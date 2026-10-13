//! The hidden admin exit (plan Section 5.10, protocol 1.1): the PIN gate behind
//! `adminExit.submit` and the sign-out flow that follows a correct PIN.
//!
//! A correct PIN ends the Staff session and shows the Windows sign-in screen. It
//! grants **no** administrator right, which is why any process in the Staff session
//! may call the method. What protects the PIN is that the hash never leaves the
//! agent and that guesses are rate-limited per device (`lockout::PIN_POLICY`,
//! persisted in `lockouts.json`).
//!
//! The PIN is never logged and never stored: it lives in one `String` for the
//! duration of one request.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use rulebox_ipc::methods::{AdminExitSubmit, Method};
use rulebox_ipc::requests::{AdminExitOutcome, AdminExitSubmitParams, AdminExitSubmitResult};
use rulebox_ipc::types::ShutdownReason;
use rulebox_ipc::{ErrorCode, RpcError, CAP_ADMIN_EXIT};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot, watch};

use crate::agent_policy::AgentPolicy;
use crate::audit::{AuditHandle, AuditKind};
use crate::ipc_conn::{rpc_error, PeerCtx, RpcResult};
use crate::ipc_shell::{ShellBroadcast, ShellExtension};
use crate::kdf;
use crate::lockout::{Gate, LockoutStore, PIN_POLICY};
use crate::platform::{Platform, PlatformError, RegData, RegValueRef};
use crate::session::SessionManager;
use crate::state::lock;

/// Shortest and longest exit PIN the agent accepts when one is typed, in ASCII
/// digits. A PIN set earlier with fewer digits keeps working.
pub const MIN_PIN_DIGITS: usize = 4;
pub const MAX_PIN_DIGITS: usize = 12;
/// Shortest PIN `rulebox-agent hash-pin` will create a hash for. The hash is a
/// portable string that travels in the desired-state document, so a short PIN could
/// be guessed offline by anyone who reads it; six digits is also what the dashboard
/// asks for (PRD 12.4).
pub const MIN_NEW_PIN_DIGITS: usize = 6;
/// How long the client has to finish what it is doing before the sign-out
/// (`agent.shuttingDown.graceMs`, also the pause before the sign-out call).
pub const EXIT_GRACE_MS: u64 = 2000;
/// How long `adminExit.submit` waits for the reconciler to prepare the sign-out.
const PREPARE_TIMEOUT: Duration = Duration::from_secs(3);
/// Pauses before the second, third and fourth `logoff_session` attempt.
const LOGOFF_RETRY_DELAYS: [Duration; 3] =
    [Duration::from_secs(1), Duration::from_secs(2), Duration::from_secs(4)];

/// `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon`, value
/// `AutoAdminLogon`: the one machine-wide value the exit touches. Written only
/// when the kiosk is applied, and only before the sign-out, so Windows shows the
/// sign-in screen instead of signing the Staff account straight back in.
pub(crate) const WINLOGON_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon";
pub(crate) const AUTO_ADMIN_LOGON: &str = "AutoAdminLogon";

/// What `adminExit.submit` sends to the reconciler after a correct PIN.
pub struct ExitRequest {
    /// The caller's own verified session: the only one that is ever signed out.
    pub session_id: u32,
    /// Answered `Ok` when the sign-out is prepared, `Err(reason)` when it cannot be.
    pub prepared: oneshot::Sender<Result<(), String>>,
    /// Where `run_exit` records an `adminExitFailed` that happens after "prepared".
    pub audit: Arc<AuditHandle>,
}

pub struct AdminExitDeps {
    pub policy_rx: watch::Receiver<AgentPolicy>,
    /// Shared with the employee-password counters (`lockouts.json`).
    pub lockouts: Arc<Mutex<LockoutStore>>,
    pub audit: Arc<AuditHandle>,
    pub session: Arc<SessionManager>,
    pub exit_tx: mpsc::Sender<ExitRequest>,
    /// The wall clock, in Unix milliseconds.
    pub now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
}

struct Inner {
    policy_rx: watch::Receiver<AgentPolicy>,
    lockouts: Arc<Mutex<LockoutStore>>,
    audit: Arc<AuditHandle>,
    session: Arc<SessionManager>,
    exit_tx: mpsc::Sender<ExitRequest>,
    now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    /// The PIN gate: one check at a time, so parallel requests cannot race the
    /// failure counter.
    gate: Arc<tokio::sync::Mutex<()>>,
}

pub struct AdminExit {
    inner: Arc<Inner>,
}

/// What `rulebox-agent status` shows about the exit. Counters only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitStatus {
    pub failures: u32,
    pub locked_for_ms: Option<u64>,
    pub problem: Option<String>,
}

impl AdminExit {
    pub fn new(deps: AdminExitDeps) -> Arc<Self> {
        Arc::new(Self {
            inner: Arc::new(Inner {
                policy_rx: deps.policy_rx,
                lockouts: deps.lockouts,
                audit: deps.audit,
                session: deps.session,
                exit_tx: deps.exit_tx,
                now_ms: deps.now_ms,
                gate: Arc::new(tokio::sync::Mutex::new(())),
            }),
        })
    }

    /// Read-only. A counter that belongs to a PIN that has since been rotated is
    /// shown as empty, because the next submit clears it.
    pub fn status(&self) -> ExitStatus {
        let policy = self.inner.policy_rx.borrow().admin_exit.clone();
        let now_ms = (self.inner.now_ms)();
        let current_id = policy.pin_hash.as_deref().map(pin_id);
        let mut store = lock(&self.inner.lockouts);
        let stale = store.admin_exit_pin_id().is_some() && *store.admin_exit_pin_id() != current_id;
        let (failures, locked_for_ms) = if stale {
            (0, None)
        } else {
            let counter = store.admin_exit();
            (counter.failures, counter.locked_for(now_ms).map(|left| left.min(counter.lock_ms)))
        };
        ExitStatus { failures, locked_for_ms, problem: policy.problem }
    }
}

impl ShellExtension for AdminExit {
    fn capabilities(&self) -> Vec<&'static str> {
        vec![CAP_ADMIN_EXIT]
    }

    fn handle(
        &self,
        peer: &PeerCtx,
        method: &str,
        params: serde_json::Value,
    ) -> Option<BoxFuture<'static, RpcResult>> {
        if method != AdminExitSubmit::NAME {
            return None;
        }
        let inner = Arc::clone(&self.inner);
        let session_id = peer.session_id;
        Some(
            async move {
                // The serde error text is not passed on: it could quote the PIN.
                let params: AdminExitSubmitParams =
                    serde_json::from_value(params).map_err(|_| invalid_params())?;
                let result = submit(&inner, session_id, params.pin).await?;
                serde_json::to_value(result).map_err(|_| internal())
            }
            .boxed(),
        )
    }
}

// -- small helpers ------------------------------------------------------------------

fn invalid_params() -> RpcError {
    rpc_error(ErrorCode::InvalidParams, "The parameters are not valid.", false)
}

fn internal() -> RpcError {
    rpc_error(ErrorCode::Internal, "Internal error.", true)
}

fn outcome(outcome: AdminExitOutcome) -> AdminExitSubmitResult {
    AdminExitSubmitResult { outcome, attempts_left: None, retry_after_ms: None }
}

fn locked_out(retry_after_ms: u64) -> AdminExitSubmitResult {
    AdminExitSubmitResult { retry_after_ms: Some(retry_after_ms), ..outcome(AdminExitOutcome::LockedOut) }
}

/// 4 to 12 ASCII digits.
pub fn valid_pin(pin: &str) -> bool {
    (MIN_PIN_DIGITS..=MAX_PIN_DIGITS).contains(&pin.len()) && pin.bytes().all(|b| b.is_ascii_digit())
}

/// The first 16 hex characters of the SHA-256 of the `pinHash` string. It names
/// "which PIN does the counter belong to" without being the hash itself.
pub fn pin_id(pin_hash: &str) -> String {
    let digest = Sha256::digest(pin_hash.as_bytes());
    let mut id = String::with_capacity(16);
    for byte in digest.iter().take(8) {
        id.push_str(&format!("{byte:02x}"));
    }
    id
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HashPinError {
    #[error("the PIN must be 6 to 12 digits")]
    NotAPin,
    #[error("hashing failed: {0}")]
    Hash(String),
}

/// `rulebox-agent hash-pin`: one line of input (the line ending is ignored) to the
/// `kdf::hash_secret` PHC string. Touches no file, pipe or registry key.
pub fn hash_pin_line(line: &str) -> Result<String, HashPinError> {
    let pin = line.trim_end_matches(['\r', '\n']);
    if !valid_pin(pin) || pin.len() < MIN_NEW_PIN_DIGITS {
        return Err(HashPinError::NotAPin);
    }
    kdf::hash_secret(pin).map_err(|error| HashPinError::Hash(error.to_string()))
}

// -- adminExit.submit (Section 5.10, steps 1 to 9) -----------------------------------

async fn submit(
    inner: &Arc<Inner>,
    session_id: u32,
    pin: String,
) -> Result<AdminExitSubmitResult, RpcError> {
    // 1. Not a guess the dialog can produce: not counted.
    if !valid_pin(&pin) {
        return Err(invalid_params());
    }
    // 2. Off, or no valid PIN. The hash is read once so one request never mixes two
    //    documents.
    let policy = inner.policy_rx.borrow().admin_exit.clone();
    let pin_hash = match policy.pin_hash {
        Some(hash) if policy.enabled => hash,
        _ => return Ok(outcome(AdminExitOutcome::Disabled)),
    };
    // 3. One check at a time.
    let Ok(_gate) = Arc::clone(&inner.gate).try_lock_owned() else {
        return Err(rpc_error(ErrorCode::Busy, "Another PIN check is running.", true));
    };

    let now_ms = (inner.now_ms)();
    let after_count = {
        let mut store = lock(&inner.lockouts);
        // 4. A rotated PIN starts a clean counter.
        let id = pin_id(&pin_hash);
        if store.admin_exit_pin_id().as_deref() != Some(id.as_str()) {
            store.admin_exit().clear();
            *store.admin_exit_pin_id() = Some(id);
            if let Err(error) = store.save(now_ms) {
                tracing::error!("cannot save lockouts.json: {error}");
            }
        }
        // 5. Locked: the PIN is not checked and nothing is counted.
        let before = store.admin_exit().clone();
        let gate = store.admin_exit().gate(&PIN_POLICY, now_ms);
        if *store.admin_exit() != before {
            // The clock rule moved the lock.
            if let Err(error) = store.save(now_ms) {
                tracing::error!("cannot save lockouts.json: {error}");
            }
        }
        if let Gate::Locked { retry_after_ms } = gate {
            return Ok(locked_out(retry_after_ms));
        }
        // 6. Count first, so killing the agent in the middle of a check never gives
        //    a free guess. If the file cannot be written nothing is checked.
        let after_count = store.admin_exit().record_failure(&PIN_POLICY, now_ms);
        if let Err(error) = store.save(now_ms) {
            tracing::error!("cannot save lockouts.json, so no PIN is checked: {error}");
            store.admin_exit().undo_failure();
            return Err(internal());
        }
        after_count
    };

    // 7. The Argon2id check, off the async threads. If this future is dropped from
    //    here on (the client went away) the failure simply stays counted.
    let verified = tokio::task::spawn_blocking(move || kdf::verify_secret(&pin, &pin_hash)).await;
    match verified {
        Ok(Ok(true)) => {}
        Ok(Ok(false)) => return Ok(wrong_pin(inner, after_count)),
        Ok(Err(kdf::KdfError::Invalid(_))) => {
            // `AgentPolicy` only keeps hashes that passed `check_hash`, so this is
            // not reachable; if it ever is, it was not a guess.
            tracing::error!("the exit PIN hash was refused by the check; no PIN is accepted");
            undo_count(inner);
            return Err(internal());
        }
        // The count stays: failing closed is the point of counting first.
        Ok(Err(kdf::KdfError::Internal(error))) => {
            tracing::error!("PIN check failed: {error}");
            return Err(internal());
        }
        Err(_) => {
            tracing::error!("PIN check task failed");
            return Err(internal());
        }
    }
    {
        let mut store = lock(&inner.lockouts);
        store.admin_exit().clear();
        if let Err(error) = store.save((inner.now_ms)()) {
            tracing::error!("cannot save lockouts.json: {error}");
        }
    }

    // 8. Ask the reconciler to prepare the sign-out. The PIN was right, so a failure
    //    here is not counted.
    let (prepared_tx, prepared_rx) = oneshot::channel();
    let request = ExitRequest {
        session_id,
        prepared: prepared_tx,
        audit: Arc::clone(&inner.audit),
    };
    let prepared = tokio::time::timeout(PREPARE_TIMEOUT, async {
        inner
            .exit_tx
            .send(request)
            .await
            .map_err(|_| "the sign-out task is not running".to_string())?;
        match prepared_rx.await {
            Ok(result) => result,
            Err(_) => Err("the sign-out was dropped".to_string()),
        }
    })
    .await;
    let failure = match prepared {
        Ok(Ok(())) => None,
        Ok(Err(reason)) => Some(reason),
        Err(_) => Some("no answer within 3 seconds".to_string()),
    };
    if let Some(reason) = failure {
        tracing::error!("the correct exit PIN could not be acted on: {reason}");
        inner.audit.record(AuditKind::AdminExitFailed, None, Some("prepare_failed".to_string()));
        return Err(rpc_error(ErrorCode::Internal, "The sign-out could not be prepared.", true));
    }

    // 9. The employee session ends with the Staff session. Record, then answer.
    inner.session.clear("admin exit");
    inner.audit.record(AuditKind::AdminExitSuccess, None, None);
    tracing::info!(session_id, "admin exit: correct PIN, signing the Staff session out");
    Ok(outcome(AdminExitOutcome::SigningOut))
}

/// The counted failure stays: write the audit record(s) and pick the answer.
fn wrong_pin(inner: &Inner, after_count: Gate) -> AdminExitSubmitResult {
    inner.audit.record(AuditKind::AdminExitWrongPin, None, None);
    match after_count {
        Gate::Locked { retry_after_ms } => {
            // Once per lock, when it starts.
            inner.audit.record(AuditKind::AdminExitLockedOut, None, None);
            tracing::warn!(retry_after_ms, "admin exit locked after wrong PINs");
            locked_out(retry_after_ms)
        }
        Gate::Open { attempts_left } => {
            tracing::warn!(attempts_left, "admin exit: wrong PIN");
            AdminExitSubmitResult {
                outcome: AdminExitOutcome::WrongPin,
                attempts_left: Some(attempts_left.max(1)),
                retry_after_ms: None,
            }
        }
    }
}

fn undo_count(inner: &Inner) {
    let now_ms = (inner.now_ms)();
    let mut store = lock(&inner.lockouts);
    store.admin_exit().undo_failure();
    if let Err(error) = store.save(now_ms) {
        tracing::error!("cannot save lockouts.json: {error}");
    }
}

// -- the sign-out (Section 5.10, steps 8a to 10) --------------------------------------

/// Prepares and performs the sign-out for one correct PIN. The reconciler
/// (`kiosk::Reconciler::on_exit`) calls it from its own loop, so no kiosk change runs
/// at the same time, and owns the exit hold that keeps `AutoAdminLogon` at `"0"`
/// afterwards.
///
/// 1. When the kiosk is applied (and this is not simulate mode) automatic sign-in
///    is turned off, so Windows shows the sign-in screen. A failure is reported
///    back through `req.prepared` and returned.
/// 2. `prepared` is answered `Ok`; `agent.shuttingDown { adminExit, 2000 }` is
///    broadcast; two seconds pass, so the answer and the event reach the client.
/// 3. `logoff_session(session_id)`, retried after 1, 2 and 4 seconds. When every
///    attempt fails an error is logged and `adminExitFailed` is recorded.
///
/// Simulate mode writes nothing and calls nothing on `Platform`: it only logs.
pub async fn run_exit(
    platform: Arc<dyn Platform>,
    kiosk_enabled: bool,
    simulate: bool,
    req: ExitRequest,
    broadcast: ShellBroadcast,
) -> Result<(), PlatformError> {
    let ExitRequest { session_id, prepared, audit } = req;
    // `adminExit.submit` gave up (timeout) or the client went away: the caller was
    // told the exit failed, so the session is left alone.
    if prepared.is_closed() {
        tracing::warn!("the admin exit request is no longer wanted; not signing out");
        return Ok(());
    }

    let key = RegValueRef { path: WINLOGON_KEY.to_string(), name: AUTO_ADMIN_LOGON.to_string() };
    let turn_off_auto_logon = kiosk_enabled && !simulate;
    if turn_off_auto_logon {
        if let Err(error) = platform.write_machine_value(&key, Some(&RegData::String("0".to_string()))) {
            tracing::error!("cannot turn automatic sign-in off for the admin exit: {error}");
            let _ = prepared.send(Err(error.to_string()));
            return Err(error);
        }
    }
    if prepared.send(Ok(())).is_err() {
        // Lost the race with the caller giving up: undo what was written.
        if turn_off_auto_logon {
            let one = RegData::String("1".to_string());
            if let Err(error) = platform.write_machine_value(&key, Some(&one)) {
                tracing::error!("cannot turn automatic sign-in back on: {error}");
            }
        }
        return Ok(());
    }

    broadcast.shutting_down(ShutdownReason::AdminExit, EXIT_GRACE_MS);
    tokio::time::sleep(Duration::from_millis(EXIT_GRACE_MS)).await;

    if simulate {
        tracing::info!("simulate: would sign the Staff session out to the Windows sign-in screen");
        return Ok(());
    }
    let mut retry_delays = LOGOFF_RETRY_DELAYS.iter();
    loop {
        match platform.logoff_session(session_id) {
            Ok(()) => {
                tracing::info!(session_id, "the Staff session was signed out for the admin exit");
                return Ok(());
            }
            Err(error) => match retry_delays.next() {
                Some(delay) => {
                    tracing::warn!(session_id, "sign-out failed ({error}); trying again in {} s", delay.as_secs());
                    tokio::time::sleep(*delay).await;
                }
                None => {
                    tracing::error!(session_id, "the Staff session could not be signed out: {error}");
                    audit.record(AuditKind::AdminExitFailed, None, Some("logoff_failed".to_string()));
                    return Err(error);
                }
            },
        }
    }
}

// -- tests ------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::OnceLock;

    use rulebox_ipc::methods::SessionSignIn;
    use rulebox_ipc::types::{ClientRole, ConnectionStatus, EnrollmentStatus};
    use rulebox_ipc::Frame;
    use serde_json::json;

    use crate::audit::{AuditQueue, AuditRecord};
    use crate::directory::FixtureDirectory;
    use crate::employee_cache::EmployeeCache;
    use crate::platform::sim::{SimOp, SimPlatform};
    use crate::session::{SessionDeps, SessionTimeouts};
    use crate::testutil::{capture_logs, test_snapshot, TempDir};

    const START_MS: u64 = 1_700_000_000_000;
    const PIN: &str = "2468";
    const SESSION: u32 = 7;

    fn hash_of(pin: &str) -> String {
        kdf::hash_secret(pin).unwrap()
    }

    fn hash_2468() -> &'static str {
        static HASH: OnceLock<String> = OnceLock::new();
        HASH.get_or_init(|| hash_of(PIN))
    }

    fn policy_with(hash: &str) -> AgentPolicy {
        AgentPolicy::from_doc(Some(&json!({ "adminExit": { "pinHash": hash } })))
    }

    /// What answers the `ExitRequest`s of a harness.
    enum Exit {
        /// Prepares at once and remembers the session ids.
        Prepare,
        /// The test reads `Harness::exit_rx` itself (or never does).
        Manual,
    }

    struct Harness {
        dir: TempDir,
        exit: Arc<AdminExit>,
        session: Arc<SessionManager>,
        policy_tx: watch::Sender<AgentPolicy>,
        lockouts: Arc<Mutex<LockoutStore>>,
        audit: Arc<AuditHandle>,
        clock: Arc<AtomicU64>,
        requested: Arc<Mutex<Vec<u32>>>,
        exit_rx: Option<mpsc::Receiver<ExitRequest>>,
    }

    /// The pieces that are rebuilt on an "agent restart" (test 6).
    struct Parts {
        exit: Arc<AdminExit>,
        session: Arc<SessionManager>,
        lockouts: Arc<Mutex<LockoutStore>>,
        audit: Arc<AuditHandle>,
    }

    fn build(
        state: &std::path::Path,
        policy_rx: watch::Receiver<AgentPolicy>,
        clock: &Arc<AtomicU64>,
        exit_tx: mpsc::Sender<ExitRequest>,
    ) -> Parts {
        std::fs::create_dir_all(state).unwrap();
        let mut snapshot = test_snapshot();
        snapshot.enrollment = EnrollmentStatus::Enrolled;
        snapshot.connection = ConnectionStatus::Online;
        let (_snapshot_tx, snapshot_rx) = watch::channel(snapshot);
        let now: Arc<dyn Fn() -> u64 + Send + Sync> = {
            let clock = Arc::clone(clock);
            Arc::new(move || clock.load(Ordering::SeqCst))
        };
        let lockouts = Arc::new(Mutex::new(LockoutStore::open(state.join("lockouts.json")).unwrap()));
        let audit = AuditHandle::new(
            AuditQueue::open(state.join("audit-queue.json")).unwrap(),
            snapshot_rx.clone(),
            Arc::clone(&now),
        );
        let session = SessionManager::new(SessionDeps {
            directory: Arc::new(FixtureDirectory::new(false)),
            cache: EmployeeCache::open(state.join("employee-cache.json")).unwrap(),
            lockouts: Arc::clone(&lockouts),
            audit: Arc::clone(&audit),
            snapshot_rx,
            files_base: Some(state.join("files")),
            now_ms: Arc::clone(&now),
            clock_floor_ms: Arc::new(|| 0),
            timeouts: SessionTimeouts::default(),
        });
        let exit = AdminExit::new(AdminExitDeps {
            policy_rx,
            lockouts: Arc::clone(&lockouts),
            audit: Arc::clone(&audit),
            session: Arc::clone(&session),
            exit_tx,
            now_ms: now,
        });
        Parts { exit, session, lockouts, audit }
    }

    fn harness(hash: Option<&str>, responder: Exit) -> Harness {
        let dir = TempDir::new();
        let policy = hash.map_or_else(AgentPolicy::default, policy_with);
        let (policy_tx, policy_rx) = watch::channel(policy);
        let clock = Arc::new(AtomicU64::new(START_MS));
        let (exit_tx, mut exit_rx) = mpsc::channel::<ExitRequest>(4);
        let parts = build(&dir.path().join("state"), policy_rx, &clock, exit_tx);
        let requested = Arc::new(Mutex::new(Vec::new()));
        let exit_rx = match responder {
            Exit::Prepare => {
                let seen = Arc::clone(&requested);
                tokio::spawn(async move {
                    while let Some(request) = exit_rx.recv().await {
                        lock(&seen).push(request.session_id);
                        let _ = request.prepared.send(Ok(()));
                    }
                });
                None
            }
            Exit::Manual => Some(exit_rx),
        };
        Harness {
            dir,
            exit: parts.exit,
            session: parts.session,
            policy_tx,
            lockouts: parts.lockouts,
            audit: parts.audit,
            clock,
            requested,
            exit_rx,
        }
    }

    fn peer() -> PeerCtx {
        PeerCtx { connection_id: 1, pid: 1, session_id: SESSION, role: ClientRole::Shell }
    }

    impl Harness {
        async fn submit(&self, pin: &str) -> Result<AdminExitSubmitResult, RpcError> {
            let future = self
                .exit
                .handle(&peer(), AdminExitSubmit::NAME, json!({ "pin": pin }))
                .expect("adminExit.submit is handled");
            future.await.map(|value| serde_json::from_value(value).unwrap())
        }

        fn advance(&self, ms: u64) {
            self.clock.fetch_add(ms, Ordering::SeqCst);
        }

        fn failures(&self) -> u32 {
            lock(&self.lockouts).admin_exit().failures
        }

        fn kinds(&self) -> Vec<AuditKind> {
            self.audit.records().iter().map(|record| record.kind).collect()
        }

        fn lockouts_on_disk(&self) -> serde_json::Value {
            let text = std::fs::read_to_string(self.dir.path().join("state").join("lockouts.json")).unwrap();
            serde_json::from_str(&text).unwrap()
        }

        fn requests(&self) -> Vec<u32> {
            lock(&self.requested).clone()
        }
    }

    fn error_code(result: &Result<AdminExitSubmitResult, RpcError>) -> ErrorCode {
        match result {
            Err(error) => error.code,
            Ok(value) => panic!("expected an error, got {value:?}"),
        }
    }

    // -- the PIN gate (tests 3 to 12) -----------------------------------------------

    #[test]
    fn the_extension_lists_its_capability() {
        let h = {
            let dir = TempDir::new();
            let (_tx, rx) = watch::channel(AgentPolicy::default());
            let (exit_tx, _exit_rx) = mpsc::channel(1);
            let clock = Arc::new(AtomicU64::new(START_MS));
            let parts = build(&dir.path().join("state"), rx, &clock, exit_tx);
            (dir, parts)
        };
        assert_eq!(h.1.exit.capabilities(), ["adminExit"]);
        assert!(h.1.exit.handle(&peer(), "session.get", json!({})).is_none());
    }

    #[tokio::test]
    async fn a_correct_pin_signs_out_the_callers_session_and_clears_everything() {
        let h = harness(Some(hash_2468()), Exit::Prepare);
        // An employee is signed in; the exit ends that session too.
        let signed_in = h
            .session
            .handle(&peer(), SessionSignIn::NAME, json!({ "username": "maya", "password": "demo" }))
            .unwrap()
            .await
            .unwrap();
        assert_eq!(signed_in["outcome"], "ok");
        assert_eq!(h.session.current_username().as_deref(), Some("maya"));
        // One wrong PIN first, so there is a counter to clear.
        assert_eq!(h.submit("1111").await.unwrap().outcome, AdminExitOutcome::WrongPin);
        assert_eq!(h.failures(), 1);

        let result = h.submit(PIN).await.unwrap();
        assert_eq!(
            result,
            AdminExitSubmitResult { outcome: AdminExitOutcome::SigningOut, attempts_left: None, retry_after_ms: None }
        );
        assert_eq!(h.requests(), [SESSION]);
        assert_eq!(h.session.current_username(), None);
        assert_eq!(h.failures(), 0);
        assert_eq!(h.lockouts_on_disk()["adminExit"]["failures"], 0);
        assert_eq!(h.kinds(), [AuditKind::AdminExitWrongPin, AuditKind::AdminExitSuccess]);
    }

    #[tokio::test]
    async fn wrong_pins_count_down_then_lock_and_the_lock_ends() {
        let logs = capture_logs();
        // Digits that no other test writes, so the log search below means something.
        let correct = "47291836405";
        let wrong = "58302716493";
        let h = harness(Some(&hash_of(correct)), Exit::Prepare);

        for expected in [4, 3, 2, 1] {
            let result = h.submit(wrong).await.unwrap();
            assert_eq!(result.outcome, AdminExitOutcome::WrongPin);
            assert_eq!(result.attempts_left, Some(expected));
            assert_eq!(result.retry_after_ms, None);
        }
        let fifth = h.submit(wrong).await.unwrap();
        assert_eq!(fifth.outcome, AdminExitOutcome::LockedOut);
        assert_eq!((fifth.attempts_left, fifth.retry_after_ms), (None, Some(60_000)));

        // During the lock even the right PIN is not checked, no request is made and
        // no further record is written.
        h.advance(10_000);
        let during = h.submit(correct).await.unwrap();
        assert_eq!((during.outcome, during.retry_after_ms), (AdminExitOutcome::LockedOut, Some(50_000)));
        assert!(h.requests().is_empty());
        assert_eq!(h.failures(), 5);

        // After the lock one PIN is checked, and the right one signs out.
        h.advance(50_001);
        let after = h.submit(correct).await.unwrap();
        assert_eq!(after.outcome, AdminExitOutcome::SigningOut);
        assert_eq!(h.requests(), [SESSION]);
        assert_eq!(h.failures(), 0);

        // Test 5: the queue, in order, and no PIN anywhere.
        let mut expected = vec![AuditKind::AdminExitWrongPin; 5];
        expected.push(AuditKind::AdminExitLockedOut);
        expected.push(AuditKind::AdminExitSuccess);
        assert_eq!(h.kinds(), expected);
        let records: Vec<AuditRecord> = h.audit.records();
        assert!(records.iter().all(|r| r.username.is_none() && r.detail.is_none()));
        let queue_file = std::fs::read_to_string(h.dir.path().join("state").join("audit-queue.json")).unwrap();
        let lockouts_file = std::fs::read_to_string(h.dir.path().join("state").join("lockouts.json")).unwrap();
        let log_text = logs.text();
        for pin in [correct, wrong] {
            for (what, text) in [("audit", &queue_file), ("lockouts", &lockouts_file), ("log", &log_text)] {
                assert!(!text.contains(pin), "the PIN {pin} is in the {what} text");
            }
        }
    }

    #[tokio::test]
    async fn a_lock_that_ended_gives_one_check_then_a_longer_lock() {
        let h = harness(Some(hash_2468()), Exit::Prepare);
        for _ in 0..5 {
            h.submit("1111").await.unwrap();
        }
        h.advance(60_001);
        // One PIN is checked; wrong again: 5 minutes.
        let sixth = h.submit("1111").await.unwrap();
        assert_eq!((sixth.outcome, sixth.retry_after_ms), (AdminExitOutcome::LockedOut, Some(300_000)));
        assert_eq!(h.failures(), 6);
        // Two lock records: one per lock that started.
        let locks = h.kinds().iter().filter(|k| **k == AuditKind::AdminExitLockedOut).count();
        assert_eq!(locks, 2);
    }

    #[tokio::test]
    async fn the_counter_and_the_lock_survive_an_agent_restart() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        let clock = Arc::new(AtomicU64::new(START_MS));
        let (_policy_tx, policy_rx) = watch::channel(policy_with(hash_2468()));
        {
            let (exit_tx, _keep) = mpsc::channel(1);
            let first = build(&state, policy_rx.clone(), &clock, exit_tx);
            let submit = |pin: &'static str| {
                first
                    .exit
                    .handle(&peer(), AdminExitSubmit::NAME, json!({ "pin": pin }))
                    .unwrap()
            };
            for _ in 0..3 {
                submit("1111").await.unwrap();
            }
        }
        // A new process: new store, new AdminExit.
        let (exit_tx, _keep) = mpsc::channel(1);
        let second = build(&state, policy_rx.clone(), &clock, exit_tx);
        let submit = |pin: &'static str| {
            second.exit.handle(&peer(), AdminExitSubmit::NAME, json!({ "pin": pin })).unwrap()
        };
        let value = submit("1111").await.unwrap();
        assert_eq!(value["outcome"], "wrongPin");
        assert_eq!(value["attemptsLeft"], 1, "the fourth failure overall");
        let value = submit("1111").await.unwrap();
        assert_eq!((value["outcome"].as_str(), value["retryAfterMs"].as_u64()), (Some("lockedOut"), Some(60_000)));

        // And the lock itself survives another restart.
        drop(second);
        let (exit_tx, _keep) = mpsc::channel(1);
        let third = build(&state, policy_rx, &clock, exit_tx);
        let value = third
            .exit
            .handle(&peer(), AdminExitSubmit::NAME, json!({ "pin": PIN }))
            .unwrap()
            .await
            .unwrap();
        assert_eq!(value["outcome"], "lockedOut");
        let status = third.exit.status();
        assert_eq!((status.failures, status.locked_for_ms), (5, Some(60_000)));
    }

    #[tokio::test]
    async fn rotating_the_pin_clears_the_counter() {
        let h = harness(Some(hash_2468()), Exit::Prepare);
        for _ in 0..3 {
            h.submit("1111").await.unwrap();
        }
        assert_eq!(h.failures(), 3);
        // The status of the old counter is shown as empty once the PIN changed.
        h.policy_tx.send(policy_with(&hash_of("1357"))).unwrap();
        assert_eq!(h.exit.status().failures, 0);
        let result = h.submit("1111").await.unwrap();
        assert_eq!((result.outcome, result.attempts_left), (AdminExitOutcome::WrongPin, Some(4)));
        // The same PIN with a fresh salt is a different hash and so a rotation too.
        h.policy_tx.send(policy_with(&hash_of("1357"))).unwrap();
        let result = h.submit("1111").await.unwrap();
        assert_eq!(result.attempts_left, Some(4));
        // The new PIN works.
        assert_eq!(h.submit("1357").await.unwrap().outcome, AdminExitOutcome::SigningOut);
    }

    #[tokio::test]
    async fn disabled_answers_disabled_and_changes_nothing() {
        let disabled_documents = [
            AgentPolicy::default(),
            AgentPolicy::from_doc(Some(&json!({ "adminExit": { "enabled": false, "pinHash": hash_2468() } }))),
            AgentPolicy::from_doc(Some(&json!({ "adminExit": { "pinHash": "broken" } }))),
        ];
        for policy in disabled_documents {
            let h = harness(None, Exit::Prepare);
            h.policy_tx.send(policy).unwrap();
            for _ in 0..3 {
                let result = h.submit(PIN).await.unwrap();
                assert_eq!(
                    result,
                    AdminExitSubmitResult { outcome: AdminExitOutcome::Disabled, attempts_left: None, retry_after_ms: None }
                );
            }
            assert_eq!(h.failures(), 0);
            assert!(h.kinds().is_empty());
            assert!(h.requests().is_empty());
            assert!(!h.dir.path().join("state").join("lockouts.json").exists(), "nothing was written");
        }
    }

    #[tokio::test]
    async fn pins_that_are_not_four_to_twelve_digits_are_invalid_params_and_not_counted() {
        let h = harness(Some(hash_2468()), Exit::Prepare);
        for bad in ["12", "12a4", "1234567890123", "", " 2468", "２４６８", "-2468"] {
            let result = h.submit(bad).await;
            assert_eq!(error_code(&result), ErrorCode::InvalidParams, "{bad:?}");
            assert!(!result.unwrap_err().retryable);
        }
        // Wrong shape of the params object.
        let future = h.exit.handle(&peer(), AdminExitSubmit::NAME, json!({ "pin": 2468 })).unwrap();
        assert_eq!(future.await.unwrap_err().code, ErrorCode::InvalidParams);
        assert_eq!(h.failures(), 0);
        assert!(h.kinds().is_empty());
        // The limits themselves are valid: 4 and 12 digits.
        for edge in ["0000", "123456789012"] {
            assert_eq!(h.submit(edge).await.unwrap().outcome, AdminExitOutcome::WrongPin);
        }
    }

    #[tokio::test]
    async fn two_submits_at_once_give_one_busy() {
        let h = harness(Some(hash_2468()), Exit::Prepare);
        let (first, second) = tokio::join!(h.submit("1111"), h.submit("2222"));
        let (ok, busy) = match (first, second) {
            (Ok(ok), Err(busy)) | (Err(busy), Ok(ok)) => (ok, busy),
            other => panic!("expected one answer and one busy, got {other:?}"),
        };
        assert_eq!(ok.outcome, AdminExitOutcome::WrongPin);
        assert_eq!(busy.code, ErrorCode::Busy);
        assert!(busy.retryable);
        // The busy request was not counted.
        assert_eq!(h.failures(), 1);
    }

    #[tokio::test]
    async fn the_failure_is_on_disk_before_the_pin_is_checked() {
        let h = harness(Some(hash_2468()), Exit::Prepare);
        // Poll the request once: it counts and saves, then waits for the Argon2id
        // check. Dropping it there (the client went away, or the check panicked)
        // must leave the count in place.
        let future = h.exit.handle(&peer(), AdminExitSubmit::NAME, json!({ "pin": PIN })).unwrap();
        assert!(future.now_or_never().is_none(), "the check cannot finish within one poll");
        assert_eq!(h.lockouts_on_disk()["adminExit"]["failures"], 1);
        assert_eq!(h.failures(), 1);
        // The gate was released with the dropped future.
        assert_eq!(h.submit(PIN).await.unwrap().outcome, AdminExitOutcome::SigningOut);
        assert_eq!(h.failures(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_reconciler_that_never_answers_is_an_internal_error_and_not_counted() {
        let mut h = harness(Some(hash_2468()), Exit::Manual);
        // Wrong PIN first: the right one clears this even though the exit failed.
        h.submit("1111").await.unwrap();
        let result = h.submit(PIN).await;
        assert_eq!(error_code(&result), ErrorCode::Internal);
        assert!(result.unwrap_err().retryable);
        assert_eq!(h.failures(), 0, "the PIN was right");
        assert_eq!(h.kinds(), [AuditKind::AdminExitWrongPin, AuditKind::AdminExitFailed]);
        // The request did reach the reconciler, with the caller's session.
        let request = h.exit_rx.as_mut().unwrap().try_recv().unwrap();
        assert_eq!(request.session_id, SESSION);
    }

    #[tokio::test]
    async fn a_reconciler_that_refuses_is_an_internal_error_with_one_failed_record() {
        let mut h = harness(Some(hash_2468()), Exit::Manual);
        let mut rx = h.exit_rx.take().unwrap();
        tokio::spawn(async move {
            while let Some(request) = rx.recv().await {
                let _ = request.prepared.send(Err("registry write refused".to_string()));
            }
        });
        h.session
            .handle(&peer(), SessionSignIn::NAME, json!({ "username": "maya", "password": "demo" }))
            .unwrap()
            .await
            .unwrap();
        let result = h.submit(PIN).await;
        assert_eq!(error_code(&result), ErrorCode::Internal);
        assert_eq!(h.kinds(), [AuditKind::AdminExitFailed]);
        assert_eq!(h.audit.records()[0].detail.as_deref(), Some("prepare_failed"));
        assert_eq!(h.failures(), 0, "the PIN was right");
        // Nothing happened to the employee: the exit did not.
        assert_eq!(h.session.current_username().as_deref(), Some("maya"));
    }

    #[tokio::test]
    async fn status_and_debug_show_counters_only() {
        let h = harness(Some(hash_2468()), Exit::Prepare);
        for _ in 0..2 {
            h.submit("1111").await.unwrap();
        }
        let status = h.exit.status();
        assert_eq!(status, ExitStatus { failures: 2, locked_for_ms: None, problem: None });
        for _ in 0..3 {
            h.submit("1111").await.unwrap();
        }
        h.advance(15_000);
        let status = h.exit.status();
        assert_eq!((status.failures, status.locked_for_ms), (5, Some(45_000)));

        let extra = rulebox_ipc::admin::AdminStatusExtra {
            admin_exit_failures: status.failures,
            admin_exit_locked_for_ms: status.locked_for_ms,
            admin_exit_problem: status.problem.clone(),
            ..Default::default()
        };
        let text = format!("{}{status:?}{extra:?}", serde_json::to_string(&extra).unwrap());
        assert!(!text.contains("$argon2") && !text.contains("pinHash") && !text.contains(hash_2468()));
    }

    // -- the sign-out (tests 13 and 14) -----------------------------------------------

    struct ExitRig {
        sim: Arc<SimPlatform>,
        _dir: TempDir,
        audit: Arc<AuditHandle>,
        broadcast: ShellBroadcast,
        events: tokio::sync::broadcast::Receiver<Frame>,
        prepared: Option<oneshot::Receiver<Result<(), String>>>,
        request: Option<ExitRequest>,
    }

    fn exit_rig() -> ExitRig {
        let dir = TempDir::new();
        let sim = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        sim.add_session(SESSION, Some("S-1-5-21-1000-2000-3000-2001"), true);
        let (_tx, snapshot_rx) = watch::channel(test_snapshot());
        let audit = AuditHandle::new(
            AuditQueue::open(dir.path().join("audit-queue.json")).unwrap(),
            snapshot_rx,
            Arc::new(|| START_MS),
        );
        let (prepared_tx, prepared_rx) = oneshot::channel();
        let broadcast = ShellBroadcast::new();
        let events = broadcast.subscribe();
        ExitRig {
            sim,
            _dir: dir,
            audit: Arc::clone(&audit),
            broadcast,
            events,
            prepared: Some(prepared_rx),
            request: Some(ExitRequest { session_id: SESSION, prepared: prepared_tx, audit }),
        }
    }

    fn auto_logon(sim: &SimPlatform) -> Option<RegData> {
        sim.read_machine_value(&RegValueRef {
            path: WINLOGON_KEY.to_string(),
            name: AUTO_ADMIN_LOGON.to_string(),
        })
        .unwrap()
    }

    fn logoff_calls(sim: &SimPlatform) -> usize {
        sim.calls().iter().filter(|op| **op == SimOp::LogoffSession).count()
    }

    #[tokio::test(start_paused = true)]
    async fn run_exit_turns_auto_logon_off_before_the_sign_out_and_broadcasts() {
        let mut rig = exit_rig();
        let sim_dyn: Arc<dyn Platform> = rig.sim.clone();
        let request = rig.request.take().unwrap();
        run_exit(sim_dyn, true, false, request, rig.broadcast.clone()).await.unwrap();

        assert_eq!(rig.prepared.take().unwrap().await.unwrap(), Ok(()));
        assert_eq!(auto_logon(&rig.sim), Some(RegData::String("0".into())));
        // The registry write came first, then the sign-out of exactly that session.
        let calls: Vec<SimOp> = rig
            .sim
            .calls()
            .into_iter()
            .filter(|op| matches!(op, SimOp::WriteMachineValue | SimOp::LogoffSession))
            .collect();
        assert_eq!(calls, [SimOp::WriteMachineValue, SimOp::LogoffSession]);
        assert!(rig.sim.sessions().unwrap().iter().all(|s| s.id != SESSION), "the session was signed out");

        match rig.events.try_recv().unwrap() {
            Frame::Event { event, data } => {
                assert_eq!(event, rulebox_ipc::methods::events::AGENT_SHUTTING_DOWN);
                assert_eq!(data, json!({ "reason": "adminExit", "graceMs": 2000 }));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(rig.audit.records().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn run_exit_retries_the_sign_out_three_times() {
        let mut rig = exit_rig();
        for _ in 0..3 {
            rig.sim.fail_next(SimOp::LogoffSession, PlatformError::Other("busy".into()));
        }
        let sim_dyn: Arc<dyn Platform> = rig.sim.clone();
        let started = tokio::time::Instant::now();
        run_exit(sim_dyn, true, false, rig.request.take().unwrap(), rig.broadcast.clone())
            .await
            .unwrap();
        assert_eq!(logoff_calls(&rig.sim), 4, "three failures, then success on the fourth call");
        // 2 s grace, then 1 + 2 + 4 s of waiting between the four calls.
        assert_eq!(started.elapsed(), Duration::from_secs(2 + 1 + 2 + 4));
        assert!(rig.audit.records().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn run_exit_gives_up_after_four_failures_and_records_it() {
        let mut rig = exit_rig();
        for _ in 0..4 {
            rig.sim.fail_next(SimOp::LogoffSession, PlatformError::Other("nope".into()));
        }
        let sim_dyn: Arc<dyn Platform> = rig.sim.clone();
        let result =
            run_exit(sim_dyn, true, false, rig.request.take().unwrap(), rig.broadcast.clone()).await;
        assert!(matches!(result, Err(PlatformError::Other(_))));
        assert_eq!(logoff_calls(&rig.sim), 4);
        assert_eq!(rig.audit.records().len(), 1);
        assert_eq!(rig.audit.records()[0].kind, AuditKind::AdminExitFailed);
        assert_eq!(rig.audit.records()[0].detail.as_deref(), Some("logoff_failed"));
        // The session is still there: nothing signed it out.
        assert!(rig.sim.sessions().unwrap().iter().any(|s| s.id == SESSION));
    }

    #[tokio::test(start_paused = true)]
    async fn run_exit_without_the_kiosk_leaves_auto_logon_alone() {
        let mut rig = exit_rig();
        let sim_dyn: Arc<dyn Platform> = rig.sim.clone();
        run_exit(sim_dyn, false, false, rig.request.take().unwrap(), rig.broadcast.clone())
            .await
            .unwrap();
        assert_eq!(auto_logon(&rig.sim), None);
        assert!(!rig.sim.calls().contains(&SimOp::WriteMachineValue));
        assert_eq!(logoff_calls(&rig.sim), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn run_exit_in_simulate_mode_calls_nothing_on_the_platform() {
        let logs = capture_logs();
        let mut rig = exit_rig();
        let sim_dyn: Arc<dyn Platform> = rig.sim.clone();
        run_exit(sim_dyn, true, true, rig.request.take().unwrap(), rig.broadcast.clone())
            .await
            .unwrap();
        assert_eq!(rig.prepared.take().unwrap().await.unwrap(), Ok(()));
        assert!(rig.sim.calls().is_empty(), "{:?}", rig.sim.calls());
        assert!(matches!(rig.events.try_recv().unwrap(), Frame::Event { .. }));
        assert!(logs.text().contains("simulate: would sign the Staff session out to the Windows sign-in screen"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_registry_failure_is_reported_back_and_nothing_is_signed_out() {
        let mut rig = exit_rig();
        rig.sim.fail_next(SimOp::WriteMachineValue, PlatformError::AccessDenied);
        let sim_dyn: Arc<dyn Platform> = rig.sim.clone();
        let result =
            run_exit(sim_dyn, true, false, rig.request.take().unwrap(), rig.broadcast.clone()).await;
        assert!(matches!(result, Err(PlatformError::AccessDenied)));
        assert!(rig.prepared.take().unwrap().await.unwrap().is_err());
        assert_eq!(logoff_calls(&rig.sim), 0);
        assert!(rig.events.try_recv().is_err(), "no event for an exit that did not happen");
        // The caller records the failure (the submit side), not run_exit.
        assert!(rig.audit.records().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_request_nobody_waits_for_any_more_signs_nothing_out() {
        let mut rig = exit_rig();
        drop(rig.prepared.take());
        let sim_dyn: Arc<dyn Platform> = rig.sim.clone();
        run_exit(sim_dyn, true, false, rig.request.take().unwrap(), rig.broadcast.clone())
            .await
            .unwrap();
        assert!(rig.sim.calls().is_empty());
        assert!(rig.events.try_recv().is_err());
    }

    // -- hash-pin (test 15) -------------------------------------------------------------

    #[test]
    fn hash_pin_line_creates_hashes_for_six_to_twelve_digits_only() {
        let hash = hash_pin_line("246810\r\n").unwrap();
        assert!(hash.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"), "{hash}");
        assert!(kdf::check_hash(&hash).is_ok());
        assert!(kdf::verify_secret("246810", &hash).unwrap());
        assert!(!kdf::verify_secret("246811", &hash).unwrap());
        assert_eq!(hash_pin_line("123456789012\n").map(|_| ()), Ok(()));
        // Under six digits is refused for a new hash, although such a PIN typed at
        // the exit is still a valid shape (an earlier hash keeps working).
        for bad in ["12", "2468", "12345", "12a456", "1234567890123", "", "\n", " 246810", "246 810"] {
            assert_eq!(hash_pin_line(bad), Err(HashPinError::NotAPin), "{bad:?}");
        }
        assert!(valid_pin("2468"));
    }

    #[test]
    fn pin_ids_are_sixteen_hex_characters_and_name_the_hash() {
        let a = pin_id("one");
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(a, pin_id("one"));
        assert_ne!(a, pin_id("two"));
        // SHA-256("") starts with e3b0c44298fc1c14.
        assert_eq!(pin_id(""), "e3b0c44298fc1c14");
    }
}
