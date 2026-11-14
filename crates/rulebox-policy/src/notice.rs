//! Device lock and broadcasts of the agent-only desired-state keys (plan Phase 5,
//! Section 4.3 and 4.17, PRD 24.4): `deviceLock` and `broadcasts`. Pure data.
//! Both are live (never ring-gated): a lock or an announcement must not wait for a
//! pilot group.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::lockdown::{LimitError, MAX_ID_CHARS};

/// `deviceLock.message`, in characters.
pub const MAX_LOCK_MESSAGE: usize = 300;
/// `deviceLock.contact`, in characters.
pub const MAX_LOCK_CONTACT: usize = 100;
/// Active broadcasts per device.
pub const MAX_ACTIVE_BROADCASTS: usize = 5;
/// `Broadcast.title`, in characters.
pub const MAX_BROADCAST_TITLE: usize = 80;
/// `Broadcast.body`, in characters.
pub const MAX_BROADCAST_BODY: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BroadcastStyle {
    Banner,
    Fullscreen,
    Unknown,
}
unknown_on_new_values!(BroadcastStyle { Banner => "banner", Fullscreen => "fullscreen" });

/// The document key `deviceLock` (`null` = not locked): the device shows a lock
/// screen with the message until the lock is removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeviceLock {
    pub lock_id: String,
    pub message: String,
    #[serde(default)]
    pub contact: Option<String>,
    #[ts(type = "number")]
    pub locked_at_ms: u64,
}

/// One announcement for the Staff session (4.17).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Broadcast {
    pub id: String,
    pub style: BroadcastStyle,
    pub title: String,
    pub body: String,
    #[serde(default)]
    #[ts(type = "number | null")]
    pub expires_at_ms: Option<u64>,
    pub ack_required: bool,
    #[ts(type = "number")]
    pub issued_at_ms: u64,
}

fn within(text: &str, max: usize) -> Result<(), LimitError> {
    if text.chars().count() > max {
        return Err(LimitError::TextTooLong);
    }
    Ok(())
}

impl DeviceLock {
    /// Message at most 300 characters, contact at most 100 (4.3 rule 4).
    pub fn check_limits(&self) -> Result<(), LimitError> {
        within(&self.lock_id, MAX_ID_CHARS)?;
        within(&self.message, MAX_LOCK_MESSAGE)?;
        if let Some(contact) = &self.contact {
            within(contact, MAX_LOCK_CONTACT)?;
        }
        Ok(())
    }
}

impl Broadcast {
    /// True while the broadcast has not expired at `now_ms`.
    pub fn is_active(&self, now_ms: u64) -> bool {
        self.expires_at_ms.is_none_or(|expires| expires > now_ms)
    }

    pub fn check_limits(&self) -> Result<(), LimitError> {
        within(&self.id, MAX_ID_CHARS)?;
        within(&self.title, MAX_BROADCAST_TITLE)?;
        within(&self.body, MAX_BROADCAST_BODY)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_example_parses() {
        let list: Vec<Broadcast> = serde_json::from_str(
            r#"[{ "id": "k5", "style": "banner", "title": "Maintenance", "body": "Back at noon.",
                  "expiresAtMs": 1761000000000, "ackRequired": true, "issuedAtMs": 1760990000000 }]"#,
        )
        .unwrap();
        assert_eq!(list[0].style, BroadcastStyle::Banner);
        assert_eq!(list[0].expires_at_ms, Some(1_761_000_000_000));
        assert!(list[0].is_active(1_760_995_000_000));
        assert!(!list[0].is_active(1_761_000_000_000));
        let lock: DeviceLock =
            serde_json::from_str(r#"{ "lockId": "l1", "message": "Call IT", "contact": null, "lockedAtMs": 5 }"#).unwrap();
        assert_eq!(lock.contact, None);
        let again: DeviceLock = serde_json::from_value(serde_json::to_value(&lock).unwrap()).unwrap();
        assert_eq!(again, lock);
    }

    #[test]
    fn no_expiry_means_active_and_unknown_style_is_unknown() {
        let broadcast: Broadcast = serde_json::from_str(
            r#"{ "id": "k", "style": "hologram", "title": "t", "body": "b", "ackRequired": false, "issuedAtMs": 1 }"#,
        )
        .unwrap();
        assert_eq!(broadcast.style, BroadcastStyle::Unknown);
        assert!(broadcast.is_active(u64::MAX));
    }

    #[test]
    fn text_limits() {
        let lock = |message: String, contact: Option<String>| DeviceLock {
            lock_id: "l".into(),
            message,
            contact,
            locked_at_ms: 1,
        };
        assert_eq!(lock("m".repeat(300), None).check_limits(), Ok(()));
        assert_eq!(lock("m".repeat(301), None).check_limits(), Err(LimitError::TextTooLong));
        assert_eq!(lock("m".into(), Some("c".repeat(101))).check_limits(), Err(LimitError::TextTooLong));
        let broadcast = |title: usize, body: usize| Broadcast {
            id: "k".into(),
            style: BroadcastStyle::Banner,
            title: "t".repeat(title),
            body: "b".repeat(body),
            expires_at_ms: None,
            ack_required: false,
            issued_at_ms: 1,
        };
        assert_eq!(broadcast(80, 500).check_limits(), Ok(()));
        assert_eq!(broadcast(81, 1).check_limits(), Err(LimitError::TextTooLong));
        assert_eq!(broadcast(1, 501).check_limits(), Err(LimitError::TextTooLong));
    }
}
