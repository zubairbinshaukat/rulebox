//! `FakeBackend`: scripted answers and a handle to push [`BackendEvent`]s (tests
//! only). Unscripted calls succeed: `enroll` answers `dev-1` of `org-1` with the
//! RFC 8032 test-1 key as its policy key, `ping` answers `nextPingInMs: 1800000`,
//! `report` accepts everything, `verifyEmployee` answers `wrongCredentials`,
//! `rotateCredential` and `unenroll` succeed, `fetchDesired` answers what
//! [`FakeBackend::publish`] stored (else `not_found`) and `fetchRoster` an empty
//! roster. A secret given to [`FakeBackend::reject_secret`] gets `device_rejected`
//! from every device call (the server dropped it).

use std::collections::{BTreeMap, BTreeSet, VecDeque};
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
    Backend, BackendError, BackendEvent, DesiredFetch, DeviceAuth, EnrollRequest, EnrollResponse, Head, PingResponse,
    ReportAccepted, ReportBatch, RosterFetch, VerifyAnswer, CODE_DEVICE_REJECTED, CODE_NOT_FOUND,
};
use super::reports::LockdownCall;
use crate::state::lock;
use crate::testutil::signing::{envelope, test_key, trusted_of};

#[derive(Debug, Clone)]
pub struct PingCall {
    pub at: Instant,
    pub auth: DeviceAuth,
}

#[derive(Debug, Clone)]
pub struct ReportCall {
    #[allow(dead_code)]
    pub at: Instant,
    pub auth: DeviceAuth,
    pub batch: ReportBatch,
}

/// The default ping answer: 30 minutes, nothing to rotate.
pub fn ping_ok(next_ping_in_ms: u64) -> PingResponse {
    PingResponse { next_ping_in_ms, server_time_ms: None, rotate_credential: false, plan_state: "ok".into() }
}

fn rejected() -> BackendError {
    BackendError::Rejected { code: CODE_DEVICE_REJECTED.to_string() }
}

struct Inner {
    enroll_script: Mutex<VecDeque<Result<EnrollResponse, BackendError>>>,
    enroll_calls: Mutex<Vec<EnrollRequest>>,
    /// How long `enroll` takes before it answers.
    enroll_delay: Mutex<Duration>,
    ping_script: Mutex<VecDeque<Result<PingResponse, BackendError>>>,
    ping_calls: Mutex<Vec<PingCall>>,
    report_script: Mutex<VecDeque<Result<ReportAccepted, BackendError>>>,
    report_calls: Mutex<Vec<ReportCall>>,
    verify_script: Mutex<VecDeque<Result<VerifyAnswer, BackendError>>>,
    /// `(auth, username)`; the password is not kept.
    verify_calls: Mutex<Vec<(DeviceAuth, String)>>,
    rotate_script: Mutex<VecDeque<Result<(), BackendError>>>,
    /// `(auth, new secret hash)`.
    rotate_calls: Mutex<Vec<(DeviceAuth, String)>>,
    rejected_secrets: Mutex<BTreeSet<String>>,
    /// When set, a device call with any other secret is `device_rejected`.
    accept_only: Mutex<Option<BTreeSet<String>>>,
    /// Pings with a secret other than this one wait this long before they answer.
    ping_delay_except: Mutex<Option<(String, Duration)>>,
    /// Pings with a secret other than this one fail with this error.
    ping_fail_except: Mutex<Option<(String, BackendError)>>,
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
    lockdown_script: Mutex<VecDeque<Result<(), BackendError>>>,
    lockdown_calls: Mutex<Vec<LockdownCallRecord>>,
}

/// (Phase 5 Step 9) One `lockdown_report` call.
#[derive(Debug, Clone)]
pub struct LockdownCallRecord {
    #[allow(dead_code)]
    pub at: Instant,
    pub auth: DeviceAuth,
    pub call: LockdownCall,
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
                ping_script: Mutex::new(VecDeque::new()),
                ping_calls: Mutex::new(Vec::new()),
                report_script: Mutex::new(VecDeque::new()),
                report_calls: Mutex::new(Vec::new()),
                verify_script: Mutex::new(VecDeque::new()),
                verify_calls: Mutex::new(Vec::new()),
                rotate_script: Mutex::new(VecDeque::new()),
                rotate_calls: Mutex::new(Vec::new()),
                rejected_secrets: Mutex::new(BTreeSet::new()),
                accept_only: Mutex::new(None),
                ping_delay_except: Mutex::new(None),
                ping_fail_except: Mutex::new(None),
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
                lockdown_script: Mutex::new(VecDeque::new()),
                lockdown_calls: Mutex::new(Vec::new()),
            }),
        }
    }

    /// (Phase 5 Step 9) The answer of the next lockdown report (default: accepted).
    pub fn script_lockdown(&self, result: Result<(), BackendError>) {
        lock(&self.inner.lockdown_script).push_back(result);
    }

    /// (Phase 5 Step 9) Every lockdown report call so far, in order.
    pub fn lockdown_calls(&self) -> Vec<LockdownCallRecord> {
        lock(&self.inner.lockdown_calls).clone()
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

    pub fn script_ping(&self, result: Result<PingResponse, BackendError>) {
        lock(&self.inner.ping_script).push_back(result);
    }

    pub fn script_report(&self, result: Result<ReportAccepted, BackendError>) {
        lock(&self.inner.report_script).push_back(result);
    }

    pub fn script_verify(&self, result: Result<VerifyAnswer, BackendError>) {
        lock(&self.inner.verify_script).push_back(result);
    }

    pub fn script_rotate(&self, result: Result<(), BackendError>) {
        lock(&self.inner.rotate_script).push_back(result);
    }

    /// From now on every device call made with `secret` is `device_rejected`.
    pub fn reject_secret(&self, secret: &str) {
        lock(&self.inner.rejected_secrets).insert(secret.to_string());
    }

    /// From now on only these secrets are known to the server; every device call
    /// with another one is `device_rejected` (a cloned image, say).
    pub fn accept_only(&self, secrets: &[&str]) {
        *lock(&self.inner.accept_only) = Some(secrets.iter().map(|s| (*s).to_string()).collect());
    }

    /// Pings made with any secret but `secret` wait `delay` before they answer.
    pub fn delay_pings_except(&self, secret: &str, delay: Duration) {
        *lock(&self.inner.ping_delay_except) = Some((secret.to_string(), delay));
    }

    /// Pings made with any secret but `secret` fail with `error` (`None`: stop).
    pub fn fail_pings_except(&self, secret: &str, error: Option<BackendError>) {
        *lock(&self.inner.ping_fail_except) = error.map(|error| (secret.to_string(), error));
    }

    fn is_rejected(&self, auth: &DeviceAuth) -> bool {
        lock(&self.inner.rejected_secrets).contains(&auth.device_secret)
            || lock(&self.inner.accept_only)
                .as_ref()
                .is_some_and(|known| !known.contains(&auth.device_secret))
    }

    pub fn ping_calls(&self) -> Vec<PingCall> {
        lock(&self.inner.ping_calls).clone()
    }

    pub fn report_calls(&self) -> Vec<ReportCall> {
        lock(&self.inner.report_calls).clone()
    }

    pub fn verify_calls(&self) -> Vec<(DeviceAuth, String)> {
        lock(&self.inner.verify_calls).clone()
    }

    pub fn rotate_calls(&self) -> Vec<(DeviceAuth, String)> {
        lock(&self.inner.rotate_calls).clone()
    }

    pub async fn wait_for_pings(&self, count: usize) {
        self.wait_until("pings", |fake| fake.ping_calls().len() >= count).await;
    }

    #[allow(dead_code)]
    pub async fn wait_for_reports(&self, count: usize) {
        self.wait_until("reports", |fake| fake.report_calls().len() >= count).await;
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

    fn ping(&self, auth: &DeviceAuth) -> BoxFuture<'_, Result<PingResponse, BackendError>> {
        let call = PingCall { at: Instant::now(), auth: auth.clone() };
        async move {
            let secret = call.auth.device_secret.clone();
            lock(&self.inner.ping_calls).push(call.clone());
            self.inner.changed.notify_waiters();
            let delay = lock(&self.inner.ping_delay_except).clone();
            if let Some((except, delay)) = delay {
                if except != secret {
                    tokio::time::sleep(delay).await;
                }
            }
            let failure = lock(&self.inner.ping_fail_except).clone();
            if let Some((except, error)) = failure {
                if except != secret {
                    return Err(error);
                }
            }
            if self.is_rejected(&call.auth) {
                return Err(rejected());
            }
            lock(&self.inner.ping_script).pop_front().unwrap_or_else(|| Ok(ping_ok(1_800_000)))
        }
        .boxed()
    }

    fn report<'a>(&'a self, auth: &DeviceAuth, batch: &ReportBatch) -> BoxFuture<'a, Result<ReportAccepted, BackendError>> {
        let call = ReportCall { at: Instant::now(), auth: auth.clone(), batch: batch.clone() };
        async move {
            let rejected_secret = self.is_rejected(&call.auth);
            let all = ReportAccepted { installs: call.batch.installs.len(), audit: call.batch.audit.len() };
            lock(&self.inner.report_calls).push(call);
            self.inner.changed.notify_waiters();
            if rejected_secret {
                return Err(rejected());
            }
            lock(&self.inner.report_script).pop_front().unwrap_or(Ok(all))
        }
        .boxed()
    }

    fn lockdown_report<'a>(&'a self, auth: &DeviceAuth, call: &LockdownCall) -> BoxFuture<'a, Result<(), BackendError>> {
        let record = LockdownCallRecord { at: Instant::now(), auth: auth.clone(), call: call.clone() };
        async move {
            let rejected_secret = self.is_rejected(&record.auth);
            lock(&self.inner.lockdown_calls).push(record);
            self.inner.changed.notify_waiters();
            if rejected_secret {
                return Err(rejected());
            }
            lock(&self.inner.lockdown_script).pop_front().unwrap_or(Ok(()))
        }
        .boxed()
    }

    fn verify_employee<'a>(
        &'a self,
        auth: &DeviceAuth,
        username: &str,
        _password: &str,
    ) -> BoxFuture<'a, Result<VerifyAnswer, BackendError>> {
        let call = (auth.clone(), username.to_string());
        async move {
            let rejected_secret = self.is_rejected(&call.0);
            lock(&self.inner.verify_calls).push(call);
            self.inner.changed.notify_waiters();
            if rejected_secret {
                return Err(rejected());
            }
            lock(&self.inner.verify_script).pop_front().unwrap_or(Ok(VerifyAnswer::WrongCredentials))
        }
        .boxed()
    }

    fn rotate_credential<'a>(&'a self, auth: &DeviceAuth, new_secret_hash: &str) -> BoxFuture<'a, Result<(), BackendError>> {
        let call = (auth.clone(), new_secret_hash.to_string());
        async move {
            let rejected_secret = self.is_rejected(&call.0);
            lock(&self.inner.rotate_calls).push(call);
            self.inner.changed.notify_waiters();
            if rejected_secret {
                return Err(rejected());
            }
            lock(&self.inner.rotate_script).pop_front().unwrap_or(Ok(()))
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
