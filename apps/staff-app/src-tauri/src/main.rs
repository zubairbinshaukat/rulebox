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
                brightness: None,
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
                "canPowerOff": true,
                "brightness": null
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

    fn no_jobs() -> std::collections::HashMap<u32, String> {
        std::collections::HashMap::new()
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
        let items = table.items(&labels, &[], &no_jobs());
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
        let items = table.items(&labels, &[], &no_jobs());
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
        let items = table.items(&none, &catalogue, &no_jobs());
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
        assert_eq!(table.items(&none, &[web], &no_jobs())[0].app_id, None);
    }

    #[test]
    fn the_active_indicator_follows_activation() {
        let mut table = TaskTable::default();
        let labels = labels(&[(9, "shell-popup"), (8, "shell-desktop")]);
        table.apply(&WindowEvent::Added(info(1, "a", None)), &labels);
        table.apply(&WindowEvent::Added(info(2, "b", None)), &labels);
        assert!(table.apply(&WindowEvent::Activated(Some(1)), &labels));
        assert!(table.items(&labels, &[], &no_jobs())[0].active);
        // Same window again: no change.
        assert!(!table.apply(&WindowEvent::Activated(Some(1)), &labels));
        // The popup takes focus: the program stays active.
        assert!(!table.apply(&WindowEvent::Activated(Some(9)), &labels));
        assert!(table.items(&labels, &[], &no_jobs())[0].active);
        // The desktop takes focus: nothing is active.
        assert!(table.apply(&WindowEvent::Activated(Some(8)), &labels));
        assert!(table.items(&labels, &[], &no_jobs()).iter().all(|t| !t.active));
        // An unknown window (a tool window, a dialog): nothing is active.
        table.apply(&WindowEvent::Activated(Some(1)), &labels);
        assert!(table.apply(&WindowEvent::Activated(Some(777)), &labels));
    }

    #[test]
    fn a_window_that_takes_the_focus_before_it_is_listed_is_active_once_listed() {
        let mut table = TaskTable::default();
        let none = Labels::new();
        // The foreground event arrives first, the window's Added after it.
        table.apply(&WindowEvent::Activated(Some(9)), &none);
        table.apply(&WindowEvent::Added(info(9, "Late", None)), &none);
        assert!(table.items(&none, &[], &no_jobs())[0].active);
    }
    #[test]
    fn removing_a_window_drops_its_state() {
        let mut table = TaskTable::default();
        let none = Labels::new();
        table.apply(&WindowEvent::Added(info(1, "a", None)), &none);
        table.apply(&WindowEvent::Activated(Some(1)), &none);
        table.apply(&WindowEvent::Flash(1, true), &none);
        assert!(table.apply(&WindowEvent::Removed(1), &none));
        assert!(table.items(&none, &[], &no_jobs()).is_empty());
        assert!(!table.apply(&WindowEvent::Removed(1), &none));
        // A re-added window starts clean.
        table.apply(&WindowEvent::Added(info(1, "a", None)), &none);
        let item = &table.items(&none, &[], &no_jobs())[0];
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
        let item = &table.items(&none, &[], &no_jobs())[0];
        assert!(item.flashing && item.hung);
    }

    #[test]
    fn icon_key_changes_when_the_icon_changes() {
        let mut table = TaskTable::default();
        let none = Labels::new();
        table.apply(&WindowEvent::Added(info(7, "a", None)), &none);
        assert_eq!(table.items(&none, &[], &no_jobs())[0].icon_key, "hwnd:7:0");
        table.apply(&WindowEvent::IconChanged(7), &none);
        assert_eq!(table.items(&none, &[], &no_jobs())[0].icon_key, "hwnd:7:1");
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




#[cfg(all(test, debug_assertions))]
mod step8_tests {
    use std::collections::HashMap;
    use std::path::PathBuf;

    use rulebox_desktop::tracker::WindowEvent;
    use rulebox_desktop::windows::WindowInfo;
    use rulebox_desktop::DesktopError;
    use rulebox_staff_lib::launcher::{
        adoption_target, failure_notice, plan_launch, LaunchPlan, Launcher, ADOPT_WINDOW,
    };
    use rulebox_staff_lib::model::{
        AppEntry, AppKind, BuiltinTool, DesktopApp, TaskItem, WebApp, WebPermissions,
    };
    use rulebox_staff_lib::tasks::{
        click_action, plan_show_desktop, ClickAction, Labels, ShowDesktopPlan, TaskFacts,
        TaskRegistry, TaskTable,
    };

    fn app(id: &str, kind: AppKind) -> AppEntry {
        AppEntry {
            id: id.into(),
            name: format!("{id} app"),
            description: None,
            kind,
            icon_key: None,
            hue: None,
            pinned_taskbar: false,
            pinned_desktop: false,
            badge: None,
        }
    }

    fn desktop(id: &str, exe: &str, args: &[&str]) -> AppEntry {
        app(
            id,
            AppKind::Desktop(DesktopApp {
                exe: exe.into(),
                args: args.iter().map(|a| (*a).to_string()).collect(),
                file_arg_template: vec![],
            }),
        )
    }

    fn task(id: &str, app_id: Option<&str>, active: bool) -> TaskItem {
        TaskItem {
            id: id.into(),
            app_id: app_id.map(String::from),
            title: "t".into(),
            icon_key: format!("hwnd:{id}:0"),
            active,
            minimized: false,
            flashing: false,
            hung: false,
            own: false,
        }
    }

    #[test]
    fn launching_an_unopened_desktop_app_starts_it_from_the_catalogue() {
        let catalogue = vec![desktop("notes", r"C:\Apps\notes.exe", &["--fast"])];
        let plan = plan_launch(&catalogue, "notes", &[], false);
        assert_eq!(
            plan,
            LaunchPlan::Start {
                exe: PathBuf::from(r"C:\Apps\notes.exe"),
                args: vec!["--fast".into()],
            }
        );
    }

    #[test]
    fn launching_an_open_app_focuses_it_instead_of_starting_another() {
        let catalogue = vec![desktop("notes", r"C:\Apps\notes.exe", &[])];
        let tasks = vec![task("10", Some("notes"), false), task("11", Some("notes"), false)];
        assert_eq!(
            plan_launch(&catalogue, "notes", &tasks, false),
            LaunchPlan::Focus {
                task_id: "10".into()
            }
        );
    }

    #[test]
    fn the_active_window_of_an_app_is_the_one_focused() {
        let catalogue = vec![desktop("notes", r"C:\Apps\notes.exe", &[])];
        let tasks = vec![task("10", Some("notes"), false), task("11", Some("notes"), true)];
        assert_eq!(
            plan_launch(&catalogue, "notes", &tasks, false),
            LaunchPlan::Focus {
                task_id: "11".into()
            }
        );
    }

    #[test]
    fn other_apps_windows_do_not_count() {
        let catalogue = vec![desktop("notes", r"C:\Apps\notes.exe", &[])];
        let tasks = vec![task("10", Some("other"), true), task("11", None, false)];
        assert!(matches!(
            plan_launch(&catalogue, "notes", &tasks, false),
            LaunchPlan::Start { .. }
        ));
    }

    #[test]
    fn unknown_ids_and_closing_and_other_kinds_are_not_started() {
        let catalogue = vec![
            desktop("notes", r"C:\Apps\notes.exe", &[]),
            app(
                "files",
                AppKind::Builtin {
                    tool: BuiltinTool::Files,
                },
            ),
            app(
                "orders",
                AppKind::Web(WebApp {
                    url: "https://x.test".into(),
                    allowed_domains: vec![],
                    permissions: WebPermissions::default(),
                }),
            ),
        ];
        assert_eq!(plan_launch(&catalogue, "nope", &[], false), LaunchPlan::Unknown);
        assert_eq!(plan_launch(&catalogue, "notes", &[], true), LaunchPlan::Closing);
        assert_eq!(
            plan_launch(&catalogue, "files", &[], false),
            LaunchPlan::OpenBuiltin {
                tool: BuiltinTool::Files
            }
        );
        assert_eq!(plan_launch(&catalogue, "orders", &[], false), LaunchPlan::NotYet);
    }

    #[test]
    fn failure_notices_explain_elevation_and_missing_programs() {
        let (title, detail) = failure_notice("Zoom", &DesktopError::NeedsElevation);
        assert_eq!(title, "Zoom could not be opened.");
        assert_eq!(
            detail.as_deref(),
            Some("This app needs administrator rights and can't be opened here.")
        );
        let (_, missing) =
            failure_notice("Zoom", &DesktopError::Refused("the program was not found".into()));
        assert_eq!(missing.as_deref(), Some("The program was not found on this PC."));
    }

    #[test]
    fn the_task_click_rule() {
        assert_eq!(click_action(true, false), ClickAction::Restore);
        // A minimized window is never "active" in a way that minimizes it again.
        assert_eq!(click_action(true, true), ClickAction::Restore);
        assert_eq!(click_action(false, true), ClickAction::Minimize);
        assert_eq!(click_action(false, false), ClickAction::Focus);
    }

    #[test]
    fn show_desktop_minimizes_everything_then_restores_only_those() {
        let listed = vec![(1, false), (2, true), (3, false)];
        // First call: minimize the two that are showing.
        assert_eq!(
            plan_show_desktop(&[], &listed),
            ShowDesktopPlan::Minimize(vec![1, 3])
        );
        // Second call: those two are now minimized; 2 was minimized before and stays.
        let after = vec![(1, true), (2, true), (3, true)];
        assert_eq!(
            plan_show_desktop(&[1, 3], &after),
            ShowDesktopPlan::Restore(vec![1, 3])
        );
    }

    #[test]
    fn show_desktop_leaves_a_window_the_person_restored_and_forgets_closed_ones() {
        // 1 was restored by hand, 3 was closed, 4 is still minimized.
        let listed = vec![(1, false), (4, true)];
        assert_eq!(
            plan_show_desktop(&[1, 3, 4], &listed),
            ShowDesktopPlan::Restore(vec![4])
        );
    }

    #[test]
    fn show_desktop_starts_over_when_nothing_remembered_is_left() {
        let listed = vec![(1, false), (2, false)];
        assert_eq!(
            plan_show_desktop(&[9], &listed),
            ShowDesktopPlan::Minimize(vec![1, 2])
        );
    }

    #[test]
    fn the_registry_only_knows_listed_windows() {
        let registry = TaskRegistry::default();
        registry.sync(vec![(
            42,
            TaskFacts {
                pid: 7,
                own: false,
                minimized: false,
                active: true,
                hung: false,
            },
        )]);
        assert!(registry.lookup("42").is_some());
        assert!(registry.lookup("43").is_none());
        assert!(registry.lookup("not a number").is_none());
        assert!(registry.lookup("").is_none());
        registry.sync(vec![]);
        assert!(registry.lookup("42").is_none());
    }

    #[test]
    fn a_process_in_a_started_job_maps_to_its_app_even_without_a_matching_exe() {
        let catalogue = vec![desktop("notes", r"C:\Apps\notes.exe", &[])];
        let mut table = TaskTable::default();
        let none = Labels::new();
        table.apply(
            &WindowEvent::Added(WindowInfo {
                hwnd: 5,
                pid: 4321,
                title: "x".into(),
                exe: Some(PathBuf::from(r"C:\Somewhere\else.exe")),
                aumid: None,
                minimized: false,
                cloaked: false,
                class: "Test".into(),
            }),
            &none,
        );
        let mut jobs = HashMap::new();
        jobs.insert(4321u32, "notes".to_string());
        assert_eq!(
            table.items(&none, &catalogue, &jobs)[0].app_id.as_deref(),
            Some("notes")
        );
        assert_eq!(
            table.items(&none, &catalogue, &HashMap::new())[0].app_id,
            None
        );
    }

    #[test]
    fn the_launcher_tracks_a_started_program_until_it_ends() {
        let exe = PathBuf::from(r"C:\Windows\System32\ping.exe");
        if !exe.exists() {
            return;
        }
        let launcher = Launcher::default();
        let pid = launcher
            .start("pinger", &exe, &["-n".into(), "2".into(), "127.0.0.1".into()])
            .expect("start");
        let none = std::collections::HashSet::new();
        assert_eq!(launcher.pid_map(&none).get(&pid).map(String::as_str), Some("pinger"));
        // Two pings take about a second; then the job empties and is dropped.
        std::thread::sleep(std::time::Duration::from_millis(2500));
        assert!(launcher.pid_map(&none).is_empty());
    }

    #[test]
    fn a_hand_off_window_is_adopted_by_program_name_shortly_after_launch() {
        let launches = vec![(
            "notes".to_string(),
            Some("Notepad.exe".to_string()),
            std::time::Duration::from_secs(2),
        )];
        assert_eq!(
            adoption_target(&launches, "notepad.exe").as_deref(),
            Some("notes")
        );
        assert_eq!(adoption_target(&launches, "calc.exe"), None);
    }

    #[test]
    fn adoption_expires_and_prefers_the_newest_launch() {
        let old = std::time::Duration::from_secs(60);
        let launches = vec![
            ("a".to_string(), Some("x.exe".to_string()), old),
            (
                "b".to_string(),
                Some("x.exe".to_string()),
                std::time::Duration::from_secs(5),
            ),
            (
                "c".to_string(),
                Some("x.exe".to_string()),
                std::time::Duration::from_secs(1),
            ),
        ];
        assert_eq!(adoption_target(&launches, "x.exe").as_deref(), Some("c"));
        let only_old = vec![("a".to_string(), Some("x.exe".to_string()), ADOPT_WINDOW)];
        assert_eq!(adoption_target(&only_old, "x.exe"), None);
    }
}

#[cfg(all(test, debug_assertions))]
mod step9_tests {
    use std::collections::{HashMap, HashSet};

    use rulebox_staff_lib::model::{Employee, SessionState};
    use rulebox_staff_lib::session::{
        closing_names, drive_sign_out, lock_transition, matches_search, sign_out_targets,
        windows_to_minimize, CloseCandidate, LockEvent, MinimizeCandidate, NamedWindow, SignOutOps,
        SignOutScope,
    };

    fn scope_jobs(pids: &[u32]) -> SignOutScope {
        SignOutScope {
            job_pids: pids.iter().copied().collect(),
            adopted_hwnds: HashSet::new(),
        }
    }

    fn scope_adopted(hwnds: &[isize]) -> SignOutScope {
        SignOutScope {
            job_pids: HashSet::new(),
            adopted_hwnds: hwnds.iter().copied().collect(),
        }
    }

    fn sample_employee() -> Employee {
        Employee {
            id: "emp_maya".into(),
            username: "maya".into(),
            name: "Maya Chen".into(),
            role: Some("Cashier".into()),
            quota_bytes: 1,
        }
    }

    fn signed_in(locked: bool) -> SessionState {
        SessionState::SignedIn {
            employee: sample_employee(),
            locked,
            offline: false,
        }
    }

    struct FakeSignOut {
        calls: Vec<String>,
        agent_fails: bool,
    }

    impl SignOutOps for FakeSignOut {
        fn close(&mut self, hwnd: isize) {
            self.calls.push(format!("close:{hwnd}"));
        }
        fn wait_for_close(&mut self) {
            self.calls.push("wait".into());
        }
        fn terminate_jobs(&mut self) {
            self.calls.push("terminate".into());
        }
        fn clear_memory(&mut self) {
            self.calls.push("clear".into());
        }
        fn agent_sign_out(&mut self) -> Result<(), String> {
            self.calls.push("agent".into());
            if self.agent_fails {
                Err("unsupported".into())
            } else {
                Ok(())
            }
        }
        fn signed_out(&mut self) {
            self.calls.push("signed-out".into());
        }
    }

    #[test]
    fn search_folds_case_and_diacritics() {
        assert!(matches_search("Café Orders", "cafe"));
        assert!(matches_search("Notepad", "NOTE"));
        assert!(matches_search("Zoë", "zoe"));
        assert!(matches_search("My files", ""));
        assert!(matches_search("My files", "  my f"));
        assert!(!matches_search("Notepad", "word"));
    }

    #[test]
    fn sign_out_never_closes_a_foreign_window_and_keeps_order() {
        let windows = vec![
            CloseCandidate {
                hwnd: 1,
                pid: 10,
                shell_app: false,
            },
            CloseCandidate {
                hwnd: 99,
                pid: 20,
                shell_app: false,
            },
            CloseCandidate {
                hwnd: 3,
                pid: 30,
                shell_app: true,
            },
        ];
        let targets = sign_out_targets(&windows, &scope_jobs(&[10]));
        assert_eq!(targets, vec![3, 1]);
        assert!(!targets.contains(&99));

        let mut fake = FakeSignOut {
            calls: Vec::new(),
            agent_fails: true,
        };
        drive_sign_out(&mut fake, &targets);
        assert_eq!(
            fake.calls,
            vec![
                "close:3",
                "close:1",
                "wait",
                "terminate",
                "clear",
                "agent",
                "signed-out",
            ]
        );
    }

    #[test]
    fn closing_names_skip_foreign_windows_and_repeat_names() {
        let windows = vec![
            NamedWindow {
                hwnd: 1,
                pid: 10,
                shell_app: false,
                title: "Untitled - Notepad".into(),
            },
            NamedWindow {
                hwnd: 2,
                pid: 10,
                shell_app: false,
                title: "Notes - Notepad".into(),
            },
            NamedWindow {
                hwnd: 20,
                pid: 20,
                shell_app: false,
                title: "Hand opened".into(),
            },
            NamedWindow {
                hwnd: 30,
                pid: 30,
                shell_app: true,
                title: "Files".into(),
            },
        ];
        let owned = HashMap::from([(10, "notes".into())]);
        let names = HashMap::from([("notes".into(), "Notepad".into())]);
        assert_eq!(
            closing_names(&windows, &scope_jobs(&[10]), &owned, &names),
            vec!["Notepad".to_string(), "Files".to_string()]
        );
    }

    #[test]
    fn sign_out_closes_only_the_adopted_window_of_a_shared_process() {
        // Windows 11 Notepad is one process. The hand-opened window shares
        // its pid with the window the shell's stub handed off to.
        let windows = vec![
            CloseCandidate {
                hwnd: 1,
                pid: 10,
                shell_app: false,
            },
            CloseCandidate {
                hwnd: 2,
                pid: 10,
                shell_app: false,
            },
        ];
        let targets = sign_out_targets(&windows, &scope_adopted(&[2]));
        assert_eq!(targets, vec![2]);
    }

    #[test]
    fn lock_transitions_stay_on_a_signed_in_employee() {
        let open = signed_in(false);
        let locked = lock_transition(&open, LockEvent::Lock).expect("lock");
        assert!(matches!(locked, SessionState::SignedIn { locked: true, .. }));
        let still = lock_transition(&locked, LockEvent::UnlockDenied).expect("denied");
        assert!(matches!(still, SessionState::SignedIn { locked: true, .. }));
        let unlocked = lock_transition(&locked, LockEvent::UnlockOk).expect("ok");
        assert!(matches!(
            unlocked,
            SessionState::SignedIn { locked: false, .. }
        ));
        assert!(lock_transition(
            &SessionState::SignedOut { last: None },
            LockEvent::Lock
        )
        .is_none());
        assert!(lock_transition(&open, LockEvent::UnlockOk).is_none());
        let SessionState::SignedIn { employee, .. } = &locked else {
            panic!("locked");
        };
        assert_eq!(employee, &sample_employee());
    }

    #[test]
    fn dev_mode_lock_does_not_minimize_foreign_windows() {
        let windows = vec![
            MinimizeCandidate {
                hwnd: 1,
                pid: 10,
                shell_app: false,
            },
            MinimizeCandidate {
                hwnd: 2,
                pid: 20,
                shell_app: false,
            },
            MinimizeCandidate {
                hwnd: 3,
                pid: 30,
                shell_app: true,
            },
        ];
        assert_eq!(
            windows_to_minimize(true, &windows, &scope_jobs(&[10])),
            vec![1, 3]
        );
        assert_eq!(
            windows_to_minimize(false, &windows, &scope_jobs(&[10])),
            vec![1, 2, 3]
        );
        assert_eq!(
            windows_to_minimize(true, &windows, &scope_adopted(&[1])),
            vec![1, 3]
        );
    }
}

#[cfg(all(test, debug_assertions))]
mod step10_tests {
    use std::fs;

    use rulebox_staff_lib::model::ThemeDto;
    use rulebox_staff_lib::system::{
        load_theme_at, plain_employee_id, theme_after_sign_out, theme_for_sign_in, write_theme_at,
    };

    fn temp_root(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("rulebox-prefs-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        if let Err(error) = fs::create_dir_all(&root) {
            panic!("temp dir: {error}");
        }
        root
    }

    #[test]
    fn theme_prefs_round_trip_and_a_broken_file_falls_back() {
        let root = temp_root("round");
        if let Err(error) = write_theme_at(&root, "emp_maya", ThemeDto::Dark) {
            panic!("write: {error}");
        }
        assert_eq!(load_theme_at(&root, "emp_maya"), Some(ThemeDto::Dark));

        let broken = root.join("emp_sam");
        if let Err(error) = fs::create_dir_all(&broken) {
            panic!("dir: {error}");
        }
        if let Err(error) = fs::write(broken.join("prefs.json"), "{") {
            panic!("broken: {error}");
        }
        assert_eq!(load_theme_at(&root, "emp_sam"), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_bad_employee_id_is_refused() {
        let root = temp_root("bad");
        assert!(!plain_employee_id("../x"));
        assert!(!plain_employee_id("a/b"));
        assert!(!plain_employee_id(""));
        assert!(!plain_employee_id("a.b"));
        assert!(write_theme_at(&root, "../x", ThemeDto::Dark).is_err());
        assert!(write_theme_at(&root, "a/b", ThemeDto::Light).is_err());
        let entries = match fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(error) => panic!("root: {error}"),
        };
        assert!(entries.count() == 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn sign_in_ignores_the_previous_employees_theme() {
        let org = ThemeDto::Auto;
        assert_eq!(theme_for_sign_in(org, None), ThemeDto::Auto);
        assert_eq!(theme_for_sign_in(org, Some(ThemeDto::Dark)), ThemeDto::Dark);
        assert_eq!(theme_after_sign_out(org), ThemeDto::Auto);
    }
}

#[cfg(all(test, debug_assertions))]
mod step11_tests {
    use rulebox_desktop::placement::Rect;
    use rulebox_staff_lib::appwin::{
        cascade_rect, check_relative, consider_tab, default_logical_size, doc_key, kind_name,
        kind_of, parse_places, restore_if_fits, snap_rect, AppDoc, DocKind, OpenTab, SavedPlace,
        SnapZone, TabAction, MAX_TABS,
    };

    fn doc_files(path: &str) -> AppDoc {
        AppDoc::Files { path: path.into() }
    }

    fn doc_view(path: &str) -> AppDoc {
        AppDoc::View { path: path.into() }
    }

    #[test]
    fn snap_rectangles_for_two_work_areas() {
        let hd = Rect::new(0, 0, 1920, 1040);
        assert_eq!(snap_rect(SnapZone::Left, hd), Some(Rect::new(0, 0, 960, 1040)));
        assert_eq!(snap_rect(SnapZone::Right, hd), Some(Rect::new(960, 0, 1920, 1040)));
        assert_eq!(snap_rect(SnapZone::TopLeft, hd), Some(Rect::new(0, 0, 960, 520)));
        assert_eq!(
            snap_rect(SnapZone::TopRight, hd),
            Some(Rect::new(960, 0, 1920, 520))
        );
        assert_eq!(
            snap_rect(SnapZone::BottomLeft, hd),
            Some(Rect::new(0, 520, 960, 1040))
        );
        assert_eq!(
            snap_rect(SnapZone::BottomRight, hd),
            Some(Rect::new(960, 520, 1920, 1040))
        );
        assert_eq!(snap_rect(SnapZone::Maximize, hd), Some(hd));
        assert_eq!(snap_rect(SnapZone::Restore, hd), None);

        let side = Rect::new(-1920, 40, -640, 760);
        assert_eq!(
            snap_rect(SnapZone::Left, side),
            Some(Rect::new(-1920, 40, -1280, 760))
        );
        assert_eq!(
            snap_rect(SnapZone::Right, side),
            Some(Rect::new(-1280, 40, -640, 760))
        );
        assert_eq!(
            snap_rect(SnapZone::BottomRight, side),
            Some(Rect::new(-1280, 400, -640, 760))
        );
    }

    #[test]
    fn cascade_steps_and_wraps() {
        let area = Rect::new(0, 0, 800, 600);
        let size = (400, 300);
        assert_eq!(cascade_rect(0, size, area, 28), Rect::new(0, 0, 400, 300));
        assert_eq!(cascade_rect(1, size, area, 28), Rect::new(28, 28, 428, 328));
        assert_eq!(cascade_rect(11, size, area, 28), Rect::new(0, 0, 400, 300));
        let wide = Rect::new(10, 20, 30, 40);
        assert_eq!(cascade_rect(3, (500, 500), wide, 28), Rect::new(10, 20, 30, 40));
    }

    #[test]
    fn the_ninth_tab_asks_to_close_one() {
        let mut tabs: Vec<OpenTab> = (0..MAX_TABS)
            .map(|n| OpenTab {
                key: format!("view:n{n}.txt"),
                title: format!("n{n}.txt"),
                kind: "text".into(),
                path: format!("n{n}.txt"),
            })
            .collect();
        assert_eq!(
            consider_tab(&tabs, &doc_view("extra.txt"), MAX_TABS),
            TabAction::AskToClose
        );
        assert!(matches!(
            consider_tab(&tabs, &doc_view("n0.txt"), MAX_TABS),
            TabAction::Select(0)
        ));
        tabs.clear();
        let TabAction::Append(first) = consider_tab(&tabs, &doc_files(""), MAX_TABS) else {
            panic!("the first document is a new tab");
        };
        assert_eq!(first.key, doc_key(&doc_files("")));
        tabs.push(first);
        assert!(matches!(
            consider_tab(&tabs, &doc_files(""), MAX_TABS),
            TabAction::Select(0)
        ));
        assert!(matches!(
            consider_tab(&tabs, &doc_view("notes.txt"), MAX_TABS),
            TabAction::Append(_)
        ));
    }

    #[test]
    fn restore_uses_a_rectangle_that_still_fits() {
        let area = Rect::new(0, 0, 1000, 800);
        let fits = SavedPlace {
            kind: "files".into(),
            x: 10,
            y: 20,
            w: 400,
            h: 300,
            maximized: false,
        };
        assert_eq!(
            restore_if_fits(&fits, area),
            Some(Rect::new(10, 20, 410, 320))
        );
        let outside = SavedPlace {
            x: 900,
            w: 200,
            ..fits.clone()
        };
        assert_eq!(restore_if_fits(&outside, area), None);
        let maximized = SavedPlace {
            maximized: true,
            x: -100,
            ..fits
        };
        assert_eq!(restore_if_fits(&maximized, area), Some(area));
        let empty = SavedPlace {
            kind: "files".into(),
            x: 0,
            y: 0,
            w: 0,
            h: 10,
            maximized: false,
        };
        assert_eq!(restore_if_fits(&empty, area), None);
    }

    #[test]
    fn kinds_sizes_and_relative_paths() {
        assert_eq!(default_logical_size(DocKind::Files), (860, 540));
        assert_eq!(default_logical_size(DocKind::Pdf), (820, 700));
        assert_eq!(default_logical_size(DocKind::Media), (980, 580));
        assert_eq!(kind_name(kind_of(&doc_view("a/b.PNG"))), "image");
        assert_eq!(kind_name(kind_of(&doc_view("song.mp3"))), "media");
        assert_eq!(doc_key(&doc_files("a/b")), "files:a/b");
        assert_eq!(check_relative("").as_deref(), Ok(""));
        assert_eq!(check_relative(r"docs\note.txt").as_deref(), Ok("docs/note.txt"));
        assert!(check_relative("..").is_err());
        assert!(check_relative("a/../b").is_err());
        assert!(check_relative("C:/secret").is_err());
        assert!(check_relative("/etc/passwd").is_err());
        assert!(parse_places("{").is_empty());
    }
}
