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
