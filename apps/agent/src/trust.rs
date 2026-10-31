//! The device's key trust store (plan Phase 4, 4.5 "Trust on the device",
//! "Rotation" and Step 9 item 4.1).
//!
//! The root of trust is the key list of the enrollment answer
//! (`AgentState.trusted_keys`); there is no trust on first use. After that a key
//! is only ever added when its endorsement, for this organization, verifies
//! under a key trusted at that moment (so a device that was offline through
//! several rotations walks the chain), or by an administrator on the PC
//! (`rulebox-agent trust-key`). A key the server lists as retired is dropped
//! only once a document signed by another key has been accepted, and the last
//! key is never dropped. A key the server lists as retired never endorses
//! another key (a leaked retired key must not be able to add one).

use rulebox_policy::envelope::{verify_endorsement, PublishedKey, TrustedKey};

use crate::state::{AgentState, SharedState};

/// What [`merge`] changed.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TrustChange {
    pub added: Vec<String>,
    pub dropped: Vec<String>,
}

impl TrustChange {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.dropped.is_empty()
    }
}

/// Why the trust store cannot be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum TrustError {
    /// There is no enrollment (or its organization id is empty): nothing can be
    /// verified or trusted, and no document is checked against an empty org.
    #[error("this PC has no organization id (it is not enrolled)")]
    NotEnrolled,
    /// The change is in memory but `agent-state.json` could not be written.
    #[error("cannot save the trusted keys")]
    NotSaved,
}

/// The organization id of the enrollment; never an empty string.
pub fn org_id_of(state: &AgentState) -> Result<&str, TrustError> {
    match state.enrollment.as_ref() {
        Some(enrollment) if !enrollment.org_id.is_empty() => Ok(enrollment.org_id.as_str()),
        _ => Err(TrustError::NotEnrolled),
    }
}

/// The trusted keys and the organization id, read together (one lock), for
/// verifying a document or a roster. Fails closed without an organization.
pub fn verification_inputs(shared: &SharedState) -> Result<(Vec<TrustedKey>, String), TrustError> {
    shared.read(|state| Ok((state.trusted_keys.clone(), org_id_of(state)?.to_string())))
}

/// The trust store after one `headState` result. Pure.
///
/// 1. Every id in `retired` is dropped when `last_doc_key_id` is set and is
///    another key, and it is not the last key.
/// 2. `keys` in the given order (oldest first): a key not trusted yet is added
///    when its endorsement verifies against the keys trusted at that moment. A
///    listed key whose id is trusted but whose public key differs is ignored
///    (a trusted key is never replaced).
///
/// **A retired key never endorses** (owner decision, Step 9 review): a leaked
/// retired key plus a backend that lists an attacker key must not make the device
/// trust it. So the endorser set excludes every id in `retired`, and a retired key
/// is not added either. The price: a device that was offline until its trusted key
/// was already retired cannot walk the chain through it and needs
/// `rulebox-agent trust-key` (or re-enrollment).
pub fn merge(
    trusted: &mut Vec<TrustedKey>,
    last_doc_key_id: Option<&str>,
    org_id: &str,
    keys: &[PublishedKey],
    retired: &[String],
) -> TrustChange {
    let mut change = TrustChange::default();
    if let Some(last) = last_doc_key_id {
        for id in retired {
            if id == last || trusted.len() <= 1 {
                continue;
            }
            if let Some(index) = trusted.iter().position(|key| &key.key_id == id) {
                trusted.remove(index);
                tracing::info!(key_id = %id, "dropped a retired policy key");
                change.dropped.push(id.clone());
            }
        }
    }
    for key in keys {
        if let Some(known) = trusted.iter().find(|known| known.key_id == key.key_id) {
            if known.public_key != key.public_key {
                tracing::warn!(key_id = %key.key_id, "the backend lists another public key under a trusted key id; ignored");
            }
            continue;
        }
        if retired.contains(&key.key_id) {
            tracing::debug!(key_id = %key.key_id, "not trusting a listed key: it is retired");
            continue;
        }
        let endorsers: Vec<TrustedKey> =
            trusted.iter().filter(|known| !retired.contains(&known.key_id)).cloned().collect();
        match verify_endorsement(key, &endorsers, org_id) {
            Ok(added) => {
                tracing::info!(key_id = %added.key_id, "trusting a new policy key (endorsed by a trusted key)");
                change.added.push(added.key_id.clone());
                trusted.push(added);
            }
            Err(error) => tracing::debug!(key_id = %key.key_id, "not trusting a listed key: {error}"),
        }
    }
    change
}

/// [`merge`] on the saved state, read, merged and written under the state lock
/// (an `admin.trustKey` that lands at the same time is not lost); saves
/// `agent-state.json` only when something changed. Returns what changed.
pub fn update(shared: &SharedState, keys: &[PublishedKey], retired: &[String]) -> Result<TrustChange, TrustError> {
    let (outcome, saved) = shared.update_if(|state| {
        let org_id = match org_id_of(state) {
            Ok(org_id) => org_id.to_string(),
            Err(error) => return (Err(error), false),
        };
        let last = state.last_doc_key_id.clone();
        let change = merge(&mut state.trusted_keys, last.as_deref(), &org_id, keys, retired);
        let changed = !change.is_empty();
        (Ok(change), changed)
    });
    if let Err(error) = saved {
        tracing::error!("cannot save the trusted keys: {error}");
    }
    outcome
}

/// Adds `key` (an administrator's `trust-key`) under the state lock. `Ok(true)`
/// when it was new.
pub fn add_key(shared: &SharedState, key: TrustedKey) -> Result<bool, TrustError> {
    let (outcome, saved) = shared.update_if(|state| {
        if org_id_of(state).is_err() {
            return (Err(TrustError::NotEnrolled), false);
        }
        if state.trusted_keys.iter().any(|known| known.key_id == key.key_id) {
            return (Ok(false), false);
        }
        state.trusted_keys.push(key);
        (Ok(true), true)
    });
    if let Err(error) = saved {
        tracing::error!("cannot save the trusted keys: {error}");
        return outcome.and(Err(TrustError::NotSaved));
    }
    outcome
}

/// The sorted key ids for the status report.
pub fn trusted_key_ids(trusted: &[TrustedKey]) -> Vec<String> {
    let mut ids: Vec<String> = trusted.iter().map(|key| key.key_id.clone()).collect();
    ids.sort();
    ids.dedup();
    ids
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::signing::{endorse, test_key, test_key_2, test_key_3, trusted_of};
    use crate::testutil::TempDir;

    const ORG: &str = "org-1";

    fn published(key: &ed25519_dalek::SigningKey, by: Option<&ed25519_dalek::SigningKey>) -> PublishedKey {
        let t = trusted_of(key);
        PublishedKey {
            key_id: t.key_id.clone(),
            public_key: t.public_key.clone(),
            endorsement: by.map(|by| endorse(by, ORG, key)),
        }
    }

    #[test]
    fn an_endorsed_key_is_added_and_a_chain_is_walked() {
        let (k1, k2, k3) = (test_key(), test_key_2(), test_key_3());
        let mut trusted = vec![trusted_of(&k1)];
        // Oldest first: k2 endorsed by k1, k3 endorsed by k2.
        let keys = [published(&k1, None), published(&k2, Some(&k1)), published(&k3, Some(&k2))];
        let change = merge(&mut trusted, None, ORG, &keys, &[]);
        assert_eq!(change.added, [trusted_of(&k2).key_id, trusted_of(&k3).key_id]);
        assert_eq!(trusted.len(), 3);
        // Again: nothing changes.
        assert!(merge(&mut trusted, None, ORG, &keys, &[]).is_empty());
    }

    #[test]
    fn unendorsed_foreign_and_relabelled_keys_are_not_added() {
        let (k1, k2, k3) = (test_key(), test_key_2(), test_key_3());
        let mut trusted = vec![trusted_of(&k1)];
        let mut other_org = published(&k3, None);
        other_org.endorsement = Some(endorse(&k1, "org-2", &k3));
        let keys = [
            published(&k2, None),          // no endorsement
            published(&k2, Some(&k3)),     // endorsed by a key that is not trusted
            other_org,                     // endorsed for another organization
        ];
        assert!(merge(&mut trusted, None, ORG, &keys, &[]).is_empty());
        // A listed key that reuses a trusted id with another public key never replaces it.
        let mut swapped = published(&k2, Some(&k1));
        swapped.key_id = trusted_of(&k1).key_id;
        assert!(merge(&mut trusted, None, ORG, &[swapped], &[]).is_empty());
        assert_eq!(trusted, [trusted_of(&k1)]);
    }

    #[test]
    fn a_retired_key_goes_only_after_a_document_of_another_key_and_never_the_last() {
        let (k1, k2) = (test_key(), test_key_2());
        let id1 = trusted_of(&k1).key_id;
        let mut trusted = vec![trusted_of(&k1), trusted_of(&k2)];
        let retired = [id1.clone()];
        // No document yet, or the last one was signed by k1: k1 stays.
        assert!(merge(&mut trusted, None, ORG, &[], &retired).is_empty());
        assert!(merge(&mut trusted, Some(&id1), ORG, &[], &retired).is_empty());
        // A document of k2 was accepted: k1 goes.
        let change = merge(&mut trusted, Some(&trusted_of(&k2).key_id), ORG, &[], &retired);
        assert_eq!(change.dropped, [id1]);
        assert_eq!(trusted, [trusted_of(&k2)]);
        // The last key stays even when listed as retired.
        let only = [trusted_of(&k2).key_id];
        assert!(merge(&mut trusted, Some("ffffffffffffffff"), ORG, &[], &only).is_empty());
        assert_eq!(trusted.len(), 1);
    }

    #[test]
    fn a_leaked_retired_key_cannot_endorse_an_attacker_key() {
        let (k1, k2, attacker) = (test_key(), test_key_2(), test_key_3());
        let id1 = trusted_of(&k1).key_id;
        // k1 leaked after it was retired; the backend lists an attacker key that k1
        // "endorsed" and marks k1 retired (as it is).
        let keys = [published(&k1, None), published(&attacker, Some(&k1))];
        let mut trusted = vec![trusted_of(&k1)];
        let retired = [id1.clone()];
        assert!(merge(&mut trusted, None, ORG, &keys, &retired).is_empty());
        assert_eq!(trusted, [trusted_of(&k1)]);
        // Same with the active key already trusted: the retired one still cannot add.
        let mut trusted = vec![trusted_of(&k1), trusted_of(&k2)];
        let change = merge(&mut trusted, Some(&trusted_of(&k2).key_id), ORG, &keys, &retired);
        assert_eq!(change.added, Vec::<String>::new());
        assert_eq!(change.dropped, retired);
        assert_eq!(trusted, [trusted_of(&k2)]);
        // The attacker key listed as retired itself is never added, even when the
        // active key endorsed it.
        let mut trusted = vec![trusted_of(&k2)];
        let listed = [published(&attacker, Some(&k2))];
        assert!(merge(&mut trusted, None, ORG, &listed, &[trusted_of(&attacker).key_id]).is_empty());
        // The same key is added when it is not retired: the rule is about retirement.
        assert_eq!(merge(&mut trusted, None, ORG, &listed, &[]).added, [trusted_of(&attacker).key_id]);
    }

    fn shared_with(state: AgentState) -> (TempDir, std::sync::Arc<SharedState>) {
        use crate::platform::sim::SimPlatform;
        use crate::platform::Platform;
        use crate::state::StateStore;
        let dir = TempDir::new();
        let platform: std::sync::Arc<dyn Platform> = std::sync::Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        let store = StateStore::open(&dir.path().join("state")).unwrap();
        (dir, SharedState::new(store, state, platform))
    }

    fn enrolled(trusted: Vec<TrustedKey>) -> AgentState {
        use crate::state::Enrollment;
        AgentState {
            enrollment: Some(Enrollment {
                convex_url: "https://x.convex.cloud".into(),
                device_id: "dev-1".into(),
                org_id: ORG.into(),
                device_name: "Desk".into(),
                enrolled_at_ms: 1,
                revoked: false,
                allow_joined: false,
            }),
            trusted_keys: trusted,
            ..AgentState::default()
        }
    }

    #[test]
    fn no_organization_fails_closed_with_a_typed_error() {
        let (k1, k2) = (test_key(), test_key_2());
        // Not enrolled at all, and enrolled with an empty organization id.
        let (_dir, shared) = shared_with(AgentState { trusted_keys: vec![trusted_of(&k1)], ..AgentState::default() });
        let keys = [published(&k1, None), published(&k2, Some(&k1))];
        assert_eq!(update(&shared, &keys, &[]), Err(TrustError::NotEnrolled));
        assert_eq!(verification_inputs(&shared), Err(TrustError::NotEnrolled));
        assert_eq!(add_key(&shared, trusted_of(&k2)), Err(TrustError::NotEnrolled));
        assert_eq!(shared.get().trusted_keys, [trusted_of(&k1)]);

        let mut state = enrolled(vec![trusted_of(&k1)]);
        state.enrollment.as_mut().unwrap().org_id = String::new();
        let (_dir, shared) = shared_with(state);
        assert_eq!(update(&shared, &keys, &[]), Err(TrustError::NotEnrolled));
        assert_eq!(shared.get().trusted_keys, [trusted_of(&k1)]);
    }

    #[test]
    fn update_is_atomic_with_an_administrator_adding_a_key() {
        let (k1, k2, k3) = (test_key(), test_key_2(), test_key_3());
        let (dir, shared) = shared_with(enrolled(vec![trusted_of(&k1)]));
        // The administrator's key lands first; the merge that follows keeps it and
        // adds the endorsed one next to it (the old read-merge-write dropped it).
        assert_eq!(add_key(&shared, trusted_of(&k3)), Ok(true));
        assert_eq!(add_key(&shared, trusted_of(&k3)), Ok(false));
        let change = update(&shared, &[published(&k2, Some(&k1))], &[]).unwrap();
        assert_eq!(change.added, [trusted_of(&k2).key_id]);
        let ids = trusted_key_ids(&shared.get().trusted_keys);
        assert_eq!(ids.len(), 3);
        // And from many threads at once nothing is lost.
        let shared = std::sync::Arc::new(shared);
        let handles: Vec<_> = (0..8u8)
            .map(|i| {
                let shared = std::sync::Arc::clone(&shared);
                std::thread::spawn(move || {
                    let mut raw = [0u8; 32];
                    raw[0] = i + 1;
                    let key = ed25519_dalek::SigningKey::from_bytes(&raw);
                    if i % 2 == 0 {
                        add_key(&shared, trusted_of(&key)).unwrap();
                    } else {
                        update(&shared, &[published(&key, None)], &[]).unwrap();
                    }
                    trusted_of(&key).key_id
                })
            })
            .collect();
        let added: Vec<String> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let kept = shared.get().trusted_keys;
        for (i, id) in added.iter().enumerate() {
            // Even workers added a key; odd ones listed an unendorsed key (refused).
            assert_eq!(kept.iter().any(|k| &k.key_id == id), i % 2 == 0, "worker {i}");
        }
        // What is on disk is what is in memory.
        let on_disk: AgentState =
            serde_json::from_slice(&std::fs::read(dir.path().join("state").join("agent-state.json")).unwrap()).unwrap();
        assert_eq!(on_disk.trusted_keys, kept);
    }

    #[test]
    fn ids_are_sorted_for_the_status() {
        let keys = [trusted_of(&test_key_2()), trusted_of(&test_key())];
        assert_eq!(trusted_key_ids(&keys), ["21fe31dfa154a261", "39f713d0a644253f"]);
    }
}
