//! Tests of the Wi-Fi layer (Phase 5 Step 13): the profile XML (escaping, every security),
//! the apply through the journal (idempotence, revisions, removal, foreign profiles, drift,
//! crash points, restore), the managed-networks permit list, and the rule that a passphrase
//! is never logged, stored or printed. All against `SimPlatform`; nothing touches the machine.

use std::path::Path;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use chacha20poly1305::aead::Aead;
use chacha20poly1305::{KeyInit, XChaCha20Poly1305};
use hkdf::Hkdf;
use rulebox_policy::envelope::key_id_of;
use rulebox_policy::network::{WifiProfile, WifiSecurity};
use rulebox_policy::seal::{open_sealed, SealedBox};
use rulebox_policy::AgentDoc;
use serde_json::Value;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

use super::*;
use crate::journal::{CrashPoint, EntryPhase, JournalCtx, JournalTarget, OriginalValue};
use crate::lockdown::apply::{apply as apply_all, ApplyRefusal};
use crate::lockdown::invariants::Facts;
use crate::platform::sim::{SimOp, SimPlatform};
use crate::platform::Platform;
use crate::state::{AgentState, Enrollment, SharedState, StateStore};
use crate::testutil::{capture_logs, TempDir};

const VECTORS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/rulebox-policy/tests/vectors/seal.json");
const ORG: &str = "org_test_vector_1";
const DEVICE: &str = "dev_test_vector_1";

fn vectors() -> Value {
    serde_json::from_str(&std::fs::read_to_string(VECTORS).unwrap()).unwrap()
}

fn vector_box(name: &str) -> (SealedBox, String, String) {
    let v = vectors();
    let case = v["cases"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap().clone();
    (
        serde_json::from_value(case["box"].clone()).unwrap(),
        case["profileId"].as_str().unwrap().to_string(),
        case["plaintext"].as_str().unwrap().to_string(),
    )
}

/// The server's sealing, written independently of `rulebox_policy::seal` (whose sealer is
/// test-only inside that crate): HKDF-SHA256 over the X25519 secret, XChaCha20-Poly1305.
fn seal_for(plaintext: &str, device_public: &[u8; 32], org: &str, device: &str, profile: &str) -> SealedBox {
    let mut ephemeral = [0u8; 32];
    getrandom::fill(&mut ephemeral).unwrap();
    let mut nonce = [0u8; 24];
    getrandom::fill(&mut nonce).unwrap();
    let secret = StaticSecret::from(ephemeral);
    let epk = PublicKey::from(&secret);
    let shared = secret.diffie_hellman(&PublicKey::from(*device_public));
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(epk.as_bytes());
    salt[32..].copy_from_slice(device_public);
    let info = format!("rulebox.seal/1|{org}|{device}|wifi|{profile}");
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), shared.as_bytes()).expand(info.as_bytes(), &mut key).unwrap();
    let cipher = XChaCha20Poly1305::new_from_slice(&key).unwrap();
    let ct = cipher.encrypt((&nonce).into(), plaintext.as_bytes()).unwrap();
    SealedBox {
        v: 1,
        key_id: key_id_of(device_public),
        epk: STANDARD.encode(epk.as_bytes()),
        nonce: STANDARD.encode(nonce),
        ct: STANDARD.encode(ct),
    }
}

fn device_secret() -> [u8; 32] {
    let v = vectors();
    STANDARD.decode(v["deviceSecret"].as_str().unwrap()).unwrap().try_into().unwrap()
}

fn device_public() -> [u8; 32] {
    *PublicKey::from(&StaticSecret::from(device_secret())).as_bytes()
}

fn profile(id: &str, ssid: &str, security: WifiSecurity, revision: u64, sealed: Option<SealedBox>) -> WifiProfile {
    WifiProfile { id: id.into(), ssid: ssid.into(), hidden: false, security, auto_connect: true, revision, sealed }
}

struct Rig {
    dir: TempDir,
    platform: Arc<SimPlatform>,
    shared: Arc<SharedState>,
    /// How many platform calls the set-up made (saving the sealing key is one).
    base: usize,
}

impl Rig {
    /// An enrolled device (the organization and device ids of the committed seal vectors)
    /// that has its sealing key.
    fn new() -> Self {
        let mut rig = Self::without_key();
        let encoded = STANDARD.encode(device_secret());
        rig.shared.update_secrets(|s| s.seal_secret = Some(encoded)).unwrap();
        rig.base = rig.platform.calls().len();
        rig
    }

    fn without_key() -> Self {
        let dir = TempDir::new();
        let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        let dyn_platform: Arc<dyn Platform> = platform.clone();
        let state = AgentState {
            enrollment: Some(Enrollment {
                convex_url: "https://example.convex.cloud".into(),
                device_id: DEVICE.into(),
                org_id: ORG.into(),
                device_name: "pc".into(),
                enrolled_at_ms: 0,
                revoked: false,
                allow_joined: false,
            }),
            ..AgentState::default()
        };
        let shared = SharedState::new(StateStore::open(&dir.path().join("state")).unwrap(), state, dyn_platform);
        Self { dir, platform, shared, base: 0 }
    }

    fn ctx(&self) -> ApplyCtx<'_> {
        self.ctx_with(Facts::default())
    }

    fn ctx_with(&self, facts: Facts) -> ApplyCtx<'_> {
        ApplyCtx { journal: JournalCtx { platform: self.platform.as_ref(), shared: self.shared.as_ref() }, facts, now_ms: 1_000, version: 7 }
    }

    fn apply(&self, wifi: Vec<WifiProfile>, managed_only: bool) -> WifiOutcome {
        super::apply(&self.ctx(), &doc(wifi, managed_only))
    }

    fn mutating(&self) -> usize {
        self.platform.calls()[self.base..].iter().filter(|op| op.is_mutating()).count()
    }

    fn profiles(&self) -> Vec<String> {
        self.platform.with_world(|w| w.wlan_profiles.keys().cloned().collect())
    }

    fn xml_of(&self, name: &str) -> String {
        self.platform.with_world(|w| w.wlan_profiles.get(name).cloned().unwrap())
    }

    fn allowed(&self) -> Vec<String> {
        self.platform.with_world(|w| w.wlan_allowed.clone())
    }

    fn entry_ids(&self) -> Vec<String> {
        self.shared.read(|s| s.journal.iter().map(|e| e.id.clone()).collect())
    }
}

fn doc(wifi: Vec<WifiProfile>, managed_only: bool) -> AgentDoc {
    AgentDoc { wifi, wifi_managed_only: managed_only, ..AgentDoc::default() }
}

fn states(outcome: &WifiOutcome) -> Vec<(&str, &str, Option<&str>)> {
    outcome.items.iter().map(|i| (i.profile_id.as_str(), i.state.as_str(), i.detail.as_deref())).collect()
}

// -- the XML --------------------------------------------------------------------------------

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// The text of the `n`-th (0-based) `<tag>` element, unescaped; a raw `<` inside would end
/// the text early and fail the comparisons below.
fn tag_text(xml: &str, tag: &str, n: usize) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.match_indices(&open).nth(n).unwrap().0 + open.len();
    let end = start + xml[start..].find(&close).unwrap();
    unescape(&xml[start..end])
}

#[test]
fn escaping_round_trips_ssids_and_passphrases_and_the_name_comes_first() {
    for ssid in ["Cafe & <Bar> \"x\" 'y'", "Café 日本語", "plain", "</name><evil/>"] {
        let p = profile("k9abc", ssid, WifiSecurity::Wpa2Personal, 3, None);
        let key = "pa&ss<w>\"o'rd12";
        let xml = profile_xml(&p, Some(key)).unwrap();
        let xml = xml.expose();
        assert_eq!(rulebox_win32::wlan::check_profile_xml(xml).unwrap(), "Rulebox-k9abc");
        assert_eq!(tag_text(xml, "name", 0), "Rulebox-k9abc");
        assert_eq!(tag_text(xml, "name", 1), ssid, "{xml}");
        let hex: String = ssid.bytes().map(|b| format!("{b:02X}")).collect();
        assert_eq!(tag_text(xml, "hex", 0), hex);
        assert_eq!(tag_text(xml, "keyMaterial", 0), key);
        assert!(!xml.contains("<evil/>"));
    }
}

#[test]
fn every_security_has_its_authentication_and_the_transition_mode() {
    let xml = |security| profile_xml(&profile("a1", "S", security, 1, None), Some("password123")).unwrap().expose().to_string();
    let open = xml(WifiSecurity::Open);
    assert!(open.contains("<authentication>open</authentication><encryption>none</encryption>"));
    assert!(!open.contains("sharedKey") && !open.contains("password123"), "an open network has no key: {open}");
    let wpa2 = xml(WifiSecurity::Wpa2Personal);
    assert!(wpa2.contains("<authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX>"));
    assert!(wpa2.contains("<keyType>passPhrase</keyType><protected>false</protected>") && !wpa2.contains("transitionMode"));
    let wpa3 = xml(WifiSecurity::Wpa3Personal);
    assert!(wpa3.contains("<authentication>WPA3SAE</authentication>") && !wpa3.contains("transitionMode"));
    let both = xml(WifiSecurity::Wpa2Wpa3Personal);
    assert!(both.contains("<authentication>WPA3SAE</authentication>"));
    assert!(both.contains("<transitionMode xmlns=\"http://www.microsoft.com/networking/WLAN/profile/v4\">true</transitionMode>"));
    for x in [&open, &wpa2, &wpa3, &both] {
        assert!(x.contains("<WLANProfile xmlns=\"http://www.microsoft.com/networking/WLAN/profile/v1\">"));
        assert!(x.contains("<connectionType>ESS</connectionType>"));
    }
    assert_eq!(
        profile_xml(&profile("a1", "S", WifiSecurity::Unknown, 1, None), None).unwrap_err(),
        "section_unknown_value"
    );
}

#[test]
fn hidden_and_auto_connect_show_in_the_xml() {
    let mut p = profile("a1", "S", WifiSecurity::Open, 1, None);
    let plain = profile_xml(&p, None).unwrap().expose().to_string();
    assert!(!plain.contains("nonBroadcast") && plain.contains("<connectionMode>auto</connectionMode>"));
    p.hidden = true;
    p.auto_connect = false;
    let hidden = profile_xml(&p, None).unwrap().expose().to_string();
    assert!(hidden.contains("<nonBroadcast>true</nonBroadcast>") && hidden.contains("<connectionMode>manual</connectionMode>"));
}

#[test]
fn bad_ids_ssids_and_passphrases_are_refused_with_fixed_codes() {
    let wpa2 = |ssid: &str| profile("a1", ssid, WifiSecurity::Wpa2Personal, 1, None);
    assert_eq!(profile_xml(&wpa2("bad\u{1}ssid"), Some("password123")).unwrap_err(), "ssid_unsupported");
    assert_eq!(profile_xml(&wpa2("tab\tssid"), Some("password123")).unwrap_err(), "ssid_unsupported");
    assert_eq!(profile_xml(&profile("a b", "S", WifiSecurity::Open, 1, None), None).unwrap_err(), "bad_profile_id");
    assert_eq!(profile_xml(&profile("", "S", WifiSecurity::Open, 1, None), None).unwrap_err(), "bad_profile_id");
    assert_eq!(profile_xml(&profile(&"a".repeat(65), "S", WifiSecurity::Open, 1, None), None).unwrap_err(), "bad_profile_id");
    for bad in ["short", &"x".repeat(64), "pässwörd123", "tab\tpassword", &"y".repeat(65), "line\nbreak123"] {
        assert_eq!(profile_xml(&wpa2("S"), Some(bad)).unwrap_err(), "passphrase_invalid", "{bad:?}");
    }
    // 8, 63 printable characters and 64 hex digits are fine (the hex one only for WPA2).
    assert!(profile_xml(&wpa2("S"), Some("12345678")).is_ok());
    assert!(profile_xml(&wpa2("S"), Some(&"z".repeat(63))).is_ok());
    let hex = "ab".repeat(32);
    let xml = profile_xml(&wpa2("S"), Some(&hex)).unwrap();
    assert!(xml.expose().contains("<keyType>networkKey</keyType>"));
    let wpa3 = profile("a1", "S", WifiSecurity::Wpa3Personal, 1, None);
    assert_eq!(profile_xml(&wpa3, Some(&hex)).unwrap_err(), "passphrase_invalid");
}

#[test]
fn the_mark_follows_the_revision_and_never_the_passphrase() {
    let p = profile("a1", "S", WifiSecurity::Wpa2Personal, 4, None);
    let mark = mark_of(&p).unwrap();
    assert!(mark.starts_with("rev4:") && mark.len() == 5 + 64);
    // The XML with a key has another hash: the mark is not it.
    let with_key = profile_xml(&p, Some("password123")).unwrap();
    assert!(!mark.contains(&journal::policy_hash(with_key.expose().as_bytes())));
    assert_ne!(mark, mark_of(&WifiProfile { revision: 5, ..p.clone() }).unwrap());
    assert_ne!(mark, mark_of(&WifiProfile { ssid: "T".into(), ..p.clone() }).unwrap());
    assert_eq!(mark, mark_of(&p).unwrap());
}

// -- the apply ------------------------------------------------------------------------------

#[test]
fn a_box_made_by_the_typescript_side_opens_and_the_profile_is_written() {
    let rig = Rig::new();
    let (sealed, id, plaintext) = vector_box("ascii");
    let (max_box, max_id, max_plain) = vector_box("max-length");
    let wifi = vec![
        profile(&id, "Acme", WifiSecurity::Wpa2Personal, 1, Some(sealed)),
        profile(&max_id, "Acme-2", WifiSecurity::Wpa3Personal, 2, Some(max_box)),
    ];
    let outcome = rig.apply(wifi, false);
    assert_eq!(states(&outcome), [(id.as_str(), "applied", None), (max_id.as_str(), "applied", None)]);
    let xml = rig.xml_of(&format!("Rulebox-{id}"));
    assert_eq!(tag_text(&xml, "keyMaterial", 0), plaintext);
    assert_eq!(tag_text(&rig.xml_of(&format!("Rulebox-{max_id}")), "keyMaterial", 0), max_plain);
    // The unicode vector opens at the seal layer too (its content is not a valid Wi-Fi key).
    let v = vectors();
    let uni = v["cases"].as_array().unwrap().iter().find(|c| c["name"] == "unicode").unwrap();
    let sealed: SealedBox = serde_json::from_value(uni["box"].clone()).unwrap();
    let opened = open_sealed(&sealed, &device_secret(), "org_test_vector_1", "dev_test_vector_2", "wifi_test_vector_1").unwrap();
    assert_eq!(std::str::from_utf8(&opened).unwrap(), "pässwörd ✓ 日本語");
}

#[test]
fn a_secured_profile_without_a_box_or_without_a_device_key_waits_and_writes_nothing() {
    let rig = Rig::new();
    let outcome = rig.apply(vec![profile("a1", "Acme", WifiSecurity::Wpa2Personal, 1, None)], false);
    assert_eq!(states(&outcome), [("a1", "waiting_for_key", None)]);
    assert!(rig.profiles().is_empty() && rig.entry_ids().is_empty());
    assert_eq!(rig.mutating(), 0);

    // A device that has no sealing key yet cannot open any box.
    let rig = Rig::without_key();
    let sealed = seal_for("password123", &device_public(), ORG, DEVICE, "a1");
    let outcome = rig.apply(vec![profile("a1", "Acme", WifiSecurity::Wpa2Personal, 1, Some(sealed))], false);
    assert_eq!(states(&outcome), [("a1", "waiting_for_key", None)]);
    assert!(rig.profiles().is_empty());
    assert_eq!(rig.mutating(), 0);
}

#[test]
fn a_profile_waiting_for_a_new_box_keeps_the_one_it_has() {
    let rig = Rig::new();
    let sealed = seal_for("first-pass-1", &device_public(), ORG, DEVICE, "a1");
    rig.apply(vec![profile("a1", "Acme", WifiSecurity::Wpa2Personal, 1, Some(sealed))], false);
    let before = rig.xml_of("Rulebox-a1");
    // Revision 2 arrived without its box (the server has not sealed it yet).
    let outcome = rig.apply(vec![profile("a1", "Acme", WifiSecurity::Wpa2Personal, 2, None)], false);
    assert_eq!(states(&outcome), [("a1", "waiting_for_key", None)]);
    assert_eq!(rig.xml_of("Rulebox-a1"), before);
    assert_eq!(rig.entry_ids(), ["wlan:Rulebox-a1"]);
}

#[test]
fn a_new_revision_replaces_the_profile_and_keeps_the_original() {
    let rig = Rig::new();
    let first = seal_for("first-pass-1", &device_public(), ORG, DEVICE, "a1");
    rig.apply(vec![profile("a1", "Acme", WifiSecurity::Wpa2Personal, 1, Some(first))], false);
    assert_eq!(rig.shared.read(|s| s.wlan_marks.get("Rulebox-a1").cloned()).unwrap().get(..5), Some("rev1:"));
    let second = seal_for("second-pass-2", &device_public(), ORG, DEVICE, "a1");
    let outcome = rig.apply(vec![profile("a1", "Acme", WifiSecurity::Wpa2Personal, 2, Some(second))], false);
    assert_eq!(states(&outcome), [("a1", "applied", None)]);
    assert_eq!(tag_text(&rig.xml_of("Rulebox-a1"), "keyMaterial", 0), "second-pass-2");
    assert_eq!(rig.shared.read(|s| s.wlan_marks.get("Rulebox-a1").cloned()).unwrap().get(..5), Some("rev2:"));
    let entries = rig.shared.read(|s| s.journal.clone());
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].original, OriginalValue::NotPresent);
    assert_eq!(entries[0].owner, JournalOwner::Wifi);
    assert_eq!(entries[0].phase, EntryPhase::Applied);
    assert_eq!(entries[0].target, JournalTarget::WlanProfile { name: "Rulebox-a1".into() });
}

#[test]
fn a_profile_removed_from_the_document_is_deleted_and_forgotten() {
    let rig = Rig::new();
    let sealed = seal_for("password123", &device_public(), ORG, DEVICE, "a1");
    rig.apply(
        vec![
            profile("a1", "Acme", WifiSecurity::Wpa2Personal, 1, Some(sealed)),
            profile("b2", "Open", WifiSecurity::Open, 1, None),
        ],
        false,
    );
    assert_eq!(rig.profiles(), ["Rulebox-a1", "Rulebox-b2"]);
    let outcome = rig.apply(vec![profile("b2", "Open", WifiSecurity::Open, 1, None)], false);
    assert_eq!(states(&outcome), [("b2", "applied", None)]);
    assert_eq!(rig.profiles(), ["Rulebox-b2"]);
    assert_eq!(rig.entry_ids(), ["wlan:Rulebox-b2"]);
    assert!(rig.shared.read(|s| !s.wlan_marks.contains_key("Rulebox-a1") && s.wlan_marks.contains_key("Rulebox-b2")));
    rig.apply(Vec::new(), false);
    assert!(rig.profiles().is_empty() && rig.entry_ids().is_empty());
    assert!(rig.shared.read(|s| s.wlan_marks.is_empty()));
}

#[test]
fn the_same_document_twice_writes_nothing_the_second_time() {
    let rig = Rig::new();
    let sealed = seal_for("password123", &device_public(), ORG, DEVICE, "a1");
    let wifi = vec![
        profile("a1", "Acme", WifiSecurity::Wpa3Personal, 1, Some(sealed)),
        profile("b2", "Guest", WifiSecurity::Open, 1, None),
    ];
    rig.apply(wifi.clone(), true);
    assert!(rig.mutating() > 0);
    let before = rig.platform.calls().len();
    let outcome = rig.apply(wifi, true);
    assert_eq!(outcome.items.iter().map(|i| i.state.as_str()).collect::<Vec<_>>(), ["applied", "applied"]);
    assert_eq!(rig.platform.calls()[before..].iter().filter(|op| op.is_mutating()).count(), 0);
}

#[test]
fn a_pc_without_a_wireless_adapter_says_unsupported_and_gets_nothing() {
    let rig = Rig::new();
    rig.platform.with_world(|w| w.wlan_interfaces = 0);
    let sealed = seal_for("password123", &device_public(), ORG, DEVICE, "a1");
    let wifi = vec![
        profile("a1", "Acme", WifiSecurity::Wpa2Personal, 1, Some(sealed)),
        profile("b2", "Guest", WifiSecurity::Open, 1, None),
    ];
    let outcome = rig.apply(wifi, true);
    assert_eq!(states(&outcome), [("a1", "unsupported", None), ("b2", "unsupported", None)]);
    assert_eq!(rig.mutating(), 0);
    assert!(rig.entry_ids().is_empty() && rig.allowed().is_empty());
}

#[test]
fn an_unreadable_wlan_state_fails_every_item_and_touches_nothing() {
    let rig = Rig::new();
    rig.platform.fail_next(SimOp::WlanList, PlatformError::Other("boom".into()));
    let outcome = rig.apply(vec![profile("b2", "Guest", WifiSecurity::Open, 1, None)], false);
    assert_eq!(states(&outcome), [("b2", "failed", Some("wlan_unreadable"))]);
    assert_eq!(rig.mutating(), 0);
}

#[test]
fn foreign_profiles_are_never_touched_and_unowned_rulebox_ones_stay() {
    let rig = Rig::new();
    rig.platform.with_world(|w| {
        w.wlan_profiles.insert("HomeWifi".into(), "<home/>".into());
        // A Rulebox-named profile the journal knows nothing about (another install, a leftover).
        w.wlan_profiles.insert("Rulebox-orphan".into(), "<orphan/>".into());
    });
    // Same SSID as the foreign profile: Rulebox still writes only its own name.
    rig.apply(vec![profile("b2", "HomeWifi", WifiSecurity::Open, 1, None)], false);
    assert_eq!(rig.profiles(), ["HomeWifi", "Rulebox-b2", "Rulebox-orphan"]);
    assert_eq!(rig.xml_of("HomeWifi"), "<home/>");
    // Removing the profile from the document deletes ours only.
    rig.apply(Vec::new(), false);
    assert_eq!(rig.profiles(), ["HomeWifi", "Rulebox-orphan"]);
    assert_eq!(rig.xml_of("Rulebox-orphan"), "<orphan/>");
}

#[test]
fn a_box_that_does_not_open_fails_without_writing() {
    let rig = Rig::new();
    // Sealed for another device id: the binding makes it useless here.
    let other = seal_for("password123", &device_public(), ORG, "dev_other", "a1");
    // Sealed to another key.
    let other_key = seal_for("password123", &[9u8; 32], ORG, DEVICE, "b2");
    let outcome = rig.apply(
        vec![
            profile("a1", "A", WifiSecurity::Wpa2Personal, 1, Some(other)),
            profile("b2", "B", WifiSecurity::Wpa2Personal, 1, Some(other_key)),
        ],
        false,
    );
    assert_eq!(states(&outcome), [("a1", "failed", Some("seal_unopenable")), ("b2", "failed", Some("seal_unopenable"))]);
    assert!(rig.profiles().is_empty() && rig.entry_ids().is_empty());
}

#[test]
fn a_bad_id_an_unknown_security_and_a_bad_passphrase_fail_with_codes() {
    let rig = Rig::new();
    let bad_key = seal_for("short", &device_public(), ORG, DEVICE, "c3");
    let unknown: WifiProfile = serde_json::from_value(serde_json::json!({
        "id": "u4", "ssid": "U", "hidden": false, "security": "wpa9", "autoConnect": true, "revision": 1
    }))
    .unwrap();
    let outcome = rig.apply(
        vec![
            profile("a b", "A", WifiSecurity::Open, 1, None),
            unknown.clone(),
            profile("c3", "C", WifiSecurity::Wpa2Personal, 1, Some(bad_key)),
        ],
        false,
    );
    assert_eq!(
        states(&outcome),
        [("a b", "failed", Some("bad_profile_id")), ("u4", "failed", Some("section_unknown_value")), ("c3", "failed", Some("passphrase_invalid"))]
    );
    assert!(rig.profiles().is_empty());

    // An unknown security keeps what is there: write the profile with a known one first.
    let sealed = seal_for("password123", &device_public(), ORG, DEVICE, "u4");
    rig.apply(vec![profile("u4", "U", WifiSecurity::Wpa2Personal, 1, Some(sealed))], false);
    let outcome = rig.apply(vec![unknown], false);
    assert_eq!(states(&outcome), [("u4", "failed", Some("section_unknown_value"))]);
    assert_eq!(rig.profiles(), ["Rulebox-u4"], "kept");
}

#[test]
fn a_driver_that_refuses_wpa3_is_reported_as_security_unsupported() {
    let rig = Rig::new();
    let sealed = seal_for("password123", &device_public(), ORG, DEVICE, "a1");
    rig.platform.fail_next(SimOp::WlanSetProfile, PlatformError::Win32 { api: "WlanSetProfile", code: 1206 });
    let outcome = rig.apply(vec![profile("a1", "A", WifiSecurity::Wpa3Personal, 1, Some(sealed.clone()))], false);
    assert_eq!(states(&outcome), [("a1", "failed", Some("security_unsupported"))]);
    // The same refusal of a WPA2 profile is a plain rejection.
    rig.platform.fail_next(SimOp::WlanSetProfile, PlatformError::Win32 { api: "WlanSetProfile", code: 1206 });
    let outcome = rig.apply(vec![profile("a1", "A", WifiSecurity::Wpa2Personal, 1, Some(sealed.clone()))], false);
    assert_eq!(states(&outcome), [("a1", "failed", Some("profile_rejected"))]);
    // And the next apply simply works.
    let outcome = rig.apply(vec![profile("a1", "A", WifiSecurity::Wpa2Personal, 1, Some(sealed))], false);
    assert_eq!(states(&outcome), [("a1", "applied", None)]);
}

#[test]
fn a_profile_removed_behind_our_back_is_written_again_and_counted() {
    let rig = Rig::new();
    let wifi = vec![profile("b2", "Guest", WifiSecurity::Open, 1, None)];
    rig.apply(wifi.clone(), false);
    assert!(rig.shared.take_rewrites().is_empty());
    rig.platform.with_world(|w| w.wlan_profiles.clear());
    let outcome = rig.apply(wifi, false);
    assert_eq!(states(&outcome), [("b2", "applied", None)]);
    assert_eq!(rig.profiles(), ["Rulebox-b2"]);
    let rewrites = rig.shared.take_rewrites();
    assert_eq!(rewrites.len(), 1);
    assert_eq!(rewrites[0].id, "wlan:Rulebox-b2");
    assert_eq!(rewrites[0].owner, JournalOwner::Wifi);
    assert_eq!(rig.entry_ids(), ["wlan:Rulebox-b2"], "still one entry with its first original");
}

#[test]
fn managed_only_sets_the_permit_list_once_and_disable_puts_it_back() {
    let rig = Rig::new();
    rig.platform.with_world(|w| w.wlan_allowed = vec!["OldAllowed".into()]);
    let wifi = vec![profile("b2", "Zed", WifiSecurity::Open, 1, None), profile("a1", "Alpha", WifiSecurity::Open, 1, None)];
    rig.apply(wifi.clone(), true);
    assert_eq!(rig.allowed(), ["Alpha", "Zed"]);
    let entry = rig.shared.read(|s| s.journal.iter().find(|e| e.id == WLAN_FILTERS_ID).cloned()).unwrap();
    assert_eq!(entry.original, OriginalValue::MultiString(vec!["OldAllowed".into()]));
    let before = rig.platform.calls().len();
    rig.apply(wifi.clone(), true);
    assert_eq!(rig.platform.calls()[before..].iter().filter(|op| op.is_mutating()).count(), 0);
    // The list follows the document.
    rig.apply(vec![wifi[0].clone()], true);
    assert_eq!(rig.allowed(), ["Zed"]);
    // Managed-only off: the original list is back and the entry is gone.
    rig.apply(vec![wifi[0].clone()], false);
    assert_eq!(rig.allowed(), ["OldAllowed"]);
    assert!(!rig.entry_ids().contains(&WLAN_FILTERS_ID.to_string()));
}

#[test]
fn a_permit_list_that_was_empty_goes_back_to_empty() {
    let rig = Rig::new();
    rig.apply(vec![profile("b2", "Zed", WifiSecurity::Open, 1, None)], true);
    assert_eq!(rig.allowed(), ["Zed"]);
    let entry = rig.shared.read(|s| s.journal.iter().find(|e| e.id == WLAN_FILTERS_ID).cloned()).unwrap();
    assert_eq!(entry.original, OriginalValue::NotPresent);
    let report = journal::restore_all(&rig.ctx().journal);
    assert!(report.is_complete(), "{:?}", report.failed_ids());
    assert!(rig.allowed().is_empty() && rig.profiles().is_empty() && rig.entry_ids().is_empty());
    assert!(rig.shared.read(|s| s.wlan_marks.is_empty()));
}

#[test]
fn managed_only_with_an_empty_list_is_refused_and_nothing_is_written() {
    let rig = Rig::new();
    let refusal = apply_all(&rig.ctx(), &doc(Vec::new(), true)).unwrap_err();
    assert_eq!(refusal, ApplyRefusal::Refused("managed_networks_empty"));
    assert_eq!(rig.mutating(), 0);
    assert!(rig.entry_ids().is_empty() && rig.allowed().is_empty());

    // The link in use is not in the list: refused as well (plan 4.6, I5).
    let facts = Facts { current_ssid: Some("Elsewhere".into()), ..Facts::default() };
    let refusal = apply_all(&rig.ctx_with(facts), &doc(vec![profile("b2", "Zed", WifiSecurity::Open, 1, None)], true)).unwrap_err();
    assert_eq!(refusal, ApplyRefusal::Refused("would_disconnect"));
    assert_eq!(rig.mutating(), 0);
}

#[test]
fn managed_only_is_not_applied_without_an_adapter() {
    let rig = Rig::new();
    rig.platform.with_world(|w| w.wlan_interfaces = 0);
    rig.apply(vec![profile("b2", "Zed", WifiSecurity::Open, 1, None)], true);
    assert!(rig.allowed().is_empty() && rig.entry_ids().is_empty());
}

#[test]
fn the_apply_report_carries_the_wifi_states() {
    let rig = Rig::new();
    let outcome = apply_all(&rig.ctx(), &doc(vec![profile("b2", "Zed", WifiSecurity::Open, 1, None)], false)).unwrap();
    assert_eq!(outcome.wifi.len(), 1);
    let report = outcome.report(7, None, crate::lockdown::apply::ReportExtras::default());
    assert_eq!(report.wifi, outcome.wifi);
    // The caller's own items win when it has some.
    let own = vec![crate::backend::reports::WifiItemState { profile_id: "x".into(), revision: 9, state: "failed".into(), detail: None }];
    let report = outcome.report(7, None, crate::lockdown::apply::ReportExtras { wifi: own.clone(), ..Default::default() });
    assert_eq!(report.wifi, own);
}

// -- crash points ---------------------------------------------------------------------------

fn crashed_apply(rig: &Rig, point: CrashPoint) {
    journal::set_crash_point(Some(point));
    let outcome = rig.apply(vec![profile("b2", "Zed", WifiSecurity::Open, 1, None)], false);
    journal::set_crash_point(None);
    assert_eq!(states(&outcome), [("b2", "failed", Some("crashed"))]);
}

#[test]
fn a_crash_before_the_write_drops_the_entry_at_the_next_start() {
    let rig = Rig::new();
    crashed_apply(&rig, CrashPoint::AfterPending);
    assert!(rig.profiles().is_empty());
    assert_eq!(rig.shared.read(|s| s.journal[0].phase), EntryPhase::Pending);
    let report = journal::startup_recover(&rig.ctx().journal);
    assert_eq!(report.dropped, ["wlan:Rulebox-b2"]);
    assert!(rig.entry_ids().is_empty());
}

#[test]
fn a_crash_after_the_write_keeps_the_entry_and_a_restore_deletes_the_profile() {
    let rig = Rig::new();
    crashed_apply(&rig, CrashPoint::AfterWrite);
    assert_eq!(rig.profiles(), ["Rulebox-b2"]);
    let report = journal::startup_recover(&rig.ctx().journal);
    assert_eq!(report.kept, ["wlan:Rulebox-b2"]);
    assert_eq!(rig.shared.read(|s| s.journal[0].phase), EntryPhase::Applied);
    assert!(journal::restore_all(&rig.ctx().journal).is_complete());
    assert!(rig.profiles().is_empty() && rig.entry_ids().is_empty());
}

#[test]
fn a_restore_that_fails_stays_restoring_and_is_retried() {
    let rig = Rig::new();
    rig.apply(vec![profile("b2", "Zed", WifiSecurity::Open, 1, None)], false);
    rig.platform.fail_next(SimOp::WlanDeleteProfile, PlatformError::Other("busy".into()));
    let report = journal::restore_all(&rig.ctx().journal);
    assert_eq!(report.failed_ids(), ["wlan:Rulebox-b2"]);
    assert_eq!(rig.shared.read(|s| s.journal[0].phase), EntryPhase::Restoring);
    assert_eq!(rig.profiles(), ["Rulebox-b2"]);
    let again = journal::startup_recover(&rig.ctx().journal);
    assert!(again.restore.is_complete());
    assert!(rig.profiles().is_empty() && rig.entry_ids().is_empty());
}

// -- the passphrase never leaves ------------------------------------------------------------

fn files_containing(dir: &Path, needles: &[&str]) -> Vec<String> {
    let mut hits = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(path) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&path) else { continue };
        for entry in read.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(bytes) = std::fs::read(&p) {
                let text = String::from_utf8_lossy(&bytes);
                if needles.iter().any(|n| text.contains(n)) {
                    hits.push(p.display().to_string());
                }
            }
        }
    }
    hits
}

#[test]
fn a_full_apply_never_logs_stores_or_prints_the_passphrase() {
    // Unique to this test: the log capture is global to the test process.
    const PASSPHRASE: &str = "Zq9-LogScan-unique-passphrase-7731";
    let logs = capture_logs();
    let rig = Rig::new();
    let sealed = seal_for(PASSPHRASE, &device_public(), ORG, DEVICE, "a1");
    let wifi = vec![profile("a1", "Acme", WifiSecurity::Wpa2Personal, 1, Some(sealed))];
    let document = doc(wifi, true);
    // A failure path that logs too (the permit list cannot be set), then the working one.
    rig.platform.fail_next(SimOp::WlanSetFilters, PlatformError::Other("nope".into()));
    let outcome = apply_all(&rig.ctx(), &document).unwrap();
    assert_eq!(outcome.wifi[0].state, "applied");
    assert_eq!(outcome.wifi_filters_error, Some("platform_error"));
    apply_all(&rig.ctx(), &document).unwrap();
    // And a removal and a restore, which also log.
    apply_all(&rig.ctx(), &doc(Vec::new(), false)).unwrap();
    apply_all(&rig.ctx(), &document).unwrap();

    // (b) the profile was written with the key in it: the apply really used the passphrase.
    assert!(rig.xml_of("Rulebox-a1").contains(PASSPHRASE));

    // (a) nothing was logged that holds it, in clear or as base64.
    let b64 = STANDARD.encode(PASSPHRASE);
    let text = logs.text();
    assert!(!text.contains(PASSPHRASE) && !text.contains(&b64), "the passphrase reached the log");

    // (c) no debug text of the journal, the state, a change or an outcome holds it.
    let mark = mark_of(&document.wifi[0]).unwrap();
    let xml = profile_xml(&document.wifi[0], Some(PASSPHRASE)).unwrap();
    let change = Change::wlan_profile("Rulebox-a1", xml, &mark);
    let dumps = [
        format!("{:?}", rig.shared.get()),
        format!("{:#?}", rig.shared.get().journal),
        format!("{change:?}"),
        format!("{outcome:?}"),
        format!("{:?}", change.desired),
    ];
    for dump in &dumps {
        assert!(!dump.contains(PASSPHRASE) && !dump.contains(&b64), "{dump}");
    }
    assert!(dumps[2].contains("<redacted>"));

    // (d) no file the agent wrote (state, secrets) holds it.
    assert!(files_containing(rig.dir.path(), &[PASSPHRASE, &b64]).is_empty());
}
