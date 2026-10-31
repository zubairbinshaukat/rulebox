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
//! key is never dropped.

use rulebox_policy::envelope::{verify_endorsement, PublishedKey, TrustedKey};

use crate::state::SharedState;

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

/// The trust store after one `headState` result. Pure.
///
/// 1. `keys` in the given order (oldest first): a key not trusted yet is added
///    when its endorsement verifies against the keys trusted at that moment. A
///    listed key whose id is trusted but whose public key differs is ignored
///    (a trusted key is never replaced).
/// 2. Every id in `retired` is dropped when `last_doc_key_id` is set and is
///    another key, and it is not the last key.
pub fn merge(
    trusted: &mut Vec<TrustedKey>,
    last_doc_key_id: Option<&str>,
    org_id: &str,
    keys: &[PublishedKey],
    retired: &[String],
) -> TrustChange {
    let mut change = TrustChange::default();
    for key in keys {
        if let Some(known) = trusted.iter().find(|known| known.key_id == key.key_id) {
            if known.public_key != key.public_key {
                tracing::warn!(key_id = %key.key_id, "the backend lists another public key under a trusted key id; ignored");
            }
            continue;
        }
        match verify_endorsement(key, trusted, org_id) {
            Ok(added) => {
                tracing::info!(key_id = %added.key_id, "trusting a new policy key (endorsed by a trusted key)");
                change.added.push(added.key_id.clone());
                trusted.push(added);
            }
            Err(error) => tracing::debug!(key_id = %key.key_id, "not trusting a listed key: {error}"),
        }
    }
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
    change
}

/// [`merge`] on the saved state; saves `agent-state.json` when it changed.
/// Returns what changed.
pub fn update(shared: &SharedState, keys: &[PublishedKey], retired: &[String]) -> TrustChange {
    let (mut trusted, last, org_id) = shared.read(|state| {
        (
            state.trusted_keys.clone(),
            state.last_doc_key_id.clone(),
            state.enrollment.as_ref().map(|e| e.org_id.clone()).unwrap_or_default(),
        )
    });
    let change = merge(&mut trusted, last.as_deref(), &org_id, keys, retired);
    if !change.is_empty() {
        if let Err(error) = shared.update(|state| state.trusted_keys = trusted) {
            tracing::error!("cannot save the trusted keys: {error}");
        }
    }
    change
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
    fn ids_are_sorted_for_the_status() {
        let keys = [trusted_of(&test_key_2()), trusted_of(&test_key())];
        assert_eq!(trusted_key_ids(&keys), ["21fe31dfa154a261", "39f713d0a644253f"]);
    }
}
