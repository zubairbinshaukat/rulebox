// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    rulebox_staff_lib::run()
}

// Step 3 tests live here: the lib unit-test / integration-test harnesses exit
// with STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139) on this Windows + Tauri link,
// but the bin harness (this file) starts cleanly.
#[cfg(all(test, debug_assertions))]
mod step3_tests {
    use std::sync::Arc;
    use std::time::Duration;

    use rulebox_staff_lib::agent::demo::DemoAgent;
    use rulebox_staff_lib::agent::AgentPort;
    use rulebox_staff_lib::model::{
        AgentLinkDto, AgentSummary, AppEntry, AppKind, BuiltinTool, CatalogState, CatalogStatus,
        ConnectionDto, DesktopApp, DisplayPrefs, EmployeeBrief, EnrollmentDto, KioskPhaseDto,
        NetworkDto, SessionState, ShellModeDto, ShellState, SignInOutcome, SignInRequest,
        SystemState, ThemeDto, VolumeDto, WebApp, WebPermissions,
    };
    use rulebox_staff_lib::state::AppState;
    use serde_json::json;

    fn sample_shell_state() -> ShellState {
        ShellState {
            mode: ShellModeDto::Dev,
            link: AgentLinkDto::Linked,
            agent: Some(AgentSummary {
                enrollment: EnrollmentDto::Enrolled,
                connection: ConnectionDto::Online,
                kiosk_phase: KioskPhaseDto::Applied,
                clock_suspect: false,
                org_name: Some("Demo Org".into()),
            }),
            display: DisplayPrefs {
                lite: false,
                theme: ThemeDto::Auto,
                reduced_motion: false,
            },
            session: SessionState::SignedOut {
                last: Some(EmployeeBrief {
                    username: "maya".into(),
                    name: "Maya Chen".into(),
                }),
            },
            apps: CatalogState {
                status: CatalogStatus::Ready,
                items: vec![
                    AppEntry {
                        id: "files".into(),
                        name: "My files".into(),
                        description: Some("Your files".into()),
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
                        description: None,
                        kind: AppKind::Web(WebApp {
                            url: "https://portal.company.com/orders".into(),
                            allowed_domains: vec!["portal.company.com".into()],
                            permissions: WebPermissions::default(),
                        }),
                        icon_key: None,
                        hue: Some(175),
                        pinned_taskbar: true,
                        pinned_desktop: true,
                        badge: Some(2),
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
                ],
            },
            tasks: vec![],
            system: SystemState {
                volume: Some(VolumeDto {
                    level: 0.5,
                    muted: false,
                }),
                battery: None,
                network: NetworkDto::Internet,
                can_power_off: true,
            },
            notices: vec![],
            banner: None,
            capabilities: vec![
                "state".into(),
                "health".into(),
                "session".into(),
                "apps".into(),
                "adminExit".into(),
            ],
        }
    }

    #[test]
    fn shell_state_golden_json() {
        let state = sample_shell_state();
        let value = serde_json::to_value(&state).expect("serialize");
        let expected = json!({
            "mode": "dev",
            "link": "linked",
            "agent": {
                "enrollment": "enrolled",
                "connection": "online",
                "kioskPhase": "applied",
                "clockSuspect": false,
                "orgName": "Demo Org"
            },
            "display": {
                "lite": false,
                "theme": "auto",
                "reducedMotion": false
            },
            "session": {
                "status": "signedOut",
                "last": { "username": "maya", "name": "Maya Chen" }
            },
            "apps": {
                "status": "ready",
                "items": [
                    {
                        "id": "files",
                        "name": "My files",
                        "description": "Your files",
                        "kind": { "type": "builtin", "tool": "files" },
                        "iconKey": "folder",
                        "hue": null,
                        "pinnedTaskbar": true,
                        "pinnedDesktop": false,
                        "badge": null
                    },
                    {
                        "id": "orders-web",
                        "name": "Orders",
                        "description": null,
                        "kind": {
                            "type": "web",
                            "url": "https://portal.company.com/orders",
                            "allowedDomains": ["portal.company.com"],
                            "permissions": {
                                "camera": false,
                                "microphone": false,
                                "screenShare": false,
                                "clipboardRead": false,
                                "notifications": true,
                                "downloads": true,
                                "printing": false,
                                "geolocation": false
                            }
                        },
                        "iconKey": null,
                        "hue": 175,
                        "pinnedTaskbar": true,
                        "pinnedDesktop": true,
                        "badge": 2
                    },
                    {
                        "id": "notepad",
                        "name": "Notepad",
                        "description": null,
                        "kind": { "type": "desktop" },
                        "iconKey": null,
                        "hue": 30,
                        "pinnedTaskbar": false,
                        "pinnedDesktop": true,
                        "badge": null
                    }
                ]
            },
            "tasks": [],
            "system": {
                "volume": { "level": 0.5, "muted": false },
                "battery": null,
                "network": "internet",
                "canPowerOff": true
            },
            "notices": [],
            "banner": null,
            "capabilities": ["state", "health", "session", "apps", "adminExit"]
        });
        assert_eq!(value, expected);
        let text = serde_json::to_string(&state).expect("text");
        assert!(!text.contains("notepad.exe"));
        assert!(!text.contains("fileArgTemplate"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn demo_sign_in_ok() {
        let agent = DemoAgent::new();
        let outcome = agent
            .sign_in(SignInRequest {
                username: "maya".into(),
                password: "demo".into(),
            })
            .await
            .expect("ok");
        match outcome {
            SignInOutcome::Ok {
                employee,
                files_root,
                offline,
            } => {
                assert_eq!(employee.username, "maya");
                assert!(files_root.replace('/', "\\").ends_with("demo-files\\maya"));
                assert!(!offline);
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn demo_sign_in_wrong_password() {
        let agent = DemoAgent::new();
        let outcome = agent
            .sign_in(SignInRequest {
                username: "maya".into(),
                password: "nope".into(),
            })
            .await
            .expect("ok");
        assert_eq!(outcome, SignInOutcome::WrongCredentials);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn demo_sign_in_lockout_after_five() {
        let agent = DemoAgent::new();
        for _ in 0..4 {
            let outcome = agent
                .sign_in(SignInRequest {
                    username: "maya".into(),
                    password: "wrong".into(),
                })
                .await
                .expect("ok");
            assert_eq!(outcome, SignInOutcome::WrongCredentials);
        }
        let outcome = agent
            .sign_in(SignInRequest {
                username: "maya".into(),
                password: "wrong".into(),
            })
            .await
            .expect("ok");
        match outcome {
            SignInOutcome::LockedOut { retry_after_ms } => {
                assert!(retry_after_ms > 0);
            }
            other => panic!("expected LockedOut, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn state_emits_are_coalesced() {
        let agent = Arc::new(DemoAgent::new());
        let state = AppState::new(agent, ShellState::initial(ShellModeDto::Dev));

        for i in 0..10 {
            state.update(|s| {
                s.display.lite = i % 2 == 0;
            });
        }

        tokio::time::sleep(Duration::from_millis(80)).await;
        let count = state.emit_count();
        assert!(
            count <= 2,
            "expected at most 2 emits after a burst, got {count}"
        );
        assert!(count >= 1, "expected at least one emit");
    }
}
