//! The enrollment code the MSI leaves for a silent install (Phase 6 Step 8, plan 4.10):
//! `msiexec /i Rulebox.msi /qn ENROLLCODE=<code>` writes it to
//! `HKLM\SOFTWARE\Rulebox\Install\Pending`, value `Code` (SYSTEM and Administrators only).
//!
//! The service reads it **once**, at its start (see [`run`]), enrolls with it (up to
//! [`MAX_TRIES`] tries, only while the answer says "try again"), and then **deletes it in every
//! outcome**: success, "already enrolled", a refused or expired code, three failed tries, a blocker.
//! A clear entry goes to the Windows Application event log each time, saying what happened and what
//! to do next. The only case that keeps the value is a service stop in the middle of an attempt:
//! the next start reads it again, because the code was not used up.
//!
//! The code is never logged, never put in an event and never in an error. It only lives in a
//! [`Zeroizing`] string and in the parameters of the one call that carries it to the enroller.

use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use rulebox_ipc::admin::{reasons, AdminEnrollParams, AdminEnrollResult, OperationFailure};
use rulebox_ipc::RpcError;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use crate::enroll::Enroller;
use crate::ipc_admin::AdminHandler;
use crate::platform::{EventKind, Platform, RegData, RegValueRef};
use crate::setup::strings;
use crate::state::SharedState;

/// The value the MSI writes (`Package.wxs`, component `PendingEnrollment`).
pub fn pending_key() -> RegValueRef {
    RegValueRef {
        path: rulebox_win32::installmarker::PENDING_KEY.to_string(),
        name: rulebox_win32::installmarker::PENDING_VALUE.to_string(),
    }
}

/// Three tries in all (plan Step 8, item 3).
pub const MAX_TRIES: u32 = 3;
/// The wait before the second and the third try (a PC that has just been installed may not have
/// its network up yet).
pub const RETRY_DELAYS: [Duration; 2] = [Duration::from_secs(10), Duration::from_secs(60)];
/// An enrollment code is far shorter; a longer value is not one.
pub const MAX_CODE_LEN: usize = 4096;

/// What became of the pending code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// There was no code: nothing was done.
    NoCode,
    Enrolled,
    /// The PC was enrolled already (before, or the answer said so): the code was not used.
    AlreadyEnrolled,
    /// No try worked. `reason` is a code such as `token_expired` or `backend_unreachable`.
    Failed { reason: String, tries: u32 },
    /// The value exists but could not be read; it was left alone.
    Unreadable,
    /// The service stopped during an attempt; the code stays for the next start.
    Interrupted,
}

/// The reason of a failed enroll call, as a code (never free text from the server): the
/// `operation_failed` reason, plus the blocker codes for `compat_blocked`.
fn failure_reason(error: &RpcError) -> String {
    let failure: Option<OperationFailure> = error.data.clone().and_then(|data| serde_json::from_value(data).ok());
    let Some(failure) = failure else {
        return serde_json::to_value(error.code)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| "failed".to_string());
    };
    if failure.reason == reasons::COMPAT_BLOCKED {
        let blockers: Vec<String> = failure
            .details
            .as_ref()
            .and_then(|details| details.get("blockers"))
            .and_then(serde_json::Value::as_array)
            .map(|list| list.iter().filter_map(|b| b.as_str()).map(str::to_string).collect())
            .unwrap_or_default();
        if !blockers.is_empty() {
            return format!("{}: {}", failure.reason, blockers.join(", "));
        }
    }
    failure.reason
}

fn event(platform: &dyn Platform, kind: EventKind, id: u32, text: &str) {
    if let Err(error) = platform.report_event(kind, id, text) {
        tracing::warn!("cannot write the event log entry {id}: {error}");
    }
}

/// Deletes the value; true when it is gone.
fn delete(platform: &dyn Platform) -> bool {
    match platform.write_machine_value(&pending_key(), None) {
        Ok(()) => true,
        Err(error) => {
            tracing::error!("cannot delete the pending enrollment code: {error}");
            false
        }
    }
}

/// Reads the pending code once, enrolls with it and deletes it. See the module comment.
///
/// - `enrolled`: whether this PC already has a live enrollment.
/// - `prepare`: runs once, after a code was found and before the first try (the service installs
///   the WebView2 Runtime there); never run when there is no code.
/// - `enroll`: one enroll call with the given parameters.
/// - `delays`: the waits before the second and later tries.
pub async fn consume(
    platform: &dyn Platform,
    enrolled: &(dyn Fn() -> bool + Send + Sync),
    prepare: &mut (dyn FnMut() -> BoxFuture<'static, ()> + Send),
    enroll: &mut (dyn FnMut(AdminEnrollParams) -> BoxFuture<'static, Result<AdminEnrollResult, RpcError>> + Send),
    delays: &[Duration],
    shutdown: &CancellationToken,
) -> Outcome {
    let code: Zeroizing<String> = match platform.read_machine_value(&pending_key()) {
        Ok(None) => return Outcome::NoCode,
        Ok(Some(RegData::String(text))) => Zeroizing::new(text.trim().to_string()),
        // Not text: not a code. Treated like an empty one below.
        Ok(Some(RegData::Dword(_))) => Zeroizing::new(String::new()),
        Err(error) => {
            tracing::error!("cannot read the pending enrollment code: {error}");
            event(platform, EventKind::Error, strings::EVENT_PENDING_UNREADABLE, strings::EVENT_UNREADABLE);
            return Outcome::Unreadable;
        }
    };
    tracing::info!("the installer left an enrollment code; using it once");

    let outcome = if code.is_empty() || code.len() > MAX_CODE_LEN {
        Outcome::Failed { reason: reasons::CODE_INVALID.to_string(), tries: 0 }
    } else if enrolled() {
        Outcome::AlreadyEnrolled
    } else {
        tokio::select! {
            () = shutdown.cancelled() => Outcome::Interrupted,
            outcome = attempts(&code, prepare, enroll, delays) => outcome,
        }
    };
    if outcome == Outcome::Interrupted {
        tracing::info!("the service is stopping; the pending enrollment code stays for the next start");
        return outcome;
    }

    // Every other path ends here: the code is used up, whatever came of it.
    let deleted = delete(platform);
    match &outcome {
        Outcome::Enrolled => {
            tracing::info!("enrolled with the code from the installer");
            event(platform, EventKind::Information, strings::EVENT_PENDING_ENROLLED, strings::EVENT_ENROLLED);
        }
        Outcome::AlreadyEnrolled => {
            tracing::info!("already enrolled; the code from the installer was not needed");
            event(platform, EventKind::Information, strings::EVENT_PENDING_ALREADY, strings::EVENT_ALREADY);
        }
        Outcome::Failed { reason, tries } => {
            tracing::error!(reason = %reason, tries, "could not enroll with the code from the installer; the code was deleted");
            event(platform, EventKind::Error, strings::EVENT_PENDING_FAILED, &strings::event_failed(reason, *tries));
        }
        Outcome::NoCode | Outcome::Unreadable | Outcome::Interrupted => {}
    }
    if !deleted {
        event(platform, EventKind::Warning, strings::EVENT_PENDING_NOT_DELETED, strings::EVENT_NOT_DELETED);
    }
    outcome
}

/// The tries themselves. Cancelled from outside by dropping the future.
async fn attempts(
    code: &Zeroizing<String>,
    prepare: &mut (dyn FnMut() -> BoxFuture<'static, ()> + Send),
    enroll: &mut (dyn FnMut(AdminEnrollParams) -> BoxFuture<'static, Result<AdminEnrollResult, RpcError>> + Send),
    delays: &[Duration],
) -> Outcome {
    prepare().await;
    let mut tries = 0u32;
    loop {
        tries += 1;
        let params = AdminEnrollParams { code: code.to_string(), device_name: None, allow_joined: false };
        match enroll(params).await {
            Ok(_) => return Outcome::Enrolled,
            Err(error) => {
                let reason = failure_reason(&error);
                if reason == reasons::ALREADY_ENROLLED {
                    return Outcome::AlreadyEnrolled;
                }
                if !error.retryable || tries >= MAX_TRIES {
                    return Outcome::Failed { reason, tries };
                }
                tracing::warn!(reason = %reason, tries, "the enrollment with the installer's code failed; trying again");
                let wait = delays.get(tries as usize - 1).copied().unwrap_or(Duration::from_secs(60));
                tokio::time::sleep(wait).await;
            }
        }
    }
}

/// The service's task: handles the pending code, once, at start. Does nothing when there is none.
/// `install_root` is where the WebView2 bootstrapper lies.
pub async fn run(
    platform: Arc<dyn Platform>,
    enroller: Arc<Enroller>,
    shared: Arc<SharedState>,
    install_root: std::path::PathBuf,
    shutdown: CancellationToken,
) {
    let enrolled = {
        let shared = Arc::clone(&shared);
        move || shared.read(|state| state.enrollment.as_ref().is_some_and(|enrollment| !enrollment.revoked))
    };
    let mut prepare = {
        let platform = Arc::clone(&platform);
        let cancel = shutdown.clone();
        move || -> BoxFuture<'static, ()> {
            let platform = Arc::clone(&platform);
            let root = install_root.clone();
            let cancel = cancel.clone();
            Box::pin(async move {
                // A silent install has no Setup window, so the service installs the runtime the
                // Staff App needs (hash-verified, and only when it is missing or too old).
                let outcome = tokio::task::spawn_blocking(move || {
                    crate::setup::webview2::ensure(
                        platform.as_ref(),
                        &root,
                        crate::setup::webview2::PINNED_SHA256,
                        crate::setup::webview2::RUN_TIMEOUT,
                        &cancel,
                    )
                })
                .await;
                match outcome {
                    Ok(outcome) if outcome.is_good() => tracing::info!(?outcome, "WebView2 Runtime checked"),
                    Ok(outcome) => tracing::warn!(?outcome, "the WebView2 Runtime is not ready; enrolling anyway"),
                    Err(error) => tracing::warn!("the WebView2 check did not finish: {error}"),
                }
            })
        }
    };
    let mut enroll = move |params: AdminEnrollParams| enroller.enroll(params);
    consume(platform.as_ref(), &enrolled, &mut prepare, &mut enroll, &RETRY_DELAYS, &shutdown).await;
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Mutex;

    use futures_util::FutureExt;
    use rulebox_ipc::types::KioskStatus;

    use super::*;
    use crate::ipc_admin::operation_failed;
    use crate::platform::sim::{SimOp, SimPlatform};
    use crate::platform::PlatformError;
    use crate::testutil::TempDir;

    /// A code that looks like a real one; every test checks it appears nowhere it should not.
    const SECRET: &str = "RBX1.s3cr3t-token-value#https://example.convex.cloud";

    fn machine(code: Option<&str>) -> (TempDir, SimPlatform) {
        let dir = TempDir::new();
        let sim = SimPlatform::new(dir.path().to_path_buf());
        sim.with_world(|world| {
            // The real key rule, so a delete outside machinereg's allow-list fails here, not on a VM.
            world.strict_machine_keys = true;
            if let Some(code) = code {
                world.machine_values.insert(pending_key(), RegData::String(code.to_string()));
            }
        });
        (dir, sim)
    }

    fn code_present(sim: &SimPlatform) -> bool {
        sim.with_world(|world| world.machine_values.contains_key(&pending_key()))
    }

    fn ok_result() -> AdminEnrollResult {
        AdminEnrollResult {
            device_id: "dev1".into(),
            device_name: "Desk 1".into(),
            kiosk: KioskStatus { enabled: true, phase: rulebox_ipc::types::KioskPhase::Applied, error_code: None },
        }
    }

    fn failure(reason: &str, retryable: bool) -> RpcError {
        operation_failed(reason, "text", retryable, None)
    }

    /// Everything one `consume` run did.
    struct Run {
        outcome: Outcome,
        calls: u32,
        codes_seen: Vec<String>,
        prepared: u32,
    }

    async fn go(
        sim: &SimPlatform,
        enrolled: bool,
        mut answers: Vec<Result<AdminEnrollResult, RpcError>>,
        shutdown: &CancellationToken,
    ) -> Run {
        let seen = Mutex::new(Vec::<String>::new());
        let calls = AtomicU32::new(0);
        let prepared = AtomicU32::new(0);
        answers.reverse();
        let answers = Mutex::new(answers);
        let mut prepare = || -> BoxFuture<'static, ()> {
            prepared.fetch_add(1, Ordering::SeqCst);
            std::future::ready(()).boxed()
        };
        let mut enroll = |params: AdminEnrollParams| {
            calls.fetch_add(1, Ordering::SeqCst);
            seen.lock().unwrap().push(params.code.clone());
            let answer = answers.lock().unwrap().pop().unwrap_or_else(|| Err(failure("test_script_ran_out", false)));
            std::future::ready(answer).boxed()
        };
        let outcome = consume(sim, &|| enrolled, &mut prepare, &mut enroll, &RETRY_DELAYS, shutdown).await;
        Run { outcome, calls: calls.load(Ordering::SeqCst), codes_seen: seen.into_inner().unwrap(), prepared: prepared.load(Ordering::SeqCst) }
    }

    /// Every event the machine got, as text; none may hold the code.
    fn events(sim: &SimPlatform) -> Vec<(EventKind, u32, String)> {
        let events = sim.with_world(|world| world.events.clone());
        for (_, _, text) in &events {
            assert!(!text.contains("s3cr3t") && !text.contains("RBX1"), "an event holds the code: {text}");
        }
        events
    }

    #[tokio::test(start_paused = true)]
    async fn no_code_means_no_call_no_delete_and_no_event() {
        let (_dir, sim) = machine(None);
        let run = go(&sim, false, vec![], &CancellationToken::new()).await;
        assert_eq!(run.outcome, Outcome::NoCode);
        assert_eq!((run.calls, run.prepared), (0, 0));
        assert!(events(&sim).is_empty());
        assert!(!sim.calls().contains(&SimOp::WriteMachineValue));
    }

    #[tokio::test(start_paused = true)]
    async fn a_good_code_enrolls_once_and_is_deleted() {
        let logs = crate::testutil::capture_logs();
        let (_dir, sim) = machine(Some(&format!("  {SECRET}  ")));
        let run = go(&sim, false, vec![Ok(ok_result())], &CancellationToken::new()).await;
        assert_eq!(run.outcome, Outcome::Enrolled);
        assert_eq!((run.calls, run.prepared), (1, 1));
        assert_eq!(run.codes_seen, [SECRET], "trimmed, and sent exactly once");
        assert!(!code_present(&sim), "deleted");
        let events = events(&sim);
        assert_eq!(events.len(), 1);
        assert_eq!((events[0].0, events[0].1), (EventKind::Information, strings::EVENT_PENDING_ENROLLED));
        // Read once: one read, one delete.
        let calls = sim.calls();
        assert_eq!(calls.iter().filter(|op| **op == SimOp::ReadMachineValue).count(), 1);
        assert_eq!(calls.iter().filter(|op| **op == SimOp::WriteMachineValue).count(), 1);
        assert!(logs.text().contains("the installer left an enrollment code"), "the step is logged");
        assert!(!logs.text().contains("s3cr3t-token-value"), "the code is never logged");
    }

    #[tokio::test(start_paused = true)]
    async fn a_network_that_is_not_up_yet_gets_three_tries_with_waits() {
        let (_dir, sim) = machine(Some(SECRET));
        let down = || failure(reasons::BACKEND_UNREACHABLE, true);
        let start = tokio::time::Instant::now();
        let run = go(&sim, false, vec![Err(down()), Err(down()), Ok(ok_result())], &CancellationToken::new()).await;
        assert_eq!(run.outcome, Outcome::Enrolled);
        assert_eq!(run.calls, 3);
        assert_eq!(start.elapsed(), RETRY_DELAYS[0] + RETRY_DELAYS[1]);
        assert_eq!(run.prepared, 1, "the runtime check runs once, not per try");
        assert!(!code_present(&sim));
    }

    #[tokio::test(start_paused = true)]
    async fn three_failed_tries_delete_the_code_and_say_so_in_the_event_log() {
        let logs = crate::testutil::capture_logs();
        let (_dir, sim) = machine(Some(SECRET));
        let down = || failure(reasons::BACKEND_UNREACHABLE, true);
        let run = go(&sim, false, vec![Err(down()), Err(down()), Err(down()), Ok(ok_result())], &CancellationToken::new()).await;
        assert_eq!(run.outcome, Outcome::Failed { reason: "backend_unreachable".into(), tries: 3 });
        assert_eq!(run.calls, 3, "never a fourth");
        assert!(!code_present(&sim), "deleted after the third failure");
        let events = events(&sim);
        assert_eq!(events.len(), 1);
        let (kind, id, text) = &events[0];
        assert_eq!((*kind, *id), (EventKind::Error, strings::EVENT_PENDING_FAILED));
        assert!(text.contains("backend_unreachable") && text.contains("3 tries") && text.contains("deleted") && text.contains("Rulebox Setup"), "{text}");
        assert!(!logs.text().contains("s3cr3t-token-value"), "the code is never logged, not even on failure");
    }

    #[tokio::test(start_paused = true)]
    async fn a_code_the_server_refuses_is_tried_once_and_deleted() {
        for reason in [reasons::TOKEN_EXPIRED, reasons::TOKEN_USED_UP, reasons::TOKEN_REVOKED, reasons::TOKEN_INVALID, reasons::CODE_INVALID] {
            let (_dir, sim) = machine(Some(SECRET));
            let run = go(&sim, false, vec![Err(failure(reason, false))], &CancellationToken::new()).await;
            assert_eq!(run.outcome, Outcome::Failed { reason: reason.to_string(), tries: 1 }, "{reason}");
            assert_eq!(run.calls, 1);
            assert!(!code_present(&sim), "{reason}");
            assert_eq!(events(&sim).len(), 1);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn blockers_stop_enrollment_and_the_event_names_them() {
        let (_dir, sim) = machine(Some(SECRET));
        let blocked = operation_failed(reasons::COMPAT_BLOCKED, "text", false, Some(serde_json::json!({ "blockers": ["s_mode", "legal_notice"] })));
        let run = go(&sim, false, vec![Err(blocked)], &CancellationToken::new()).await;
        assert_eq!(run.outcome, Outcome::Failed { reason: "compat_blocked: s_mode, legal_notice".into(), tries: 1 });
        assert!(!code_present(&sim));
        assert!(events(&sim)[0].2.contains("s_mode, legal_notice"));
    }

    #[tokio::test(start_paused = true)]
    async fn an_enrolled_pc_does_not_use_the_code_but_still_deletes_it() {
        let (_dir, sim) = machine(Some(SECRET));
        let run = go(&sim, true, vec![Ok(ok_result())], &CancellationToken::new()).await;
        assert_eq!(run.outcome, Outcome::AlreadyEnrolled);
        assert_eq!((run.calls, run.prepared), (0, 0));
        assert!(!code_present(&sim));
        assert_eq!(events(&sim)[0].1, strings::EVENT_PENDING_ALREADY);
        // The same when the answer says so.
        let (_dir, sim) = machine(Some(SECRET));
        let run = go(&sim, false, vec![Err(failure(reasons::ALREADY_ENROLLED, false))], &CancellationToken::new()).await;
        assert_eq!(run.outcome, Outcome::AlreadyEnrolled);
        assert!(!code_present(&sim));
    }

    #[tokio::test(start_paused = true)]
    async fn an_empty_or_oversized_or_not_text_value_is_deleted_without_a_call() {
        let long = "x".repeat(MAX_CODE_LEN + 1);
        for value in [RegData::String(String::new()), RegData::String("   ".into()), RegData::String(long), RegData::Dword(1)] {
            let (_dir, sim) = machine(None);
            sim.with_world(|world| world.machine_values.insert(pending_key(), value.clone()));
            let run = go(&sim, false, vec![Ok(ok_result())], &CancellationToken::new()).await;
            assert_eq!(run.outcome, Outcome::Failed { reason: "code_invalid".into(), tries: 0 }, "{value:?}");
            assert_eq!(run.calls, 0);
            assert!(!code_present(&sim));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_delete_that_fails_is_reported_and_the_next_start_finds_the_pc_enrolled() {
        let (_dir, sim) = machine(Some(SECRET));
        sim.fail_next(SimOp::WriteMachineValue, PlatformError::AccessDenied);
        let run = go(&sim, false, vec![Ok(ok_result())], &CancellationToken::new()).await;
        assert_eq!(run.outcome, Outcome::Enrolled);
        assert!(code_present(&sim));
        let events = events(&sim);
        assert!(events.iter().any(|(kind, id, _)| (*kind, *id) == (EventKind::Warning, strings::EVENT_PENDING_NOT_DELETED)));
        // Next start: enrolled, so the code is not used, and this time it can be deleted.
        let again = go(&sim, true, vec![], &CancellationToken::new()).await;
        assert_eq!(again.outcome, Outcome::AlreadyEnrolled);
        assert!(!code_present(&sim));
    }

    #[tokio::test(start_paused = true)]
    async fn an_unreadable_value_is_left_alone_and_reported() {
        let (_dir, sim) = machine(Some(SECRET));
        sim.fail_next(SimOp::ReadMachineValue, PlatformError::AccessDenied);
        let run = go(&sim, false, vec![Ok(ok_result())], &CancellationToken::new()).await;
        assert_eq!(run.outcome, Outcome::Unreadable);
        assert_eq!(run.calls, 0);
        assert!(code_present(&sim));
        assert_eq!(events(&sim)[0].1, strings::EVENT_PENDING_UNREADABLE);
    }

    #[tokio::test(start_paused = true)]
    async fn a_stop_in_the_middle_keeps_the_code_for_the_next_start() {
        let (_dir, sim) = machine(Some(SECRET));
        let shutdown = CancellationToken::new();
        // The enroller never answers; the stop arrives while it waits.
        let stopper = shutdown.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            stopper.cancel();
        });
        let mut prepare = || -> BoxFuture<'static, ()> { std::future::ready(()).boxed() };
        let mut enroll = |_params: AdminEnrollParams| -> BoxFuture<'static, Result<AdminEnrollResult, RpcError>> { futures_util::future::pending().boxed() };
        let outcome = consume(&sim, &|| false, &mut prepare, &mut enroll, &RETRY_DELAYS, &shutdown).await;
        assert_eq!(outcome, Outcome::Interrupted);
        assert!(code_present(&sim), "the code was not used up");
        assert!(events(&sim).is_empty());
    }

    #[test]
    fn the_pending_key_is_the_one_the_msi_writes_and_the_agent_may_delete() {
        let key = pending_key();
        assert_eq!(key.path, r"SOFTWARE\Rulebox\Install\Pending");
        assert_eq!(key.name, "Code");
        // The same text as Package.wxs.
        let wxs = include_str!("../../../installer/Package.wxs");
        assert!(wxs.contains(r#"Key="SOFTWARE\Rulebox\Install\Pending""#) && wxs.contains(r#"Name="Code""#));
        // machinereg lets exactly this delete through.
        assert!(rulebox_win32::machinereg::check_write(&key.path, &key.name, None).is_ok());
    }

    #[test]
    fn the_failure_reason_is_a_code_and_never_server_text() {
        let error = RpcError { code: rulebox_ipc::ErrorCode::Busy, message: "free text".into(), retryable: true, data: None };
        assert_eq!(failure_reason(&error), "busy");
        assert_eq!(failure_reason(&failure("token_expired", false)), "token_expired");
    }
}
