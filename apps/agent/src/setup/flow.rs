//! What Rulebox Setup does, as a state machine without any window (Phase 6 Step 8, plan 4.10.1).
//!
//! The window (`ui.rs`) feeds [`Event`]s in, runs the [`Job`]s that come out on a worker thread
//! through a [`Backend`], and draws the [`View`] of the current screen. So the whole behaviour is
//! tested here without Win32:
//!
//! 1. **Check**: whether this PC is enrolled already, and the compatibility report.
//! 2. **WebView2**: when the runtime is missing or too old, install it from the bundled bootstrapper
//!    (once), then check again; a runtime that is still not good is a blocker.
//! 3. **Code**: the administrator pastes the enrollment code. Blockers stop everything: with one,
//!    there is no code box and no `Enroll` job can start.
//! 4. **Enroll**, then say what happens next.
//!
//! The enrollment code lives in one `String` handed to the one `Enroll` job. It is never logged and
//! never part of a [`View`] or a [`Screen`].

use crate::compat::{CompatReport, Warning};
use crate::enroll_code;
use crate::setup::pending::MAX_CODE_LEN;
use crate::setup::{strings, webview2};

/// How the kiosk stands right after enrollment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KioskState {
    On,
    NotOnYet,
    Failed,
}

/// What a successful enrollment tells the window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnrolledInfo {
    pub device_name: String,
    pub kiosk: KioskState,
}

/// The answer of a check: the device name when this PC is enrolled already, and the report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckResult {
    pub enrolled: Option<String>,
    pub report: CompatReport,
}

/// Everything Setup needs from the machine and the service. Blocking: only worker threads call it.
pub trait Backend: Send + Sync + 'static {
    /// Reads the PC (and asks the service whether it is enrolled). `webview2_attempted`: Setup
    /// already tried to install the runtime, so a bad one is a blocker, not a warning.
    fn check(&self, webview2_attempted: bool) -> Result<CheckResult, String>;
    /// Installs the WebView2 Runtime if it is missing or too old.
    fn install_webview2(&self) -> webview2::Outcome;
    /// Enrolls with `code`. `Err` is a plain sentence for the administrator.
    fn enroll(&self, code: &str) -> Result<EnrolledInfo, String>;
}

/// Work for a worker thread.
#[derive(Clone, PartialEq, Eq)]
pub enum Job {
    Check { webview2_attempted: bool },
    InstallWebView2,
    /// Carries the code; never printed (see the `Debug` below).
    Enroll(String),
}

impl std::fmt::Debug for Job {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Job::Check { webview2_attempted } => f.debug_struct("Check").field("webview2_attempted", webview2_attempted).finish(),
            Job::InstallWebView2 => f.write_str("InstallWebView2"),
            Job::Enroll(_) => f.write_str("Enroll(<code>)"),
        }
    }
}

/// Runs one job to its end.
pub fn run_job(backend: &dyn Backend, job: Job) -> Event {
    match job {
        Job::Check { webview2_attempted } => Event::Checked(backend.check(webview2_attempted)),
        Job::InstallWebView2 => Event::WebView2(backend.install_webview2()),
        Job::Enroll(code) => Event::Enrolled(backend.enroll(&code)),
    }
}

/// What happened (a job ended, or the administrator did something).
pub enum Event {
    Start,
    Checked(Result<CheckResult, String>),
    WebView2(webview2::Outcome),
    Enrolled(Result<EnrolledInfo, String>),
    /// The text of the code box when "Enroll" was chosen.
    Submit(String),
    CheckAgain,
    Close,
}

/// What the window does next.
#[derive(Debug, PartialEq, Eq)]
pub enum Effect {
    Nothing,
    Run(Job),
    Quit,
}

/// The screens, in the order a normal run shows them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Screen {
    Checking,
    InstallingWebView2,
    /// A blocker (or a runtime that could not be fixed) stops enrollment.
    Blocked { notes: Vec<String>, problems: Vec<String> },
    Code { notes: Vec<String>, error: Option<String> },
    Enrolling,
    Done(EnrolledInfo),
    AlreadyEnrolled(String),
    Fatal(String),
}

/// The state machine. It owns no window and no thread.
pub struct Flow {
    screen: Screen,
    webview2_attempted: bool,
    /// What the WebView2 step said (shown on the next screen), if anything.
    webview2_note: Option<String>,
    /// The notes of the last good check, kept for the code box after a failed enrollment.
    notes: Vec<String>,
}

impl Default for Flow {
    fn default() -> Self {
        Self::new()
    }
}

impl Flow {
    pub fn new() -> Self {
        Self { screen: Screen::Checking, webview2_attempted: false, webview2_note: None, notes: Vec::new() }
    }

    #[cfg(test)]
    pub fn screen(&self) -> &Screen {
        &self.screen
    }

    /// True while a job runs (the window ignores Close and disables the buttons).
    pub fn busy(&self) -> bool {
        matches!(self.screen, Screen::Checking | Screen::InstallingWebView2 | Screen::Enrolling)
    }

    pub fn on(&mut self, event: Event) -> Effect {
        match event {
            Event::Start => {
                self.screen = Screen::Checking;
                Effect::Run(Job::Check { webview2_attempted: false })
            }
            Event::Checked(Err(text)) => {
                self.screen = Screen::Fatal(text);
                Effect::Nothing
            }
            Event::Checked(Ok(check)) => self.after_check(check),
            Event::WebView2(outcome) => {
                // Whatever came of it, Setup has tried: from here a bad runtime is a blocker.
                self.webview2_attempted = true;
                self.webview2_note = strings::webview2_outcome_line(&outcome);
                self.screen = Screen::Checking;
                Effect::Run(Job::Check { webview2_attempted: true })
            }
            Event::CheckAgain => {
                if matches!(self.screen, Screen::Blocked { .. } | Screen::Fatal(_)) {
                    self.screen = Screen::Checking;
                    Effect::Run(Job::Check { webview2_attempted: self.webview2_attempted })
                } else {
                    Effect::Nothing
                }
            }
            Event::Submit(text) => self.submit(&text),
            Event::Enrolled(Ok(info)) => {
                self.screen = Screen::Done(info);
                Effect::Nothing
            }
            Event::Enrolled(Err(text)) => {
                self.screen = Screen::Code { notes: self.notes.clone(), error: Some(text) };
                Effect::Nothing
            }
            Event::Close => {
                if self.busy() {
                    Effect::Nothing
                } else {
                    Effect::Quit
                }
            }
        }
    }

    fn after_check(&mut self, check: CheckResult) -> Effect {
        if let Some(name) = check.enrolled {
            self.screen = Screen::AlreadyEnrolled(name);
            return Effect::Nothing;
        }
        let report = &check.report;
        let runtime_wanted = report.warnings.iter().any(|w| matches!(w, Warning::Webview2Missing | Warning::Webview2TooOld));
        if runtime_wanted && !self.webview2_attempted {
            self.screen = Screen::InstallingWebView2;
            return Effect::Run(Job::InstallWebView2);
        }
        let mut notes = strings::report_lines(report);
        if let Some(note) = self.webview2_note.take() {
            notes.insert(0, note);
        }
        notes.extend(report.warnings.iter().filter(|w| !matches!(w, Warning::Webview2Missing | Warning::Webview2TooOld)).map(|w| strings::warning_line(*w)));
        if report.blockers.is_empty() {
            self.notes = notes.clone();
            self.screen = Screen::Code { notes, error: None };
        } else {
            let problems = report.blockers.iter().map(|b| strings::blocker_line(*b)).collect();
            self.screen = Screen::Blocked { notes, problems };
        }
        Effect::Nothing
    }

    fn submit(&mut self, text: &str) -> Effect {
        // Only the code box can start an enrollment: a blocker, a running job or a finished run
        // never does, whatever the window sends.
        let Screen::Code { notes, .. } = &self.screen else {
            return Effect::Nothing;
        };
        let notes = notes.clone();
        let code = text.trim();
        let problem = if code.is_empty() {
            Some(strings::CODE_EMPTY)
        } else if code.len() > MAX_CODE_LEN {
            Some(strings::CODE_TOO_LONG)
        } else if enroll_code::parse(code).is_err() {
            Some(strings::CODE_INVALID)
        } else {
            None
        };
        if let Some(problem) = problem {
            self.screen = Screen::Code { notes, error: Some(problem.to_string()) };
            return Effect::Nothing;
        }
        self.screen = Screen::Enrolling;
        Effect::Run(Job::Enroll(code.to_string()))
    }

    // -- what the window draws -------------------------------------------------------------------

    pub fn view(&self) -> View {
        let close = |label: &'static str| Button { action: Action::Close, label, default: false };
        match &self.screen {
            Screen::Checking => View::busy(strings::CHECKING_TITLE, strings::CHECKING_LINE),
            Screen::InstallingWebView2 => View::busy(strings::INSTALLING_WEBVIEW2_TITLE, strings::INSTALLING_WEBVIEW2_LINE),
            Screen::Enrolling => View::busy(strings::ENROLLING_TITLE, strings::ENROLLING_LINE),
            Screen::Blocked { notes, problems } => {
                let mut lines = vec![strings::BLOCKED_INTRO.to_string(), String::new()];
                lines.extend(problems.iter().map(|p| format!("- {p}")));
                lines.push(String::new());
                lines.extend(notes.iter().cloned());
                View {
                    title: strings::BLOCKED_TITLE.to_string(),
                    lines,
                    busy: false,
                    input: None,
                    buttons: vec![Button { action: Action::CheckAgain, label: strings::BUTTON_CHECK_AGAIN, default: true }, close(strings::BUTTON_CLOSE)],
                }
            }
            Screen::Code { notes, error } => {
                let mut lines = vec![strings::CODE_INTRO.to_string(), String::new()];
                lines.extend(notes.iter().cloned());
                View {
                    title: strings::CODE_TITLE.to_string(),
                    lines,
                    busy: false,
                    input: Some(Input { label: strings::CODE_LABEL, error: error.clone() }),
                    buttons: vec![Button { action: Action::Enroll, label: strings::BUTTON_ENROLL, default: true }, close(strings::BUTTON_CLOSE)],
                }
            }
            Screen::Done(info) => {
                let kiosk = match info.kiosk {
                    KioskState::On => strings::NEXT_KIOSK_ON,
                    KioskState::NotOnYet => strings::NEXT_KIOSK_PENDING,
                    KioskState::Failed => strings::NEXT_KIOSK_FAILED,
                };
                View {
                    title: strings::DONE_TITLE.to_string(),
                    lines: vec![
                        format!("This PC is now \"{}\" in your organization.", info.device_name),
                        String::new(),
                        strings::NEXT_TITLE.to_string(),
                        kiosk.to_string(),
                        strings::NEXT_WAY_BACK.to_string(),
                    ],
                    busy: false,
                    input: None,
                    buttons: vec![Button { action: Action::Close, label: strings::BUTTON_FINISH, default: true }],
                }
            }
            Screen::AlreadyEnrolled(name) => View {
                title: strings::ALREADY_TITLE.to_string(),
                lines: vec![format!("This PC is enrolled as \"{name}\"."), strings::ALREADY_LINE.to_string()],
                busy: false,
                input: None,
                buttons: vec![Button { action: Action::Close, label: strings::BUTTON_CLOSE, default: true }],
            },
            Screen::Fatal(text) => View {
                title: strings::FATAL_TITLE.to_string(),
                lines: vec![text.clone()],
                busy: false,
                input: None,
                buttons: vec![Button { action: Action::CheckAgain, label: strings::BUTTON_CHECK_AGAIN, default: true }, close(strings::BUTTON_CLOSE)],
            },
        }
    }
}

/// What a button does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Enroll,
    CheckAgain,
    Close,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Button {
    pub action: Action,
    pub label: &'static str,
    /// The button Enter presses.
    pub default: bool,
}

/// The code box, with the problem to show under it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Input {
    pub label: &'static str,
    pub error: Option<String>,
}

/// One screen as the window draws it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct View {
    pub title: String,
    pub lines: Vec<String>,
    /// A job runs: no buttons, no code box.
    pub busy: bool,
    pub input: Option<Input>,
    pub buttons: Vec<Button>,
}

impl View {
    fn busy(title: &str, line: &str) -> Self {
        Self { title: title.to_string(), lines: vec![line.to_string()], busy: true, input: None, buttons: Vec::new() }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::compat::{self, Options};
    use crate::platform::sim::{SimOp, SimPlatform, SimProgram};
    use crate::platform::{FileIdentity, FileStamp};
    use crate::testutil::TempDir;

    const ROOT: &str = r"C:\Program Files\Rulebox";
    const HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    /// A code the parser accepts.
    fn good_code() -> String {
        format!("RBX1.{}", URL_SAFE_NO_PAD.encode("https://happy-animal-123.convex.cloud#0123456789ABCDEFGHJK"))
    }

    /// The real checks (compat and the bootstrap) on a `SimPlatform`; only the service is scripted.
    struct TestBackend {
        sim: Arc<SimPlatform>,
        pinned: Option<String>,
        enrolled: Mutex<Option<String>>,
        enroll_answer: Mutex<Result<EnrolledInfo, String>>,
        enrolls: Mutex<Vec<()>>,
        _dir: TempDir,
    }

    impl TestBackend {
        fn new(setup: impl FnOnce(&SimPlatform)) -> Self {
            let dir = TempDir::new();
            let sim = SimPlatform::new(dir.path().to_path_buf());
            sim.with_world(|world| {
                world.programs.insert(
                    format!(r"{ROOT}\MicrosoftEdgeWebview2Setup.exe").to_ascii_lowercase(),
                    SimProgram {
                        stamp: FileStamp { created: 1, modified: 1, size: 1_800_000 },
                        identity: FileIdentity::default(),
                        sha256: Some(HASH.to_string()),
                    },
                );
            });
            setup(&sim);
            Self {
                sim: Arc::new(sim),
                pinned: Some(HASH.to_string()),
                enrolled: Mutex::new(None),
                enroll_answer: Mutex::new(Ok(EnrolledInfo { device_name: "Desk 1".into(), kiosk: KioskState::On })),
                enrolls: Mutex::new(Vec::new()),
                _dir: dir,
            }
        }

        fn enroll_calls(&self) -> usize {
            self.enrolls.lock().unwrap().len()
        }
    }

    impl Backend for TestBackend {
        fn check(&self, webview2_attempted: bool) -> Result<CheckResult, String> {
            let report = compat::build_with(self.sim.as_ref(), None, false, Options { webview2_install_attempted: webview2_attempted })
                .map_err(|error| error.to_string())?;
            Ok(CheckResult { enrolled: self.enrolled.lock().unwrap().clone(), report })
        }

        fn install_webview2(&self) -> webview2::Outcome {
            webview2::ensure(self.sim.as_ref(), Path::new(ROOT), self.pinned.as_deref(), Duration::from_secs(1), &CancellationToken::new())
        }

        fn enroll(&self, _code: &str) -> Result<EnrolledInfo, String> {
            self.enrolls.lock().unwrap().push(());
            self.enroll_answer.lock().unwrap().clone()
        }
    }

    /// Plays a whole run: each effect's job is run against the backend and its event fed back.
    fn drive(flow: &mut Flow, backend: &TestBackend, first: Event) {
        let mut effect = flow.on(first);
        while let Effect::Run(job) = effect {
            effect = flow.on(run_job(backend, job));
        }
        assert!(matches!(effect, Effect::Nothing | Effect::Quit));
    }

    fn started(backend: &TestBackend) -> Flow {
        let mut flow = Flow::new();
        drive(&mut flow, backend, Event::Start);
        flow
    }

    #[test]
    fn a_healthy_pc_goes_straight_to_the_code_box() {
        let backend = TestBackend::new(|_| {});
        let flow = started(&backend);
        let Screen::Code { notes, error } = flow.screen() else { panic!("{:?}", flow.screen()) };
        assert_eq!(*error, None);
        assert!(notes.iter().any(|line| line.starts_with("Protection: full")), "{notes:?}");
        assert!(notes.iter().any(|line| line.contains("130.0.2849.80")), "{notes:?}");
        assert!(!backend.sim.with_world(|w| !w.bootstrapper_runs.is_empty()), "nothing was installed");
        let view = flow.view();
        assert!(view.input.is_some() && view.buttons.iter().any(|b| b.action == Action::Enroll && b.default));
    }

    #[test]
    fn a_missing_runtime_is_installed_then_the_report_is_read_again() {
        let backend = TestBackend::new(|sim| sim.with_world(|world| world.webview2_pv = None));
        let mut flow = Flow::new();
        // Start: check (runtime missing) -> install job -> check again (attempted).
        assert_eq!(flow.on(Event::Start), Effect::Run(Job::Check { webview2_attempted: false }));
        let effect = flow.on(run_job(&backend, Job::Check { webview2_attempted: false }));
        assert_eq!(effect, Effect::Run(Job::InstallWebView2));
        assert!(flow.busy() && flow.view().title == strings::INSTALLING_WEBVIEW2_TITLE);
        let effect = flow.on(run_job(&backend, Job::InstallWebView2));
        assert_eq!(effect, Effect::Run(Job::Check { webview2_attempted: true }));
        assert_eq!(flow.on(run_job(&backend, Job::Check { webview2_attempted: true })), Effect::Nothing);
        let Screen::Code { notes, .. } = flow.screen() else { panic!("{:?}", flow.screen()) };
        assert!(notes.iter().any(|line| line.contains("was installed") && line.contains("131.0.2903.51")), "{notes:?}");
        assert_eq!(backend.sim.with_world(|w| w.bootstrapper_runs.len()), 1, "run exactly once");
    }

    #[test]
    fn a_runtime_that_cannot_be_installed_blocks_enrollment() {
        for (name, change) in [
            ("not pinned", Box::new(|b: &mut TestBackend| b.pinned = None) as Box<dyn Fn(&mut TestBackend)>),
            ("run changes nothing", Box::new(|b: &mut TestBackend| b.sim.with_world(|w| w.bootstrapper_installs_pv = None))),
        ] {
            let mut backend = TestBackend::new(|sim| sim.with_world(|world| world.webview2_pv = None));
            change(&mut backend);
            let mut flow = Flow::new();
            drive(&mut flow, &backend, Event::Start);
            let Screen::Blocked { problems, notes } = flow.screen() else { panic!("{name}: {:?}", flow.screen()) };
            assert!(problems.iter().any(|p| p.contains("WebView2")), "{name}: {problems:?}");
            assert!(!notes.is_empty());
            // No second install attempt on "Check again": the report just says the same.
            let runs = backend.sim.with_world(|w| w.bootstrapper_runs.len());
            drive(&mut flow, &backend, Event::CheckAgain);
            assert!(matches!(flow.screen(), Screen::Blocked { .. }), "{name}");
            assert_eq!(backend.sim.with_world(|w| w.bootstrapper_runs.len()), runs, "{name}");
            // And nothing can start an enrollment.
            assert_eq!(flow.on(Event::Submit(good_code())), Effect::Nothing, "{name}");
            assert_eq!(backend.enroll_calls(), 0);
        }
    }

    #[test]
    fn a_wrong_bootstrapper_hash_is_reported_and_blocks() {
        let backend = TestBackend::new(|sim| {
            sim.with_world(|world| {
                world.webview2_pv = None;
                for program in world.programs.values_mut() {
                    program.sha256 = Some("f".repeat(64));
                }
            });
        });
        let flow = started(&backend);
        let Screen::Blocked { notes, .. } = flow.screen() else { panic!("{:?}", flow.screen()) };
        assert!(notes.iter().any(|line| line.contains("not the file it should be")), "{notes:?}");
        assert!(!backend.sim.calls().contains(&SimOp::RunWebviewBootstrapper), "never started");
    }

    #[test]
    fn blockers_stop_enrollment_and_the_code_box_never_appears() {
        for change in [
            Box::new(|sim: &SimPlatform| sim.with_world(|w| w.os.s_mode = true)) as Box<dyn Fn(&SimPlatform)>,
            Box::new(|sim| sim.with_world(|w| w.os.build = 19044)),
            Box::new(|sim| sim.with_world(|w| w.os.domain_joined = true)),
            Box::new(|sim| sim.with_world(|w| w.admins.clear())),
            Box::new(|sim| sim.with_world(|w| w.legal_notice = true)),
        ] {
            let backend = TestBackend::new(|sim| change(sim));
            let mut flow = started(&backend);
            let Screen::Blocked { problems, .. } = flow.screen() else { panic!("{:?}", flow.screen()) };
            assert_eq!(problems.len(), 1);
            let view = flow.view();
            assert!(view.input.is_none(), "no code box");
            assert!(view.buttons.iter().all(|b| b.action != Action::Enroll));
            assert_eq!(flow.on(Event::Submit(good_code())), Effect::Nothing, "a submit is ignored");
            assert_eq!(backend.enroll_calls(), 0);
        }
    }

    #[test]
    fn the_report_screens_say_protection_and_warnings_in_plain_words() {
        let backend = TestBackend::new(|sim| {
            sim.with_world(|w| {
                w.os.edition_id = "Core".into();
                w.protected_print = true;
                w.os.ram_mb = 2048;
            });
        });
        let flow = started(&backend);
        let Screen::Code { notes, .. } = flow.screen() else { panic!("{:?}", flow.screen()) };
        let text = notes.join("\n");
        assert!(text.contains("Protection: reduced") && text.contains("AppLocker rules (L3)"), "{text}");
        assert!(text.contains("protected print mode") && text.contains("less than 3 GB"), "{text}");
    }

    #[test]
    fn an_enrolled_pc_says_so_and_offers_no_code_box() {
        let backend = TestBackend::new(|_| {});
        *backend.enrolled.lock().unwrap() = Some("Desk 7".into());
        let flow = started(&backend);
        assert_eq!(flow.screen(), &Screen::AlreadyEnrolled("Desk 7".into()));
        let view = flow.view();
        assert!(view.input.is_none() && view.lines[0].contains("Desk 7"));
    }

    #[test]
    fn a_good_code_enrolls_and_the_last_screen_says_what_happens_next() {
        let backend = TestBackend::new(|_| {});
        let mut flow = started(&backend);
        drive(&mut flow, &backend, Event::Submit(format!("  {}  ", good_code())));
        assert_eq!(backend.enroll_calls(), 1);
        let Screen::Done(info) = flow.screen() else { panic!("{:?}", flow.screen()) };
        assert_eq!(info.device_name, "Desk 1");
        let text = flow.view().lines.join("\n");
        assert!(text.contains("Desk 1") && text.contains("The kiosk is on"), "{text}");
        assert!(text.contains("get back to Windows") && text.contains("hold Shift"), "{text}");
        // Finish closes.
        assert_eq!(flow.on(Event::Close), Effect::Quit);
        // The kiosk-state variants.
        for (kiosk, expected) in [
            (KioskState::NotOnYet, "not on yet"),
            (KioskState::Failed, "could not finish"),
        ] {
            let backend = TestBackend::new(|_| {});
            *backend.enroll_answer.lock().unwrap() = Ok(EnrolledInfo { device_name: "D".into(), kiosk });
            let mut flow = started(&backend);
            drive(&mut flow, &backend, Event::Submit(good_code()));
            assert!(flow.view().lines.join("\n").contains(expected));
        }
    }

    #[test]
    fn bad_input_never_reaches_the_service() {
        let backend = TestBackend::new(|_| {});
        let mut flow = started(&backend);
        for (text, expected) in [
            ("", strings::CODE_EMPTY),
            ("   \t ", strings::CODE_EMPTY),
            ("not a code", strings::CODE_INVALID),
            ("RBX1.%%%", strings::CODE_INVALID),
            (&"x".repeat(MAX_CODE_LEN + 1), strings::CODE_TOO_LONG),
        ] {
            assert_eq!(flow.on(Event::Submit(text.to_string())), Effect::Nothing);
            let Screen::Code { error, .. } = flow.screen() else { panic!("{:?}", flow.screen()) };
            assert_eq!(error.as_deref(), Some(expected), "{text:?}");
        }
        assert_eq!(backend.enroll_calls(), 0);
    }

    #[test]
    fn a_refused_enrollment_returns_to_the_code_box_with_the_reason() {
        let backend = TestBackend::new(|_| {});
        *backend.enroll_answer.lock().unwrap() = Err("The enrollment code has expired. Create a new one.".into());
        let mut flow = started(&backend);
        drive(&mut flow, &backend, Event::Submit(good_code()));
        let Screen::Code { error, notes } = flow.screen() else { panic!("{:?}", flow.screen()) };
        assert_eq!(error.as_deref(), Some("The enrollment code has expired. Create a new one."));
        assert!(!notes.is_empty(), "the report stays on screen");
        // A second try is possible.
        *backend.enroll_answer.lock().unwrap() = Ok(EnrolledInfo { device_name: "D".into(), kiosk: KioskState::On });
        drive(&mut flow, &backend, Event::Submit(good_code()));
        assert!(matches!(flow.screen(), Screen::Done(_)));
        assert_eq!(backend.enroll_calls(), 2);
    }

    #[test]
    fn a_failed_check_is_fatal_and_can_be_repeated() {
        let backend = TestBackend::new(|_| {});
        let mut flow = Flow::new();
        assert!(matches!(flow.on(Event::Start), Effect::Run(_)));
        assert_eq!(flow.on(Event::Checked(Err(strings::NOT_RUNNING.into()))), Effect::Nothing);
        assert_eq!(flow.screen(), &Screen::Fatal(strings::NOT_RUNNING.into()));
        assert_eq!(flow.on(Event::Submit(good_code())), Effect::Nothing);
        drive(&mut flow, &backend, Event::CheckAgain);
        assert!(matches!(flow.screen(), Screen::Code { .. }));
    }

    #[test]
    fn close_is_ignored_while_a_job_runs() {
        let mut flow = Flow::new();
        flow.on(Event::Start);
        assert!(flow.busy());
        assert_eq!(flow.on(Event::Close), Effect::Nothing);
        assert!(flow.view().busy && flow.view().buttons.is_empty() && flow.view().input.is_none());
    }

    #[test]
    fn the_code_is_never_printed_by_a_job_or_a_view() {
        let code = good_code();
        let job = Job::Enroll(code.clone());
        assert!(!format!("{job:?}").contains("RBX1"));
        let backend = TestBackend::new(|_| {});
        let mut flow = started(&backend);
        let effect = flow.on(Event::Submit(code.clone()));
        assert_eq!(effect, Effect::Run(Job::Enroll(code.clone())));
        let view = format!("{:?}", flow.view());
        assert!(!view.contains(&code) && !view.contains("RBX1"), "{view}");
    }

    #[test]
    fn every_screen_has_a_title_and_a_way_out_except_while_busy() {
        let info = EnrolledInfo { device_name: "D".into(), kiosk: KioskState::On };
        for screen in [
            Screen::Checking,
            Screen::InstallingWebView2,
            Screen::Enrolling,
            Screen::Blocked { notes: vec![], problems: vec!["x".into()] },
            Screen::Code { notes: vec![], error: None },
            Screen::Done(info),
            Screen::AlreadyEnrolled("D".into()),
            Screen::Fatal("x".into()),
        ] {
            let flow = Flow { screen: screen.clone(), webview2_attempted: false, webview2_note: None, notes: vec![] };
            let view = flow.view();
            assert!(!view.title.is_empty(), "{screen:?}");
            assert_eq!(view.buttons.is_empty(), view.busy, "{screen:?}");
            // Exactly one default button when there are buttons (Enter does one thing).
            assert!(view.busy || view.buttons.iter().filter(|b| b.default).count() == 1, "{screen:?}");
        }
    }
}
