//! `FakeBackend`: scripted answers and a handle to push [`BackendEvent`]s (tests
//! only). Unscripted calls succeed: `enroll` answers `dev-1` of `org-1` with the
//! RFC 8032 test-1 key as its policy key, `heartbeat` answers `nextPingInMs:
//! 300000`, `unenroll` succeeds, `fetchDesired` answers what [`FakeBackend::publish`]
//! stored (else `not_found`) and `fetchRoster` an empty roster.

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use rulebox_policy::envelope::{PublishedKey, SignedEnvelope};
use tokio::sync::{mpsc, Notify};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::{
    Backend, BackendError, BackendEvent, DesiredFetch, DeviceAuth, EnrollRequest, EnrollResponse, Head,
    HeartbeatResponse, RosterFetch, StatusReport, CODE_NOT_FOUND,
};
use crate::state::lock;
use crate::testutil::signing::{envelope, test_key, trusted_of};

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
    /// What `fetchDesired` answers per version; a version not here is `not_found`.
    bodies: Mutex<BTreeMap<u64, Result<SignedEnvelope, BackendError>>>,
    desired_calls: Mutex<Vec<u64>>,
    roster_script: Mutex<VecDeque<Result<RosterFetch, BackendError>>>,
    roster_calls: Mutex<Vec<u64>>,
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
                bodies: Mutex::new(BTreeMap::new()),
                desired_calls: Mutex::new(Vec::new()),
                roster_script: Mutex::new(VecDeque::new()),
                roster_calls: Mutex::new(Vec::new()),
            }),
        }
    }

    /// What `fetchDesired(version)` answers from now on.
    pub fn store_body(&self, version: u64, answer: Result<SignedEnvelope, BackendError>) {
        lock(&self.inner.bodies).insert(version, answer);
    }

    /// The head-state event for `envelope` (keys = `keys`, nothing retired).
    pub fn head_event(envelope: &SignedEnvelope, roster_epoch: u64, keys: Vec<PublishedKey>) -> BackendEvent {
        BackendEvent::Desired(DesiredFetch::Ok {
            head: Some(Head {
                version: envelope.version,
                content_hash: "c".to_string(),
                key_id: envelope.key_id.clone(),
                ping_interval_ms: 1_800_000,
                ping_nonce: 0,
                fast_until: 0,
                roster_epoch,
                plan_state: "ok".to_string(),
            }),
            keys,
            retired_key_ids: Vec::new(),
        })
    }

    /// The published key list of the test-1 key alone.
    pub fn test_keys() -> Vec<PublishedKey> {
        let key = trusted_of(&test_key());
        vec![PublishedKey { key_id: key.key_id, public_key: key.public_key, endorsement: None }]
    }

    /// Publishes like the server: stores `envelope` as the body of its version and
    /// pushes the head that announces it.
    pub fn publish(&self, envelope: SignedEnvelope) {
        let event = Self::head_event(&envelope, 0, Self::test_keys());
        self.store_body(envelope.version, Ok(envelope));
        self.push(event);
    }

    /// [`Self::publish`] of `doc` signed by the test-1 key for `org-1` / `dev-1`.
    pub fn publish_doc(&self, version: u64, doc: serde_json::Value) {
        self.publish(envelope(&test_key(), "org-1", "dev-1", version, &doc));
    }

    pub fn desired_calls(&self) -> Vec<u64> {
        lock(&self.inner.desired_calls).clone()
    }

    pub fn script_roster(&self, result: Result<RosterFetch, BackendError>) {
        lock(&self.inner.roster_script).push_back(result);
    }

    pub fn roster_calls(&self) -> Vec<u64> {
        lock(&self.inner.roster_calls).clone()
    }

    pub fn script_enroll(&self, result: Result<EnrollResponse, BackendError>) {
        lock(&self.inner.enroll_script).push_back(result);
    }

    #[allow(dead_code)]
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
                    policy_keys: vec![trusted_of(&test_key())],
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

    fn fetch_desired(&self, _auth: &DeviceAuth, version: u64) -> BoxFuture<'_, Result<SignedEnvelope, BackendError>> {
        async move {
            lock(&self.inner.desired_calls).push(version);
            self.inner.changed.notify_waiters();
            lock(&self.inner.bodies)
                .get(&version)
                .cloned()
                .unwrap_or_else(|| Err(BackendError::Rejected { code: CODE_NOT_FOUND.to_string() }))
        }
        .boxed()
    }

    fn fetch_roster(&self, _auth: &DeviceAuth, since_epoch: u64) -> BoxFuture<'_, Result<RosterFetch, BackendError>> {
        async move {
            lock(&self.inner.roster_calls).push(since_epoch);
            self.inner.changed.notify_waiters();
            lock(&self.inner.roster_script)
                .pop_front()
                .unwrap_or(Ok(RosterFetch::Entries { epoch: 0, entries: Vec::new() }))
        }
        .boxed()
    }
}
