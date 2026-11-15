//! The backend seam (plan Section 5.8, Step 8): everything the agent says to, and
//! hears from, the Convex deployment goes through [`Backend`]. `ConvexBackend`
//! (`convex.rs`) is the real one; `FakeBackend` (`fake.rs`, tests only) scripts it.
//!
//! Device authentication (README answer Q1): every device call carries
//! `deviceId` and `deviceSecret` as arguments and the server compares
//! `sha256(secret)` with `devices.secretHash`. There is no JWT in Phase 2.
//!
//! The device secret is a credential: [`DeviceAuth`]'s `Debug` hides it, and
//! nothing in this module logs a call's arguments or a server error message (a
//! Convex error message can quote the arguments, secret included).

use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use rulebox_ipc::types::ConnectionStatus;
use rulebox_policy::envelope::{PublishedKey, SignedEnvelope, TrustedKey};
use rulebox_policy::roster::{RosterEntry, RosterSnapshot};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub mod convex;
#[cfg(test)]
pub mod fake;
pub mod reports;
pub mod task;
pub mod value;

/// Every one-shot call is wrapped in this timeout: the Convex Rust client waits
/// forever while the PC is offline (plan Section 5.8).
pub const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Builds the backend for one deployment URL. `ConvexClient::new` does not touch
/// the network, so building never blocks; the connection is made in the
/// background.
pub type BackendFactory = Arc<dyn Fn(&str) -> Result<Arc<dyn Backend>, BackendError> + Send + Sync>;

/// A request to one deployment. `subscribe` is long-lived; the rest are one-shot
/// and already have the 30-second timeout applied by the implementation.
pub trait Backend: Send + Sync {
    /// `enrollment:enroll`. Safe to repeat with the same token and secret hash.
    fn enroll(&self, req: EnrollRequest) -> BoxFuture<'_, Result<EnrollResponse, BackendError>>;

    /// (Phase 4 Step 13, A4) `devices:ping`: liveness only (the status travels in
    /// [`Backend::report`]). Unknown, wrong secret and revoked are
    /// `Rejected { code: "device_rejected" }`.
    fn ping(&self, auth: &DeviceAuth) -> BoxFuture<'_, Result<PingResponse, BackendError>>;

    /// (Phase 4 Step 13, A12) `deviceApi:report`: the status snapshot (only when it
    /// changed), install results and audit records in one call. Each part keeps
    /// the server's own idempotency rule, so a repeated batch is harmless.
    fn report<'a>(&'a self, auth: &DeviceAuth, batch: &ReportBatch) -> BoxFuture<'a, Result<ReportAccepted, BackendError>>;

    /// (Phase 5 Step 9) One lockdown report (`deviceApi:reportApply`, `reportFindings`
    /// or `reportSecurityDaily`; the functions arrive with Step 10). Each is idempotent on
    /// the server, so a repeated call after a lost answer is harmless. The default is
    /// "not supported": a backend that does not know the call is `Rejected`, and the
    /// caller keeps the report and tries again later.
    fn lockdown_report<'a>(&'a self, auth: &DeviceAuth, call: &reports::LockdownCall) -> BoxFuture<'a, Result<(), BackendError>> {
        let _ = (auth, call);
        Box::pin(async { Err(BackendError::Rejected { code: CODE_NOT_SUPPORTED.to_string() }) })
    }

    /// (Phase 4 Step 13) The action `deviceApi:verifyEmployee`: one online check of
    /// a username and password. The password is an argument of this one call and
    /// is never logged, stored or put in an error.
    fn verify_employee<'a>(
        &'a self,
        auth: &DeviceAuth,
        username: &str,
        password: &str,
    ) -> BoxFuture<'a, Result<VerifyAnswer, BackendError>>;

    /// (Phase 4 Step 13) `deviceApi:rotateCredential`. Idempotent: the same new
    /// hash again with the old secret answers ok once the server took it.
    fn rotate_credential<'a>(&'a self, auth: &DeviceAuth, new_secret_hash: &str) -> BoxFuture<'a, Result<(), BackendError>>;

    /// `devices:unenroll`. A `rejected` answer (unknown id, wrong secret or already
    /// revoked) is success: the caller wants the device gone either way.
    fn unenroll(&self, auth: &DeviceAuth) -> BoxFuture<'_, Result<(), BackendError>>;

    /// Long-lived. Subscribes to `devices:headState` (the only subscription,
    /// PRD 11.1 rule 6) and sends every result and every connection-state change
    /// until `shutdown` is cancelled.
    fn subscribe(
        &self,
        auth: DeviceAuth,
        tx: mpsc::Sender<BackendEvent>,
        shutdown: CancellationToken,
    ) -> BoxFuture<'_, ()>;

    /// (Phase 4 Step 9) `devices:fetchDesired({ version })`: the signed envelope of
    /// one version, as received. A pruned version is `Rejected { code: "not_found" }`.
    fn fetch_desired(&self, auth: &DeviceAuth, version: u64) -> BoxFuture<'_, Result<SignedEnvelope, BackendError>>;

    /// (Phase 4 Step 9) `devices:fetchRoster({ sinceEpoch })`.
    fn fetch_roster(&self, auth: &DeviceAuth, since_epoch: u64) -> BoxFuture<'_, Result<RosterFetch, BackendError>>;
}

/// The server code of a version that was pruned (`fetchDesired`).
pub const CODE_NOT_FOUND: &str = "not_found";
/// (Step 13) Every device function: unknown device, wrong secret or revoked.
pub const CODE_DEVICE_REJECTED: &str = "device_rejected";
/// (Step 13) `rotateCredential` with the previous secret while the server holds
/// another new hash.
pub const CODE_CONFLICT: &str = "conflict";
/// (Step 13) `rotateCredential` for a device without a credentials row.
pub const CODE_NOT_READY: &str = "not_ready";
/// (Phase 5 Step 9) The backend has no such call (a [`Backend`] that does not override
/// `lockdown_report`).
pub const CODE_NOT_SUPPORTED: &str = "not_supported";

/// (Phase 4 Step 13) The live backend and the credentials of this device, while
/// the backend task runs. The employee directory and the report sink are built
/// before enrollment; they read the link at each call, so they always use the
/// current deployment and the current (possibly just rotated) secret. Empty =
/// not enrolled, revoked or stopped: callers answer `Unreachable`.
#[derive(Default)]
pub struct BackendLink {
    inner: std::sync::RwLock<Option<(Arc<dyn Backend>, DeviceAuth)>>,
}

impl BackendLink {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn set(&self, backend: Arc<dyn Backend>, auth: DeviceAuth) {
        *self.inner.write().unwrap_or_else(std::sync::PoisonError::into_inner) = Some((backend, auth));
    }

    /// Replaces only the credentials (a finished rotation).
    pub fn set_auth(&self, auth: DeviceAuth) {
        if let Some((_, current)) = self.inner.write().unwrap_or_else(std::sync::PoisonError::into_inner).as_mut() {
            *current = auth;
        }
    }

    pub fn clear(&self) {
        *self.inner.write().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }

    pub fn get(&self) -> Option<(Arc<dyn Backend>, DeviceAuth)> {
        self.inner.read().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }
}

/// (Step 13) The answer of `devices:ping` (`devices:heartbeat` answers the same
/// keys). `rotateCredential` and `planState` missing mean `false` and `"ok"`;
/// `serverTimeMs` is read when the server sends it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PingResponse {
    pub next_ping_in_ms: u64,
    pub server_time_ms: Option<i64>,
    pub rotate_credential: bool,
    /// `"ok" | "overLimit" | "suspended"`; the agent only logs it (A13 item 12).
    pub plan_state: String,
}

/// (Step 13) One `deviceApi:report` call. An empty part is left out.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ReportBatch {
    pub status: Option<StatusReport>,
    pub installs: Vec<InstallReport>,
    pub audit: Vec<crate::audit::AuditRecord>,
    /// Records lost on the device since the last accepted report.
    pub dropped: u64,
}

impl ReportBatch {
    pub fn is_empty(&self) -> bool {
        self.status.is_none() && self.installs.is_empty() && self.audit.is_empty() && self.dropped == 0
    }
}

/// (Step 13) `{ accepted: { installs, audit } }`: how many of each the server now
/// knows (new and repeated).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ReportAccepted {
    pub installs: usize,
    pub audit: usize,
}

/// (Step 13, A12) One install result. Only `pending` (the agent took the job) and
/// the terminal states are reported; Step 14's engine produces them (and keeps the
/// last one in `installs.json` until the server took it, hence `Deserialize`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub app_id: String,
    pub state: InstallState,
    pub app_revision: u64,
    pub attempts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    /// One of the server's fixed texts (`download_failed`, `hash_mismatch`, ...).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallState {
    Pending,
    Installed,
    Failed,
    Removed,
    Unsupported,
}

/// (Step 13) The answer of `deviceApi:verifyEmployee`. `Disabled` and
/// `NotAllowedHere` come only for a correct password.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyAnswer {
    Ok { employee: rulebox_ipc::requests::Employee, offline_days: u32, credential_revision: u64 },
    WrongCredentials,
    Disabled,
    NotAllowedHere,
    LockedOut { retry_after_ms: u64 },
}

#[derive(Clone, PartialEq, Eq)]
pub struct DeviceAuth {
    pub device_id: String,
    pub device_secret: String,
}

impl std::fmt::Debug for DeviceAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceAuth")
            .field("device_id", &self.device_id)
            .field("device_secret", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, PartialEq)]
pub struct EnrollRequest {
    /// The raw enrollment token; the server stores and compares only its hash.
    pub token: String,
    /// `sha256_hex(device_secret)`: the hash of the UTF-8 text of the secret.
    pub device_secret_hash: String,
    pub device_name: String,
    /// SHA-256 of the machine GUID: a hint for the administrator (cloned images
    /// share it), never used for authentication.
    pub hardware_id_hash: Option<String>,
    pub agent_version: String,
    /// The `CompatReport` as JSON (the server keeps it as `v.any()`).
    pub compat: serde_json::Value,
}

impl std::fmt::Debug for EnrollRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EnrollRequest")
            .field("token", &"<redacted>")
            .field("device_name", &self.device_name)
            .field("agent_version", &self.agent_version)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnrollResponse {
    pub device_id: String,
    pub org_id: String,
    pub device_name: String,
    pub server_time_ms: i64,
    /// (Phase 4 Step 9) The organization's active key (and the next one while a
    /// rotation is prepared): the device's root of trust. Each key id was checked
    /// against its key when the answer was parsed.
    pub policy_keys: Vec<TrustedKey>,
}

/// The `status` part of `deviceApi:report` (it was the argument of
/// `devices:heartbeat` until Step 13). The server validates it with a
/// **strict** `v.object`, so these fourteen keys (camelCase) are the only ones
/// that may ever be sent; an unknown key makes the whole call fail. Optional
/// fields are omitted when the agent does not know them. `agent_version` and
/// `compat` are always present because the status is a full snapshot: an absent
/// field clears the stored value.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    pub agent_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_build: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_edition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ram_mb: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_free_gb: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lockdown_level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kiosk_phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kiosk_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_version: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell_health: Option<String>,
    pub compat: serde_json::Value,
    /// (Phase 4 Step 9) The ids of the keys this device trusts, sorted: the
    /// dashboard's "N of M devices trust the new key" (`keys:trustProgress`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trusted_key_ids: Option<Vec<String>>,
    /// (Phase 4 Step 14) `Some(true)` while an installer asked for a restart since
    /// the last boot; left out otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restart_pending: Option<bool>,
    /// (Phase 5 Step 20, plan 4.16) The physical-protection report (`lockdown::boot::SecurityReport`
    /// as JSON): Secure Boot, BitLocker, TPM, auto-recovery, the Safe Mode registration, the
    /// service DACL and folder-ACL repairs. Left out until the first lockdown pass read it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub security: Option<serde_json::Value>,
    /// (Phase 5 Step 20) What this agent can do (`lockdown/1`). Left out by an agent without the
    /// lockdown runtime (the demo world).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
}

/// The object keys of `StatusReport` that `devices:heartbeat` accepts (`convex/lib/deviceReport.ts`,
/// `statusValidator`). A test pins the serialized key set to this list.
#[cfg(test)]
pub const STATUS_KEYS: [&str; 16] = [
    "agentVersion",
    "os",
    "osBuild",
    "osEdition",
    "ramMb",
    "diskFreeGb",
    "lockdownLevel",
    "kioskPhase",
    "kioskError",
    "appliedVersion",
    "shellHealth",
    "compat",
    "trustedKeyIds",
    "restartPending",
    "security",
    "capabilities",
];

#[derive(Debug, Clone, PartialEq)]
pub enum BackendEvent {
    Connection(ConnectionStatus),
    Desired(DesiredFetch),
}

/// The head of `devices:headState` (plan 5.1 amended, A5 + A13). NOT signed: it
/// only says that a version exists. Nothing is applied from it; the body is
/// fetched and verified (`rulebox_policy::envelope::verify_for_head`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub version: u64,
    /// SHA-256 of the document with version 0 (server-side de-duplication only).
    pub content_hash: String,
    pub key_id: String,
    pub ping_interval_ms: u64,
    /// (A13, behaviour in Step 13) A change asks for a ping at once.
    pub ping_nonce: u64,
    /// (A13, behaviour in Step 13) Ping every 60 s until this Unix ms time.
    pub fast_until: u64,
    pub roster_epoch: u64,
    /// `"ok" | "overLimit" | "suspended"`.
    pub plan_state: String,
}

/// One result of the `devices:headState` subscription.
#[derive(Debug, Clone, PartialEq)]
pub enum DesiredFetch {
    /// `{ kind: "ok", head, keys, retiredKeyIds }`. `head` is `None` until the
    /// publisher reached the device (about 1.5 s after enrollment). `keys` is
    /// every key of the organization, oldest first, with endorsements.
    Ok { head: Option<Head>, keys: Vec<PublishedKey>, retired_key_ids: Vec<String> },
    /// `{ kind: "revoked" }`.
    Revoked,
    /// `{ kind: "unknownDevice" }`: the id does not exist or the secret is wrong.
    UnknownDevice,
}

/// One answer of `devices:fetchRoster`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RosterFetch {
    /// `{ epoch, entries }`: the entries after `sinceEpoch`, ascending.
    Entries { epoch: u64, entries: Vec<RosterEntry> },
    /// `{ snapshot }`: the device is behind the newest snapshot.
    Snapshot(RosterSnapshot),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BackendError {
    /// No connection, or the client is gone.
    #[error("the backend is unreachable")]
    Unreachable,
    /// No answer within [`CALL_TIMEOUT`].
    #[error("the backend did not answer in time")]
    Timeout,
    /// The server answered with an application error. `code` is the `code` field of
    /// the `ConvexError` data (`token_expired`, `invalid_request`, ...), or
    /// `server_error` when the server sent a plain error message.
    #[error("the backend rejected the request ({code})")]
    Rejected { code: String },
    /// The answer did not have the expected shape.
    #[error("unexpected backend answer: {0}")]
    Protocol(String),
}

/// SHA-256 of the UTF-8 bytes of `text`, as 64 lowercase hex characters. This is
/// how the device secret is hashed: of the **text** of the secret (the hex string
/// exactly as it is later sent as `deviceSecret`), never of its decoded bytes, to
/// match `sha256Hex` in `convex/lib/deviceAuth.ts`.
pub fn sha256_hex(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest.iter() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_of_abc_matches_the_published_vector() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn the_secret_is_hashed_as_text_not_as_decoded_bytes() {
        // 64 hex characters: hashing the text must differ from hashing the 32 bytes
        // it encodes (which is the mistake this test pins).
        let secret = "ab".repeat(32);
        let as_text = sha256_hex(&secret);
        let decoded: Vec<u8> = (0..secret.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&secret[i..i + 2], 16).unwrap())
            .collect();
        let mut as_bytes = String::new();
        for byte in Sha256::digest(&decoded).iter() {
            as_bytes.push_str(&format!("{byte:02x}"));
        }
        assert_ne!(as_text, as_bytes);
        assert_eq!(as_text.len(), 64);
        assert!(as_text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    }

    #[test]
    fn debug_output_hides_secrets_and_tokens() {
        let auth = DeviceAuth { device_id: "dev1".into(), device_secret: "s3cret-value".into() };
        let text = format!("{auth:?}");
        assert!(text.contains("dev1") && text.contains("<redacted>") && !text.contains("s3cret"));
        let request = EnrollRequest {
            token: "TOKEN-TEXT".into(),
            device_secret_hash: "h".into(),
            device_name: "Desk".into(),
            hardware_id_hash: None,
            agent_version: "0.0.0".into(),
            compat: serde_json::json!({}),
        };
        assert!(!format!("{request:?}").contains("TOKEN-TEXT"));
        let envelope = SignedEnvelope {
            version: 1,
            payload: r#"{"doc":{"adminExit":{"pinHash":"$argon2id$hide-me"}}}"#.into(),
            signature: "sig".into(),
            key_id: "k".into(),
        };
        assert!(!format!("{envelope:?}").contains("argon2"));
    }

    fn full_status() -> StatusReport {
        StatusReport {
            agent_version: "0.0.0".into(),
            os: Some("Windows 11".into()),
            os_build: Some("26100.1".into()),
            os_edition: Some("Professional".into()),
            ram_mb: Some(8192),
            disk_free_gb: Some(100),
            lockdown_level: Some("kiosk".into()),
            kiosk_phase: Some("applied".into()),
            kiosk_error: Some("x".into()),
            applied_version: Some(3),
            shell_health: Some("healthy".into()),
            compat: serde_json::json!({ "blockers": [] }),
            trusted_key_ids: Some(vec!["21fe31dfa154a261".into()]),
            restart_pending: Some(false),
            security: Some(serde_json::json!({ "secureBoot": "on" })),
            capabilities: Some(vec!["lockdown/1".into()]),
        }
    }

    fn keys_of(status: &StatusReport) -> std::collections::BTreeSet<String> {
        serde_json::to_value(status)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect()
    }

    /// The server validates `status` with a strict `v.object`: an extra key fails
    /// the whole heartbeat. This pins the wire key set to the list in
    /// `convex/devices.ts` (`statusValidator`).
    #[test]
    fn status_keys_match_server() {
        let expected: std::collections::BTreeSet<String> =
            STATUS_KEYS.iter().map(|k| (*k).to_string()).collect();
        assert_eq!(keys_of(&full_status()), expected);
    }

    #[test]
    fn unknown_fields_are_omitted_and_agent_version_and_compat_always_stay() {
        let sparse = StatusReport {
            agent_version: "0.0.0".into(),
            os: None,
            os_build: None,
            os_edition: None,
            ram_mb: None,
            disk_free_gb: None,
            lockdown_level: None,
            kiosk_phase: None,
            kiosk_error: None,
            applied_version: None,
            shell_health: None,
            compat: serde_json::json!({}),
            trusted_key_ids: None,
            restart_pending: None,
            security: None,
            capabilities: None,
        };
        let keys = keys_of(&sparse);
        assert_eq!(keys.into_iter().collect::<Vec<_>>(), ["agentVersion", "compat"]);
        // Every key the agent ever sends is one the server knows.
        for key in keys_of(&full_status()) {
            assert!(STATUS_KEYS.contains(&key.as_str()), "{key}");
        }
    }
}
