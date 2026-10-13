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
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub mod convex;
#[cfg(test)]
pub mod fake;
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

    /// `devices:heartbeat`. `status` is a full snapshot (an absent field clears the
    /// stored value), so pass `None` only when it has not changed since the last
    /// accepted one. A `rejected` answer is `Err(Rejected { code: "rejected" })`.
    fn heartbeat(
        &self,
        auth: &DeviceAuth,
        status: Option<StatusReport>,
    ) -> BoxFuture<'_, Result<HeartbeatResponse, BackendError>>;

    /// `devices:unenroll`. A `rejected` answer (unknown id, wrong secret or already
    /// revoked) is success: the caller wants the device gone either way.
    fn unenroll(&self, auth: &DeviceAuth) -> BoxFuture<'_, Result<(), BackendError>>;

    /// Long-lived. Subscribes to `devices:desiredState` (the only subscription,
    /// PRD 11.1 rule 6) and sends every result and every connection-state change
    /// until `shutdown` is cancelled.
    fn subscribe(
        &self,
        auth: DeviceAuth,
        tx: mpsc::Sender<BackendEvent>,
        shutdown: CancellationToken,
    ) -> BoxFuture<'_, ()>;
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
}

/// The `status` argument of `devices:heartbeat`. The server validates it with a
/// **strict** `v.object`, so these twelve keys (camelCase) are the only ones that
/// may ever be sent; an unknown key makes the whole call fail. Optional fields are
/// omitted when the agent does not know them. `agent_version` and `compat` are
/// always present because the status is a full snapshot: an absent field clears
/// the stored value.
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
}

/// The object keys of `StatusReport` that `devices:heartbeat` accepts (`convex/devices.ts`,
/// `statusValidator`). A test pins the serialized key set to this list.
#[cfg(test)]
pub const STATUS_KEYS: [&str; 12] = [
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
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeartbeatResponse {
    pub next_ping_in_ms: u64,
    pub server_time_ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum BackendEvent {
    Connection(ConnectionStatus),
    Desired(DesiredFetch),
}

/// One result of the `devices:desiredState` subscription.
#[derive(Clone, PartialEq)]
pub enum DesiredFetch {
    /// `{ kind: "ok", desired: null }`: no document yet.
    None,
    /// `{ kind: "ok", desired: { version, doc, signature } }`. `doc` is the raw
    /// document, agent-only keys included.
    Doc { version: u64, doc: serde_json::Value, signature: Option<String> },
    /// `{ kind: "revoked" }`.
    Revoked,
    /// `{ kind: "unknownDevice" }`: the id does not exist or the secret is wrong.
    UnknownDevice,
}

impl std::fmt::Debug for DesiredFetch {
    // Not derived: `doc` can hold the exit PIN hash.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DesiredFetch::None => f.write_str("None"),
            DesiredFetch::Doc { version, signature, .. } => f
                .debug_struct("Doc")
                .field("version", version)
                .field("signed", &signature.is_some())
                .finish_non_exhaustive(),
            DesiredFetch::Revoked => f.write_str("Revoked"),
            DesiredFetch::UnknownDevice => f.write_str("UnknownDevice"),
        }
    }
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
        let doc = DesiredFetch::Doc {
            version: 1,
            doc: serde_json::json!({ "adminExit": { "pinHash": "$argon2id$hide-me" } }),
            signature: None,
        };
        assert!(!format!("{doc:?}").contains("argon2"));
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
    fn the_status_key_set_is_exactly_the_servers_list() {
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
        };
        let keys = keys_of(&sparse);
        assert_eq!(keys.into_iter().collect::<Vec<_>>(), ["agentVersion", "compat"]);
        // Every key the agent ever sends is one the server knows.
        for key in keys_of(&full_status()) {
            assert!(STATUS_KEYS.contains(&key.as_str()), "{key}");
        }
    }
}
