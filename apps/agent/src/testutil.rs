//! Test helpers (compiled only for tests).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use rulebox_ipc::codec::{CodecError, FrameCodec};
use rulebox_ipc::types::AgentSnapshot;
use rulebox_ipc::Frame;
use tokio::net::windows::named_pipe::NamedPipeClient;
use tokio_util::codec::Framed;

use crate::agent::{initial_snapshot, AgentConfig};
use crate::agent_policy::AgentPolicy;
use crate::platform::sim::SimPlatform;
use crate::state::AgentState;

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// A fresh directory under the system temp dir, removed on drop.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new() -> Self {
        let dir = std::env::temp_dir()
            .join(format!("rulebox-agent-test-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A pipe name no other test, process or real agent uses.
pub fn unique_pipe_name() -> String {
    format!(
        r"\\.\pipe\dev.rulebox.agent-test.{}.{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/// The snapshot of a fresh, not enrolled agent.
pub fn test_snapshot() -> AgentSnapshot {
    let sim = SimPlatform::new(std::env::temp_dir());
    initial_snapshot(&AgentState::default(), &sim, &AgentConfig::default(), &AgentPolicy::default())
}

/// A small, complete status snapshot (report tests).
pub fn sample_status() -> crate::backend::StatusReport {
    crate::backend::StatusReport {
        agent_version: "0.0.0".into(),
        os: Some("Windows 11".into()),
        os_build: None,
        os_edition: None,
        ram_mb: Some(8192),
        disk_free_gb: None,
        lockdown_level: None,
        kiosk_phase: None,
        kiosk_error: None,
        applied_version: Some(1),
        shell_health: None,
        compat: serde_json::json!({}),
        trusted_key_ids: None,
        restart_pending: None,
    }
}

/// The employee-session pieces a backend or enrollment test needs, built over files
/// in `<dir>\state`.
pub struct SessionParts {
    pub session: Arc<crate::session::SessionManager>,
    pub lockouts: Arc<Mutex<crate::lockout::LockoutStore>>,
    pub audit: Arc<crate::audit::AuditHandle>,
}

pub fn test_session_parts(
    dir: &Path,
    snapshot_rx: tokio::sync::watch::Receiver<AgentSnapshot>,
) -> SessionParts {
    use crate::audit::{AuditHandle, AuditQueue};
    use crate::directory::UnavailableDirectory;
    use crate::employee_cache::EmployeeCache;
    use crate::lockout::LockoutStore;
    use crate::session::{SessionDeps, SessionManager, SessionTimeouts};

    let state = dir.join("state");
    std::fs::create_dir_all(&state).unwrap();
    let now: Arc<dyn Fn() -> u64 + Send + Sync> = Arc::new(crate::state::unix_ms);
    let lockouts = Arc::new(Mutex::new(LockoutStore::open(state.join("lockouts.json")).unwrap()));
    let audit = AuditHandle::new(
        AuditQueue::open(state.join("audit-queue.json")).unwrap(),
        snapshot_rx.clone(),
        Arc::clone(&now),
    );
    let session = SessionManager::new(SessionDeps {
        directory: Arc::new(UnavailableDirectory),
        cache: EmployeeCache::open(state.join("employee-cache.json")).unwrap(),
        lockouts: Arc::clone(&lockouts),
        audit: Arc::clone(&audit),
        snapshot_rx,
        files_base: None,
        now_ms: now,
        clock_floor_ms: Arc::new(|| 0),
        timeouts: SessionTimeouts::default(),
    });
    SessionParts { session, lockouts, audit }
}


/// A bare protocol client for tests that need to misbehave: it sends whatever
/// it is told and never says `hello` by itself. Must be used inside a runtime.
pub struct RawClient {
    framed: Framed<NamedPipeClient, FrameCodec>,
}

impl RawClient {
    /// Opens the pipe, retrying while it is busy: after a client connects the
    /// server needs a moment to create the next instance (the real client does
    /// the same, plan Section 6.8).
    pub async fn connect(name: &str) -> Self {
        let give_up = tokio::time::Instant::now() + Duration::from_secs(5);
        let handle = loop {
            match rulebox_win32::pipe::open_client(name) {
                Ok(handle) => break handle,
                Err(rulebox_win32::Win32Error::Busy) if tokio::time::Instant::now() < give_up => {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(error) => panic!("open the test pipe: {error}"),
            }
        };
        let pipe = rulebox_win32::pipe::client_from_handle(handle).expect("wrap the pipe handle");
        Self { framed: Framed::new(pipe, FrameCodec::new()) }
    }

    pub async fn send(&mut self, frame: Frame) {
        self.framed.send(frame).await.expect("send a frame");
    }

    /// Sends `payload` as one length-prefixed frame without checking that it is
    /// a valid `Frame`.
    pub async fn send_raw_payload(&mut self, payload: &[u8]) {
        use tokio::io::AsyncWriteExt;
        let mut bytes = u32::try_from(payload.len()).unwrap().to_be_bytes().to_vec();
        bytes.extend_from_slice(payload);
        self.framed.get_mut().write_all(&bytes).await.expect("write raw bytes");
    }

    /// The next frame; `None` once the server closed the pipe. No time limit
    /// (the clock may be paused).
    pub async fn recv_raw(&mut self) -> Option<Frame> {
        match self.framed.next().await {
            None | Some(Err(CodecError::Io(_))) => None,
            Some(Ok(frame)) => Some(frame),
            Some(Err(error)) => panic!("the server sent a bad frame: {error}"),
        }
    }

    /// Like `recv_raw`, but panics after 10 seconds.
    pub async fn recv(&mut self) -> Option<Frame> {
        tokio::time::timeout(Duration::from_secs(10), self.recv_raw())
            .await
            .expect("an answer within 10 s")
    }

    /// The next frame, or `None` when nothing arrives within `limit` or the pipe closed.
    pub async fn recv_within(&mut self, limit: Duration) -> Option<Frame> {
        tokio::time::timeout(limit, self.recv_raw()).await.ok().flatten()
    }

    /// Sends a request and returns its response, skipping events.
    pub async fn request(&mut self, id: u32, method: &str, params: serde_json::Value) -> Frame {
        self.send(Frame::Request { id, method: method.to_string(), params }).await;
        loop {
            match self.recv().await {
                Some(frame @ Frame::Response { id: got, .. }) if got == id => return frame,
                Some(_) => {}
                None => panic!("the pipe closed while waiting for the answer to {method}"),
            }
        }
    }
}

static CAPTURE: OnceLock<CaptureWriter> = OnceLock::new();

/// Installs, once per test process, a **global** subscriber at `trace` level that
/// keeps every log line in memory, and returns the buffer. Global on purpose: a
/// scoped (`set_default`) subscriber is unreliable when tests run in parallel,
/// because another thread can register a callsite first and cache "not
/// interested" for it. Everything every test logs ends up in the buffer, so
/// assertions must use strings that no other test writes.
pub fn capture_logs() -> CaptureWriter {
    CAPTURE
        .get_or_init(|| {
            let capture = CaptureWriter::default();
            let subscriber = tracing_subscriber::fmt()
                .with_max_level(tracing::Level::TRACE)
                .with_ansi(false)
                .with_writer(capture.clone())
                .finish();
            tracing::subscriber::set_global_default(subscriber)
                .expect("no other global subscriber in the test process");
            capture
        })
        .clone()
}

/// A `tracing` writer that keeps everything in memory.
#[derive(Clone, Default)]
pub struct CaptureWriter(Arc<Mutex<Vec<u8>>>);

impl CaptureWriter {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

impl std::io::Write for CaptureWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for CaptureWriter {
    type Writer = CaptureWriter;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// (Phase 4 Step 9) Signing like the server does, with the published RFC 8032
/// section 7.1 test keys (never trusted outside tests).
pub mod signing {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;
    use ed25519_dalek::{Signer, SigningKey};
    use rulebox_policy::envelope::{endorsement_message, Endorsement, SignedEnvelope, TrustedKey, PAYLOAD_FORMAT};
    use rulebox_policy::roster::{roster_entry_message, RosterEntry};

    fn key_of(seed_hex: &str) -> SigningKey {
        let bytes: Vec<u8> =
            (0..64).step_by(2).map(|i| u8::from_str_radix(&seed_hex[i..i + 2], 16).unwrap()).collect();
        SigningKey::from_bytes(&bytes.try_into().unwrap())
    }

    /// TEST 1 (key id `21fe31dfa154a261`, the key of the committed vectors).
    pub fn test_key() -> SigningKey {
        key_of("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
    }

    /// TEST 2 (key id `39f713d0a644253f`).
    pub fn test_key_2() -> SigningKey {
        key_of("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb")
    }

    /// TEST 3.
    pub fn test_key_3() -> SigningKey {
        key_of("c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7")
    }

    pub fn trusted_of(key: &SigningKey) -> TrustedKey {
        TrustedKey::from_public_key(&STANDARD.encode(key.verifying_key().as_bytes())).unwrap()
    }

    pub fn sign_text(key: &SigningKey, text: &str) -> String {
        STANDARD.encode(key.sign(text.as_bytes()).to_bytes())
    }

    /// The payload `buildPayload` would write for `doc` (key order as the server's).
    pub fn payload_of(key_id: &str, org: &str, device: &str, version: u64, doc: &serde_json::Value) -> String {
        format!(
            "{{\"format\":\"{PAYLOAD_FORMAT}\",\"keyId\":\"{key_id}\",\"orgId\":\"{org}\",\"deviceId\":\"{device}\",\
             \"version\":{version},\"issuedAtMs\":1760950000000,\"doc\":{doc}}}"
        )
    }

    /// A document envelope signed by `key` (`doc.version` should equal `version`).
    pub fn envelope(key: &SigningKey, org: &str, device: &str, version: u64, doc: &serde_json::Value) -> SignedEnvelope {
        let key_id = trusted_of(key).key_id;
        let payload = payload_of(&key_id, org, device, version, doc);
        SignedEnvelope { version, signature: sign_text(key, &payload), payload, key_id }
    }

    /// `by`'s endorsement of `key` for `org`.
    pub fn endorse(by: &SigningKey, org: &str, key: &SigningKey) -> Endorsement {
        let t = trusted_of(key);
        Endorsement {
            by_key_id: trusted_of(by).key_id,
            signature: sign_text(by, &endorsement_message(org, &t.key_id, &t.public_key)),
        }
    }

    /// A roster entry signed by `key` for `org` / `group`.
    pub fn roster_entry(
        key: &SigningKey,
        org: &str,
        group: &str,
        epoch: u64,
        employee_id: &str,
        credential_revision: Option<u64>,
    ) -> RosterEntry {
        let mut entry = RosterEntry {
            epoch,
            employee_id: employee_id.to_string(),
            credential_revision,
            signature: String::new(),
            key_id: trusted_of(key).key_id,
        };
        entry.signature = sign_text(key, &roster_entry_message(&entry.key_id, org, group, &entry));
        entry
    }
}
