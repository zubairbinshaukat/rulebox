import { fail } from "./errors";
import { parseHotkey } from "./hotkey";
import { MAX_DEFAULT_QUOTA_GB, MAX_HOTKEY_TEXT, MAX_OFFLINE_DAYS, MAX_ORG_NAME } from "./limits";
import type { OrgSettings } from "./validators";

// Organization settings rules (plan 4.10). Pure; the server is the authority,
// the dashboard mirrors these rules for live validation only.

/**
 * The device exit PIN (PRD 12.4; plan 4.10): 6 to 12 ASCII digits; refused:
 * all digits the same, and a run up or down by one (`012345…`, `987654…`).
 * Null when acceptable, else a fixed reason (never the PIN).
 */
export function exitPinProblem(pin: string): string | null {
  if (!/^[0-9]{6,12}$/.test(pin)) return "6 to 12 digits";
  if (/^(\d)\1+$/.test(pin)) return "all digits the same";
  if ("0123456789".includes(pin) || "9876543210".includes(pin)) return "sequence";
  return null;
}

/** Organization name: trimmed, 1..MAX_ORG_NAME characters, no control characters. */
export function normalizeOrgName(name: string): string {
  const trimmed = name.trim();
  // eslint-disable-next-line no-control-regex
  if (trimmed.length < 1 || trimmed.length > MAX_ORG_NAME || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    fail("invalid_argument", { field: "name" });
  }
  return trimmed;
}

function wholeIn(n: number, min: number, max: number): boolean {
  return Number.isInteger(n) && n >= min && n <= max;
}

/**
 * Validate every field (plan 4.10) and return the stored form: the hotkey in
 * its canonical spelling (`Ctrl+Alt+Shift+<KEY>`). `invalid_argument` names
 * the field; for the hotkey `detail` is the grammar rule it broke.
 */
export function normalizeSettings(s: OrgSettings): OrgSettings {
  if (!wholeIn(s.offlineDays, 0, MAX_OFFLINE_DAYS)) fail("invalid_argument", { field: "offlineDays" });
  if (!wholeIn(s.defaultQuotaGb, 0, MAX_DEFAULT_QUOTA_GB)) fail("invalid_argument", { field: "defaultQuotaGb" });
  if (s.adminExit.hotkey.length > MAX_HOTKEY_TEXT) fail("invalid_argument", { field: "adminExit.hotkey" });
  const hotkey = parseHotkey(s.adminExit.hotkey);
  if (!hotkey.ok) fail("invalid_argument", { field: "adminExit.hotkey", detail: hotkey.reason });
  return {
    offlineDays: s.offlineDays,
    defaultQuotaGb: s.defaultQuotaGb,
    power: { sleep: s.power.sleep, restart: s.power.restart, shutDown: s.power.shutDown },
    adminExit: { enabled: s.adminExit.enabled, hotkey: hotkey.canonical },
  };
}

/** Names of the top-level settings that differ (for the audit summary and the step-up rule). */
export function changedSettings(before: OrgSettings, after: OrgSettings): (keyof OrgSettings)[] {
  const out: (keyof OrgSettings)[] = [];
  if (before.offlineDays !== after.offlineDays) out.push("offlineDays");
  if (before.defaultQuotaGb !== after.defaultQuotaGb) out.push("defaultQuotaGb");
  if (
    before.power.sleep !== after.power.sleep ||
    before.power.restart !== after.power.restart ||
    before.power.shutDown !== after.power.shutDown
  ) {
    out.push("power");
  }
  if (before.adminExit.enabled !== after.adminExit.enabled || before.adminExit.hotkey !== after.adminExit.hotkey) {
    out.push("adminExit");
  }
  return out;
}
