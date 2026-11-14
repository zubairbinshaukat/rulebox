import { DAY_MS, MAX_FINDINGS_PER_CALL, MAX_ITEM_STATES, MAX_ORG_PERMISSION_DENIALS, MAX_PERMISSION_DENIALS, SECURITY_DAY_SLACK } from "./limits";
import { fail } from "./errors";
import { FOLDER_CLASSES, RINGS, type ApplyStateValue, type BlockedCountsValue, type PermissionDenialValue, type RingValue } from "./lockdownValidators";
import { isCount } from "./deviceApiRules";

// What an agent may send in the Phase 5 reports (plan 4.11, 4.19) and how it is cleaned
// (Step 10). PURE. The wire shapes are those of `apps/agent/src/backend/reports.rs`.
//
// The rule behind every function here: the agent is a different program on a PC we do not
// control, possibly a NEWER one. A value this server does not know is never a reason to
// refuse the report (that would stall the agent's queue for good); it is stored as a fixed
// "unknown" code or dropped. A value that is a SHAPE problem (a list longer than its cap, a
// number that is not a count, a malformed hash) is `invalid_argument`. And nothing that
// could be a path, a window title, a command line or a URL is ever stored: every free-form
// field is checked against a character class of fixed-code characters.

const CODE = /^[A-Za-z0-9_.:-]+$/;

/** A fixed code (`would_block_exit`, `waiting_for_key`, ...) of at most `max` characters, else undefined. */
export function cleanCode(value: string | null | undefined, max: number): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value.length >= 1 && value.length <= max && CODE.test(value) ? value : undefined;
}

/** An id the agent copied from a document (a Convex id, 32 characters today): letters, digits, `_` and `-`, at most 64. */
export function cleanId(value: string): string | undefined {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
}

const APPLY_STATES: readonly string[] = ["applied", "partial", "refused", "failed", "rolledBack"];

/** A state this server knows, else `partial` (a newer agent's state must not stall its queue; it is shown as "not fully applied"). */
export function applyStateOf(state: string): ApplyStateValue {
  return (APPLY_STATES.includes(state) ? state : "partial") as ApplyStateValue;
}

export function ringOf(ring: string): RingValue {
  return (RINGS as readonly string[]).includes(ring) ? (ring as RingValue) : "everyone";
}

export type LayerIn = { mode: string; state: string; detail?: string };
export type LayerOut = { mode: string; state: string; detail?: string };

export function cleanLayer(l: LayerIn): LayerOut {
  const out: LayerOut = { mode: cleanCode(l.mode, 16) ?? "unknown", state: cleanCode(l.state, 24) ?? "unknown" };
  const detail = cleanCode(l.detail, 64);
  if (detail !== undefined) out.detail = detail;
  return out;
}

type ItemIn = { revision: number; state: string; detail?: string };

/** Wi-Fi / printer states: at most MAX_ITEM_STATES (else `invalid_argument`); an item with a bad id is dropped. */
export function cleanItems<K extends "profileId" | "printerId">(
  field: string,
  key: K,
  items: (ItemIn & Record<K, string>)[],
): ({ revision: number; state: string; detail?: string } & Record<K, string>)[] {
  if (items.length > MAX_ITEM_STATES) fail("invalid_argument", { field });
  const out: ({ revision: number; state: string; detail?: string } & Record<K, string>)[] = [];
  for (const it of items) {
    const id = cleanId(it[key]);
    if (id === undefined) continue;
    if (!isCount(it.revision)) fail("invalid_argument", { field: `${field}.revision` });
    const row = { [key]: id, revision: it.revision, state: cleanCode(it.state, 32) ?? "unknown" } as { revision: number; state: string; detail?: string } & Record<K, string>;
    const detail = cleanCode(it.detail, 64);
    if (detail !== undefined) row.detail = detail;
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------- findings (4.10)

export type FindingIn = {
  fingerprint: string;
  layer: string;
  fileName: string;
  folderClass: string;
  signer?: string;
  product?: string;
  sha256?: string;
};
export type FindingOut = {
  fingerprint: string;
  layer: "appLocker" | "appControl" | "procWatch";
  fileName: string;
  folderClass: string;
  signer?: string;
  product?: string;
  sha256?: string;
};

const LAYERS: readonly string[] = ["appLocker", "appControl", "procWatch"];
const HASH64 = /^[0-9a-f]{64}$/;

/** A text that is a program's file name or a certificate field: one line, no control characters, at most `max`. */
function oneLine(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  const t = text.trim();
  // eslint-disable-next-line no-control-regex
  if (t.length < 1 || t.length > max || /[\u0000-\u001f\u007f]/.test(t)) return undefined;
  return t;
}

/**
 * Up to MAX_FINDINGS_PER_CALL findings (more = `invalid_argument`). A finding with a bad fingerprint
 * or a layer this server does not know is dropped (the call still succeeds); a file name that
 * holds a path separator is dropped too (rule 6: a path never reaches the server). Duplicate
 * fingerprints within a call keep the first.
 */
export function cleanFindings(findings: FindingIn[]): FindingOut[] {
  if (findings.length > MAX_FINDINGS_PER_CALL) fail("invalid_argument", { field: "findings" });
  const seen = new Set<string>();
  const out: FindingOut[] = [];
  for (const f of findings) {
    if (!HASH64.test(f.fingerprint) || seen.has(f.fingerprint) || !LAYERS.includes(f.layer)) continue;
    const fileName = oneLine(f.fileName, 100);
    if (fileName === undefined || /[\\/]/.test(fileName)) continue;
    seen.add(f.fingerprint);
    const row: FindingOut = {
      fingerprint: f.fingerprint,
      layer: f.layer as FindingOut["layer"],
      fileName,
      folderClass: (FOLDER_CLASSES as readonly string[]).includes(f.folderClass) ? f.folderClass : "other",
    };
    const signer = oneLine(f.signer, 200);
    const product = oneLine(f.product, 100);
    if (signer !== undefined) row.signer = signer;
    if (product !== undefined) row.product = product;
    if (f.sha256 !== undefined && HASH64.test(f.sha256)) row.sha256 = f.sha256;
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------- daily security counters (4.2)

const PERMISSION_KINDS: readonly string[] = ["camera", "microphone", "screenShare", "clipboardRead", "notifications", "downloads", "printing", "geolocation"];
const MAX_COUNTER = 1_000_000_000;

export type DailyIn = {
  day: string;
  blocked: BlockedCountsValue;
  permissionDenials: PermissionDenialValue[];
  drift: number;
  tamper: number;
};

function counter(n: number, field: string): number {
  if (!isCount(n) || n > MAX_COUNTER) fail("invalid_argument", { field });
  return n;
}

/** `YYYY-MM-DD` of a server time (UTC). */
export function serverDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * One device's counters for one server day. The day must be today or at most
 * SECURITY_DAY_SLACK days back (the agent names the server's UTC day, and may send
 * yesterday's totals with its first call after midnight). Counters are counts;
 * permission denials: at most MAX_PERMISSION_DENIALS rows (else `invalid_argument`), a row with a
 * kind this server does not know is dropped, equal (app, kind) rows are added up.
 */
export function cleanDaily(d: DailyIn, now: number): DailyIn {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.day)) fail("invalid_argument", { field: "day" });
  const t = Date.parse(`${d.day}T00:00:00Z`);
  if (!Number.isFinite(t) || serverDay(t) !== d.day) fail("invalid_argument", { field: "day" });
  const today = Date.parse(`${serverDay(now)}T00:00:00Z`);
  if (t > today || t < today - SECURITY_DAY_SLACK * DAY_MS) fail("invalid_argument", { field: "day" });
  if (d.permissionDenials.length > MAX_PERMISSION_DENIALS) fail("invalid_argument", { field: "permissionDenials" });
  return {
    day: d.day,
    blocked: {
      appLocker: counter(d.blocked.appLocker, "blocked.appLocker"),
      appControl: counter(d.blocked.appControl, "blocked.appControl"),
      procWatch: counter(d.blocked.procWatch, "blocked.procWatch"),
      elevation: counter(d.blocked.elevation, "blocked.elevation"),
    },
    permissionDenials: mergeDenials(
      d.permissionDenials
        .filter((p) => PERMISSION_KINDS.includes(p.kind) && cleanId(p.appId) !== undefined)
        .map((p) => ({ appId: p.appId, kind: p.kind, count: counter(p.count, "permissionDenials.count") })),
      MAX_PERMISSION_DENIALS,
    ),
    drift: counter(d.drift, "drift"),
    tamper: counter(d.tamper, "tamper"),
  };
}

export function isZeroDaily(d: DailyIn): boolean {
  const b = d.blocked;
  return b.appLocker + b.appControl + b.procWatch + b.elevation === 0 && d.permissionDenials.length === 0 && d.drift === 0 && d.tamper === 0;
}

/** Add equal (app, kind) rows; keep the `cap` largest. Deterministic order: count desc, then app, then kind. */
export function mergeDenials(rows: PermissionDenialValue[], cap: number): PermissionDenialValue[] {
  const map = new Map<string, PermissionDenialValue>();
  for (const r of rows) {
    const key = `${r.appId}\u0000${r.kind}`;
    const have = map.get(key);
    if (have === undefined) map.set(key, { ...r });
    else have.count = Math.min(MAX_COUNTER, have.count + r.count);
  }
  return [...map.values()]
    .sort((a, b) => b.count - a.count || (a.appId < b.appId ? -1 : a.appId > b.appId ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
    .slice(0, cap);
}

export const ORG_DENIAL_CAP = MAX_ORG_PERMISSION_DENIALS;

export function addBlocked(a: BlockedCountsValue, b: BlockedCountsValue): BlockedCountsValue {
  return {
    appLocker: Math.min(MAX_COUNTER * 1000, a.appLocker + b.appLocker),
    appControl: Math.min(MAX_COUNTER * 1000, a.appControl + b.appControl),
    procWatch: Math.min(MAX_COUNTER * 1000, a.procWatch + b.procWatch),
    elevation: Math.min(MAX_COUNTER * 1000, a.elevation + b.elevation),
  };
}
