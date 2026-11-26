//! Phase 6 Step 4: the new policy fields (plan 4.2, 4.3, 4.4) through the public API
//! only. The Phase 4 catalogue vector and the Phase 5 agent keys must serialize
//! byte-for-byte as before; the Phase 6 fields are omitted when absent.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use rulebox_policy::catalog::{
    check_limits, ApplyWhen, BrowserKind, CatalogApp, CatalogError, FeedKind, InstallTech, UpdateMode,
};
use rulebox_policy::lockdown::LimitError;
use rulebox_policy::network::{DriverKind, DriverSource, DriverSpec};
use rulebox_policy::{AgentDoc, DisplayModeOverride, RuleboxRelease};
use serde_json::{json, Value};

const SHA_A: &str = "0000000000000000000000000000000000000000000000000000000000000001";
const SHA_B: &str = "0000000000000000000000000000000000000000000000000000000000000002";

fn vector() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/vectors/catalog-v2.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A desktop app of the Phase 4 shape, for the tests to add Phase 6 keys to.
fn desktop(extra_desktop: Value, extra_install: Value) -> Value {
    let mut install = json!({
        "kind": "exe", "url": "https://downloads.example.test/setup.exe", "sha256": SHA_A, "sizeBytes": 1000,
        "silentArgs": ["/S"], "productCode": null, "successExitCodes": [0], "removeWhenUnassigned": false
    });
    for (key, value) in extra_install.as_object().into_iter().flatten() {
        install[key] = value.clone();
    }
    let mut spec = json!({
        "exe": "{ProgramFiles}\\Vendor\\app.exe", "args": [], "fileArgTemplate": [],
        "install": install, "resetFolders": []
    });
    for (key, value) in extra_desktop.as_object().into_iter().flatten() {
        spec[key] = value.clone();
    }
    json!({
        "id": "app1", "name": "App", "description": null, "kind": "desktop", "builtin": null, "web": null,
        "desktop": spec, "pinnedTaskbar": false, "pinnedDesktop": false, "hue": null, "icon": null,
        "audience": "everyone", "employeeIds": [], "revision": 1
    })
}

fn web(id: &str, url: &str, domains: &[&str], browser: Value) -> CatalogApp {
    let mut value = json!({
        "id": id, "name": "Web", "description": null, "kind": "web", "builtin": null,
        "web": { "url": url, "allowedDomains": domains, "permissions": {
            "camera": false, "microphone": false, "screenShare": false, "clipboardRead": false,
            "notifications": true, "downloads": true, "printing": false, "geolocation": false } },
        "desktop": null, "pinnedTaskbar": false, "pinnedDesktop": false, "hue": null, "icon": null,
        "audience": "everyone", "employeeIds": [], "revision": 1
    });
    if !browser.is_null() {
        value["web"]["browser"] = browser;
    }
    serde_json::from_value(value).unwrap()
}

fn parse(value: &Value) -> CatalogApp {
    serde_json::from_value(value.clone()).unwrap()
}

#[test]
fn the_phase_4_catalogue_serializes_byte_for_byte_as_before() {
    let v = vector();
    let list: Vec<CatalogApp> = serde_json::from_value(v["doc"]["catalog"].clone()).unwrap();
    let text = serde_json::to_string(&list).unwrap();
    assert_eq!(text, v["catalogJson"].as_str().unwrap());
    // No Phase 6 key is written for an app that does not use it.
    for key in ["\"tech\"", "\"answerFile\"", "\"timeoutMin\"", "\"version\"", "\"update\"", "\"previous\"", "\"browser\"", "\"publisher\""] {
        assert!(!text.contains(key), "{key}");
    }
    for app in &list {
        assert_eq!(app.validate(), Ok(()), "{}", app.id);
        if let Some(desktop) = &app.desktop {
            assert_eq!(desktop.update_mode(), UpdateMode::Pinned);
        }
        if let Some(web) = &app.web {
            assert_eq!(web.browser_kind(), BrowserKind::Builtin);
        }
    }
    assert_eq!(check_limits(&list), Ok(()));
}

#[test]
fn the_phase_6_fields_round_trip_in_contract_order() {
    let text = concat!(
        r#"{"id":"app1","name":"App","description":null,"kind":"desktop","builtin":null,"web":null,"#,
        r#""desktop":{"exe":"{ProgramFiles}\\Vendor\\app.exe","args":[],"fileArgTemplate":[],"#,
        r#""install":{"kind":"exe","url":"https://downloads.example.test/setup.exe","sha256":""#, "0000000000000000000000000000000000000000000000000000000000000001", r#"","sizeBytes":1000,"#,
        r#""silentArgs":["/s","/f1{AnswerFile}"],"productCode":null,"successExitCodes":[0,3010],"removeWhenUnassigned":false,"#,
        r#""tech":"installshield_script","answerFile":{"url":"https://downloads.example.test/setup.iss","sha256":""#, "0000000000000000000000000000000000000000000000000000000000000002", r#"","sizeBytes":2048},"#,
        r#""timeoutMin":45,"publisher":"CN=Vendor Ltd"},"resetFolders":[],"#,
        r#""version":"2.4.1","update":{"mode":"managed","publisher":"CN=Vendor Ltd","publisherProduct":"Vendor App","minVersion":"2.0","applyWhen":"when_closed","rollbackOnFail":false},"#,
        r#""previous":{"version":"2.4.0","url":"https://downloads.example.test/setup-240.exe","sha256":""#, "0000000000000000000000000000000000000000000000000000000000000002", r#"","sizeBytes":999}},"#,
        r#""pinnedTaskbar":false,"pinnedDesktop":false,"hue":null,"icon":null,"audience":"everyone","employeeIds":[],"revision":3}"#
    );
    let app: CatalogApp = serde_json::from_str(text).unwrap();
    assert_eq!(serde_json::to_string(&app).unwrap(), text);
    assert_eq!(app.validate(), Ok(()));
    let desktop = app.desktop.as_ref().unwrap();
    let install = desktop.install.as_ref().unwrap();
    assert_eq!(install.tech, Some(InstallTech::InstallshieldScript));
    assert_eq!(install.timeout_min, Some(45));
    assert_eq!(install.answer_file.as_ref().unwrap().size_bytes, 2048);
    let update = desktop.update.as_ref().unwrap();
    assert_eq!((update.mode, update.apply_when(), update.rollback_on_fail()), (UpdateMode::Managed, ApplyWhen::WhenClosed, false));
    assert_eq!(desktop.update_mode(), UpdateMode::Managed);
    assert_eq!(desktop.previous.as_ref().unwrap().version, "2.4.0");

    let browser = r#"{"kind":"chrome","appId":"app_chrome"}"#;
    let app = web("w1", "https://orders.example.test/", &["orders.example.test"], serde_json::from_str(browser).unwrap());
    assert!(serde_json::to_string(&app).unwrap().contains(&format!(r#""browser":{browser}"#)));
    assert_eq!(app.web.as_ref().unwrap().browser_kind(), BrowserKind::Chrome);
    let edge = web("w2", "https://orders.example.test/", &[], json!({ "kind": "edge" }));
    assert!(serde_json::to_string(&edge).unwrap().ends_with(r#""browser":{"kind":"edge"}},"desktop":null,"pinnedTaskbar":false,"pinnedDesktop":false,"hue":null,"icon":null,"audience":"everyone","employeeIds":[],"revision":1}"#));
}

#[test]
fn defaults_of_absent_update_fields() {
    let app = parse(&desktop(json!({ "update": { "mode": "managed" }, "version": "1.0" }), json!({})));
    let update = app.desktop.as_ref().unwrap().update.as_ref().unwrap();
    assert_eq!(update.apply_when(), ApplyWhen::BootOrSignedOut);
    assert!(update.rollback_on_fail());
    // The defaults are not written back.
    assert!(serde_json::to_string(&app).unwrap().contains(r#""update":{"mode":"managed"}"#));
}

#[test]
fn unknown_values_behave_as_the_safe_value() {
    let app = parse(&desktop(
        json!({ "version": "1.0", "update": { "mode": "autopilot", "applyWhen": "midnight" } }),
        json!({ "tech": "squirrel" }),
    ));
    let desktop = app.desktop.as_ref().unwrap();
    assert_eq!(desktop.update.as_ref().unwrap().mode, UpdateMode::Unknown);
    assert_eq!(desktop.update_mode(), UpdateMode::Pinned);
    assert_eq!(desktop.update.as_ref().unwrap().apply_when(), ApplyWhen::BootOrSignedOut);
    let tech = desktop.install.as_ref().unwrap().tech.unwrap();
    assert_eq!((tech, tech.effective()), (InstallTech::Unknown, InstallTech::Exe));
    // An unknown mode needs nothing (it is Pinned), and the entry still validates.
    assert_eq!(app.validate(), Ok(()));

    let firefox = web("w", "https://x.example.test/", &[], json!({ "kind": "firefox" }));
    assert_eq!(firefox.web.as_ref().unwrap().browser.as_ref().unwrap().kind, BrowserKind::Unknown);
    assert_eq!(firefox.web.as_ref().unwrap().browser_kind(), BrowserKind::Builtin);
    // Chrome without the Chrome app's id cannot be launched: built-in.
    let no_id = web("w", "https://x.example.test/", &[], json!({ "kind": "chrome" }));
    assert_eq!(no_id.web.as_ref().unwrap().browser_kind(), BrowserKind::Builtin);
    let empty_id = web("w", "https://x.example.test/", &[], json!({ "kind": "chrome", "appId": "" }));
    assert_eq!(empty_id.web.as_ref().unwrap().browser_kind(), BrowserKind::Builtin);

    assert_eq!(serde_json::from_value::<FeedKind>(json!("rss")).unwrap(), FeedKind::Unknown);
    assert_eq!(serde_json::from_value::<FeedKind>(json!("tauri")).unwrap(), FeedKind::Tauri);
    assert_eq!(serde_json::from_value::<DisplayModeOverride>(json!("dim")).unwrap().effective(), DisplayModeOverride::Auto);
    assert_eq!(serde_json::from_value::<DisplayModeOverride>(json!("lite")).unwrap().effective(), DisplayModeOverride::Lite);
    let source: Option<DriverSource> = serde_json::from_value(json!("magic_zip")).unwrap();
    assert_eq!(source, Some(DriverSource::Unknown));
    // Every new enum string round-trips.
    for text in ["pinned", "vendor", "managed"] {
        assert_eq!(serde_json::to_value(serde_json::from_value::<UpdateMode>(json!(text)).unwrap()).unwrap(), json!(text));
    }
    for text in ["boot_or_signed_out", "when_closed"] {
        assert_eq!(serde_json::to_value(serde_json::from_value::<ApplyWhen>(json!(text)).unwrap()).unwrap(), json!(text));
    }
    for text in ["msi", "nsis", "inno", "burn", "installshield_msi", "installshield_script", "advanced_installer", "exe"] {
        assert_eq!(serde_json::to_value(serde_json::from_value::<InstallTech>(json!(text)).unwrap()).unwrap(), json!(text));
    }
    for text in ["builtin", "edge", "chrome"] {
        assert_eq!(serde_json::to_value(serde_json::from_value::<BrowserKind>(json!(text)).unwrap()).unwrap(), json!(text));
    }
    for text in ["inf_zip", "vendor_exe", "vendor_exe_extract"] {
        assert_eq!(serde_json::to_value(serde_json::from_value::<DriverSource>(json!(text)).unwrap()).unwrap(), json!(text));
    }
}

/// Plan 4.3: the feed URL and the public key never reach a device.
#[test]
fn the_feed_url_and_key_never_reach_the_device() {
    let secret_url = "https://vendor.example.test/updates/latest.json";
    let secret_key = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    let value = desktop(
        json!({
            "version": "1.0",
            "update": {
                "mode": "managed",
                "feed": { "kind": "tauri", "url": secret_url, "pubkey": secret_key, "target": "windows-x86_64" },
                "autoPublish": true
            }
        }),
        json!({}),
    );
    let app = parse(&value);
    assert_eq!(app.validate(), Ok(()));
    let text = serde_json::to_string(&app).unwrap();
    for leaked in [secret_url, secret_key, "feed", "pubkey", "autoPublish", "target"] {
        assert!(!text.contains(leaked), "{leaked}");
    }
    // The agent-only document has no feed either.
    let agent = AgentDoc::from_doc(&json!({ "feed": { "url": secret_url }, "displayMode": "lite" })).unwrap();
    assert!(!serde_json::to_string(&agent).unwrap().contains(secret_url));
}

fn expect(value: Value, error: CatalogError) {
    assert_eq!(parse(&value).validate(), Err(error), "{value}");
}

#[test]
fn validation_of_the_phase_6_fields() {
    // Versions: at most 40 characters of [0-9A-Za-z.+-].
    let ok = |version: &str| parse(&desktop(json!({ "version": version }), json!({}))).validate();
    assert_eq!(ok("1.2.3"), Ok(()));
    assert_eq!(ok("2024.1+build-5"), Ok(()));
    assert_eq!(ok(&"1".repeat(40)), Ok(()));
    for bad in ["", "1_2", "v 1", "1.2\u{e9}", &"1".repeat(41)] {
        assert_eq!(ok(bad), Err(CatalogError::BadText("desktop.version")), "{bad:?}");
    }
    // Pinned: free text is fine.
    assert_eq!(parse(&desktop(json!({ "version": "build 7", "update": { "mode": "pinned" } }), json!({}))).validate(), Err(CatalogError::BadText("desktop.version")));
    assert_eq!(parse(&desktop(json!({ "version": "2024+x", "update": { "mode": "pinned" } }), json!({}))).validate(), Ok(()));

    // Managed needs an ordered version.
    for version in [json!(null), json!("2024+x"), json!("v1.2")] {
        let mut extra = json!({ "update": { "mode": "managed" } });
        if !version.is_null() {
            extra["version"] = version;
        }
        expect(desktop(extra, json!({})), CatalogError::VersionNotOrdered("desktop.version"));
    }
    // Vendor needs a publisher; minVersion needs an order, and so does the version.
    let vendor = |update: Value, version: Value| {
        let mut extra = json!({ "update": update });
        if !version.is_null() {
            extra["version"] = version;
        }
        desktop(extra, json!({}))
    };
    expect(vendor(json!({ "mode": "vendor" }), json!(null)), CatalogError::VendorNeedsPublisher);
    expect(vendor(json!({ "mode": "vendor", "publisher": "  " }), json!(null)), CatalogError::VendorNeedsPublisher);
    assert_eq!(parse(&vendor(json!({ "mode": "vendor", "publisher": "CN=V" }), json!(null))).validate(), Ok(()));
    expect(
        vendor(json!({ "mode": "vendor", "publisher": "CN=V", "minVersion": "x" }), json!("1.0")),
        CatalogError::VersionNotOrdered("update.minVersion"),
    );
}

#[test]
fn vendor_min_version_rules() {
    let update = |min: &str| json!({ "mode": "vendor", "publisher": "CN=V", "minVersion": min });
    let with = |min: &str, version: Option<&str>| {
        let mut extra = json!({ "update": update(min) });
        if let Some(version) = version {
            extra["version"] = json!(version);
        }
        parse(&desktop(extra, json!({}))).validate()
    };
    assert_eq!(with("1.0", Some("2.0")), Ok(()));
    assert_eq!(with("1.0+a", Some("2.0")), Err(CatalogError::VersionNotOrdered("update.minVersion")));
    assert_eq!(with("1.0", None), Err(CatalogError::VersionNotOrdered("desktop.version")));
    assert_eq!(with("1.0", Some("2024+x")), Err(CatalogError::VersionNotOrdered("desktop.version")));
    assert_eq!(with("1.0 x", Some("2.0")), Err(CatalogError::BadText("update.minVersion")));
}

#[test]
fn install_fields_are_checked() {
    let install = |extra: Value| parse(&desktop(json!({}), extra)).validate();
    assert_eq!(install(json!({ "timeoutMin": 5 })), Ok(()));
    assert_eq!(install(json!({ "timeoutMin": 120 })), Ok(()));
    for minutes in [0, 4, 121, 100_000] {
        assert_eq!(install(json!({ "timeoutMin": minutes })), Err(CatalogError::BadTimeout), "{minutes}");
    }
    let answer = |url: &str, sha: &str, size: u64| install(json!({ "answerFile": { "url": url, "sha256": sha, "sizeBytes": size } }));
    assert_eq!(answer("https://x.example.test/a.iss", SHA_B, 262_144), Ok(()));
    assert_eq!(answer("https://x.example.test/a.iss", SHA_B, 262_145), Err(CatalogError::AnswerFileTooLarge));
    assert_eq!(answer("http://x.example.test/a.iss", SHA_B, 10), Err(CatalogError::NotHttps("install.answerFile.url")));
    assert_eq!(answer("https://x.example.test/a.iss", "ABC", 10), Err(CatalogError::BadSha256("install.answerFile.sha256")));
    assert_eq!(install(json!({ "publisher": "x".repeat(201) })), Err(CatalogError::BadText("install.publisher")));
    assert_eq!(install(json!({ "publisher": "x".repeat(200) })), Ok(()));
    // Previous version: https, hash, version text.
    let previous = |url: &str, sha: &str, version: &str| {
        parse(&desktop(json!({ "previous": { "version": version, "url": url, "sha256": sha, "sizeBytes": 0 } }), json!({}))).validate()
    };
    assert_eq!(previous("https://x.example.test/p.exe", SHA_B, "1.0"), Ok(()));
    assert_eq!(previous("http://x.example.test/p.exe", SHA_B, "1.0"), Err(CatalogError::NotHttps("desktop.previous.url")));
    assert_eq!(previous("https://x.example.test/p.exe", "z", "1.0"), Err(CatalogError::BadSha256("desktop.previous.sha256")));
    assert_eq!(previous("https://x.example.test/p.exe", SHA_B, "1 0"), Err(CatalogError::BadText("desktop.previous.version")));
}

#[test]
fn browser_limits_are_per_device() {
    // 60 browser web apps are fine, 61 are not; built-in apps never count.
    let chrome = |i: usize| web(&format!("w{i}"), "https://a.example.test/", &[], json!({ "kind": "edge" }));
    let mut apps: Vec<CatalogApp> = (0..60).map(chrome).collect();
    for i in 0..200 {
        apps.push(web(&format!("b{i}"), "https://a.example.test/", &[], Value::Null));
    }
    assert_eq!(check_limits(&apps), Ok(()));
    apps.push(chrome(60));
    assert_eq!(check_limits(&apps), Err(LimitError::TooManyBrowserApps));

    // Patterns: distinct allowed domains and start hosts, any case; 800 fit, 801 do not.
    let many = |count: usize| {
        let domains: Vec<String> = (0..count).map(|i| format!("d{i}.example.test")).collect();
        let refs: Vec<&str> = domains.iter().map(String::as_str).collect();
        vec![web("w", "https://start.example.test/x?y=1", &refs, json!({ "kind": "edge" }))]
    };
    assert_eq!(check_limits(&many(799)), Ok(())); // + the start host = 800
    assert_eq!(check_limits(&many(800)), Err(LimitError::TooManyBrowserPatterns));
    // The start host counts once, whatever its case; repeated patterns count once.
    let twice = vec![
        web("a", "https://START.example.test/", &["start.example.test", "START.example.test"], json!({ "kind": "edge" })),
        web("b", "https://start.example.test:8443/p", &["start.example.test"], json!({ "kind": "chrome", "appId": "c" })),
    ];
    assert_eq!(check_limits(&twice), Ok(()));
    // A chrome choice without an app id is a built-in window: not counted.
    let unusable: Vec<CatalogApp> =
        (0..100).map(|i| web(&format!("w{i}"), "https://a.example.test/", &[], json!({ "kind": "chrome" }))).collect();
    assert_eq!(check_limits(&unusable), Ok(()));
}

/// (Phase 6 Step 17, plan 4.9.7) `browserSites` of a Chrome or Edge program: omitted when absent (the
/// vectors keep their bytes), serialized after `update`, validated like the server's `domainProblem`,
/// at most 200, and counted in the 800 patterns of a device.
#[test]
fn the_browser_sites_of_a_browser_program_round_trip_validate_and_count() {
    let plain = parse(&desktop(json!({}), json!({})));
    assert!(plain.desktop.as_ref().unwrap().browser_sites.is_none());
    assert!(!serde_json::to_string(&plain).unwrap().contains("browserSites"));

    let sites = json!(["example.com", "*.orders.example.com"]);
    let app = parse(&desktop(json!({ "browserSites": sites }), json!({})));
    let spec = app.desktop.as_ref().unwrap();
    assert_eq!(spec.browser_sites(), ["example.com", "*.orders.example.com"]);
    assert_eq!(app.validate(), Ok(()));
    let text = serde_json::to_string(&app).unwrap();
    assert!(text.contains(r#""resetFolders":[],"browserSites":["example.com","*.orders.example.com"]}"#), "{text}");
    assert_eq!(parse(&serde_json::from_str::<Value>(&text).unwrap()), app);

    for bad in ["Example.com", "https://example.com", "example", "example.com/path", "-a.example.com", "a..com", "*.*.example.com", "exa mple.com"] {
        let broken = parse(&desktop(json!({ "browserSites": [bad] }), json!({})));
        assert_eq!(broken.validate(), Err(CatalogError::BadText("desktop.browserSites")), "{bad}");
    }
    let many: Vec<String> = (0..201).map(|i| format!("d{i}.example.test")).collect();
    assert_eq!(parse(&desktop(json!({ "browserSites": many }), json!({}))).validate(), Err(CatalogError::BadText("desktop.browserSites")));
    let exact: Vec<String> = (0..200).map(|i| format!("d{i}.example.test")).collect();
    assert_eq!(parse(&desktop(json!({ "browserSites": exact }), json!({}))).validate(), Ok(()));

    // The sites share the 800 patterns of the device with the web apps' domains.
    let sites_app = |count: usize| {
        let list: Vec<String> = (0..count).map(|i| format!("s{i}.example.test")).collect();
        parse(&desktop(json!({ "browserSites": list }), json!({})))
    };
    let mut apps = vec![sites_app(200)];
    let domains: Vec<String> = (0..599).map(|i| format!("d{i}.example.test")).collect();
    let refs: Vec<&str> = domains.iter().map(String::as_str).collect();
    apps.push(web("w", "https://start.example.test/", &refs, json!({ "kind": "edge" })));
    assert_eq!(check_limits(&apps), Ok(())); // 200 + 599 + start host = 800
    apps.push({
        let mut extra = sites_app(1);
        extra.id = "app2".into();
        extra.desktop.as_mut().unwrap().browser_sites = Some(vec!["one-more.example.test".into()]);
        extra
    });
    assert_eq!(check_limits(&apps), Err(LimitError::TooManyBrowserPatterns));
}

#[test]
fn an_installers_silent_args_follow_the_token_rule_in_the_limits() {
    // (Phase 6 Step 14) `check_silent_args` on every install: the two tokens pass, nothing else in braces does.
    let with_args = |args: Value| {
        let mut app = desktop(json!({}), json!({}));
        app["desktop"]["install"]["silentArgs"] = args;
        vec![parse(&app)]
    };
    assert_eq!(check_limits(&with_args(json!(["/s", "/f1{AnswerFile}", "/f2{LogFile}"]))), Ok(()));
    assert_eq!(check_limits(&with_args(json!(["/S", "/VERYSILENT", "/NORESTART"]))), Ok(()));
    assert_eq!(check_limits(&with_args(json!([]))), Ok(()));
    for bad in [json!(["/DIR={app}"]), json!(["{answerfile}"]), json!(["{"]), json!(["a\nb"]), json!(vec!["/a"; 17])] {
        assert_eq!(check_limits(&with_args(bad.clone())), Err(LimitError::BadSilentArgs), "{bad}");
    }
    // An app without an install, and a web app, are not looked at.
    let mut plain = desktop(json!({}), json!({}));
    plain["desktop"]["install"] = Value::Null;
    assert_eq!(check_limits(&[parse(&plain), web("w", "https://a.example.test/", &[], Value::Null)]), Ok(()));
}

#[test]
fn driver_source_is_omitted_when_absent() {
    let spec = |source: Option<DriverSource>| DriverSpec {
        id: "d".into(),
        name: "n".into(),
        kind: DriverKind::Inf,
        url: "https://x.example.test/d.zip".into(),
        sha256: SHA_A.into(),
        size_bytes: 1,
        inf: Some("a.inf".into()),
        silent_args: Vec::new(),
        success_exit_codes: Vec::new(),
        revision: 1,
        source,
        signer_thumbprint: None,
    };
    assert!(!serde_json::to_string(&spec(None)).unwrap().contains("source"));
    let text = serde_json::to_string(&spec(Some(DriverSource::InfZip))).unwrap();
    assert!(text.ends_with(r#""revision":1,"source":"inf_zip"}"#), "{text}");
    assert_eq!(serde_json::from_str::<DriverSpec>(&text).unwrap(), spec(Some(DriverSource::InfZip)));
}

#[test]
fn agent_only_keys_of_phase_6() {
    // Absent keys: the Phase 5 default, and nothing is written back (byte-for-byte).
    let plain = AgentDoc::from_doc(&json!({})).unwrap();
    assert_eq!(plain, AgentDoc::default());
    let text = serde_json::to_string(&plain).unwrap();
    for key in ["displayMode", "webWindowCap", "webIdleCloseMin", "browserUploads", "ruleboxRelease"] {
        assert!(!text.contains(key), "{key}");
    }

    let doc = json!({
        "displayMode": "lite", "webWindowCap": 3, "webIdleCloseMin": 30, "browserUploads": true,
        "ruleboxRelease": { "version": "0.7.0", "url": "https://dl.example.test/rulebox.msi", "sha256": SHA_A, "sizeBytes": 9_000_000 }
    });
    let agent = AgentDoc::from_doc(&doc).unwrap();
    assert_eq!(agent.display_mode, Some(DisplayModeOverride::Lite));
    assert_eq!((agent.web_window_cap, agent.web_idle_close_min, agent.browser_uploads), (Some(3), Some(30), true));
    assert_eq!(agent.check_limits(0), Ok(()));
    assert_eq!(serde_json::to_value(&agent).unwrap()["ruleboxRelease"], doc["ruleboxRelease"]);
    assert_eq!(AgentDoc::from_doc(&serde_json::to_value(&agent).unwrap()).unwrap(), agent);

    // Limits.
    let limit = |key: &str, value: Value| AgentDoc::from_doc(&json!({ key: value })).unwrap().check_limits(0);
    for cap in [1, 12] {
        assert_eq!(limit("webWindowCap", json!(cap)), Ok(()));
    }
    for cap in [0, 13, 200] {
        assert_eq!(limit("webWindowCap", json!(cap)), Err(LimitError::BadWindowCap), "{cap}");
    }
    for minutes in [0, 5, 240] {
        assert_eq!(limit("webIdleCloseMin", json!(minutes)), Ok(()));
    }
    for minutes in [1, 4, 241, 1000] {
        assert_eq!(limit("webIdleCloseMin", json!(minutes)), Err(LimitError::BadIdleClose), "{minutes}");
    }
    let release = |version: &str, url: &str, sha: &str| {
        limit("ruleboxRelease", json!({ "version": version, "url": url, "sha256": sha, "sizeBytes": 1 }))
    };
    assert_eq!(release("0.7.0", "https://dl.example.test/r.msi", SHA_A), Ok(()));
    assert_eq!(release("seven", "https://dl.example.test/r.msi", SHA_A), Err(LimitError::BadRelease));
    assert_eq!(release("0.7.0", "http://dl.example.test/r.msi", SHA_A), Err(LimitError::BadRelease));
    assert_eq!(release("0.7.0", "https://dl.example.test/r.msi", "abc"), Err(LimitError::BadRelease));
    let _: RuleboxRelease = serde_json::from_value(doc["ruleboxRelease"].clone()).unwrap();
}
