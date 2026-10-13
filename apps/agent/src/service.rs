//! The Windows service host and the service commands (plan Section 7, Step 11):
//! `service run` (called by the service manager), `service install` and
//! `service uninstall` (dev and VM use; the MSI does this in Phase 6).
//!
//! The host is thin on purpose. The control handler runs on a thread of the
//! service manager and must return at once, so it does exactly two things: cancel
//! the shutdown token on Stop and Shutdown, and push session and power events into
//! the channel `agent::run` reads. No locks, no I/O. Session events are only hints:
//! the reconciler re-reads the session list at start and after every event, because
//! Windows does not replay logon notifications to a service that starts after
//! automatic sign-in has already happened.
//!
//! `service install`, `service uninstall` and `recover` change the machine, so each
//! one starts with the test-machine guard, before any lookup or prompt.

use std::ffi::OsString;
use std::io::Write;
use std::path::{Component, Path};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use windows_service::service::{
    PowerEventParam, ServiceAccess, ServiceAction, ServiceActionType, ServiceControl, ServiceControlAccept,
    ServiceErrorControl, ServiceExitCode, ServiceFailureActions, ServiceFailureResetPeriod, ServiceInfo,
    ServiceStartType, ServiceState, ServiceStatus, ServiceType, SessionChangeReason,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult, ServiceStatusHandle};
use windows_service::service_dispatcher;
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

use crate::agent::{self, ControlEvent, Deps};
use crate::paths::{DataPaths, InstallPaths};
use crate::platform;
use crate::recover::{self, RecoverEnv, StateReading};

pub const SERVICE_NAME: &str = "RuleboxAgent";
const DISPLAY_NAME: &str = "Rulebox Agent";
const DESCRIPTION: &str = "Enforces Rulebox kiosk settings on this PC.";

/// `sc.exe query RuleboxAgent` shows these as the service-specific exit code.
/// Any other failure of the agent: the failure actions restart the service.
pub const EXIT_FAILED: u32 = 1;
/// The data directory is not trusted (plan Section 5.1); nothing was written.
pub const EXIT_DATA_DIR: u32 = 2;

/// `StartServiceCtrlDispatcher` was not called by the service manager.
const ERROR_FAILED_SERVICE_CONTROLLER_CONNECT: i32 = 1063;
const ERROR_ACCESS_DENIED: i32 = 5;
const ERROR_SERVICE_DOES_NOT_EXIST: i32 = 1060;
const ERROR_SERVICE_ALREADY_RUNNING: i32 = 1056;
const ERROR_SERVICE_NOT_ACTIVE: i32 = 1062;
const ERROR_SERVICE_MARKED_FOR_DELETE: i32 = 1072;

/// How long the service manager may wait for the start to finish.
const START_WAIT_HINT: Duration = Duration::from_secs(30);
/// Plan: "give tasks 10 seconds" after a stop request. `agent::run` bounds its own
/// wind-down to 5 + 5 seconds; this is the outer limit, with 2 seconds of margin.
const STOP_DEADLINE: Duration = Duration::from_secs(12);
const STOP_WAIT_HINT: Duration = Duration::from_secs(15);
/// The runtime waits this long for blocking Win32 calls when it is dropped.
const RUNTIME_SHUTDOWN: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(250);
/// `service uninstall`: wait for the service to stop, and for its entry to vanish.
const UNINSTALL_STOP_WAIT: Duration = Duration::from_secs(30);
const UNINSTALL_GONE_WAIT: Duration = Duration::from_secs(15);

// -- the control handler (pure mapping) -------------------------------------------------------

/// What the control handler does with one control code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostAction {
    /// Cancel the shutdown token.
    Stop,
    /// Forward to `agent::run`.
    Event(ControlEvent),
    Nothing,
}

/// What the control handler answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reply {
    Handled,
    NotImplemented,
}

impl From<Reply> for ServiceControlHandlerResult {
    fn from(reply: Reply) -> Self {
        match reply {
            Reply::Handled => ServiceControlHandlerResult::NoError,
            Reply::NotImplemented => ServiceControlHandlerResult::NotImplemented,
        }
    }
}

/// The control handler as a pure function. Lock is the only reason that becomes a
/// `SessionLocked`; every other session reason is a `SessionChanged` hint. Resume
/// from sleep (any of the three resume notifications) is `PowerResumed`; the other
/// power events are granted and ignored.
pub fn map_control(control: &ServiceControl) -> (HostAction, Reply) {
    match control {
        ServiceControl::Stop | ServiceControl::Shutdown | ServiceControl::Preshutdown => {
            (HostAction::Stop, Reply::Handled)
        }
        // Every service must answer Interrogate.
        ServiceControl::Interrogate => (HostAction::Nothing, Reply::Handled),
        ServiceControl::SessionChange(change) => {
            let session_id = change.notification.session_id;
            let event = match change.reason {
                SessionChangeReason::SessionLock => ControlEvent::SessionLocked { session_id },
                _ => ControlEvent::SessionChanged { session_id },
            };
            (HostAction::Event(event), Reply::Handled)
        }
        ServiceControl::PowerEvent(power) => match power {
            PowerEventParam::ResumeAutomatic | PowerEventParam::ResumeSuspend | PowerEventParam::ResumeCritical => {
                (HostAction::Event(ControlEvent::PowerResumed), Reply::Handled)
            }
            // Granting a query is the answer the system waits for.
            _ => (HostAction::Nothing, Reply::Handled),
        },
        _ => (HostAction::Nothing, Reply::NotImplemented),
    }
}

/// The controls the running service asks for (Step 11, step 3).
fn accepted_controls() -> ServiceControlAccept {
    ServiceControlAccept::STOP
        | ServiceControlAccept::SHUTDOWN
        | ServiceControlAccept::SESSION_CHANGE
        | ServiceControlAccept::POWER_EVENT
}

// -- service run -------------------------------------------------------------------------------

windows_service::define_windows_service!(ffi_service_main, service_main);

/// `service run`. Blocks until the service has stopped. Started by hand (error 1063)
/// it only says so and returns 2.
pub fn run_dispatcher(err: &mut dyn Write) -> u8 {
    match service_dispatcher::start(SERVICE_NAME, ffi_service_main) {
        Ok(()) => 0,
        Err(error) if win32_code(&error) == Some(ERROR_FAILED_SERVICE_CONTROLLER_CONNECT) => {
            let _ = writeln!(err, "This command is started by Windows. Use `run --console` to debug.");
            2
        }
        Err(error) => {
            let _ = writeln!(err, "error: cannot start the service dispatcher: {}", describe(&error));
            1
        }
    }
}

/// The entry point the service manager calls on its own thread.
fn service_main(_arguments: Vec<OsString>) {
    // The result is reported to the service manager from inside; there is nobody to
    // return it to.
    let _ = run_service();
}

/// Reports a state to the service manager. Cheap to copy; usable from any thread.
#[derive(Clone, Copy)]
struct Reporter(ServiceStatusHandle);

impl Reporter {
    fn report(
        self,
        state: ServiceState,
        controls_accepted: ServiceControlAccept,
        exit_code: ServiceExitCode,
        checkpoint: u32,
        wait_hint: Duration,
    ) {
        let status = ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted,
            exit_code,
            checkpoint,
            wait_hint,
            process_id: None,
        };
        if let Err(error) = self.0.set_service_status(status) {
            tracing::warn!("cannot report {state:?} to the service manager: {}", describe(&error));
        }
    }

    fn start_pending(self, checkpoint: u32) {
        self.report(
            ServiceState::StartPending,
            ServiceControlAccept::empty(),
            ServiceExitCode::NO_ERROR,
            checkpoint,
            START_WAIT_HINT,
        );
    }

    fn running(self) {
        self.report(ServiceState::Running, accepted_controls(), ServiceExitCode::NO_ERROR, 0, Duration::ZERO);
    }

    fn stop_pending(self) {
        self.report(
            ServiceState::StopPending,
            ServiceControlAccept::empty(),
            ServiceExitCode::NO_ERROR,
            1,
            STOP_WAIT_HINT,
        );
    }

    fn stopped(self, exit_code: ServiceExitCode) {
        self.report(ServiceState::Stopped, ServiceControlAccept::empty(), exit_code, 0, Duration::ZERO);
    }
}

fn run_service() -> windows_service::Result<()> {
    let token = CancellationToken::new();
    let (control_tx, control_rx) = mpsc::unbounded_channel::<ControlEvent>();

    // The handler is registered before anything else so the service manager always
    // gets an answer; it touches no file and takes no lock.
    let handler_token = token.clone();
    let handle = service_control_handler::register(SERVICE_NAME, move |control| {
        let (action, reply) = map_control(&control);
        match action {
            HostAction::Stop => handler_token.cancel(),
            HostAction::Event(event) => {
                // Only fails when the agent is already gone; there is nobody to tell.
                let _ = control_tx.send(event);
            }
            HostAction::Nothing => {}
        }
        reply.into()
    })?;
    let reporter = Reporter(handle);
    reporter.start_pending(1);

    let exit_code = host(reporter, token, control_rx);
    reporter.stopped(exit_code);
    Ok(())
}

/// Everything between "registered" and "stopped". Returns the exit code to report.
fn host(reporter: Reporter, token: CancellationToken, control_rx: mpsc::UnboundedReceiver<ControlEvent>) -> ServiceExitCode {
    let failed = ServiceExitCode::ServiceSpecific(EXIT_FAILED);

    let (paths, install) = match (DataPaths::from_known_folders(), InstallPaths::from_known_folders()) {
        (Ok(paths), Ok(install)) => (paths, install),
        // No folder, no trusted place to log to.
        _ => return failed,
    };

    // 2. The data directory is checked (and repaired when allowed) before logging
    //    starts: the logs live inside it. A refusal writes nothing at all.
    if platform::windows::ensure_data_dir(paths.root()).is_err() {
        return ServiceExitCode::ServiceSpecific(EXIT_DATA_DIR);
    }
    let log_guard = match crate::logging::init(&paths.logs_dir(), false) {
        Ok(guard) => guard,
        Err(_) => return failed,
    };
    let _ = crate::PANIC_LOG_DIR.set(paths.logs_dir());
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "service starting");
    reporter.start_pending(2);

    // 3. The runtime and the real dependencies, then `Running`.
    let deps = match crate::real_deps(paths, install) {
        Ok(deps) => deps,
        Err(error) => {
            tracing::error!("cannot set the agent up: {error:#}");
            drop(log_guard);
            return failed;
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            tracing::error!("cannot start the async runtime: {error}");
            drop(log_guard);
            return failed;
        }
    };
    reporter.running();

    // 4 to 6. Run until a stop is requested or the agent fails.
    let outcome = runtime.block_on(run_until_stopped(reporter, deps, token.clone(), control_rx));
    runtime.shutdown_timeout(RUNTIME_SHUTDOWN);

    let stop_requested = token.is_cancelled();
    let exit_code = match outcome {
        Outcome::Finished(Ok(())) if stop_requested => {
            tracing::info!("service stopped");
            ServiceExitCode::NO_ERROR
        }
        Outcome::Finished(Ok(())) => {
            tracing::error!("the agent ended without being asked to; the failure actions restart the service");
            failed
        }
        // A stop was asked for: whatever went wrong while winding down, the stop is
        // reported as clean, or the failure actions would restart a service that was
        // stopped on purpose.
        Outcome::Finished(Err(error)) if stop_requested => {
            tracing::error!("the agent failed while stopping: {error:#}");
            ServiceExitCode::NO_ERROR
        }
        Outcome::Finished(Err(error)) => {
            tracing::error!("the agent failed: {error:#}");
            failed
        }
        Outcome::TimedOut => {
            tracing::warn!("the agent did not stop within {} s; stopping anyway", STOP_DEADLINE.as_secs());
            ServiceExitCode::NO_ERROR
        }
    };
    // Flush the log before `Stopped` is reported.
    drop(log_guard);
    exit_code
}

enum Outcome {
    Finished(anyhow::Result<()>),
    TimedOut,
}

async fn run_until_stopped(
    reporter: Reporter,
    deps: Deps,
    token: CancellationToken,
    control_rx: mpsc::UnboundedReceiver<ControlEvent>,
) -> Outcome {
    let mut run = tokio::spawn(agent::run(deps, token.clone(), control_rx));
    let joined = tokio::select! {
        joined = &mut run => joined,
        () = token.cancelled() => {
            reporter.stop_pending();
            match tokio::time::timeout(STOP_DEADLINE, &mut run).await {
                Ok(joined) => joined,
                Err(_) => {
                    run.abort();
                    return Outcome::TimedOut;
                }
            }
        }
    };
    match joined {
        Ok(result) => Outcome::Finished(result),
        // A panic ends the process in the panic hook before it gets here.
        Err(error) => Outcome::Finished(Err(anyhow!("the agent task failed: {error}"))),
    }
}

// -- errors from the service manager ---------------------------------------------------------------

fn win32_code(error: &windows_service::Error) -> Option<i32> {
    match error {
        windows_service::Error::Winapi(io) => io.raw_os_error(),
        _ => None,
    }
}

/// The error with its cause (the crate's own text is only "IO error in winapi call").
fn describe(error: &windows_service::Error) -> String {
    match std::error::Error::source(error) {
        Some(cause) => format!("{error}: {cause}"),
        None => error.to_string(),
    }
}

/// A service-manager failure as an error for the administrator.
fn scm_error(what: &str, error: &windows_service::Error) -> anyhow::Error {
    match win32_code(error) {
        Some(ERROR_ACCESS_DENIED) => {
            anyhow!("{what}: access denied. Run this from an elevated (Run as administrator) prompt.")
        }
        Some(ERROR_SERVICE_MARKED_FOR_DELETE) => anyhow!(
            "{what}: the service is marked for deletion. Close services.msc and Task Manager, or restart, \
             then run this again."
        ),
        _ => anyhow!("{what}: {}", describe(error)),
    }
}

// -- the guard ---------------------------------------------------------------------------------------

/// The first line of every command that changes accounts, services or Winlogon
/// settings. Nothing is looked up, asked or written before it.
pub fn guard_destructive(command: &str) -> anyhow::Result<()> {
    rulebox_win32::guard::require_test_machine().map_err(|error| {
        anyhow!(
            "`{command}` is refused: {error}. It changes the service, accounts or Windows sign-in settings, \
             so it runs only on a test machine whose marker was created by hand \
             (HKLM\\SOFTWARE\\Rulebox\\TestMachine, value ComputerName)."
        )
    })
}

// -- stop ----------------------------------------------------------------------------------------------

/// What stopping the service found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopOutcome {
    NotInstalled,
    NotRunning,
    Stopped,
    TimedOut,
    Failed(String),
}

/// Stops `RuleboxAgent` if it runs and waits for it (polling `query_status`). Never
/// fails: what happened is the answer.
pub fn stop_service(wait: Duration) -> StopOutcome {
    let manager = match ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT) {
        Ok(manager) => manager,
        Err(error) => return StopOutcome::Failed(scm_error("cannot reach the service manager", &error).to_string()),
    };
    let service = match manager.open_service(SERVICE_NAME, ServiceAccess::STOP | ServiceAccess::QUERY_STATUS) {
        Ok(service) => service,
        Err(error) if win32_code(&error) == Some(ERROR_SERVICE_DOES_NOT_EXIST) => return StopOutcome::NotInstalled,
        Err(error) => return StopOutcome::Failed(scm_error("cannot open the service", &error).to_string()),
    };
    match service.query_status() {
        Ok(status) if status.current_state == ServiceState::Stopped => return StopOutcome::NotRunning,
        Ok(_) => {}
        Err(error) => return StopOutcome::Failed(scm_error("cannot query the service", &error).to_string()),
    }
    match service.stop() {
        Ok(_) => {}
        Err(error) if win32_code(&error) == Some(ERROR_SERVICE_NOT_ACTIVE) => return StopOutcome::NotRunning,
        Err(error) => return StopOutcome::Failed(scm_error("cannot stop the service", &error).to_string()),
    }
    let deadline = Instant::now() + wait;
    loop {
        match service.query_status() {
            Ok(status) if status.current_state == ServiceState::Stopped => return StopOutcome::Stopped,
            Ok(_) => {}
            Err(error) => return StopOutcome::Failed(scm_error("cannot query the service", &error).to_string()),
        }
        if Instant::now() >= deadline {
            return StopOutcome::TimedOut;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

// -- service install -----------------------------------------------------------------------------------

fn normalized(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    let text = text.strip_prefix(r"\\?\").unwrap_or(&text);
    text.trim_end_matches('\\').to_lowercase()
}

/// The service runs this file as SYSTEM, so it must sit directly in
/// `%ProgramFiles%\Rulebox\`, where standard users cannot write (plan Section 9).
/// Pure.
pub fn check_install_location(exe: &Path, install_root: &Path) -> Result<(), String> {
    let inside = exe.parent().is_some_and(|dir| normalized(dir) == normalized(install_root))
        && exe.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
        && !exe.components().any(|component| component == Component::ParentDir);
    if inside {
        Ok(())
    } else {
        Err(format!(
            "{} is not inside {}. The service runs this file as SYSTEM, so it must live where standard users \
             cannot write: copy it there (scripts\\vm-deploy.ps1) and run the command from that copy.",
            exe.display(),
            install_root.display()
        ))
    }
}

fn service_info(exe: &Path) -> ServiceInfo {
    ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(DISPLAY_NAME),
        service_type: ServiceType::OWN_PROCESS,
        // Automatic, not delayed: the agent must be up before automatic sign-in.
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: exe.to_path_buf(),
        launch_arguments: vec![OsString::from("service"), OsString::from("run")],
        dependencies: Vec::new(),
        // LocalSystem.
        account_name: None,
        account_password: None,
    }
}

/// Restart after 1 s, 5 s, 30 s (the last one repeats); the count resets after a day.
fn failure_actions() -> ServiceFailureActions {
    let restart = |seconds| ServiceAction {
        action_type: ServiceActionType::Restart,
        delay: Duration::from_secs(seconds),
    };
    ServiceFailureActions {
        reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(86_400)),
        reboot_msg: None,
        command: None,
        actions: Some(vec![restart(1), restart(5), restart(30)]),
    }
}

/// `service install`. Returns the exit code.
pub fn run_install(out: &mut dyn Write, err: &mut dyn Write) -> u8 {
    let result = (|| {
        let exe = std::env::current_exe().context("find this program")?;
        let install = InstallPaths::from_known_folders()?;
        let paths = DataPaths::from_known_folders()?;
        install_at(&exe, &install, &paths, out)
    })();
    report_result(result, err)
}

fn report_result(result: anyhow::Result<()>, err: &mut dyn Write) -> u8 {
    match result {
        Ok(()) => 0,
        Err(error) => {
            let _ = writeln!(err, "error: {error:#}");
            crate::ipc_admin::EXIT_ERROR
        }
    }
}

/// [`run_install`] for an explicit program, install folder and data folder.
pub fn install_at(exe: &Path, install: &InstallPaths, paths: &DataPaths, out: &mut dyn Write) -> anyhow::Result<()> {
    // The guard comes before every lookup, so a refusal changes nothing.
    guard_destructive("service install")?;
    check_install_location(exe, install.root()).map_err(|message| anyhow!(message))?;
    // The data directory is created through the one function that checks it. It
    // comes before the service so a refusal leaves the service manager untouched.
    platform::windows::ensure_data_dir(paths.root()).context("the data directory cannot be used")?;

    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )
    .map_err(|error| scm_error("cannot reach the service manager", &error))?;
    let info = service_info(exe);
    // CHANGE_CONFIG for the settings, START for the restart actions and the start.
    let access = ServiceAccess::CHANGE_CONFIG | ServiceAccess::START | ServiceAccess::QUERY_STATUS;

    let (service, created) = match manager.open_service(SERVICE_NAME, access) {
        // Updated in place: deleting and creating again would leave it "marked for
        // deletion" while anything still holds a handle.
        Ok(service) => {
            service
                .change_config(&info)
                .map_err(|error| scm_error("cannot update the service", &error))?;
            service
                .set_delayed_auto_start(false)
                .map_err(|error| scm_error("cannot set the start type", &error))?;
            (service, false)
        }
        Err(error) if win32_code(&error) == Some(ERROR_SERVICE_DOES_NOT_EXIST) => {
            let service = manager
                .create_service(&info, access)
                .map_err(|error| scm_error("cannot create the service", &error))?;
            (service, true)
        }
        Err(error) => return Err(scm_error("cannot open the service", &error)),
    };
    service
        .set_description(DESCRIPTION)
        .map_err(|error| scm_error("cannot set the description", &error))?;
    service
        .update_failure_actions(failure_actions())
        .map_err(|error| scm_error("cannot set the recovery actions", &error))?;
    service
        .set_failure_actions_on_non_crash_failures(true)
        .map_err(|error| scm_error("cannot set the recovery flag", &error))?;
    let _ = writeln!(
        out,
        "Service {SERVICE_NAME} {} (automatic start, LocalSystem, restart after 1 s, 5 s, 30 s).",
        if created { "created" } else { "updated" }
    );

    match service.start::<&str>(&[]) {
        Ok(()) => {
            let _ = writeln!(out, "Service started.");
        }
        Err(error) if win32_code(&error) == Some(ERROR_SERVICE_ALREADY_RUNNING) => {
            let _ = writeln!(
                out,
                "The service was already running; restart it (`sc.exe stop {SERVICE_NAME}`, then `sc.exe start \
                 {SERVICE_NAME}`) to use this file."
            );
        }
        Err(error) => return Err(scm_error("the service was installed but could not be started", &error)),
    }
    Ok(())
}

// -- service uninstall ---------------------------------------------------------------------------------

/// Why uninstalling must not go ahead without `--force`, or `None` (plan Step 11:
/// "refuse if the device is enrolled and kiosk is applied"). Anything the state
/// shows that Disable would undo counts, enrolled or not, and a state that cannot
/// be read cannot be shown to be clean. Pure.
pub fn uninstall_blocker(state: &StateReading) -> Option<String> {
    match state {
        StateReading::Missing => None,
        // `has_kiosk_changes` covers `applied == Enabled` and the journal, the LSA
        // take-over and the Staff hive record.
        StateReading::Readable(state) => {
            crate::kiosk::has_kiosk_changes(state).then(|| "The kiosk is applied on this PC.".to_string())
        }
        StateReading::Unreadable(reason) => {
            Some(format!("The agent state cannot be read ({reason}), so it cannot be shown that the kiosk is off."))
        }
        StateReading::DirNotTrusted(reason) => {
            Some(format!("The data directory cannot be trusted ({reason}), so it cannot be shown that the kiosk is off."))
        }
    }
}

/// `service uninstall [--force]`. Returns the exit code.
pub fn run_uninstall(force: bool, out: &mut dyn Write, err: &mut dyn Write) -> u8 {
    let result = (|| {
        let install = InstallPaths::from_known_folders()?;
        let paths = DataPaths::from_known_folders()?;
        uninstall_at(force, &install, &paths, out)
    })();
    report_result(result, err)
}

/// [`run_uninstall`] on explicit folders.
pub fn uninstall_at(force: bool, install: &InstallPaths, paths: &DataPaths, out: &mut dyn Write) -> anyhow::Result<()> {
    guard_destructive("service uninstall")?;
    if !rulebox_win32::security::process_is_elevated().context("check the elevation")? {
        bail!("run `service uninstall` from an elevated (Run as administrator) prompt.");
    }

    let (state, _trusted) = recover::read_state(paths, &rulebox_win32::security::verify_protected_dir);
    if let Some(reason) = uninstall_blocker(&state) {
        if !force {
            bail!(
                "{reason} Run `rulebox-agent unenroll` first, or use `service uninstall --force`, which runs \
                 `recover` first."
            );
        }
        let _ = writeln!(out, "{reason} --force: running `recover` first.");
        let platform = platform::windows::WindowsPlatform::new(install.clone(), paths.clone());
        let stop = || stop_service(recover::SERVICE_STOP_WAIT);
        let env = RecoverEnv {
            platform: &platform,
            paths,
            verify_dir: &rulebox_win32::security::verify_protected_dir,
            stop_service: &stop,
        };
        let report = recover::recover_machine(&env);
        report.print(out);
        if !report.is_complete() {
            bail!("`recover` did not finish, so the service was not removed. Fix the problems above, or run `recover` again.");
        }
    }

    // Stop, delete, and wait until the entry is really gone.
    match stop_service(UNINSTALL_STOP_WAIT) {
        StopOutcome::NotInstalled => {
            let _ = writeln!(out, "Service {SERVICE_NAME} is not installed.");
            return Ok(());
        }
        StopOutcome::NotRunning | StopOutcome::Stopped => {}
        StopOutcome::TimedOut => bail!(
            "the service did not stop within {} s. Try again, or end rulebox-agent.exe in Task Manager.",
            UNINSTALL_STOP_WAIT.as_secs()
        ),
        StopOutcome::Failed(reason) => bail!("{reason}"),
    }

    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|error| scm_error("cannot reach the service manager", &error))?;
    let service = match manager.open_service(SERVICE_NAME, ServiceAccess::DELETE | ServiceAccess::QUERY_STATUS) {
        Ok(service) => service,
        Err(error) if win32_code(&error) == Some(ERROR_SERVICE_DOES_NOT_EXIST) => {
            let _ = writeln!(out, "Service {SERVICE_NAME} is gone.");
            return Ok(());
        }
        Err(error) => return Err(scm_error("cannot open the service", &error)),
    };
    service.delete().map_err(|error| scm_error("cannot delete the service", &error))?;
    // The entry disappears only when every handle is closed, ours included.
    drop(service);

    let deadline = Instant::now() + UNINSTALL_GONE_WAIT;
    loop {
        match manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS) {
            Err(error) if win32_code(&error) == Some(ERROR_SERVICE_DOES_NOT_EXIST) => {
                let _ = writeln!(out, "Service {SERVICE_NAME} removed.");
                return Ok(());
            }
            Ok(handle) => drop(handle),
            Err(error) => return Err(scm_error("cannot check that the service is gone", &error)),
        }
        if Instant::now() >= deadline {
            bail!(
                "the service is marked for deletion but still listed. Close services.msc and Task Manager, or \
                 restart, then run this again."
            );
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use windows_service::service::{SessionChangeParam, SessionNotification};

    use crate::state::{AgentState, KioskApplied};
    use crate::testutil::TempDir;

    fn session(reason: SessionChangeReason, session_id: u32) -> ServiceControl {
        ServiceControl::SessionChange(SessionChangeParam {
            reason,
            notification: SessionNotification { size: 8, session_id },
        })
    }

    // -- the control handler (plan unit test 1) ---------------------------------------------

    #[test]
    fn stop_and_shutdown_cancel_the_token_and_are_acknowledged() {
        for control in [ServiceControl::Stop, ServiceControl::Shutdown, ServiceControl::Preshutdown] {
            assert_eq!(map_control(&control), (HostAction::Stop, Reply::Handled), "{control:?}");
        }
    }

    #[test]
    fn interrogate_is_answered_and_does_nothing() {
        assert_eq!(map_control(&ServiceControl::Interrogate), (HostAction::Nothing, Reply::Handled));
    }

    #[test]
    fn lock_becomes_session_locked_and_every_other_reason_a_session_hint() {
        assert_eq!(
            map_control(&session(SessionChangeReason::SessionLock, 3)),
            (HostAction::Event(ControlEvent::SessionLocked { session_id: 3 }), Reply::Handled)
        );
        for reason in [
            SessionChangeReason::ConsoleConnect,
            SessionChangeReason::ConsoleDisconnect,
            SessionChangeReason::RemoteConnect,
            SessionChangeReason::RemoteDisconnect,
            SessionChangeReason::SessionLogon,
            SessionChangeReason::SessionLogoff,
            SessionChangeReason::SessionUnlock,
            SessionChangeReason::SessionRemoteControl,
            SessionChangeReason::SessionCreate,
            SessionChangeReason::SessionTerminate,
        ] {
            assert_eq!(
                map_control(&session(reason, 7)),
                (HostAction::Event(ControlEvent::SessionChanged { session_id: 7 }), Reply::Handled),
                "{reason:?}"
            );
        }
    }

    #[test]
    fn resume_from_sleep_is_power_resumed_and_other_power_events_are_granted() {
        for power in [
            PowerEventParam::ResumeAutomatic,
            PowerEventParam::ResumeSuspend,
            PowerEventParam::ResumeCritical,
        ] {
            assert_eq!(
                map_control(&ServiceControl::PowerEvent(power)),
                (HostAction::Event(ControlEvent::PowerResumed), Reply::Handled),
                "{power:?}"
            );
        }
        for power in [
            PowerEventParam::Suspend,
            PowerEventParam::QuerySuspend,
            PowerEventParam::QuerySuspendFailed,
            PowerEventParam::PowerStatusChange,
            PowerEventParam::BatteryLow,
        ] {
            assert_eq!(
                map_control(&ServiceControl::PowerEvent(power)),
                (HostAction::Nothing, Reply::Handled),
                "{power:?}"
            );
        }
    }

    #[test]
    fn controls_the_service_does_not_accept_are_not_implemented() {
        for control in [ServiceControl::Pause, ServiceControl::Continue, ServiceControl::ParamChange, ServiceControl::TimeChange] {
            assert_eq!(map_control(&control), (HostAction::Nothing, Reply::NotImplemented), "{control:?}");
        }
    }

    #[test]
    fn the_running_service_accepts_stop_shutdown_session_and_power_only() {
        let accepted = accepted_controls();
        assert_eq!(
            accepted,
            ServiceControlAccept::STOP
                | ServiceControlAccept::SHUTDOWN
                | ServiceControlAccept::SESSION_CHANGE
                | ServiceControlAccept::POWER_EVENT
        );
        // Preshutdown excludes Shutdown; the plan asks for Shutdown.
        assert!(!accepted.contains(ServiceControlAccept::PRESHUTDOWN));
        assert!(!accepted.contains(ServiceControlAccept::PAUSE_CONTINUE));
    }

    // -- what the service is created with (plan Step 11, "service install") ---------------------

    #[test]
    fn the_service_is_created_as_the_plan_says() {
        let exe = Path::new(r"C:\Program Files\Rulebox\rulebox-agent.exe");
        let info = service_info(exe);
        assert_eq!(info.name, OsString::from("RuleboxAgent"));
        assert_eq!(info.display_name, OsString::from("Rulebox Agent"));
        assert_eq!(info.service_type, ServiceType::OWN_PROCESS);
        assert_eq!(info.start_type, ServiceStartType::AutoStart, "automatic, never delayed");
        assert_eq!(info.error_control, ServiceErrorControl::Normal);
        assert_eq!(info.executable_path, exe);
        assert_eq!(info.launch_arguments, [OsString::from("service"), OsString::from("run")]);
        assert_eq!(info.account_name, None, "LocalSystem");
        assert!(info.dependencies.is_empty());
    }

    #[test]
    fn the_recovery_actions_restart_after_1_5_and_30_seconds() {
        let actions = failure_actions();
        assert_eq!(actions.reset_period, ServiceFailureResetPeriod::After(Duration::from_secs(86_400)));
        let list = actions.actions.unwrap();
        assert!(list.iter().all(|action| action.action_type == ServiceActionType::Restart));
        let delays: Vec<u64> = list.iter().map(|action| action.delay.as_secs()).collect();
        assert_eq!(delays, [1, 5, 30]);
        assert_eq!((actions.reboot_msg, actions.command), (None, None));
    }

    #[test]
    fn install_refuses_a_program_outside_the_install_folder() {
        let root = Path::new(r"C:\Program Files\Rulebox");
        for good in [
            r"C:\Program Files\Rulebox\rulebox-agent.exe",
            r"c:\program files\rulebox\RULEBOX-AGENT.EXE",
            r"\\?\C:\Program Files\Rulebox\rulebox-agent.exe",
            r"C:/Program Files/Rulebox/rulebox-agent.exe",
        ] {
            assert_eq!(check_install_location(Path::new(good), root), Ok(()), "{good}");
        }
        for bad in [
            r"D:\work\personal\rulebox\target\debug\rulebox-agent.exe",
            r"C:\Users\Staff\Downloads\rulebox-agent.exe",
            r"C:\Program Files\Rulebox\sub\rulebox-agent.exe",
            r"C:\Program Files\Rulebox\..\Other\rulebox-agent.exe",
            r"C:\Program Files\Rulebox-evil\rulebox-agent.exe",
            r"C:\Program Files\Rulebox",
            r"C:\Program Files\Rulebox\rulebox-agent.dll",
        ] {
            let error = check_install_location(Path::new(bad), root).unwrap_err();
            assert!(error.contains("standard users"), "{bad}: {error}");
        }
    }

    // -- uninstall (plan: refuse while the kiosk is applied) --------------------------------------

    #[test]
    fn uninstall_is_blocked_while_the_kiosk_is_applied_or_cannot_be_shown_to_be_off() {
        assert_eq!(uninstall_blocker(&StateReading::Missing), None);

        let mut state = AgentState::default();
        assert_eq!(uninstall_blocker(&StateReading::Readable(Box::new(state.clone()))), None);
        state.kiosk.applied = KioskApplied::Disabled;
        assert_eq!(uninstall_blocker(&StateReading::Readable(Box::new(state.clone()))), None);

        state.kiosk.applied = KioskApplied::Enabled;
        assert!(uninstall_blocker(&StateReading::Readable(Box::new(state.clone()))).is_some());

        // Disabled, but the machine still holds something Disable would undo.
        state.kiosk.applied = KioskApplied::Disabled;
        state.kiosk.lsa_taken_over = true;
        assert!(uninstall_blocker(&StateReading::Readable(Box::new(state))).is_some());

        assert!(uninstall_blocker(&StateReading::Unreadable("it does not parse".into())).is_some());
        assert!(uninstall_blocker(&StateReading::DirNotTrusted("it is a link".into())).is_some());
    }

    // -- the guard: refused before any change (dev machine only) -----------------------------------

    fn service_exists() -> bool {
        let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT).unwrap();
        manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS).is_ok()
    }

    #[test]
    fn install_is_refused_by_the_guard_and_changes_nothing() {
        if rulebox_win32::guard::is_test_machine() {
            return;
        }
        let dir = TempDir::new();
        let install = InstallPaths::new(dir.path().join("install"));
        // A program that passes the location check, and a data directory that does
        // not exist: the guard must stop it before either matters.
        let exe = install.agent_exe();
        let paths = DataPaths::new(dir.path().join("data"));
        let existed = service_exists();

        let mut out = Vec::new();
        let error = install_at(&exe, &install, &paths, &mut out).unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("test-machine guard") && message.contains("service install"), "{message}");
        assert!(out.is_empty());
        assert!(!paths.root().exists(), "the data directory was not created");
        assert_eq!(service_exists(), existed, "the service list did not change");
    }

    #[test]
    fn uninstall_force_is_refused_by_the_guard_before_recover_runs() {
        if rulebox_win32::guard::is_test_machine() {
            return;
        }
        let dir = TempDir::new();
        let install = InstallPaths::new(dir.path().join("install"));
        let paths = DataPaths::new(dir.path().to_path_buf());
        std::fs::create_dir_all(paths.state_dir()).unwrap();
        let mut state = AgentState::default();
        state.kiosk.applied = KioskApplied::Enabled;
        let bytes = serde_json::to_vec_pretty(&state).unwrap();
        std::fs::write(paths.agent_state(), &bytes).unwrap();

        let mut out = Vec::new();
        let error = uninstall_at(true, &install, &paths, &mut out).unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("test-machine guard") && message.contains("service uninstall"), "{message}");
        assert!(out.is_empty(), "nothing was printed or run");
        assert_eq!(std::fs::read(paths.agent_state()).unwrap(), bytes);
        assert!(!paths.recovered_flag().exists());
    }

    #[test]
    fn started_by_hand_the_dispatcher_says_so_and_returns_2() {
        // Not started by the service manager: error 1063. Safe to run anywhere; it
        // registers nothing and opens nothing.
        let mut err = Vec::new();
        assert_eq!(run_dispatcher(&mut err), 2);
        let text = String::from_utf8(err).unwrap();
        assert!(text.contains("started by Windows") && text.contains("run --console"), "{text}");
    }
}
