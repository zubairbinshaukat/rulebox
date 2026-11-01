//! The demo world of `run --console --simulate --sim-demo` and of fixture mode
//! (plan Section 6.11, "Simulated agent"): employees, the app catalogue, the
//! snapshot overlay. The names match Phase 3's `DemoAgent`.
//!
//! Nothing here runs on a real agent unless `agent-config.json` asks for it **and**
//! the test-machine marker is present (`directory::choose`).

use rulebox_ipc::hotkey::DEFAULT_ADMIN_EXIT_HOTKEY;
use rulebox_ipc::requests::{
    AppEntry, AppKind, BuiltinApp, DesktopApp, Employee, WebApp, WebPermissions,
};
use rulebox_ipc::types::{AgentSnapshot, ConnectionStatus, DeviceInfo, EnrollmentStatus, KioskPhase, KioskStatus};
use rulebox_policy::{DesiredState, EXAMPLE_DESIRED_STATE_JSON};

use crate::kdf;

/// Every demo employee's password.
pub const DEMO_PASSWORD: &str = "demo";
/// The demo exit PIN. [`demo_document`] hashes it with `kdf::hash_secret`.
pub const DEMO_EXIT_PIN: &str = "2468";
const GIB: u64 = 1024 * 1024 * 1024;

pub struct DemoEmployee {
    /// Already normalized.
    pub username: &'static str,
    pub employee: Employee,
    pub offline_days: u32,
    /// The directory answers `disabled` whatever the password.
    pub disabled: bool,
}

fn employee(id: &str, username: &str, name: &str, role: Option<&str>) -> Employee {
    Employee {
        id: id.to_string(),
        username: username.to_string(),
        name: name.to_string(),
        role: role.map(str::to_string),
        quota_bytes: 10 * GIB,
    }
}

/// `maya` (7 days offline), `sam` (0 days: always `offlineExpired` offline) and
/// `alex` (disabled).
pub fn employees() -> Vec<DemoEmployee> {
    vec![
        DemoEmployee {
            username: "maya",
            employee: employee("emp_maya", "maya", "Maya Chen", Some("Cashier")),
            offline_days: 7,
            disabled: false,
        },
        DemoEmployee {
            username: "sam",
            employee: employee("emp_sam", "sam", "Sam Ortiz", Some("Manager")),
            offline_days: 0,
            disabled: false,
        },
        DemoEmployee {
            username: "alex",
            employee: employee("emp_alex", "alex", "Alex Rivera", None),
            offline_days: 7,
            disabled: true,
        },
    ]
}

/// Icons of the demo web apps, embedded (offline-first: nothing is fetched at run time).
mod icons {
    /// zubyr.dev's own `apple-touch-icon` (`/apple-icon.png`, 180 x 180, 3.8 KB), downloaded
    /// once at dev time on 2026-10-31 and kept byte for byte. The site has no web manifest,
    /// so this is the icon an installed PWA would show. example.com publishes no icon.
    pub const ZUBYR_PNG: &[u8] = include_bytes!("../assets/icons/zubyr.png");
    /// batwa.zubyr.dev's `apple-touch-icon` (`/icons/apple-touch-icon-180-v2.png`, 180 x 180,
    /// 21,159 bytes, opaque), downloaded once at dev time on 2026-10-31 and kept byte for
    /// byte. Its manifest also lists a 192 x 192 "any" icon, but that one is 35 KB (over
    /// the 30 KB budget of these fixtures); the apple-touch icon is the same artwork.
    pub const BATWA_PNG: &[u8] = include_bytes!("../assets/icons/batwa.png");
    /// zahras-pos.vercel.app's manifest icon (`/icon-192x192.png`, purpose "any", 192 x 192,
    /// 20,477 bytes), downloaded once at dev time on 2026-10-31 and kept byte for byte. It is
    /// a TRANSPARENT PNG (a lavender "Z" with a peach spark, no background); the site's
    /// maskable icons and `apple-touch-icon.png` (the same bytes as this one) were not used.
    pub const ZAHRAS_POS_PNG: &[u8] = include_bytes!("../assets/icons/zahras-pos.png");
}

/// A PNG as the catalogue carries it: base64, no `data:` prefix.
fn icon_base64(png: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(png)
}

fn web_app(id: &str, name: &str, url: &str, domain: &str, pinned_taskbar: bool, hue: u16) -> AppEntry {
    AppEntry {
        id: id.to_string(),
        name: name.to_string(),
        description: None,
        kind: AppKind::Web,
        builtin: None,
        web: Some(WebApp {
            url: url.to_string(),
            allowed_domains: vec![domain.to_string()],
            permissions: WebPermissions::default(),
        }),
        desktop: None,
        pinned_taskbar,
        pinned_desktop: true,
        icon_png_base64: None,
        hue: Some(hue),
    }
}

/// The catalogue every demo employee gets.
pub fn catalogue() -> Vec<AppEntry> {
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    let notepad = format!(r"{}\System32\notepad.exe", system_root.trim_end_matches('\\'));
    let msconfig = format!(r"{}\System32\msconfig.exe", system_root.trim_end_matches('\\'));
    vec![
        AppEntry {
            id: "files".into(),
            name: "My files".into(),
            description: None,
            kind: AppKind::Builtin,
            builtin: Some(BuiltinApp { tool: "files".into() }),
            web: None,
            desktop: None,
            pinned_taskbar: true,
            pinned_desktop: false,
            icon_png_base64: None,
            hue: None,
        },
        // Real sites, so the VM can load them. Subdomains of an allowed domain are
        // allowed too (`www.zubyr.dev` needs no entry). Links from one site to the
        // other (or anywhere else) show the blocked page.
        {
            // The site's own icon, like an installed PWA; Example has none (hue art).
            let mut zubyr = web_app("zubyr-web", "Zubyr", "https://zubyr.dev", "zubyr.dev", true, 175);
            zubyr.icon_png_base64 = Some(icon_base64(icons::ZUBYR_PNG));
            zubyr
        },
        {
            // A PWA of its own (manifest name "Batwa", theme #4F33E8) on a subdomain of
            // Zubyr's domain, so it is a second web login on the same site family: the
            // allow-list matches subdomains only downwards, so Zubyr's window may show
            // Batwa but Batwa's window may not show zubyr.dev (its author link is blocked).
            // The camera is on because Batwa really uses it (scanning a shared-space QR
            // code with getUserMedia); it makes no use of the microphone, location or
            // clipboard reads, so those keep their defaults. Downloads (its JSON backup
            // export) and notifications are on by default.
            let mut batwa = web_app("batwa-web", "Batwa", "https://batwa.zubyr.dev", "batwa.zubyr.dev", true, 285);
            batwa.icon_png_base64 = Some(icon_base64(icons::BATWA_PNG));
            if let Some(web) = batwa.web.as_mut() {
                web.permissions.camera = true;
            }
            batwa
        },
        {
            // A PWA (manifest name "Zahras POS", theme #863bff, hue 293 in oklch) on its own
            // vercel.app host. Default permissions. Its page loads its fonts from Google
            // Fonts, which is a sub-resource and not a navigation, so the allow-list of
            // one domain is enough.
            let mut zahra = web_app("zahras-pos-web", "Zahras POS", "https://zahras-pos.vercel.app", "zahras-pos.vercel.app", true, 293);
            zahra.icon_png_base64 = Some(icon_base64(icons::ZAHRAS_POS_PNG));
            zahra
        },
        {
            // Camera rule on, like Batwa; Zubyr keeps the default (denied).
            let mut example = web_app("example-web", "Example", "https://example.com", "example.com", false, 250);
            if let Some(web) = example.web.as_mut() {
                web.permissions.camera = true;
            }
            example
        },
        AppEntry {
            id: "notepad".into(),
            name: "Notepad".into(),
            description: None,
            kind: AppKind::Desktop,
            builtin: None,
            web: None,
            desktop: Some(DesktopApp {
                exe: notepad,
                args: Vec::new(),
                file_arg_template: vec!["{file}".into()],
            }),
            pinned_taskbar: false,
            pinned_desktop: true,
            icon_png_base64: None,
            hue: Some(30),
        },
        // `msconfig.exe` has `requestedExecutionLevel="requireAdministrator"` in its
        // manifest, so CreateProcessW answers error 740 for every non-elevated token
        // (regedit.exe is `highestAvailable`: it would just start for a standard
        // user). The Staff App must show the "needs admin" notice and no UAC prompt.
        AppEntry {
            id: "needs-admin".into(),
            name: "System Configuration".into(),
            description: Some("Needs administrator rights: the notice must appear, with no UAC prompt.".into()),
            kind: AppKind::Desktop,
            builtin: None,
            web: None,
            desktop: Some(DesktopApp {
                exe: msconfig,
                args: Vec::new(),
                file_arg_template: Vec::new(),
            }),
            pinned_taskbar: false,
            pinned_desktop: true,
            icon_png_base64: None,
            hue: Some(340),
        },
    ]
}

/// Sample files (plan 12.2, "Each viewer opens its sample"), embedded in the agent
/// (about 110 KB, no network). Generated once by a throwaway script; real files, not
/// stubs: a PNG, a one-page PDF, a DOCX, an XLSX, a 4 s H.264 + AAC MP4 (faststart,
/// so seeking works) and a 4 s MP3.
///
/// (Phase 4 Step 13) Only the Phase 3 test-machine fixture mode exported them; that
/// mode is gone (Phase 3 is done), so they are compiled for the tests only.
#[cfg(test)]
mod samples {
    pub const PHOTO_PNG: &[u8] = include_bytes!("../assets/fixture-samples/Photo.png");
    pub const REPORT_PDF: &[u8] = include_bytes!("../assets/fixture-samples/Report.pdf");
    pub const LETTER_DOCX: &[u8] = include_bytes!("../assets/fixture-samples/Letter.docx");
    pub const BUDGET_XLSX: &[u8] = include_bytes!("../assets/fixture-samples/Budget.xlsx");
    pub const CLIP_MP4: &[u8] = include_bytes!("../assets/fixture-samples/Clip.mp4");
    pub const SONG_MP3: &[u8] = include_bytes!("../assets/fixture-samples/Song.mp3");
}

/// Everything exported for the employee's folder: (relative path, bytes).
#[cfg(test)]
fn sample_files() -> Vec<(&'static str, &'static [u8])> {
    vec![
        ("Shopping list.txt", b"Milk\nEggs\nBread\nCoffee\n"),
        ("Notes.txt", "Remember to call the supplier.\nTotal: 4\u{20ac}\n".as_bytes()),
        ("Sales.csv", b"Day,Items,Total\nMon,12,48.50\nTue,9,36.00\nWed,15,61.25\n"),
        ("Photo.png", samples::PHOTO_PNG),
        ("Report.pdf", samples::REPORT_PDF),
        ("Letter.docx", samples::LETTER_DOCX),
        ("Budget.xlsx", samples::BUDGET_XLSX),
        ("Clip.mp4", samples::CLIP_MP4),
        ("Song.mp3", samples::SONG_MP3),
        // Not a picture: the first bytes of a Windows program. The viewer must refuse it.
        ("Renamed program.png", b"MZ This is not an image; the viewer must refuse it.\n"),
        ("Documents/Contract.txt", b"Draft contract.\n"),
        ("Documents/Invoice.csv", b"No,Amount\n1,100\n"),
        ("Pictures/Logo.png", samples::PHOTO_PNG),
    ]
}

/// Writes the sample files into `folder` (the agent's own `fixture-samples` folder),
/// skipping files that already exist. Errors are logged, never fatal.
///
/// The agent must **not** write into the employee's files folder (plan 2, Section
/// 5.9: SYSTEM writing into a Staff-writable path invites junction tricks, and the
/// Staff App creates that folder as Staff). So an administrator copies these in:
/// `robocopy "%ProgramData%\Rulebox\fixture-samples" "<Staff profile>\RuleboxFiles\emp_maya" /E`.
#[cfg(test)]
pub fn export_sample_files(folder: &std::path::Path) {
    for (relative, bytes) in sample_files() {
        let path = folder.join(relative);
        if path.exists() {
            continue;
        }
        let written = path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::write(&path, bytes));
        if let Err(error) = written {
            tracing::warn!("cannot write the sample file {}: {error}", path.display());
        }
    }
}

/// The demo desired-state document: the example state plus the three agent-only
/// keys of Section 5.10 (`adminExit` with the hash of [`DEMO_EXIT_PIN`], `power`,
/// `orgName`). `AgentPolicy::from_doc` reads the keys; the snapshot's
/// `desiredState` is parsed from the same text by [`apply_demo_snapshot`]. Hashing
/// takes a few tens of milliseconds, so call it once per start.
pub fn demo_document() -> serde_json::Value {
    let mut doc = serde_json::from_str::<serde_json::Value>(EXAMPLE_DESIRED_STATE_JSON)
        .unwrap_or_else(|_| serde_json::json!({}));
    let mut admin_exit = serde_json::json!({ "enabled": true, "hotkey": DEFAULT_ADMIN_EXIT_HOTKEY });
    match kdf::hash_secret(DEMO_EXIT_PIN) {
        Ok(hash) => admin_exit["pinHash"] = serde_json::Value::String(hash),
        // Without a hash the demo exit is simply off; `status` says why.
        Err(error) => tracing::error!("cannot hash the demo exit PIN: {error}"),
    }
    if let Some(object) = doc.as_object_mut() {
        object.insert("adminExit".into(), admin_exit);
        object.insert(
            "power".into(),
            serde_json::json!({ "sleep": true, "restart": true, "shutDown": true }),
        );
        object.insert("orgName".into(), serde_json::json!("Demo Company"));
    }
    doc
}

/// The demo snapshot of Section 6.11: enrolled, kiosk applied, the example desired
/// state. `offline` is `--sim-offline`. The 1.1 fields `adminExit`, `power` and
/// `orgName` come from [`demo_document`] through `AgentPolicy`, not from here.
pub fn apply_demo_snapshot(snapshot: &mut AgentSnapshot, offline: bool) {
    snapshot.enrollment = EnrollmentStatus::Enrolled;
    snapshot.device = Some(DeviceInfo { id: "sim-device".into(), name: "Simulated PC".into() });
    snapshot.connection = if offline { ConnectionStatus::Offline } else { ConnectionStatus::Online };
    snapshot.kiosk = KioskStatus { enabled: true, phase: KioskPhase::Applied, error_code: None };
    snapshot.desired_state = serde_json::from_str::<DesiredState>(EXAMPLE_DESIRED_STATE_JSON).ok();
    if snapshot.desired_state.is_some() {
        snapshot.desired_state_version = snapshot.desired_state_version.max(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::test_snapshot;

    #[test]
    fn the_demo_world_matches_the_plan() {
        let all = employees();
        let names: Vec<_> = all.iter().map(|e| (e.username, e.employee.id.as_str(), e.offline_days, e.disabled)).collect();
        assert_eq!(
            names,
            [("maya", "emp_maya", 7, false), ("sam", "emp_sam", 0, false), ("alex", "emp_alex", 7, true)]
        );
        assert_eq!(all[0].employee.quota_bytes, 10 * GIB);

        let apps = catalogue();
        let ids: Vec<_> = apps.iter().map(|a| (a.id.as_str(), a.kind)).collect();
        assert_eq!(
            ids,
            [
                ("files", AppKind::Builtin),
                ("zubyr-web", AppKind::Web),
                ("batwa-web", AppKind::Web),
                ("zahras-pos-web", AppKind::Web),
                ("example-web", AppKind::Web),
                ("notepad", AppKind::Desktop),
                ("needs-admin", AppKind::Desktop)
            ]
        );
        // Zubyr, Batwa and Zahras POS carry their own icons; Example shows the hue art.
        let with_icon: Vec<_> = apps.iter().filter(|a| a.icon_png_base64.is_some()).map(|a| a.id.as_str()).collect();
        assert_eq!(with_icon, ["zubyr-web", "batwa-web", "zahras-pos-web"]);
        assert!(apps[1].pinned_taskbar && apps[2].pinned_taskbar && apps[2].pinned_desktop);
        assert!(!apps[4].pinned_taskbar, "example is not pinned to the taskbar");

        let zubyr = apps[1].web.as_ref().unwrap();
        assert_eq!((zubyr.url.as_str(), zubyr.allowed_domains.as_slice()), ("https://zubyr.dev", ["zubyr.dev".to_string()].as_slice()));
        assert_eq!(zubyr.permissions, WebPermissions::default());
        assert!(!zubyr.permissions.camera, "Zubyr keeps the camera denied");
        let batwa = apps[2].web.as_ref().unwrap();
        assert_eq!(apps[2].name, "Batwa");
        assert_eq!(batwa.url, "https://batwa.zubyr.dev");
        assert_eq!(batwa.allowed_domains, ["batwa.zubyr.dev"]);
        assert!(batwa.permissions.camera, "Batwa has the camera rule on");
        assert_eq!(
            WebPermissions { camera: false, ..batwa.permissions },
            WebPermissions::default(),
            "Batwa differs from the defaults by the camera only"
        );
        let zahra = apps[3].web.as_ref().unwrap();
        assert_eq!(apps[3].name, "Zahras POS");
        assert!(apps[3].pinned_taskbar && apps[3].pinned_desktop);
        assert_eq!(apps[3].hue, Some(293));
        assert_eq!(zahra.url, "https://zahras-pos.vercel.app");
        assert_eq!(zahra.allowed_domains, ["zahras-pos.vercel.app"]);
        assert_eq!(zahra.permissions, WebPermissions::default());
        let example = apps[4].web.as_ref().unwrap();
        assert_eq!(example.url, "https://example.com");
        assert_eq!(example.allowed_domains, ["example.com"]);
        assert!(example.permissions.camera, "Example has the camera rule on");

        // The domains stay apart: Example is outside Zubyr's and Batwa's lists and the
        // other way round, and Batwa (a subdomain) does not allow its parent zubyr.dev.
        // (example.com's own "More information" link goes to iana.org, which no entry lists.)
        assert!(!batwa.allowed_domains.iter().any(|d| d == "zubyr.dev"));
        assert!(!example.allowed_domains.iter().any(|d| d.ends_with("zubyr.dev")));
        assert!(!zubyr.allowed_domains.iter().any(|d| d == "example.com"));

        let admin = apps[6].desktop.as_ref().unwrap();
        assert!(admin.exe.to_lowercase().ends_with(r"\system32\msconfig.exe"), "{}", admin.exe);
        assert!(!admin.exe.contains('%'));
        let notepad = apps[5].desktop.as_ref().unwrap();
        assert!(notepad.exe.to_lowercase().ends_with(r"\system32\notepad.exe"), "{}", notepad.exe);
        assert!(!notepad.exe.contains('%'), "the environment variable is expanded");
        assert_eq!(notepad.file_arg_template, ["{file}"]);
    }

    #[test]
    fn the_app_icons_are_small_square_pngs_the_session_keeps() {
        use base64::Engine as _;
        for (id, png, side) in [
            ("zubyr-web", icons::ZUBYR_PNG, 180),
            ("batwa-web", icons::BATWA_PNG, 180),
            ("zahras-pos-web", icons::ZAHRAS_POS_PNG, 192),
        ] {
            assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"), "{id}: not a PNG");
            assert_eq!(&png[12..16], b"IHDR");
            let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
            let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
            assert_eq!((width, height), (side, side), "{id}");
            assert!(png.len() < 30 * 1024, "{id}: the icon is {} bytes", png.len());

            // What the catalogue carries decodes back to the same file, and the Staff App
            // only accepts a base64 string that starts with the PNG signature.
            let app = catalogue().into_iter().find(|a| a.id == id).unwrap();
            let encoded = app.icon_png_base64.unwrap_or_else(|| panic!("{id} has its icon"));
            assert!(encoded.starts_with("iVBORw0KGgo"));
            assert_eq!(base64::engine::general_purpose::STANDARD.decode(&encoded).unwrap(), png);
            // `apps.list` replaces an icon above 32 KiB decoded by null (session.rs).
            assert!(encoded.len() <= 43_692, "{id}: {} characters", encoded.len());
        }
    }

    #[test]
    fn the_sample_files_are_real_small_and_seeded_once() {
        let total: usize = sample_files().iter().map(|(_, bytes)| bytes.len()).sum();
        assert!(total < 300 * 1024, "the samples are {total} bytes");
        assert!(samples::PHOTO_PNG.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(samples::REPORT_PDF.starts_with(b"%PDF-"));
        assert!(samples::LETTER_DOCX.starts_with(b"PK\x03\x04") && samples::BUDGET_XLSX.starts_with(b"PK\x03\x04"));
        assert_eq!(&samples::CLIP_MP4[4..8], b"ftyp");
        assert!(samples::SONG_MP3.starts_with(b"ID3") || samples::SONG_MP3[0] == 0xFF);

        let dir = std::env::temp_dir().join(format!("rulebox-fixture-seed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let folder = dir.join("fixture-samples");
        export_sample_files(&folder);
        for extension in ["txt", "csv", "png", "pdf", "docx", "xlsx", "mp4"] {
            assert!(
                sample_files().iter().any(|(name, _)| name.ends_with(extension) && folder.join(name).is_file()),
                "no .{extension} sample"
            );
        }
        // Existing files are left alone.
        std::fs::write(folder.join("Notes.txt"), b"mine").unwrap();
        export_sample_files(&folder);
        assert_eq!(std::fs::read(folder.join("Notes.txt")).unwrap(), b"mine");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_demo_snapshot_is_enrolled_and_online_or_offline() {
        let mut online = test_snapshot();
        apply_demo_snapshot(&mut online, false);
        assert_eq!(online.enrollment, EnrollmentStatus::Enrolled);
        assert_eq!(online.connection, ConnectionStatus::Online);
        assert_eq!(online.device.as_ref().map(|d| d.id.as_str()), Some("sim-device"));
        assert!(online.kiosk.enabled && online.desired_state.is_some());
        // The overlay leaves the 1.1 policy fields to `AgentPolicy`.
        assert!(online.power.is_none() && online.org_name.is_none());

        let mut offline = test_snapshot();
        apply_demo_snapshot(&mut offline, true);
        assert_eq!(offline.connection, ConnectionStatus::Offline);
    }

    #[test]
    fn the_demo_document_carries_the_agent_only_keys_with_the_hash_of_2468() {
        use crate::agent_policy::AgentPolicy;
        let doc = demo_document();
        // Still a valid desired state, with the three extra keys beside it.
        assert!(serde_json::from_value::<DesiredState>(doc.clone()).is_ok());
        let policy = AgentPolicy::from_doc(Some(&doc));
        assert!(policy.admin_exit.enabled, "{policy:?}");
        assert_eq!(policy.admin_exit.hotkey, "Ctrl+Shift+F12");
        assert_eq!(policy.admin_exit.problem, None);
        assert_eq!(policy.org_name.as_deref(), Some("Demo Company"));
        assert_eq!(
            policy.power,
            Some(rulebox_ipc::types::PowerOptions { sleep: true, restart: true, shut_down: true })
        );
        let hash = policy.admin_exit.pin_hash.unwrap();
        assert!(kdf::verify_secret(DEMO_EXIT_PIN, &hash).unwrap());
        assert!(!kdf::verify_secret("1111", &hash).unwrap());
    }
}
