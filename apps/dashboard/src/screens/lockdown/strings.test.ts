import { describe, expect, it } from "vitest";
import { overviewLockdownStrings } from "../overview/strings";
import { LAYER_DETAILS, LAYER_MODE_LABELS, LAYER_STATES, REFUSALS } from "./codes";
import { findingsStrings, lockdownStrings } from "./strings";

/** Every visible string of the lockdown words: [path, text]. Functions are called with sample arguments. */
type Entry = [path: string, text: string];

const SAMPLES: unknown[][] = [
  [3, true],
  [1, false],
  ["Contoso Ltd"],
  [{ kind: "publisher", subject: "Contoso Ltd", fileName: "tool.exe", hashStart: "abc", path: null }],
  [{ kind: "hash", subject: null, fileName: null, hashStart: "abc", path: null }],
  [{ kind: "path", subject: null, fileName: "tool.exe", hashStart: null, path: "{ProgramFiles}\\Acme\\tool.exe" }],
  [["Sales", "Office"], true],
];

function collect(value: unknown, path: string, out: Entry[]): void {
  if (typeof value === "string") out.push([path, value]);
  else if (typeof value === "function") {
    for (const args of SAMPLES) {
      try {
        const r = (value as (...a: unknown[]) => unknown)(...args);
        if (typeof r === "string") out.push([path, r]);
        else collect(r, path, out);
      } catch {
        // Not this argument shape.
      }
    }
  } else if (Array.isArray(value)) value.forEach((v, i) => collect(v, `${path}[${i}]`, out));
  else if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) collect(v, `${path}.${k}`, out);
}

const entriesOf = (value: unknown, root: string): Entry[] => {
  const out: Entry[] = [];
  collect(value, root, out);
  return out.filter(([, text]) => text !== "");
};

const all: Entry[] = [
  ...entriesOf(lockdownStrings, "lockdown"),
  ...entriesOf(findingsStrings, "findings"),
  ...entriesOf(overviewLockdownStrings, "overview"),
  ...entriesOf(REFUSALS, "refusals"),
  ...entriesOf(LAYER_DETAILS, "details"),
  ...entriesOf(Object.fromEntries(Object.entries(LAYER_STATES).map(([k, v]) => [k, v.label])), "states"),
  ...entriesOf(LAYER_MODE_LABELS, "modes"),
];

/** The (i) texts that name the Windows feature on purpose (and the one note that tells you which Windows edition lacks it). */
const NAMES_WINDOWS_ON_PURPOSE = new Set(["lockdown.appLockerHelp", "lockdown.appControlHelp", "details.applocker_not_on_this_edition"]);
const JARGON = /AppLocker|App Control|process watch|\baudit|\benforc/i;

/** An (i) text: a key that ends in Help, Info or Hint (or sits under one), or the second item of a `[label, info]` pair. */
const isInfo = (path: string): boolean => /(Help|Info|Hint)(\.|$)/.test(path) || /^lockdown\.(staff|machine)\.\w+\[1\]$/.test(path);
const sentences = (text: string): number => text.split(/[.!?](?:\s|$)/).filter((s) => s.trim() !== "").length;

describe("lockdown words", () => {
  it("collects a real number of strings (the walker is not skipping everything)", () => {
    expect(all.length).toBeGreaterThan(250);
    expect(all.map(([p]) => p)).toEqual(expect.arrayContaining(["lockdown.appLockerHelp", "lockdown.presets.standard.badge", "findings.howSteps[2]", "overview.auditTitle", "refusals.would_block_exit"]));
  });

  it("no visible string says AppLocker, App Control, process watch, audit or enforce, except where the Windows feature is named on purpose", () => {
    const hits = all.filter(([path, text]) => JARGON.test(text) && !NAMES_WINDOWS_ON_PURPOSE.has(path)).map(([path, text]) => `${path}: ${text}`);
    expect(hits).toEqual([]);
  });

  it("the two (i) texts that name a Windows feature say so once, in plain words", () => {
    expect(lockdownStrings.appLockerHelp).toContain("Uses Windows AppLocker");
    expect(lockdownStrings.appControlHelp).toContain("Uses Windows App Control");
  });

  it("every (i) text is at most three sentences", () => {
    const long = all.filter(([path, text]) => isInfo(path) && sentences(text) > 3).map(([path, text]) => `${path}: ${text}`);
    expect(long).toEqual([]);
    expect(all.filter(([path]) => isInfo(path)).length).toBeGreaterThan(40);
  });

  it("mode words are Off, Trial run and Block everywhere a person sees a mode", () => {
    expect(lockdownStrings.modes).toEqual({ off: "Off", audit: "Trial run", enforce: "Block" });
    expect(LAYER_MODE_LABELS).toEqual({ off: "Off", audit: "Trial run", enforce: "Block", on: "On" });
    expect(LAYER_STATES.auditFirst!.label).toBe("Trial run first");
  });

  it("the three checks have plain names", () => {
    expect(lockdownStrings.appLocker).toBe("Employee program list");
    expect(lockdownStrings.appControl).toBe("Windows safety list");
    expect(lockdownStrings.procWatch).toBe("Rulebox program check");
    expect(findingsStrings.layers).toEqual({ appLocker: "Employee program list", appControl: "Windows safety list", procWatch: "Rulebox program check" });
  });

  it("the sync card says counts in plain words", () => {
    const s = lockdownStrings;
    expect(s.upToDate(2, 5, false)).toBe("PCs up to date: 2 of 5");
    expect(s.upToDate(150, 200, true)).toBe("PCs up to date: 150 of 200+");
    expect(s.allUpToDate(8)).toBe("All 8 PCs are up to date.");
    expect(s.allUpToDate(1)).toBe("This PC is up to date.");
    expect(s.sending(0, 8)).toBe("Sending: 0 of 8 PCs have it");
    expect(s.waiting(2)).toBe("2 waiting");
    expect(s.problems(1)).toBe("1 could not apply it:");
    expect(s.reduced(2)).toContain("2 PCs run Windows Home");
    expect(s.reduced(1)).toContain("1 PC runs Windows Home");
    expect(s.adminTilesPending(2)).toBe("Admin accounts stay visible on 2 PCs until Other user sign-in is confirmed there.");
    expect(s.custom("Standard", 2)).toBe("Custom: Standard with 2 changes");
    expect(s.custom("Standard", 1)).toBe("Custom: Standard with 1 change");
    expect(s.unsaved(1)).toBe("1 unsaved change");
    expect(s.trialDays(9)).toBe("Trial run for 9 days.");
  });

  it("the confirmation, the exception rows and the overview lines use the new words", () => {
    expect(lockdownStrings.enforceTitle).toBe("Start blocking programs?");
    expect(lockdownStrings.enforceFindings(0, false)).toBe("Nothing is waiting for review.");
    expect(lockdownStrings.enforceFindings(12, true)).toBe("12+ programs are still waiting for review. They will be blocked.");
    expect(lockdownStrings.exceptionWhat({ kind: "publisher", subject: "Contoso Ltd", fileName: "tool.exe", hashStart: null, path: null })).toBe("tool.exe from Contoso Ltd");
    expect(lockdownStrings.exceptionWhat({ kind: "hash", subject: null, fileName: null, hashStart: "abc123", path: null })).toBe("A program (this exact version)");
    expect(lockdownStrings.exceptionWhat({ kind: "path", subject: null, fileName: null, hashStart: null, path: "{ProgramFiles}\\Acme\\tool.exe" })).toBe("Acme\\tool.exe");
    // The fingerprint is not in the row text, only in its hover text.
    expect(lockdownStrings.exceptionTitle({ kind: "hash", hashStart: "abc123", path: null })).toContain("abc123");
    expect(overviewLockdownStrings.auditTitle(["Sales", "Office"], true)).toBe("Trial run for more than 14 days: Sales, Office and more");
    expect(overviewLockdownStrings.notAppliedTitle(["Desk 9"], false)).toBe("Lockdown not applied on: Desk 9");
  });
});
