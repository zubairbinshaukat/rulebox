//! The demo world of `run --console --simulate --sim-demo` and of fixture mode
//! (plan Section 6.11, "Simulated agent"): employees, the app catalogue, the
//! snapshot overlay. The names match Phase 3's `DemoAgent`.
//!
//! Nothing here runs on a real agent unless `agent-config.json` asks for it **and**
//! the test-machine marker is present (`directory::choose`).

use rulebox_ipc::requests::{
    AppEntry, AppKind, BuiltinApp, DesktopApp, Employee, WebApp, WebPermissions,
};
use rulebox_ipc::types::{AgentSnapshot, ConnectionStatus, DeviceInfo, EnrollmentStatus, KioskPhase, KioskStatus};
use rulebox_policy::{DesiredState, EXAMPLE_DESIRED_STATE_JSON};

/// Every demo employee's password.
pub const DEMO_PASSWORD: &str = "demo";
/// The demo exit PIN (Step 6b hashes it with `kdf::hash_secret` when it builds the
/// demo document).
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
        web_app("orders-web", "Orders", "https://portal.company.com/orders", "portal.company.com", true, 175),
        web_app("mail-web", "Mail", "https://mail.example.com", "mail.example.com", false, 250),
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
    ]
}

/// The demo snapshot of Section 6.11: enrolled, kiosk applied, the example desired
/// state. `offline` is `--sim-offline`. `admin_exit`, `power` and `org_name`
/// arrive with Step 6b and stay `None` until then.
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
                ("orders-web", AppKind::Web),
                ("mail-web", AppKind::Web),
                ("notepad", AppKind::Desktop)
            ]
        );
        assert!(apps.iter().all(|a| a.icon_png_base64.is_none()));
        assert!(!apps[2].pinned_taskbar, "mail is not pinned to the taskbar");
        let notepad = apps[3].desktop.as_ref().unwrap();
        assert!(notepad.exe.to_lowercase().ends_with(r"\system32\notepad.exe"), "{}", notepad.exe);
        assert!(!notepad.exe.contains('%'), "the environment variable is expanded");
        assert_eq!(notepad.file_arg_template, ["{file}"]);
    }

    #[test]
    fn the_demo_snapshot_is_enrolled_and_online_or_offline() {
        let mut online = test_snapshot();
        apply_demo_snapshot(&mut online, false);
        assert_eq!(online.enrollment, EnrollmentStatus::Enrolled);
        assert_eq!(online.connection, ConnectionStatus::Online);
        assert_eq!(online.device.as_ref().map(|d| d.id.as_str()), Some("sim-device"));
        assert!(online.kiosk.enabled && online.desired_state.is_some());
        assert!(online.admin_exit.is_none() && online.power.is_none() && online.org_name.is_none());

        let mut offline = test_snapshot();
        apply_demo_snapshot(&mut offline, true);
        assert_eq!(offline.connection, ConnectionStatus::Offline);
    }
}
