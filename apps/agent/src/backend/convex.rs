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

use super::value::{from_json, to_json};
use super::{
    Backend, BackendError, BackendEvent, BackendFactory, DesiredFetch, DeviceAuth, EnrollRequest,
    EnrollResponse, HeartbeatResponse, StatusReport, CALL_TIMEOUT,
};

/// Convex function names.
pub const FN_ENROLL: &str = "enrollment:enroll";
pub const FN_DESIRED_STATE: &str = "devices:desiredState";
pub const FN_HEARTBEAT: &str = "devices:heartbeat";
pub const FN_UNENROLL: &str = "devices:unenroll";

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

/// The arguments of `devices:heartbeat`: the credentials, and `status` only when
/// there is one to send.
pub fn heartbeat_args(auth: &DeviceAuth, status: Option<&StatusReport>) -> BTreeMap<String, Value> {
    let mut args = auth_args(auth);
    if let Some(status) = status {
        // A `StatusReport` always serializes; the empty object cannot happen.
        let json = serde_json::to_value(status).unwrap_or(Json::Null);
        args.insert("status".to_string(), from_json(&json));
    }
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

/// `{ deviceId, orgId, deviceName, serverTimeMs }`.
pub fn parse_enroll_response(json: &Json) -> Result<EnrollResponse, BackendError> {
    Ok(EnrollResponse {
        device_id: string_field(json, "deviceId")?,
        org_id: string_field(json, "orgId")?,
        device_name: string_field(json, "deviceName")?,
        server_time_ms: time_ms(json, "serverTimeMs")?,
    })
}

/// `{ kind: "rejected" } | { kind: "ok", nextPingInMs, serverTimeMs }`.
pub fn parse_heartbeat_response(json: &Json) -> Result<HeartbeatResponse, BackendError> {
    match string_field(json, "kind")?.as_str() {
        "rejected" => Err(BackendError::Rejected { code: "rejected".to_string() }),
        "ok" => Ok(HeartbeatResponse {
            next_ping_in_ms: whole_number(json, "nextPingInMs")?,
            server_time_ms: time_ms(json, "serverTimeMs")?,
        }),
        _ => Err(protocol("unknown heartbeat answer")),
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

/// `{ kind: "unknownDevice" } | { kind: "revoked" } | { kind: "ok", desired: null |
/// { version, doc, signature: null } }`.
pub fn parse_desired(json: &Json) -> Result<DesiredFetch, BackendError> {
    match string_field(json, "kind")?.as_str() {
        "unknownDevice" => Ok(DesiredFetch::UnknownDevice),
        "revoked" => Ok(DesiredFetch::Revoked),
        "ok" => {
            let desired = field(json, "desired")?;
            if desired.is_null() {
                return Ok(DesiredFetch::None);
            }
            let signature = match desired.get("signature") {
                None | Some(Json::Null) => None,
                Some(Json::String(signature)) => Some(signature.clone()),
                Some(_) => return Err(protocol("\"signature\" is not text or null")),
            };
            Ok(DesiredFetch::Doc {
                version: whole_number(desired, "version")?,
                doc: field(desired, "doc")?.clone(),
                signature,
            })
        }
        _ => Err(protocol("unknown desired-state answer")),
    }
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

    async fn run_subscription(&self, auth: DeviceAuth, tx: mpsc::Sender<BackendEvent>, shutdown: CancellationToken) {
        let mut wait = RESUBSCRIBE_BASE;
        // Set up the subscription, retrying while the client cannot.
        let (mut subscription, mut status_rx) = loop {
            let attempt = async {
                let connected = self.connected().await?;
                let mut client = connected.client.clone();
                let subscription = tokio::time::timeout(
                    CALL_TIMEOUT,
                    client.subscribe(FN_DESIRED_STATE, auth_args(&auth)),
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
                        let fetch = function_result(result).and_then(|json| parse_desired(&json));
                        match fetch {
                            Ok(fetch) => {
                                if tx.send(BackendEvent::Desired(fetch)).await.is_err() {
                                    return;
                                }
                            }
                            Err(error) => tracing::warn!("ignoring a desired-state answer: {error}"),
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

    fn heartbeat(
        &self,
        auth: &DeviceAuth,
        status: Option<StatusReport>,
    ) -> BoxFuture<'_, Result<HeartbeatResponse, BackendError>> {
        let args = heartbeat_args(auth, status.as_ref());
        async move {
            let json = self.mutation(FN_HEARTBEAT, args).await?;
            parse_heartbeat_response(&json)
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::sha256_hex;
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
        assert_eq!(FN_DESIRED_STATE, "devices:desiredState");
        assert_eq!(FN_HEARTBEAT, "devices:heartbeat");
        assert_eq!(FN_UNENROLL, "devices:unenroll");
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
    /// `desiredState` and `heartbeat` call sends, hashed as text.
    #[test]
    fn the_enrolled_hash_matches_the_secret_later_sent() {
        let auth = auth();
        let enrolled_hash = sha256_hex(&auth.device_secret);
        let desired = auth_args(&auth);
        let heartbeat = heartbeat_args(&auth, None);
        for args in [&desired, &heartbeat] {
            assert_eq!(sha256_hex(string_arg(args, "deviceSecret")), enrolled_hash);
            assert_eq!(string_arg(args, "deviceId"), "kd7abc");
        }
        assert_eq!(keys(&desired), ["deviceId", "deviceSecret"]);
        assert_eq!(keys(&heartbeat), ["deviceId", "deviceSecret"]);
    }

    #[test]
    fn heartbeat_status_is_sent_only_when_given_and_numbers_are_floats() {
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
        };
        let args = heartbeat_args(&auth(), Some(&status));
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

    #[test]
    fn enroll_answers_parse_and_bad_ones_are_protocol_errors() {
        let ok = json!({ "deviceId": "d1", "orgId": "o1", "deviceName": "Desk", "serverTimeMs": 1_760_000_000_000_u64 });
        let parsed = parse_enroll_response(&ok).unwrap();
        assert_eq!(parsed.device_id, "d1");
        assert_eq!(parsed.org_id, "o1");
        assert_eq!(parsed.device_name, "Desk");
        assert_eq!(parsed.server_time_ms, 1_760_000_000_000);
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
    fn heartbeat_answers() {
        let ok = parse_heartbeat_response(&json!({ "kind": "ok", "nextPingInMs": 300_000, "serverTimeMs": 5 })).unwrap();
        assert_eq!(ok, HeartbeatResponse { next_ping_in_ms: 300_000, server_time_ms: 5 });
        assert_eq!(
            parse_heartbeat_response(&json!({ "kind": "rejected" })),
            Err(BackendError::Rejected { code: "rejected".into() })
        );
        assert!(matches!(parse_heartbeat_response(&json!({ "kind": "?" })), Err(BackendError::Protocol(_))));
        assert!(matches!(parse_heartbeat_response(&json!({ "kind": "ok" })), Err(BackendError::Protocol(_))));
    }

    #[test]
    fn a_rejected_unenroll_is_success() {
        assert_eq!(parse_unenroll_response(&json!({ "kind": "ok" })), Ok(()));
        assert_eq!(parse_unenroll_response(&json!({ "kind": "rejected" })), Ok(()));
        assert!(parse_unenroll_response(&json!({ "kind": "boom" })).is_err());
        assert!(parse_unenroll_response(&json!(null)).is_err());
    }

    #[test]
    fn desired_state_answers() {
        assert_eq!(parse_desired(&json!({ "kind": "unknownDevice" })), Ok(DesiredFetch::UnknownDevice));
        assert_eq!(parse_desired(&json!({ "kind": "revoked" })), Ok(DesiredFetch::Revoked));
        assert_eq!(parse_desired(&json!({ "kind": "ok", "desired": null })), Ok(DesiredFetch::None));
        let doc = json!({ "kioskEnabled": true, "version": 3 });
        // The version arrives as a float from the server; the number rule already ran.
        let from_server = to_json(from_json(&json!({
            "kind": "ok",
            "desired": { "version": 3, "doc": doc, "signature": null }
        })));
        assert_eq!(
            parse_desired(&from_server),
            Ok(DesiredFetch::Doc { version: 3, doc: doc.clone(), signature: None })
        );
        let signed = json!({ "kind": "ok", "desired": { "version": 4, "doc": {}, "signature": "sig" } });
        assert_eq!(
            parse_desired(&signed),
            Ok(DesiredFetch::Doc { version: 4, doc: json!({}), signature: Some("sig".into()) })
        );
        assert!(matches!(parse_desired(&json!({ "kind": "ok" })), Err(BackendError::Protocol(_))));
        assert!(matches!(
            parse_desired(&json!({ "kind": "ok", "desired": { "version": -1, "doc": {}, "signature": null } })),
            Err(BackendError::Protocol(_))
        ));
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
