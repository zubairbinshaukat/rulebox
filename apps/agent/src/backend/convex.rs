//! `ConvexBackend`: the real [`Backend`], on the `convex` crate (plan Section 5.8).
//!
//! One `ConvexClient` per deployment URL, built lazily on first use with a
//! state-change channel of capacity 16 that a forwarding task always drains. The
//! client reconnects by itself (100 ms to 15 s backoff) and `ConvexClient::new` does
//! not touch the network. It has no proxy support and its one-shot calls wait
//! forever while offline, so every one of them runs under [`CALL_TIMEOUT`].
//!
//! The logic that is worth testing without a network is in the free functions
//! (argument builders, answer parsers); the methods only move bytes.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use convex::{ConvexClient, ConvexClientBuilder, FunctionResult, Value, WebSocketState};
use futures_util::future::BoxFuture;
use futures_util::{FutureExt, StreamExt};
use rulebox_ipc::types::ConnectionStatus;
use serde_json::Value as Json;
use tokio::sync::{mpsc, watch, OnceCell};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use rulebox_policy::envelope::{Endorsement, PublishedKey, SignedEnvelope, TrustedKey};
use rulebox_policy::roster::{RosterEntry, RosterSnapshot};

use super::reports::{lockdown_args, LockdownCall};
use super::value::{from_json, to_json};
use super::{
    Backend, BackendError, BackendEvent, BackendFactory, DesiredFetch, DeviceAuth, EnrollRequest,
    EnrollResponse, Head, PingResponse, ReportAccepted, ReportBatch, RosterFetch, VerifyAnswer, CALL_TIMEOUT,
};

/// Convex function names.
pub const FN_ENROLL: &str = "enrollment:enroll";
/// (Phase 4 Step 9) The one subscription; it replaced `devices:desiredState`.
pub const FN_HEAD_STATE: &str = "devices:headState";
pub const FN_FETCH_DESIRED: &str = "devices:fetchDesired";
pub const FN_FETCH_ROSTER: &str = "devices:fetchRoster";
/// (Step 13) Liveness; it replaced `devices:heartbeat` (the server alias was
/// removed in Phase 6 Step 3).
pub const FN_PING: &str = "devices:ping";
pub const FN_UNENROLL: &str = "devices:unenroll";
/// (Step 13) The batched status, installs and audit records.
pub const FN_REPORT: &str = "deviceApi:report";
/// (Step 13) An action.
pub const FN_VERIFY_EMPLOYEE: &str = "deviceApi:verifyEmployee";
pub const FN_ROTATE_CREDENTIAL: &str = "deviceApi:rotateCredential";

/// Capacity of the client's state-change channel (plan Section 5.8).
const STATE_CHANNEL: usize = 16;
/// Wait before the next try when the subscription could not be set up.
const RESUBSCRIBE_BASE: Duration = Duration::from_secs(5);
const RESUBSCRIBE_MAX: Duration = Duration::from_secs(60);
/// Largest absolute value of a millisecond count we accept from the server (2^53).
const MAX_EXACT: f64 = 9_007_199_254_740_992.0;

// -- arguments --------------------------------------------------------------------

fn text(value: &str) -> Value {
    Value::String(value.to_string())
}

/// `{ deviceId, deviceSecret }`.
pub fn auth_args(auth: &DeviceAuth) -> BTreeMap<String, Value> {
    BTreeMap::from([
        ("deviceId".to_string(), text(&auth.device_id)),
        ("deviceSecret".to_string(), text(&auth.device_secret)),
    ])
}

/// The arguments of `enrollment:enroll`. `hardwareIdHash` is left out when unknown
/// (it is `v.optional(v.string())`, so `null` would be refused).
pub fn enroll_args(request: &EnrollRequest) -> BTreeMap<String, Value> {
    let mut args = BTreeMap::from([
        ("token".to_string(), text(&request.token)),
        ("deviceSecretHash".to_string(), text(&request.device_secret_hash)),
        ("deviceName".to_string(), text(&request.device_name)),
        ("agentVersion".to_string(), text(&request.agent_version)),
        ("compat".to_string(), from_json(&request.compat)),
    ]);
    if let Some(hash) = &request.hardware_id_hash {
        args.insert("hardwareIdHash".to_string(), text(hash));
    }
    args
}

/// The arguments of `deviceApi:report`: the credentials and only the parts that
/// carry something (`status` is a full snapshot, so it is left out when it did not
/// change; an absent part is `v.optional`).
pub fn report_args(auth: &DeviceAuth, batch: &ReportBatch) -> BTreeMap<String, Value> {
    let mut args = auth_args(auth);
    if let Some(status) = &batch.status {
        // A `StatusReport` always serializes; the null cannot happen.
        let json = serde_json::to_value(status).unwrap_or(Json::Null);
        args.insert("status".to_string(), from_json(&json));
    }
    if !batch.installs.is_empty() {
        let json = serde_json::to_value(&batch.installs).unwrap_or(Json::Null);
        args.insert("installs".to_string(), from_json(&json));
    }
    if !batch.audit.is_empty() || batch.dropped > 0 {
        let records = serde_json::to_value(&batch.audit).unwrap_or(Json::Null);
        let part = serde_json::json!({ "records": records, "dropped": batch.dropped });
        args.insert("audit".to_string(), from_json(&part));
    }
    args
}

/// The arguments of `deviceApi:verifyEmployee`. They hold the password: never log
/// them (nothing in this file logs arguments).
pub fn verify_args(auth: &DeviceAuth, username: &str, password: &str) -> BTreeMap<String, Value> {
    let mut args = auth_args(auth);
    args.insert("username".to_string(), text(username));
    args.insert("password".to_string(), text(password));
    args
}

/// The arguments of `deviceApi:rotateCredential`: only the hash of the new secret
/// travels.
pub fn rotate_args(auth: &DeviceAuth, new_secret_hash: &str) -> BTreeMap<String, Value> {
    let mut args = auth_args(auth);
    args.insert("newSecretHash".to_string(), text(new_secret_hash));
    args
}

/// The credentials and one whole-number argument (`v.number()`: a float on the wire).
pub fn number_args(auth: &DeviceAuth, name: &str, value: u64) -> BTreeMap<String, Value> {
    let mut args = auth_args(auth);
    args.insert(name.to_string(), Value::Float64(value as f64));
    args
}

// -- answers ----------------------------------------------------------------------

fn protocol(what: &str) -> BackendError {
    BackendError::Protocol(what.to_string())
}

fn field<'a>(json: &'a Json, name: &str) -> Result<&'a Json, BackendError> {
    json.get(name).ok_or_else(|| BackendError::Protocol(format!("the answer has no \"{name}\"")))
}

fn string_field(json: &Json, name: &str) -> Result<String, BackendError> {
    field(json, name)?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| BackendError::Protocol(format!("\"{name}\" is not text")))
}

/// A non-negative whole number of at most 2^53, from a value that went through
/// [`to_json`] (an integral float is already an integer there).
fn whole_number(json: &Json, name: &str) -> Result<u64, BackendError> {
    let number = field(json, name)?;
    if let Some(value) = number.as_u64() {
        if (value as f64) <= MAX_EXACT {
            return Ok(value);
        }
    }
    Err(BackendError::Protocol(format!("\"{name}\" is not a whole number")))
}

fn time_ms(json: &Json, name: &str) -> Result<i64, BackendError> {
    let value = whole_number(json, name)?;
    i64::try_from(value).map_err(|_| protocol("a time is out of range"))
}

fn array_field<'a>(json: &'a Json, name: &str) -> Result<&'a Vec<Json>, BackendError> {
    field(json, name)?
        .as_array()
        .ok_or_else(|| BackendError::Protocol(format!("\"{name}\" is not a list")))
}

/// `{ deviceId, orgId, deviceName, serverTimeMs, policyKeys: [{ keyId, publicKey }] }`.
/// An answer without `policyKeys`, with none, or with a key whose id is not the id
/// of its key, is a `Protocol` error: a device is never enrolled without a root
/// of trust.
pub fn parse_enroll_response(json: &Json) -> Result<EnrollResponse, BackendError> {
    let mut policy_keys = Vec::new();
    for key in array_field(json, "policyKeys")? {
        let key = TrustedKey::checked(&string_field(key, "keyId")?, &string_field(key, "publicKey")?)
            .map_err(|error| BackendError::Protocol(format!("a policy key is not valid ({error})")))?;
        if !policy_keys.contains(&key) {
            policy_keys.push(key);
        }
    }
    if policy_keys.is_empty() {
        return Err(protocol("the enrollment answer has no policy key"));
    }
    Ok(EnrollResponse {
        device_id: string_field(json, "deviceId")?,
        org_id: string_field(json, "orgId")?,
        device_name: string_field(json, "deviceName")?,
        server_time_ms: time_ms(json, "serverTimeMs")?,
        policy_keys,
    })
}

/// `{ nextPingInMs, planState, rotateCredential }` (`devices:ping`). A missing
/// `rotateCredential` is false and a missing `planState` is `"ok"`, so a server
/// that does not send them never starts a rotation; `serverTimeMs` is read when
/// present (`devices:ping` sends it).
pub fn parse_ping_response(json: &Json) -> Result<PingResponse, BackendError> {
    if json.get("kind").and_then(Json::as_str) == Some("rejected") {
        return Err(BackendError::Rejected { code: super::CODE_DEVICE_REJECTED.to_string() });
    }
    let rotate_credential = match json.get("rotateCredential") {
        None | Some(Json::Null) => false,
        Some(Json::Bool(rotate)) => *rotate,
        Some(_) => return Err(protocol("\"rotateCredential\" is not a boolean")),
    };
    let plan_state = match json.get("planState") {
        None | Some(Json::Null) => "ok".to_string(),
        Some(_) => string_field(json, "planState")?,
    };
    let server_time_ms = match json.get("serverTimeMs") {
        None | Some(Json::Null) => None,
        Some(_) => Some(time_ms(json, "serverTimeMs")?),
    };
    Ok(PingResponse { next_ping_in_ms: whole_number(json, "nextPingInMs")?, server_time_ms, rotate_credential, plan_state })
}

/// `{ accepted: { installs, audit } }`.
pub fn parse_report_response(json: &Json) -> Result<ReportAccepted, BackendError> {
    let accepted = field(json, "accepted")?;
    let count = |name| whole_number(accepted, name).map(|n| usize::try_from(n).unwrap_or(usize::MAX));
    Ok(ReportAccepted { installs: count("installs")?, audit: count("audit")? })
}

/// `{ kind: "ok", employee: { id, username, name, role, quotaBytes }, offlineDays,
/// credentialRevision } | { kind: "wrongCredentials" | "disabled" |
/// "notAllowedHere" } | { kind: "lockedOut", retryAfterMs }`.
pub fn parse_verify_response(json: &Json) -> Result<VerifyAnswer, BackendError> {
    match string_field(json, "kind")?.as_str() {
        "ok" => {
            let employee = field(json, "employee")?;
            let role = match employee.get("role") {
                None | Some(Json::Null) => None,
                Some(_) => Some(string_field(employee, "role")?),
            };
            let offline_days = whole_number(json, "offlineDays")?;
            Ok(VerifyAnswer::Ok {
                employee: rulebox_ipc::requests::Employee {
                    id: string_field(employee, "id")?,
                    username: string_field(employee, "username")?,
                    name: string_field(employee, "name")?,
                    role,
                    quota_bytes: whole_number(employee, "quotaBytes")?,
                },
                // The server bounds it to 0..30; anything larger is clamped, never wrapped.
                offline_days: u32::try_from(offline_days).unwrap_or(u32::MAX),
                credential_revision: whole_number(json, "credentialRevision")?,
            })
        }
        "wrongCredentials" => Ok(VerifyAnswer::WrongCredentials),
        "disabled" => Ok(VerifyAnswer::Disabled),
        "notAllowedHere" => Ok(VerifyAnswer::NotAllowedHere),
        "lockedOut" => Ok(VerifyAnswer::LockedOut { retry_after_ms: whole_number(json, "retryAfterMs")? }),
        _ => Err(protocol("unknown verify answer")),
    }
}

/// `{ kind: "ok" }`.
pub fn parse_rotate_response(json: &Json) -> Result<(), BackendError> {
    match string_field(json, "kind")?.as_str() {
        "ok" => Ok(()),
        _ => Err(protocol("unknown rotation answer")),
    }
}

/// `{ kind: "rejected" } | { kind: "ok" }`. Both are success for the caller: the
/// device wants to be gone, and a rejection means it already is (unknown, revoked
/// or a secret the server no longer knows).
pub fn parse_unenroll_response(json: &Json) -> Result<(), BackendError> {
    match string_field(json, "kind")?.as_str() {
        "ok" | "rejected" => Ok(()),
        _ => Err(protocol("unknown unenroll answer")),
    }
}

fn parse_head(head: &Json) -> Result<Head, BackendError> {
    Ok(Head {
        version: whole_number(head, "version")?,
        content_hash: string_field(head, "contentHash")?,
        key_id: string_field(head, "keyId")?,
        ping_interval_ms: whole_number(head, "pingIntervalMs")?,
        ping_nonce: whole_number(head, "pingNonce")?,
        fast_until: whole_number(head, "fastUntil")?,
        roster_epoch: whole_number(head, "rosterEpoch")?,
        plan_state: string_field(head, "planState")?,
    })
}

fn parse_published_key(key: &Json) -> Result<PublishedKey, BackendError> {
    let endorsement = match field(key, "endorsement")? {
        Json::Null => None,
        e => Some(Endorsement { by_key_id: string_field(e, "byKeyId")?, signature: string_field(e, "signature")? }),
    };
    Ok(PublishedKey { key_id: string_field(key, "keyId")?, public_key: string_field(key, "publicKey")?, endorsement })
}

/// `{ kind: "unknownDevice" } | { kind: "revoked" } | { kind: "ok", head: null |
/// { version, contentHash, keyId, bodyId, pingIntervalMs, pingNonce, fastUntil,
/// rosterEpoch, planState }, keys: [{ keyId, publicKey, endorsement }],
/// retiredKeyIds: [string] }`. The keys are only parsed here; whether they are
/// trusted is `trust::update`'s decision.
pub fn parse_head_state(json: &Json) -> Result<DesiredFetch, BackendError> {
    match string_field(json, "kind")?.as_str() {
        "unknownDevice" => Ok(DesiredFetch::UnknownDevice),
        "revoked" => Ok(DesiredFetch::Revoked),
        "ok" => {
            let head = match field(json, "head")? {
                Json::Null => None,
                head => Some(parse_head(head)?),
            };
            let keys = array_field(json, "keys")?.iter().map(parse_published_key).collect::<Result<_, _>>()?;
            let retired_key_ids = array_field(json, "retiredKeyIds")?
                .iter()
                .map(|id| id.as_str().map(str::to_string).ok_or_else(|| protocol("a retired key id is not text")))
                .collect::<Result<_, _>>()?;
            Ok(DesiredFetch::Ok { head, keys, retired_key_ids })
        }
        _ => Err(protocol("unknown head-state answer")),
    }
}

/// `{ version, payload, signature, keyId }`, kept exactly as received (the
/// signature is over these payload bytes).
pub fn parse_envelope(json: &Json) -> Result<SignedEnvelope, BackendError> {
    Ok(SignedEnvelope {
        version: whole_number(json, "version")?,
        payload: string_field(json, "payload")?,
        signature: string_field(json, "signature")?,
        key_id: string_field(json, "keyId")?,
    })
}

/// `{ epoch, entries: [{ epoch, employeeId, credentialRevision | null, signature,
/// keyId }] } | { snapshot: { epoch, payload, signature, keyId } }`.
pub fn parse_roster_fetch(json: &Json) -> Result<RosterFetch, BackendError> {
    if let Some(snapshot) = json.get("snapshot") {
        return Ok(RosterFetch::Snapshot(RosterSnapshot {
            epoch: whole_number(snapshot, "epoch")?,
            payload: string_field(snapshot, "payload")?,
            signature: string_field(snapshot, "signature")?,
            key_id: string_field(snapshot, "keyId")?,
        }));
    }
    let entries = array_field(json, "entries")?
        .iter()
        .map(|entry| {
            let credential_revision = match field(entry, "credentialRevision")? {
                Json::Null => None,
                _ => Some(whole_number(entry, "credentialRevision")?),
            };
            Ok(RosterEntry {
                epoch: whole_number(entry, "epoch")?,
                employee_id: string_field(entry, "employeeId")?,
                credential_revision,
                signature: string_field(entry, "signature")?,
                key_id: string_field(entry, "keyId")?,
            })
        })
        .collect::<Result<_, BackendError>>()?;
    Ok(RosterFetch::Entries { epoch: whole_number(json, "epoch")?, entries })
}

/// The `code` of a `ConvexError`'s data, or `server_error` when it has none (the
/// data may be any value, or a plain string).
pub fn rejected_code(data: &Json) -> String {
    data.get("code")
        .and_then(Json::as_str)
        .filter(|code| !code.is_empty() && code.len() <= 64)
        .map_or_else(|| "server_error".to_string(), str::to_string)
}

fn function_result(result: FunctionResult) -> Result<Json, BackendError> {
    match result {
        FunctionResult::Value(value) => Ok(to_json(value)),
        FunctionResult::ConvexError(error) => {
            Err(BackendError::Rejected { code: rejected_code(&to_json(error.data)) })
        }
        // The message is deliberately dropped: a validation error quotes the
        // arguments, and the arguments hold the device secret.
        FunctionResult::ErrorMessage(_) => Err(BackendError::Rejected { code: "server_error".to_string() }),
    }
}

fn map_state(state: &WebSocketState) -> ConnectionStatus {
    match state {
        WebSocketState::Connected => ConnectionStatus::Online,
        // "Closed and connecting or reconnecting" is what the Staff App calls offline
        // (plan edge case 1): there is no separate "still trying" state to show.
        WebSocketState::Connecting => ConnectionStatus::Offline,
    }
}

// -- the backend -----------------------------------------------------------------

/// Aborts a task when dropped.
struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct Connected {
    client: ConvexClient,
    /// The latest connection state, fed by a task that drains the client's channel.
    state: watch::Receiver<ConnectionStatus>,
    _forwarder: AbortOnDrop,
}

pub struct ConvexBackend {
    url: String,
    connected: OnceCell<Connected>,
}

impl ConvexBackend {
    /// Does not connect; the client is built on first use.
    pub fn new(url: &str) -> Self {
        Self { url: url.to_string(), connected: OnceCell::new() }
    }

    /// The factory `agent::run` uses on a real agent.
    pub fn factory() -> BackendFactory {
        Arc::new(|url| Ok(Arc::new(ConvexBackend::new(url)) as Arc<dyn Backend>))
    }

    async fn connected(&self) -> Result<&Connected, BackendError> {
        self.connected
            .get_or_try_init(|| async {
                let (state_tx, mut state_rx) = mpsc::channel::<WebSocketState>(STATE_CHANNEL);
                let client = ConvexClientBuilder::new(&self.url)
                    .with_on_state_change(state_tx)
                    .build()
                    .await
                    .map_err(|error| {
                        // A malformed URL is the only way this fails (no network yet).
                        tracing::error!("cannot create the backend client: {error}");
                        BackendError::Protocol("cannot create the backend client".to_string())
                    })?;
                let (status_tx, status_rx) = watch::channel(ConnectionStatus::Offline);
                let forwarder = tokio::spawn(async move {
                    while let Some(state) = state_rx.recv().await {
                        status_tx.send_replace(map_state(&state));
                    }
                });
                Ok(Connected { client, state: status_rx, _forwarder: AbortOnDrop(forwarder) })
            })
            .await
    }

    /// One mutation under the 30-second timeout.
    async fn mutation(&self, name: &str, args: BTreeMap<String, Value>) -> Result<Json, BackendError> {
        let connected = self.connected().await?;
        let mut client = connected.client.clone();
        let outcome = tokio::time::timeout(CALL_TIMEOUT, client.mutation(name, args))
            .await
            .map_err(|_| BackendError::Timeout)?;
        match outcome {
            Ok(result) => function_result(result),
            Err(error) => {
                // The client's own failure (its worker is gone), not a server answer.
                tracing::debug!("backend call {name} failed: {error}");
                Err(BackendError::Unreachable)
            }
        }
    }

    /// One action under the 30-second timeout (the caller may wait less).
    async fn action(&self, name: &str, args: BTreeMap<String, Value>) -> Result<Json, BackendError> {
        let connected = self.connected().await?;
        let mut client = connected.client.clone();
        let outcome = tokio::time::timeout(CALL_TIMEOUT, client.action(name, args))
            .await
            .map_err(|_| BackendError::Timeout)?;
        match outcome {
            Ok(result) => function_result(result),
            Err(error) => {
                tracing::debug!("backend call {name} failed: {error}");
                Err(BackendError::Unreachable)
            }
        }
    }

    /// One one-shot query under the 30-second timeout.
    async fn query(&self, name: &str, args: BTreeMap<String, Value>) -> Result<Json, BackendError> {
        let connected = self.connected().await?;
        let mut client = connected.client.clone();
        let outcome = tokio::time::timeout(CALL_TIMEOUT, client.query(name, args))
            .await
            .map_err(|_| BackendError::Timeout)?;
        match outcome {
            Ok(result) => function_result(result),
            Err(error) => {
                tracing::debug!("backend call {name} failed: {error}");
                Err(BackendError::Unreachable)
            }
        }
    }

    async fn run_subscription(&self, auth: DeviceAuth, tx: mpsc::Sender<BackendEvent>, shutdown: CancellationToken) {
        let mut wait = RESUBSCRIBE_BASE;
        // Set up the subscription, retrying while the client cannot.
        let (mut subscription, mut status_rx) = loop {
            let attempt = async {
                let connected = self.connected().await?;
                let mut client = connected.client.clone();
                let subscription = tokio::time::timeout(
                    CALL_TIMEOUT,
                    client.subscribe(FN_HEAD_STATE, auth_args(&auth)),
                )
                .await
                .map_err(|_| BackendError::Timeout)?
                .map_err(|_| BackendError::Unreachable)?;
                Ok::<_, BackendError>((subscription, connected.state.clone()))
            };
            match attempt.await {
                Ok(ready) => break ready,
                Err(error) => {
                    tracing::warn!("cannot subscribe to the desired state ({error}); retrying in {} s", wait.as_secs());
                    tokio::select! {
                        () = shutdown.cancelled() => return,
                        () = tokio::time::sleep(wait) => {}
                    }
                    wait = (wait * 2).min(RESUBSCRIBE_MAX);
                }
            }
        };

        // The current state first, then every change.
        let first = *status_rx.borrow_and_update();
        if tx.send(BackendEvent::Connection(first)).await.is_err() {
            return;
        }
        let mut status_open = true;
        let mut stream_open = true;
        loop {
            tokio::select! {
                () = shutdown.cancelled() => return,
                changed = status_rx.changed(), if status_open => {
                    if changed.is_err() {
                        status_open = false;
                        continue;
                    }
                    let status = *status_rx.borrow_and_update();
                    if tx.send(BackendEvent::Connection(status)).await.is_err() {
                        return;
                    }
                }
                item = subscription.next(), if stream_open => match item {
                    None => {
                        tracing::warn!("the desired-state subscription ended");
                        stream_open = false;
                    }
                    Some(result) => {
                        let fetch = function_result(result).and_then(|json| parse_head_state(&json));
                        match fetch {
                            Ok(fetch) => {
                                if tx.send(BackendEvent::Desired(fetch)).await.is_err() {
                                    return;
                                }
                            }
                            Err(error) => tracing::warn!("ignoring a head-state answer: {error}"),
                        }
                    }
                },
            }
            if !status_open && !stream_open {
                // Nothing more can arrive; wait for the shutdown instead of spinning.
                shutdown.cancelled().await;
                return;
            }
        }
    }
}

impl Backend for ConvexBackend {
    fn enroll(&self, req: EnrollRequest) -> BoxFuture<'_, Result<EnrollResponse, BackendError>> {
        async move {
            let json = self.mutation(FN_ENROLL, enroll_args(&req)).await?;
            parse_enroll_response(&json)
        }
        .boxed()
    }

    fn ping(&self, auth: &DeviceAuth) -> BoxFuture<'_, Result<PingResponse, BackendError>> {
        let args = auth_args(auth);
        async move {
            let json = self.mutation(FN_PING, args).await?;
            parse_ping_response(&json)
        }
        .boxed()
    }

    fn report<'a>(&'a self, auth: &DeviceAuth, batch: &ReportBatch) -> BoxFuture<'a, Result<ReportAccepted, BackendError>> {
        let args = report_args(auth, batch);
        async move {
            let json = self.mutation(FN_REPORT, args).await?;
            parse_report_response(&json)
        }
        .boxed()
    }

    fn lockdown_report<'a>(&'a self, auth: &DeviceAuth, call: &LockdownCall) -> BoxFuture<'a, Result<(), BackendError>> {
        let name = call.function();
        let args = lockdown_args(auth, call);
        async move {
            self.mutation(name, args).await?;
            Ok(())
        }
        .boxed()
    }

    fn verify_employee<'a>(
        &'a self,
        auth: &DeviceAuth,
        username: &str,
        password: &str,
    ) -> BoxFuture<'a, Result<VerifyAnswer, BackendError>> {
        let args = verify_args(auth, username, password);
        async move {
            let json = self.action(FN_VERIFY_EMPLOYEE, args).await?;
            parse_verify_response(&json)
        }
        .boxed()
    }

    fn rotate_credential<'a>(&'a self, auth: &DeviceAuth, new_secret_hash: &str) -> BoxFuture<'a, Result<(), BackendError>> {
        let args = rotate_args(auth, new_secret_hash);
        async move {
            let json = self.mutation(FN_ROTATE_CREDENTIAL, args).await?;
            parse_rotate_response(&json)
        }
        .boxed()
    }

    fn unenroll(&self, auth: &DeviceAuth) -> BoxFuture<'_, Result<(), BackendError>> {
        let args = auth_args(auth);
        async move {
            let json = self.mutation(FN_UNENROLL, args).await?;
            parse_unenroll_response(&json)
        }
        .boxed()
    }

    fn subscribe(
        &self,
        auth: DeviceAuth,
        tx: mpsc::Sender<BackendEvent>,
        shutdown: CancellationToken,
    ) -> BoxFuture<'_, ()> {
        self.run_subscription(auth, tx, shutdown).boxed()
    }

    fn fetch_desired(&self, auth: &DeviceAuth, version: u64) -> BoxFuture<'_, Result<SignedEnvelope, BackendError>> {
        let args = number_args(auth, "version", version);
        async move {
            let json = self.query(FN_FETCH_DESIRED, args).await?;
            parse_envelope(&json)
        }
        .boxed()
    }

    fn fetch_roster(&self, auth: &DeviceAuth, since_epoch: u64) -> BoxFuture<'_, Result<RosterFetch, BackendError>> {
        let args = number_args(auth, "sinceEpoch", since_epoch);
        async move {
            let json = self.query(FN_FETCH_ROSTER, args).await?;
            parse_roster_fetch(&json)
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{sha256_hex, StatusReport};
    use serde_json::json;

    fn auth() -> DeviceAuth {
        DeviceAuth { device_id: "kd7abc".into(), device_secret: "ab".repeat(32) }
    }

    fn keys(args: &BTreeMap<String, Value>) -> Vec<&str> {
        args.keys().map(String::as_str).collect()
    }

    fn string_arg<'a>(args: &'a BTreeMap<String, Value>, name: &str) -> &'a str {
        match &args[name] {
            Value::String(text) => text,
            other => panic!("{name} is {other:?}"),
        }
    }

    #[test]
    fn function_names_match_the_server() {
        assert_eq!(FN_ENROLL, "enrollment:enroll");
        assert_eq!(FN_HEAD_STATE, "devices:headState");
        assert_eq!(FN_FETCH_DESIRED, "devices:fetchDesired");
        assert_eq!(FN_FETCH_ROSTER, "devices:fetchRoster");
        assert_eq!(FN_PING, "devices:ping");
        assert_eq!(FN_UNENROLL, "devices:unenroll");
        assert_eq!(FN_REPORT, "deviceApi:report");
        assert_eq!(FN_VERIFY_EMPLOYEE, "deviceApi:verifyEmployee");
        assert_eq!(FN_ROTATE_CREDENTIAL, "deviceApi:rotateCredential");
    }

    #[test]
    fn enroll_arguments_have_the_servers_shape() {
        let secret = "cd".repeat(32);
        let request = EnrollRequest {
            token: "0123456789ABCDEFGHJK".into(),
            device_secret_hash: sha256_hex(&secret),
            device_name: "Front desk".into(),
            hardware_id_hash: Some(sha256_hex("machine-guid")),
            agent_version: "0.0.0".into(),
            compat: json!({ "blockers": [], "os": { "build": 26100 } }),
        };
        let args = enroll_args(&request);
        assert_eq!(
            keys(&args),
            ["agentVersion", "compat", "deviceName", "deviceSecretHash", "hardwareIdHash", "token"]
        );
        assert_eq!(string_arg(&args, "token"), "0123456789ABCDEFGHJK");
        assert_eq!(string_arg(&args, "deviceSecretHash"), sha256_hex(&secret));
        // `compat` is `v.any()`; its numbers are floats like every other number.
        let compat = to_json(args["compat"].clone());
        assert_eq!(compat, json!({ "blockers": [], "os": { "build": 26100 } }));

        // `hardwareIdHash` is `v.optional(v.string())`: absent, never null.
        let without = enroll_args(&EnrollRequest { hardware_id_hash: None, ..request });
        assert!(!without.contains_key("hardwareIdHash"));
    }

    /// The hash sent at enrollment is the hash of the secret that every later
    /// `headState`, `ping` and `report` call sends, hashed as text.
    #[test]
    fn the_enrolled_hash_matches_the_secret_later_sent() {
        let auth = auth();
        let enrolled_hash = sha256_hex(&auth.device_secret);
        let desired = auth_args(&auth);
        let report = report_args(&auth, &ReportBatch::default());
        for args in [&desired, &report] {
            assert_eq!(sha256_hex(string_arg(args, "deviceSecret")), enrolled_hash);
            assert_eq!(string_arg(args, "deviceId"), "kd7abc");
        }
        assert_eq!(keys(&desired), ["deviceId", "deviceSecret"]);
        assert_eq!(keys(&report), ["deviceId", "deviceSecret"]);
    }

    #[test]
    fn report_arguments_carry_only_the_parts_that_are_there() {
        use crate::audit::{AuditKind, AuditRecord};
        use crate::backend::{InstallReport, InstallState};
        let record = AuditRecord {
            id: "ab".repeat(16),
            at_ms: 1_760_000_000_000,
            server_time_offset_ms: Some(-5),
            kind: AuditKind::EmployeeLockedOut,
            username: Some("maya".into()),
            detail: Some("password_lockout".into()),
        };
        let install = InstallReport {
            app_id: "app1".into(),
            state: InstallState::Failed,
            app_revision: 3,
            attempts: 2,
            exit_code: Some(1603),
            detail: Some("exit_code".into()),
            installed_version: None,
        };
        let batch = ReportBatch { status: None, installs: vec![install], audit: vec![record], dropped: 4 };
        let args = report_args(&auth(), &batch);
        assert_eq!(keys(&args), ["audit", "deviceId", "deviceSecret", "installs"]);
        assert_eq!(
            to_json(args["audit"].clone()),
            json!({ "records": [{ "id": "ab".repeat(16), "atMs": 1_760_000_000_000_u64, "serverTimeOffsetMs": -5,
                                  "kind": "employeeLockedOut", "username": "maya", "detail": "password_lockout" }],
                    "dropped": 4 })
        );
        assert_eq!(
            to_json(args["installs"].clone()),
            json!([{ "appId": "app1", "state": "failed", "appRevision": 3, "attempts": 2, "exitCode": 1603, "detail": "exit_code" }])
        );
        // (Phase 6 Step 11) `installedVersion`: absent keeps, a text stores, `null` clears.
        let with_version = |version: Option<Option<&str>>| InstallReport {
            app_id: "app1".into(),
            state: InstallState::Installed,
            app_revision: 3,
            attempts: 0,
            exit_code: None,
            detail: None,
            installed_version: version.map(|inner| inner.map(str::to_string)),
        };
        let installs = |versions: Vec<InstallReport>| {
            let args = report_args(&auth(), &ReportBatch { installs: versions, ..ReportBatch::default() });
            to_json(args["installs"].clone())
        };
        assert_eq!(
            installs(vec![with_version(None), with_version(Some(Some("2.1.0.0"))), with_version(Some(None))]),
            json!([
                { "appId": "app1", "state": "installed", "appRevision": 3, "attempts": 0 },
                { "appId": "app1", "state": "installed", "appRevision": 3, "attempts": 0, "installedVersion": "2.1.0.0" },
                { "appId": "app1", "state": "installed", "appRevision": 3, "attempts": 0, "installedVersion": null }
            ])
        );
        let back: InstallReport = serde_json::from_value(json!({ "appId": "a", "state": "installed", "appRevision": 1, "attempts": 0, "installedVersion": null })).unwrap();
        assert_eq!(back.installed_version, Some(None));
        let back: InstallReport = serde_json::from_value(json!({ "appId": "a", "state": "installed", "appRevision": 1, "attempts": 0 })).unwrap();
        assert_eq!(back.installed_version, None);
        // Numbers are floats on the wire (`v.number()`).
        let Value::Object(audit) = &args["audit"] else { panic!("audit is not an object") };
        assert!(matches!(audit["dropped"], Value::Float64(n) if n == 4.0));
        // Only a dropped count still sends the audit part (the server writes one row).
        let only_dropped = report_args(&auth(), &ReportBatch { dropped: 2, ..ReportBatch::default() });
        assert_eq!(to_json(only_dropped["audit"].clone()), json!({ "records": [], "dropped": 2 }));
    }

    #[test]
    fn verify_and_rotate_arguments() {
        let args = verify_args(&auth(), "maya", "pw-value");
        assert_eq!(keys(&args), ["deviceId", "deviceSecret", "password", "username"]);
        assert_eq!(string_arg(&args, "password"), "pw-value");
        let args = rotate_args(&auth(), &"0".repeat(64));
        assert_eq!(keys(&args), ["deviceId", "deviceSecret", "newSecretHash"]);
    }

    #[test]
    fn heartbeat_without_rotate_field_means_false() {
        let bare = parse_ping_response(&json!({ "nextPingInMs": 1_800_000 })).unwrap();
        assert_eq!(
            bare,
            PingResponse { next_ping_in_ms: 1_800_000, server_time_ms: None, rotate_credential: false, plan_state: "ok".into() }
        );
        let full = parse_ping_response(&json!({ "nextPingInMs": 60_000, "planState": "overLimit", "rotateCredential": true }))
            .unwrap();
        assert!(full.rotate_credential);
        assert_eq!(full.plan_state, "overLimit");
        // The `heartbeat` alias' shape parses too, server time included.
        let alias = parse_ping_response(&json!({ "kind": "ok", "nextPingInMs": 5, "serverTimeMs": 7, "rotateCredential": false }))
            .unwrap();
        assert_eq!(alias.server_time_ms, Some(7));
        assert_eq!(
            parse_ping_response(&json!({ "kind": "rejected" })),
            Err(BackendError::Rejected { code: "device_rejected".into() })
        );
        assert!(matches!(parse_ping_response(&json!({})), Err(BackendError::Protocol(_))));
        assert!(matches!(
            parse_ping_response(&json!({ "nextPingInMs": 5, "rotateCredential": "yes" })),
            Err(BackendError::Protocol(_))
        ));
    }

    #[test]
    fn report_verify_and_rotate_answers() {
        let accepted = parse_report_response(&to_json(from_json(&json!({ "accepted": { "installs": 3, "audit": 5 } }))));
        assert_eq!(accepted, Ok(ReportAccepted { installs: 3, audit: 5 }));
        assert!(parse_report_response(&json!({ "accepted": 5 })).is_err());

        let ok = json!({ "kind": "ok", "employee": { "id": "e1", "username": "maya", "name": "Maya", "role": null,
                         "quotaBytes": 10_737_418_240_u64 }, "offlineDays": 3, "credentialRevision": 7 });
        let VerifyAnswer::Ok { employee, offline_days, credential_revision } =
            parse_verify_response(&to_json(from_json(&ok))).unwrap()
        else {
            panic!("expected ok");
        };
        assert_eq!((employee.id.as_str(), employee.role, employee.quota_bytes), ("e1", None, 10_737_418_240));
        assert_eq!((offline_days, credential_revision), (3, 7));
        for (kind, answer) in [
            ("wrongCredentials", VerifyAnswer::WrongCredentials),
            ("disabled", VerifyAnswer::Disabled),
            ("notAllowedHere", VerifyAnswer::NotAllowedHere),
        ] {
            assert_eq!(parse_verify_response(&json!({ "kind": kind })), Ok(answer));
        }
        assert_eq!(
            parse_verify_response(&json!({ "kind": "lockedOut", "retryAfterMs": 900_000 })),
            Ok(VerifyAnswer::LockedOut { retry_after_ms: 900_000 })
        );
        assert!(matches!(parse_verify_response(&json!({ "kind": "maybe" })), Err(BackendError::Protocol(_))));
        assert_eq!(parse_rotate_response(&json!({ "kind": "ok" })), Ok(()));
        assert!(parse_rotate_response(&json!({ "kind": "nope" })).is_err());
    }

    #[test]
    fn report_status_is_sent_only_when_given_and_numbers_are_floats() {
        let status = StatusReport {
            agent_version: "0.0.0".into(),
            os: Some("Windows 11".into()),
            os_build: None,
            os_edition: None,
            ram_mb: Some(8192),
            disk_free_gb: None,
            lockdown_level: None,
            kiosk_phase: None,
            kiosk_error: None,
            applied_version: Some(7),
            shell_health: None,
            compat: json!({}),
            trusted_key_ids: None,
            restart_pending: None,
            security: None,
            capabilities: None,
        };
        let args = report_args(&auth(), &ReportBatch { status: Some(status), ..ReportBatch::default() });
        assert_eq!(keys(&args), ["deviceId", "deviceSecret", "status"]);
        let Value::Object(sent) = &args["status"] else { panic!("status is not an object") };
        assert_eq!(
            sent.keys().map(String::as_str).collect::<Vec<_>>(),
            ["agentVersion", "appliedVersion", "compat", "os", "ramMb"]
        );
        // `appliedVersion` and `ramMb` are `v.number()`: a float, never an Int64.
        assert!(matches!(sent["appliedVersion"], Value::Float64(n) if n == 7.0));
        assert!(matches!(sent["ramMb"], Value::Float64(n) if n == 8192.0));
    }

    /// The RFC 8032 test-1 public key of the committed vectors.
    const KEY_ID: &str = "21fe31dfa154a261";
    const PUBLIC_KEY: &str = "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=";

    #[test]
    fn enroll_answers_parse_and_bad_ones_are_protocol_errors() {
        let ok = json!({ "deviceId": "d1", "orgId": "o1", "deviceName": "Desk", "serverTimeMs": 1_760_000_000_000_u64,
                         "policyKeys": [{ "keyId": KEY_ID, "publicKey": PUBLIC_KEY }] });
        let parsed = parse_enroll_response(&ok).unwrap();
        assert_eq!(parsed.device_id, "d1");
        assert_eq!(parsed.org_id, "o1");
        assert_eq!(parsed.device_name, "Desk");
        assert_eq!(parsed.server_time_ms, 1_760_000_000_000);
        assert_eq!(parsed.policy_keys, [TrustedKey { key_id: KEY_ID.into(), public_key: PUBLIC_KEY.into() }]);
        // No root of trust: an answer without keys, with none, or with a key whose id
        // is not its own, is refused.
        for keys in [json!(null), json!([]), json!([{ "keyId": "0000000000000000", "publicKey": PUBLIC_KEY }])] {
            let mut answer = ok.clone();
            answer["policyKeys"] = keys;
            assert!(matches!(parse_enroll_response(&answer), Err(BackendError::Protocol(_))), "{answer}");
        }
        let mut without = ok.clone();
        without.as_object_mut().unwrap().remove("policyKeys");
        assert!(matches!(parse_enroll_response(&without), Err(BackendError::Protocol(_))));
        // A float that the number rule already turned into an integer parses; a
        // fraction or a missing field does not.
        let via_values = to_json(from_json(&ok));
        assert_eq!(parse_enroll_response(&via_values).unwrap(), parsed);
        assert!(matches!(
            parse_enroll_response(&json!({ "deviceId": "d1" })),
            Err(BackendError::Protocol(_))
        ));
        assert!(matches!(
            parse_enroll_response(&json!({ "deviceId": "d", "orgId": "o", "deviceName": "n", "serverTimeMs": 1.5 })),
            Err(BackendError::Protocol(_))
        ));
    }

    #[test]
    fn a_rejected_unenroll_is_success() {
        assert_eq!(parse_unenroll_response(&json!({ "kind": "ok" })), Ok(()));
        assert_eq!(parse_unenroll_response(&json!({ "kind": "rejected" })), Ok(()));
        assert!(parse_unenroll_response(&json!({ "kind": "boom" })).is_err());
        assert!(parse_unenroll_response(&json!(null)).is_err());
    }

    fn head_json(version: i64) -> Json {
        json!({ "version": version, "contentHash": "c", "keyId": KEY_ID, "bodyId": "b1", "pingIntervalMs": 1_800_000,
                "pingNonce": 2, "fastUntil": 0, "rosterEpoch": 4, "planState": "ok" })
    }

    #[test]
    fn head_state_answers() {
        assert_eq!(parse_head_state(&json!({ "kind": "unknownDevice" })), Ok(DesiredFetch::UnknownDevice));
        assert_eq!(parse_head_state(&json!({ "kind": "revoked" })), Ok(DesiredFetch::Revoked));
        // Just enrolled: no head yet (about 1.5 s), the keys already there.
        let keys = json!([
            { "keyId": KEY_ID, "publicKey": PUBLIC_KEY, "endorsement": null },
            { "keyId": "39f713d0a644253f", "publicKey": "x", "endorsement": { "byKeyId": KEY_ID, "signature": "s" } }
        ]);
        let empty = json!({ "kind": "ok", "head": null, "keys": keys, "retiredKeyIds": [KEY_ID] });
        let DesiredFetch::Ok { head: None, keys: parsed, retired_key_ids } = parse_head_state(&empty).unwrap() else {
            panic!("expected ok without a head");
        };
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].endorsement, None);
        assert_eq!(parsed[1].endorsement, Some(Endorsement { by_key_id: KEY_ID.into(), signature: "s".into() }));
        assert_eq!(retired_key_ids, [KEY_ID]);
        // Numbers arrive as floats; the number rule already ran.
        let from_server =
            to_json(from_json(&json!({ "kind": "ok", "head": head_json(3), "keys": [], "retiredKeyIds": [] })));
        let DesiredFetch::Ok { head: Some(head), .. } = parse_head_state(&from_server).unwrap() else {
            panic!("expected a head");
        };
        assert_eq!(
            head,
            Head {
                version: 3,
                content_hash: "c".into(),
                key_id: KEY_ID.into(),
                ping_interval_ms: 1_800_000,
                ping_nonce: 2,
                fast_until: 0,
                roster_epoch: 4,
                plan_state: "ok".into(),
            }
        );
        // The Phase 2 shape is not a head state.
        let phase2 = json!({ "kind": "ok", "desired": { "version": 3, "doc": {}, "signature": null } });
        assert!(matches!(parse_head_state(&phase2), Err(BackendError::Protocol(_))));
        let negative = json!({ "kind": "ok", "head": head_json(-1), "keys": [], "retiredKeyIds": [] });
        assert!(matches!(parse_head_state(&negative), Err(BackendError::Protocol(_))));
    }

    #[test]
    fn fetch_answers_keep_the_payload_bytes_and_parse_rosters() {
        let payload = "{\"a\":\"Zo\u{eb} \\\"q\\\"\"}";
        let envelope = parse_envelope(&json!({ "version": 7, "payload": payload, "signature": "sig", "keyId": KEY_ID }))
            .unwrap();
        assert_eq!(envelope.payload, payload);
        assert_eq!((envelope.version, envelope.key_id.as_str()), (7, KEY_ID));
        assert!(parse_envelope(&json!({ "version": 7, "payload": {}, "signature": "s", "keyId": "k" })).is_err());

        let entries = json!({ "epoch": 2, "entries": [
            { "epoch": 1, "employeeId": "e1", "credentialRevision": 3, "signature": "s1", "keyId": KEY_ID },
            { "epoch": 2, "employeeId": "e1", "credentialRevision": null, "signature": "s2", "keyId": KEY_ID }
        ] });
        let RosterFetch::Entries { epoch: 2, entries } = parse_roster_fetch(&to_json(from_json(&entries))).unwrap() else {
            panic!("expected entries");
        };
        assert_eq!(entries[0].credential_revision, Some(3));
        assert_eq!(entries[1].credential_revision, None);
        let snapshot = json!({ "snapshot": { "epoch": 5, "payload": "{}", "signature": "s", "keyId": KEY_ID } });
        assert!(matches!(parse_roster_fetch(&snapshot), Ok(RosterFetch::Snapshot(s)) if s.epoch == 5));
        assert!(parse_roster_fetch(&json!({ "epoch": 1 })).is_err());

        let args = number_args(&auth(), "version", 7);
        assert_eq!(keys(&args), ["deviceId", "deviceSecret", "version"]);
        assert!(matches!(args["version"], Value::Float64(n) if n == 7.0));
    }

    #[test]
    fn rejected_code_comes_from_the_convex_error_data() {
        assert_eq!(rejected_code(&json!({ "code": "token_expired" })), "token_expired");
        assert_eq!(rejected_code(&json!({ "code": "invalid_request", "message": "x" })), "invalid_request");
        assert_eq!(rejected_code(&json!("a plain string")), "server_error");
        assert_eq!(rejected_code(&json!({ "code": 5 })), "server_error");
        assert_eq!(rejected_code(&json!({ "code": "" })), "server_error");
        assert_eq!(rejected_code(&json!(null)), "server_error");
    }

    #[test]
    fn function_results_map_to_values_and_errors() {
        use convex::ConvexError;
        let value = function_result(FunctionResult::Value(Value::Float64(5.0))).unwrap();
        assert_eq!(value, json!(5));
        let error = function_result(FunctionResult::ConvexError(ConvexError {
            message: "quoted args: deviceSecret=hide-me".into(),
            data: from_json(&json!({ "code": "token_used_up" })),
        }));
        assert_eq!(error, Err(BackendError::Rejected { code: "token_used_up".into() }));
        let plain = function_result(FunctionResult::ErrorMessage("deviceSecret=hide-me".into()));
        assert_eq!(plain, Err(BackendError::Rejected { code: "server_error".into() }));
        assert!(!format!("{plain:?}").contains("hide-me"));
    }

    #[test]
    fn socket_states_map_to_connection_states() {
        assert_eq!(map_state(&WebSocketState::Connected), ConnectionStatus::Online);
        assert_eq!(map_state(&WebSocketState::Connecting), ConnectionStatus::Offline);
    }

    /// The factory builds no client (and so touches no network) until a call is made.
    #[tokio::test]
    async fn the_factory_does_not_connect() {
        let factory = ConvexBackend::factory();
        let backend = factory("https://example.invalid").unwrap();
        drop(backend);
    }
}
