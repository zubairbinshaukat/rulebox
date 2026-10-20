import { describe, expect, it } from "vitest";
import type { AdminExitView } from "@rulebox/types";

import { matches, parseCombination } from "../lib/exitKey";
import { toPhysical } from "../shell/popup/thumbRect";
import { initialIndex, moveIndex, switcherKey, switcherOrder } from "../shell/popup/switcherLogic";
import { afterAnswer, filterPin, formatCountdown, MESSAGES, pinReady, present, type Phase } from "./logic";

const linkedView: AdminExitView = { link: "linked", supported: true, enabled: true, lite: false, theme: "light" };
const key = (over: object) => ({ key: "", ctrlKey: false, altKey: false, shiftKey: false, ...over });

describe("PIN input", () => {
  it("keeps digits only, at most 12", () => {
    expect(filterPin("12a3 4-5")).toBe("12345");
    expect(filterPin("１２３４")).toBe("");
    expect(filterPin("1234567890123456")).toBe("123456789012");
    expect(filterPin("")).toBe("");
  });

  it("needs 4 to 12 digits to submit", () => {
    expect(pinReady("123")).toBe(false);
    expect(pinReady("1234")).toBe(true);
    expect(pinReady("123456789012")).toBe(true);
    expect(pinReady("1234567890123")).toBe(false);
    expect(pinReady("12a4")).toBe(false);
  });

  it("shows the countdown as M:SS, rounding up", () => {
    expect(formatCountdown(272_000)).toBe("4:32");
    expect(formatCountdown(59_001)).toBe("1:00");
    expect(formatCountdown(500)).toBe("0:01");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5)).toBe("0:00");
  });
});

describe("the dialog states (Section 7.11)", () => {
  const now = 1_000_000;
  const ready: Phase = { kind: "ready" };

  it("ready: an enabled field and a submit once the PIN is long enough", () => {
    const p = present(linkedView, ready, "2468", now, null);
    expect(p).toMatchObject({ fieldDisabled: false, canSubmit: true, message: null, closes: false });
    expect(present(linkedView, ready, "24", now, null).canSubmit).toBe(false);
  });

  it("checking: the field is disabled", () => {
    const p = present(linkedView, { kind: "checking" }, "", now, null);
    expect(p.fieldDisabled).toBe(true);
    expect(p.message).toBe(MESSAGES.checking);
  });

  it("wrong PIN: says so, with the attempts left when the agent gives them", () => {
    expect(present(linkedView, { kind: "wrong", attemptsLeft: null }, "", now, null).message).toBe("That PIN is not right.");
    expect(present(linkedView, { kind: "wrong", attemptsLeft: 3 }, "", now, null).message).toBe("That PIN is not right. 3 tries left.");
    expect(present(linkedView, { kind: "wrong", attemptsLeft: 1 }, "", now, null).message).toBe("That PIN is not right. 1 try left.");
    expect(present(linkedView, { kind: "wrong", attemptsLeft: 3 }, "", now, null).fieldDisabled).toBe(false);
  });

  it("locked out: a countdown, the field disabled until zero", () => {
    const locked: Phase = { kind: "locked", until: now + 272_000 };
    const p = present(linkedView, locked, "", now, null);
    expect(p.fieldDisabled).toBe(true);
    expect(p.message).toBe("Too many tries. Try again in 4:32.");
    expect(present(linkedView, locked, "", now + 100_000, null).message).toBe("Too many tries. Try again in 2:52.");
    expect(present(linkedView, locked, "", now + 272_000, null)).toMatchObject({ fieldDisabled: false, message: null });
  });

  it("signing out: waits", () => {
    const p = present(linkedView, { kind: "signingOut" }, "", now, null);
    expect(p.fieldDisabled).toBe(true);
    expect(p.message).toBe("Signing out to Windows…");
  });

  it("agent not linked: disabled, waiting; after 30 seconds the recovery line is added", () => {
    for (const link of ["disconnected", "connecting", "versionMismatch"] as const) {
      const view = { ...linkedView, link };
      expect(present(view, ready, "2468", now, now)).toMatchObject({ fieldDisabled: true, canSubmit: false, message: MESSAGES.waiting, recovery: false });
      expect(present(view, ready, "", now + 29_999, now).recovery).toBe(false);
      expect(present(view, ready, "", now + 30_000, now).recovery).toBe(true);
    }
  });

  it("agent not linked -> linked: the field comes back by itself", () => {
    const down = present({ ...linkedView, link: "disconnected" }, ready, "", now, now);
    const back = present(linkedView, ready, "", now + 5_000, null);
    expect(down.fieldDisabled).toBe(true);
    expect(back.fieldDisabled).toBe(false);
  });

  it("a call that timed out re-enables after a few seconds, without keeping the PIN", () => {
    const failed: Phase = { kind: "unavailable", since: now };
    expect(present(linkedView, failed, "", now + 1_000, null).fieldDisabled).toBe(true);
    expect(present(linkedView, failed, "", now + 5_000, null).fieldDisabled).toBe(false);
  });

  it("no adminExit capability: not available, with the recovery line", () => {
    const p = present({ ...linkedView, supported: false }, ready, "2468", now, null);
    expect(p).toMatchObject({ fieldDisabled: true, canSubmit: false, message: MESSAGES.unsupported, recovery: true });
  });

  it("disabled by the organization: the dialog closes itself", () => {
    expect(present({ ...linkedView, enabled: false }, ready, "", now, null).closes).toBe(true);
  });

  it("maps every answer of the agent", () => {
    expect(afterAnswer({ status: "signingOut" }, now)).toEqual({ kind: "signingOut" });
    expect(afterAnswer({ status: "wrongPin", attemptsLeft: 2 }, now)).toEqual({ kind: "wrong", attemptsLeft: 2 });
    expect(afterAnswer({ status: "lockedOut", retryAfterMs: 60_000 }, now)).toEqual({ kind: "locked", until: now + 60_000 });
    expect(afterAnswer({ status: "disabled" }, now)).toBe("close");
    expect(afterAnswer({ status: "unavailable" }, now)).toEqual({ kind: "unavailable", since: now });
  });
});

describe("the key listener", () => {
  it("parses the same combinations as the agent", () => {
    expect(parseCombination("Ctrl+Shift+F12")).toEqual({ ctrl: true, alt: false, shift: true, key: "f12" });
    expect(parseCombination(" alt + 7 ")).toEqual({ ctrl: false, alt: true, shift: false, key: "7" });
    for (const bad of ["", "Shift+F12", "Alt+Tab", "Ctrl+Esc", "Ctrl+Alt+Del", "Ctrl+A+B", "Ctrl+Ctrl+A", "Ctrl+F13", "banana", "Ctrl+"]) {
      expect(parseCombination(bad), bad).toBeNull();
    }
  });

  it("matches the exact combination only", () => {
    const combo = parseCombination("Ctrl+Shift+F12");
    expect(combo).not.toBeNull();
    if (!combo) return;
    expect(matches(combo, key({ key: "F12", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matches(combo, key({ key: "F12", ctrlKey: true }))).toBe(false);
    expect(matches(combo, key({ key: "F12", ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(matches(combo, key({ key: "F11", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(matches(combo, key({ key: "F12", ctrlKey: true, shiftKey: true, metaKey: true }))).toBe(false);
    const letter = parseCombination("Ctrl+Alt+x");
    if (!letter) return;
    expect(matches(letter, key({ key: "x", ctrlKey: true, altKey: true }))).toBe(true);
    expect(matches(letter, key({ key: "≈", code: "KeyX", ctrlKey: true, altKey: true }))).toBe(true);
  });
});

describe("the app switcher", () => {
  const task = (id: string, recency: number, active = false) => ({
    id,
    appId: null,
    title: id,
    iconKey: "k",
    active,
    minimized: false,
    flashing: false,
    hung: false,
    own: false,
    recency,
  });

  it("lists the most recently used first; the active window leads", () => {
    const order = switcherOrder([task("a", 1), task("b", 5), task("c", 3), task("d", 0, true)]);
    expect(order.map((t) => t.id)).toEqual(["d", "b", "c", "a"]);
  });

  it("keeps the taskbar order for windows that were never active", () => {
    expect(switcherOrder([task("x", 0), task("y", 0), task("z", 0)]).map((t) => t.id)).toEqual(["x", "y", "z"]);
  });

  it("starts on the window used before this one and wraps around", () => {
    expect(initialIndex(0)).toBe(0);
    expect(initialIndex(1)).toBe(0);
    expect(initialIndex(4)).toBe(1);
    expect(moveIndex(3, 4, 1)).toBe(0);
    expect(moveIndex(0, 4, -1)).toBe(3);
    expect(moveIndex(0, 0, 1)).toBe(0);
  });

  it("handles keys: Tab moves, Alt release or Enter activates, Escape cancels", () => {
    expect(switcherKey({ key: "Tab", shiftKey: false, phase: "down" })).toEqual({ type: "move", delta: 1 });
    expect(switcherKey({ key: "Tab", shiftKey: true, phase: "down" })).toEqual({ type: "move", delta: -1 });
    expect(switcherKey({ key: "ArrowLeft", shiftKey: false, phase: "down" })).toEqual({ type: "move", delta: -1 });
    expect(switcherKey({ key: "ArrowRight", shiftKey: false, phase: "down" })).toEqual({ type: "move", delta: 1 });
    expect(switcherKey({ key: "Alt", shiftKey: false, phase: "up" })).toEqual({ type: "activate" });
    expect(switcherKey({ key: "Enter", shiftKey: false, phase: "down" })).toEqual({ type: "activate" });
    expect(switcherKey({ key: "Escape", shiftKey: false, phase: "down" })).toEqual({ type: "cancel" });
    expect(switcherKey({ key: "Tab", shiftKey: false, phase: "up" })).toBeNull();
    expect(switcherKey({ key: "a", shiftKey: false, phase: "down" })).toBeNull();
  });
});

describe("thumbnail rectangles", () => {
  it("scale from CSS to physical pixels (125%)", () => {
    expect(toPhysical({ x: 12, y: 44, width: 248, height: 140 }, 1.25)).toEqual({ x: 15, y: 55, width: 310, height: 175 });
    expect(toPhysical({ x: 10.4, y: 10.4, width: 100, height: 50 }, 1)).toEqual({ x: 10, y: 10, width: 100, height: 50 });
    expect(toPhysical({ x: 1, y: 1, width: 1, height: 1 }, 0)).toEqual({ x: 1, y: 1, width: 1, height: 1 });
  });
});
