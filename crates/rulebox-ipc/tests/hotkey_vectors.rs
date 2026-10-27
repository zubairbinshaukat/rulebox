//! The shared admin-exit key-combination vectors (`tests/vectors/hotkeys.json`).
//! The same file runs against the server's port in `convex/lib/hotkey.ts`
//! (`convex/hotkey.test.ts`), so the dashboard can never accept a combination
//! the agent refuses, or the reverse (plan Phase 4, Section 4.10).

use rulebox_ipc::hotkey::parse;
use serde_json::Value;

const VECTORS: &str = include_str!("vectors/hotkeys.json");

fn pairs(doc: &Value, name: &str) -> Vec<(String, String)> {
    doc[name]
        .as_array()
        .unwrap_or_else(|| panic!("{name} is not an array"))
        .iter()
        .map(|pair| {
            let input = pair[0].as_str().expect("input is a string").to_string();
            let expected = pair[1].as_str().expect("expected value is a string").to_string();
            (input, expected)
        })
        .collect()
}

#[test]
fn the_crate_agrees_with_every_shared_hotkey_vector() {
    let doc: Value = serde_json::from_str(VECTORS).expect("hotkeys.json parses");

    let accept = pairs(&doc, "accept");
    assert!(accept.len() >= 10, "too few accepted vectors");
    for (input, canonical) in accept {
        let parsed = parse(&input).unwrap_or_else(|e| panic!("{input:?} should parse, got {e:?}"));
        assert_eq!(parsed.canonical(), canonical, "canonical form of {input:?}");
        // The canonical form parses to the same combination.
        assert_eq!(parse(&canonical).ok(), Some(parsed), "round trip of {input:?}");
    }

    let reject = pairs(&doc, "reject");
    assert!(reject.len() >= 10, "too few refused vectors");
    for (input, variant) in reject {
        let err = parse(&input).expect_err(&format!("{input:?} should be refused"));
        let debug = format!("{err:?}");
        let name = debug.split('(').next().unwrap_or_default();
        assert_eq!(name, variant, "error for {input:?}");
    }
}
