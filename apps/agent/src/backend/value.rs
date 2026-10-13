//! `convex::Value` <-> `serde_json::Value` (plan Section 5.8, "Value conversion").
//!
//! Convex numbers are 64-bit floats, so `version` arrives as `42.0` and `serde`
//! would refuse to read it as `u64`. [`to_json`] turns every finite float with no
//! fractional part and an absolute value below 2^53 into a JSON integer.
//!
//! The crate's own `Value::export()` is reused for the one leaf that is easy to get
//! wrong (bytes become base64 text, as in the crate's JSON export); the rest is
//! converted here because `export()` writes a 64-bit integer as a *string*, which
//! would make an integer field unreadable.
//!
//! [`from_json`] goes the other way for call arguments. **Every number becomes a
//! float**: a Convex `v.number()` validator rejects an `Int64` (that is a
//! `v.int64()`), and `appliedVersion`, `ramMb` and `diskFreeGb` are `v.number()`.

use std::collections::BTreeMap;

use convex::Value;
use serde_json::{Map, Number, Value as Json};

/// 2^53: the largest magnitude at which every integer is exactly representable.
const MAX_EXACT_INTEGER: f64 = 9_007_199_254_740_992.0;

/// Converts a Convex value to JSON. See the module comment for the number rule.
pub fn to_json(value: Value) -> Json {
    match value {
        Value::Null => Json::Null,
        Value::Boolean(flag) => Json::Bool(flag),
        Value::String(text) => Json::String(text),
        Value::Int64(number) => Json::Number(Number::from(number)),
        Value::Float64(number) => float_to_json(number),
        Value::Bytes(bytes) => Value::Bytes(bytes).export(),
        Value::Array(items) => Json::Array(items.into_iter().map(to_json).collect()),
        Value::Object(fields) => {
            let mut map = Map::new();
            for (key, field) in fields {
                map.insert(key, to_json(field));
            }
            Json::Object(map)
        }
    }
}

fn float_to_json(number: f64) -> Json {
    if number.is_finite() && number.fract() == 0.0 && number.abs() < MAX_EXACT_INTEGER {
        // Below 2^53, so the cast is exact.
        return Json::Number(Number::from(number as i64));
    }
    // Everything else keeps the crate's export form: a finite float is a JSON
    // number; NaN and the infinities are the strings "NaN", "Infinity", "-Infinity".
    Value::Float64(number).export()
}

/// Converts JSON to a Convex value for call arguments. Numbers are always floats.
pub fn from_json(json: &Json) -> Value {
    match json {
        Json::Null => Value::Null,
        Json::Bool(flag) => Value::Boolean(*flag),
        Json::String(text) => Value::String(text.clone()),
        Json::Number(number) => Value::Float64(number.as_f64().unwrap_or(f64::NAN)),
        Json::Array(items) => Value::Array(items.iter().map(from_json).collect()),
        Json::Object(fields) => {
            let mut map = BTreeMap::new();
            for (key, field) in fields {
                map.insert(key.clone(), from_json(field));
            }
            Value::Object(map)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rulebox_policy::{DesiredState, EXAMPLE_DESIRED_STATE_JSON};
    use serde_json::json;

    #[test]
    fn an_integral_float_becomes_an_integer_and_a_fraction_stays_a_float() {
        let forty_two = to_json(Value::Float64(42.0));
        assert!(forty_two.is_u64(), "{forty_two:?}");
        assert_eq!(forty_two, json!(42));
        let fraction = to_json(Value::Float64(1.5));
        assert!(fraction.is_f64(), "{fraction:?}");
        assert_eq!(fraction, json!(1.5));
        // Zero, negative zero and negative integers.
        assert_eq!(to_json(Value::Float64(0.0)), json!(0));
        assert_eq!(to_json(Value::Float64(-0.0)), json!(0));
        assert_eq!(to_json(Value::Float64(-7.0)), json!(-7));
        assert!(to_json(Value::Float64(-7.0)).is_i64());
    }

    #[test]
    fn the_2_pow_53_boundary() {
        let below = 9_007_199_254_740_991.0_f64;
        assert_eq!(to_json(Value::Float64(below)), json!(9_007_199_254_740_991_u64));
        // At and above 2^53 the integer is not exact any more: it stays a float.
        let at = to_json(Value::Float64(9_007_199_254_740_992.0));
        assert!(at.is_f64(), "{at:?}");
        let big = to_json(Value::Float64(1e300));
        assert!(big.is_f64(), "{big:?}");
    }

    #[test]
    fn non_finite_floats_use_the_crate_export_strings() {
        assert_eq!(to_json(Value::Float64(f64::NAN)), json!("NaN"));
        assert_eq!(to_json(Value::Float64(f64::INFINITY)), json!("Infinity"));
        assert_eq!(to_json(Value::Float64(f64::NEG_INFINITY)), json!("-Infinity"));
    }

    #[test]
    fn other_leaves_and_containers() {
        assert_eq!(to_json(Value::Null), Json::Null);
        assert_eq!(to_json(Value::Boolean(true)), json!(true));
        assert_eq!(to_json(Value::String("a".into())), json!("a"));
        // A real 64-bit integer stays a number (the crate's export would make it text).
        assert_eq!(to_json(Value::Int64(-5)), json!(-5));
        assert_eq!(to_json(Value::Bytes(vec![0b0000_0000, 0b0001_0000, 0b1000_0011])), json!("ABCD"));
        let nested = Value::Object(BTreeMap::from([
            ("n".to_string(), Value::Float64(3.0)),
            ("list".to_string(), Value::Array(vec![Value::Float64(1.0), Value::Float64(2.5)])),
        ]));
        assert_eq!(to_json(nested), json!({ "n": 3, "list": [1, 2.5] }));
    }

    #[test]
    fn from_json_makes_every_number_a_float() {
        let value = from_json(&json!({ "ramMb": 8192, "ratio": 0.5, "ok": true, "list": [1, null, "x"] }));
        let Value::Object(map) = value else { panic!("expected an object") };
        assert!(matches!(map["ramMb"], Value::Float64(n) if n == 8192.0));
        assert!(matches!(map["ratio"], Value::Float64(n) if n == 0.5));
        assert!(matches!(map["ok"], Value::Boolean(true)));
        let Value::Array(list) = &map["list"] else { panic!("expected an array") };
        assert!(matches!(list[0], Value::Float64(n) if n == 1.0));
        assert!(matches!(list[1], Value::Null));
        // No Int64 anywhere: a `v.number()` validator would reject it.
        fn has_int64(value: &Value) -> bool {
            match value {
                Value::Int64(_) => true,
                Value::Array(items) => items.iter().any(has_int64),
                Value::Object(fields) => fields.values().any(has_int64),
                _ => false,
            }
        }
        assert!(!has_int64(&Value::Object(map)));
    }

    /// What the server stores for the PRD example is a JS object, so every number
    /// is a float: build that, convert it, and parse it into `DesiredState`.
    #[test]
    fn the_prd_example_document_converts_and_parses() {
        let json: Json = serde_json::from_str(EXAMPLE_DESIRED_STATE_JSON).unwrap();
        let from_server = from_json(&json);
        // `version` really arrives as a float, and serde refuses it as a u64.
        let Value::Object(fields) = &from_server else { panic!("expected an object") };
        assert!(matches!(fields["version"], Value::Float64(n) if n == 42.0));
        let raw_float = json!(42.0);
        assert!(serde_json::from_value::<u64>(raw_float).is_err());

        let converted = to_json(from_server);
        let state: DesiredState = serde_json::from_value(converted).unwrap();
        assert!(state.kiosk_enabled);
        assert_eq!(state.version, 42);
        assert_eq!(state.storage.default_quota_gb, 10);
        assert_eq!(state.apps, ["orders-web", "zoom", "tally", "libreoffice"]);
    }

    #[test]
    fn the_agent_only_keys_survive_in_the_raw_document() {
        let doc = json!({
            "kioskEnabled": true, "apps": [], "allowedSites": [], "fileHandlers": {},
            "storage": { "defaultQuotaGb": 0 }, "branding": { "name": "Rulebox" }, "version": 7,
            "adminExit": { "pinHash": "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA", "hotkey": "Ctrl+Shift+F12" },
            "power": { "sleep": true, "restart": true, "shutDown": false },
            "orgName": "Company"
        });
        let raw = to_json(from_json(&doc));
        assert_eq!(raw, doc);
        // DesiredState ignores the extra keys.
        let state: DesiredState = serde_json::from_value(raw).unwrap();
        assert_eq!(state.version, 7);
    }
}
