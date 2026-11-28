/**
 * Demo twin of `convex/lockdown.ts`, `fleet:allowUsb` and the lockdown parts of `fleet:page` / `overview:get` (Phase 5 Step 19).
 * Same rules as the server: roles, the revision check, the conditional fresh step-up of a mode change, the refusal codes.
 */
import { useCallback } from "react";
import type { LockdownApi } from "../lockdown/api";
import type { DbDevice, DemoDb } from "../fixtures/seed";
import {
  DEFAULT_LOCKDOWN_SETTINGS,
  MAX_ALLOW_GROUPS,
  MAX_EXCEPTION_REASON,
  MAX_LOCKOUT_MINUTES,
  MAX_LOCKOUT_THRESHOLD,
  MAX_USB_ALLOW_HOURS,
  MIN_LOCKOUT_THRESHOLD,
  OPEN_FINDINGS_CAP,
  type DevicePage,
  type ExceptionRow,
  type FindingRow,
  type LockdownSettings,
  type LockdownSync,
  type LockdownView,
  type LockdownWarnings,
} from "../types";
import { allowKinds, changedLayers, folderProblem, sameSettings } from "../../screens/lockdown/rules";
import { byKey, useDemoServerPage } from "./lists";
import { currentMember, db as getDb, fail, newId, onDemoReset, runMutation, touch, useDemoQuery } from "./store";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MAX_EXCEPTIONS_LISTED = 50;
const MAX_GROUP_EXCEPTIONS = 200;
const AUDIT_WARN_DAYS = 14;
const WARNING_ROWS = 3;

function requireReader() {
  const me = currentMember();
  if (!me) fail("unauthenticated");
  if (me.status === "disabled") fail("forbidden");
  return me;
}

function requireAdmin() {
  const me = requireReader();
  if (me.role !== "admin" && me.role !== "owner") fail("forbidden");
}

function find<T extends { _id: string }>(list: T[], id: string): T {
  const row = list.find((x) => x._id === id);
  if (!row) fail("not_found");
  return row;
}

const settingsOf = (db: DemoDb, groupId: string): LockdownSettings => db.lockdown.get(groupId)?.settings ?? DEFAULT_LOCKDOWN_SETTINGS;
const anyAudit = (s: LockdownSettings) => s.appLocker.mode === "audit" || s.appControl.mode === "audit" || s.procWatch.mode === "audit";
const whole = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;

/**
 * A new configuration version for the group (what `snapshotGroupConfig` does): the rollout screen lists it. A group without a rollout
 * row gets one (rings off, version 1), like the server's first snapshot. The PCs "catch up" one by one afterwards (`scheduleCatchUp`).
 */
function newConfigVersion(db: DemoDb, groupId: string, reason: string, now: number) {
  const r = db.rollouts.get(groupId);
  if (!r) {
    db.rollouts.set(groupId, {
      enabled: false,
      pointers: { pilot: 1, early: 1, everyone: 1 },
      autoPromote: { enabled: false, bakeHours: 24, maxFailurePct: 10 },
      autoRollback: true,
      state: "idle",
      haltReason: null,
      stageStartedAt: null,
      revision: 1,
      versions: [{ version: 1, reason, createdAt: now }],
    });
    scheduleCatchUp(groupId);
    return;
  }
  const version = Math.max(...r.versions.map((v) => v.version), r.pointers.pilot) + 1;
  r.versions = [{ version, reason, createdAt: now }, ...r.versions].slice(0, 20);
  if (r.enabled) {
    r.pointers = { ...r.pointers, pilot: version };
    if (r.state !== "halted") r.state = "rolling";
    r.stageStartedAt = now;
  } else {
    r.pointers = { pilot: version, early: version, everyone: version };
  }
  r.revision++;
  scheduleCatchUp(groupId);
}

// ---------------------------------------------------------------- "PCs up to date" (`lockdown:groupSync`)

/** Same cap as `LOCKDOWN_SYNC_CAP` on the server. */
const SYNC_CAP = 200;
const SYNC_PROBLEM_NAMES = 3;
const CATCH_UP_MS = 1200;
/** `admin_tiles_skipped`: the agent since 2026-11-28 (machine layer `ok`); `admin_signin_unverified`: older agents. Same set as `convex/lib/lockdownSync.ts`. */
const ADMIN_TILES_CODES: ReadonlySet<string> = new Set(["admin_tiles_skipped", "admin_signin_unverified"]);
const newestOf = (p: { pilot: number; early: number; everyone: number }) => Math.max(p.pilot, p.early, p.everyone);

/** The same rules as the server: the group's PCs and their reports at or above the newest configuration version. */
export function lockdownSyncOf(db: DemoDb, groupId: string): LockdownSync {
  const g = find(db.groups, groupId);
  const rollout = db.rollouts.get(g._id) ?? null;
  const pcs = db.devices.filter((d) => d.groupId === g._id);
  const members = pcs.slice(0, SYNC_CAP);
  const out: LockdownSync = {
    total: members.length,
    totalMore: pcs.length > SYNC_CAP,
    upToDate: 0,
    problems: 0,
    problemPcs: [],
    reduced: 0,
    adminTilesPending: 0,
    newestVersion: rollout === null ? null : newestOf(rollout.pointers),
    ringsOn: rollout?.enabled ?? false,
    rolloutState: rollout?.state ?? "idle",
  };
  if (out.newestVersion === null) return out;
  for (const pc of members) {
    const r = db.applyDetails.get(pc._id);
    if (r === undefined || r.configVersion === null || r.configVersion < out.newestVersion) continue;
    if (r.state === "applied" || r.state === "partial") out.upToDate++;
    else {
      out.problems++;
      if (out.problemPcs.length < SYNC_PROBLEM_NAMES) out.problemPcs.push({ deviceId: pc._id, name: pc.name, state: r.state });
    }
    if (r.layers.appLocker.state === "unsupported" || r.layers.appControl.state === "unsupported") out.reduced++;
    if (ADMIN_TILES_CODES.has(r.layers.machine.detail ?? "") || ADMIN_TILES_CODES.has(r.refusal ?? "")) out.adminTilesPending++;
  }
  return out;
}

const catchUps = new Map<string, ReturnType<typeof setTimeout>>();
onDemoReset(() => {
  for (const timer of catchUps.values()) clearTimeout(timer);
  catchUps.clear();
});

/**
 * After a save the group's PCs pick the new settings up, one every 1.2 s (the demo has no agents): a PC that did not refuse, fail or
 * roll back, is not revoked, and whose ring already follows the newest version gets a report at that version. The screen shows the
 * counter go 0 -> m. One timer chain per group; a second save while it runs keeps it running (the target is read at every tick).
 */
function scheduleCatchUp(groupId: string) {
  if (catchUps.has(groupId)) return;
  const tick = () => {
    catchUps.delete(groupId);
    const db = getDb();
    const rollout = db.rollouts.get(groupId);
    if (rollout === undefined) return;
    const newest = newestOf(rollout.pointers);
    const next = db.devices.find((d) => {
      if (d.groupId !== groupId || d.revoked || db.oldAgents.has(d._id)) return false;
      if (rollout.pointers[d.ring ?? "everyone"] < newest) return false; // its ring waits for the promotion
      const r = db.applyDetails.get(d._id);
      if (r === undefined) return true;
      if (r.state === "refused" || r.state === "failed" || r.state === "rolledBack") return false;
      return (r.configVersion ?? 0) < newest;
    });
    if (next === undefined) return;
    const now = Date.now();
    const old = db.applyDetails.get(next._id);
    const ok = { mode: "on", state: "ok" };
    db.applyDetails.set(next._id, {
      state: "applied",
      refusal: null,
      appliedVersion: newest,
      lkgVersion: newest,
      layers: { staff: ok, machine: ok, appLocker: ok, appControl: ok, procWatch: ok, boot: ok, performance: ok },
      ...old,
      configVersion: newest,
      updatedAt: now,
    });
    touch();
    catchUps.set(groupId, setTimeout(tick, CATCH_UP_MS));
  };
  catchUps.set(groupId, setTimeout(tick, CATCH_UP_MS));
}

function viewOf(db: DemoDb, groupId: string): LockdownView {
  const g = find(db.groups, groupId);
  const row = db.lockdown.get(g._id);
  const all = db.exceptions.filter((e) => e.groupId === g._id).sort((a, b) => b.createdAt - a.createdAt);
  const open = db.findings.filter((f) => f.status === "new").length;
  return {
    groupName: g.name,
    settings: settingsOf(db, g._id),
    revision: row?.revision ?? 0,
    auditSince: row?.auditSince ?? null,
    exceptions: all.slice(0, MAX_EXCEPTIONS_LISTED).map((e): ExceptionRow => ({ _id: e._id, rule: e.rule, appName: e.appName, reason: e.reason, createdAt: e.createdAt })),
    exceptionsTruncated: all.length > MAX_EXCEPTIONS_LISTED,
    openFindings: Math.min(open, OPEN_FINDINGS_CAP),
    openFindingsMore: open > OPEN_FINDINGS_CAP,
  };
}

/** The lockdown fields of `fleet:page` (the Protection tab reads them from the page). */
export function deviceLockdownOf(db: DemoDb, d: DbDevice): Pick<DevicePage, "ring" | "usbAllowUntil" | "protection" | "lockdownCapable" | "apply"> {
  const apply = db.applyDetails.get(d._id) ?? null;
  const reported = db.reports.has(d._id);
  return {
    ring: d.ring ?? "everyone",
    usbAllowUntil: db.usbAllow.get(d._id) ?? null,
    protection: db.postures.get(d._id) ?? null,
    lockdownCapable: !reported && apply === null ? null : !db.oldAgents.has(d._id),
    apply,
  };
}

/** The lockdown warnings of `overview:get`: three rows each, like the server. */
export function lockdownWarningsOf(db: DemoDb, now: number): LockdownWarnings {
  const cut = Math.floor(now / DAY) * DAY - AUDIT_WARN_DAYS * DAY;
  const overdue = db.groups.flatMap((g) => {
    const since = db.lockdown.get(g._id)?.auditSince ?? null;
    return since !== null && since < cut ? [{ groupId: g._id, name: g.name, since }] : [];
  });
  const halted = db.groups.filter((g) => db.rollouts.get(g._id)?.state === "halted").map((g) => ({ groupId: g._id, name: g.name }));
  const notApplied = db.devices.flatMap((d) => {
    const a = db.applyDetails.get(d._id);
    return a && (a.state === "refused" || a.state === "rolledBack") ? [{ deviceId: d._id, name: d.name, state: a.state, refusal: a.refusal }] : [];
  });
  return {
    auditOverdue: overdue.slice(0, WARNING_ROWS),
    auditOverdueMore: overdue.length > WARNING_ROWS,
    halted: halted.slice(0, WARNING_ROWS),
    haltedMore: halted.length > WARNING_ROWS,
    notApplied: notApplied.slice(0, WARNING_ROWS),
    notAppliedMore: notApplied.length > WARNING_ROWS,
  };
}

export const demoLockdownApi: LockdownApi = {
  useLockdownView(groupId) {
    return useDemoQuery(`lockdown:groupView:${groupId}`, (db) => {
      requireReader();
      return viewOf(db, groupId);
    });
  },

  // `lockdown:groupSync`: its own query, so the form does not re-run while PCs report.
  useLockdownSync(groupId) {
    return useDemoQuery(`lockdown:groupSync:${groupId}`, (db) => {
      requireReader();
      return lockdownSyncOf(db, groupId);
    });
  },

  // A mode change (or the App Control level) is a major action on the server: fresh step-up. The other switches: unlocked.
  useSaveLockdown() {
    return useCallback(({ groupId, settings, expectedRevision }) => {
      const current = getDb().groups.some((g) => g._id === groupId) ? settingsOf(getDb(), groupId) : settings;
      const major = changedLayers(current, settings).length > 0 || current.appControl.level !== settings.appControl.level;
      return runMutation(
        "admin",
        ({ db, audit, now }) => {
          const g = find(db.groups, groupId);
          const row = db.lockdown.get(g._id);
          if ((row?.revision ?? 0) !== expectedRevision) fail("stale_edit");
          const l = settings.machine.accountLockout;
          if (l !== null) {
            if (!whole(l.threshold, MIN_LOCKOUT_THRESHOLD, MAX_LOCKOUT_THRESHOLD)) fail("invalid_argument", { field: "accountLockout.threshold" });
            if (!whole(l.durationMin, 1, MAX_LOCKOUT_MINUTES)) fail("invalid_argument", { field: "accountLockout.durationMin" });
            if (!whole(l.windowMin, 1, l.durationMin)) fail("invalid_argument", { field: "accountLockout.windowMin" });
          }
          const before = settingsOf(db, g._id);
          if (sameSettings(before, settings)) return { revision: row?.revision ?? 0 };
          if (settings.wifiManagedOnly && !before.wifiManagedOnly && !db.wifi.some((w) => w.groupIds.includes(g._id))) {
            fail("conflict", { detail: "managed_networks_empty" });
          }
          const revision = (row?.revision ?? 0) + 1;
          db.lockdown.set(g._id, { settings, revision, auditSince: anyAudit(settings) ? (row?.auditSince ?? now) : null });
          newConfigVersion(db, g._id, "Lockdown settings changed", now);
          const target = { targetType: "group", targetId: g._id, targetLabel: g.name };
          if (major) {
            audit({
              ...target,
              action: "lockdown.layerModeChanged",
              summary: `Changed the program rules of the group ${g.name} (AppLocker ${settings.appLocker.mode}, App Control ${settings.appControl.mode}, process watch ${settings.procWatch.mode})`,
            });
          }
          const rest = (s: LockdownSettings) => ({ ...s, appLocker: null, appControl: null, procWatch: null });
          if (JSON.stringify(rest(before)) !== JSON.stringify(rest(settings))) {
            audit({ ...target, action: "lockdown.settingsChanged", summary: `Changed the lockdown settings of the group ${g.name}` });
          }
          return { revision };
        },
        major ? "fresh" : "unlocked",
      );
    }, []);
  },

  // `lockdown:findings`: one status, sort key "seen" only (either direction).
  useFindingsPage({ status, ...query }) {
    return useDemoServerPage("lockdown:findings", `findings:${status}`, query, (db, sort) => {
      requireReader();
      if (sort !== undefined && sort.key !== "seen") fail("invalid_argument", { field: "sort" });
      return db.findings.filter((f) => f.status === status).sort(byKey((f: FindingRow) => f.lastSeenAt, sort?.dir ?? "desc"));
    });
  },

  useAllowOptions() {
    return useDemoQuery("lockdown:allowOptions", (db) => {
      requireAdmin();
      const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
      return {
        groups: db.groups.map((g) => ({ _id: g._id, name: g.name })).sort(byName),
        apps: db.apps.filter((a) => !a.archived && a.kind === "desktop").map((a) => ({ _id: a._id, name: a.name })).sort(byName),
      };
    });
  },

  useAllowFinding() {
    return useCallback(
      ({ findingId, kind, folder, groupIds, appId, reason }) =>
        runMutation("admin", ({ db, audit, now }) => {
          const f = find(db.findings, findingId);
          if (f.layer === "appControl") fail("conflict", { detail: "app_control_finding" });
          const ids = [...new Set(groupIds)];
          if (ids.length === 0) fail("invalid_argument", { field: "groupIds" });
          if (ids.length > MAX_ALLOW_GROUPS) fail("too_large", { detail: "groups" });
          const note = (reason ?? "").trim();
          if (note.length > MAX_EXCEPTION_REASON) fail("invalid_argument", { field: "reason" });
          const possible = allowKinds(f);
          if (kind === "publisher" && !possible.includes("publisher")) fail("conflict", { detail: "no_signer" });
          if (kind === "hash" && !possible.includes("hash")) fail("conflict", { detail: "no_hash" });
          if (kind === "path") {
            if (!possible.includes("path")) fail("conflict", { detail: "path_not_admin_only" });
            if (folder === undefined || folderProblem(folder) || !/\.exe$/i.test(f.fileName)) fail("invalid_argument", { field: "folder" });
          }
          const rule: ExceptionRow["rule"] = {
            kind,
            subject: kind === "publisher" ? f.signer : null,
            product: kind === "publisher" ? f.product : null,
            fileName: kind === "publisher" ? f.fileName : null,
            // The demo has no real hash: a stand-in that is stable per finding.
            hashStart: kind === "hash" ? `${f._id.replace(/[^0-9a-f]/gi, "").padEnd(12, "0").slice(0, 12)}` : null,
            path: kind === "path" ? `${(folder ?? "").trim().replace(/\\+$/, "")}\\${f.fileName}` : null,
          };
          const app = appId === undefined ? null : find(db.apps, appId);
          const groups = ids.map((id) => find(db.groups, id));
          const added = [];
          for (const g of groups) {
            const have = db.exceptions.filter((e) => e.groupId === g._id);
            if (have.some((e) => JSON.stringify(e.rule) === JSON.stringify(rule))) continue;
            if (have.length >= MAX_GROUP_EXCEPTIONS) fail("too_large", { detail: "exceptions" });
            db.exceptions.push({ _id: newId("exc"), groupId: g._id, findingId: f._id, rule, appName: app?.name ?? null, reason: note, createdAt: now });
            newConfigVersion(db, g._id, "Exception added", now);
            added.push(g);
          }
          f.status = "allowed";
          const first = added[0];
          if (first) {
            audit({
              action: "lockdown.exceptionAdded",
              targetType: "group",
              targetId: first._id,
              targetLabel: first.name,
              summary: added.length === 1 ? `Allowed the program ${f.fileName} for the group ${first.name} (${kind} rule)` : `Allowed the program ${f.fileName} for ${added.length} groups (${kind} rule)`,
            });
          }
          return { added: added.length };
        }),
      [],
    );
  },

  useIgnoreFinding() {
    return useCallback(
      ({ findingId }) =>
        runMutation("admin", ({ db, audit }) => {
          const f = find(db.findings, findingId);
          if (f.status === "ignored") return;
          if (f.status === "allowed") fail("conflict", { detail: "already_allowed" });
          f.status = "ignored";
          audit({ action: "lockdown.findingIgnored", targetType: "finding", targetId: f._id, targetLabel: f.fileName, summary: `Ignored the blocked program ${f.fileName}` });
        }),
      [],
    );
  },

  useRemoveException() {
    return useCallback(
      ({ exceptionId }) =>
        runMutation("admin", ({ db, audit, now }) => {
          const e = find(db.exceptions, exceptionId);
          db.exceptions = db.exceptions.filter((x) => x._id !== e._id);
          if (e.findingId !== undefined && !db.exceptions.some((x) => x.findingId === e.findingId)) {
            const f = db.findings.find((x) => x._id === e.findingId);
            if (f && f.status === "allowed") f.status = "new";
          }
          newConfigVersion(db, e.groupId, "Exception removed", now);
          const g = db.groups.find((x) => x._id === e.groupId);
          audit({
            action: "lockdown.exceptionRemoved",
            targetType: "group",
            targetId: e.groupId,
            targetLabel: g?.name,
            summary: `Removed the exception for ${e.rule.fileName ?? e.rule.path?.split("\\").pop() ?? "a program"} (${e.rule.kind} rule)${g ? ` from the group ${g.name}` : ""}`,
          });
        }),
      [],
    );
  },

  // `fleet:allowUsb`: whole hours 1..8; 0 ends it; a revoked PC is refused.
  useAllowUsb() {
    return useCallback(
      ({ deviceId, hours }) =>
        runMutation("admin", ({ db, audit, now }) => {
          if (!whole(hours, 0, MAX_USB_ALLOW_HOURS)) fail("invalid_argument", { field: "hours" });
          const d = find(db.devices, deviceId);
          if (d.revoked) fail("conflict", { detail: "device revoked" });
          const open = (db.usbAllow.get(d._id) ?? 0) > now;
          if (hours === 0 && !open) return { until: null };
          const until = hours === 0 ? null : now + hours * HOUR;
          if (until === null) db.usbAllow.delete(d._id);
          else db.usbAllow.set(d._id, until);
          audit({
            action: "device.usbTempAllow",
            targetType: "device",
            targetId: d._id,
            targetLabel: d.name,
            summary: hours === 0 ? `Ended the USB allowance on the PC ${d.name}` : `Allowed USB devices on the PC ${d.name} for ${hours} h`,
          });
          return { until };
        }),
      [],
    );
  },
};
