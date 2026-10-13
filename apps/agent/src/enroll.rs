//! Enrollment and unenrollment (plan Section 5.4, Step 8; the unenroll flow is the
//! one described under Step 11): the real [`AdminHandler`] behind `admin.enroll` and
//! `admin.unenroll`.
//!
//! The kiosk reconciler does not exist yet (Step 9), so everything that would
//! change the kiosk goes through [`KioskControl`]. Everything that touches the
//! machine's accounts goes through the `Platform` seam.
//!
//! Secrets and codes: the device secret, the enrollment token and the enrollment code
//! are never logged and never put in an error.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use rulebox_ipc::admin::{
    reasons, AdminEnrollParams, AdminEnrollResult, AdminUnenrollParams,
};
use rulebox_ipc::types::{AgentSnapshot, ConnectionStatus, DeviceInfo, EnrollmentStatus};
use rulebox_ipc::{ErrorCode, RpcError};

use crate::agent_policy::AgentPolicy;
use crate::audit::AuditHandle;
use crate::backend::task::{note_server_time, publish_policy, BackendRunner, TaskContext};
use crate::backend::{sha256_hex, Backend, BackendError, DeviceAuth, EnrollRequest};
use crate::compat;
use crate::enroll_code::{self, EnrollmentCode};
use crate::ipc_admin::{operation_failed, AdminHandler};
use crate::ipc_conn::rpc_error;
use crate::lockout::LockoutStore;
use crate::platform::{Platform, RegData, RegValueRef};
use crate::state::{lock, remove_file_if_exists, Enrollment, KioskRecord, PendingEnrollment, StaffAccount};

/// `operation_failed` reasons that are not in `rulebox_ipc::admin::reasons`.
pub mod extra_reasons {
    /// `unenroll`: the kiosk could not be switched off, so nothing was changed.
    pub const KIOSK_DISABLE_FAILED: &str = "kiosk_disable_failed";
    /// `unenroll --remove-staff-account`: the Staff session did not end in time.
    pub const STAFF_SESSION_OPEN: &str = "staff_session_still_open";
    /// `unenroll --remove-staff-account`: the account could not be deleted.
    pub const STAFF_ACCOUNT_REMOVE_FAILED: &str = "staff_account_remove_failed";
}

/// The waits the plan fixes; tests shorten none of them (they use paused time).
#[derive(Debug, Clone, Copy)]
pub struct Timings {
    /// Section 5.4 step 7: how long enrollment waits for the first reconcile.
    pub reconcile_wait: Duration,
    /// Step 11, `unenroll`: the `devices:unenroll` call.
    pub unenroll_call: Duration,
    /// Step 11, `unenroll --remove-staff-account`: the Staff session ending.
    pub staff_session_wait: Duration,
    pub staff_session_poll: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Self {
            reconcile_wait: Duration::from_secs(120),
            unenroll_call: Duration::from_secs(10),
            staff_session_wait: Duration::from_secs(30),
            staff_session_poll: Duration::from_secs(1),
        }
    }
}

pub struct EnrollDeps {
    pub ctx: Arc<TaskContext>,
    pub runner: Arc<BackendRunner>,
    pub audit: Arc<AuditHandle>,
    pub lockouts: Arc<Mutex<LockoutStore>>,
    pub timings: Timings,
}

pub struct Enroller {
    inner: Arc<EnrollDeps>,
}

impl Enroller {
    pub fn new(deps: EnrollDeps) -> Self {
        Self { inner: Arc::new(deps) }
    }
}

impl AdminHandler for Enroller {
    fn enroll(&self, params: AdminEnrollParams) -> BoxFuture<'static, Result<AdminEnrollResult, RpcError>> {
        let inner = Arc::clone(&self.inner);
        async move { inner.enroll(params).await }.boxed()
    }

    fn unenroll(&self, params: AdminUnenrollParams) -> BoxFuture<'static, Result<(), RpcError>> {
        let inner = Arc::clone(&self.inner);
        async move { inner.unenroll(params).await }.boxed()
    }
}

// -- errors -----------------------------------------------------------------------

fn internal(message: &str) -> RpcError {
    rpc_error(ErrorCode::Internal, message, true)
}

fn is_token_code(code: &str) -> bool {
    matches!(
        code,
        reasons::TOKEN_INVALID | reasons::TOKEN_EXPIRED | reasons::TOKEN_USED_UP | reasons::TOKEN_REVOKED
    )
}

/// Section 5.4 and Step 8, "Admin-pipe errors": maps what the backend said to the
/// reason the administrator sees.
pub fn backend_failure(error: &BackendError) -> RpcError {
    match error {
        BackendError::Unreachable | BackendError::Timeout => operation_failed(
            reasons::BACKEND_UNREACHABLE,
            "The backend did not answer. Check the network connection and try again.",
            true,
            None,
        ),
        BackendError::Rejected { code } if is_token_code(code) => {
            let message = match code.as_str() {
                reasons::TOKEN_EXPIRED => "The enrollment code has expired. Create a new one.",
                reasons::TOKEN_USED_UP => "The enrollment code has already been used.",
                reasons::TOKEN_REVOKED => "The enrollment code was revoked.",
                _ => "The enrollment code is not recognized by the backend.",
            };
            operation_failed(code, message, false, None)
        }
        BackendError::Rejected { code } => operation_failed(
            reasons::BACKEND_REJECTED,
            "The backend refused the request.",
            false,
            Some(serde_json::json!({ "serverCode": code })),
        ),
        BackendError::Protocol(_) => operation_failed(
            reasons::BACKEND_REJECTED,
            "The backend sent an answer this agent does not understand.",
            false,
            Some(serde_json::json!({ "serverCode": "protocol_error" })),
        ),
    }
}

// -- helpers ----------------------------------------------------------------------

/// 32 random bytes as 64 lowercase hex characters.
fn new_device_secret() -> Result<String, RpcError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| internal("The operating system gave no random numbers."))?;
    let mut secret = String::with_capacity(64);
    for byte in bytes {
        secret.push_str(&format!("{byte:02x}"));
    }
    Ok(secret)
}

/// SHA-256 of `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`: a hint for the
/// administrator (cloned images share it), never used for authentication.
fn hardware_id_hash(platform: &dyn Platform) -> Option<String> {
    let key = RegValueRef {
        path: r"SOFTWARE\Microsoft\Cryptography".to_string(),
        name: "MachineGuid".to_string(),
    };
    match platform.read_machine_value(&key) {
        Ok(Some(RegData::String(guid))) if !guid.trim().is_empty() => Some(sha256_hex(guid.trim())),
        _ => None,
    }
}

fn not_enrolled_snapshot(snapshot: &mut AgentSnapshot) {
    snapshot.enrollment = EnrollmentStatus::NotEnrolled;
    snapshot.device = None;
    snapshot.convex_url = None;
    snapshot.connection = ConnectionStatus::Offline;
    snapshot.desired_state = None;
    snapshot.desired_state_version = 0;
    snapshot.server_time_offset_ms = None;
    AgentPolicy::default().apply_to_snapshot(snapshot);
}

impl EnrollDeps {
    // -- enroll -------------------------------------------------------------------

    async fn enroll(&self, params: AdminEnrollParams) -> Result<AdminEnrollResult, RpcError> {
        let ctx = &self.ctx;
        let state = ctx.shared.get();

        // 1. Already enrolled (a revoked enrollment may be replaced).
        let enrolled_in_snapshot = ctx.snapshot.current().enrollment == EnrollmentStatus::Enrolled;
        if state.enrollment.as_ref().is_some_and(|e| !e.revoked) || enrolled_in_snapshot {
            return Err(operation_failed(
                reasons::ALREADY_ENROLLED,
                "This PC is already enrolled. Run `rulebox-agent unenroll` first.",
                false,
                None,
            ));
        }

        // 2. The code.
        let code: EnrollmentCode = enroll_code::parse(&params.code).map_err(|error| {
            operation_failed(
                reasons::CODE_INVALID,
                "The enrollment code is not valid. Copy the whole code from the dashboard.",
                false,
                Some(serde_json::json!({ "kind": error.kind() })),
            )
        })?;

        // 3. Compatibility. Nothing has been changed yet.
        let staff_sid = state.staff.as_ref().map(|staff| staff.sid.as_str());
        let report = compat::build(ctx.platform.as_ref(), staff_sid, params.allow_joined).map_err(|error| {
            tracing::error!("cannot check this PC's compatibility: {error}");
            internal("Cannot read this PC's configuration.")
        })?;
        if !report.blockers.is_empty() {
            return Err(operation_failed(
                reasons::COMPAT_BLOCKED,
                "This PC cannot be enrolled.",
                false,
                Some(serde_json::json!({ "blockers": report.blocker_codes() })),
            ));
        }

        // 4. The device secret: reused when this is a retry of the same code, so a
        //    lost answer is idempotent. Secrets are saved first, then the pending
        //    enrollment.
        let token_sha256 = sha256_hex(&code.token);
        let same_code = state
            .pending_enrollment
            .as_ref()
            .is_some_and(|p| p.convex_url == code.convex_url && p.token_sha256 == token_sha256);
        let kept_secret = if same_code {
            ctx.shared
                .secrets(|secrets| secrets.pending_device_secret.clone())
                .map_err(|error| {
                    tracing::error!("cannot read the saved secrets: {error}");
                    internal("Cannot read the agent's saved secrets.")
                })?
        } else {
            None
        };
        let secret = match kept_secret {
            Some(secret) => secret,
            None => new_device_secret()?,
        };
        ctx.shared
            .update_secrets(|secrets| secrets.pending_device_secret = Some(secret.clone()))
            .map_err(|error| {
                tracing::error!("cannot save the pending device secret: {error}");
                internal("Cannot save the agent's secrets.")
            })?;
        let started_at_ms = match (&state.pending_enrollment, same_code) {
            (Some(pending), true) => pending.started_at_ms,
            _ => (ctx.now_ms)(),
        };
        let pending = PendingEnrollment {
            convex_url: code.convex_url.clone(),
            token_sha256,
            started_at_ms,
        };
        ctx.shared
            .update(|state| state.pending_enrollment = Some(pending.clone()))
            .map_err(|error| {
                tracing::error!("cannot save the pending enrollment: {error}");
                internal("Cannot save the agent's state.")
            })?;

        // 5. The backend call (30-second timeout inside the backend).
        let backend: Arc<dyn Backend> = (ctx.factory)(&code.convex_url).map_err(|error| backend_failure(&error))?;
        let device_name = params
            .device_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .or_else(|| ctx.platform.computer_name().ok())
            .unwrap_or_else(|| "Unnamed device".to_string());
        let request = EnrollRequest {
            token: code.token,
            device_secret_hash: sha256_hex(&secret),
            device_name,
            hardware_id_hash: hardware_id_hash(ctx.platform.as_ref()),
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
            compat: report.to_json(),
        };
        let response = match backend.enroll(request).await {
            Ok(response) => response,
            Err(BackendError::Rejected { code }) if is_token_code(&code) => {
                // The code is dead: forget the attempt (and its secret).
                self.clear_pending();
                return Err(backend_failure(&BackendError::Rejected { code }));
            }
            // Unreachable or timed out: the pending enrollment stays, so a retry with
            // the same code sends the same secret hash.
            Err(error) => return Err(backend_failure(&error)),
        };

        // 6. Success: move the secret, write the enrollment, clear the pending one.
        //    The device secret is saved while the pending one is still there: a
        //    crash between the two files leaves a state a retry completes.
        ctx.shared
            .update_secrets(|secrets| secrets.device_secret = Some(secret.clone()))
            .map_err(|error| {
                tracing::error!("cannot save the device secret: {error}");
                internal("Cannot save the agent's secrets. Run the enrollment again with the same code.")
            })?;
        let replaced_revoked = state.enrollment.is_some();
        if replaced_revoked {
            // A revoked enrollment is being replaced: its documents and employees
            // belong to the old organization.
            self.forget_organization_data();
        }
        let now = (ctx.now_ms)();
        let enrollment = Enrollment {
            convex_url: code.convex_url.clone(),
            device_id: response.device_id.clone(),
            org_id: response.org_id.clone(),
            device_name: response.device_name.clone(),
            enrolled_at_ms: now,
            revoked: false,
        };
        if let Err(error) = ctx.shared.update(|state| {
            state.enrollment = Some(enrollment);
            state.pending_enrollment = None;
            state.last_applied_version = 0;
        }) {
            // The server has the device; a retry with the same code is idempotent.
            tracing::error!("cannot save the enrollment: {error}");
        }
        if let Err(error) = ctx.shared.update_secrets(|secrets| secrets.pending_device_secret = None) {
            tracing::warn!("cannot clear the pending device secret: {error}");
        }
        ctx.snapshot.update(|snapshot| {
            snapshot.enrollment = EnrollmentStatus::Enrolled;
            snapshot.device =
                Some(DeviceInfo { id: response.device_id.clone(), name: response.device_name.clone() });
            snapshot.convex_url = Some(code.convex_url.clone());
            snapshot.connection = ConnectionStatus::Offline;
        });
        note_server_time(ctx, response.server_time_ms);
        tracing::info!(device_id = %response.device_id, "this PC is enrolled");

        // 7. Start syncing, then wait for the first reconcile. A kiosk failure is
        //    not an enrollment failure: the device stays enrolled and the reconciler
        //    retries (Section 5.6).
        let auth = DeviceAuth { device_id: response.device_id.clone(), device_secret: secret };
        self.runner.start(backend, auth).await;
        let kiosk = match tokio::time::timeout(self.timings.reconcile_wait, ctx.control.reconcile_now()).await {
            Ok(kiosk) => kiosk,
            Err(_) => {
                tracing::warn!("the first reconcile did not finish within the wait; enrollment continues");
                ctx.snapshot.current().kiosk
            }
        };
        Ok(AdminEnrollResult {
            device_id: response.device_id,
            device_name: response.device_name,
            kiosk,
        })
    }

    /// Forgets a failed attempt: the pending enrollment and its secret.
    fn clear_pending(&self) {
        if let Err(error) = self.ctx.shared.update_secrets(|secrets| secrets.pending_device_secret = None) {
            tracing::error!("cannot clear the pending device secret: {error}");
        }
        if let Err(error) = self.ctx.shared.update(|state| state.pending_enrollment = None) {
            tracing::error!("cannot clear the pending enrollment: {error}");
        }
    }

    /// What belongs to the organization the PC is leaving: the cached document, the
    /// offline employee cache, the lockout counters and the undelivered audit
    /// records. Also resets the policy and the snapshot's document fields.
    fn forget_organization_data(&self) {
        let ctx = &self.ctx;
        if let Err(error) = remove_file_if_exists(&ctx.paths.desired_state()) {
            tracing::error!("cannot delete desired-state.json: {error}");
        }
        ctx.session.forget_employees();
        if let Err(error) = lock(&self.lockouts).reset() {
            tracing::error!("cannot delete lockouts.json: {error}");
        }
        let undelivered = self.audit.discard_all();
        if undelivered > 0 {
            tracing::warn!(undelivered, "audit records that were never delivered were discarded");
        }
        publish_policy(&ctx.policy_tx, AgentPolicy::default());
        ctx.snapshot.update(|snapshot| {
            snapshot.desired_state = None;
            snapshot.desired_state_version = 0;
            AgentPolicy::default().apply_to_snapshot(snapshot);
        });
    }

    // -- unenroll -----------------------------------------------------------------

    async fn unenroll(&self, params: AdminUnenrollParams) -> Result<(), RpcError> {
        let ctx = &self.ctx;
        let state = ctx.shared.get();
        let Some(enrollment) = state.enrollment.clone() else {
            return Err(rpc_error(ErrorCode::NotEnrolled, "This PC is not enrolled.", false));
        };

        // 1. Stop syncing, so no new document arrives while the kiosk is undone.
        self.runner.stop().await;

        // 2. Undo the kiosk (Section 5.6 "Disable"). If that fails nothing else is
        //    touched: the enrollment and the journal are what `recover` needs.
        if let Err(reason) = ctx.control.disable().await {
            tracing::error!("cannot switch the kiosk off: {reason}");
            self.runner.start_from_state().await;
            return Err(operation_failed(
                extra_reasons::KIOSK_DISABLE_FAILED,
                "The kiosk could not be switched off, so this PC is still enrolled. Try again, \
                 or use `rulebox-agent recover`.",
                true,
                None,
            ));
        }

        // 3. The Staff account, when asked: sign its session out, wait, delete it.
        if params.remove_staff_account {
            if let Some(staff) = &state.staff {
                if let Err(error) = self.remove_staff_account(staff).await {
                    self.runner.start_from_state().await;
                    return Err(error);
                }
            }
        }

        // 4. Tell the backend. A failure is only logged: the PC leaves either way.
        self.tell_backend(&enrollment).await;

        // 5. Wipe: secrets, the cached document, then the enrollment and everything
        //    that belongs to the organization.
        if let Err(error) = ctx.shared.update_secrets(|secrets| {
            secrets.device_secret = None;
            secrets.pending_device_secret = None;
        }) {
            tracing::error!("cannot clear the saved secrets: {error}");
        }
        self.forget_organization_data();
        let removed_staff = params.remove_staff_account;
        if let Err(error) = ctx.shared.update(|state| {
            state.enrollment = None;
            state.pending_enrollment = None;
            if removed_staff {
                state.staff = None;
            }
            state.journal.clear();
            state.last_applied_version = 0;
            if removed_staff {
                state.kiosk = KioskRecord::default();
            }
        }) {
            tracing::error!("cannot save the unenrolled state: {error}");
        }
        ctx.snapshot.update(not_enrolled_snapshot);
        tracing::info!("this PC is no longer enrolled");
        Ok(())
    }

    /// `devices:unenroll` under a 10-second timeout; every outcome is only logged.
    async fn tell_backend(&self, enrollment: &Enrollment) {
        let ctx = &self.ctx;
        let secret = match ctx.shared.secrets(|secrets| secrets.device_secret.clone()) {
            Ok(Some(secret)) => secret,
            Ok(None) => {
                tracing::warn!("no device secret: the backend is not told about the unenrollment");
                return;
            }
            Err(error) => {
                tracing::warn!("cannot read the device secret ({error}): the backend is not told");
                return;
            }
        };
        let backend = match (ctx.factory)(&enrollment.convex_url) {
            Ok(backend) => backend,
            Err(error) => {
                tracing::warn!("cannot reach the backend to unenroll ({error})");
                return;
            }
        };
        let auth = DeviceAuth { device_id: enrollment.device_id.clone(), device_secret: secret };
        match tokio::time::timeout(self.timings.unenroll_call, backend.unenroll(&auth)).await {
            Ok(Ok(())) => tracing::info!("the backend was told about the unenrollment"),
            Ok(Err(error)) => tracing::warn!("the backend was not told about the unenrollment: {error}"),
            Err(_) => tracing::warn!("the backend did not answer the unenrollment in time"),
        }
    }

    /// Signs the Staff session out, waits for it to end (up to 30 s), then deletes
    /// the account and its profile. Every Windows call goes through `Platform`.
    async fn remove_staff_account(&self, staff: &StaffAccount) -> Result<(), RpcError> {
        let platform = Arc::clone(&self.ctx.platform);
        let staff_sessions = |platform: &dyn Platform| -> Vec<u32> {
            platform
                .sessions()
                .map(|sessions| {
                    sessions
                        .iter()
                        .filter(|session| session.user_sid.as_deref() == Some(staff.sid.as_str()))
                        .map(|session| session.id)
                        .collect()
                })
                .unwrap_or_default()
        };

        for session_id in staff_sessions(platform.as_ref()) {
            let platform = Arc::clone(&platform);
            let result = tokio::task::spawn_blocking(move || platform.logoff_session(session_id)).await;
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => tracing::warn!(session_id, "cannot sign the Staff session out: {error}"),
                Err(_) => tracing::warn!(session_id, "the sign-out task failed"),
            }
        }
        let deadline = tokio::time::Instant::now() + self.timings.staff_session_wait;
        while !staff_sessions(platform.as_ref()).is_empty() {
            if tokio::time::Instant::now() >= deadline {
                return Err(operation_failed(
                    extra_reasons::STAFF_SESSION_OPEN,
                    "The Staff session did not end within 30 seconds, so the account was kept. \
                     Sign it out and try again.",
                    true,
                    None,
                ));
            }
            tokio::time::sleep(self.timings.staff_session_poll).await;
        }

        let sid = staff.sid.clone();
        let user_name = staff.user_name.clone();
        let deleter = Arc::clone(&platform);
        let deleted = tokio::task::spawn_blocking(move || deleter.delete_staff_user(&sid, &user_name)).await;
        match deleted {
            Ok(Ok(())) | Ok(Err(crate::platform::PlatformError::NotFound)) => Ok(()),
            Ok(Err(error)) => {
                tracing::error!("cannot delete the Staff account: {error}");
                Err(operation_failed(
                    extra_reasons::STAFF_ACCOUNT_REMOVE_FAILED,
                    "The Staff account could not be deleted. See the agent log.",
                    true,
                    None,
                ))
            }
            Err(_) => Err(internal("The account removal task failed.")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::Ordering;

    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    use rulebox_ipc::admin::OperationFailure;
    use rulebox_ipc::types::{KioskPhase, KioskStatus};
    use tokio::sync::watch;

    use crate::backend::fake::FakeBackend;
    use crate::backend::{BackendEvent, DesiredFetch, EnrollResponse};
    use crate::kiosk_control::{FakeKioskControl, KioskControl};
    use crate::paths::DataPaths;
    use crate::platform::sim::{SimOp, SimPlatform};
    use crate::platform::PlatformError;
    use crate::session::SessionManager;
    use crate::state::{AgentState, KioskApplied, SharedState, SnapshotHandle, StateStore};
    use crate::testutil::{test_session_parts, test_snapshot, TempDir};

    const TOKEN: &str = "0123456789ABCDEFGHJK";
    const OTHER_TOKEN: &str = "KJHGFEDCBA9876543210";
    const URL: &str = "https://test.convex.cloud";

    fn code_for(token: &str) -> String {
        format!("RBX1.{}", URL_SAFE_NO_PAD.encode(format!("{URL}#{token}").as_bytes()))
    }

    fn enroll_params(token: &str) -> AdminEnrollParams {
        AdminEnrollParams { code: code_for(token), device_name: Some("Front desk".into()), allow_joined: false }
    }

    struct Rig {
        dir: TempDir,
        platform: Arc<SimPlatform>,
        ctx: Arc<TaskContext>,
        enroller: Enroller,
        runner: Arc<BackendRunner>,
        control: Arc<FakeKioskControl>,
        /// Handed out by the factory, in order; the last one repeats.
        fakes: Arc<Mutex<VecDeque<FakeBackend>>>,
        urls: Arc<Mutex<Vec<String>>>,
        snapshot_rx: watch::Receiver<AgentSnapshot>,
        lockouts: Arc<Mutex<LockoutStore>>,
        audit: Arc<AuditHandle>,
        session: Arc<SessionManager>,
    }

    impl Rig {
        fn new() -> Self {
            Self::with_state(AgentState::default())
        }

        fn with_state(state: AgentState) -> Self {
            let dir = TempDir::new();
            let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
            let dyn_platform: Arc<dyn Platform> = platform.clone();
            let paths = DataPaths::new(dir.path().to_path_buf());
            let store = StateStore::open(&paths.state_dir()).unwrap();
            let shared = SharedState::new(store, state.clone(), Arc::clone(&dyn_platform));
            let mut first = test_snapshot();
            if let Some(e) = &state.enrollment {
                first.enrollment = if e.revoked { EnrollmentStatus::Revoked } else { EnrollmentStatus::Enrolled };
            }
            let (snapshot, snapshot_rx) = SnapshotHandle::new(first);
            let (policy_tx, _policy_rx) = watch::channel(AgentPolicy::default());
            let parts = test_session_parts(dir.path(), snapshot_rx.clone());
            let control = Arc::new(FakeKioskControl::new());
            let fakes = Arc::new(Mutex::new(VecDeque::from([FakeBackend::new()])));
            let urls = Arc::new(Mutex::new(Vec::new()));
            let factory: crate::backend::BackendFactory = {
                let fakes = Arc::clone(&fakes);
                let urls = Arc::clone(&urls);
                Arc::new(move |url| {
                    lock(&urls).push(url.to_string());
                    let mut fakes = lock(&fakes);
                    let fake = if fakes.len() > 1 { fakes.pop_front() } else { fakes.front().cloned() };
                    Ok(Arc::new(fake.expect("a fake backend")) as Arc<dyn Backend>)
                })
            };
            let ctx = Arc::new(TaskContext {
                shared,
                paths,
                snapshot,
                policy_tx: Arc::new(policy_tx),
                session: Arc::clone(&parts.session),
                control: Arc::clone(&control) as Arc<dyn KioskControl>,
                platform: dyn_platform,
                factory,
                now_ms: Arc::new(|| 1_760_000_000_000),
                jitter: Arc::new(|_| 0),
            });
            let runner = BackendRunner::new(Arc::clone(&ctx), tokio_util::sync::CancellationToken::new());
            let enroller = Enroller::new(EnrollDeps {
                ctx: Arc::clone(&ctx),
                runner: Arc::clone(&runner),
                audit: Arc::clone(&parts.audit),
                lockouts: Arc::clone(&parts.lockouts),
                timings: Timings::default(),
            });
            Self {
                dir,
                platform,
                ctx,
                enroller,
                runner,
                control,
                fakes,
                urls,
                snapshot_rx,
                lockouts: parts.lockouts,
                audit: parts.audit,
                session: parts.session,
            }
        }

        fn fake(&self) -> FakeBackend {
            lock(&self.fakes).front().cloned().unwrap()
        }

        fn state(&self) -> AgentState {
            self.ctx.shared.get()
        }

        fn snapshot(&self) -> AgentSnapshot {
            self.snapshot_rx.borrow().clone()
        }

        fn pending_secret(&self) -> Option<String> {
            self.ctx.shared.secrets(|s| s.pending_device_secret.clone()).unwrap()
        }

        fn device_secret(&self) -> Option<String> {
            self.ctx.shared.secrets(|s| s.device_secret.clone()).unwrap()
        }

        async fn enroll(&self, params: AdminEnrollParams) -> Result<AdminEnrollResult, RpcError> {
            self.enroller.enroll(params).await
        }

        async fn unenroll(&self, remove_staff_account: bool) -> Result<(), RpcError> {
            self.enroller.unenroll(AdminUnenrollParams { remove_staff_account }).await
        }
    }

    fn failure(error: &RpcError) -> OperationFailure {
        assert_eq!(error.code, ErrorCode::OperationFailed, "{error:?}");
        serde_json::from_value(error.data.clone().expect("failure data")).unwrap()
    }

    fn response(device_id: &str) -> EnrollResponse {
        EnrollResponse {
            device_id: device_id.into(),
            org_id: "org-1".into(),
            device_name: "Front desk".into(),
            server_time_ms: 1_760_000_000_250,
        }
    }

    fn enrolled_state(revoked: bool) -> AgentState {
        AgentState {
            enrollment: Some(Enrollment {
                convex_url: URL.into(),
                device_id: "dev-old".into(),
                org_id: "org-old".into(),
                device_name: "Old".into(),
                enrolled_at_ms: 1,
                revoked,
            }),
            last_applied_version: 11,
            ..AgentState::default()
        }
    }

    async fn settle() {
        for _ in 0..30 {
            tokio::task::yield_now().await;
        }
    }

    // -- enroll ---------------------------------------------------------------

    #[tokio::test]
    async fn the_happy_path_writes_the_enrollment_moves_the_secret_and_starts_syncing() {
        let rig = Rig::new();
        let fake = rig.fake();
        fake.script_enroll(Ok(response("dev-77")));
        rig.platform.with_world(|w| {
            w.machine_values.insert(
                RegValueRef { path: r"SOFTWARE\Microsoft\Cryptography".into(), name: "MachineGuid".into() },
                RegData::String("11111111-2222-3333-4444-555555555555".into()),
            );
        });

        let result = rig.enroll(enroll_params(TOKEN)).await.unwrap();
        assert_eq!(result.device_id, "dev-77");
        assert_eq!(result.device_name, "Front desk");
        assert_eq!(result.kiosk.phase, KioskPhase::Applied);

        // The request: raw token, the hash of the secret's TEXT, the report.
        let calls = fake.enroll_calls();
        assert_eq!(calls.len(), 1);
        let secret = rig.device_secret().expect("the device secret is saved");
        assert_eq!(secret.len(), 64);
        assert_eq!(calls[0].token, TOKEN);
        assert_eq!(calls[0].device_secret_hash, sha256_hex(&secret));
        assert_eq!(calls[0].device_name, "Front desk");
        assert_eq!(calls[0].agent_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(
            calls[0].hardware_id_hash.as_deref(),
            Some(sha256_hex("11111111-2222-3333-4444-555555555555").as_str())
        );
        assert!(calls[0].compat["blockers"].as_array().unwrap().is_empty());

        // State: enrollment written, pending cleared in state and in secrets.
        let state = rig.state();
        let enrollment = state.enrollment.expect("enrolled");
        assert_eq!(
            (enrollment.device_id.as_str(), enrollment.org_id.as_str(), enrollment.convex_url.as_str()),
            ("dev-77", "org-1", URL)
        );
        assert!(!enrollment.revoked);
        assert!(state.pending_enrollment.is_none());
        assert!(rig.pending_secret().is_none());

        // The snapshot, the reconciler call and the subscription.
        let snapshot = rig.snapshot();
        assert_eq!(snapshot.enrollment, EnrollmentStatus::Enrolled);
        assert_eq!(snapshot.device.map(|d| d.id), Some("dev-77".to_string()));
        assert_eq!(snapshot.convex_url.as_deref(), Some(URL));
        assert_eq!(snapshot.server_time_offset_ms, Some(250));
        assert_eq!(rig.control.reconciles.load(Ordering::SeqCst), 1);
        fake.wait_for_subscription().await;
        let used = fake.subscriptions();
        assert_eq!(used[0].device_id, "dev-77");
        // The hash the server stored is the hash of the secret every later call sends.
        assert_eq!(sha256_hex(&used[0].device_secret), calls[0].device_secret_hash);
        assert!(rig.runner.is_running().await);
        rig.runner.stop().await;
    }

    #[tokio::test]
    async fn without_a_name_the_computer_name_is_used() {
        let rig = Rig::new();
        let params = AdminEnrollParams { code: code_for(TOKEN), device_name: Some("   ".into()), allow_joined: false };
        rig.enroll(params).await.unwrap();
        assert_eq!(rig.fake().enroll_calls()[0].device_name, "SIM-PC");
        rig.runner.stop().await;
    }

    #[tokio::test]
    async fn a_timeout_keeps_pending_and_the_same_code_reuses_the_secret() {
        let rig = Rig::new();
        let fake = rig.fake();
        fake.script_enroll(Err(BackendError::Timeout));
        let error = rig.enroll(enroll_params(TOKEN)).await.unwrap_err();
        let failed = failure(&error);
        assert_eq!(failed.reason, reasons::BACKEND_UNREACHABLE);
        assert!(error.retryable);
        assert!(rig.state().enrollment.is_none());
        let pending = rig.state().pending_enrollment.expect("pending stays");
        assert_eq!(pending.convex_url, URL);
        assert_eq!(pending.token_sha256, sha256_hex(TOKEN));
        let first_secret = rig.pending_secret().expect("the pending secret stays");

        // Retry with the SAME code: same secret, same hash.
        fake.script_enroll(Err(BackendError::Unreachable));
        rig.enroll(enroll_params(TOKEN)).await.unwrap_err();
        assert_eq!(rig.pending_secret().as_deref(), Some(first_secret.as_str()));
        let calls = fake.enroll_calls();
        assert_eq!(calls[0].device_secret_hash, calls[1].device_secret_hash);
        assert_eq!(calls[0].device_secret_hash, sha256_hex(&first_secret));

        // A DIFFERENT code starts over with a new secret and a new pending record.
        fake.script_enroll(Err(BackendError::Timeout));
        rig.enroll(enroll_params(OTHER_TOKEN)).await.unwrap_err();
        let second_secret = rig.pending_secret().unwrap();
        assert_ne!(second_secret, first_secret);
        assert_eq!(fake.enroll_calls()[2].device_secret_hash, sha256_hex(&second_secret));
        assert_eq!(rig.state().pending_enrollment.unwrap().token_sha256, sha256_hex(OTHER_TOKEN));

        // And the first code again is now "a different code" too.
        fake.script_enroll(Ok(response("dev-1")));
        rig.enroll(enroll_params(TOKEN)).await.unwrap();
        assert_ne!(fake.enroll_calls()[3].device_secret_hash, sha256_hex(&second_secret));
        rig.runner.stop().await;
    }

    #[tokio::test]
    async fn a_dead_token_clears_pending_and_the_secret_and_returns_its_code() {
        for code in ["token_expired", "token_used_up", "token_revoked", "token_invalid"] {
            let rig = Rig::new();
            rig.fake().script_enroll(Err(BackendError::Rejected { code: code.into() }));
            let error = rig.enroll(enroll_params(TOKEN)).await.unwrap_err();
            let failed = failure(&error);
            assert_eq!(failed.reason, code);
            assert!(!error.retryable);
            assert!(rig.state().pending_enrollment.is_none(), "{code}");
            assert!(rig.pending_secret().is_none(), "{code}");
            assert!(rig.state().enrollment.is_none());
            assert!(rig.device_secret().is_none());
        }
    }

    #[tokio::test]
    async fn a_compat_blocker_stops_enrollment_before_any_backend_call() {
        let rig = Rig::new();
        rig.platform.with_world(|w| {
            w.legal_notice = true;
            w.os.s_mode = true;
        });
        let error = rig.enroll(enroll_params(TOKEN)).await.unwrap_err();
        let failed = failure(&error);
        assert_eq!(failed.reason, reasons::COMPAT_BLOCKED);
        assert_eq!(failed.details.unwrap()["blockers"], serde_json::json!(["s_mode", "legal_notice"]));
        assert!(rig.fake().enroll_calls().is_empty());
        assert!(lock(&rig.urls).is_empty(), "no backend was even built");
        // Nothing was written: no pending enrollment, no secret.
        assert!(rig.state().pending_enrollment.is_none());
        assert!(rig.pending_secret().is_none());
    }

    #[tokio::test]
    async fn each_failure_has_its_reason_and_only_unreachable_is_retryable() {
        // already_enrolled
        let rig = Rig::with_state(enrolled_state(false));
        let error = rig.enroll(enroll_params(TOKEN)).await.unwrap_err();
        assert_eq!(failure(&error).reason, reasons::ALREADY_ENROLLED);
        assert!(!error.retryable);
        assert!(rig.fake().enroll_calls().is_empty());

        // code_invalid with the kind of the problem, and no backend call
        let rig = Rig::new();
        let params = AdminEnrollParams { code: "RBX2.nope".into(), device_name: None, allow_joined: false };
        let error = rig.enroll(params).await.unwrap_err();
        let failed = failure(&error);
        assert_eq!(failed.reason, reasons::CODE_INVALID);
        assert_eq!(failed.details.unwrap()["kind"], "badPrefix");
        assert!(rig.fake().enroll_calls().is_empty());

        // backend_unreachable (retryable), backend_rejected with the server code,
        // and a protocol error
        let cases: Vec<(BackendError, &str, bool, Option<&str>)> = vec![
            (BackendError::Unreachable, reasons::BACKEND_UNREACHABLE, true, None),
            (BackendError::Timeout, reasons::BACKEND_UNREACHABLE, true, None),
            (
                BackendError::Rejected { code: "invalid_request".into() },
                reasons::BACKEND_REJECTED,
                false,
                Some("invalid_request"),
            ),
            (
                BackendError::Rejected { code: "server_error".into() },
                reasons::BACKEND_REJECTED,
                false,
                Some("server_error"),
            ),
            (BackendError::Protocol("x".into()), reasons::BACKEND_REJECTED, false, Some("protocol_error")),
        ];
        for (backend_error, reason, retryable, server_code) in cases {
            let rig = Rig::new();
            rig.fake().script_enroll(Err(backend_error.clone()));
            let error = rig.enroll(enroll_params(TOKEN)).await.unwrap_err();
            let failed = failure(&error);
            assert_eq!(failed.reason, reason, "{backend_error:?}");
            assert_eq!(error.retryable, retryable, "{backend_error:?}");
            assert_eq!(
                failed.details.and_then(|d| d.get("serverCode").and_then(|c| c.as_str().map(str::to_string))),
                server_code.map(str::to_string),
                "{backend_error:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_failure_of_the_error_text_never_contains_the_code_or_the_token() {
        let rig = Rig::new();
        rig.fake().script_enroll(Err(BackendError::Rejected { code: "token_expired".into() }));
        let code = code_for(TOKEN);
        let error = rig.enroll(enroll_params(TOKEN)).await.unwrap_err();
        let text = format!("{error:?}");
        assert!(!text.contains(TOKEN) && !text.contains(&code), "{text}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_kiosk_failure_is_not_an_enrollment_failure() {
        let rig = Rig::new();
        *lock(&rig.control.kiosk) = KioskStatus {
            enabled: false,
            phase: KioskPhase::Failed,
            error_code: Some("staff_account_conflict".into()),
        };
        let result = rig.enroll(enroll_params(TOKEN)).await.unwrap();
        assert_eq!(result.kiosk.error_code.as_deref(), Some("staff_account_conflict"));
        assert!(rig.state().enrollment.is_some(), "the device stays enrolled");
        rig.runner.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_reconcile_that_never_finishes_is_given_120_seconds() {
        let rig = Rig::new();
        rig.control.hang_reconcile.store(true, Ordering::SeqCst);
        let started = tokio::time::Instant::now();
        let result = rig.enroll(enroll_params(TOKEN)).await.unwrap();
        assert_eq!(tokio::time::Instant::now() - started, Duration::from_secs(120));
        // The answer carries what the snapshot knows.
        assert_eq!(result.kiosk, test_snapshot().kiosk);
        assert!(rig.state().enrollment.is_some());
        rig.runner.stop().await;
    }

    #[tokio::test]
    async fn enrolling_again_over_a_revoked_enrollment_starts_clean() {
        let rig = Rig::with_state(enrolled_state(true));
        // The old organization's cached document and an employee audit record.
        std::fs::write(rig.ctx.paths.desired_state(), br#"{"version":11,"doc":{}}"#).unwrap();
        rig.audit.record(crate::audit::AuditKind::AdminExitWrongPin, None, None);
        assert_eq!(rig.audit.queued(), 1);
        rig.fake().script_enroll(Ok(response("dev-new")));

        rig.enroll(enroll_params(TOKEN)).await.unwrap();
        let state = rig.state();
        assert_eq!(state.enrollment.as_ref().map(|e| e.device_id.as_str()), Some("dev-new"));
        assert!(!state.enrollment.unwrap().revoked);
        assert_eq!(state.last_applied_version, 0);
        assert!(!rig.ctx.paths.desired_state().exists());
        assert_eq!(rig.audit.queued(), 0);
        assert_eq!(rig.snapshot().enrollment, EnrollmentStatus::Enrolled);
        rig.runner.stop().await;
    }

    #[tokio::test]
    async fn the_platform_is_only_read_during_enrollment() {
        let rig = Rig::new();
        rig.enroll(enroll_params(TOKEN)).await.unwrap();
        rig.runner.stop().await;
        let mutating = [
            SimOp::CreateStaffUser,
            SimOp::SetUserPassword,
            SimOp::DeleteStaffUser,
            SimOp::WriteMachineValue,
            SimOp::LsaSecretSet,
            SimOp::SetStaffShell,
            SimOp::LogoffSession,
        ];
        let calls = rig.platform.calls();
        assert!(calls.iter().all(|call| !mutating.contains(call)), "{calls:?}");
    }

    // -- unenroll -------------------------------------------------------------

    async fn enrolled_rig() -> (Rig, String) {
        let rig = Rig::new();
        rig.enroll(enroll_params(TOKEN)).await.unwrap();
        let secret = rig.device_secret().unwrap();
        rig.fake().wait_for_subscription().await;
        (rig, secret)
    }

    #[tokio::test]
    async fn unenroll_tells_the_backend_and_wipes_everything_of_the_organization() {
        let (rig, secret) = enrolled_rig().await;
        // Things that belong to the organization.
        std::fs::write(rig.ctx.paths.desired_state(), br#"{"version":2,"doc":{}}"#).unwrap();
        rig.audit.record(crate::audit::AuditKind::AdminExitWrongPin, None, None);
        {
            let mut lockouts = lock(&rig.lockouts);
            lockouts.admin_exit().record_failure(&crate::lockout::PIN_POLICY, 1);
            lockouts.save(1).unwrap();
        }
        assert!(rig.ctx.paths.lockouts().exists());
        assert!(rig.ctx.paths.audit_queue().exists());

        rig.unenroll(false).await.unwrap();

        // The backend was told, with the secret.
        let calls = rig.fake().unenroll_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].device_id, "dev-1");
        assert_eq!(calls[0].device_secret, secret);
        // Local state.
        let state = rig.state();
        assert!(state.enrollment.is_none() && state.pending_enrollment.is_none());
        assert_eq!(state.last_applied_version, 0);
        assert!(rig.device_secret().is_none());
        assert!(!rig.ctx.paths.desired_state().exists());
        assert!(!rig.ctx.paths.lockouts().exists());
        assert!(!rig.ctx.paths.audit_queue().exists());
        assert_eq!(rig.audit.queued(), 0);
        // The snapshot and the task.
        let snapshot = rig.snapshot();
        assert_eq!(snapshot.enrollment, EnrollmentStatus::NotEnrolled);
        assert!(snapshot.device.is_none() && snapshot.convex_url.is_none());
        assert!(!rig.runner.is_running().await);
        assert_eq!(rig.control.disables.load(Ordering::SeqCst), 1);
        // The Staff account was not asked about.
        assert!(!rig.platform.calls().contains(&SimOp::DeleteStaffUser));
    }

    #[tokio::test]
    async fn unenroll_succeeds_when_the_backend_rejects_or_is_unreachable() {
        for backend_answer in [
            Ok(()),
            Err(BackendError::Rejected { code: "rejected".into() }),
            Err(BackendError::Unreachable),
            Err(BackendError::Timeout),
        ] {
            let (rig, _) = enrolled_rig().await;
            rig.fake().script_unenroll(backend_answer.clone());
            rig.unenroll(false).await.unwrap();
            assert_eq!(rig.fake().unenroll_calls().len(), 1, "{backend_answer:?}");
            assert!(rig.state().enrollment.is_none(), "{backend_answer:?}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn unenroll_gives_the_backend_ten_seconds_and_goes_on() {
        // A backend that never answers `unenroll`.
        struct Silent(FakeBackend);
        impl Backend for Silent {
            fn enroll(
                &self,
                req: EnrollRequest,
            ) -> BoxFuture<'_, Result<EnrollResponse, BackendError>> {
                self.0.enroll(req)
            }
            fn heartbeat(
                &self,
                auth: &DeviceAuth,
                status: Option<crate::backend::StatusReport>,
            ) -> BoxFuture<'_, Result<crate::backend::HeartbeatResponse, BackendError>> {
                self.0.heartbeat(auth, status)
            }
            fn unenroll(&self, _auth: &DeviceAuth) -> BoxFuture<'_, Result<(), BackendError>> {
                std::future::pending().boxed()
            }
            fn subscribe(
                &self,
                auth: DeviceAuth,
                tx: tokio::sync::mpsc::Sender<BackendEvent>,
                shutdown: tokio_util::sync::CancellationToken,
            ) -> BoxFuture<'_, ()> {
                self.0.subscribe(auth, tx, shutdown)
            }
        }
        let rig = Rig::new();
        let silent: Arc<dyn Backend> = Arc::new(Silent(FakeBackend::new()));
        let factory_backend = Arc::clone(&silent);
        // Rebuild the enroller over a context whose factory returns the silent one.
        let ctx = Arc::new(TaskContext {
            shared: Arc::clone(&rig.ctx.shared),
            paths: rig.ctx.paths.clone(),
            snapshot: rig.ctx.snapshot.clone(),
            policy_tx: Arc::clone(&rig.ctx.policy_tx),
            session: Arc::clone(&rig.session),
            control: Arc::clone(&rig.control) as Arc<dyn KioskControl>,
            platform: Arc::clone(&rig.ctx.platform),
            factory: Arc::new(move |_| Ok(Arc::clone(&factory_backend))),
            now_ms: Arc::clone(&rig.ctx.now_ms),
            jitter: Arc::clone(&rig.ctx.jitter),
        });
        let runner = BackendRunner::new(Arc::clone(&ctx), tokio_util::sync::CancellationToken::new());
        let enroller = Enroller::new(EnrollDeps {
            ctx,
            runner: Arc::clone(&runner),
            audit: Arc::clone(&rig.audit),
            lockouts: Arc::clone(&rig.lockouts),
            timings: Timings::default(),
        });
        enroller.enroll(enroll_params(TOKEN)).await.unwrap();
        let started = tokio::time::Instant::now();
        enroller.unenroll(AdminUnenrollParams { remove_staff_account: false }).await.unwrap();
        assert_eq!(tokio::time::Instant::now() - started, Duration::from_secs(10));
        assert!(rig.state().enrollment.is_none());
    }

    #[tokio::test]
    async fn unenroll_needs_an_enrollment() {
        let rig = Rig::new();
        let error = rig.unenroll(false).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::NotEnrolled);
        assert_eq!(rig.control.disables.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_revoked_device_can_be_unenrolled() {
        let rig = Rig::with_state(enrolled_state(true));
        // Its secret is still in the secrets file.
        rig.ctx.shared.update_secrets(|s| s.device_secret = Some("ab".repeat(32))).unwrap();
        rig.fake().script_unenroll(Err(BackendError::Rejected { code: "rejected".into() }));
        rig.unenroll(false).await.unwrap();
        assert!(rig.state().enrollment.is_none());
        assert_eq!(rig.snapshot().enrollment, EnrollmentStatus::NotEnrolled);
    }

    #[tokio::test]
    async fn a_failed_disable_changes_nothing_and_syncing_resumes() {
        let (rig, secret) = enrolled_rig().await;
        *lock(&rig.control.disable_error) = Some("platform said no".into());
        let error = rig.unenroll(true).await.unwrap_err();
        let failed = failure(&error);
        assert_eq!(failed.reason, extra_reasons::KIOSK_DISABLE_FAILED);
        assert!(error.retryable);
        // Still enrolled, secret and cache intact, backend not told, task running again.
        assert!(rig.state().enrollment.is_some());
        assert_eq!(rig.device_secret().as_deref(), Some(secret.as_str()));
        assert!(rig.fake().unenroll_calls().is_empty());
        assert!(!rig.platform.calls().contains(&SimOp::DeleteStaffUser));
        assert!(rig.runner.is_running().await);
        rig.runner.stop().await;
    }

    fn add_staff(rig: &Rig) -> StaffAccount {
        let sid = rig
            .platform
            .create_staff_user(
                &crate::platform::StaffUserSpec {
                    user_name: "RuleboxStaff".into(),
                    full_name: "Staff".into(),
                    comment: "Managed by Rulebox. Do not edit or delete.".into(),
                },
                "pw",
            )
            .unwrap();
        let staff = StaffAccount { sid: sid.clone(), user_name: "RuleboxStaff".into(), profile_dir: None };
        rig.ctx.shared.update(|s| s.staff = Some(staff.clone())).unwrap();
        staff
    }

    #[tokio::test]
    async fn unenroll_can_remove_the_staff_account_through_the_platform() {
        let (rig, _) = enrolled_rig().await;
        let staff = add_staff(&rig);
        // A signed-in Staff session, and an administrator's session that must stay.
        rig.platform.add_session(3, Some(&staff.sid), true);
        rig.platform.add_session(1, Some("S-1-5-21-9-9-9-500"), true);

        rig.unenroll(true).await.unwrap();

        let calls = rig.platform.calls();
        assert!(calls.contains(&SimOp::LogoffSession) && calls.contains(&SimOp::DeleteStaffUser));
        assert!(rig.platform.find_local_user("RuleboxStaff").unwrap().is_none());
        let remaining: Vec<u32> = rig.platform.sessions().unwrap().iter().map(|s| s.id).collect();
        assert_eq!(remaining, [1], "only the Staff session was signed out");
        let state = rig.state();
        assert!(state.staff.is_none() && state.enrollment.is_none());
        assert_eq!(state.kiosk.applied, KioskApplied::NotApplied);
    }

    #[tokio::test]
    async fn the_staff_account_stays_unless_asked() {
        let (rig, _) = enrolled_rig().await;
        let staff = add_staff(&rig);
        rig.unenroll(false).await.unwrap();
        assert!(rig.platform.find_local_user("RuleboxStaff").unwrap().is_some());
        assert_eq!(rig.state().staff.map(|s| s.sid), Some(staff.sid));
    }

    #[tokio::test(start_paused = true)]
    async fn a_staff_session_that_will_not_end_keeps_the_account_and_the_enrollment() {
        let (rig, _) = enrolled_rig().await;
        let staff = add_staff(&rig);
        rig.platform.add_session(3, Some(&staff.sid), true);
        // The sign-out call "works" but the session stays (a hung logoff).
        rig.platform.fail_next(SimOp::LogoffSession, PlatformError::Other("hung".into()));
        let started = tokio::time::Instant::now();
        let error = rig.unenroll(true).await.unwrap_err();
        assert_eq!(failure(&error).reason, extra_reasons::STAFF_SESSION_OPEN);
        assert!(tokio::time::Instant::now() - started >= Duration::from_secs(30));
        assert!(rig.platform.find_local_user("RuleboxStaff").unwrap().is_some());
        assert!(rig.state().enrollment.is_some());
        assert!(rig.fake().unenroll_calls().is_empty());
        rig.runner.stop().await;
    }

    #[tokio::test]
    async fn a_failed_account_deletion_is_reported_and_the_enrollment_stays() {
        let (rig, _) = enrolled_rig().await;
        add_staff(&rig);
        rig.platform.fail_next(SimOp::DeleteStaffUser, PlatformError::AccessDenied);
        let error = rig.unenroll(true).await.unwrap_err();
        assert_eq!(failure(&error).reason, extra_reasons::STAFF_ACCOUNT_REMOVE_FAILED);
        assert!(rig.state().enrollment.is_some());
        rig.runner.stop().await;
    }

    #[tokio::test]
    async fn the_revocation_in_the_stream_and_the_cleanup_of_unenroll_work_together() {
        let (rig, _) = enrolled_rig().await;
        rig.fake().push(BackendEvent::Desired(DesiredFetch::Revoked));
        for _ in 0..100 {
            if !rig.runner.is_running().await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(rig.state().enrollment.unwrap().revoked);
        settle().await;
        rig.unenroll(false).await.unwrap();
        assert!(rig.state().enrollment.is_none());
    }
}
