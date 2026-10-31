//! The verified roster of the device's group (plan Phase 4, 4.4 amended, A6;
//! Step 9 amendment 10): `<data>\state\roster.json`, schema 1, atomic writes.
//!
//! The head carries the group's `rosterEpoch`; when it moves the backend task
//! calls [`sync`], which fetches the entries since the stored epoch
//! (`devices:fetchRoster`). Every entry must verify (`verify_roster_entry`) and
//! follow the previous one without a gap; a gap or a bad signature makes it start
//! over from epoch 0, which returns the signed snapshot (or the whole log while
//! there is none). An unsigned entry is never accepted: the stored roster only
//! ever moves to a state every step of which verified.
//!
//! Nothing reads the roster yet: the offline sign-in rules of Step 13 do.

use std::collections::BTreeMap;
use std::path::Path;

use rulebox_policy::envelope::{TrustedKey, VerifyError};
use rulebox_policy::roster::{verify_roster_entry, verify_snapshot};
use serde::{Deserialize, Serialize};

use crate::backend::{Backend, BackendError, DeviceAuth, RosterFetch};
use crate::state::{read_json, write_atomic};

pub const ROSTER_SCHEMA: u32 = 1;
/// At most this many `fetchRoster` calls per sync (a delta can need the snapshot
/// first, then the entries after it).
const MAX_CALLS: usize = 4;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct RosterState {
    pub schema: u32,
    /// The group these members belong to (`doc.rosterGroupId`).
    pub group_id: Option<String>,
    pub epoch: u64,
    /// Employee id -> credential revision.
    pub members: BTreeMap<String, u64>,
}

impl Default for RosterState {
    fn default() -> Self {
        Self { schema: ROSTER_SCHEMA, group_id: None, epoch: 0, members: BTreeMap::new() }
    }
}

impl RosterState {
    /// The empty roster of `group` (epoch 0).
    pub fn for_group(group: Option<&str>) -> Self {
        Self { group_id: group.map(str::to_string), ..Self::default() }
    }

    /// The saved roster; missing, unreadable or of another schema is the empty one.
    pub fn load(path: &Path) -> Self {
        match read_json::<RosterState>(path) {
            Ok(Some(state)) if state.schema == ROSTER_SCHEMA => state,
            Ok(Some(state)) => {
                tracing::warn!(schema = state.schema, "roster.json has an unknown schema; starting empty");
                Self::default()
            }
            Ok(None) => Self::default(),
            Err(error) => {
                tracing::error!("cannot read roster.json: {error}");
                Self::default()
            }
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        write_atomic(path, &bytes)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RosterError {
    /// The entries do not follow the stored epoch without a gap.
    Gap,
    /// An entry or snapshot did not verify.
    Untrusted(VerifyError),
    Backend(BackendError),
}

impl std::fmt::Display for RosterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RosterError::Gap => f.write_str("the roster entries have a gap"),
            RosterError::Untrusted(error) => write!(f, "a roster entry did not verify ({error})"),
            RosterError::Backend(error) => write!(f, "{error}"),
        }
    }
}

/// `current` after one `fetchRoster` answer, when every part of it verifies.
/// Pure.
pub fn apply_fetch(
    current: &RosterState,
    fetch: RosterFetch,
    trusted: &[TrustedKey],
    org_id: &str,
    group_id: &str,
) -> Result<RosterState, RosterError> {
    let mut next = current.clone();
    match fetch {
        RosterFetch::Entries { epoch, entries } => {
            for entry in &entries {
                if entry.epoch != next.epoch + 1 {
                    return Err(RosterError::Gap);
                }
                verify_roster_entry(entry, trusted, org_id, group_id).map_err(RosterError::Untrusted)?;
                match entry.credential_revision {
                    Some(revision) => next.members.insert(entry.employee_id.clone(), revision),
                    None => next.members.remove(&entry.employee_id),
                };
                next.epoch = entry.epoch;
            }
            // The server is further than the entries it sent (the log moved on, or
            // it lost entries): not a state we can reach from here.
            if entries.is_empty() && epoch > next.epoch {
                return Err(RosterError::Gap);
            }
        }
        RosterFetch::Snapshot(snapshot) => {
            let verified = verify_snapshot(&snapshot, trusted, org_id, group_id).map_err(RosterError::Untrusted)?;
            if verified.epoch < next.epoch {
                return Err(RosterError::Gap);
            }
            next.epoch = verified.epoch;
            next.members = verified.members.into_iter().collect();
        }
    }
    Ok(next)
}

/// Brings `current` to `target_epoch` for `group_id`. A roster of another group,
/// or one ahead of the target (the server started over), starts empty. Returns
/// the newest verified state reached; an error leaves the caller's copy as it was.
pub async fn sync(
    backend: &dyn Backend,
    auth: &DeviceAuth,
    current: RosterState,
    target_epoch: u64,
    trusted: &[TrustedKey],
    org_id: &str,
    group_id: &str,
) -> Result<RosterState, RosterError> {
    let mut state = if current.group_id.as_deref() != Some(group_id) || current.epoch > target_epoch {
        RosterState::for_group(Some(group_id))
    } else {
        current
    };
    let mut started_over = false;
    for _ in 0..MAX_CALLS {
        if state.epoch >= target_epoch {
            break;
        }
        let fetch = backend.fetch_roster(auth, state.epoch).await.map_err(RosterError::Backend)?;
        match apply_fetch(&state, fetch, trusted, org_id, group_id) {
            Ok(next) if next.epoch == state.epoch => break,
            Ok(next) => state = next,
            Err(error @ (RosterError::Gap | RosterError::Untrusted(_))) if !started_over => {
                tracing::warn!("{error}; fetching the roster from the start");
                started_over = true;
                state = RosterState::for_group(Some(group_id));
            }
            Err(error) => return Err(error),
        }
    }
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::fake::FakeBackend;
    use crate::testutil::signing::{roster_entry, sign_text, test_key, test_key_2, trusted_of};
    use crate::testutil::TempDir;
    use rulebox_policy::roster::RosterSnapshot;

    const ORG: &str = "org-1";
    const GROUP: &str = "grp-1";

    fn auth() -> DeviceAuth {
        DeviceAuth { device_id: "dev-1".into(), device_secret: "s".into() }
    }

    fn snapshot(epoch: u64, members: &[(&str, u64)]) -> RosterSnapshot {
        let key = test_key();
        let key_id = trusted_of(&key).key_id;
        let payload = serde_json::json!({
            "format": "rulebox.roster-snapshot/1", "keyId": key_id, "orgId": ORG, "groupId": GROUP,
            "epoch": epoch, "members": members.iter().map(|(id, rev)| serde_json::json!([id, rev])).collect::<Vec<_>>()
        })
        .to_string();
        RosterSnapshot { epoch, signature: sign_text(&key, &payload), payload, key_id }
    }

    #[test]
    fn entries_apply_in_order_and_removals_remove() {
        let key = test_key();
        let trusted = [trusted_of(&key)];
        let fetch = RosterFetch::Entries {
            epoch: 3,
            entries: vec![
                roster_entry(&key, ORG, GROUP, 1, "e1", Some(3)),
                roster_entry(&key, ORG, GROUP, 2, "e2", Some(1)),
                roster_entry(&key, ORG, GROUP, 3, "e2", None),
            ],
        };
        let next = apply_fetch(&RosterState::for_group(Some(GROUP)), fetch, &trusted, ORG, GROUP).unwrap();
        assert_eq!(next.epoch, 3);
        assert_eq!(next.members, BTreeMap::from([("e1".to_string(), 3)]));
    }

    #[test]
    fn a_gap_an_untrusted_or_a_foreign_entry_changes_nothing() {
        let key = test_key();
        let trusted = [trusted_of(&key)];
        let start = RosterState::for_group(Some(GROUP));
        let gap = RosterFetch::Entries { epoch: 2, entries: vec![roster_entry(&key, ORG, GROUP, 2, "e1", Some(1))] };
        assert_eq!(apply_fetch(&start, gap, &trusted, ORG, GROUP), Err(RosterError::Gap));
        let behind = RosterFetch::Entries { epoch: 5, entries: vec![] };
        assert_eq!(apply_fetch(&start, behind, &trusted, ORG, GROUP), Err(RosterError::Gap));
        let untrusted =
            RosterFetch::Entries { epoch: 1, entries: vec![roster_entry(&test_key_2(), ORG, GROUP, 1, "e1", Some(1))] };
        assert_eq!(
            apply_fetch(&start, untrusted, &trusted, ORG, GROUP),
            Err(RosterError::Untrusted(VerifyError::UnknownKey))
        );
        let other_group =
            RosterFetch::Entries { epoch: 1, entries: vec![roster_entry(&key, ORG, "grp-2", 1, "e1", Some(1))] };
        assert_eq!(
            apply_fetch(&start, other_group, &trusted, ORG, GROUP),
            Err(RosterError::Untrusted(VerifyError::BadSignature))
        );
    }

    #[tokio::test]
    async fn roster_gap_triggers_snapshot() {
        let key = test_key();
        let trusted = [trusted_of(&key)];
        let fake = FakeBackend::new();
        // Asked from epoch 1, the server sends epoch 5 (a gap): the agent starts over
        // from 0 and gets the snapshot at 5, then the entry after it.
        fake.script_roster(Ok(RosterFetch::Entries {
            epoch: 6,
            entries: vec![roster_entry(&key, ORG, GROUP, 5, "e9", Some(1))],
        }));
        fake.script_roster(Ok(RosterFetch::Snapshot(snapshot(5, &[("e1", 4)]))));
        fake.script_roster(Ok(RosterFetch::Entries {
            epoch: 6,
            entries: vec![roster_entry(&key, ORG, GROUP, 6, "e2", Some(2))],
        }));
        let current = RosterState { group_id: Some(GROUP.into()), epoch: 1, ..RosterState::default() };
        let state = sync(&fake, &auth(), current, 6, &trusted, ORG, GROUP).await.unwrap();
        assert_eq!(fake.roster_calls(), [1, 0, 5]);
        assert_eq!(state.epoch, 6);
        assert_eq!(state.members, BTreeMap::from([("e1".to_string(), 4), ("e2".to_string(), 2)]));
    }

    #[tokio::test]
    async fn a_forged_roster_twice_is_an_error_and_another_group_starts_empty() {
        let key = test_key();
        let trusted = [trusted_of(&key)];
        let fake = FakeBackend::new();
        let mut forged = roster_entry(&key, ORG, GROUP, 1, "e1", Some(1));
        forged.credential_revision = Some(2);
        for _ in 0..2 {
            fake.script_roster(Ok(RosterFetch::Entries { epoch: 1, entries: vec![forged.clone()] }));
        }
        let current = RosterState {
            group_id: Some("grp-old".into()),
            epoch: 9,
            members: BTreeMap::from([("old".to_string(), 1)]),
            ..RosterState::default()
        };
        let result = sync(&fake, &auth(), current, 1, &trusted, ORG, GROUP).await;
        assert_eq!(result, Err(RosterError::Untrusted(VerifyError::BadSignature)));
        // The other group's roster was not used as the starting point.
        assert_eq!(fake.roster_calls(), [0, 0]);
    }

    #[test]
    fn the_file_round_trips_and_a_bad_one_is_empty() {
        let dir = TempDir::new();
        let path = dir.path().join("roster.json");
        assert_eq!(RosterState::load(&path), RosterState::default());
        let state = RosterState {
            group_id: Some(GROUP.into()),
            epoch: 4,
            members: BTreeMap::from([("e1".to_string(), 2)]),
            ..RosterState::default()
        };
        state.save(&path).unwrap();
        assert_eq!(RosterState::load(&path), state);
        std::fs::write(&path, br#"{ "schema": 2, "epoch": 1 }"#).unwrap();
        assert_eq!(RosterState::load(&path), RosterState::default());
    }
}
