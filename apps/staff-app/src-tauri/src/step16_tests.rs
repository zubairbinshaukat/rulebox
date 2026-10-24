//! Step 16 tests: shortcuts, the administrator exit and task recency. The
//! Win32 pieces (hotkeys, the Windows-key state machine, thumbnail geometry)
//! are tested in `rulebox-desktop`.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;

use rulebox_desktop::hotkeys::{Combo, HotkeyId};
use rulebox_desktop::tracker::WindowEvent;
use rulebox_desktop::windows::WindowInfo;
use rulebox_ipc::hotkey::{self, HotkeyError, DEFAULT_ADMIN_EXIT_HOTKEY};
use rulebox_ipc::types::AdminExitInfo;
use rulebox_staff_lib::agent::AgentError;
use rulebox_staff_lib::exit::{answer, pin_is_well_formed, view_of, ExitAnswer};
use rulebox_staff_lib::model::{AdminExitOutcome, AgentLinkDto, ThemeDto};
use rulebox_staff_lib::shortcuts::{combo_from, exit_hotkey, ExitHotkey};
use rulebox_staff_lib::tasks::{Labels, TaskTable};

// ---------------------------------------------------------------------------
// The exit combination.
// ---------------------------------------------------------------------------

#[test]
fn the_default_combination_parses_and_maps_to_win32() {
    let parsed = hotkey::parse(DEFAULT_ADMIN_EXIT_HOTKEY).unwrap();
    assert_eq!(DEFAULT_ADMIN_EXIT_HOTKEY, "Ctrl+Shift+F12");
    let combo = combo_from(&parsed);
    assert!(combo.modifiers.ctrl && combo.modifiers.shift && !combo.modifiers.alt);
    assert_eq!(combo.vk, 0x7B, "F12");
}

#[test]
fn valid_combinations_map_letters_digits_and_function_keys() {
    let letter = combo_from(&hotkey::parse("Ctrl+Alt+x").unwrap());
    assert_eq!(letter.vk, u32::from(b'X'));
    assert!(letter.modifiers.ctrl && letter.modifiers.alt && !letter.modifiers.shift);
    let digit = combo_from(&hotkey::parse("Alt+7").unwrap());
    assert_eq!(digit.vk, u32::from(b'7'));
    let function = combo_from(&hotkey::parse(" ctrl + F1 ").unwrap());
    assert_eq!(function.vk, 0x70);
}

#[test]
fn reserved_and_malformed_combinations_are_rejected() {
    // Without Ctrl or Alt.
    assert_eq!(hotkey::parse("Shift+F12"), Err(HotkeyError::NeedsCtrlOrAlt));
    assert_eq!(hotkey::parse("F12"), Err(HotkeyError::NeedsCtrlOrAlt));
    // The system's own combinations cannot even be written.
    assert!(hotkey::parse("Alt+Tab").is_err());
    assert!(hotkey::parse("Ctrl+Esc").is_err());
    assert!(hotkey::parse("Ctrl+Alt+Del").is_err());
    assert!(hotkey::parse("Ctrl+Alt+Delete").is_err());
    // Garbage.
    assert_eq!(hotkey::parse(""), Err(HotkeyError::Empty));
    assert_eq!(hotkey::parse("   "), Err(HotkeyError::Empty));
    assert!(hotkey::parse("Ctrl+").is_err());
    assert!(hotkey::parse("Ctrl+Shift").is_err());
    assert!(hotkey::parse("Ctrl+A+B").is_err());
    assert!(hotkey::parse("Ctrl+Ctrl+A").is_err());
    assert!(hotkey::parse("Ctrl+F13").is_err());
    assert!(hotkey::parse("banana").is_err());
    assert!(hotkey::parse("Ctrl+Alt+Shift+Win+A").is_err());
}

#[test]
fn the_three_shortcuts_are_the_documented_ones() {
    let (alt_tab, ctrl_esc) = (std::hint::black_box(Combo::ALT_TAB), std::hint::black_box(Combo::CTRL_ESC));
    assert_eq!(alt_tab.vk, 0x09);
    assert!(alt_tab.modifiers.alt && !alt_tab.modifiers.ctrl);
    assert_eq!(ctrl_esc.vk, 0x1B);
    assert!(ctrl_esc.modifiers.ctrl && !ctrl_esc.modifiers.alt);
    assert_ne!(HotkeyId::SWITCHER, HotkeyId::START);
    assert_ne!(HotkeyId::START, HotkeyId::ADMIN_EXIT);
}

#[test]
fn which_combination_the_exit_uses() {
    let default = ExitHotkey::On {
        text: DEFAULT_ADMIN_EXIT_HOTKEY.into(),
    };
    // Before any snapshot: the default is registered (the hotkey exists before the agent link).
    assert_eq!(exit_hotkey(None), default);
    // From the agent.
    let custom = AdminExitInfo {
        enabled: true,
        hotkey: "Ctrl+Alt+F9".into(),
    };
    assert_eq!(exit_hotkey(Some(&custom)), ExitHotkey::On { text: "Ctrl+Alt+F9".into() });
    // Turned off by the organization: the combination does nothing at all.
    let off = AdminExitInfo {
        enabled: false,
        hotkey: "Ctrl+Alt+F9".into(),
    };
    assert_eq!(exit_hotkey(Some(&off)), ExitHotkey::Off);
    // Unparseable: the default, not nothing.
    for bad in ["", "banana", "Alt+Tab", "Shift+F12"] {
        let broken = AdminExitInfo {
            enabled: true,
            hotkey: bad.into(),
        };
        assert_eq!(exit_hotkey(Some(&broken)), default, "{bad:?}");
    }
}

// ---------------------------------------------------------------------------
// The dialog's states (Section 7.11).
// ---------------------------------------------------------------------------

#[test]
fn the_agent_answers_become_the_dialog_states() {
    assert_eq!(answer(Ok(AdminExitOutcome::SigningOut)), ExitAnswer::SigningOut);
    assert_eq!(
        answer(Ok(AdminExitOutcome::WrongPin { attempts_left: Some(3) })),
        ExitAnswer::WrongPin { attempts_left: Some(3) }
    );
    assert_eq!(
        answer(Ok(AdminExitOutcome::WrongPin { attempts_left: None })),
        ExitAnswer::WrongPin { attempts_left: None }
    );
    assert_eq!(
        answer(Ok(AdminExitOutcome::LockedOut { retry_after_ms: 272_000 })),
        ExitAnswer::LockedOut { retry_after_ms: 272_000 }
    );
    assert_eq!(answer(Ok(AdminExitOutcome::Disabled)), ExitAnswer::Disabled);
    // No answer at all: "can't check right now".
    assert_eq!(answer(Err(AgentError::NotLinked)), ExitAnswer::Unavailable);
    assert_eq!(answer(Err(AgentError::Timeout)), ExitAnswer::Unavailable);
    assert_eq!(answer(Err(AgentError::Unsupported)), ExitAnswer::Unavailable);
    assert_eq!(answer(Err(AgentError::VersionMismatch)), ExitAnswer::Unavailable);
    assert_eq!(answer(Ok(AdminExitOutcome::Unknown)), ExitAnswer::Unavailable);
}

#[test]
fn a_pin_is_four_to_twelve_digits() {
    for good in ["1234", "2468", "123456789012", "0000"] {
        assert!(pin_is_well_formed(good), "{good}");
    }
    for bad in ["", "123", "1234567890123", "12a4", "12 34", "１２３４", "-1234", "12.34", "abcd"] {
        assert!(!pin_is_well_formed(bad), "{bad:?}");
    }
}

#[test]
fn the_dialog_view_for_every_row_of_the_table() {
    let caps = |names: &[&str]| names.iter().map(|n| (*n).to_string()).collect::<Vec<_>>();
    let with_exit = caps(&["state", "adminExit"]);
    let without = caps(&["state", "apps"]);

    // Ready: linked, supported, enabled.
    let ready = view_of(AgentLinkDto::Linked, &with_exit, Some(true), false, ThemeDto::Light);
    assert!(ready.supported && ready.enabled);
    assert_eq!(ready.link, AgentLinkDto::Linked);

    // Agent not linked: supported is unknown, so it is not reported as missing.
    for link in [AgentLinkDto::Disconnected, AgentLinkDto::Connecting, AgentLinkDto::VersionMismatch] {
        let waiting = view_of(link, &[], None, false, ThemeDto::Auto);
        assert!(waiting.supported, "{link:?}: unknown abilities are not 'unsupported'");
        assert!(waiting.enabled, "{link:?}: the default stands before a snapshot");
        assert_eq!(waiting.link, link);
    }

    // Linked, but the agent has no adminExit capability.
    let unsupported = view_of(AgentLinkDto::Linked, &without, Some(true), false, ThemeDto::Dark);
    assert!(!unsupported.supported);

    // Disabled by the organization.
    let off = view_of(AgentLinkDto::Linked, &with_exit, Some(false), false, ThemeDto::Light);
    assert!(!off.enabled);

    // Agent not linked -> linked: the same dialog, a new view (the field re-enables).
    let before = view_of(AgentLinkDto::Disconnected, &[], None, true, ThemeDto::Dark);
    let after = view_of(AgentLinkDto::Linked, &with_exit, Some(true), true, ThemeDto::Dark);
    assert_ne!(before, after);
    assert!(after.lite && after.theme == ThemeDto::Dark);
}

#[test]
fn the_exit_can_open_in_every_session_state() {
    use rulebox_staff_lib::exit::opens_in;
    use rulebox_staff_lib::model::{Employee, SessionState};
    let employee = Employee {
        id: "e".into(),
        username: "maya".into(),
        name: "Maya".into(),
        role: None,
        quota_bytes: 0,
    };
    for session in [
        SessionState::SignedOut { last: None },
        SessionState::SigningIn,
        SessionState::SignedIn {
            employee: employee.clone(),
            locked: false,
            offline: false,
        },
        SessionState::SignedIn {
            employee,
            locked: true,
            offline: true,
        },
        SessionState::SigningOut,
    ] {
        assert!(opens_in(&session), "{session:?}");
    }
}

// ---------------------------------------------------------------------------
// Task recency (the app switcher's order).
// ---------------------------------------------------------------------------

fn info(hwnd: isize, title: &str) -> WindowInfo {
    WindowInfo {
        hwnd,
        pid: 10,
        title: title.into(),
        exe: Some(PathBuf::from(r"C:\x.exe")),
        aumid: None,
        minimized: false,
        cloaked: false,
        class: "Test".into(),
    }
}

#[test]
fn recency_grows_as_windows_are_activated() {
    let mut table = TaskTable::default();
    let none = Labels::new();
    for (h, t) in [(1, "one"), (2, "two"), (3, "three")] {
        table.apply(&WindowEvent::Added(info(h, t)), &none);
    }
    let recency = |table: &TaskTable| -> Vec<(String, u32)> {
        table.items(&none, &[], &std::collections::HashMap::new()).into_iter().map(|i| (i.id, i.recency)).collect()
    };
    // Nothing activated yet: no recency.
    assert!(recency(&table).iter().all(|(_, r)| *r == 0));

    table.apply(&WindowEvent::Activated(Some(2)), &none);
    table.apply(&WindowEvent::Activated(Some(3)), &none);
    table.apply(&WindowEvent::Activated(Some(1)), &none);
    let now = recency(&table);
    let of = |id: &str| now.iter().find(|(i, _)| i == id).unwrap().1;
    assert!(of("1") > of("3") && of("3") > of("2") && of("2") > 0, "{now:?}");

    // Activating the same window again does not reshuffle.
    let before = of("1");
    table.apply(&WindowEvent::Activated(Some(1)), &none);
    assert_eq!(recency(&table).iter().find(|(i, _)| i == "1").unwrap().1, before);

    // A closed window is forgotten.
    table.apply(&WindowEvent::Removed(3), &none);
    assert_eq!(recency(&table).len(), 2);
    // A window that comes back with the same handle starts over.
    table.apply(&WindowEvent::Added(info(3, "three again")), &none);
    assert_eq!(recency(&table).iter().find(|(i, _)| i == "3").unwrap().1, 0);
}

#[test]
fn the_windows_key_opens_start_only_on_an_unlocked_desktop() {
    use rulebox_staff_lib::model::{Employee, SessionState};
    use rulebox_staff_lib::shortcuts::start_allowed;
    let employee = Employee {
        id: "emp_maya".into(),
        username: "maya".into(),
        name: "Maya Chen".into(),
        role: None,
        quota_bytes: 1,
    };
    let signed_in = |locked| SessionState::SignedIn { employee: employee.clone(), locked, offline: false };
    assert!(start_allowed(&signed_in(false)));
    assert!(!start_allowed(&signed_in(true)), "the lock screen has no Start");
    assert!(!start_allowed(&SessionState::SignedOut { last: None }), "nor the sign-in screen");
    assert!(!start_allowed(&SessionState::SigningIn));
    assert!(!start_allowed(&SessionState::SigningOut));
}

mod resource_monitor {
    use std::collections::HashMap;
    use std::time::Duration;

    use rulebox_desktop::procstats::ProcInfo;
    use rulebox_staff_lib::monitor::{build_groups, process_cpu, GroupKind, Roots};

    fn proc(pid: u32, parent: u32, exe: &str, mb: u64) -> ProcInfo {
        ProcInfo { pid, parent, exe: exe.into(), private_ws: Some(mb << 20), cpu_100ns: Some(0) }
    }

    #[test]
    fn processes_are_grouped_by_the_tree_they_belong_to() {
        let processes = vec![
            proc(10, 1, "rulebox-staff.exe", 40),
            proc(11, 10, "msedgewebview2.exe", 100),
            proc(12, 11, "msedgewebview2.exe", 60),
            proc(20, 10, "msedgewebview2.exe", 80), // a web app's browser
            proc(21, 20, "msedgewebview2.exe", 30),
            proc(30, 2, "notepad.exe", 25), // launched by the shell
            proc(40, 3, "rulebox-agent.exe", 15),
            proc(41, 3, "rulebox-shell.exe", 5),
            proc(50, 4, "explorer.exe", 90),
            proc(51, 4, "code.exe", 70),
            proc(52, 4, "code.exe", 30),
        ];
        let mut roots: Roots = HashMap::new();
        roots.insert(10, (GroupKind::Shell, "Shell".into()));
        roots.insert(20, (GroupKind::WebApp, "Orders".into()));
        roots.insert(30, (GroupKind::App, "Notepad".into()));
        let cpu: HashMap<u32, f32> = [(11, 2.0), (12, 1.0), (21, 4.0)].into_iter().collect();

        let groups = build_groups(&processes, &cpu, &roots);
        let find = |name: &str| groups.iter().find(|g| g.name == name).unwrap_or_else(|| panic!("{name} in {groups:?}"));
        assert_eq!(groups[0].kind, GroupKind::Shell, "Rulebox's shell comes first");
        // The web app's browser is a child of the shell but its own root wins.
        assert_eq!(find("Shell").bytes, 200 << 20);
        assert_eq!(find("Shell").processes, 3);
        assert_eq!(find("Orders").bytes, 110 << 20);
        assert!((find("Orders").cpu_percent - 4.0).abs() < 0.01);
        assert_eq!(find("Notepad").kind, GroupKind::App);
        assert_eq!(find("Rulebox agent").kind, GroupKind::Agent);
        assert_eq!(find("Rulebox shell launcher").kind, GroupKind::Launcher);
        // Other programs are one row per program.
        assert_eq!(find("code.exe").processes, 2);
        assert_eq!(find("code.exe").bytes, 100 << 20);
        assert_eq!(find("Shell").unreadable, 0);
    }

    #[test]
    fn processes_without_figures_are_counted_as_unreadable() {
        let mut agent = proc(40, 3, "rulebox-agent.exe", 0);
        agent.private_ws = None;
        let groups = build_groups(&[agent], &HashMap::new(), &HashMap::new());
        assert_eq!(groups[0].bytes, 0);
        assert_eq!(groups[0].unreadable, 1, "a SYSTEM process is shown as not readable, not as 0 MB");
    }

    #[test]
    fn a_process_cpu_share_is_of_the_whole_machine() {
        // One second of CPU in one wall second on 4 cores: 25 %.
        assert!((process_cpu(0, 10_000_000, Duration::from_secs(1), 4) - 25.0).abs() < 0.01);
        assert_eq!(process_cpu(5, 5, Duration::from_secs(2), 8), 0.0);
        assert_eq!(process_cpu(0, 1, Duration::ZERO, 8), 0.0);
    }
}
