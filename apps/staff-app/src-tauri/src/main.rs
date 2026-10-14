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

    #[test]
    fn sign_in_outcomes_map_to_session() {
        use rulebox_staff_lib::model::Employee;
        use rulebox_staff_lib::session::session_after_outcome;

        let last = Some(EmployeeBrief {
            username: "maya".into(),
            name: "Maya Chen".into(),
        });
        let emp = Employee {
            id: "emp_maya".into(),
            username: "maya".into(),
            name: "Maya Chen".into(),
            role: None,
            quota_bytes: 1,
        };
        let ok = SignInOutcome::Ok {
            employee: emp,
            files_root: r"C:\tmp".into(),
            offline: true,
        };
        assert!(matches!(
            session_after_outcome(last.clone(), &ok),
            SessionState::SignedIn { offline: true, .. }
        ));
        for outcome in [
            SignInOutcome::WrongCredentials,
            SignInOutcome::Disabled,
            SignInOutcome::LockedOut {
                retry_after_ms: 30_000,
            },
            SignInOutcome::OfflineNeverSignedIn,
            SignInOutcome::OfflineExpired,
            SignInOutcome::Unknown,
        ] {
            match session_after_outcome(last.clone(), &outcome) {
                SessionState::SignedOut {
                    last: Some(ref brief),
                } => assert_eq!(brief.username, "maya"),
                other => panic!("unexpected {other:?} for {outcome:?}"),
            }
        }
    }
}

#[cfg(all(test, debug_assertions))]
mod step7_tests {
    use std::path::PathBuf;

    use rulebox_desktop::tracker::WindowEvent;
    use rulebox_desktop::windows::WindowInfo;
    use rulebox_staff_lib::model::{
        AppEntry, AppKind, DesktopApp, WebApp, WebPermissions,
    };
    use rulebox_staff_lib::tasks::{
        coalesce, parse_icon_key, parse_icon_size, parse_label, IconStore, LabelKind, Labels,
        TaskTable,
    };

    fn info(hwnd: isize, title: &str, exe: Option<&str>) -> WindowInfo {
        WindowInfo {
            hwnd,
            pid: 10,
            title: title.into(),
            exe: exe.map(PathBuf::from),
            aumid: None,
            minimized: false,
            cloaked: false,
            class: "Test".into(),
        }
    }

    fn desktop_app(id: &str, exe: &str) -> AppEntry {
        AppEntry {
            id: id.into(),
            name: id.into(),
            description: None,
            kind: AppKind::Desktop(DesktopApp {
                exe: exe.into(),
                args: vec![],
                file_arg_template: vec![],
            }),
            icon_key: None,
            hue: None,
            pinned_taskbar: false,
            pinned_desktop: false,
            badge: None,
        }
    }

    fn labels(pairs: &[(isize, &str)]) -> Labels {
        pairs.iter().map(|(h, l)| (*h, (*l).to_string())).collect()
    }

    #[test]
    fn labels_are_classified() {
        assert_eq!(parse_label("shell-taskbar"), Some(LabelKind::Shell));
        assert_eq!(parse_label("app-3"), Some(LabelKind::Builtin));
        assert_eq!(
            parse_label("web-orders-web-2"),
            Some(LabelKind::Web {
                app_id: "orders-web".into()
            })
        );
        assert_eq!(parse_label("web-orders"), None);
        assert_eq!(parse_label("web--1"), None);
        assert_eq!(parse_label("main"), None);
    }

    #[test]
    fn shell_windows_are_never_listed() {
        let mut table = TaskTable::default();
        let labels = labels(&[(1, "shell-desktop"), (2, "shell-popup")]);
        table.apply(&WindowEvent::Added(info(1, "Rulebox", None)), &labels);
        table.apply(&WindowEvent::Added(info(2, "Rulebox", None)), &labels);
        table.apply(&WindowEvent::Added(info(3, "Notes", None)), &labels);
        let items = table.items(&labels, &[]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "3");
        assert!(!items[0].own);
    }

    #[test]
    fn own_windows_carry_their_app_id() {
        let mut table = TaskTable::default();
        let labels = labels(&[(5, "web-orders-web-1"), (6, "app-0")]);
        table.apply(&WindowEvent::Added(info(5, "Orders", None)), &labels);
        table.apply(&WindowEvent::Added(info(6, "My files", None)), &labels);
        let items = table.items(&labels, &[]);
        assert_eq!(items[0].app_id.as_deref(), Some("orders-web"));
        assert!(items[0].own);
        assert_eq!(items[1].app_id, None);
        assert!(items[1].own);
    }

    #[test]
    fn programs_group_under_their_catalogue_app_by_exe() {
        let catalogue = vec![desktop_app("notepad", r"C:\Windows\System32\notepad.exe")];
        let mut table = TaskTable::default();
        let none = Labels::new();
        table.apply(
            &WindowEvent::Added(info(1, "a.txt", Some(r"c:/windows/system32/NOTEPAD.EXE"))),
            &none,
        );
        table.apply(
            &WindowEvent::Added(info(2, "b", Some(r"C:\Other\thing.exe"))),
            &none,
        );
        table.apply(&WindowEvent::Added(info(3, "c", None)), &none);
        let items = table.items(&none, &catalogue);
        assert_eq!(items[0].app_id.as_deref(), Some("notepad"));
        assert_eq!(items[1].app_id, None);
        assert_eq!(items[2].app_id, None);
    }

    #[test]
    fn web_catalogue_entries_never_match_by_exe() {
        let web = AppEntry {
            kind: AppKind::Web(WebApp {
                url: "https://x.test".into(),
                allowed_domains: vec![],
                permissions: WebPermissions::default(),
            }),
            ..desktop_app("w", "")
        };
        let mut table = TaskTable::default();
        let none = Labels::new();
        table.apply(&WindowEvent::Added(info(1, "a", Some(r"C:\x.exe"))), &none);
        assert_eq!(table.items(&none, &[web])[0].app_id, None);
    }

    #[test]
    fn the_active_indicator_follows_activation() {
        let mut table = TaskTable::default();
        let labels = labels(&[(9, "shell-popup"), (8, "shell-desktop")]);
        table.apply(&WindowEvent::Added(info(1, "a", None)), &labels);
        table.apply(&WindowEvent::Added(info(2, "b", None)), &labels);
        assert!(table.apply(&WindowEvent::Activated(Some(1)), &labels));
        assert!(table.items(&labels, &[])[0].active);
        // Same window again: no change.
        assert!(!table.apply(&WindowEvent::Activated(Some(1)), &labels));
        // The popup takes focus: the program stays active.
        assert!(!table.apply(&WindowEvent::Activated(Some(9)), &labels));
        assert!(table.items(&labels, &[])[0].active);
        // The desktop takes focus: nothing is active.
        assert!(table.apply(&WindowEvent::Activated(Some(8)), &labels));
        assert!(table.items(&labels, &[]).iter().all(|t| !t.active));
        // An unknown window (a tool window, a dialog): nothing is active.
        table.apply(&WindowEvent::Activated(Some(1)), &labels);
        assert!(table.apply(&WindowEvent::Activated(Some(777)), &labels));
    }

    #[test]
    fn removing_a_window_drops_its_state() {
        let mut table = TaskTable::default();
        let none = Labels::new();
        table.apply(&WindowEvent::Added(info(1, "a", None)), &none);
        table.apply(&WindowEvent::Activated(Some(1)), &none);
        table.apply(&WindowEvent::Flash(1, true), &none);
        assert!(table.apply(&WindowEvent::Removed(1), &none));
        assert!(table.items(&none, &[]).is_empty());
        assert!(!table.apply(&WindowEvent::Removed(1), &none));
        // A re-added window starts clean.
        table.apply(&WindowEvent::Added(info(1, "a", None)), &none);
        let item = &table.items(&none, &[])[0];
        assert!(!item.active && !item.flashing);
    }

    #[test]
    fn flash_and_hung_show_on_the_item() {
        let mut table = TaskTable::default();
        let none = Labels::new();
        table.apply(&WindowEvent::Added(info(1, "a", None)), &none);
        table.apply(&WindowEvent::Flash(1, true), &none);
        assert!(table.set_hung([1].into_iter().collect()));
        assert!(!table.set_hung([1].into_iter().collect()));
        let item = &table.items(&none, &[])[0];
        assert!(item.flashing && item.hung);
    }

    #[test]
    fn icon_key_changes_when_the_icon_changes() {
        let mut table = TaskTable::default();
        let none = Labels::new();
        table.apply(&WindowEvent::Added(info(7, "a", None)), &none);
        assert_eq!(table.items(&none, &[])[0].icon_key, "hwnd:7:0");
        table.apply(&WindowEvent::IconChanged(7), &none);
        assert_eq!(table.items(&none, &[])[0].icon_key, "hwnd:7:1");
    }

    #[test]
    fn a_burst_of_title_changes_collapses_to_the_last() {
        let mut events = vec![WindowEvent::Added(info(1, "start", None))];
        for n in 0..50 {
            events.push(WindowEvent::Changed(info(1, &format!("t{n}"), None)));
        }
        events.push(WindowEvent::Changed(info(2, "other", None)));
        let folded = coalesce(events);
        let changes: Vec<_> = folded
            .iter()
            .filter_map(|e| match e {
                WindowEvent::Changed(i) => Some((i.hwnd, i.title.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(changes, vec![(1, "t49".to_string()), (2, "other".to_string())]);
        assert!(matches!(folded[0], WindowEvent::Added(_)));
    }

    #[test]
    fn a_change_before_a_removal_is_dropped() {
        let folded = coalesce(vec![
            WindowEvent::Changed(info(1, "x", None)),
            WindowEvent::Removed(1),
        ]);
        assert!(matches!(folded.as_slice(), [WindowEvent::Removed(1)]));
    }

    #[test]
    fn icon_keys_and_sizes_parse() {
        assert_eq!(parse_icon_key("hwnd:123:4"), Some(123));
        assert_eq!(parse_icon_key("hwnd:123"), Some(123));
        assert_eq!(parse_icon_key("hwnd:0:1"), None);
        assert_eq!(parse_icon_key("hwnd:abc:1"), None);
        assert_eq!(parse_icon_key("exe:abc"), None);
        assert_eq!(parse_icon_size(None), 48);
        assert_eq!(parse_icon_size(Some("s=32")), 32);
        assert_eq!(parse_icon_size(Some("x=1&s=1000")), 256);
        assert_eq!(parse_icon_size(Some("s=2")), 16);
        assert_eq!(parse_icon_size(Some("s=zz")), 48);
    }

    #[test]
    fn the_icon_store_refuses_windows_the_tracker_never_listed() {
        let store = IconStore::default();
        assert!(store.render("hwnd:12345:0", 32).is_none());
    }
}


