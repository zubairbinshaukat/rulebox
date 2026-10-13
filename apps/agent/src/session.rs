//! The employee session and the app catalogue (plan Section 5.9, protocol 1.1):
//! `session.signIn`, `session.signOut`, `session.get`, `session.verifyPassword`
//! and `apps.list`.
//!
//! The agent asks an [`EmployeeDirectory`] for one online check, keeps an Argon2id
//! hash of the password for offline sign-in, rate-limits guesses (persisted, per
//! username and per device) and keeps **one** session in memory. It makes no
//! Windows call and it never creates, opens or lists the employee's files folder:
//! it only builds the string (`files_folder_name`).
//!
//! Passwords are never logged and never stored in plain text.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use rulebox_ipc::methods::{
    AppsList, Empty, Method, SessionGet, SessionSignIn, SessionSignOut, SessionVerifyPassword,
};
use rulebox_ipc::requests::{
    AppEntry, AppsListResult, Employee, SessionGetResult, SignInOutcome, SignInParams, SignInResult,
    VerifyOutcome, VerifyPasswordParams, VerifyPasswordResult,
};
use rulebox_ipc::types::{AgentSnapshot, ConnectionStatus, EnrollmentStatus};
use rulebox_ipc::{ErrorCode, RpcError, CAP_APPS, CAP_SESSION};
use sha2::{Digest, Sha256};
use tokio::sync::watch;

use crate::audit::{AuditHandle, AuditKind};
use crate::directory::{DirectoryAnswer, EmployeeDirectory};
use crate::employee_cache::{is_expired, CacheEntry, EmployeeCache};
use crate::ipc_conn::{rpc_error, PeerCtx, RpcResult};
use crate::ipc_shell::ShellExtension;
use crate::kdf;
use crate::lockout::{DeviceGuard, Gate, LockoutStore, PASSWORD_POLICY};
use crate::state::lock;

/// Longest username after normalization, in characters.
const MAX_USERNAME_CHARS: usize = 64;
/// Longest password, in characters.
const MAX_PASSWORD_CHARS: usize = 256;
/// An icon above this many base64 characters (32 KiB decoded) is replaced by null.
const MAX_ICON_BASE64_CHARS: usize = 43_692;
/// If the serialized `apps.list` result is still above this, every icon goes.
const MAX_APPS_RESULT_BYTES: usize = 900_000;

/// How long the agent waits. The plan fixes both values; tests shorten or
/// lengthen them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionTimeouts {
    /// One online check against the directory (Section 5.9, step 7).
    pub directory: Duration,
    /// The whole `session.signIn` or `session.verifyPassword` request (step 9).
    pub budget: Duration,
}

impl Default for SessionTimeouts {
    fn default() -> Self {
        Self { directory: Duration::from_secs(6), budget: Duration::from_secs(8) }
    }
}

pub struct SessionDeps {
    pub directory: Arc<dyn EmployeeDirectory>,
    pub cache: EmployeeCache,
    /// Shared with the exit-PIN counter (Step 6b).
    pub lockouts: Arc<Mutex<LockoutStore>>,
    pub audit: Arc<AuditHandle>,
    pub snapshot_rx: watch::Receiver<AgentSnapshot>,
    /// `<Staff profile>\RuleboxFiles`, or `<data>\sim-files` in `--sim-demo`;
    /// `None` until the Staff account is set up.
    pub files_base: Option<PathBuf>,
    /// The wall clock, in Unix milliseconds.
    pub now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    /// The highest wall clock the agent has seen (`state.last_wall_clock_ms`); the
    /// offline period is measured against the larger of this and `now_ms`.
    pub clock_floor_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    pub timeouts: SessionTimeouts,
}

/// The signed-in employee. Memory only: it is never written to disk (Section 5.9).
struct ActiveSession {
    /// The normalized login name; the key of the lockout counter and cache entry.
    username: String,
    employee: Employee,
    apps: Vec<AppEntry>,
    files_root: String,
    offline: bool,
    /// Argon2id PHC string of the password, for `session.verifyPassword`.
    password_hash: String,
}

struct Inner {
    directory: Arc<dyn EmployeeDirectory>,
    cache: Mutex<EmployeeCache>,
    lockouts: Arc<Mutex<LockoutStore>>,
    audit: Arc<AuditHandle>,
    snapshot_rx: watch::Receiver<AgentSnapshot>,
    files_base: Mutex<Option<PathBuf>>,
    now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    clock_floor_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    timeouts: SessionTimeouts,
    session: Mutex<Option<ActiveSession>>,
    device_guard: Mutex<DeviceGuard>,
    /// One `signIn` or `verifyPassword` check at a time keeps parallel requests
    /// from racing the failure counter.
    gate: Arc<tokio::sync::Mutex<()>>,
}

pub struct SessionManager {
    inner: Arc<Inner>,
}

impl SessionManager {
    pub fn new(deps: SessionDeps) -> Arc<Self> {
        Arc::new(Self {
            inner: Arc::new(Inner {
                directory: deps.directory,
                cache: Mutex::new(deps.cache),
                lockouts: deps.lockouts,
                audit: deps.audit,
                snapshot_rx: deps.snapshot_rx,
                files_base: Mutex::new(deps.files_base),
                now_ms: deps.now_ms,
                clock_floor_ms: deps.clock_floor_ms,
                timeouts: deps.timeouts,
                session: Mutex::new(None),
                device_guard: Mutex::new(DeviceGuard::default()),
                gate: Arc::new(tokio::sync::Mutex::new(())),
            }),
        })
    }

    /// The Staff profile became known (or changed).
    pub fn set_files_base(&self, base: Option<PathBuf>) {
        *lock(&self.inner.files_base) = base;
    }

    /// Ends the employee's session: the Staff Windows session ended, a correct
    /// exit PIN, or the device was revoked. `reason` is only for the log.
    pub fn clear(&self, reason: &'static str) {
        let had = lock(&self.inner.session).take().is_some();
        if had {
            tracing::info!(reason, "employee session cleared");
        }
    }

    /// Unenrollment: ends the session and forgets every cached employee (the offline
    /// sign-in cache belongs to the organization the PC is leaving).
    pub fn forget_employees(&self) {
        self.clear("unenrolled");
        if let Err(error) = lock(&self.inner.cache).clear() {
            tracing::error!("cannot delete the employee cache: {error}");
        }
    }

    /// The normalized login name of the signed-in employee.
    pub fn current_username(&self) -> Option<String> {
        lock(&self.inner.session).as_ref().map(|s| s.username.clone())
    }

    /// The signed-in employee's display name (for `rulebox-agent status`).
    pub fn current_display_name(&self) -> Option<String> {
        lock(&self.inner.session).as_ref().map(|s| s.employee.name.clone())
    }
}

impl ShellExtension for SessionManager {
    fn capabilities(&self) -> Vec<&'static str> {
        if self.inner.directory.available() {
            vec![CAP_SESSION, CAP_APPS]
        } else {
            Vec::new()
        }
    }

    fn handle(
        &self,
        _peer: &PeerCtx,
        method: &str,
        params: serde_json::Value,
    ) -> Option<BoxFuture<'static, RpcResult>> {
        // Without the capability the methods do not exist: `unknown_method`.
        if !self.inner.directory.available() {
            return None;
        }
        let inner = Arc::clone(&self.inner);
        match method {
            SessionSignIn::NAME => Some(
                async move {
                    let params: SignInParams = parse_params(params)?;
                    to_value(sign_in(&inner, params).await?)
                }
                .boxed(),
            ),
            SessionVerifyPassword::NAME => Some(
                async move {
                    let params: VerifyPasswordParams = parse_params(params)?;
                    to_value(verify_password(&inner, params).await?)
                }
                .boxed(),
            ),
            SessionSignOut::NAME => Some(
                async move {
                    // No session is still a success.
                    if lock(&inner.session).take().is_some() {
                        tracing::info!("employee signed out");
                    }
                    to_value(Empty {})
                }
                .boxed(),
            ),
            SessionGet::NAME => Some(
                async move {
                    let result = match lock(&inner.session).as_ref() {
                        Some(active) => SessionGetResult {
                            employee: Some(active.employee.clone()),
                            files_root: Some(active.files_root.clone()),
                            offline: active.offline,
                        },
                        None => SessionGetResult { employee: None, files_root: None, offline: false },
                    };
                    to_value(result)
                }
                .boxed(),
            ),
            AppsList::NAME => Some(
                async move {
                    let apps = match lock(&inner.session).as_ref() {
                        Some(active) => active.apps.clone(),
                        None => return Err(not_signed_in()),
                    };
                    to_value(AppsListResult { apps: sanitize_apps(apps) })
                }
                .boxed(),
            ),
            _ => None,
        }
    }
}

// -- errors and small helpers ----------------------------------------------------

fn parse_params<T: serde::de::DeserializeOwned>(params: serde_json::Value) -> Result<T, RpcError> {
    // The serde error text is not passed on: it can quote the value (a password).
    serde_json::from_value(params)
        .map_err(|_| rpc_error(ErrorCode::InvalidParams, "The parameters are not valid.", false))
}

fn to_value<T: serde::Serialize>(value: T) -> RpcResult {
    serde_json::to_value(value).map_err(|_| internal())
}

fn internal() -> RpcError {
    rpc_error(ErrorCode::Internal, "Internal error.", true)
}

fn not_signed_in() -> RpcError {
    rpc_error(ErrorCode::NotSignedIn, "No employee is signed in.", false)
}

fn busy() -> RpcError {
    rpc_error(ErrorCode::Busy, "Another sign-in check is running.", true)
}

fn timeout_error() -> RpcError {
    rpc_error(ErrorCode::Timeout, "The check took too long.", true)
}

fn invalid_params() -> RpcError {
    rpc_error(ErrorCode::InvalidParams, "The parameters are not valid.", false)
}

fn denied(message: &str) -> RpcError {
    rpc_error(ErrorCode::DeniedByPolicy, message, false)
}

/// Section 5.9, step 2: trim, then Unicode lowercase; 1 to 64 characters.
fn normalize_username(raw: &str) -> Result<String, RpcError> {
    let username = raw.trim().to_lowercase();
    let chars = username.chars().count();
    if chars == 0 || chars > MAX_USERNAME_CHARS {
        return Err(invalid_params());
    }
    Ok(username)
}

fn check_password_length(password: &str) -> Result<(), RpcError> {
    let chars = password.chars().count();
    if chars == 0 || chars > MAX_PASSWORD_CHARS {
        return Err(invalid_params());
    }
    Ok(())
}

fn outcome_only(outcome: SignInOutcome) -> SignInResult {
    SignInResult { outcome, employee: None, files_root: None, offline: false, retry_after_ms: None }
}

fn locked_out(retry_after_ms: u64) -> SignInResult {
    SignInResult { retry_after_ms: Some(retry_after_ms), ..outcome_only(SignInOutcome::LockedOut) }
}

/// The folder name under the files base: the employee id when it is a plain
/// `[A-Za-z0-9_-]{1,64}` name that Windows does not treat as a device, otherwise
/// the first 32 hex characters of its SHA-256. The result is always a single safe
/// path component.
pub fn files_folder_name(employee_id: &str) -> String {
    let plain = (1..=64).contains(&employee_id.len())
        && employee_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        && !is_reserved_device_name(employee_id);
    if plain {
        return employee_id.to_string();
    }
    let digest = Sha256::digest(employee_id.as_bytes());
    let mut name = String::with_capacity(32);
    for byte in digest.iter().take(16) {
        name.push_str(&format!("{byte:02x}"));
    }
    name
}

/// `CON`, `PRN`, `AUX`, `NUL`, `COM1`..`COM9`, `LPT1`..`LPT9` (any case) name
/// devices, not files.
fn is_reserved_device_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.len() == 4
            && upper.as_bytes()[3].is_ascii_digit()
            && upper.as_bytes()[3] != b'0')
}

/// Section 5.9, "`apps.list`": an icon above 32 KiB decoded becomes null; if the
/// result is still above 900,000 bytes every icon goes, so the reply always fits
/// one frame.
fn sanitize_apps(mut apps: Vec<AppEntry>) -> Vec<AppEntry> {
    for app in &mut apps {
        if app.icon_png_base64.as_ref().is_some_and(|icon| icon.len() > MAX_ICON_BASE64_CHARS) {
            app.icon_png_base64 = None;
        }
    }
    let size = serde_json::to_vec(&AppsListResult { apps: apps.clone() }).map_or(usize::MAX, |bytes| bytes.len());
    if size > MAX_APPS_RESULT_BYTES {
        tracing::warn!(bytes = size, "the app catalogue is too large for one frame; sending it without icons");
        for app in &mut apps {
            app.icon_png_base64 = None;
        }
    }
    apps
}

// -- the shared parts of sign-in and password check ---------------------------------

impl Inner {
    fn enrollment(&self) -> EnrollmentStatus {
        self.snapshot_rx.borrow().enrollment
    }

    fn online(&self) -> bool {
        self.snapshot_rx.borrow().connection == ConnectionStatus::Online
    }

    fn files_base(&self) -> Option<PathBuf> {
        lock(&self.files_base).clone()
    }

    fn other_employee_signed_in(&self, username: &str) -> bool {
        lock(&self.session).as_ref().is_some_and(|active| active.username != username)
    }

    /// Steps 5 of Section 5.9: the device-wide guard and this username's counter.
    /// `Some(retry_after_ms)` when either one is locked (the password is then not
    /// checked and nothing is counted).
    fn locked_for(&self, username: &str, now_ms: u64) -> Option<u64> {
        let from_guard = lock(&self.device_guard).check(now_ms);
        let mut store = lock(&self.lockouts);
        let counter = store.employee(username);
        let before = counter.clone();
        let gate = counter.gate(&PASSWORD_POLICY, now_ms);
        let changed = *counter != before;
        let from_counter = match gate {
            Gate::Locked { retry_after_ms } => Some(retry_after_ms),
            Gate::Open { .. } => None,
        };
        if changed {
            // The clock rule moved a lock, or the forget rule cleared the counter.
            if let Err(error) = store.save(now_ms) {
                tracing::error!("cannot save lockouts.json: {error}");
            }
        }
        match (from_guard, from_counter) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or(0).max(b.unwrap_or(0))),
        }
    }

    /// Step 6: count the failure and save **before** checking anything, so killing
    /// the agent in the middle of a check never gives a free guess. `Err` (and the
    /// count undone) when the file cannot be written: the check fails closed.
    fn count_first(&self, username: &str, now_ms: u64) -> Result<Gate, RpcError> {
        let mut store = lock(&self.lockouts);
        let gate = store.employee(username).record_failure(&PASSWORD_POLICY, now_ms);
        if let Err(error) = store.save(now_ms) {
            tracing::error!("cannot save lockouts.json, so no password is checked: {error}");
            store.employee(username).undo_failure();
            return Err(internal());
        }
        Ok(gate)
    }

    /// Takes back the counted failure: the attempt turned out not to be a guess.
    fn undo(&self, username: &str) {
        let now_ms = (self.now_ms)();
        let mut store = lock(&self.lockouts);
        store.employee(username).undo_failure();
        if let Err(error) = store.save(now_ms) {
            tracing::error!("cannot save lockouts.json: {error}");
        }
    }

    /// A correct password clears the counter.
    fn clear_counter(&self, username: &str) {
        let now_ms = (self.now_ms)();
        let mut store = lock(&self.lockouts);
        store.employee(username).clear();
        if let Err(error) = store.save(now_ms) {
            tracing::error!("cannot save lockouts.json: {error}");
        }
    }

    /// The failure stays counted: tell the device-wide guard, and write the one
    /// audit record when the counted failure started a lock. Returns the retry time
    /// when the answer is `lockedOut`.
    fn failure_stays(&self, username: &str, after_count: Gate, now_ms: u64) -> Option<u64> {
        lock(&self.device_guard).record_failure(now_ms);
        match after_count {
            Gate::Locked { retry_after_ms } => {
                self.audit.record(
                    AuditKind::EmployeeLockedOut,
                    Some(username.to_string()),
                    Some("password_lockout".to_string()),
                );
                tracing::warn!(username, retry_after_ms, "employee locked out after wrong passwords");
                Some(retry_after_ms)
            }
            Gate::Open { .. } => None,
        }
    }
}

/// Tracks whether a counted failure is still pending, so a request that is
/// dropped by the time budget can undo it.
#[derive(Default)]
struct Attempt {
    counted: bool,
}

enum Verified {
    Match,
    NoMatch,
    /// The stored hash is not a valid Argon2id hash.
    BadHash,
}

async fn argon2_verify(password: String, hash: String) -> Result<Verified, RpcError> {
    let joined = tokio::task::spawn_blocking(move || kdf::verify_secret(&password, &hash)).await;
    match joined {
        Ok(Ok(true)) => Ok(Verified::Match),
        Ok(Ok(false)) => Ok(Verified::NoMatch),
        Ok(Err(kdf::KdfError::Invalid(_))) => Ok(Verified::BadHash),
        Ok(Err(kdf::KdfError::Internal(error))) => {
            tracing::error!("password check failed: {error}");
            Err(internal())
        }
        Err(_) => Err(internal()),
    }
}

async fn argon2_hash(password: String) -> Result<String, RpcError> {
    match tokio::task::spawn_blocking(move || kdf::hash_secret(&password)).await {
        Ok(Ok(hash)) => Ok(hash),
        Ok(Err(error)) => {
            tracing::error!("password hashing failed: {error}");
            Err(internal())
        }
        Err(_) => Err(internal()),
    }
}

// -- session.signIn --------------------------------------------------------------

async fn sign_in(inner: &Arc<Inner>, params: SignInParams) -> Result<SignInResult, RpcError> {
    // 1. Not enrolled, or revoked.
    match inner.enrollment() {
        EnrollmentStatus::Enrolled => {}
        EnrollmentStatus::Revoked => return Err(denied("This PC's enrollment was revoked.")),
        EnrollmentStatus::NotEnrolled | EnrollmentStatus::Unknown => {
            return Err(rpc_error(ErrorCode::NotEnrolled, "This PC is not enrolled.", false));
        }
    }
    // 2. Normalize and bound the input.
    let username = normalize_username(&params.username)?;
    check_password_length(&params.password)?;
    // 3. Another employee is signed in. The same username may replace its session.
    if inner.other_employee_signed_in(&username) {
        return Err(denied("Another employee is signed in."));
    }
    // The files base must be known before anything is counted.
    let Some(files_base) = inner.files_base() else {
        return Err(rpc_error(ErrorCode::Internal, "The Staff account is not set up yet.", true));
    };
    // 4. One check at a time.
    let Ok(_gate) = Arc::clone(&inner.gate).try_lock_owned() else {
        return Err(busy());
    };
    // Another sign-in may have finished between step 3 and the gate.
    if inner.other_employee_signed_in(&username) {
        return Err(denied("Another employee is signed in."));
    }

    // 5 to 8, inside the request's time budget (step 9).
    let mut attempt = Attempt::default();
    let checked = tokio::time::timeout(
        inner.timeouts.budget,
        sign_in_checked(inner, &username, params.password, &files_base, &mut attempt),
    )
    .await;
    match checked {
        Ok(result) => result,
        Err(_) => {
            if attempt.counted {
                inner.undo(&username);
            }
            tracing::warn!(username = %username, "sign-in check exceeded its time budget");
            Err(timeout_error())
        }
    }
}

/// Steps 5 to 8. `attempt.counted` is true from step 6 until the failure is
/// undone, cleared or kept.
async fn sign_in_checked(
    inner: &Arc<Inner>,
    username: &str,
    password: String,
    files_base: &std::path::Path,
    attempt: &mut Attempt,
) -> Result<SignInResult, RpcError> {
    let now_ms = (inner.now_ms)();
    // 5. Locked: the password is not checked.
    if let Some(retry_after_ms) = inner.locked_for(username, now_ms) {
        return Ok(locked_out(retry_after_ms));
    }
    // 6. Count first.
    let after_count = inner.count_first(username, now_ms)?;
    attempt.counted = true;

    // 7. Online path.
    if inner.online() {
        let asked = tokio::time::timeout(
            inner.timeouts.directory,
            inner.directory.verify(username, &password),
        )
        .await;
        match asked {
            Ok(Ok(DirectoryAnswer::Ok(found))) => {
                let hash = match argon2_hash(password).await {
                    Ok(hash) => hash,
                    Err(error) => {
                        inner.undo(username);
                        attempt.counted = false;
                        return Err(error);
                    }
                };
                inner.clear_counter(username);
                attempt.counted = false;
                let entry = CacheEntry {
                    username: username.to_string(),
                    employee: found.employee.clone(),
                    apps: found.apps.clone(),
                    password_hash: hash.clone(),
                    offline_days: found.offline_days,
                    last_online_ms: (inner.now_ms)(),
                };
                if let Err(error) = lock(&inner.cache).put(entry) {
                    // The sign-in itself succeeded; only offline sign-in suffers.
                    tracing::error!("cannot save employee-cache.json: {error}");
                }
                return Ok(start_session(inner, username, found.employee, found.apps, hash, false, files_base));
            }
            Ok(Ok(DirectoryAnswer::WrongCredentials)) => {
                // The offline cache is not tried: the password may have changed.
                attempt.counted = false;
                return Ok(wrong_credentials(inner, username, after_count, now_ms));
            }
            Ok(Ok(DirectoryAnswer::Disabled)) => {
                if let Err(error) = lock(&inner.cache).remove(username) {
                    tracing::error!("cannot save employee-cache.json: {error}");
                }
                inner.undo(username);
                attempt.counted = false;
                return Ok(outcome_only(SignInOutcome::Disabled));
            }
            Ok(Ok(DirectoryAnswer::LockedOut { retry_after_ms })) => {
                inner.undo(username);
                attempt.counted = false;
                return Ok(locked_out(retry_after_ms));
            }
            // Unreachable, unavailable or too slow: the offline path.
            Ok(Err(_)) | Err(_) => {}
        }
    }

    // 8. Offline path.
    let entry = lock(&inner.cache).get(username).cloned();
    let Some(entry) = entry else {
        inner.undo(username);
        attempt.counted = false;
        return Ok(outcome_only(SignInOutcome::OfflineNeverSignedIn));
    };
    if is_expired(&entry, (inner.now_ms)(), (inner.clock_floor_ms)()) {
        inner.undo(username);
        attempt.counted = false;
        return Ok(outcome_only(SignInOutcome::OfflineExpired));
    }
    match argon2_verify(password, entry.password_hash.clone()).await? {
        Verified::Match => {
            inner.clear_counter(username);
            attempt.counted = false;
            Ok(start_session(
                inner,
                username,
                entry.employee,
                entry.apps,
                entry.password_hash,
                true,
                files_base,
            ))
        }
        Verified::NoMatch => {
            attempt.counted = false;
            Ok(wrong_credentials(inner, username, after_count, (inner.now_ms)()))
        }
        Verified::BadHash => {
            // Not a guess: the entry is damaged. Forget it; the next online
            // sign-in writes a new one.
            tracing::error!(username, "the cached password hash is not valid; removing the entry");
            if let Err(error) = lock(&inner.cache).remove(username) {
                tracing::error!("cannot save employee-cache.json: {error}");
            }
            inner.undo(username);
            attempt.counted = false;
            Ok(outcome_only(SignInOutcome::OfflineNeverSignedIn))
        }
    }
}

fn wrong_credentials(inner: &Inner, username: &str, after_count: Gate, now_ms: u64) -> SignInResult {
    match inner.failure_stays(username, after_count, now_ms) {
        Some(retry_after_ms) => locked_out(retry_after_ms),
        None => outcome_only(SignInOutcome::WrongCredentials),
    }
}

fn start_session(
    inner: &Inner,
    username: &str,
    employee: Employee,
    apps: Vec<AppEntry>,
    password_hash: String,
    offline: bool,
    files_base: &std::path::Path,
) -> SignInResult {
    let files_root = files_base.join(files_folder_name(&employee.id)).to_string_lossy().into_owned();
    tracing::info!(username, offline, "employee signed in");
    let result = SignInResult {
        outcome: SignInOutcome::Ok,
        employee: Some(employee.clone()),
        files_root: Some(files_root.clone()),
        offline,
        retry_after_ms: None,
    };
    *lock(&inner.session) = Some(ActiveSession {
        username: username.to_string(),
        employee,
        apps,
        files_root,
        offline,
        password_hash,
    });
    result
}

// -- session.verifyPassword -------------------------------------------------------

async fn verify_password(
    inner: &Arc<Inner>,
    params: VerifyPasswordParams,
) -> Result<VerifyPasswordResult, RpcError> {
    check_password_length(&params.password)?;
    let current = lock(&inner.session)
        .as_ref()
        .map(|active| (active.username.clone(), active.password_hash.clone()));
    let Some((username, hash)) = current else {
        return Err(not_signed_in());
    };
    // Steps 4 to 6, then one Argon2id check against the employee's own hash. It
    // never calls the directory, so it works offline and is fast.
    let Ok(_gate) = Arc::clone(&inner.gate).try_lock_owned() else {
        return Err(busy());
    };
    let mut attempt = Attempt::default();
    let checked = tokio::time::timeout(
        inner.timeouts.budget,
        verify_checked(inner, &username, params.password, hash, &mut attempt),
    )
    .await;
    match checked {
        Ok(result) => result,
        Err(_) => {
            if attempt.counted {
                inner.undo(&username);
            }
            Err(timeout_error())
        }
    }
}

async fn verify_checked(
    inner: &Arc<Inner>,
    username: &str,
    password: String,
    hash: String,
    attempt: &mut Attempt,
) -> Result<VerifyPasswordResult, RpcError> {
    let outcome = |outcome, retry_after_ms| VerifyPasswordResult { outcome, retry_after_ms };
    let now_ms = (inner.now_ms)();
    if let Some(retry_after_ms) = inner.locked_for(username, now_ms) {
        return Ok(outcome(VerifyOutcome::LockedOut, Some(retry_after_ms)));
    }
    let after_count = inner.count_first(username, now_ms)?;
    attempt.counted = true;
    match argon2_verify(password, hash).await {
        Ok(Verified::Match) => {
            inner.clear_counter(username);
            attempt.counted = false;
            Ok(outcome(VerifyOutcome::Ok, None))
        }
        Ok(Verified::NoMatch) => {
            attempt.counted = false;
            match inner.failure_stays(username, after_count, (inner.now_ms)()) {
                Some(retry_after_ms) => Ok(outcome(VerifyOutcome::LockedOut, Some(retry_after_ms))),
                None => Ok(outcome(VerifyOutcome::WrongCredentials, None)),
            }
        }
        // The session's own hash is damaged: not a guess, and not the caller's fault.
        Ok(Verified::BadHash) => {
            inner.undo(username);
            attempt.counted = false;
            Err(internal())
        }
        Err(error) => {
            inner.undo(username);
            attempt.counted = false;
            Err(error)
        }
    }
}

// -- tests ------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    use rulebox_ipc::types::ClientRole;
    use serde_json::json;
    use tokio::sync::Notify;

    use crate::audit::{AuditQueue, AuditRecord};
    use crate::directory::{DirectoryEmployee, DirectoryError, FixtureDirectory, UnavailableDirectory};
    use crate::fixtures;
    use crate::testutil::{test_snapshot, TempDir};

    /// What the test directory does with the next check.
    #[derive(Clone)]
    enum Mode {
        /// The fixture answers (maya, sam, alex; password `demo`).
        Fixture,
        Unreachable,
        /// Never answers.
        Never,
        /// Waits until released, then answers like the fixture.
        Hold(Arc<Notify>),
        /// Always this answer.
        Answer(DirectoryAnswer),
    }

    struct TestDirectory {
        mode: Mutex<Mode>,
        calls: AtomicUsize,
        fixture: FixtureDirectory,
    }

    impl TestDirectory {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                mode: Mutex::new(Mode::Fixture),
                calls: AtomicUsize::new(0),
                fixture: FixtureDirectory::new(false),
            })
        }

        fn set(&self, mode: Mode) {
            *lock(&self.mode) = mode;
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl EmployeeDirectory for TestDirectory {
        fn available(&self) -> bool {
            true
        }

        fn verify<'a>(
            &'a self,
            username: &'a str,
            password: &'a str,
        ) -> BoxFuture<'a, Result<DirectoryAnswer, DirectoryError>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mode = lock(&self.mode).clone();
            async move {
                match mode {
                    Mode::Fixture => self.fixture.verify(username, password).await,
                    Mode::Unreachable => Err(DirectoryError::Unreachable),
                    Mode::Never => std::future::pending().await,
                    Mode::Hold(release) => {
                        release.notified().await;
                        self.fixture.verify(username, password).await
                    }
                    Mode::Answer(answer) => Ok(answer),
                }
            }
            .boxed()
        }
    }

    const START_MS: u64 = 1_700_000_000_000;
    const DAY_MS: u64 = 86_400_000;

    struct Harness {
        dir: TempDir,
        manager: Arc<SessionManager>,
        directory: Arc<TestDirectory>,
        clock: Arc<AtomicU64>,
        floor: Arc<AtomicU64>,
        snapshot_tx: watch::Sender<AgentSnapshot>,
        lockouts: Arc<Mutex<LockoutStore>>,
        audit: Arc<AuditHandle>,
    }

    struct Options {
        timeouts: SessionTimeouts,
        enrollment: EnrollmentStatus,
        files_base: bool,
        /// Written to the cache before the manager opens it.
        cached: Vec<CacheEntry>,
    }

    impl Default for Options {
        fn default() -> Self {
            Self {
                timeouts: SessionTimeouts::default(),
                enrollment: EnrollmentStatus::Enrolled,
                files_base: true,
                cached: Vec::new(),
            }
        }
    }

    fn harness() -> Harness {
        harness_with(Options::default())
    }

    fn harness_with(options: Options) -> Harness {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        std::fs::create_dir_all(&state).unwrap();
        let mut snapshot = test_snapshot();
        snapshot.enrollment = options.enrollment;
        snapshot.connection = ConnectionStatus::Online;
        let (snapshot_tx, snapshot_rx) = watch::channel(snapshot);

        let clock = Arc::new(AtomicU64::new(START_MS));
        let floor = Arc::new(AtomicU64::new(0));
        let now: Arc<dyn Fn() -> u64 + Send + Sync> = {
            let clock = Arc::clone(&clock);
            Arc::new(move || clock.load(Ordering::SeqCst))
        };
        let clock_floor: Arc<dyn Fn() -> u64 + Send + Sync> = {
            let floor = Arc::clone(&floor);
            Arc::new(move || floor.load(Ordering::SeqCst))
        };

        let mut cache = EmployeeCache::open(state.join("employee-cache.json")).unwrap();
        for entry in options.cached {
            cache.put(entry).unwrap();
        }
        let lockouts = Arc::new(Mutex::new(LockoutStore::open(state.join("lockouts.json")).unwrap()));
        let audit = AuditHandle::new(
            AuditQueue::open(state.join("audit-queue.json")).unwrap(),
            snapshot_rx.clone(),
            Arc::clone(&now),
        );
        let directory = TestDirectory::new();
        let manager = SessionManager::new(SessionDeps {
            directory: Arc::clone(&directory) as Arc<dyn EmployeeDirectory>,
            cache,
            lockouts: Arc::clone(&lockouts),
            audit: Arc::clone(&audit),
            snapshot_rx,
            files_base: options.files_base.then(|| dir.path().join("files")),
            now_ms: now,
            clock_floor_ms: clock_floor,
            timeouts: options.timeouts,
        });
        Harness { dir, manager, directory, clock, floor, snapshot_tx, lockouts, audit }
    }

    impl Harness {
        fn peer() -> PeerCtx {
            PeerCtx { connection_id: 1, pid: 1, session_id: 1, role: ClientRole::Shell }
        }

        async fn call(&self, method: &str, params: serde_json::Value) -> RpcResult {
            let future = self
                .manager
                .handle(&Self::peer(), method, params)
                .unwrap_or_else(|| panic!("{method} is not handled"));
            future.await
        }

        async fn sign_in(&self, username: &str, password: &str) -> Result<SignInResult, RpcError> {
            let value = self
                .call(SessionSignIn::NAME, json!({ "username": username, "password": password }))
                .await?;
            Ok(serde_json::from_value(value).unwrap())
        }

        async fn verify(&self, password: &str) -> Result<VerifyPasswordResult, RpcError> {
            let value = self.call(SessionVerifyPassword::NAME, json!({ "password": password })).await?;
            Ok(serde_json::from_value(value).unwrap())
        }

        async fn sign_out(&self) {
            self.call(SessionSignOut::NAME, json!({})).await.unwrap();
        }

        async fn session_get(&self) -> SessionGetResult {
            serde_json::from_value(self.call(SessionGet::NAME, json!({})).await.unwrap()).unwrap()
        }

        async fn apps(&self) -> Result<AppsListResult, RpcError> {
            let value = self.call(AppsList::NAME, json!({})).await?;
            Ok(serde_json::from_value(value).unwrap())
        }

        fn set_online(&self, online: bool) {
            self.snapshot_tx.send_modify(|s| {
                s.connection = if online { ConnectionStatus::Online } else { ConnectionStatus::Offline };
            });
        }

        fn advance(&self, ms: u64) {
            self.clock.fetch_add(ms, Ordering::SeqCst);
        }

        fn state_path(&self, name: &str) -> PathBuf {
            self.dir.path().join("state").join(name)
        }

        fn cache_on_disk(&self) -> EmployeeCache {
            EmployeeCache::open(self.state_path("employee-cache.json")).unwrap()
        }

        fn failures(&self, username: &str) -> u32 {
            lock(&self.lockouts).employee(username).failures
        }

        fn audit_records(&self) -> Vec<AuditRecord> {
            self.audit.records()
        }
    }

    fn code_of(result: &Result<impl std::fmt::Debug, RpcError>) -> ErrorCode {
        match result {
            Err(error) => error.code,
            Ok(value) => panic!("expected an error, got {value:?}"),
        }
    }

    fn cached_entry(username: &str, offline_days: u32, last_online_ms: u64, password: &str) -> CacheEntry {
        let demo = fixtures::employees().into_iter().find(|e| e.username == username).unwrap();
        CacheEntry {
            username: username.to_string(),
            employee: demo.employee,
            apps: fixtures::catalogue(),
            password_hash: kdf::hash_secret(password).unwrap(),
            offline_days,
            last_online_ms,
        }
    }

    // -- tests 6 to 11 ----------------------------------------------------------------

    #[tokio::test]
    async fn online_sign_in_succeeds_and_caches_only_a_hash() {
        let h = harness();
        let result = h.sign_in("maya", "demo").await.unwrap();
        assert_eq!(result.outcome, SignInOutcome::Ok);
        assert!(!result.offline);
        assert_eq!(result.employee.as_ref().map(|e| e.name.as_str()), Some("Maya Chen"));
        let root = result.files_root.unwrap();
        assert!(root.ends_with(r"\emp_maya"), "{root}");
        assert!(root.starts_with(h.dir.path().join("files").to_str().unwrap()), "{root}");
        // The agent only names the folder; it does not create it.
        assert!(!h.dir.path().join("files").exists());

        let cache = h.cache_on_disk();
        let entry = cache.get("maya").expect("a cache entry");
        assert_eq!(entry.offline_days, 7);
        assert_eq!(entry.last_online_ms, START_MS);
        assert!(entry.password_hash.starts_with("$argon2id$"));
        let text = std::fs::read_to_string(h.state_path("employee-cache.json")).unwrap();
        assert!(!text.contains("demo"), "the plain password is on disk: {text}");
        assert_eq!(h.failures("maya"), 0);
    }

    #[tokio::test]
    async fn a_wrong_password_online_does_not_fall_back_to_the_cache() {
        // The cache holds the old password `demo`; the directory says it is wrong now.
        let h = harness_with(Options {
            cached: vec![cached_entry("maya", 7, START_MS, "demo")],
            ..Options::default()
        });
        h.directory.set(Mode::Answer(DirectoryAnswer::WrongCredentials));
        let result = h.sign_in("maya", "demo").await.unwrap();
        assert_eq!(result.outcome, SignInOutcome::WrongCredentials);
        assert!(result.employee.is_none());
        assert_eq!(h.failures("maya"), 1);
        assert_eq!(h.session_get().await.employee, None);
    }

    #[tokio::test]
    async fn offline_sign_in_uses_the_cache() {
        let h = harness();
        h.sign_in("maya", "demo").await.unwrap();
        h.sign_out().await;
        h.set_online(false);
        let calls = h.directory.calls();

        let result = h.sign_in("maya", "demo").await.unwrap();
        assert_eq!(result.outcome, SignInOutcome::Ok);
        assert!(result.offline);
        assert!(h.session_get().await.offline);
        assert_eq!(h.directory.calls(), calls, "the directory is not asked while offline");

        // A wrong password offline is a counted failure like any other.
        h.sign_out().await;
        let wrong = h.sign_in("maya", "nope").await.unwrap();
        assert_eq!(wrong.outcome, SignInOutcome::WrongCredentials);
        assert_eq!(h.failures("maya"), 1);
    }

    #[tokio::test]
    async fn offline_outcomes_for_unknown_zero_day_and_expired_entries() {
        let h = harness();
        h.sign_in("maya", "demo").await.unwrap();
        h.sign_out().await;
        h.sign_in("sam", "demo").await.unwrap();
        h.sign_out().await;
        h.set_online(false);

        // Never signed in on this PC.
        let unknown = h.sign_in("alex", "demo").await.unwrap();
        assert_eq!(unknown.outcome, SignInOutcome::OfflineNeverSignedIn);
        // sam has 0 offline days: always expired.
        let sam = h.sign_in("sam", "demo").await.unwrap();
        assert_eq!(sam.outcome, SignInOutcome::OfflineExpired);
        // None of these were guesses.
        assert_eq!((h.failures("alex"), h.failures("sam")), (0, 0));

        // maya: fine after 7 days, expired after 8.
        h.advance(7 * DAY_MS);
        assert_eq!(h.sign_in("maya", "demo").await.unwrap().outcome, SignInOutcome::Ok);
        h.sign_out().await;
        h.advance(DAY_MS);
        assert_eq!(h.sign_in("maya", "demo").await.unwrap().outcome, SignInOutcome::OfflineExpired);

        // The local clock is set back 30 days; the agent remembers the later time.
        h.floor.store(h.clock.load(Ordering::SeqCst), Ordering::SeqCst);
        h.clock.fetch_sub(30 * DAY_MS, Ordering::SeqCst);
        assert_eq!(h.sign_in("maya", "demo").await.unwrap().outcome, SignInOutcome::OfflineExpired);
    }

    #[tokio::test]
    async fn an_unreachable_directory_falls_to_the_offline_path() {
        let h = harness();
        h.sign_in("maya", "demo").await.unwrap();
        h.sign_out().await;
        h.directory.set(Mode::Unreachable);
        let result = h.sign_in("maya", "demo").await.unwrap();
        assert_eq!(result.outcome, SignInOutcome::Ok);
        assert!(result.offline, "online connection, but the directory could not be reached");
    }

    #[tokio::test]
    async fn a_disabled_employee_is_refused_and_the_cache_entry_is_removed() {
        let h = harness_with(Options {
            cached: vec![cached_entry("alex", 7, START_MS, "demo")],
            ..Options::default()
        });
        assert!(h.cache_on_disk().get("alex").is_some());
        let result = h.sign_in("alex", "demo").await.unwrap();
        assert_eq!(result.outcome, SignInOutcome::Disabled);
        assert!(h.cache_on_disk().get("alex").is_none());
        assert_eq!(h.failures("alex"), 0, "the counted failure was undone");
    }

    #[tokio::test]
    async fn five_wrong_passwords_lock_for_thirty_seconds_and_a_correct_one_clears() {
        let h = harness();
        for _ in 0..4 {
            assert_eq!(h.sign_in("maya", "bad").await.unwrap().outcome, SignInOutcome::WrongCredentials);
        }
        let fifth = h.sign_in("maya", "bad").await.unwrap();
        assert_eq!(fifth.outcome, SignInOutcome::LockedOut);
        assert_eq!(fifth.retry_after_ms, Some(30_000));

        // During the lock even the right password is not checked.
        h.advance(10_000);
        let calls = h.directory.calls();
        let during = h.sign_in("maya", "demo").await.unwrap();
        assert_eq!(during.outcome, SignInOutcome::LockedOut);
        assert_eq!(during.retry_after_ms, Some(20_000));
        assert_eq!(h.directory.calls(), calls);

        // After the lock the right password works and the counter is cleared.
        h.advance(20_001);
        let ok = h.sign_in("maya", "demo").await.unwrap();
        assert_eq!(ok.outcome, SignInOutcome::Ok);
        assert_eq!(h.failures("maya"), 0);
    }

    #[tokio::test]
    async fn a_lock_that_starts_writes_exactly_one_audit_record() {
        let h = harness();
        for _ in 0..5 {
            h.sign_in("maya", "bad").await.unwrap();
        }
        // Attempts during the lock do not write more.
        h.sign_in("maya", "bad").await.unwrap();
        h.sign_in("maya", "bad").await.unwrap();
        let records = h.audit_records();
        assert_eq!(records.len(), 1, "{records:?}");
        assert_eq!(records[0].kind, AuditKind::EmployeeLockedOut);
        assert_eq!(records[0].username.as_deref(), Some("maya"));
        assert_eq!(records[0].detail.as_deref(), Some("password_lockout"));
        let text = serde_json::to_string(&records).unwrap();
        assert!(!text.contains("\"bad\""), "{text}");

        // The 6th failure after the lock ends starts a second, longer lock: a second record.
        h.advance(30_001);
        let sixth = h.sign_in("maya", "bad").await.unwrap();
        assert_eq!((sixth.outcome, sixth.retry_after_ms), (SignInOutcome::LockedOut, Some(60_000)));
        assert_eq!(h.audit_records().len(), 2);
    }

    #[tokio::test]
    async fn a_correct_password_on_the_locking_attempt_clears_instead_of_locking() {
        let h = harness();
        for _ in 0..4 {
            h.sign_in("maya", "bad").await.unwrap();
        }
        // The 5th attempt would lock if wrong; it is right.
        assert_eq!(h.sign_in("maya", "demo").await.unwrap().outcome, SignInOutcome::Ok);
        assert_eq!(h.failures("maya"), 0);
        assert!(h.audit_records().is_empty());
    }

    #[tokio::test]
    async fn the_device_wide_guard_blocks_many_usernames() {
        let h = harness();
        for n in 0..21 {
            let result = h.sign_in(&format!("guess{n}"), "bad").await.unwrap();
            assert_eq!(result.outcome, SignInOutcome::WrongCredentials, "attempt {n}");
        }
        // The 22nd request, for yet another username, is answered locked out.
        let blocked = h.sign_in("another", "bad").await.unwrap();
        assert_eq!(blocked.outcome, SignInOutcome::LockedOut);
        assert!(blocked.retry_after_ms.is_some_and(|ms| ms > 0 && ms <= 600_000));
        // Even maya with the right password.
        assert_eq!(h.sign_in("maya", "demo").await.unwrap().outcome, SignInOutcome::LockedOut);
        // Ten minutes after the oldest failure it opens again.
        h.advance(600_000);
        assert_eq!(h.sign_in("maya", "demo").await.unwrap().outcome, SignInOutcome::Ok);
    }

    // -- tests 12 and 13 --------------------------------------------------------------

    #[tokio::test]
    async fn the_failure_is_on_disk_before_the_password_is_checked() {
        let h = harness();
        let release = Arc::new(Notify::new());
        h.directory.set(Mode::Hold(Arc::clone(&release)));
        let manager = Arc::clone(&h.manager);
        let pending = tokio::spawn(async move {
            let future = manager
                .handle(&Harness::peer(), SessionSignIn::NAME, json!({ "username": "maya", "password": "bad" }))
                .unwrap();
            future.await
        });
        // Wait until the directory is being asked: the check is in flight.
        for _ in 0..200 {
            if h.directory.calls() > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(h.directory.calls(), 1);
        let on_disk = std::fs::read_to_string(h.state_path("lockouts.json")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&on_disk).unwrap();
        assert_eq!(parsed["employees"]["maya"]["failures"], 1, "{on_disk}");

        // While it is in flight, a second request is busy (test 13).
        let second = h.sign_in("maya", "bad").await;
        assert_eq!(code_of(&second), ErrorCode::Busy);
        assert!(second.unwrap_err().retryable);
        // (There is no session yet, so verifyPassword fails before it reaches the gate.)
        assert_eq!(code_of(&h.verify("demo").await), ErrorCode::NotSignedIn);

        release.notify_one();
        let first = pending.await.unwrap().unwrap();
        assert_eq!(first["outcome"], "wrongCredentials");
        // And now it is free again.
        h.directory.set(Mode::Fixture);
        assert_eq!(h.sign_in("maya", "demo").await.unwrap().outcome, SignInOutcome::Ok);
    }

    #[tokio::test(start_paused = true)]
    async fn the_time_budget_undoes_the_counted_failure() {
        let h = harness_with(Options {
            // The directory timeout is longer than the budget, so the budget fires.
            timeouts: SessionTimeouts { directory: Duration::from_secs(60), budget: Duration::from_secs(8) },
            ..Options::default()
        });
        h.directory.set(Mode::Never);
        let before = h.failures("maya");
        let result = h.sign_in("maya", "demo").await;
        let error = result.unwrap_err();
        assert_eq!(error.code, ErrorCode::Timeout);
        assert!(error.retryable);
        assert_eq!(h.failures("maya"), before, "the counter is back to its old value");
        let on_disk = std::fs::read_to_string(h.state_path("lockouts.json")).unwrap();
        assert!(!on_disk.contains("\"failures\": 1"), "{on_disk}");
        // The gate was released: the next sign-in works.
        h.directory.set(Mode::Fixture);
        assert_eq!(h.sign_in("maya", "demo").await.unwrap().outcome, SignInOutcome::Ok);
    }

    #[tokio::test(start_paused = true)]
    async fn a_directory_that_is_too_slow_falls_back_within_the_budget() {
        // Default timeouts: the directory gets 6 s, then the offline path runs.
        let h = harness_with(Options {
            cached: vec![cached_entry("maya", 7, START_MS, "demo")],
            ..Options::default()
        });
        h.directory.set(Mode::Never);
        let result = h.sign_in("maya", "demo").await.unwrap();
        assert_eq!(result.outcome, SignInOutcome::Ok);
        assert!(result.offline);
    }

    // -- test 14 to 18 ----------------------------------------------------------------

    #[tokio::test]
    async fn another_employee_cannot_sign_in_but_the_same_one_may_again() {
        let h = harness();
        h.sign_in("maya", "demo").await.unwrap();
        let sam = h.sign_in("sam", "demo").await;
        assert_eq!(code_of(&sam), ErrorCode::DeniedByPolicy);
        assert_eq!(h.failures("sam"), 0, "nothing was counted");
        // Same username (any case, with spaces): allowed, replaces the session.
        assert_eq!(h.sign_in("  MAYA ", "demo").await.unwrap().outcome, SignInOutcome::Ok);
        assert_eq!(h.manager.current_username().as_deref(), Some("maya"));
        assert_eq!(h.manager.current_display_name().as_deref(), Some("Maya Chen"));
    }

    #[tokio::test]
    async fn verify_password_checks_the_session_hash_without_the_directory() {
        let h = harness();
        assert_eq!(code_of(&h.verify("demo").await), ErrorCode::NotSignedIn);

        h.sign_in("maya", "demo").await.unwrap();
        let calls = h.directory.calls();
        let ok = h.verify("demo").await.unwrap();
        assert_eq!((ok.outcome, ok.retry_after_ms), (VerifyOutcome::Ok, None));
        for _ in 0..4 {
            assert_eq!(h.verify("bad").await.unwrap().outcome, VerifyOutcome::WrongCredentials);
        }
        let locked = h.verify("bad").await.unwrap();
        assert_eq!(locked.outcome, VerifyOutcome::LockedOut);
        assert_eq!(locked.retry_after_ms, Some(30_000));
        // The right password is also refused during the lock.
        assert_eq!(h.verify("demo").await.unwrap().outcome, VerifyOutcome::LockedOut);
        assert_eq!(h.directory.calls(), calls, "verifyPassword never calls the directory");
        assert_eq!(h.audit_records().len(), 1);

        // It also works offline.
        h.set_online(false);
        h.advance(30_001);
        assert_eq!(h.verify("demo").await.unwrap().outcome, VerifyOutcome::Ok);
    }

    #[tokio::test]
    async fn apps_list_needs_a_session_and_returns_the_catalogue() {
        let h = harness();
        assert_eq!(code_of(&h.apps().await), ErrorCode::NotSignedIn);
        h.sign_in("maya", "demo").await.unwrap();
        let apps = h.apps().await.unwrap().apps;
        let ids: Vec<_> = apps.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["files", "orders-web", "mail-web", "notepad"]);
    }

    fn app_with_icon(id: &str, icon_chars: usize) -> AppEntry {
        let mut app = fixtures::catalogue().remove(1);
        app.id = id.to_string();
        app.icon_png_base64 = Some("A".repeat(icon_chars));
        app
    }

    #[tokio::test]
    async fn a_large_icon_comes_back_as_null() {
        let h = harness();
        h.directory.set(Mode::Answer(DirectoryAnswer::Ok(DirectoryEmployee {
            employee: fixtures::employees().remove(0).employee,
            apps: vec![app_with_icon("big", 50_000), app_with_icon("small", 1_000)],
            offline_days: 7,
        })));
        h.sign_in("maya", "demo").await.unwrap();
        let apps = h.apps().await.unwrap().apps;
        assert_eq!(apps[0].icon_png_base64, None);
        assert_eq!(apps[1].icon_png_base64.as_deref().map(str::len), Some(1_000));
    }

    #[test]
    fn too_many_icons_for_one_frame_are_all_dropped() {
        // 25 icons of 40,000 characters pass the per-icon limit but not the total.
        let apps: Vec<_> = (0..25).map(|n| app_with_icon(&format!("a{n}"), 40_000)).collect();
        let sanitized = sanitize_apps(apps);
        assert_eq!(sanitized.len(), 25);
        assert!(sanitized.iter().all(|a| a.icon_png_base64.is_none()));
        // Exactly at the per-icon limit is kept when the total fits.
        let kept = sanitize_apps(vec![app_with_icon("x", MAX_ICON_BASE64_CHARS)]);
        assert_eq!(kept[0].icon_png_base64.as_deref().map(str::len), Some(MAX_ICON_BASE64_CHARS));
    }

    #[tokio::test]
    async fn session_get_sign_out_and_clear() {
        let h = harness();
        let nobody = h.session_get().await;
        assert_eq!((nobody.employee, nobody.files_root, nobody.offline), (None, None, false));

        h.sign_in("maya", "demo").await.unwrap();
        let signed_in = h.session_get().await;
        assert_eq!(signed_in.employee.map(|e| e.username), Some("maya".to_string()));
        assert!(signed_in.files_root.is_some_and(|r| r.ends_with(r"\emp_maya")));

        // Signing out twice succeeds.
        h.sign_out().await;
        h.sign_out().await;
        assert_eq!(h.session_get().await.employee, None);
        assert_eq!(code_of(&h.apps().await), ErrorCode::NotSignedIn);

        // `clear` (Staff session ended, admin exit, revoked) empties the session too.
        h.sign_in("sam", "demo").await.unwrap();
        h.manager.clear("test");
        assert_eq!(h.session_get().await.employee, None);
        assert_eq!(h.manager.current_username(), None);
    }

    #[tokio::test]
    async fn sign_in_needs_an_enrolled_device_and_valid_input() {
        let not_enrolled = harness_with(Options { enrollment: EnrollmentStatus::NotEnrolled, ..Options::default() });
        assert_eq!(code_of(&not_enrolled.sign_in("maya", "demo").await), ErrorCode::NotEnrolled);

        let revoked = harness_with(Options { enrollment: EnrollmentStatus::Revoked, ..Options::default() });
        assert_eq!(code_of(&revoked.sign_in("maya", "demo").await), ErrorCode::DeniedByPolicy);

        let h = harness();
        assert_eq!(code_of(&h.sign_in("", "demo").await), ErrorCode::InvalidParams);
        assert_eq!(code_of(&h.sign_in("   ", "demo").await), ErrorCode::InvalidParams);
        assert_eq!(code_of(&h.sign_in(&"u".repeat(65), "demo").await), ErrorCode::InvalidParams);
        assert_eq!(code_of(&h.sign_in("maya", "").await), ErrorCode::InvalidParams);
        assert_eq!(code_of(&h.sign_in("maya", &"p".repeat(257)).await), ErrorCode::InvalidParams);
        // The limits themselves are fine: 64 characters, 256 characters.
        assert_eq!(h.sign_in(&"u".repeat(64), &"p".repeat(256)).await.unwrap().outcome, SignInOutcome::WrongCredentials);
        // Nothing invalid was counted.
        assert_eq!(h.failures("maya"), 0);
        // Params of the wrong shape are invalid_params and say nothing about the value.
        let bad = h.call(SessionSignIn::NAME, json!({ "username": "maya", "password": 12345 })).await;
        let error = bad.unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidParams);
        assert!(!error.message.contains("12345"));
        assert_eq!(
            code_of(&h.call(SessionVerifyPassword::NAME, json!({})).await),
            ErrorCode::InvalidParams
        );
    }

    #[tokio::test]
    async fn an_unknown_files_base_is_a_retryable_internal_error_before_counting() {
        let h = harness_with(Options { files_base: false, ..Options::default() });
        let error = h.sign_in("maya", "demo").await.unwrap_err();
        assert_eq!(error.code, ErrorCode::Internal);
        assert!(error.retryable);
        assert!(error.message.contains("not set up"));
        assert_eq!(h.failures("maya"), 0);
        // Once the Staff account is set up the sign-in works.
        h.manager.set_files_base(Some(h.dir.path().join("files")));
        assert_eq!(h.sign_in("maya", "demo").await.unwrap().outcome, SignInOutcome::Ok);
    }

    #[tokio::test]
    async fn a_damaged_cache_hash_is_removed_and_not_counted() {
        let mut entry = cached_entry("maya", 7, START_MS, "demo");
        entry.password_hash = "$argon2id$v=19$m=1048576,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g".into();
        let h = harness_with(Options { cached: vec![entry], ..Options::default() });
        h.set_online(false);
        let result = h.sign_in("maya", "demo").await.unwrap();
        assert_eq!(result.outcome, SignInOutcome::OfflineNeverSignedIn);
        assert!(h.cache_on_disk().get("maya").is_none());
        assert_eq!(h.failures("maya"), 0);
    }

    // -- tests 19 and 20 --------------------------------------------------------------

    #[test]
    fn files_folder_name_is_one_safe_component() {
        assert_eq!(files_folder_name("emp_maya"), "emp_maya");
        assert_eq!(files_folder_name("A-b_9"), "A-b_9");
        let exactly_64 = "a".repeat(64);
        assert_eq!(files_folder_name(&exactly_64), exactly_64);

        for bad in [r"..\evil", "../evil", "a.b", "a b", "", "C:", "emp\u{e9}", &"a".repeat(70), "con", "NUL", "com1", "LPT9"] {
            let name = files_folder_name(bad);
            assert_eq!(name.len(), 32, "{bad:?} -> {name}");
            assert!(name.bytes().all(|b| b.is_ascii_hexdigit()), "{name}");
        }
        // Deterministic.
        assert_eq!(files_folder_name(r"..\evil"), files_folder_name(r"..\evil"));
        assert_ne!(files_folder_name(r"..\evil"), files_folder_name(r"..\evil2"));
        // COM0 and CONSOLE are not device names.
        assert_eq!(files_folder_name("com0"), "com0");
        assert_eq!(files_folder_name("console"), "console");
    }

    #[test]
    fn without_a_directory_there_are_no_capabilities_and_no_methods() {
        let dir = TempDir::new();
        let (_tx, snapshot_rx) = watch::channel(test_snapshot());
        let now: Arc<dyn Fn() -> u64 + Send + Sync> = Arc::new(|| START_MS);
        let manager = SessionManager::new(SessionDeps {
            directory: Arc::new(UnavailableDirectory),
            cache: EmployeeCache::open(dir.path().join("c.json")).unwrap(),
            lockouts: Arc::new(Mutex::new(LockoutStore::open(dir.path().join("l.json")).unwrap())),
            audit: AuditHandle::new(
                AuditQueue::open(dir.path().join("a.json")).unwrap(),
                snapshot_rx.clone(),
                Arc::clone(&now),
            ),
            snapshot_rx,
            files_base: Some(dir.path().join("files")),
            now_ms: Arc::clone(&now),
            clock_floor_ms: now,
            timeouts: SessionTimeouts::default(),
        });
        assert!(manager.capabilities().is_empty());
        for method in [SessionSignIn::NAME, SessionSignOut::NAME, SessionGet::NAME, SessionVerifyPassword::NAME, AppsList::NAME] {
            assert!(manager.handle(&Harness::peer(), method, json!({})).is_none(), "{method}");
        }
    }

    #[test]
    fn with_a_directory_the_capabilities_are_session_and_apps() {
        let h = harness();
        assert_eq!(h.manager.capabilities(), ["session", "apps"]);
        assert!(h.manager.handle(&Harness::peer(), "x.other", json!({})).is_none());
    }
}

/// Through the real shell server: capability listing, `unknown_method`, a sign-in
/// on the wire and that no password reaches the log.
#[cfg(test)]
mod wire_tests {
    use super::*;

    use rulebox_ipc::server::PipeListener;
    use rulebox_ipc::types::{ClientInfo, HelloParams, HelloResult, ProtocolVersion};
    use rulebox_ipc::Frame;
    use rulebox_win32::pipe::sim_pipe_sddl;
    use rulebox_win32::sid::current_user_sid;
    use serde_json::json;
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    use crate::audit::AuditQueue;
    use crate::directory::{FixtureDirectory, UnavailableDirectory};
    use crate::ipc_shell::{serve, PeerPolicy, ShellBroadcast, ShellServer};
    use crate::testutil::{capture_logs, test_snapshot, unique_pipe_name, RawClient, TempDir};
    use rulebox_ipc::types::ClientRole;

    struct Served {
        name: String,
        shutdown: CancellationToken,
        task: tokio::task::JoinHandle<()>,
        _dir: TempDir,
    }

    fn start(directory: Arc<dyn EmployeeDirectory>) -> Served {
        let dir = TempDir::new();
        let mut snapshot = test_snapshot();
        snapshot.enrollment = EnrollmentStatus::Enrolled;
        snapshot.connection = ConnectionStatus::Online;
        let (snapshot_tx, snapshot_rx) = watch::channel(snapshot);
        // Keep the sender alive for the life of the test process's server task.
        std::mem::forget(snapshot_tx);
        let now: Arc<dyn Fn() -> u64 + Send + Sync> = Arc::new(crate::state::unix_ms);
        let manager = SessionManager::new(SessionDeps {
            directory,
            cache: EmployeeCache::open(dir.path().join("c.json")).unwrap(),
            lockouts: Arc::new(Mutex::new(LockoutStore::open(dir.path().join("l.json")).unwrap())),
            audit: AuditHandle::new(
                AuditQueue::open(dir.path().join("a.json")).unwrap(),
                snapshot_rx.clone(),
                Arc::clone(&now),
            ),
            snapshot_rx: snapshot_rx.clone(),
            files_base: Some(dir.path().join("files")),
            now_ms: Arc::clone(&now),
            clock_floor_ms: Arc::new(|| 0),
            timeouts: SessionTimeouts::default(),
        });

        let me = current_user_sid().unwrap();
        let name = unique_pipe_name();
        let listener = PipeListener::bind(&name, &sim_pipe_sddl(&me)).unwrap();
        let (signals, _signals_rx) = mpsc::unbounded_channel();
        std::mem::forget(_signals_rx);
        let server = ShellServer {
            snapshot_rx,
            signals,
            broadcast: ShellBroadcast::new(),
            extensions: vec![manager as Arc<dyn ShellExtension>],
            peers: PeerPolicy::Simulate { current_user: me },
        };
        let shutdown = CancellationToken::new();
        let task = tokio::spawn(serve(listener, server, shutdown.clone()));
        Served { name, shutdown, task, _dir: dir }
    }

    async fn hello(client: &mut RawClient) -> HelloResult {
        let params = serde_json::to_value(HelloParams {
            protocol: ProtocolVersion { major: 1, minor: 1 },
            client: ClientInfo { role: ClientRole::Shell, name: "test".into(), version: "0.0.0".into() },
        })
        .unwrap();
        match client.request(0, "hello", params).await {
            Frame::Response { ok: true, result: Some(result), .. } => serde_json::from_value(result).unwrap(),
            other => panic!("hello failed: {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_unavailable_directory_makes_session_methods_unknown_methods() {
        let served = start(Arc::new(UnavailableDirectory));
        let mut client = RawClient::connect(&served.name).await;
        assert_eq!(hello(&mut client).await.capabilities, ["state", "health"]);
        for (id, method) in [(1, "session.signIn"), (2, "apps.list"), (3, "session.get")] {
            match client.request(id, method, json!({})).await {
                Frame::Response { ok: false, error: Some(error), .. } => {
                    assert_eq!(error.code, ErrorCode::UnknownMethod, "{method}");
                }
                other => panic!("unexpected {other:?}"),
            }
        }
        served.shutdown.cancel();
        served.task.await.unwrap();
    }

    #[tokio::test]
    async fn a_fixture_directory_signs_in_over_the_pipe_and_the_password_is_never_logged() {
        let capture = capture_logs();
        let served = start(Arc::new(FixtureDirectory::new(false)));
        let mut client = RawClient::connect(&served.name).await;
        assert_eq!(hello(&mut client).await.capabilities, ["state", "health", "session", "apps"]);

        // A password no other test writes, so the shared log capture can be searched.
        let secret = "pw-do-not-log-4f1c";
        let wrong = client
            .request(1, "session.signIn", json!({ "username": "maya", "password": secret }))
            .await;
        match wrong {
            Frame::Response { ok: true, result: Some(result), .. } => {
                assert_eq!(result["outcome"], "wrongCredentials");
                assert_eq!(result["employee"], serde_json::Value::Null);
            }
            other => panic!("unexpected {other:?}"),
        }
        let ok = client
            .request(2, "session.signIn", json!({ "username": "Maya", "password": "demo" }))
            .await;
        match ok {
            Frame::Response { ok: true, result: Some(result), .. } => {
                assert_eq!(result["outcome"], "ok");
                assert_eq!(result["offline"], false);
                assert_eq!(result["employee"]["id"], "emp_maya");
                assert!(result["filesRoot"].as_str().is_some_and(|r| r.ends_with(r"\emp_maya")));
            }
            other => panic!("unexpected {other:?}"),
        }
        // A request whose params do not parse must not echo the secret either.
        client
            .request(3, "session.verifyPassword", json!({ "password": [secret] }))
            .await;
        let apps = client.request(4, "apps.list", json!({})).await;
        match apps {
            Frame::Response { ok: true, result: Some(result), .. } => {
                assert_eq!(result["apps"].as_array().map(Vec::len), Some(4));
            }
            other => panic!("unexpected {other:?}"),
        }
        served.shutdown.cancel();
        served.task.await.unwrap();

        let logged = capture.text();
        assert!(logged.contains("session.signIn"), "the log must have been captured: {logged}");
        assert!(!logged.contains(secret), "a password reached the log:\n{logged}");
    }
}
