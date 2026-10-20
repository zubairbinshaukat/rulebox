//! In-process fake agent for UI development (`RULEBOX_STAFF_DEMO=1`, debug only).

#![cfg(debug_assertions)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures_util::future::{ready, BoxFuture};
use rulebox_ipc::types::{
    AgentSnapshot, ConnectionStatus, DisplayMode, EnrollmentStatus, KioskPhase, KioskStatus,
    ShellHealth, ShellStatus,
};
use rulebox_ipc::{CAPABILITIES, CAP_ADMIN_EXIT, CAP_APPS, CAP_SESSION};
use tokio::sync::watch;

use super::{AgentError, AgentPort};
use crate::model::{
    AdminExitOutcome, AgentLink, AppEntry, AppKind, BuiltinTool, DesktopApp, Employee,
    SignInOutcome, SignInRequest, VerifyOutcome, WebApp, WebPermissions,
};

const LOCKOUT_AFTER: u32 = 5;
const LOCKOUT_MS: u64 = 30_000;
const ADMIN_PIN: &str = "2468";

struct EmployeeRec {
    username: &'static str,
    password: &'static str,
    employee: Employee,
}

fn directory() -> [EmployeeRec; 2] {
    [
        EmployeeRec {
            username: "maya",
            password: "demo",
            employee: Employee {
                id: "emp_maya".into(),
                username: "maya".into(),
                name: "Maya Chen".into(),
                role: Some("Cashier".into()),
                quota_bytes: 10_737_418_240,
            },
        },
        EmployeeRec {
            username: "sam",
            password: "demo",
            employee: Employee {
                id: "emp_sam".into(),
                username: "sam".into(),
                name: "Sam Okonkwo".into(),
                role: Some("Supervisor".into()),
                quota_bytes: 10_737_418_240,
            },
        },
    ]
}

fn demo_snapshot() -> AgentSnapshot {
    AgentSnapshot {
        agent_version: "0.0.0-demo".into(),
        enrollment: EnrollmentStatus::Enrolled,
        device: Some(rulebox_ipc::types::DeviceInfo {
            id: "demo-device".into(),
            name: "Demo PC".into(),
        }),
        convex_url: None,
        connection: ConnectionStatus::Online,
        kiosk: KioskStatus {
            enabled: true,
            phase: KioskPhase::Applied,
            error_code: None,
        },
        shell: ShellStatus {
            health: ShellHealth::Healthy,
        },
        display_mode: DisplayMode::Standard,
        desired_state: Some(rulebox_policy::DesiredState {
            kiosk_enabled: true,
            apps: vec!["files".into(), "orders-web".into(), "notepad".into()],
            allowed_sites: vec!["portal.company.com".into()],
            file_handlers: Default::default(),
            storage: rulebox_policy::StorageConfig {
                default_quota_gb: 10,
            },
            branding: rulebox_policy::Branding {
                name: "Demo Org".into(),
                logo: None,
            },
            version: 1,
        }),
        desired_state_version: 1,
        server_time_offset_ms: Some(0),
        clock_suspect: false,
        admin_exit: Some(rulebox_ipc::types::AdminExitInfo {
            enabled: true,
            hotkey: rulebox_ipc::hotkey::DEFAULT_ADMIN_EXIT_HOTKEY.to_string(),
        }),
        power: Some(rulebox_ipc::types::PowerOptions {
            sleep: true,
            restart: true,
            shut_down: true,
        }),
        org_name: Some("Demo Org".into()),
    }
}

/// Catalogue for the demo agent. `RULEBOX_DEMO_APPS=<n>` (and the debug
/// cmd poller) select the count for layout screenshots.
pub fn sample_apps_for(n: Option<usize>) -> Vec<AppEntry> {
    let base = vec![
        AppEntry {
            id: "files".into(),
            name: "My files".into(),
            description: Some("Your files on this PC".into()),
            kind: AppKind::Builtin {
                tool: BuiltinTool::Files,
            },
            icon_key: Some("folder".into()),
            hue: None,
            pinned_taskbar: true,
            pinned_desktop: false,
            badge: None,
        },
        AppEntry {
            id: "orders-web".into(),
            name: "Orders".into(),
            description: Some("Company order portal".into()),
            kind: AppKind::Web(WebApp {
                url: "https://portal.company.com/orders".into(),
                allowed_domains: vec!["portal.company.com".into()],
                permissions: WebPermissions::default(),
            }),
            icon_key: None,
            hue: Some(175),
            pinned_taskbar: true,
            pinned_desktop: true,
            badge: None,
        },
        AppEntry {
            id: "notepad".into(),
            name: "Notepad".into(),
            description: None,
            kind: AppKind::Desktop(DesktopApp {
                exe: r"C:\Windows\System32\notepad.exe".into(),
                args: vec![],
                file_arg_template: vec!["{file}".into()],
            }),
            icon_key: None,
            hue: Some(30),
            pinned_taskbar: false,
            pinned_desktop: true,
            badge: None,
        },
    ];

    let Some(n) = n else {
        return base;
    };
    if n == 0 {
        return Vec::new();
    }
    let mut out = base;
    if out.len() > n {
        out.truncate(n);
        return out;
    }
    let mut i = out.len();
    while out.len() < n {
        i += 1;
        let hue = ((i * 37) % 360) as u16;
        out.push(AppEntry {
            id: format!("demo-app-{i}"),
            name: format!("Demo app {i}"),
            description: Some("Generated for layout screenshots".into()),
            kind: AppKind::Web(WebApp {
                url: format!("https://example.invalid/app/{i}"),
                allowed_domains: vec!["example.invalid".into()],
                permissions: WebPermissions::default(),
            }),
            icon_key: None,
            hue: Some(hue),
            pinned_taskbar: false,
            pinned_desktop: true,
            badge: if i % 5 == 0 { Some(i as u32 % 9 + 1) } else { None },
        });
    }
    out
}

/// Two real web apps for trying the web app windows by hand (Step 15):
/// "Example" may show only example.com (its own "More information" link goes
/// to iana.org, which is not allowed), and "Camera test" asks for a camera it is
/// not given. Added when RULEBOX_DEMO_WEB is set.
fn demo_web_apps() -> Vec<AppEntry> {
    let make = |id: &str, name: &str, url: &str, domains: &[&str]| AppEntry {
        id: id.into(),
        name: name.into(),
        description: Some("Web app demo".into()),
        kind: AppKind::Web(WebApp {
            url: url.into(),
            allowed_domains: domains.iter().map(|d| (*d).to_string()).collect(),
            permissions: WebPermissions::default(),
        }),
        icon_key: None,
        hue: Some(210),
        pinned_taskbar: false,
        pinned_desktop: true,
        badge: None,
    };
    vec![
        make("example-web", "Example", "https://example.com/", &["example.com"]),
        make("camera-web", "Camera test", "https://webcamtests.com/", &["webcamtests.com"]),
    ]
}

fn sample_apps() -> Vec<AppEntry> {
    let n = std::env::var_os("RULEBOX_DEMO_APPS").and_then(|raw| raw.to_string_lossy().parse().ok());
    let mut apps = sample_apps_for(n);
    if std::env::var_os("RULEBOX_DEMO_WEB").is_some() {
        apps.extend(demo_web_apps());
    }
    apps
}

fn files_root_for(username: &str) -> String {
    // The workspace `target\`, not a `target\` next to wherever the app was
    // started (the files backend creates the folder).
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../../target/demo-files");
    path.push(username);
    path.to_string_lossy().into_owned()
}

/// A real 96x64 PNG (a soft gradient) so the image chip and viewer have something to show.
fn demo_png() -> Vec<u8> {
    let (width, height) = (96u32, 64u32);
    let mut pixels = Vec::with_capacity((width * height * 3) as usize);
    for y in 0..height {
        for x in 0..width {
            pixels.extend_from_slice(&[(40 + x * 2) as u8, (120 + y) as u8, 170]);
        }
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        if let Ok(mut writer) = encoder.write_header() {
            let _ = writer.write_image_data(&pixels);
        }
    }
    out
}

/// Sample files for the demo employees: about a dozen files, a few folders and
/// one folder of 5,000 empty files (to check that the lists scroll smoothly).
/// Written once, on a worker, and only when the folder has never been seeded.
fn seed_demo_files(root: &str) {
    let root = PathBuf::from(root);
    std::thread::spawn(move || {
        let marker = root.join(".rulebox-demo-seeded");
        if marker.exists() {
            return;
        }
        let write = |name: &str, bytes: &[u8]| {
            let path = root.join(name);
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(path, bytes);
        };
        write("Shopping list.txt", b"Milk\nEggs\nBread\nCoffee\n");
        write("Notes.txt", "Remember to call the supplier.\nTotal: 4\u{20ac}\n".as_bytes());
        write("Sales.csv", b"Day,Items,Total\nMon,12,48.50\nTue,9,36.00\nWed,15,61.25\n");
        write("Report.pdf", b"%PDF-1.4\n% demo stub\n");
        write("Budget.xlsx", b"PK\x03\x04 demo stub");
        write("Letter.docx", b"PK\x03\x04 demo stub");
        write("Song.mp3", b"ID3 demo stub");
        write("Clip.mp4", b"\0\0\0\x18ftypmp42 demo stub");
        let png = demo_png();
        write("Photo.png", &png);
        write("Documents/Contract.txt", b"Draft contract.\n");
        write("Documents/Invoice.csv", b"No,Amount\n1,100\n");
        write("Pictures/Logo.png", &png);
        write("Downloads/Manual.pdf", b"%PDF-1.4\n% demo stub\n");
        let big = root.join("Big folder");
        let _ = std::fs::create_dir_all(&big);
        for n in 0..5000 {
            let _ = std::fs::write(big.join(format!("File {n:04}.txt")), b"");
        }
        let _ = std::fs::write(marker, b"1");
    });
}

struct SessionSlot {
    employee: Option<Employee>,
    fails: u32,
    locked_until: Option<Instant>,
    pin_fails: u32,
    pin_locked_until: Option<Instant>,
}

/// Fake agent: enrolled, online, kiosk applied; `maya`/`demo` and `sam`/`demo`.
pub struct DemoAgent {
    link_tx: watch::Sender<AgentLink>,
    link_rx: watch::Receiver<AgentLink>,
    snap_tx: watch::Sender<Option<AgentSnapshot>>,
    snap_rx: watch::Receiver<Option<AgentSnapshot>>,
    session: Mutex<SessionSlot>,
    ready_count: AtomicU32,
}

impl DemoAgent {
    pub fn new() -> Self {
        let (link_tx, link_rx) = watch::channel(AgentLink::Linked);
        let (snap_tx, snap_rx) = watch::channel(Some(demo_snapshot()));
        Self {
            link_tx,
            link_rx,
            snap_tx,
            snap_rx,
            session: Mutex::new(SessionSlot {
                employee: None,
                fails: 0,
                locked_until: None,
                pin_fails: 0,
                pin_locked_until: None,
            }),
            ready_count: AtomicU32::new(0),
        }
    }

    #[cfg(test)]
    pub fn set_link(&self, link: AgentLink) {
        let _ = self.link_tx.send(link);
    }
}

impl Default for DemoAgent {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentPort for DemoAgent {
    fn link(&self) -> watch::Receiver<AgentLink> {
        self.link_rx.clone()
    }

    fn snapshot(&self) -> watch::Receiver<Option<AgentSnapshot>> {
        self.snap_rx.clone()
    }

    fn capabilities(&self) -> Vec<String> {
        let mut caps: Vec<String> = CAPABILITIES.iter().map(|s| (*s).to_string()).collect();
        caps.push(CAP_SESSION.to_string());
        caps.push(CAP_APPS.to_string());
        caps.push(CAP_ADMIN_EXIT.to_string());
        caps
    }

    fn ready(&self) -> BoxFuture<'_, Result<(), AgentError>> {
        self.ready_count.fetch_add(1, Ordering::Relaxed);
        let _ = self.snap_tx.send(Some(demo_snapshot()));
        Box::pin(ready(Ok(())))
    }

    fn heartbeat(&self) -> BoxFuture<'_, Result<(), AgentError>> {
        Box::pin(ready(Ok(())))
    }

    fn sign_in(&self, req: SignInRequest) -> BoxFuture<'_, Result<SignInOutcome, AgentError>> {
        Box::pin(async move {
            let mut slot = self
                .session
                .lock()
                .map_err(|e| AgentError::Internal(e.to_string()))?;

            if let Some(until) = slot.locked_until {
                if Instant::now() < until {
                    let retry = until.saturating_duration_since(Instant::now());
                    return Ok(SignInOutcome::LockedOut {
                        retry_after_ms: retry.as_millis() as u64,
                    });
                }
                slot.locked_until = None;
                slot.fails = 0;
            }

            let username = req.username.trim().to_ascii_lowercase();
            let found = directory()
                .into_iter()
                .find(|e| e.username == username.as_str());

            match found {
                Some(rec) if rec.password == req.password => {
                    slot.fails = 0;
                    slot.employee = Some(rec.employee.clone());
                    let files_root = files_root_for(rec.username);
                    seed_demo_files(&files_root);
                    Ok(SignInOutcome::Ok {
                        employee: rec.employee.clone(),
                        files_root,
                        offline: false,
                    })
                }
                Some(_) | None => {
                    slot.fails = slot.fails.saturating_add(1);
                    if slot.fails >= LOCKOUT_AFTER {
                        slot.locked_until = Some(Instant::now() + Duration::from_millis(LOCKOUT_MS));
                        slot.fails = 0;
                        Ok(SignInOutcome::LockedOut {
                            retry_after_ms: LOCKOUT_MS,
                        })
                    } else {
                        Ok(SignInOutcome::WrongCredentials)
                    }
                }
            }
        })
    }

    fn sign_out(&self) -> BoxFuture<'_, Result<(), AgentError>> {
        Box::pin(async move {
            let mut slot = self
                .session
                .lock()
                .map_err(|e| AgentError::Internal(e.to_string()))?;
            slot.employee = None;
            Ok(())
        })
    }

    fn verify_password(
        &self,
        password: String,
    ) -> BoxFuture<'_, Result<VerifyOutcome, AgentError>> {
        Box::pin(async move {
            let mut slot = self
                .session
                .lock()
                .map_err(|e| AgentError::Internal(e.to_string()))?;

            let Some(employee) = slot.employee.clone() else {
                return Err(AgentError::Rejected {
                    code: "not_signed_in".into(),
                    message: "no employee is signed in".into(),
                });
            };

            if let Some(until) = slot.locked_until {
                if Instant::now() < until {
                    let retry = until.saturating_duration_since(Instant::now());
                    return Ok(VerifyOutcome::LockedOut {
                        retry_after_ms: retry.as_millis() as u64,
                    });
                }
                slot.locked_until = None;
                slot.fails = 0;
            }

            let expected = directory()
                .into_iter()
                .find(|e| e.username == employee.username.as_str())
                .map(|e| e.password);

            if expected == Some(password.as_str()) {
                slot.fails = 0;
                Ok(VerifyOutcome::Ok)
            } else {
                slot.fails = slot.fails.saturating_add(1);
                if slot.fails >= LOCKOUT_AFTER {
                    slot.locked_until = Some(Instant::now() + Duration::from_millis(LOCKOUT_MS));
                    slot.fails = 0;
                    Ok(VerifyOutcome::LockedOut {
                        retry_after_ms: LOCKOUT_MS,
                    })
                } else {
                    Ok(VerifyOutcome::WrongCredentials)
                }
            }
        })
    }

    fn apps(&self) -> BoxFuture<'_, Result<Vec<AppEntry>, AgentError>> {
        Box::pin(ready(Ok(sample_apps())))
    }

    fn admin_exit(&self, pin: String) -> BoxFuture<'_, Result<AdminExitOutcome, AgentError>> {
        Box::pin(async move {
            let mut slot = self
                .session
                .lock()
                .map_err(|e| AgentError::Internal(e.to_string()))?;

            if let Some(until) = slot.pin_locked_until {
                if Instant::now() < until {
                    let retry = until.saturating_duration_since(Instant::now());
                    return Ok(AdminExitOutcome::LockedOut {
                        retry_after_ms: retry.as_millis() as u64,
                    });
                }
                slot.pin_locked_until = None;
                slot.pin_fails = 0;
            }

            if pin == ADMIN_PIN {
                slot.pin_fails = 0;
                tracing::info!("demo admin exit: would sign out to Windows (PIN ok)");
                Ok(AdminExitOutcome::SigningOut)
            } else {
                slot.pin_fails = slot.pin_fails.saturating_add(1);
                if slot.pin_fails >= LOCKOUT_AFTER {
                    slot.pin_locked_until =
                        Some(Instant::now() + Duration::from_millis(LOCKOUT_MS));
                    slot.pin_fails = 0;
                    Ok(AdminExitOutcome::LockedOut {
                        retry_after_ms: LOCKOUT_MS,
                    })
                } else {
                    let left = LOCKOUT_AFTER.saturating_sub(slot.pin_fails);
                    Ok(AdminExitOutcome::WrongPin {
                        attempts_left: Some(left),
                    })
                }
            }
        })
    }
}
