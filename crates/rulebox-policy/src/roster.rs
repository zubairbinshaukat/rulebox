//! The signed per-group roster log (plan Phase 4, 4.2.1 / 4.4 amended, A6; Step
//! 9 amendment 10). Who may sign in on a device comes from signed entries
//! ("employee E may sign in with credential revision R" / "E was removed") with
//! a gap-free epoch per group, and a signed snapshot of the members every 200
//! entries. No I/O.
//!
//! Signed messages (UTF-8, verified byte for byte):
//!
//! - entry: `"rulebox.roster/1\n<keyId>\n<orgId>\n<groupId>\n<epoch>\n<employeeId>\n<rev|removed>"`
//! - snapshot: the JSON payload `{ format: "rulebox.roster-snapshot/1", keyId,
//!   orgId, groupId, epoch, members: [[employeeId, rev], ...] }`, signed like a
//!   desired document and parsed only after its signature verified.

use serde::{Deserialize, Serialize};

use crate::envelope::{verify_message, TrustedKey, VerifyError};

pub const ROSTER_ENTRY_FORMAT: &str = "rulebox.roster/1";
pub const ROSTER_SNAPSHOT_FORMAT: &str = "rulebox.roster-snapshot/1";

/// One entry of `devices:fetchRoster`. `credential_revision` `None` = removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterEntry {
    pub epoch: u64,
    pub employee_id: String,
    pub credential_revision: Option<u64>,
    pub signature: String,
    pub key_id: String,
}

/// The snapshot of `devices:fetchRoster`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterSnapshot {
    pub epoch: u64,
    pub payload: String,
    pub signature: String,
    pub key_id: String,
}

/// A snapshot whose signature and content checked out: the members at `epoch`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedSnapshot {
    pub epoch: u64,
    /// `(employeeId, credentialRevision)`, as signed (sorted by id by the server).
    pub members: Vec<(String, u64)>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotPayload {
    format: String,
    key_id: String,
    org_id: String,
    group_id: String,
    epoch: u64,
    members: Vec<(String, u64)>,
}

/// The exact message of one entry, for the key that signed it.
pub fn roster_entry_message(key_id: &str, org_id: &str, group_id: &str, entry: &RosterEntry) -> String {
    let revision = entry.credential_revision.map_or_else(|| "removed".to_string(), |rev| rev.to_string());
    format!(
        "{ROSTER_ENTRY_FORMAT}\n{key_id}\n{org_id}\n{group_id}\n{}\n{}\n{revision}",
        entry.epoch, entry.employee_id
    )
}

/// An entry of this organization's group `group_id`, signed by the trusted key it
/// names. The organization, the group and the key id are part of the signed
/// message, so an entry of another group or organization fails as
/// `BadSignature`; a key that is not trusted is `UnknownKey`.
pub fn verify_roster_entry(
    entry: &RosterEntry,
    trusted: &[TrustedKey],
    org_id: &str,
    group_id: &str,
) -> Result<(), VerifyError> {
    let message = roster_entry_message(&entry.key_id, org_id, group_id, entry);
    verify_message(&message, &entry.signature, &entry.key_id, trusted)
}

/// A snapshot: the signature over the payload bytes first, then the payload must
/// be a snapshot (`BadFormat`) of the key (`KeyIdMismatch`), organization
/// (`WrongOrg`), group (`WrongGroup`) and epoch (`VersionMismatch`) it claims.
pub fn verify_snapshot(
    snapshot: &RosterSnapshot,
    trusted: &[TrustedKey],
    org_id: &str,
    group_id: &str,
) -> Result<VerifiedSnapshot, VerifyError> {
    verify_message(&snapshot.payload, &snapshot.signature, &snapshot.key_id, trusted)?;
    let payload: SnapshotPayload = serde_json::from_str(&snapshot.payload).map_err(|_| VerifyError::BadFormat)?;
    if payload.format != ROSTER_SNAPSHOT_FORMAT {
        return Err(VerifyError::BadFormat);
    }
    if payload.key_id != snapshot.key_id {
        return Err(VerifyError::KeyIdMismatch);
    }
    if payload.org_id != org_id {
        return Err(VerifyError::WrongOrg);
    }
    if payload.group_id != group_id {
        return Err(VerifyError::WrongGroup);
    }
    if payload.epoch != snapshot.epoch {
        return Err(VerifyError::VersionMismatch);
    }
    Ok(VerifiedSnapshot { epoch: payload.epoch, members: payload.members })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn vector() -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/vectors/roster-v1.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn trusted(v: &Value) -> Vec<TrustedKey> {
        vec![TrustedKey::checked(v["keyId"].as_str().unwrap(), v["publicKey"].as_str().unwrap()).unwrap()]
    }

    fn entries(v: &Value) -> Vec<(RosterEntry, String)> {
        v["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| (serde_json::from_value(e.clone()).unwrap(), e["message"].as_str().unwrap().to_string()))
            .collect()
    }

    #[test]
    fn roster_vector_verifies() {
        let v = vector();
        let (org, group) = (v["orgId"].as_str().unwrap(), v["groupId"].as_str().unwrap());
        let trusted = trusted(&v);
        let list = entries(&v);
        assert_eq!(list.len(), 3);
        for (entry, message) in &list {
            assert_eq!(&roster_entry_message(&entry.key_id, org, group, entry), message);
            assert_eq!(verify_roster_entry(entry, &trusted, org, group), Ok(()), "epoch {}", entry.epoch);
        }
        assert_eq!(list[2].0.credential_revision, None);
        let snapshot: RosterSnapshot = serde_json::from_value(v["snapshot"].clone()).unwrap();
        let verified = verify_snapshot(&snapshot, &trusted, org, group).unwrap();
        assert_eq!(verified, VerifiedSnapshot { epoch: 3, members: vec![("emp_test_vector_1".into(), 3)] });
    }

    #[test]
    fn forged_roster_entry_refused() {
        let v = vector();
        let (org, group) = (v["orgId"].as_str().unwrap(), v["groupId"].as_str().unwrap());
        let trusted = trusted(&v);
        let (entry, _) = entries(&v).remove(0);
        // Another revision, another employee, another epoch, a removal: all forged.
        for forged in [
            RosterEntry { credential_revision: Some(4), ..entry.clone() },
            RosterEntry { employee_id: "emp_other".into(), ..entry.clone() },
            RosterEntry { epoch: 9, ..entry.clone() },
            RosterEntry { credential_revision: None, ..entry.clone() },
        ] {
            assert_eq!(verify_roster_entry(&forged, &trusted, org, group), Err(VerifyError::BadSignature));
        }
        // An untrusted key, and a key id that is not the one that signed.
        assert_eq!(verify_roster_entry(&entry, &[], org, group), Err(VerifyError::UnknownKey));
        let relabelled = RosterEntry { key_id: "0000000000000000".into(), ..entry.clone() };
        let mut also = trusted.clone();
        also.push(TrustedKey { key_id: "0000000000000000".into(), public_key: trusted[0].public_key.clone() });
        assert_eq!(verify_roster_entry(&relabelled, &also, org, group), Err(VerifyError::BadSignature));
        // A tampered snapshot.
        let mut snapshot: RosterSnapshot = serde_json::from_value(v["snapshot"].clone()).unwrap();
        snapshot.payload = snapshot.payload.replace("\",3]]", "\",4]]");
        assert_eq!(verify_snapshot(&snapshot, &trusted, org, group), Err(VerifyError::BadSignature));
    }

    #[test]
    fn roster_of_other_group_refused() {
        let v = vector();
        let org = v["orgId"].as_str().unwrap();
        let trusted = trusted(&v);
        let (entry, _) = entries(&v).remove(0);
        assert_eq!(verify_roster_entry(&entry, &trusted, org, "grp_other"), Err(VerifyError::BadSignature));
        assert_eq!(verify_roster_entry(&entry, &trusted, "org_other", "grp_test_vector_1"), Err(VerifyError::BadSignature));
        let snapshot: RosterSnapshot = serde_json::from_value(v["snapshot"].clone()).unwrap();
        assert_eq!(verify_snapshot(&snapshot, &trusted, org, "grp_other"), Err(VerifyError::WrongGroup));
        assert_eq!(verify_snapshot(&snapshot, &trusted, "org_other", "grp_test_vector_1"), Err(VerifyError::WrongOrg));
        // A snapshot relabelled as another epoch.
        let relabelled = RosterSnapshot { epoch: 2, ..snapshot };
        assert_eq!(verify_snapshot(&relabelled, &trusted, org, "grp_test_vector_1"), Err(VerifyError::VersionMismatch));
    }
}
