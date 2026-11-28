import {
  MAX_LOCKOUT_MINUTES,
  MAX_LOCKOUT_THRESHOLD,
  MIN_LOCKOUT_THRESHOLD,
  type ExceptionKind,
  type FindingRow,
  type LayerMode,
  type LockdownSettings,
} from "../../data/types";
import { valueAt } from "./presets";
import { lockdownStrings } from "./strings";

/** Pure rules of the lockdown screens (Phase 5 Step 19); the server checks the same things (`convex/lockdown.ts`). */

export interface LockoutDraft {
  on: boolean;
  threshold: string;
  duration: string;
  window: string;
}

export function lockoutDraftOf(s: LockdownSettings): LockoutDraft {
  const l = s.machine.accountLockout;
  return l === null ? { on: false, threshold: "10", duration: "15", window: "15" } : { on: true, threshold: String(l.threshold), duration: String(l.durationMin), window: String(l.windowMin) };
}

const whole = (text: string, min: number, max: number): number | null => {
  const t = text.trim();
  if (!/^\d{1,6}$/.test(t)) return null;
  const v = Number(t);
  return v >= min && v <= max ? v : null;
};

/** Which lockout fields are wrong (all false while the lockout is off). */
export function lockoutProblems(l: LockoutDraft): { threshold: boolean; duration: boolean; window: boolean } {
  if (!l.on) return { threshold: false, duration: false, window: false };
  const duration = whole(l.duration, 1, MAX_LOCKOUT_MINUTES);
  return {
    threshold: whole(l.threshold, MIN_LOCKOUT_THRESHOLD, MAX_LOCKOUT_THRESHOLD) === null,
    duration: duration === null,
    window: whole(l.window, 1, duration ?? MAX_LOCKOUT_MINUTES) === null,
  };
}

/** The settings to save: the draft with the lockout fields as numbers (the saved lockout is kept while a field is invalid). */
export function settingsOf(draft: LockdownSettings, l: LockoutDraft): LockdownSettings {
  return withoutStaleConfirm(withLockout(draft, l));
}

function withLockout(draft: LockdownSettings, l: LockoutDraft): LockdownSettings {
  if (!l.on) return { ...draft, machine: { ...draft.machine, accountLockout: null } };
  const p = lockoutProblems(l);
  if (p.threshold || p.duration || p.window) return draft;
  return { ...draft, machine: { ...draft.machine, accountLockout: { threshold: Number(l.threshold.trim()), durationMin: Number(l.duration.trim()), windowMin: Number(l.window.trim()) } } };
}

/** "I understand this PC may go offline" only means something while "managed networks only" is on, and is never stored as false (as the server does). */
function withoutStaleConfirm(s: LockdownSettings): LockdownSettings {
  const { wifiManagedOnlyConfirmed, ...rest } = s;
  return wifiManagedOnlyConfirmed === true && s.wifiManagedOnly ? { ...rest, wifiManagedOnlyConfirmed: true } : rest;
}

/** A text that is the same for equal settings whatever the order of their keys (the server does not promise one). */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${k}:${stable(o[k])}`)
    .join(",")}}`;
}

export function sameSettings(a: LockdownSettings, b: LockdownSettings): boolean {
  return stable(a) === stable(b);
}

const RULE_LAYERS =["appLocker", "appControl", "procWatch"] as const;
export type RuleLayer = (typeof RULE_LAYERS)[number];

/** The program rules whose mode changes between two settings. */
export function changedLayers(from: LockdownSettings, to: LockdownSettings): { layer: RuleLayer; from: LayerMode; to: LayerMode }[] {
  return RULE_LAYERS.filter((k) => from[k].mode !== to[k].mode).map((k) => ({ layer: k, from: from[k].mode, to: to[k].mode }));
}

/** The "Program blocking" control: the mode all three program checks share, or "mixed" when they differ (set per check in Advanced). */
export function programModeOf(s: LockdownSettings): LayerMode | "mixed" {
  const mode = s.appLocker.mode;
  return s.appControl.mode === mode && s.procWatch.mode === mode ? mode : "mixed";
}

/** The settings with all three program checks set to one mode (the safety list strength is kept). */
export function setProgramMode(s: LockdownSettings, mode: LayerMode): LockdownSettings {
  return { ...s, appLocker: { mode }, appControl: { ...s.appControl, mode }, procWatch: { mode } };
}

type Leaf = { path: string; label: string };

/** Every setting a person can change, in screen order, with its plain label. */
const LEAVES: readonly Leaf[] = [
  { path: "appLocker.mode", label: lockdownStrings.appLocker },
  { path: "appControl.mode", label: lockdownStrings.appControl },
  { path: "appControl.level", label: lockdownStrings.appControlLevel },
  { path: "procWatch.mode", label: lockdownStrings.procWatch },
  ...(Object.keys(lockdownStrings.staff) as (keyof typeof lockdownStrings.staff)[]).map((k) => ({ path: `staff.${k}`, label: lockdownStrings.staff[k][0] })),
  ...(Object.keys(lockdownStrings.machine) as (keyof typeof lockdownStrings.machine)[]).map((k) => ({ path: `machine.${k}`, label: lockdownStrings.machine[k][0] })),
  { path: "machine.accountLockout", label: lockdownStrings.lockout },
  ...(Object.keys(lockdownStrings.usb) as (keyof typeof lockdownStrings.usb)[]).map((k) => ({ path: `usb.${k}`, label: lockdownStrings.usb[k] })),
  { path: "usb.retroactive", label: lockdownStrings.usbRetroactive },
  { path: "keyboard.winCombos", label: lockdownStrings.winCombos },
  { path: "accessibilityTools", label: lockdownStrings.accessibilityTools },
  { path: "boot.autoRecovery", label: lockdownStrings.autoRecovery },
  { path: "boot.safeModeGuard", label: lockdownStrings.safeModeGuard },
  { path: "performance.staffTuning", label: lockdownStrings.staffTuning },
  { path: "performance.kioskProfile", label: lockdownStrings.kioskProfile },
  { path: "performance.noPrinting", label: lockdownStrings.noPrinting },
  { path: "wifiManagedOnly", label: lockdownStrings.wifiManagedOnly },
  { path: "wifiManagedOnlyConfirmed", label: lockdownStrings.wifiManagedOnlyConfirm },
];

/** How many changes the save bar names; the rest is "and N more". */
export const MAX_CHANGE_LABELS = 8;

/** What changed between two settings, for the save bar: plain labels, at most `max` named, `count` = all of them. */
export function changeLabels(before: LockdownSettings, next: LockdownSettings, max: number = MAX_CHANGE_LABELS): { labels: string[]; count: number; more: number } {
  const differs = (path: string) => stable(valueAt(before, path) ?? false) !== stable(valueAt(next, path) ?? false);
  const modePaths = ["appLocker.mode", "appControl.mode", "procWatch.mode"];
  // The three program checks moved together (the "Program blocking" control): one change, not three.
  const together = modePaths.every(differs) && programModeOf(next) !== "mixed" && programModeOf(before) !== "mixed";
  const all = LEAVES.filter((l) => differs(l.path) && !(together && modePaths.includes(l.path))).map((l) => l.label);
  if (together) all.unshift(lockdownStrings.modeTitle);
  return { labels: all.slice(0, max), count: all.length, more: Math.max(0, all.length - max) };
}

/** Folder classes only administrators can write to: the only ones a path exception may name (plan 4.9, edge case 13). */
const ADMIN_ONLY_FOLDERS: readonly string[] = ["programFiles", "rulebox"];

/**
 * Which rule kinds a finding can be allowed with, best first (plan Step 19 item 2): publisher when it is signed, the exact file when
 * the PC sent its hash, a folder only for admin-only folders. App Control findings cannot be allowed per program: none.
 */
export function allowKinds(f: Pick<FindingRow, "layer" | "signer" | "hasHash" | "folderClass">): ExceptionKind[] {
  if (f.layer === "appControl") return [];
  const out: ExceptionKind[] = [];
  if (f.signer !== null) out.push("publisher");
  if (f.hasHash) out.push("hash");
  if (ADMIN_ONLY_FOLDERS.includes(f.folderClass)) out.push("path");
  return out;
}

const FOLDER_ROOTS = ["{ProgramFiles}\\", "{ProgramFilesX86}\\", "{RuleboxApps}\\"];

/** True when the folder template cannot be right (the server has the full check). */
export function folderProblem(folder: string): boolean {
  const t = folder.trim();
  if (!FOLDER_ROOTS.some((r) => t.startsWith(r) && t.length > r.length)) return true;
  return t.split("\\").some((part) => part === ".." || part === ".") || /[/:*?"<>|]/.test(t.replace(/^\{[A-Za-z0-9]+\}/, ""));
}
