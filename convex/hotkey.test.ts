import { describe, expect, test } from "vitest";
import raw from "../crates/rulebox-ipc/tests/vectors/hotkeys.json?raw";
import { DEFAULT_ADMIN_EXIT_HOTKEY, parseHotkey } from "./lib/hotkey";
import { DEFAULT_ORG_SETTINGS } from "./lib/validators";

// The shared vectors also run against `rulebox_ipc::hotkey::parse`
// (crates/rulebox-ipc/tests/hotkey_vectors.rs): both must agree on every one.

const vectors = JSON.parse(raw) as { accept: [string, string][]; reject: [string, string][] };

describe("admin-exit hotkey grammar = rulebox_ipc::hotkey::parse", () => {
  test("vector file is not empty", () => {
    expect(vectors.accept.length).toBeGreaterThanOrEqual(10);
    expect(vectors.reject.length).toBeGreaterThanOrEqual(10);
  });

  test.each(vectors.accept)("accepts %j as %s", (input, canonical) => {
    expect(parseHotkey(input)).toEqual({ ok: true, canonical });
    expect(parseHotkey(canonical)).toEqual({ ok: true, canonical });
  });

  test.each(vectors.reject)("refuses %j (%s)", (input, reason) => {
    expect(parseHotkey(input)).toEqual({ ok: false, reason });
  });

  test("the default combination is canonical", () => {
    expect(DEFAULT_ORG_SETTINGS.adminExit.hotkey).toBe(DEFAULT_ADMIN_EXIT_HOTKEY);
    expect(parseHotkey(DEFAULT_ADMIN_EXIT_HOTKEY)).toEqual({ ok: true, canonical: DEFAULT_ADMIN_EXIT_HOTKEY });
  });
});
