//! Build configuration of the agent (Phase 6 Step 5, plan 4.11): what a release build
//! refuses, and `rulebox-agent guard-status`, the read-only report of the machine guard.

use std::io::Write;

use rulebox_win32::guard::{self, Condition, Door, Evaluation};

/// Whether the demo world (`--sim-demo`, fixture employees with the password `demo`) may
/// run. A release build refuses it, even on a PC with the test marker. The unit tests of
/// this crate run the demo world in every profile, so `cfg!(test)` keeps it open there.
pub const fn demo_world_allowed() -> bool {
    demo_allowed_in(!cfg!(any(debug_assertions, test)))
}

/// The rule itself, with the build kind passed in so both answers are tested.
pub const fn demo_allowed_in(release_build: bool) -> bool {
    !release_build
}

/// The refusal text of `run` when the demo world is asked for in a release build.
pub const DEMO_REFUSED: &str = "the demo world (--sim-demo) is not available in a release build";

/// `rulebox-agent guard-status [--json]`: which condition of each door holds, and which
/// failed. Reads the registry and one folder's security descriptor; changes nothing,
/// starts no logging and opens no pipe or data directory. Exit code 0 when the guard is
/// open, 1 when it is not (so a dev machine reports 1).
pub fn run_guard_status(json: bool, out: &mut dyn Write) -> u8 {
    let evaluation = guard::inspect();
    let written = if json { write_json(&evaluation, out) } else { write_text(&evaluation, out) };
    if written.is_err() {
        return 1;
    }
    if evaluation.door.is_some() {
        0
    } else {
        1
    }
}

fn door_name(door: Option<Door>) -> &'static str {
    match door {
        Some(Door::TestMarker) => "open: test-machine marker",
        Some(Door::Production) => "open: production (installed release)",
        None => "closed",
    }
}

fn write_text(evaluation: &Evaluation, out: &mut dyn Write) -> std::io::Result<()> {
    writeln!(out, "Machine guard : {}", door_name(evaluation.door))?;
    writeln!(
        out,
        "Build         : {}, {}",
        if guard::DEBUG_BUILD { "debug" } else { "release" },
        if guard::PRODUCTION_FEATURE { "feature `production` on" } else { "feature `production` off" }
    )?;
    write_door(out, "Test door (the test-machine marker names this computer)", &evaluation.test_door)?;
    write_door(out, "Production door (an installed release, every line must hold)", &evaluation.production_door)?;
    Ok(())
}

fn write_door(out: &mut dyn Write, title: &str, conditions: &[Condition]) -> std::io::Result<()> {
    writeln!(out, "{title}")?;
    for condition in conditions {
        writeln!(out, "  [{}] {:<27} {}", if condition.met { "ok" } else { "FAIL" }, condition.name, condition.detail)?;
    }
    Ok(())
}

fn conditions_json(conditions: &[Condition]) -> Vec<serde_json::Value> {
    conditions
        .iter()
        .map(|c| serde_json::json!({ "name": c.name, "met": c.met, "detail": c.detail }))
        .collect()
}

fn write_json(evaluation: &Evaluation, out: &mut dyn Write) -> std::io::Result<()> {
    let value = serde_json::json!({
        "open": evaluation.door.is_some(),
        "door": match evaluation.door {
            Some(Door::TestMarker) => "testMarker",
            Some(Door::Production) => "production",
            None => "none",
        },
        "debugBuild": guard::DEBUG_BUILD,
        "productionFeature": guard::PRODUCTION_FEATURE,
        "testDoor": conditions_json(&evaluation.test_door),
        "productionDoor": conditions_json(&evaluation.production_door),
    });
    writeln!(out, "{}", serde_json::to_string_pretty(&value).map_err(std::io::Error::other)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_release_build_refuses_the_demo_world_and_a_debug_build_allows_it() {
        assert!(!demo_allowed_in(true));
        assert!(demo_allowed_in(false));
        // The unit tests of this crate always have the demo world open.
        assert!(demo_world_allowed());
    }

    #[test]
    fn guard_status_fails_on_this_machine_and_names_the_failed_conditions() {
        let mut out = Vec::new();
        let code = run_guard_status(false, &mut out);
        let text = String::from_utf8(out).unwrap();
        assert_eq!(code, 1, "{text}");
        assert!(text.contains("Machine guard : closed"), "{text}");
        assert!(text.contains("[FAIL] test_marker"), "{text}");
        assert!(text.contains("[FAIL] production_feature") || text.contains("[FAIL] release_build"), "{text}");
    }

    #[test]
    fn guard_status_json_is_valid_and_closed() {
        let mut out = Vec::new();
        assert_eq!(run_guard_status(true, &mut out), 1);
        let value: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(value["open"], false);
        assert_eq!(value["door"], "none");
        assert_eq!(value["productionDoor"].as_array().unwrap().len(), 6);
    }
}
