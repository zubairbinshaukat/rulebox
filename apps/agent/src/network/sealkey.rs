//! The device sealing key (plan 4.18): an X25519 key pair created on the first Phase 5 start.
//! The private half lives only in `Secrets` (DPAPI machine scope on Windows); the public half
//! goes to the server once (`deviceApi:registerSealKey`), which seals Wi-Fi passphrases to it.
//!
//! Nothing here logs a key. The reconciler (Step 20) calls [`ensure`] at start and sends
//! [`pending_registration`]'s call, then records the key id in `AgentState.seal_key_registered`.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use rulebox_policy::envelope::key_id_of;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::backend::reports::LockdownCall;
use crate::platform::PlatformError;
use crate::state::SharedState;

/// The public half of the sealing key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealPublic {
    /// Standard base64 of the 32 public-key bytes (what `registerSealKey` takes).
    pub public_b64: String,
    /// `key_id_of(public bytes)`: the server's `sealKeyIdOf`, and `SealedBox.keyId`.
    pub key_id: String,
}

fn decode_secret(text: &str) -> Option<Zeroizing<[u8; 32]>> {
    let bytes = Zeroizing::new(STANDARD.decode(text).ok()?);
    let array: [u8; 32] = bytes.as_slice().try_into().ok()?;
    Some(Zeroizing::new(array))
}

fn public_of(secret: &[u8; 32]) -> SealPublic {
    let public = PublicKey::from(&StaticSecret::from(*secret));
    SealPublic { public_b64: STANDARD.encode(public.as_bytes()), key_id: key_id_of(public.as_bytes()) }
}

/// The device's sealing key: created and saved the first time, read back afterwards. A saved
/// value that does not decode is an error (it is never replaced silently: a new key would make
/// every sealed box addressed to the old one unopenable without anybody noticing).
pub fn ensure(shared: &SharedState) -> Result<SealPublic, PlatformError> {
    let saved = shared.secrets(|secrets| secrets.seal_secret.clone())?;
    if let Some(text) = saved {
        let secret = Zeroizing::new(text);
        return decode_secret(&secret)
            .map(|bytes| public_of(&bytes))
            .ok_or_else(|| PlatformError::Other("the saved sealing key does not decode".into()));
    }
    let mut bytes = Zeroizing::new([0u8; 32]);
    getrandom::fill(bytes.as_mut_slice())
        .map_err(|_| PlatformError::Other("the operating system gave no random numbers".into()))?;
    let encoded = STANDARD.encode(bytes.as_slice());
    shared.update_secrets(|secrets| secrets.seal_secret = Some(encoded))?;
    Ok(public_of(&bytes))
}

/// The private key, or `None` when the device has none yet (a box then cannot be opened).
pub fn secret(shared: &SharedState) -> Result<Option<Zeroizing<[u8; 32]>>, PlatformError> {
    let saved = shared.secrets(|secrets| secrets.seal_secret.clone())?.map(Zeroizing::new);
    match saved {
        None => Ok(None),
        Some(text) => decode_secret(&text)
            .map(Some)
            .ok_or_else(|| PlatformError::Other("the saved sealing key does not decode".into())),
    }
}

/// The `registerSealKey` call that is due, if any: none when the server already has this key
/// (`registered` is its id), else one call with the public key. Pure.
pub fn pending_registration(registered: Option<&str>, key: &SealPublic) -> Option<LockdownCall> {
    if registered == Some(key.key_id.as_str()) {
        return None;
    }
    Some(LockdownCall::RegisterSealKey { public_key: key.public_b64.clone() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::sim::SimPlatform;
    use crate::platform::Platform;
    use crate::state::{AgentState, StateStore};
    use crate::testutil::TempDir;
    use std::sync::Arc;

    fn shared(dir: &TempDir) -> (Arc<SimPlatform>, Arc<SharedState>) {
        let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        let dyn_platform: Arc<dyn Platform> = platform.clone();
        let shared = SharedState::new(StateStore::open(&dir.path().join("state")).unwrap(), AgentState::default(), dyn_platform);
        (platform, shared)
    }

    #[test]
    fn the_key_is_created_once_and_kept() {
        let dir = TempDir::new();
        let (_platform, shared) = shared(&dir);
        assert!(secret(&shared).unwrap().is_none());
        let first = ensure(&shared).unwrap();
        let again = ensure(&shared).unwrap();
        assert_eq!(first, again);
        assert_eq!(first.key_id.len(), 16);
        let public = STANDARD.decode(&first.public_b64).unwrap();
        assert_eq!(public.len(), 32);
        let private = secret(&shared).unwrap().unwrap();
        let from_private = public_of(&private);
        assert_eq!(from_private, first);
        // It is in the secrets file and not in the state file.
        let stored = shared.secrets(|s| s.seal_secret.clone()).unwrap().unwrap();
        assert!(!serde_json::to_string(&shared.get()).unwrap().contains(&stored));
    }

    #[test]
    fn a_damaged_saved_key_is_an_error_not_a_new_key() {
        let dir = TempDir::new();
        let (_platform, shared) = shared(&dir);
        shared.update_secrets(|s| s.seal_secret = Some("not a key".into())).unwrap();
        assert!(ensure(&shared).is_err());
        assert!(secret(&shared).is_err());
        assert_eq!(shared.secrets(|s| s.seal_secret.clone()).unwrap().as_deref(), Some("not a key"));
    }

    #[test]
    fn two_devices_get_different_keys() {
        let (a, b) = (TempDir::new(), TempDir::new());
        let (_p1, s1) = shared(&a);
        let (_p2, s2) = shared(&b);
        assert_ne!(ensure(&s1).unwrap().key_id, ensure(&s2).unwrap().key_id);
    }

    #[test]
    fn registration_is_due_until_the_server_has_this_key() {
        let key = SealPublic { public_b64: "AAAA".into(), key_id: "d280093620494f96".into() };
        let call = pending_registration(None, &key).unwrap();
        assert_eq!(call, LockdownCall::RegisterSealKey { public_key: "AAAA".into() });
        assert!(pending_registration(Some("d280093620494f96"), &key).is_none());
        // A different registered id (the key was replaced) is due again.
        assert!(pending_registration(Some("0000000000000000"), &key).is_some());
    }

    #[test]
    fn the_key_id_matches_the_policy_crate_vector() {
        // The committed vector's device key (made by the TypeScript side).
        let secret_bytes = STANDARD.decode("CqXdQK3Kh+t74e263L1KOQmZT/FBt3sOTRl7QLrb7vA=").unwrap();
        let secret: [u8; 32] = secret_bytes.try_into().unwrap();
        let public = public_of(&secret);
        assert_eq!(public.key_id, "d280093620494f96");
        assert_eq!(public.public_b64, "Es/TaB5vKMB/tYJx5iq0lb14KzQZ4PFX+1lIGZXseWo=");
    }
}
