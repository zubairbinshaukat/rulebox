//! `FakeBackend`: scripted answers and a handle to push [`BackendEvent`]s (tests
//! only). Unscripted calls succeed: `enroll` answers `dev-1`, `heartbeat` answers
//! `nextPingInMs: 300000`, `unenroll` succeeds.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use tokio::sync::{mpsc, Notify};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::{
    Backend, BackendError, BackendEvent, DeviceAuth, EnrollRequest, EnrollResponse, HeartbeatResponse,
    StatusReport,
};
use crate::state::lock;

#[derive(Debug, Clone)]
pub struct HeartbeatCall {
    pub at: Instant,
    pub auth: DeviceAuth,
    pub status: Option<StatusReport>,
}

struct Inner {
    enroll_script: Mutex<VecDeque<Result<EnrollResponse, BackendError>>>,
    enroll_calls: Mutex<Vec<EnrollRequest>>,
    /// How long `enroll` takes before it answers.
    enroll_delay: Mutex<Duration>,
    heartbeat_script: Mutex<VecDeque<Result<HeartbeatResponse, BackendError>>>,
    heartbeat_calls: Mutex<Vec<HeartbeatCall>>,
    unenroll_script: Mutex<VecDeque<Result<(), BackendError>>>,
    unenroll_calls: Mutex<Vec<DeviceAuth>>,
    events_tx: mpsc::UnboundedSender<BackendEvent>,
    events_rx: Mutex<Option<mpsc::UnboundedReceiver<BackendEvent>>>,
    subscriptions: Mutex<Vec<DeviceAuth>>,
    changed: Notify,
    subscribe_count: AtomicUsize,
}

#[derive(Clone)]
pub struct FakeBackend {
    inner: Arc<Inner>,
}

impl FakeBackend {
    pub fn new() -> Self {
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        Self {
            inner: Arc::new(Inner {
                enroll_script: Mutex::new(VecDeque::new()),
                enroll_calls: Mutex::new(Vec::new()),
                enroll_delay: Mutex::new(Duration::ZERO),
                heartbeat_script: Mutex::new(VecDeque::new()),
                heartbeat_calls: Mutex::new(Vec::new()),
                unenroll_script: Mutex::new(VecDeque::new()),
                unenroll_calls: Mutex::new(Vec::new()),
                events_tx,
                events_rx: Mutex::new(Some(events_rx)),
                subscriptions: Mutex::new(Vec::new()),
                changed: Notify::new(),
                subscribe_count: AtomicUsize::new(0),
            }),
        }
    }

    pub fn script_enroll(&self, result: Result<EnrollResponse, BackendError>) {
        lock(&self.inner.enroll_script).push_back(result);
    }

    pub fn set_enroll_delay(&self, delay: Duration) {
        *lock(&self.inner.enroll_delay) = delay;
    }

    pub fn script_heartbeat(&self, result: Result<HeartbeatResponse, BackendError>) {
        lock(&self.inner.heartbeat_script).push_back(result);
    }

    pub fn script_unenroll(&self, result: Result<(), BackendError>) {
        lock(&self.inner.unenroll_script).push_back(result);
    }

    /// Delivered to the subscriber (buffered until one subscribes).
    pub fn push(&self, event: BackendEvent) {
        let _ = self.inner.events_tx.send(event);
    }

    pub fn enroll_calls(&self) -> Vec<EnrollRequest> {
        lock(&self.inner.enroll_calls).clone()
    }

    pub fn heartbeat_calls(&self) -> Vec<HeartbeatCall> {
        lock(&self.inner.heartbeat_calls).clone()
    }

    pub fn unenroll_calls(&self) -> Vec<DeviceAuth> {
        lock(&self.inner.unenroll_calls).clone()
    }

    pub fn subscriptions(&self) -> Vec<DeviceAuth> {
        lock(&self.inner.subscriptions).clone()
    }

    /// Waits until `condition` holds, woken by every call the fake receives.
    pub async fn wait_until(&self, what: &str, mut condition: impl FnMut(&FakeBackend) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let notified = self.inner.changed.notified();
            if condition(self) {
                return;
            }
            tokio::select! {
                () = notified => {}
                () = tokio::time::sleep_until(deadline) => panic!("timed out waiting for {what}"),
            }
        }
    }

    pub async fn wait_for_heartbeats(&self, count: usize) {
        self.wait_until("heartbeats", |fake| fake.heartbeat_calls().len() >= count).await;
    }

    pub async fn wait_for_subscription(&self) {
        self.wait_until("the subscription", |fake| {
            fake.inner.subscribe_count.load(Ordering::SeqCst) > 0
        })
        .await;
    }
}

impl Backend for FakeBackend {
    fn enroll(&self, req: EnrollRequest) -> BoxFuture<'_, Result<EnrollResponse, BackendError>> {
        async move {
            lock(&self.inner.enroll_calls).push(req.clone());
            self.inner.changed.notify_waiters();
            let delay = *lock(&self.inner.enroll_delay);
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            match lock(&self.inner.enroll_script).pop_front() {
                Some(result) => result,
                None => Ok(EnrollResponse {
                    device_id: "dev-1".to_string(),
                    org_id: "org-1".to_string(),
                    device_name: req.device_name,
                    server_time_ms: 1_760_000_000_000,
                }),
            }
        }
        .boxed()
    }

    fn heartbeat(
        &self,
        auth: &DeviceAuth,
        status: Option<StatusReport>,
    ) -> BoxFuture<'_, Result<HeartbeatResponse, BackendError>> {
        let call = HeartbeatCall { at: Instant::now(), auth: auth.clone(), status };
        async move {
            lock(&self.inner.heartbeat_calls).push(call);
            self.inner.changed.notify_waiters();
            match lock(&self.inner.heartbeat_script).pop_front() {
                Some(result) => result,
                None => Ok(HeartbeatResponse { next_ping_in_ms: 300_000, server_time_ms: 1_760_000_000_000 }),
            }
        }
        .boxed()
    }

    fn unenroll(&self, auth: &DeviceAuth) -> BoxFuture<'_, Result<(), BackendError>> {
        let auth = auth.clone();
        async move {
            lock(&self.inner.unenroll_calls).push(auth);
            self.inner.changed.notify_waiters();
            lock(&self.inner.unenroll_script).pop_front().unwrap_or(Ok(()))
        }
        .boxed()
    }

    fn subscribe(
        &self,
        auth: DeviceAuth,
        tx: mpsc::Sender<BackendEvent>,
        shutdown: CancellationToken,
    ) -> BoxFuture<'_, ()> {
        async move {
            lock(&self.inner.subscriptions).push(auth);
            self.inner.subscribe_count.fetch_add(1, Ordering::SeqCst);
            self.inner.changed.notify_waiters();
            let rx = lock(&self.inner.events_rx).take();
            let Some(mut rx) = rx else {
                shutdown.cancelled().await;
                return;
            };
            loop {
                tokio::select! {
                    () = shutdown.cancelled() => break,
                    event = rx.recv() => match event {
                        Some(event) => {
                            if tx.send(event).await.is_err() {
                                break;
                            }
                        }
                        None => {
                            shutdown.cancelled().await;
                            break;
                        }
                    },
                }
            }
            // Hand the queue back: a later subscription (the task restarted) still
            // receives what is pushed.
            *lock(&self.inner.events_rx) = Some(rx);
        }
        .boxed()
    }
}
