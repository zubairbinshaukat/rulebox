import type { LockdownSettings } from "../../data/types";

/**
 * Protection levels ("presets") of the group lockdown screen (`docs/plans/ui-pass/lockdown.md` section 3). Pure and derived on the
 * client: nothing is stored, no field of `lockdownSettings` is renamed. A preset sets exactly the 28 PRESET_FIELDS below; the program
 * rule modes, `machine.hideAdminTiles`, `performance.*`, `wifiManagedOnly` and `wifiManagedOnlyConfirmed` are never touched by it.
 *
 * Standard equals today's `DEFAULT_LOCKDOWN_SETTINGS` on every preset field (a test pins it), so a group that kept the defaults reads
 * "Standard". Strict lockout {5, 30, 30}: 5 is the lowest threshold the agent accepts and the window is not longer than the lock, so
 * `lockout_threshold_too_low` and `lockout_window_too_long` cannot fire for a preset.
 */

export type PresetId = "basic" | "standard" | "strict";
export const PRESET_IDS: readonly PresetId[] = ["basic", "standard", "strict"];

/** Order of a tie between presets that are equally near: the usual one first. */
const TIE_ORDER: readonly PresetId[] = ["standard", "basic", "strict"];

export type Lockout = { threshold: number; durationMin: number; windowMin: number };
export type PresetValue = boolean | string | Lockout | null;

/** The settings paths (dot notation) a preset sets, in the order of `LockdownSettings`. */
export const PRESET_FIELDS = [
  "staff.taskManager",
  "staff.run",
  "staff.commandPrompt",
  "staff.registryTools",
  "staff.settings",
  "staff.signOut",
  "staff.changePassword",
  "staff.hideDrives",
  "staff.accessibilityHotkeys",
  "staff.officeMacros",
  "machine.hideSwitchUser",
  "machine.hideSignInPower",
  "machine.denyElevationRequests",
  "machine.noWakePassword",
  "machine.restrictPrinterDrivers",
  "machine.fileOutputPrinters",
  "machine.accountLockout",
  "appControl.level",
  "keyboard.winCombos",
  "usb.storage",
  "usb.printers",
  "usb.imaging",
  "usb.phones",
  "usb.other",
  "usb.retroactive",
  "accessibilityTools",
  "boot.autoRecovery",
  "boot.safeModeGuard",
] as const;
export type PresetField = (typeof PRESET_FIELDS)[number];

/** What a preset sets: one value per preset field. */
export type PresetValues = { [F in PresetField]: PresetValue };

/** The preset fields all three levels share. */
const ALWAYS = {
  "staff.taskManager": true,
  "staff.run": true,
  "staff.commandPrompt": true,
  "staff.registryTools": true,
  "staff.accessibilityHotkeys": true,
  "staff.officeMacros": true,
  "machine.denyElevationRequests": true,
  "machine.noWakePassword": true,
  "machine.restrictPrinterDrivers": true,
  "appControl.level": "recommendedBlocks",
  "keyboard.winCombos": "swallow",
  "usb.printers": "allow",
  "usb.imaging": "allow",
  "usb.other": "allow",
  "boot.safeModeGuard": true,
} satisfies Partial<PresetValues>;

export const PRESETS: Record<PresetId, PresetValues> = {
  basic: {
    ...ALWAYS,
    "staff.settings": false,
    "staff.signOut": false,
    "staff.changePassword": false,
    "staff.hideDrives": false,
    "machine.hideSwitchUser": false,
    "machine.hideSignInPower": false,
    "machine.fileOutputPrinters": false,
    "machine.accountLockout": null,
    "accessibilityTools": true,
    "usb.storage": "allow",
    "usb.phones": "allow",
    "usb.retroactive": false,
    "boot.autoRecovery": "leave",
  },
  standard: {
    ...ALWAYS,
    "staff.settings": true,
    "staff.signOut": true,
    "staff.changePassword": true,
    "staff.hideDrives": true,
    "machine.hideSwitchUser": true,
    "machine.hideSignInPower": true,
    "machine.fileOutputPrinters": true,
    "machine.accountLockout": { threshold: 10, durationMin: 15, windowMin: 15 },
    "accessibilityTools": false,
    "usb.storage": "allow",
    "usb.phones": "allow",
    "usb.retroactive": false,
    "boot.autoRecovery": "off",
  },
  strict: {
    ...ALWAYS,
    "staff.settings": true,
    "staff.signOut": true,
    "staff.changePassword": true,
    "staff.hideDrives": true,
    "machine.hideSwitchUser": true,
    "machine.hideSignInPower": true,
    "machine.fileOutputPrinters": true,
    "machine.accountLockout": { threshold: 5, durationMin: 30, windowMin: 30 },
    "accessibilityTools": false,
    "usb.storage": "block",
    "usb.phones": "block",
    "usb.retroactive": true,
    "boot.autoRecovery": "off",
  },
};

// ---------------------------------------------------------------- reading and writing a path

/** A text that is the same for equal values (the lockout is an object). */
function same(a: PresetValue | undefined, b: PresetValue | undefined): boolean {
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
  return a.threshold === b.threshold && a.durationMin === b.durationMin && a.windowMin === b.windowMin;
}

/** The value at a settings path (`"usb.storage"`, `"accessibilityTools"`). */
export function valueAt(settings: LockdownSettings, path: string): PresetValue {
  let at: unknown = settings;
  for (const key of path.split(".")) at = (at as Record<string, unknown> | undefined)?.[key];
  return (at ?? null) as PresetValue;
}

/** A copy of the settings with one path set (the objects along the path are copied, the rest is shared). */
export function setAt(settings: LockdownSettings, path: string, value: PresetValue): LockdownSettings {
  const keys = path.split(".");
  const put = (node: unknown, i: number): unknown => {
    const o = { ...(node as Record<string, unknown>) };
    const key = keys[i]!;
    o[key] = i === keys.length - 1 ? (value !== null && typeof value === "object" ? { ...value } : value) : put(o[key], i + 1);
    return o;
  };
  return put(settings, 0) as LockdownSettings;
}

// ---------------------------------------------------------------- applying and recognising

/** The draft with a preset applied: the 28 preset fields are set, every other field is kept as it is. */
export function applyPreset(draft: LockdownSettings, id: PresetId): LockdownSettings {
  let out = draft;
  for (const field of PRESET_FIELDS) out = setAt(out, field, PRESETS[id][field]);
  return out;
}

/** True when the settings differ from `preset` at `path` (a "Changed" pill in Advanced). A path outside the preset fields never differs. */
export function fieldChanged(settings: LockdownSettings, preset: PresetId, path: string): boolean {
  if (!(PRESET_FIELDS as readonly string[]).includes(path)) return false;
  return !same(valueAt(settings, path), PRESETS[preset][path as PresetField]);
}

/** The preset fields where the settings differ from a preset. */
function differences(settings: LockdownSettings, preset: PresetId): PresetField[] {
  return PRESET_FIELDS.filter((f) => !same(valueAt(settings, f), PRESETS[preset][f]));
}

export interface PresetMatch {
  /** The preset all 28 preset fields match exactly, else "custom". */
  id: PresetId | "custom";
  /** The preset with the fewest differences (a tie prefers standard, then basic, then strict). */
  nearest: PresetId;
  /** The preset fields where the settings differ from `nearest` (empty unless `id` is "custom"). */
  changes: PresetField[];
}

/** Which protection level the settings are: an exact match on the 28 preset fields, else "custom" with the nearest preset. */
export function presetOf(settings: LockdownSettings): PresetMatch {
  let nearest: PresetId = "standard";
  let changes = differences(settings, "standard");
  for (const id of TIE_ORDER.slice(1)) {
    const d = differences(settings, id);
    if (d.length < changes.length) {
      nearest = id;
      changes = d;
    }
  }
  return { id: changes.length === 0 ? nearest : "custom", nearest, changes };
}
