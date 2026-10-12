//! Frame envelope and error codes (plan Section 6.4 and 6.7).

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Frame {
    /// Client -> agent.
    #[serde(rename = "req")]
    Request {
        id: u32,
        method: String,
        #[serde(default)]
        params: serde_json::Value,
    },
    /// Agent -> client. `ok` selects `result` or `error`.
    #[serde(rename = "res")]
    Response {
        id: u32,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<RpcError>,
    },
    /// Agent -> client, no reply.
    #[serde(rename = "evt")]
    Event {
        event: String,
        #[serde(default)]
        data: serde_json::Value,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(default)]
    pub data: Option<serde_json::Value>,
}

/// Unknown codes from a newer agent map to `Internal`.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    HelloRequired,
    UnsupportedProtocol,
    Unauthorized,
    UnknownMethod,
    InvalidParams,
    DeniedByPolicy,
    NotEnrolled,
    Busy,
    Timeout,
    FrameTooLarge,
    #[serde(other)]
    Internal,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn round_trip(text: &str) -> Frame {
        let value: Value = serde_json::from_str(text).unwrap();
        let frame: Frame = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&frame).unwrap(), value);
        frame
    }

    #[test]
    fn request_example_round_trips() {
        let frame = round_trip(r#"{ "t": "req", "id": 7, "method": "state.get", "params": {} }"#);
        assert_eq!(
            frame,
            Frame::Request { id: 7, method: "state.get".into(), params: json!({}) }
        );
    }

    #[test]
    fn ok_response_example_round_trips() {
        let frame = round_trip(r#"{ "t": "res", "id": 7, "ok": true, "result": { "a": 1 } }"#);
        assert!(matches!(frame, Frame::Response { ok: true, error: None, .. }));
    }

    #[test]
    fn error_response_example_round_trips() {
        let frame = round_trip(
            r#"{ "t": "res", "id": 7, "ok": false,
                 "error": { "code": "invalid_params", "message": "bad", "retryable": false, "data": null } }"#,
        );
        match frame {
            Frame::Response { ok: false, result: None, error: Some(e), .. } => {
                assert_eq!(e.code, ErrorCode::InvalidParams);
                assert!(!e.retryable);
            }
            other => panic!("unexpected frame {other:?}"),
        }
    }

    #[test]
    fn event_example_round_trips() {
        let frame = round_trip(r#"{ "t": "evt", "event": "state.changed", "data": { "x": true } }"#);
        assert!(matches!(frame, Frame::Event { .. }));
    }

    #[test]
    fn unknown_extra_fields_are_ignored() {
        let text = r#"{ "t": "req", "id": 1, "method": "hello", "params": {}, "future": [1, 2] }"#;
        let frame: Frame = serde_json::from_str(text).unwrap();
        assert!(matches!(frame, Frame::Request { id: 1, .. }));

        let text = r#"{ "t": "res", "id": 1, "ok": false,
            "error": { "code": "busy", "message": "m", "retryable": true, "extra": 1 }, "more": 2 }"#;
        let frame: Frame = serde_json::from_str(text).unwrap();
        assert!(matches!(frame, Frame::Response { .. }));
    }

    #[test]
    fn missing_params_default_to_null() {
        let frame: Frame = serde_json::from_str(r#"{ "t": "req", "id": 2, "method": "x" }"#).unwrap();
        assert_eq!(frame, Frame::Request { id: 2, method: "x".into(), params: Value::Null });
    }

    #[test]
    fn unknown_error_code_maps_to_internal() {
        let code: ErrorCode = serde_json::from_str(r#""brand_new_code""#).unwrap();
        assert_eq!(code, ErrorCode::Internal);
        let known: ErrorCode = serde_json::from_str(r#""frame_too_large""#).unwrap();
        assert_eq!(known, ErrorCode::FrameTooLarge);
        assert_eq!(serde_json::to_string(&ErrorCode::HelloRequired).unwrap(), r#""hello_required""#);
    }
}
