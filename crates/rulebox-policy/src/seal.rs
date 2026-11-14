//! Sealed boxes `rulebox.seal/1` (plan Phase 5, Section 4.18): how a Wi-Fi
//! passphrase reaches one device without the signed document, a log or a backup
//! ever holding it in the clear.
//!
//! The server makes a box with an ephemeral X25519 key pair and the device's public
//! sealing key; the agent opens it with the device's private key (kept in the DPAPI
//! `Secrets` store, never in this crate). Key = HKDF-SHA256 over the shared secret,
//! `salt = epk || devicePk`, `info = "rulebox.seal/1|" + orgId + "|" + deviceId +
//! "|wifi|" + profileId`; cipher = XChaCha20-Poly1305 with a random 24-byte nonce and
//! no extra associated data. The `info` binds the box to its organization, device and
//! profile, so a box copied to another device or profile does not open.
//!
//! `tests/vectors/seal.json` (written by `scripts/vectors/seal.mjs` with
//! `@noble/curves` and `@noble/ciphers`, an independent implementation) pins the
//! format in both languages. The plaintext comes back in a [`Zeroizing`] buffer.
//! Nothing here logs or prints a plaintext, a key or a ciphertext.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use chacha20poly1305::aead::Aead;
use chacha20poly1305::{KeyInit, XChaCha20Poly1305};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use ts_rs::TS;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::envelope::key_id_of;

/// `SealedBox.v` of this format.
pub const SEAL_VERSION: u32 = 1;
const INFO_PREFIX: &str = "rulebox.seal/1|";
const NONCE_LEN: usize = 24;
/// Poly1305 tag.
const TAG_LEN: usize = 16;
/// Longest plaintext a box can hold here (a Wi-Fi passphrase is at most 63 characters).
const MAX_PLAINTEXT: usize = 256;

/// `{ v, keyId, epk, nonce, ct }`, every binary field base64 (standard alphabet).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SealedBox {
    pub v: u32,
    /// Id of the device sealing key the box is addressed to ([`key_id_of`] of its public key).
    pub key_id: String,
    /// The ephemeral X25519 public key (32 bytes).
    pub epk: String,
    /// 24 random bytes.
    pub nonce: String,
    /// Ciphertext followed by the 16-byte tag.
    pub ct: String,
}

impl std::fmt::Debug for SealedBox {
    // Not derived: no key material or ciphertext in a log line.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SealedBox").field("v", &self.v).field("key_id", &self.key_id).finish_non_exhaustive()
    }
}

/// Why a box did not open. Fixed texts: never a key or a plaintext.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SealError {
    #[error("sealed box version is not supported")]
    BadVersion,
    #[error("sealed box is not valid base64 or has the wrong length")]
    BadEncoding,
    #[error("an id contains a character that is not allowed")]
    BadId,
    /// The box is addressed to another device key.
    #[error("sealed box is for another device key")]
    WrongKey,
    /// Wrong organization, device or profile, a changed byte, or a bad ephemeral key.
    #[error("sealed box does not open")]
    Open,
}

fn info(org_id: &str, device_id: &str, profile_id: &str) -> Result<String, SealError> {
    if [org_id, device_id, profile_id].iter().any(|id| id.is_empty() || id.contains('|')) {
        return Err(SealError::BadId);
    }
    Ok(format!("{INFO_PREFIX}{org_id}|{device_id}|wifi|{profile_id}"))
}

fn decode_fixed<const N: usize>(text: &str) -> Result<[u8; N], SealError> {
    let bytes = STANDARD.decode(text).map_err(|_| SealError::BadEncoding)?;
    bytes.try_into().map_err(|_| SealError::BadEncoding)
}

/// The 32-byte key of one box: HKDF-SHA256 over the shared secret.
fn box_key(shared: &[u8; 32], epk: &[u8; 32], device_pk: &[u8; 32], info: &str) -> Zeroizing<[u8; 32]> {
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(epk);
    salt[32..].copy_from_slice(device_pk);
    let mut key = Zeroizing::new([0u8; 32]);
    // A 32-byte output is far below the HKDF limit (255 * 32), so this cannot fail.
    if Hkdf::<Sha256>::new(Some(&salt), shared).expand(info.as_bytes(), key.as_mut()).is_err() {
        key.fill(0);
    }
    key
}

/// Opens `sealed` with the device's private sealing key. Fails with
/// [`SealError::WrongKey`] when the box names another key, and with
/// [`SealError::Open`] for every other failure (wrong `device_id`, `org_id` or
/// `profile_id`, a changed byte, a low-order ephemeral key): no oracle.
pub fn open_sealed(
    sealed: &SealedBox,
    device_secret: &[u8; 32],
    org_id: &str,
    device_id: &str,
    profile_id: &str,
) -> Result<Zeroizing<Vec<u8>>, SealError> {
    if sealed.v != SEAL_VERSION {
        return Err(SealError::BadVersion);
    }
    let info = info(org_id, device_id, profile_id)?;
    let epk_bytes: [u8; 32] = decode_fixed(&sealed.epk)?;
    let nonce: [u8; NONCE_LEN] = decode_fixed(&sealed.nonce)?;
    let ct = STANDARD.decode(&sealed.ct).map_err(|_| SealError::BadEncoding)?;
    if ct.len() < TAG_LEN || ct.len() > MAX_PLAINTEXT + TAG_LEN {
        return Err(SealError::BadEncoding);
    }

    let secret = StaticSecret::from(*device_secret);
    let device_pk = PublicKey::from(&secret);
    if sealed.key_id != key_id_of(device_pk.as_bytes()) {
        return Err(SealError::WrongKey);
    }
    let shared = secret.diffie_hellman(&PublicKey::from(epk_bytes));
    if !shared.was_contributory() {
        return Err(SealError::Open);
    }
    let key = box_key(shared.as_bytes(), &epk_bytes, device_pk.as_bytes(), &info);
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_ref()).map_err(|_| SealError::Open)?;
    let plaintext = cipher.decrypt((&nonce).into(), ct.as_slice()).map_err(|_| SealError::Open)?;
    Ok(Zeroizing::new(plaintext))
}

/// For tests only: seals `plaintext` for `device_public` with the given ephemeral
/// secret and nonce (the caller supplies the randomness, so the vectors are
/// deterministic). The server side of the format lives in Convex (Phase 5 Step 10).
#[cfg(test)]
pub(crate) fn seal(
    plaintext: &[u8],
    device_public: &[u8; 32],
    ephemeral_secret: [u8; 32],
    nonce: [u8; NONCE_LEN],
    org_id: &str,
    device_id: &str,
    profile_id: &str,
) -> SealedBox {
    let info = info(org_id, device_id, profile_id).expect("ids");
    let secret = StaticSecret::from(ephemeral_secret);
    let epk = PublicKey::from(&secret);
    let shared = secret.diffie_hellman(&PublicKey::from(*device_public));
    let key = box_key(shared.as_bytes(), epk.as_bytes(), device_public, &info);
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_ref()).expect("key");
    let ct = cipher.encrypt((&nonce).into(), plaintext).expect("encrypt");
    SealedBox {
        v: SEAL_VERSION,
        key_id: key_id_of(device_public),
        epk: STANDARD.encode(epk.as_bytes()),
        nonce: STANDARD.encode(nonce),
        ct: STANDARD.encode(ct),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const ORG: &str = "org1";
    const DEVICE: &str = "dev1";
    const PROFILE: &str = "wifi1";

    fn device() -> ([u8; 32], [u8; 32]) {
        let secret = [7u8; 32];
        let public = *PublicKey::from(&StaticSecret::from(secret)).as_bytes();
        (secret, public)
    }

    fn make(plaintext: &[u8]) -> SealedBox {
        let (_, public) = device();
        seal(plaintext, &public, [9u8; 32], [3u8; 24], ORG, DEVICE, PROFILE)
    }

    #[test]
    fn round_trip() {
        let (secret, _) = device();
        let sealed = make(b"correct horse battery");
        let opened = open_sealed(&sealed, &secret, ORG, DEVICE, PROFILE).unwrap();
        assert_eq!(opened.as_slice(), b"correct horse battery");
        // The empty plaintext and a long one also work.
        let long = vec![b'x'; 63];
        let opened = open_sealed(&make(&long), &secret, ORG, DEVICE, PROFILE).unwrap();
        assert_eq!(opened.as_slice(), long.as_slice());
    }

    #[test]
    fn a_box_for_another_device_profile_or_org_does_not_open() {
        let (secret, _) = device();
        let sealed = make(b"secret");
        assert_eq!(open_sealed(&sealed, &secret, ORG, "dev2", PROFILE), Err(SealError::Open));
        assert_eq!(open_sealed(&sealed, &secret, ORG, DEVICE, "wifi2"), Err(SealError::Open));
        assert_eq!(open_sealed(&sealed, &secret, "org2", DEVICE, PROFILE), Err(SealError::Open));
        // Ids cannot be joined into a different binding.
        assert_eq!(open_sealed(&sealed, &secret, "org1|dev1", "x", PROFILE), Err(SealError::BadId));
        assert_eq!(open_sealed(&sealed, &secret, ORG, "", PROFILE), Err(SealError::BadId));
    }

    #[test]
    fn another_device_key_is_reported_as_wrong_key() {
        let sealed = make(b"secret");
        assert_eq!(open_sealed(&sealed, &[8u8; 32], ORG, DEVICE, PROFILE), Err(SealError::WrongKey));
    }

    #[test]
    fn tampering_and_bad_shapes_are_refused() {
        let (secret, _) = device();
        let sealed = make(b"secret");

        let mut flipped = sealed.clone();
        let mut ct = STANDARD.decode(&flipped.ct).unwrap();
        ct[0] ^= 1;
        flipped.ct = STANDARD.encode(ct);
        assert_eq!(open_sealed(&flipped, &secret, ORG, DEVICE, PROFILE), Err(SealError::Open));

        let mut other_nonce = sealed.clone();
        other_nonce.nonce = STANDARD.encode([4u8; 24]);
        assert_eq!(open_sealed(&other_nonce, &secret, ORG, DEVICE, PROFILE), Err(SealError::Open));

        let mut version = sealed.clone();
        version.v = 2;
        assert_eq!(open_sealed(&version, &secret, ORG, DEVICE, PROFILE), Err(SealError::BadVersion));

        for bad in [
            SealedBox { epk: STANDARD.encode([1u8; 31]), ..sealed.clone() },
            SealedBox { nonce: STANDARD.encode([1u8; 23]), ..sealed.clone() },
            SealedBox { ct: STANDARD.encode([1u8; 15]), ..sealed.clone() },
            SealedBox { ct: STANDARD.encode([1u8; 400]), ..sealed.clone() },
            SealedBox { ct: "not base64!".into(), ..sealed.clone() },
        ] {
            assert_eq!(open_sealed(&bad, &secret, ORG, DEVICE, PROFILE), Err(SealError::BadEncoding));
        }

        // The all-zero public key gives an all-zero shared secret: refused.
        let zero_epk = SealedBox { epk: STANDARD.encode([0u8; 32]), ..sealed };
        assert_eq!(open_sealed(&zero_epk, &secret, ORG, DEVICE, PROFILE), Err(SealError::Open));
    }

    #[test]
    fn debug_shows_no_ciphertext() {
        let sealed = make(b"secret");
        let text = format!("{sealed:?}");
        assert!(!text.contains(&sealed.ct) && !text.contains(&sealed.epk));
    }

    fn vectors() -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/vectors/seal.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn b64<const N: usize>(value: &Value) -> [u8; N] {
        decode_fixed(value.as_str().unwrap()).unwrap()
    }

    #[test]
    fn vectors_made_by_noble_open_here_and_rebuild_byte_for_byte() {
        let v = vectors();
        let secret: [u8; 32] = b64(&v["deviceSecret"]);
        let public: [u8; 32] = b64(&v["devicePublic"]);
        assert_eq!(PublicKey::from(&StaticSecret::from(secret)).as_bytes(), &public);
        assert_eq!(v["keyId"].as_str().unwrap(), key_id_of(&public));
        let cases = v["cases"].as_array().unwrap();
        assert!(cases.len() >= 3);
        for case in cases {
            let sealed: SealedBox = serde_json::from_value(case["box"].clone()).unwrap();
            let (org, device, profile) =
                (case["orgId"].as_str().unwrap(), case["deviceId"].as_str().unwrap(), case["profileId"].as_str().unwrap());
            let plaintext = case["plaintext"].as_str().unwrap();
            let opened = open_sealed(&sealed, &secret, org, device, profile).unwrap();
            assert_eq!(std::str::from_utf8(&opened).unwrap(), plaintext, "{}", case["name"]);
            // And the Rust sealer, given the same randomness, writes the same bytes.
            let rebuilt = seal(plaintext.as_bytes(), &public, b64(&case["ephemeralSecret"]), b64(&case["nonceBytes"]), org, device, profile);
            assert_eq!(rebuilt, sealed, "{}", case["name"]);
        }
    }

    #[test]
    fn negative_vectors_fail_with_their_reason() {
        let v = vectors();
        let secret: [u8; 32] = b64(&v["deviceSecret"]);
        let negatives = v["negative"].as_array().unwrap();
        assert!(negatives.len() >= 3);
        let mut reasons = Vec::new();
        for case in negatives {
            let sealed: SealedBox = serde_json::from_value(case["box"].clone()).unwrap();
            let got = open_sealed(
                &sealed,
                &secret,
                case["orgId"].as_str().unwrap(),
                case["deviceId"].as_str().unwrap(),
                case["profileId"].as_str().unwrap(),
            );
            let reason = match got {
                Ok(_) => "opened",
                Err(SealError::Open) => "open",
                Err(SealError::WrongKey) => "wrongKey",
                Err(SealError::BadVersion) => "badVersion",
                Err(SealError::BadEncoding) => "badEncoding",
                Err(SealError::BadId) => "badId",
            };
            assert_eq!(reason, case["reason"].as_str().unwrap(), "{}", case["name"]);
            reasons.push(reason);
        }
        // A box with a different deviceId must be among them.
        assert!(negatives.iter().any(|c| c["name"] == "other-device-id"));
        assert!(reasons.contains(&"open"));
    }
}
