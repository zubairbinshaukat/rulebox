import { describe, expect, it } from "vitest";
import { DEFAULT_LOCKDOWN_SETTINGS, type LockdownSettings } from "../../data/types";
import { PRESET_FIELDS, PRESET_IDS, PRESETS, applyPreset, fieldChanged, presetOf, setAt, valueAt, type PresetId } from "./presets";
import { changeLabels, lockoutDraftOf, lockoutProblems, programModeOf, setProgramMode } from "./rules";
import { lockdownStrings as s } from "./strings";

const D = DEFAULT_LOCKDOWN_SETTINGS;
const standard = () => applyPreset(D, "standard");

describe("presets: the three levels", () => {
  it("sets exactly 28 fields", () => {
    expect(PRESET_FIELDS).toHaveLength(28);
    for (const id of PRESET_IDS) expect(Object.keys(PRESETS[id]).sort()).toEqual([...PRESET_FIELDS].sort());
  });

  it("Standard equals the defaults on every preset field, so a group that kept the defaults reads Standard", () => {
    for (const f of PRESET_FIELDS) expect(valueAt(D, f), f).toEqual(PRESETS.standard[f]);
    expect(presetOf(D)).toEqual({ id: "standard", nearest: "standard", changes: [] });
  });

  it("the values of the plan (section 3): Basic leaves lockout and recovery to the PC, Strict blocks USB drives and phones", () => {
    const basic = PRESETS.basic;
    expect(basic["machine.accountLockout"]).toBeNull();
    expect(basic["boot.autoRecovery"]).toBe("leave");
    expect(basic["accessibilityTools"]).toBe(true);
    for (const f of ["staff.settings", "staff.signOut", "staff.changePassword", "staff.hideDrives", "machine.hideSwitchUser", "machine.hideSignInPower", "machine.fileOutputPrinters"] as const) {
      expect(basic[f], f).toBe(false);
    }
    const strict = PRESETS.strict;
    expect(strict["machine.accountLockout"]).toEqual({ threshold: 5, durationMin: 30, windowMin: 30 });
    expect(strict["usb.storage"]).toBe("block");
    expect(strict["usb.phones"]).toBe("block");
    expect(strict["usb.retroactive"]).toBe(true);
    // Printers, scanners and other devices stay allowed on every level; the safety list is the recommended one.
    for (const id of PRESET_IDS) {
      expect(PRESETS[id]["usb.printers"]).toBe("allow");
      expect(PRESETS[id]["usb.imaging"]).toBe("allow");
      expect(PRESETS[id]["usb.other"]).toBe("allow");
      expect(PRESETS[id]["appControl.level"]).toBe("recommendedBlocks");
      expect(PRESETS[id]["keyboard.winCombos"]).toBe("swallow");
      expect(PRESETS[id]["boot.safeModeGuard"]).toBe(true);
    }
  });

  it("every preset round-trips through presetOf", () => {
    for (const id of PRESET_IDS) expect(presetOf(applyPreset(D, id))).toEqual({ id, nearest: id, changes: [] });
  });

  it("the Strict lockout passes the same checks as the inputs (threshold 5, window not longer than the lock)", () => {
    const l = applyPreset(D, "strict").machine.accountLockout;
    expect(l).not.toBeNull();
    expect(lockoutProblems(lockoutDraftOf(applyPreset(D, "strict")))).toEqual({ threshold: false, duration: false, window: false });
    expect(l!.windowMin).toBeLessThanOrEqual(l!.durationMin);
    expect(lockoutProblems(lockoutDraftOf(applyPreset(D, "basic")))).toEqual({ threshold: false, duration: false, window: false });
  });

  it("applying a preset does not share objects with the preset table", () => {
    const a = applyPreset(D, "standard");
    a.machine.accountLockout!.threshold = 99;
    expect(PRESETS.standard["machine.accountLockout"]).toEqual({ threshold: 10, durationMin: 15, windowMin: 15 });
  });
});

describe("presets: fields outside the levels are never touched", () => {
  const other: LockdownSettings = {
    ...D,
    machine: { ...D.machine, hideAdminTiles: !D.machine.hideAdminTiles },
    appLocker: { mode: "enforce" },
    appControl: { mode: "off", level: "recommendedBlocks" },
    procWatch: { mode: "audit" },
    performance: { staffTuning: false, kioskProfile: false, noPrinting: true },
    wifiManagedOnly: true,
    wifiManagedOnlyConfirmed: true,
  };

  it("modes, hideAdminTiles, speed and Wi-Fi do not change the level", () => {
    expect(presetOf(other)).toEqual({ id: "standard", nearest: "standard", changes: [] });
    for (const id of PRESET_IDS) expect(presetOf(applyPreset(other, id)).id).toBe(id);
  });

  it("applyPreset keeps them", () => {
    for (const id of PRESET_IDS) {
      const out = applyPreset(other, id);
      expect(out.machine.hideAdminTiles).toBe(other.machine.hideAdminTiles);
      expect(out.appLocker).toEqual(other.appLocker);
      expect(out.appControl.mode).toBe("off");
      expect(out.procWatch).toEqual(other.procWatch);
      expect(out.performance).toEqual(other.performance);
      expect(out.wifiManagedOnly).toBe(true);
      expect(out.wifiManagedOnlyConfirmed).toBe(true);
    }
  });

  it("applyPreset does not change its input", () => {
    const before = JSON.stringify(D);
    applyPreset(D, "strict");
    expect(JSON.stringify(D)).toBe(before);
  });
});

describe("presets: Custom", () => {
  it("one changed field is Custom with the nearest level and that one change", () => {
    const custom = setAt(standard(), "usb.storage", "readOnly");
    expect(presetOf(custom)).toEqual({ id: "custom", nearest: "standard", changes: ["usb.storage"] });
    expect(fieldChanged(custom, "standard", "usb.storage")).toBe(true);
    expect(fieldChanged(custom, "standard", "usb.phones")).toBe(false);
    expect(fieldChanged(custom, "standard", "wifiManagedOnly")).toBe(false); // not a preset field
  });

  it("the nearest level is the one with the fewest differences", () => {
    const nearStrict = setAt(setAt(applyPreset(D, "strict"), "usb.retroactive", false), "staff.run", false);
    expect(presetOf(nearStrict)).toMatchObject({ id: "custom", nearest: "strict", changes: ["staff.run", "usb.retroactive"] });
    const nearBasic = setAt(applyPreset(D, "basic"), "staff.settings", true);
    expect(presetOf(nearBasic)).toMatchObject({ id: "custom", nearest: "basic", changes: ["staff.settings"] });
  });

  it("a tie prefers Standard", () => {
    // Differs from Standard and from Basic by the same number of fields: Standard wins.
    const base = applyPreset(D, "standard");
    const basicFields = PRESET_FIELDS.filter((f) => JSON.stringify(PRESETS.basic[f]) !== JSON.stringify(PRESETS.standard[f]));
    const half = basicFields.slice(0, basicFields.length / 2);
    let tie = base;
    for (const f of half) tie = setAt(tie, f, PRESETS.basic[f]);
    expect(basicFields.length % 2).toBe(0);
    const p = presetOf(tie);
    expect(p.id).toBe("custom");
    expect(p.nearest).toBe("standard");
    expect(p.changes).toHaveLength(half.length);
  });

  it("a lockout of other numbers is a change; leaving the lockout to the PC matches Basic only", () => {
    const l = setAt(standard(), "machine.accountLockout", { threshold: 8, durationMin: 15, windowMin: 15 });
    expect(presetOf(l)).toEqual({ id: "custom", nearest: "standard", changes: ["machine.accountLockout"] });
    const off = setAt(standard(), "machine.accountLockout", null);
    expect(presetOf(off).changes).toEqual(["machine.accountLockout"]);
  });

  it("a Strict list is Custom, never rewritten", () => {
    const strictList: LockdownSettings = { ...standard(), appControl: { mode: "audit", level: "allowlist" } };
    expect(presetOf(strictList)).toEqual({ id: "custom", nearest: "standard", changes: ["appControl.level"] });
  });

  it("Reset to the nearest level (applyPreset) makes it exact again", () => {
    const custom = setAt(setAt(applyPreset(D, "strict"), "staff.run", false), "usb.phones", "allow");
    const { nearest } = presetOf(custom);
    expect(presetOf(applyPreset(custom, nearest)).id).toBe(nearest);
  });
});

describe("program blocking", () => {
  it("programModeOf: one mode when the three checks agree, else mixed", () => {
    for (const mode of ["off", "audit", "enforce"] as const) expect(programModeOf(setProgramMode(D, mode))).toBe(mode);
    expect(programModeOf(D)).toBe("audit");
    expect(programModeOf({ ...D, procWatch: { mode: "enforce" } })).toBe("mixed");
    expect(programModeOf({ ...D, appControl: { ...D.appControl, mode: "off" } })).toBe("mixed");
  });

  it("setProgramMode sets all three and keeps the safety list strength and every other field", () => {
    const strictList: LockdownSettings = { ...D, appControl: { mode: "audit", level: "allowlist" }, wifiManagedOnly: true };
    const out = setProgramMode(strictList, "enforce");
    expect(out.appLocker).toEqual({ mode: "enforce" });
    expect(out.appControl).toEqual({ mode: "enforce", level: "allowlist" });
    expect(out.procWatch).toEqual({ mode: "enforce" });
    expect(out.wifiManagedOnly).toBe(true);
    expect(setProgramMode({ ...D, procWatch: { mode: "off" } }, "audit")).toEqual(D);
  });

  it("changing the program blocking never changes the protection level", () => {
    for (const id of PRESET_IDS as readonly PresetId[]) {
      for (const mode of ["off", "audit", "enforce"] as const) expect(presetOf(setProgramMode(applyPreset(D, id), mode)).id).toBe(id);
    }
  });
});

describe("changeLabels (the save bar)", () => {
  it("nothing changed: nothing listed", () => {
    expect(changeLabels(D, { ...D })).toEqual({ labels: [], count: 0, more: 0 });
  });

  it("lists plain labels in screen order", () => {
    const next: LockdownSettings = { ...D, staff: { ...D.staff, run: false }, usb: { ...D.usb, storage: "block" }, accessibilityTools: true };
    expect(changeLabels(D, next)).toEqual({ labels: [s.staff.run[0], s.usb.storage, s.accessibilityTools], count: 3, more: 0 });
  });

  it("the three program checks moved together are one change; moved alone, each is named", () => {
    expect(changeLabels(D, setProgramMode(D, "enforce"))).toEqual({ labels: [s.modeTitle], count: 1, more: 0 });
    expect(changeLabels(D, { ...D, procWatch: { mode: "enforce" } })).toEqual({ labels: [s.procWatch], count: 1, more: 0 });
    expect(changeLabels(D, { ...D, appControl: { ...D.appControl, level: "allowlist" } }).labels).toEqual([s.appControlLevel]);
  });

  it("a preset change names what it moved, at most 8, with the rest counted", () => {
    const { labels, count, more } = changeLabels(applyPreset(D, "basic"), applyPreset(D, "strict"));
    expect(labels).toHaveLength(8);
    expect(count).toBeGreaterThan(8);
    expect(more).toBe(count - 8);
    expect(new Set(labels).size).toBe(8);
    expect(changeLabels(applyPreset(D, "basic"), applyPreset(D, "strict"), 100).labels).toHaveLength(count);
  });

  it("the lockout is one change whatever number moved", () => {
    const next = { ...D, machine: { ...D.machine, accountLockout: { threshold: 6, durationMin: 20, windowMin: 10 } } };
    expect(changeLabels(D, next).labels).toEqual([s.lockout]);
  });

  it("a Wi-Fi confirmation that appears or goes is a change", () => {
    expect(changeLabels({ ...D, wifiManagedOnly: true }, { ...D, wifiManagedOnly: true, wifiManagedOnlyConfirmed: true }).labels).toEqual([s.wifiManagedOnlyConfirm]);
    expect(changeLabels({ ...D, wifiManagedOnlyConfirmed: undefined }, D).count).toBe(0);
  });
});
