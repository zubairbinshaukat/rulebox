//! Signed desired-state documents and the key trust store (plan Phase 4,
//! Sections 4.4 / 4.5 and Step 9). No I/O: the agent feeds it what the backend
//! sent and what it trusts.
//!
//! What is signed is the UTF-8 bytes of `payload`, exactly as received: there is
//! no canonicalization anywhere. The signature is checked with Ed25519 STRICT
//! rules (`verify_strict`: a non-canonical S or a small-order point is refused)
//! **before** the payload is parsed, so a forged document never reaches the JSON
//! parser. The checks run in the order of the committed vectors
//! (`tests/vectors/signed-v2-negative.json`, `procedure`).

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// `payload.format` of a version 2 document.
pub const PAYLOAD_FORMAT: &str = "rulebox.desired/2";
/// First line of the message an active key signs to endorse the next key:
/// `"rulebox.key-endorsement/1\n<orgId>\n<keyId>\n<publicKeyBase64>"`.
pub const ENDORSEMENT_FORMAT: &str = "rulebox.key-endorsement/1";

/// A key this device trusts. `public_key` is standard base64 of the 32 raw bytes;
/// `key_id` is [`key_id_of`] of them (checked whenever a key is added).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedKey {
    pub key_id: String,
    pub public_key: String,
}

impl TrustedKey {
    /// A key from its base64 public key: decodes it, refuses a weak key and
    /// computes the key id.
    pub fn from_public_key(public_key_b64: &str) -> Result<Self, VerifyError> {
        let key = decode_key(public_key_b64.trim())?;
        Ok(Self { key_id: key_id_of(key.as_bytes()), public_key: STANDARD.encode(key.as_bytes()) })
    }

    /// A key as the backend listed it: the stated id must be the id of the key.
    pub fn checked(key_id: &str, public_key_b64: &str) -> Result<Self, VerifyError> {
        let key = Self::from_public_key(public_key_b64)?;
        if key.key_id != key_id {
            return Err(VerifyError::KeyIdMismatch);
        }
        Ok(key)
    }
}

/// The envelope of `devices:fetchDesired`: `{ version, payload, signature, keyId }`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedEnvelope {
    pub version: u64,
    pub payload: String,
    pub signature: String,
    pub key_id: String,
}

impl std::fmt::Debug for SignedEnvelope {
    // Not derived: `payload` holds the exit PIN hash.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignedEnvelope")
            .field("version", &self.version)
            .field("key_id", &self.key_id)
            .field("payload_bytes", &self.payload.len())
            .finish_non_exhaustive()
    }
}

/// The signed payload, parsed only after its signature verified.
#[derive(Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Payload {
    pub format: String,
    pub key_id: String,
    pub org_id: String,
    pub device_id: String,
    pub version: u64,
    pub issued_at_ms: u64,
    /// The raw document, agent-only keys included.
    pub doc: serde_json::Value,
}

impl std::fmt::Debug for Payload {
    // Not derived: `doc` holds the exit PIN hash.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Payload")
            .field("format", &self.format)
            .field("key_id", &self.key_id)
            .field("org_id", &self.org_id)
            .field("device_id", &self.device_id)
            .field("version", &self.version)
            .field("issued_at_ms", &self.issued_at_ms)
            .finish_non_exhaustive()
    }
}

/// One `keys` entry of `devices:headState`: every key of the organization,
/// with the endorsement by the key that was active when it was prepared.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedKey {
    pub key_id: String,
    pub public_key: String,
    pub endorsement: Option<Endorsement>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endorsement {
    pub by_key_id: String,
    pub signature: String,
}

/// Why a signed message was refused. [`VerifyError::reason`] is the wire spelling
/// (the `reason` of the negative vectors; also what the agent logs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum VerifyError {
    /// The key id is not among the trusted keys.
    #[error("unknown_key")]
    UnknownKey,
    /// A key or signature is not standard base64 of the right length, or the key
    /// is not a valid (or is a weak) Ed25519 point.
    #[error("bad_encoding")]
    BadEncoding,
    /// The signature does not verify under the strict rules.
    #[error("bad_signature")]
    BadSignature,
    /// The signed bytes are not the expected JSON, or name another format.
    #[error("bad_format")]
    BadFormat,
    /// The signed payload names a different key than the envelope (or a listed
    /// key id is not the id of its key).
    #[error("key_id_mismatch")]
    KeyIdMismatch,
    #[error("wrong_org")]
    WrongOrg,
    #[error("wrong_device")]
    WrongDevice,
    /// (roster) A snapshot signed for another group.
    #[error("wrong_group")]
    WrongGroup,
    /// The versions of the envelope, the payload, the document and the head do
    /// not all agree (a replayed or relabelled document).
    #[error("version_mismatch")]
    VersionMismatch,
    /// The body does not match the head that announced it (key id).
    #[error("head_mismatch")]
    HeadMismatch,
}

impl VerifyError {
    pub fn reason(self) -> &'static str {
        match self {
            VerifyError::UnknownKey => "unknown_key",
            VerifyError::BadEncoding => "bad_encoding",
            VerifyError::BadSignature => "bad_signature",
            VerifyError::BadFormat => "bad_format",
            VerifyError::KeyIdMismatch => "key_id_mismatch",
            VerifyError::WrongOrg => "wrong_org",
            VerifyError::WrongDevice => "wrong_device",
            VerifyError::WrongGroup => "wrong_group",
            VerifyError::VersionMismatch => "version_mismatch",
            VerifyError::HeadMismatch => "head_mismatch",
        }
    }
}

/// Key id: the first 16 lower-case hex characters of SHA-256 of the 32 raw
/// public-key bytes.
pub fn key_id_of(public_key: &[u8; 32]) -> String {
    let digest = Sha256::digest(public_key);
    digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

/// SHA-256 of the UTF-8 bytes of `text`, as 64 lower-case hex characters.
pub fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Standard base64 (with padding) of exactly 32 bytes that are a valid, non-weak
/// Ed25519 public key.
fn decode_key(b64: &str) -> Result<VerifyingKey, VerifyError> {
    let bytes: [u8; 32] = STANDARD
        .decode(b64)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(VerifyError::BadEncoding)?;
    let key = VerifyingKey::from_bytes(&bytes).map_err(|_| VerifyError::BadEncoding)?;
    if key.is_weak() {
        return Err(VerifyError::BadEncoding);
    }
    Ok(key)
}

/// Standard base64 (with padding) of exactly 64 bytes.
fn decode_signature(b64: &str) -> Result<Signature, VerifyError> {
    let bytes: [u8; 64] = STANDARD
        .decode(b64)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(VerifyError::BadEncoding)?;
    Ok(Signature::from_bytes(&bytes))
}

/// The trusted key named `key_id`, decoded.
fn trusted_key(trusted: &[TrustedKey], key_id: &str) -> Result<VerifyingKey, VerifyError> {
    let key = trusted.iter().find(|key| key.key_id == key_id).ok_or(VerifyError::UnknownKey)?;
    decode_key(&key.public_key)
}

/// Checks `signature_b64` over the UTF-8 bytes of `message` with the trusted key
/// `key_id`: unknown key, then encoding, then the strict signature check.
pub fn verify_message(
    message: &str,
    signature_b64: &str,
    key_id: &str,
    trusted: &[TrustedKey],
) -> Result<(), VerifyError> {
    let key = trusted_key(trusted, key_id)?;
    let signature = decode_signature(signature_b64)?;
    key.verify_strict(message.as_bytes(), &signature).map_err(|_| VerifyError::BadSignature)
}

/// Verifies a document envelope for this device. The order (each step only runs
/// when the ones before passed): the key is trusted (`UnknownKey`); key and
/// signature decode (`BadEncoding`); the strict signature over the payload bytes
/// (`BadSignature`); **only then** the payload is parsed (`BadFormat`, also for
/// another `format`); `payload.keyId == env.keyId` (`KeyIdMismatch`); the
/// organization (`WrongOrg`) and the device (`WrongDevice`); `payload.version ==
/// env.version == payload.doc.version` (`VersionMismatch`).
pub fn verify_envelope(
    env: &SignedEnvelope,
    trusted: &[TrustedKey],
    org_id: &str,
    device_id: &str,
) -> Result<Payload, VerifyError> {
    verify_message(&env.payload, &env.signature, &env.key_id, trusted)?;
    let payload: Payload = serde_json::from_str(&env.payload).map_err(|_| VerifyError::BadFormat)?;
    if payload.format != PAYLOAD_FORMAT || !payload.doc.is_object() {
        return Err(VerifyError::BadFormat);
    }
    if payload.key_id != env.key_id {
        return Err(VerifyError::KeyIdMismatch);
    }
    if payload.org_id != org_id {
        return Err(VerifyError::WrongOrg);
    }
    if payload.device_id != device_id {
        return Err(VerifyError::WrongDevice);
    }
    let doc_version = payload.doc.get("version").and_then(serde_json::Value::as_u64);
    if payload.version != env.version || doc_version != Some(payload.version) {
        return Err(VerifyError::VersionMismatch);
    }
    Ok(payload)
}

/// What the (unsigned) head announced; a body is applied only when it matches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadRef<'a> {
    pub version: u64,
    pub key_id: &'a str,
}

/// [`verify_envelope`], then the body must be the one the head announced: the
/// same version (`VersionMismatch`: an older document replayed as the answer)
/// and the same key id (`HeadMismatch`).
///
/// The head's `contentHash` is NOT compared: it is the SHA-256 of the document
/// re-serialized with version 0 (server-side de-duplication), which the agent
/// would have to rebuild byte for byte from parsed JSON. The signature already
/// binds every byte of the body.
pub fn verify_for_head(
    env: &SignedEnvelope,
    trusted: &[TrustedKey],
    org_id: &str,
    device_id: &str,
    head: &HeadRef<'_>,
) -> Result<Payload, VerifyError> {
    let payload = verify_envelope(env, trusted, org_id, device_id)?;
    if payload.version != head.version {
        return Err(VerifyError::VersionMismatch);
    }
    if payload.key_id != head.key_id {
        return Err(VerifyError::HeadMismatch);
    }
    Ok(payload)
}

/// The exact message of a key endorsement.
pub fn endorsement_message(org_id: &str, key_id: &str, public_key_b64: &str) -> String {
    format!("{ENDORSEMENT_FORMAT}\n{org_id}\n{key_id}\n{public_key_b64}")
}

/// A published key becomes trusted when its id is the id of its key and its
/// endorsement, for this organization, verifies under a key already trusted.
/// `UnknownKey` when it has no endorsement or the endorsing key is not trusted.
pub fn verify_endorsement(
    key: &PublishedKey,
    trusted: &[TrustedKey],
    org_id: &str,
) -> Result<TrustedKey, VerifyError> {
    let candidate = TrustedKey::checked(&key.key_id, &key.public_key)?;
    let endorsement = key.endorsement.as_ref().ok_or(VerifyError::UnknownKey)?;
    // The message carries the key exactly as listed (it is what was signed).
    let message = endorsement_message(org_id, &key.key_id, &key.public_key);
    verify_message(&message, &endorsement.signature, &endorsement.by_key_id, trusted)?;
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::{json, Value};

    /// RFC 8032 section 7.1, TEST 1 (published; the seed of the committed vectors).
    const TEST1_SEED: &str = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
    const TEST1_PUBLIC: &str = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
    const TEST1_SIGNATURE: &str = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
    /// RFC 8032 TEST 2 (the "next" key of the vectors).
    const TEST2_SEED: &str = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
    }

    fn signing_key(seed_hex: &str) -> SigningKey {
        SigningKey::from_bytes(&hex(seed_hex).try_into().unwrap())
    }

    fn trusted_of(key: &SigningKey) -> TrustedKey {
        TrustedKey::from_public_key(&STANDARD.encode(key.verifying_key().as_bytes())).unwrap()
    }

    fn sign(key: &SigningKey, message: &str) -> String {
        STANDARD.encode(key.sign(message.as_bytes()).to_bytes())
    }

    fn read_vector(name: &str) -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("vectors").join(name);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn envelope_of(v: &Value) -> SignedEnvelope {
        serde_json::from_value(v.clone()).unwrap()
    }

    /// A signed version 2 payload for `org`/`device`, built like `buildPayload`.
    fn payload_text(key_id: &str, org: &str, device: &str, version: u64) -> String {
        json!({
            "format": PAYLOAD_FORMAT, "keyId": key_id, "orgId": org, "deviceId": device,
            "version": version, "issuedAtMs": 1, "doc": { "kioskEnabled": true, "version": version,
            "adminExit": { "pinHash": "$argon2id$hide-me" } }
        })
        .to_string()
    }

    fn signed(key: &SigningKey, org: &str, device: &str, version: u64) -> SignedEnvelope {
        let key_id = trusted_of(key).key_id;
        let payload = payload_text(&key_id, org, device, version);
        SignedEnvelope { version, signature: sign(key, &payload), payload, key_id }
    }

    #[test]
    fn rfc8032_test1() {
        let key = signing_key(TEST1_SEED);
        assert_eq!(key.verifying_key().as_bytes().to_vec(), hex(TEST1_PUBLIC));
        assert_eq!(key.sign(b"").to_bytes().to_vec(), hex(TEST1_SIGNATURE));
        // The vectors' key id of this key.
        assert_eq!(key_id_of(key.verifying_key().as_bytes()), "21fe31dfa154a261");
        let trusted = [trusted_of(&key)];
        let signature = STANDARD.encode(hex(TEST1_SIGNATURE));
        assert_eq!(verify_message("", &signature, "21fe31dfa154a261", &trusted), Ok(()));
    }

    #[test]
    fn vector_from_convex_verifies() {
        let v = read_vector("signed-v2.json");
        let trusted = [TrustedKey::checked(v["keyId"].as_str().unwrap(), v["publicKey"].as_str().unwrap()).unwrap()];
        let org = v["orgId"].as_str().unwrap();
        let device = v["deviceId"].as_str().unwrap();
        let env = envelope_of(&json!({
            "version": v["version"], "payload": v["payload"], "signature": v["signature"], "keyId": v["keyId"]
        }));
        let payload = verify_envelope(&env, &trusted, org, device).unwrap();
        assert_eq!((payload.version, payload.org_id.as_str(), payload.device_id.as_str()), (7, org, device));
        assert_eq!(payload.doc["version"], 7);
        assert_eq!(sha256_hex(&env.payload), v["payloadSha256"].as_str().unwrap());
        // The document is a DesiredState plus the agent-only keys.
        let desired: crate::DesiredState = serde_json::from_value(payload.doc.clone()).unwrap();
        assert!(desired.kiosk_enabled);
        let head = HeadRef { version: 7, key_id: &env.key_id };
        assert_eq!(verify_for_head(&env, &trusted, org, device, &head).unwrap(), payload);

        // The unicode document: the bytes as given, the escapes undone by the parser.
        let u = &v["unicode"];
        let env = envelope_of(&json!({
            "version": u["version"], "payload": u["payload"], "signature": u["signature"], "keyId": v["keyId"]
        }));
        assert!(env.payload.len() > env.payload.chars().count(), "multi-byte UTF-8");
        let payload = verify_envelope(&env, &trusted, org, device).unwrap();
        assert_eq!(payload.doc["orgName"], u["orgName"]);
        assert!(u["orgName"].as_str().unwrap().contains('\u{1}'));
        assert_eq!(sha256_hex(&env.payload), u["payloadSha256"].as_str().unwrap());
    }

    #[test]
    fn every_negative_vector_is_rejected_with_its_reason() {
        let v = read_vector("signed-v2-negative.json");
        let trusted: Vec<TrustedKey> = serde_json::from_value(v["trustedKeys"].clone()).unwrap();
        let expected = &v["expected"];
        let org = expected["orgId"].as_str().unwrap();
        let device = expected["deviceId"].as_str().unwrap();
        let version = expected["version"].as_u64().unwrap();
        let cases = v["cases"].as_array().unwrap();
        assert!(cases.len() >= 10);
        let mut seen = std::collections::BTreeSet::new();
        for case in cases {
            let env = envelope_of(&case["envelope"]);
            let head = HeadRef { version, key_id: &env.key_id };
            let error = verify_for_head(&env, &trusted, org, device, &head).unwrap_err();
            assert_eq!(error.reason(), case["reason"].as_str().unwrap(), "{}", case["name"]);
            assert_eq!(error.to_string(), error.reason());
            seen.insert(error.reason());
        }
        let reasons: std::collections::BTreeSet<&str> =
            v["reasons"].as_array().unwrap().iter().map(|r| r.as_str().unwrap()).collect();
        assert_eq!(seen, reasons);
    }

    #[test]
    fn flipped_payload_byte_fails() {
        let key = signing_key(TEST1_SEED);
        let mut env = signed(&key, "o", "d", 3);
        env.payload = env.payload.replacen("true", "fals", 1);
        assert_eq!(verify_envelope(&env, &[trusted_of(&key)], "o", "d"), Err(VerifyError::BadSignature));
    }

    #[test]
    fn flipped_signature_byte_fails() {
        let key = signing_key(TEST1_SEED);
        let mut env = signed(&key, "o", "d", 3);
        let mut bytes = STANDARD.decode(&env.signature).unwrap();
        bytes[5] ^= 0x01;
        env.signature = STANDARD.encode(bytes);
        assert_eq!(verify_envelope(&env, &[trusted_of(&key)], "o", "d"), Err(VerifyError::BadSignature));
        // Not base64 of 64 bytes: an encoding error, not a parse of anything.
        env.signature = "AAAA".into();
        assert_eq!(verify_envelope(&env, &[trusted_of(&key)], "o", "d"), Err(VerifyError::BadEncoding));
    }

    #[test]
    fn unknown_key_id() {
        let key = signing_key(TEST1_SEED);
        let other = signing_key(TEST2_SEED);
        let env = signed(&other, "o", "d", 3);
        assert_eq!(verify_envelope(&env, &[trusted_of(&key)], "o", "d"), Err(VerifyError::UnknownKey));
        assert_eq!(verify_envelope(&env, &[], "o", "d"), Err(VerifyError::UnknownKey));
    }

    #[test]
    fn key_id_mismatch_inside_payload() {
        let key = signing_key(TEST1_SEED);
        let trusted = trusted_of(&key);
        let payload = payload_text("0000000000000000", "o", "d", 3);
        let env = SignedEnvelope { version: 3, signature: sign(&key, &payload), payload, key_id: trusted.key_id.clone() };
        assert_eq!(verify_envelope(&env, &[trusted], "o", "d"), Err(VerifyError::KeyIdMismatch));
    }

    #[test]
    fn wrong_device() {
        let key = signing_key(TEST1_SEED);
        let env = signed(&key, "o", "other-device", 3);
        assert_eq!(verify_envelope(&env, &[trusted_of(&key)], "o", "d"), Err(VerifyError::WrongDevice));
    }

    #[test]
    fn wrong_org() {
        let key = signing_key(TEST1_SEED);
        let env = signed(&key, "other-org", "d", 3);
        assert_eq!(verify_envelope(&env, &[trusted_of(&key)], "o", "d"), Err(VerifyError::WrongOrg));
    }

    #[test]
    fn version_mismatch() {
        let key = signing_key(TEST1_SEED);
        let trusted = [trusted_of(&key)];
        let mut env = signed(&key, "o", "d", 3);
        env.version = 4;
        assert_eq!(verify_envelope(&env, &trusted, "o", "d"), Err(VerifyError::VersionMismatch));
        // A valid older document as the answer to a newer head.
        let env = signed(&key, "o", "d", 3);
        let head = HeadRef { version: 4, key_id: &env.key_id };
        assert_eq!(verify_for_head(&env, &trusted, "o", "d", &head), Err(VerifyError::VersionMismatch));
        // A head that named another key.
        let head = HeadRef { version: 3, key_id: "ffffffffffffffff" };
        assert_eq!(verify_for_head(&env, &trusted, "o", "d", &head), Err(VerifyError::HeadMismatch));
    }

    #[test]
    fn a_signed_payload_of_another_format_or_shape_is_bad_format() {
        let key = signing_key(TEST1_SEED);
        let trusted = [trusted_of(&key)];
        let key_id = trusted[0].key_id.clone();
        for payload in [
            "not json".to_string(),
            payload_text(&key_id, "o", "d", 3).replace(PAYLOAD_FORMAT, "rulebox.desired/1"),
            json!({ "format": PAYLOAD_FORMAT, "keyId": key_id, "orgId": "o", "deviceId": "d",
                    "version": 3, "issuedAtMs": 1, "doc": [] })
            .to_string(),
        ] {
            let env = SignedEnvelope { version: 3, signature: sign(&key, &payload), payload, key_id: key_id.clone() };
            assert_eq!(verify_envelope(&env, &trusted, "o", "d"), Err(VerifyError::BadFormat));
        }
    }

    #[test]
    fn weak_key_refused() {
        // The identity point (y = 1): small order, so it "verifies" forged signatures
        // under lax rules. It can never become a trusted key.
        let mut identity = [0u8; 32];
        identity[0] = 1;
        let b64 = STANDARD.encode(identity);
        assert_eq!(TrustedKey::from_public_key(&b64), Err(VerifyError::BadEncoding));
        // Even when it is in the list (a corrupted store), it verifies nothing.
        let trusted = [TrustedKey { key_id: key_id_of(&identity), public_key: b64 }];
        let payload = payload_text(&trusted[0].key_id, "o", "d", 1);
        let env = SignedEnvelope {
            version: 1,
            payload,
            signature: STANDARD.encode([0u8; 64]),
            key_id: trusted[0].key_id.clone(),
        };
        assert_eq!(verify_envelope(&env, &trusted, "o", "d"), Err(VerifyError::BadEncoding));
        // Not 32 bytes, not base64.
        assert_eq!(TrustedKey::from_public_key("AAAA"), Err(VerifyError::BadEncoding));
        assert_eq!(TrustedKey::from_public_key("%%%"), Err(VerifyError::BadEncoding));
        // A listed id that is not the id of the key.
        let real = trusted_of(&signing_key(TEST1_SEED));
        assert_eq!(TrustedKey::checked("0000000000000000", &real.public_key), Err(VerifyError::KeyIdMismatch));
    }

    #[test]
    fn endorsement_round_trip() {
        let active = signing_key(TEST1_SEED);
        let next = signing_key(TEST2_SEED);
        let trusted = [trusted_of(&active)];
        let next_trusted = trusted_of(&next);
        let message = endorsement_message("org-1", &next_trusted.key_id, &next_trusted.public_key);
        let published = PublishedKey {
            key_id: next_trusted.key_id.clone(),
            public_key: next_trusted.public_key.clone(),
            endorsement: Some(Endorsement { by_key_id: trusted[0].key_id.clone(), signature: sign(&active, &message) }),
        };
        assert_eq!(verify_endorsement(&published, &trusted, "org-1"), Ok(next_trusted.clone()));
        // Bound to the organization.
        assert_eq!(verify_endorsement(&published, &trusted, "org-2"), Err(VerifyError::BadSignature));
        // Only a trusted key can endorse.
        assert_eq!(
            verify_endorsement(&published, std::slice::from_ref(&next_trusted), "org-1"),
            Err(VerifyError::UnknownKey)
        );
        // Self-endorsed: not trusted.
        let selfish = PublishedKey {
            endorsement: Some(Endorsement { by_key_id: next_trusted.key_id.clone(), signature: sign(&next, &message) }),
            ..published.clone()
        };
        assert_eq!(verify_endorsement(&selfish, &trusted, "org-1"), Err(VerifyError::UnknownKey));
        // No endorsement.
        let bare = PublishedKey { endorsement: None, ..published.clone() };
        assert_eq!(verify_endorsement(&bare, &trusted, "org-1"), Err(VerifyError::UnknownKey));
        // A wrong id for the key.
        let relabelled = PublishedKey { key_id: "0000000000000000".into(), ..published };
        assert_eq!(verify_endorsement(&relabelled, &trusted, "org-1"), Err(VerifyError::KeyIdMismatch));
    }

    #[test]
    fn the_vector_endorsement_verifies() {
        let v = read_vector("signed-v2.json");
        let trusted = [TrustedKey::checked(v["keyId"].as_str().unwrap(), v["publicKey"].as_str().unwrap()).unwrap()];
        let e = &v["endorsement"];
        let org = v["orgId"].as_str().unwrap();
        assert_eq!(
            endorsement_message(org, e["keyId"].as_str().unwrap(), e["publicKey"].as_str().unwrap()),
            e["message"].as_str().unwrap()
        );
        let published = PublishedKey {
            key_id: e["keyId"].as_str().unwrap().into(),
            public_key: e["publicKey"].as_str().unwrap().into(),
            endorsement: Some(Endorsement {
                by_key_id: e["byKeyId"].as_str().unwrap().into(),
                signature: e["signature"].as_str().unwrap().into(),
            }),
        };
        let added = verify_endorsement(&published, &trusted, org).unwrap();
        assert_eq!(added.key_id, "39f713d0a644253f");
        assert_eq!(added, trusted_of(&signing_key(TEST2_SEED)));
    }

    #[test]
    fn debug_hides_doc() {
        let key = signing_key(TEST1_SEED);
        let env = signed(&key, "o", "d", 3);
        let text = format!("{env:?}");
        assert!(!text.contains("argon2") && !text.contains("pinHash"), "{text}");
        let payload = verify_envelope(&env, &[trusted_of(&key)], "o", "d").unwrap();
        let text = format!("{payload:?}");
        assert!(!text.contains("argon2") && !text.contains("pinHash") && text.contains("version: 3"), "{text}");
    }
}
