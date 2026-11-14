/**
 * Demo implementation of every data hook (`VITE_DEMO=1`). Each query hook
 * computes exactly what its Convex function will return; each mutation
 * applies the server's rules (roles, revisions, uniqueness, dependents) so
 * the screens' error paths can be exercised without a backend.
 */
import { useCallback, useEffect, useState } from "react";
import type { DataApi } from "../api";
import type { AppsApi } from "../apps/api";
import type { AuditApi } from "../audit/api";
import type { DevicesApi } from "../devices/api";
import type { EmployeesApi } from "../employees/api";
import type { EnrollmentApi } from "../enrollment/api";
import {
  type DbApp,
  type DbDevice,
  type DbPrinter,
  type DbWifi,
  type DemoDb,
} from "../fixtures/seed";
import {
  INSTALL_STATES,
  NEW_WEB_APP_PERMISSIONS,
  NO_GROUP_FILTER,
  WEB_PERMISSION_KEYS,
  type AppDetail,
  type AppKind,
  type AppOption,
  type AppRow,
  type AssignmentRow,
  type AuditEntry,
  type DevicePresence,
  type DeviceRow,
  type EmployeeDetail,
  type EmployeeRow,
  type EnrollmentCodeRow,
  type GroupOption,
  type InstallCounts,
  type InstallState,
  type InstallSummary,
  type Me,
  type MeResult,
  type NetworksScreen,
  type PrinterDetail,
  type PrinterRow,
  type OverviewScreen,
  type WifiApplyCounts,
  type WifiDetail,
  type WifiRow,
} from "../types";
import type { ServerList } from "../serverList";
import { byKey, contains, relevance, useDemoServerPage } from "./lists";
import * as validate from "../../lib/validate";
import { MAX_WIFI_GROUPS_PER_SAVE, MAX_WIFI_NAME, MAX_WIFI_PROFILES, WIFI_SECURITIES, passphraseProblem, ssidProblem } from "../../lib/wifiRules";
import { MAX_PRINTERS, PRINTER_KINDS, addressProblem, driverChoices, portProblem, printerNameProblem, queueProblem } from "../../lib/printerRules";
import {
  bumpFailedSignIns,
  checkRevision,
  clearFailedSignIns,
  controls,
  currentMember,
  db as getDb,
  fail,
  hasPin,
  latency,
  newId,
  runMutation,
  runOptimistic,
  session,
  setSession,
  sleep,
  startHeartbeats,
  useDemoQuery,
  useStoreVersion,
} from "./store";

const SERVER_API_VERSION = 1;
const NO_FAILED: ServerList<never> = { status: "ready", items: [], isDone: true, continueCursor: "", total: 0, busy: false };
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

// ---------------------------------------------------------------- projections

const byNewest = <T extends { at: number }>(a: T, b: T) => b.at - a.at;

function groupName(db: DemoDb, id?: string) {
  return id ? db.groups.find((g) => g._id === id)?.name : undefined;
}

function groupOptions(db: DemoDb): GroupOption[] {
  return db.groups
    .map((g) => ({ _id: g._id, name: g.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 500);
}

function wifiRow(db: DemoDb, w: DbWifi): WifiRow {
  return {
    _id: w._id,
    name: w.name,
    ssid: w.ssid,
    hidden: w.hidden,
    security: w.security,
    autoConnect: w.autoConnect,
    hasPassphrase: w.hasPassphrase,
    passphraseSetAt: w.passphraseSetAt,
    revision: w.revision,
    groupCount: w.groupIds.length,
    // Like the server: the first 10 only (the detail page's picker has the full list).
    groups: w.groupIds.map((id) => ({ _id: id, name: groupName(db, id) ?? "" })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 10),
  };
}

/** What `networks:wifiDetail` counts: the PCs of the assigned groups (first 200 per group), by what they report. Demo: derived, never random. */
function wifiCounts(db: DemoDb, w: DbWifi): WifiApplyCounts {
  const WIFI_COUNT_PER_GROUP = 200;
  let sampled = 0;
  let capped = false;
  for (const g of w.groupIds) {
    const n = db.devices.filter((d) => d.groupId === g && !d.revoked).length;
    sampled += Math.min(n, WIFI_COUNT_PER_GROUP);
    capped ||= n > WIFI_COUNT_PER_GROUP;
  }
  const needsKey = w.security !== "open" && !w.hasPassphrase;
  const waiting = needsKey ? sampled : 0;
  const unsupported = needsKey ? 0 : Math.floor(sampled / 10);
  const failed = needsKey ? 0 : sampled >= 5 ? 1 : 0;
  return { applied: sampled - waiting - unsupported - failed, failed, waiting, unsupported, sampled, capped };
}

/** The first 10 group names of a printer, like the server (the detail page's picker has the full list). */
function printerRow(db: DemoDb, p: DbPrinter): PrinterRow {
  return {
    _id: p._id,
    name: p.name,
    kind: p.kind,
    address: p.address,
    port: p.port,
    queue: p.queue,
    driver: p.driver,
    revision: p.revision,
    groupCount: p.groupIds.length,
    defaultGroupCount: p.defaultForGroupIds.length,
    groups: p.groupIds.map((id) => ({ _id: id, name: groupName(db, id) ?? "" })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 10),
  };
}

/** What `networks:printerDetail` counts: derived from the PCs of the assigned groups, never random (a demo has no apply reports). */
function printerCounts(db: DemoDb, p: DbPrinter): WifiApplyCounts {
  const PER_GROUP = 200;
  let sampled = 0;
  let capped = false;
  for (const g of p.groupIds) {
    const n = db.devices.filter((d) => d.groupId === g && !d.revoked).length;
    sampled += Math.min(n, PER_GROUP);
    capped ||= n > PER_GROUP;
  }
  const failed = sampled >= 5 ? 1 : 0;
  return { applied: sampled - failed, failed, waiting: 0, unsupported: 0, sampled, capped };
}

function canOpenFiles(a: DbApp) {
  return a.kind === "desktop" && (a.desktop?.fileArgTemplate.length ?? 0) > 0;
}

function appOptions(db: DemoDb): AppOption[] {
  return db.apps
    .filter((a) => !a.archived)
    .map((a) => ({ _id: a._id, name: a.name, kind: a.kind, canOpenFiles: canOpenFiles(a) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function latestVersion(db: DemoDb, deviceId: string) {
  return db.versions.get(deviceId)?.[0]?.version;
}

/** `devicePresence`: a transition, not a timestamp (an online PC's `since` is not shown). */
function devicePresence(db: DemoDb, d: DbDevice): DevicePresence {
  if (!d.revoked && db.onlineIds.has(d._id)) return { online: true, since: d.enrolledAt };
  return { online: false, since: db.lastSeen.get(d._id) ?? null };
}

function deviceRow(db: DemoDb, d: DbDevice): DeviceRow {
  const r = db.reports.get(d._id);
  return {
    _id: d._id,
    name: d.name,
    groupId: d.groupId,
    groupName: groupName(db, d.groupId),
    revoked: d.revoked,
    kioskEnabled: d.kioskEnabled,
    enrolledAt: d.enrolledAt,
    presence: devicePresence(db, d),
    report: r
      ? {
          agentVersion: r.agentVersion,
          osBuild: r.osBuild,
          osEdition: r.osEdition,
          kioskPhase: r.kioskPhase,
          kioskError: r.kioskError,
          appliedVersion: r.appliedVersion,
          outOfSupport: r.outOfSupport,
        }
      : null,
    latestVersion: latestVersion(db, d._id),
    planState: planState(db, d),
  };
}

/** The head's plan state: a suspended organization suspends every PC; otherwise what the fixture says (null = never published). */
function planState(db: DemoDb, d: DbDevice): DeviceRow["planState"] {
  if (d.revoked) return null;
  return db.org.plan.status !== "active" ? "suspended" : (d.planState ?? "ok");
}

function employeeRow(db: DemoDb, e: DemoDb["employees"][number]): EmployeeRow {
  const gids = db.groupMembers.filter((m) => m.employeeId === e._id).map((m) => m.groupId);
  const groups = gids
    .map((id) => ({ _id: id, name: groupName(db, id) ?? "" }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    _id: e._id,
    name: e.name,
    username: e.username,
    quotaGb: e.quotaGb,
    disabled: e.disabled,
    groups: groups.slice(0, 5),
    moreGroups: groups.length > 5,
  };
}

const IN_PROGRESS: InstallState[] = ["pending", "downloading", "installing", "removing"];

/** Like `apps:list`: reads at most 10 assignments per app and says when there are more ("10+"). */
function appGroupCount(total: number): { groupCount: number; groupCountMore: boolean } {
  return { groupCount: Math.min(total, 10), groupCountMore: total > 10 };
}

function installSummary(db: DemoDb, appId: string): InstallSummary | null {
  const rows = db.installs.filter((i) => i.appId === appId);
  if (rows.length === 0) return null;
  const cap = (n: number) => Math.min(n, 1001);
  return {
    installed: cap(rows.filter((r) => r.state === "installed").length),
    failed: cap(rows.filter((r) => r.state === "failed").length),
    inProgress: cap(rows.filter((r) => IN_PROGRESS.includes(r.state)).length),
  };
}

function assignmentRow(db: DemoDb, a: DemoDb["assignments"][number]): AssignmentRow & { groupId: string; groupName: string } {
  const app = db.apps.find((x) => x._id === a.appId);
  return {
    _id: a._id,
    appId: a.appId,
    appName: app?.name ?? "",
    appKind: app?.kind ?? "web",
    hue: app?.hue,
    audience: a.audience,
    pinnedTaskbar: a.pinnedTaskbar,
    pinnedDesktop: a.pinnedDesktop,
    groupId: a.groupId,
    groupName: groupName(db, a.groupId) ?? "",
  };
}

function auditEntry(e: DemoDb["audit"][number]): AuditEntry {
  return { ...e };
}

function codeState(t: DemoDb["tokens"][number], now: number): EnrollmentCodeRow["state"] {
  if (t.revoked) return "revoked";
  if (t.usesLeft <= 0) return "usedUp";
  if (t.expiresAt <= now) return "expired";
  return "active";
}

function requireReader() {
  const me = currentMember();
  if (!me) fail("unauthenticated");
  if (me.status === "disabled") fail("forbidden");
  return me;
}

function requireAdmin() {
  const me = requireReader();
  if (me.role !== "admin" && me.role !== "owner") fail("forbidden");
  return me;
}

function find<T extends { _id: string }>(list: T[], id: string): T {
  const row = list.find((x) => x._id === id);
  if (!row) fail("not_found");
  return row;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function token(len: number) {
  let s = "";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  for (const b of bytes) s += CROCKFORD[b % 32];
  return s;
}

function base64Url(text: string) {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function nameOrFail(value: string, max: number, field = "name") {
  if (validate.name(value, max)) fail("invalid_argument", { field });
  return value.trim();
}

/** Groups `normalizeDescription`: trimmed, at most 300; "" = none. */
function descriptionOrFail(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (validate.description(value, validate.NAME_MAX.description)) fail("invalid_argument", { field: "description" });
  return value.trim() || undefined;
}

// ---------------------------------------------------------------- session

let booted = false;

function useBoot() {
  const [ready, setReady] = useState(booted);
  useEffect(() => {
    startHeartbeats();
    if (booted) return;
    const t = setTimeout(() => {
      booted = true;
      setReady(true);
    }, 300);
    return () => clearTimeout(t);
  }, []);
  return ready;
}

function meOf(): MeResult {
  const s = session();
  const m = currentMember();
  if (!s || !m) return null;
  if (m.status === "disabled") return { noAccess: true, serverApiVersion: SERVER_API_VERSION };
  const me: Me = {
    email: m.email,
    role: m.role,
    status: m.status,
    orgId: getDb().org._id,
    orgName: getDb().org.name,
    // Every member needs a PIN (Phase 4b); `set` follows the demo factors, so PIN setup shows until one exists.
    pin: { required: true, set: hasPin(m._id) },
    serverApiVersion: SERVER_API_VERSION,
  };
  return me;
}

// ---------------------------------------------------------------- the hooks

export const demoApi: DataApi = {
  useAuthState() {
    useStoreVersion();
    const ready = useBoot();
    return { isLoading: !ready, isAuthenticated: session() !== null };
  },

  useMe() {
    useStoreVersion();
    const ready = useBoot();
    return ready ? meOf() : undefined;
  },

  useAuthActions() {
    return {
      signIn: async ({ email, password }) => {
        await sleep(latency());
        if (bumpFailedSignIns() > 6) fail("rate_limited");
        const m = getDb().members.find((x) => x.email === email.trim().toLowerCase());
        if (!m || m.password !== password) throw new Error("InvalidSecret");
        if (m.status === "disabled") fail("account_disabled");
        clearFailedSignIns();
        setSession({ memberId: m._id, createdAt: Date.now() });
      },
      signUp: async ({ inviteCode, email, password }) => {
        await sleep(latency());
        const db = getDb();
        const addr = email.trim().toLowerCase();
        const inv = db.invites.find(
          (i) => i.kind === "join" && i.code === inviteCode.trim().toUpperCase() && i.email === addr && !i.usedAt && i.expiresAt > Date.now(),
        );
        if (!inv) fail("invite_invalid");
        if (validate.memberPassword(password)) fail("invalid_argument", { field: "password" });
        if (db.members.some((m) => m.email === addr)) fail("invite_invalid");
        inv.usedAt = Date.now();
        const id = newId("mem");
        db.members.push({
          _id: id,
          email: addr,
          role: inv.role,
          status: "active",
          createdAt: Date.now(),
          revision: 0,
          password,
        });
        db.audit.push({
          _id: newId("aud"),
          at: Date.now(),
          actorType: "member",
          actorId: id,
          actorLabel: addr,
          action: "member.joined",
          summary: `Joined as ${inv.role}.`,
        });
        setSession({ memberId: id, createdAt: Date.now() });
      },
      signOut: async () => {
        setSession(null);
      },
    };
  },

  useRedeemReset() {
    return async ({ email, code, newPassword }) => {
      await sleep(latency());
      const db = getDb();
      const addr = email.trim().toLowerCase();
      const inv = db.invites.find(
        (i) => i.kind === "passwordReset" && i.code === code.trim().toUpperCase() && i.email === addr && !i.usedAt && i.expiresAt > Date.now(),
      );
      if (!inv) fail("invite_invalid");
      if (validate.memberPassword(newPassword)) fail("invalid_argument", { field: "password" });
      const m = db.members.find((x) => x.email === addr);
      if (!m) fail("invite_invalid");
      m.password = newPassword;
      inv.usedAt = Date.now();
    };
  },

  useConnectionState() {
    useStoreVersion();
    return { isWebSocketConnected: !controls().offline };
  },

  // ---- overview
  useOverview() {
    return useDemoQuery("overview:get", (db): OverviewScreen => {
      requireReader();
      const live = db.devices.filter((d) => !d.revoked);
      const active = db.keys.some((k) => k.status === "active");
      const next = db.keys.some((k) => k.status === "next");
      return {
        counts: {
          deviceCount: live.length,
          employeeCount: db.employees.length,
          appCount: db.apps.filter((a) => !a.archived).length,
          groupCount: db.groups.length,
          noGroupDeviceCount: live.filter((d) => !d.groupId).length,
          outOfSupportCount: live.filter((d) => db.reports.get(d._id)?.outOfSupport === true).length,
          failedInstallCount: db.installs.filter((i) => i.state === "failed").length,
        },
        onlineCount: live.filter((d) => db.onlineIds.has(d._id)).length,
        plan: { name: db.org.plan.plan, status: db.org.plan.status, limits: db.org.plan.limits },
        signing: !active ? "none" : next ? "rotating" : "active",
        publishFailedAt: db.publishFailedAt ?? null,
        rosterPending: db.rosterPending === true,
        recentAudit: [...db.audit].sort(byNewest).slice(0, 10).map(auditEntry),
      };
    });
  },

  // `overview:failedInstallsPage`: sort key "updated" only; the total is `overview:get`'s `failedInstallCount`.
  useFailedInstallsPage({ enabled, ...query }) {
    const page = useDemoServerPage("overview:failedInstallsPage", `failed:${enabled}`, query, (db, sort) => {
      requireReader();
      if (!enabled) return [];
      return db.installs
        .filter((i) => i.state === "failed")
        .sort(byKey((i) => i.updatedAt, sort?.dir ?? "desc"))
        .map((i) => ({
          _id: i._id,
          deviceId: i.deviceId,
          deviceName: db.devices.find((d) => d._id === i.deviceId)?.name ?? "",
          appId: i.appId,
          appName: db.apps.find((a) => a._id === i.appId)?.name ?? "",
          detail: i.detail,
          updatedAt: i.updatedAt,
        }));
    });
    return enabled ? page : NO_FAILED;
  },

  // ---- devices (the paginated lists: `demoDevicesApi` below)
  useDeviceDetail(deviceId) {
    return useDemoQuery(`fleet:get:${deviceId}`, (db) => {
      requireReader();
      const d = find(db.devices, deviceId);
      const g = d.groupId ? db.groups.find((x) => x._id === d.groupId) : undefined;
      return {
        _id: d._id,
        name: d.name,
        revision: d.revision,
        revoked: d.revoked,
        kioskEnabled: d.kioskEnabled,
        enrolledAt: d.enrolledAt,
        group: g ? { _id: g._id, name: g.name } : null,
        presence: devicePresence(db, d),
        report: db.reports.get(d._id) ?? null,
        versions: (db.versions.get(d._id) ?? []).slice(0, 5),
        flags: { noGroup: !d.groupId, revoked: d.revoked, rotateCredential: d.rotateCredential },
        groups: groupOptions(db),
      };
    });
  },

  // `fleet:liveness`: the one liveness row (minute buckets in the real backend).
  useDeviceLiveness(deviceId) {
    return useDemoQuery(`fleet:liveness:${deviceId}`, (db) => {
      requireReader();
      const d = find(db.devices, deviceId);
      const seen = db.lastSeen.get(d._id);
      return {
        lastContactAt: seen === undefined ? null : Math.floor(seen / MIN) * MIN,
        online: devicePresence(db, d).online,
        fastUntil: db.watching.get(d._id) ?? null,
      };
    });
  },

  // `fleet:watch`: ping every 60 s for 5 minutes (written only when it extends by 2 minutes).
  useWatchDevice() {
    return useCallback(
      ({ deviceId }) =>
        runMutation("viewer", ({ db, now }) => {
          const d = find(db.devices, deviceId);
          if (d.revoked || !db.lastSeen.has(d._id)) return { fastUntil: null };
          const fastUntil = Math.ceil((now + 5 * MIN) / MIN) * MIN;
          const have = db.watching.get(d._id);
          if (have !== undefined && fastUntil < have + 2 * MIN) return { fastUntil: have };
          db.watching.set(d._id, fastUntil);
          return { fastUntil };
        }),
      [],
    );
  },

  // `fleet:checkNow`: at most 50 PCs; online ones answer, the others do not.
  useCheckNow() {
    return useCallback(
      ({ deviceIds }) =>
        runMutation("admin", ({ db, now }) => {
          const ids = [...new Set(deviceIds)];
          if (ids.length < 1 || ids.length > 50) fail("invalid_argument", { field: "deviceIds" });
          for (const id of ids) find(db.devices, id);
          if (db.lastCheckAt !== undefined && now - db.lastCheckAt < MIN) fail("rate_limited");
          db.lastCheckAt = now;
          const id = newId("chk");
          db.checks.set(id, { requestedAt: now, deviceIds: ids });
          return { checkId: id };
        }),
      [],
    );
  },

  useCheckResult(checkId) {
    return useDemoQuery(`fleet:checkResult:${checkId}`, (db) => {
      requireAdmin();
      const c = db.checks.get(checkId);
      if (!c) fail("not_found");
      return {
        requestedAt: c.requestedAt,
        items: c.deviceIds.map((deviceId) => {
          const d = db.devices.find((x) => x._id === deviceId);
          return { deviceId, answered: d !== undefined && devicePresence(db, d).online };
        }),
      };
    });
  },

  useRenameDevice() {
    return useCallback(
      ({ deviceId, expectedRevision, name }) =>
        runMutation("admin", ({ db, audit }) => {
          const d = find(db.devices, deviceId);
          checkRevision(d, expectedRevision);
          const clean = nameOrFail(name, validate.NAME_MAX.device);
          const old = d.name;
          d.name = clean;
          d.revision++;
          audit({ action: "device.renamed", targetType: "device", targetId: d._id, targetLabel: clean, summary: `Renamed from “${old}” to “${clean}”.` });
        }),
      [],
    );
  },

  useMoveDevice() {
    return useCallback(
      ({ deviceId, expectedRevision, groupId }) =>
        runMutation("admin", ({ db, audit }) => {
          const d = find(db.devices, deviceId);
          checkRevision(d, expectedRevision);
          const g = find(db.groups, groupId);
          d.groupId = g._id;
          d.revision++;
          bumpVersion(db, d._id, "group changed");
          audit({ action: "device.moved", targetType: "device", targetId: d._id, targetLabel: d.name, summary: `Moved to “${g.name}”.` });
        }),
      [],
    );
  },

  // Turning the kiosk off is a major action on the server (plan 4.16): fresh step-up.
  useSetKiosk() {
    return useCallback(
      ({ deviceId, expectedRevision, enabled }) =>
        runMutation(
          "admin",
          ({ db, audit }) => {
            const d = find(db.devices, deviceId);
            if (d.revoked) fail("conflict", { detail: "device revoked" });
            checkRevision(d, expectedRevision);
            if (d.kioskEnabled === enabled) return;
            d.kioskEnabled = enabled;
            d.revision++;
            bumpVersion(db, d._id, enabled ? "kiosk on" : "kiosk off");
            audit({
              action: enabled ? "device.kioskEnabled" : "device.kioskDisabled",
              targetType: "device",
              targetId: d._id,
              targetLabel: d.name,
              summary: enabled ? "Kiosk turned on." : "Kiosk turned off.",
            });
          },
          enabled ? "unlocked" : "fresh",
        ),
      [],
    );
  },
  useRevokeDevice() {
    return useCallback(
      ({ deviceId }) =>
        // Major action (plan 4.16): fresh step-up.
        runMutation(
          "admin",
          ({ db, audit }) => {
            const d = find(db.devices, deviceId);
            if (d.revoked) return;
            d.revoked = true;
            d.revision++;
            db.onlineIds.delete(d._id);
            audit({ action: "device.revoked", targetType: "device", targetId: d._id, targetLabel: d.name, summary: "Revoked." });
          },
          "fresh",
        ),
      [],
    );
  },

  useRemoveDevice() {
    return useCallback(
      ({ deviceId }) =>
        // Major action (plan 4.16): fresh step-up.
        runMutation(
          "admin",
          ({ db, audit }) => {
            const d = find(db.devices, deviceId);
            if (!d.revoked) fail("conflict", { detail: "revoke the device first" });
            db.devices = db.devices.filter((x) => x._id !== deviceId);
            db.installs = db.installs.filter((x) => x.deviceId !== deviceId);
            db.reports.delete(deviceId);
            db.lastSeen.delete(deviceId);
            db.versions.delete(deviceId);
            audit({ action: "device.removed", targetType: "device", targetId: d._id, targetLabel: d.name, summary: "Removed from Rulebox." });
          },
          "fresh",
        ),
      [],
    );
  },

  useRequestRotation() {
    return useCallback(
      ({ deviceId }) =>
        runMutation("admin", ({ db, audit }) => {
          const d = find(db.devices, deviceId);
          d.rotateCredential = true;
          audit({ action: "device.credentialRotationRequested", targetType: "device", targetId: d._id, targetLabel: d.name, summary: "Credential rotation requested." });
        }),
      [],
    );
  },

  // ---- groups
  useGroupsScreen() {
    return useDemoQuery("groups:list", (db) => {
      requireReader();
      return [...db.groups]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((g) => ({
          _id: g._id,
          name: g.name,
          description: g.description,
          revision: g.revision,
          createdAt: g.createdAt,
          deviceCount: Math.min(db.devices.filter((d) => d.groupId === g._id).length, 501),
          employeeCount: Math.min(db.groupMembers.filter((m) => m.groupId === g._id).length, 501),
        }));
    });
  },

  // `groups:page`: a bounded list with offset cursors and its exact total inside the page; the search is "contains" on name and description.
  useGroupsPage(query) {
    return useDemoServerPage(
      "groups:page",
      "groups",
      query,
      (db, sort, search) => {
        requireReader();
        const key = sort?.key ?? "name";
        if (key !== "name" && key !== "created") fail("invalid_argument", { field: "sort" });
        return db.groups
          .filter((g) => !search || contains(search, g.name, g.description))
          .sort(byKey((g) => (key === "name" ? g.name : g.createdAt), sort?.dir ?? "asc"))
          .map((g) => ({
            _id: g._id,
            name: g.name,
            description: g.description,
            revision: g.revision,
            createdAt: g.createdAt,
            deviceCount: Math.min(db.devices.filter((d) => d.groupId === g._id).length, 501),
            employeeCount: Math.min(db.groupMembers.filter((m) => m.groupId === g._id).length, 501),
          }));
      },
      "o",
    );
  },

  useGroupDetail(groupId) {
    return useDemoQuery(`groups:get:${groupId}`, (db) => {
      requireReader();
      const g = find(db.groups, groupId);
      return {
        _id: g._id,
        name: g.name,
        description: g.description,
        revision: g.revision,
        assignments: db.assignments
          .filter((a) => a.groupId === g._id)
          .map((a) => assignmentRow(db, a))
          .sort((a, b) => a.appName.localeCompare(b.appName))
          .slice(0, 150),
        deviceCount: Math.min(db.devices.filter((d) => d.groupId === g._id).length, 501),
        employeeCount: Math.min(db.groupMembers.filter((m) => m.groupId === g._id).length, 501),
      };
    });
  },

  // `groups:create`: exact-name uniqueness (`by_org_name`), then the plan's `maxGroups`.
  useCreateGroup() {
    return useCallback(
      ({ name, description }) =>
        runMutation("admin", ({ db, audit, now }) => {
          const clean = nameOrFail(name, validate.NAME_MAX.group);
          const desc = descriptionOrFail(description);
          if (db.groups.some((g) => g.name === clean)) fail("conflict", { field: "name" });
          if (db.org.plan.status !== "active") fail("plan_limit", { detail: "suspended" });
          if (db.groups.length + 1 > db.org.plan.limits.maxGroups) fail("plan_limit", { detail: "groups" });
          const id = newId("grp");
          db.groups.push({ _id: id, name: clean, description: desc, revision: 0, createdAt: now });
          audit({ action: "group.created", targetType: "group", targetId: id, targetLabel: clean, summary: `Created the group ${clean}` });
          return id;
        }),
      [],
    );
  },

  // `groups:rename`: description undefined = unchanged, "" = cleared; nothing changed = no write.
  useUpdateGroup() {
    return useCallback(
      ({ groupId, expectedRevision, name, description }) =>
        runMutation("admin", ({ db, audit }) => {
          const g = find(db.groups, groupId);
          checkRevision(g, expectedRevision);
          const clean = nameOrFail(name, validate.NAME_MAX.group);
          const desc = description === undefined ? g.description : descriptionOrFail(description);
          const renamed = g.name !== clean;
          if (!renamed && desc === g.description) return { revision: g.revision };
          if (renamed && db.groups.some((x) => x._id !== g._id && x.name === clean)) fail("conflict", { field: "name" });
          const before = g.name;
          g.name = clean;
          g.description = desc;
          g.revision++;
          audit({
            action: renamed ? "group.renamed" : "group.updated",
            targetType: "group",
            targetId: g._id,
            targetLabel: clean,
            summary: renamed ? `Renamed the group ${before} to ${clean}` : `Changed the description of the group ${clean}`,
          });
          return { revision: g.revision };
        }),
      [],
    );
  },

  // `groups:remove` (major): `has_dependents` names what still uses the group.
  useDeleteGroup() {
    return useCallback(
      ({ groupId }) =>
        runMutation(
          "admin",
          ({ db, audit, now }) => {
            const g = find(db.groups, groupId);
            const dependents = [
              db.devices.some((d) => d.groupId === groupId) ? "devices" : null,
              db.groupMembers.some((m) => m.groupId === groupId) ? "employees" : null,
              db.assignments.some((a) => a.groupId === groupId) ? "apps" : null,
              db.tokens.some((t) => t.groupId === groupId && !t.revoked && t.expiresAt > now && t.usesLeft > 0) ? "enrollment codes" : null,
            ].filter((x) => x !== null);
            if (dependents.length > 0) fail("has_dependents", { detail: dependents.join(", ") });
            db.groups = db.groups.filter((x) => x._id !== groupId);
            for (const w of db.wifi) w.groupIds = w.groupIds.filter((x) => x !== groupId);
            for (const p of db.printers) {
              p.groupIds = p.groupIds.filter((x) => x !== groupId);
              p.defaultForGroupIds = p.defaultForGroupIds.filter((x) => x !== groupId);
            }
            audit({ action: "group.deleted", targetType: "group", targetId: g._id, targetLabel: g.name, summary: `Deleted the group ${g.name}` });
          },
          "fresh",
        ),
      [],
    );
  },

  useAssignApp() {
    return useCallback(
      ({ groupId, appId, audience, pinnedTaskbar, pinnedDesktop }) =>
        runMutation("admin", ({ db, audit }) => {
          const g = find(db.groups, groupId);
          const a = find(db.apps, appId);
          if (db.assignments.some((x) => x.groupId === groupId && x.appId === appId)) fail("conflict", { field: "app" });
          db.assignments.push({ _id: newId("asg"), groupId, appId, audience, pinnedTaskbar, pinnedDesktop });
          republishGroup(db, groupId, "app assigned");
          audit({ action: "app.assigned", targetType: "app", targetId: a._id, targetLabel: a.name, summary: `Assigned to “${g.name}”.` });
        }),
      [],
    );
  },

  useUpdateAssignment() {
    return useCallback(({ assignmentId, audience, pinnedTaskbar, pinnedDesktop }) => {
      let before: { audience: "everyone" | "selected"; pinnedTaskbar: boolean; pinnedDesktop: boolean } | null = null;
      return runOptimistic(
        "admin",
        (db) => {
          const a = db.assignments.find((x) => x._id === assignmentId);
          if (!a) return;
          before = { audience: a.audience, pinnedTaskbar: a.pinnedTaskbar, pinnedDesktop: a.pinnedDesktop };
          Object.assign(a, { audience, pinnedTaskbar, pinnedDesktop });
        },
        (db) => {
          const a = db.assignments.find((x) => x._id === assignmentId);
          if (a && before) Object.assign(a, before);
        },
        ({ db }) => {
          const a = find(db.assignments, assignmentId);
          Object.assign(a, { audience, pinnedTaskbar, pinnedDesktop });
          republishGroup(db, a.groupId, "assignment changed");
        },
      );
    }, []);
  },

  useUnassignApp() {
    return useCallback(
      ({ assignmentId }) =>
        runMutation("admin", ({ db, audit }) => {
          const a = find(db.assignments, assignmentId);
          db.assignments = db.assignments.filter((x) => x._id !== assignmentId);
          const app = db.apps.find((x) => x._id === a.appId);
          republishGroup(db, a.groupId, "app unassigned");
          audit({ action: "app.unassigned", targetType: "app", targetId: a.appId, targetLabel: app?.name, summary: `Unassigned from “${groupName(db, a.groupId)}”.` });
        }),
      [],
    );
  },

  useAddGroupEmployee() {
    return useCallback(
      ({ groupId, employeeId }) =>
        runMutation("admin", ({ db, audit }) => {
          find(db.groups, groupId);
          const e = find(db.employees, employeeId);
          if (db.groupMembers.some((m) => m.groupId === groupId && m.employeeId === employeeId)) return; // already a member: no change
          db.groupMembers.push({ groupId, employeeId });
          e.revision++;
          audit({ action: "employee.groupsChanged", targetType: "employee", targetId: e._id, targetLabel: e.name, summary: `Added to “${groupName(db, groupId)}”.` });
        }),
      [],
    );
  },

  useRemoveGroupEmployee() {
    return useCallback(
      ({ groupId, employeeId }) =>
        runMutation("admin", ({ db, audit }) => {
          const e = find(db.employees, employeeId);
          db.groupMembers = db.groupMembers.filter((m) => !(m.groupId === groupId && m.employeeId === employeeId));
          e.revision++;
          audit({ action: "employee.groupsChanged", targetType: "employee", targetId: e._id, targetLabel: e.name, summary: `Removed from “${groupName(db, groupId)}”.` });
        }),
      [],
    );
  },

  // ---- employees (the list is in `demoEmployeesApi`, its own seam)
  useEmployeeDetail(employeeId) {
    return useDemoQuery(`employees:get:${employeeId}`, (db): EmployeeDetail => {
      requireReader();
      if (employeeId === "new") {
        return {
          _id: "new",
          name: "",
          username: "",
          disabled: false,
          revision: 0,
          passwordSet: false,
          createdAt: Date.now(),
          groupIds: [],
          appIds: [],
          lockout: null,
          groupOptions: groupOptions(db),
          appOptions: appOptions(db),
          defaultQuotaGb: db.org.settings.defaultQuotaGb,
        };
      }
      const e = find(db.employees, employeeId);
      const lock = db.lockouts.get(e._id);
      return {
        _id: e._id,
        name: e.name,
        username: e.username,
        quotaGb: e.quotaGb,
        disabled: e.disabled,
        revision: e.revision,
        passwordSet: e.passwordSetAt !== undefined,
        passwordSetAt: e.passwordSetAt,
        createdAt: e.createdAt,
        groupIds: db.groupMembers.filter((m) => m.employeeId === e._id).map((m) => m.groupId).slice(0, 100),
        appIds: db.employeeApps.filter((m) => m.employeeId === e._id).map((m) => m.appId).slice(0, 50),
        lockout: lock && lock.lockedUntil > Date.now() ? lock : null,
        groupOptions: groupOptions(db),
        appOptions: appOptions(db),
        defaultQuotaGb: db.org.settings.defaultQuotaGb,
      };
    });
  },

  useCreateEmployee() {
    return useCallback(
      (input) =>
        runMutation("admin", ({ db, audit, now }) => {
          const name = nameOrFail(input.name, validate.NAME_MAX.employee);
          if (validate.username(input.username)) fail("invalid_argument", { field: "username" });
          const username = validate.normalizeUsername(input.username);
          if (db.employees.some((e) => e.username === username)) fail("conflict", { field: "username" });
          if (input.password && validate.employeePassword(input.password, username)) fail("invalid_argument", { field: "password" });
          // As `employees:create`: suspended, then the plan's `maxEmployees`.
          if (db.org.plan.status !== "active") fail("plan_limit", { detail: "suspended" });
          if (db.employees.length + 1 > db.org.plan.limits.maxEmployees) fail("plan_limit", { detail: "employees" });
          const id = newId("emp");
          db.employees.push({
            _id: id,
            name,
            username,
            quotaGb: input.quotaGb,
            disabled: false,
            revision: 0,
            passwordSetAt: input.password ? now : undefined,
            createdAt: now,
          });
          for (const g of input.groupIds) db.groupMembers.push({ groupId: g, employeeId: id });
          for (const a of input.appIds) db.employeeApps.push({ employeeId: id, appId: a });
          audit({ action: "employee.created", targetType: "employee", targetId: id, targetLabel: name, summary: `Employee “${name}” added.` });
          return id;
        }),
      [],
    );
  },

  useUpdateEmployee() {
    return useCallback(
      (input) =>
        runMutation("admin", ({ db, audit }) => {
          const e = find(db.employees, input.employeeId);
          checkRevision(e, input.expectedRevision);
          const name = nameOrFail(input.name, validate.NAME_MAX.employee);
          if (validate.username(input.username)) fail("invalid_argument", { field: "username" });
          const username = validate.normalizeUsername(input.username);
          if (db.employees.some((x) => x._id !== e._id && x.username === username)) fail("conflict", { field: "username" });
          const changed: string[] = [];
          if (e.name !== name) changed.push("name");
          if (e.username !== username) changed.push("username");
          if (e.quotaGb !== input.quotaGb) changed.push("quota");
          const oldGroups = db.groupMembers.filter((m) => m.employeeId === e._id).map((m) => m.groupId).sort();
          if (oldGroups.join() !== [...input.groupIds].sort().join()) changed.push("groups");
          db.groupMembers = db.groupMembers.filter((m) => m.employeeId !== e._id);
          for (const g of input.groupIds) db.groupMembers.push({ groupId: g, employeeId: e._id });
          const oldApps = db.employeeApps.filter((m) => m.employeeId === e._id).map((m) => m.appId).sort();
          if (oldApps.join() !== [...input.appIds].sort().join()) changed.push("apps");
          db.employeeApps = db.employeeApps.filter((m) => m.employeeId !== e._id);
          for (const a of input.appIds) db.employeeApps.push({ employeeId: e._id, appId: a });
          // Like `employees:save`: one revision bump for the whole form, none when nothing changed.
          e.name = name;
          e.username = username;
          e.quotaGb = input.quotaGb;
          if (changed.length > 0) e.revision++;
          audit({
            action: "employee.updated",
            targetType: "employee",
            targetId: e._id,
            targetLabel: name,
            summary: changed.length ? `Changed: ${changed.join(", ")}.` : "Saved without changes.",
          });
          return { revision: e.revision };
        }),
      [],
    );
  },

  useSetEmployeePassword() {
    return useCallback(
      ({ employeeId, password }) =>
        runMutation("admin", ({ db, audit, now }) => {
          const e = find(db.employees, employeeId);
          if (validate.employeePassword(password, e.username)) fail("invalid_argument", { field: "password" });
          e.passwordSetAt = now;
          audit({ action: "employee.passwordSet", targetType: "employee", targetId: e._id, targetLabel: e.name, summary: "Password set." });
        }),
      [],
    );
  },

  useSetEmployeeDisabled() {
    return useCallback(
      ({ employeeId, disabled }) =>
        runMutation("admin", ({ db, audit }) => {
          const e = find(db.employees, employeeId);
          if (e.disabled === disabled) return;
          // As the server: the revision guards the profile form, which this does not touch.
          e.disabled = disabled;
          audit({
            action: disabled ? "employee.disabled" : "employee.enabled",
            targetType: "employee",
            targetId: e._id,
            targetLabel: e.name,
            summary: disabled ? "Disabled." : "Enabled.",
          });
        }),
      [],
    );
  },

  useUnlockEmployee() {
    return useCallback(
      ({ employeeId }) =>
        runMutation("admin", ({ db, audit }) => {
          const e = find(db.employees, employeeId);
          db.lockouts.delete(employeeId);
          audit({ action: "employee.updated", targetType: "employee", targetId: e._id, targetLabel: e.name, summary: "Unlocked." });
        }),
      [],
    );
  },

  useDeleteEmployee() {
    return useCallback(
      ({ employeeId }) =>
        runMutation("admin", ({ db, audit }) => {
          const e = find(db.employees, employeeId);
          if (!e.disabled) fail("invalid_argument", { field: "disabled" });
          db.employees = db.employees.filter((x) => x._id !== employeeId);
          db.groupMembers = db.groupMembers.filter((m) => m.employeeId !== employeeId);
          db.employeeApps = db.employeeApps.filter((m) => m.employeeId !== employeeId);
          db.lockouts.delete(employeeId);
          audit({ action: "employee.deleted", targetType: "employee", targetId: e._id, targetLabel: e.name, summary: `Employee “${e.name}” deleted.` });
        }),
      [],
    );
  },

  // ---- apps
  useAppOptions() {
    return useDemoQuery("apps:options", (db) => {
      requireReader();
      return appOptions(db);
    });
  },

  useAppDetail(appId) {
    return useDemoQuery(`apps:get:${appId}`, (db): AppDetail => {
      requireReader();
      if (appId === "new") {
        return {
          _id: "new",
          name: "",
          kind: "web" as AppKind,
          archived: false,
          revision: 0,
          createdAt: Date.now(),
          assignments: [],
          fileTypes: [],
          directEmployeeCount: 0,
          groupOptions: groupOptions(db),
          denials30d: [],
        };
      }
      const a = find(db.apps, appId);
      return {
        _id: a._id,
        name: a.name,
        description: a.description,
        kind: a.kind,
        hue: a.hue,
        iconUrl: a.iconUrl,
        web: a.web,
        desktop: a.desktop,
        archived: a.archived,
        revision: a.revision,
        createdAt: a.createdAt,
        assignments: db.assignments.filter((x) => x.appId === a._id).map((x) => assignmentRow(db, x)),
        fileTypes: db.fileHandlers.filter((f) => f.appId === a._id).map((f) => f.extension).sort(),
        directEmployeeCount: Math.min(db.employeeApps.filter((m) => m.appId === a._id).length, 1001),
        groupOptions: groupOptions(db),
        denials30d: a.kind === "web" ? [...(db.appDenials.get(a._id) ?? [])].sort((x, y) => y.count - x.count || (x.kind < y.kind ? -1 : 1)) : [],
      };
    });
  },

  useAppInstallSummary(appId) {
    return useDemoQuery(`apps:installSummary:${appId}`, (db): InstallCounts => {
      requireReader();
      const a = find(db.apps, appId);
      const counts: InstallCounts = {};
      for (const s of INSTALL_STATES) {
        const c = db.installs.filter((i) => i.appId === a._id && i.state === s).length;
        if (c) counts[s] = Math.min(c, 1001);
        // The server reads at most 1,001 rows per state: past that a count may be low.
        if (c > 1001) counts.capped = true;
      }
      return counts;
    });
  },

  useCreateWebApp() {
    return useCallback(
      (input) =>
        runMutation("admin", ({ db, audit, now }) => {
          const name = nameOrFail(input.name, validate.NAME_MAX.app);
          if (validate.webUrl(input.url)) fail("invalid_argument", { field: "url" });
          if (validate.domains(input.allowedDomains)) fail("invalid_argument", { field: "allowedDomains" });
          const id = newId("app");
          const host = new URL(input.url).hostname;
          db.apps.push({
            _id: id,
            name,
            description: input.description?.trim() || undefined,
            kind: "web",
            hue: input.hue,
            web: {
              url: input.url.trim(),
              allowedDomains: [...new Set([host, ...input.allowedDomains])],
              permissions: { ...NEW_WEB_APP_PERMISSIONS },
            },
            archived: false,
            revision: 1,
            createdAt: now,
          });
          audit({ action: "app.created", targetType: "app", targetId: id, targetLabel: name, summary: `Website “${name}” added.` });
          return id;
        }),
      [],
    );
  },

  useCreateDesktopApp() {
    return useCallback(
      (input) =>
        runMutation("admin", ({ db, audit, now }) => {
          const name = nameOrFail(input.name, validate.NAME_MAX.app);
          const id = newId("app");
          const exe = input.desktop.exe.replace("{AppId}", id);
          db.apps.push({
            _id: id,
            name,
            description: input.description?.trim() || undefined,
            kind: "desktop",
            hue: input.hue,
            desktop: { ...input.desktop, exe },
            archived: false,
            revision: 1,
            createdAt: now,
          });
          audit({ action: "app.created", targetType: "app", targetId: id, targetLabel: name, summary: `Windows program “${name}” added.` });
          return id;
        }),
      [],
    );
  },

  useUpdateApp() {
    return useCallback(
      ({ appId, expectedRevision, web, desktop }) =>
        runMutation("admin", ({ db, audit }) => {
          const a = find(db.apps, appId);
          checkRevision(a, expectedRevision);
          if (web && a.kind === "web") {
            a.name = nameOrFail(web.name, validate.NAME_MAX.app);
            a.description = web.description?.trim() || undefined;
            a.hue = web.hue;
            if (validate.webUrl(web.url)) fail("invalid_argument", { field: "url" });
            const host = new URL(web.url).hostname;
            a.web = { ...(a.web ?? { permissions: { ...NEW_WEB_APP_PERMISSIONS } }), url: web.url.trim(), allowedDomains: [...new Set([host, ...web.allowedDomains])] };
          }
          if (desktop && a.kind === "desktop") {
            a.name = nameOrFail(desktop.name, validate.NAME_MAX.app);
            a.description = desktop.description?.trim() || undefined;
            a.hue = desktop.hue;
            a.desktop = { ...desktop.desktop, exe: desktop.desktop.exe.replace("{AppId}", a._id) };
          }
          a.revision++;
          audit({ action: "app.updated", targetType: "app", targetId: a._id, targetLabel: a.name, summary: "App settings changed." });
        }),
      [],
    );
  },

  useSetAppPermissions() {
    return useCallback(
      ({ appId, expectedRevision, permissions }) =>
        runMutation("admin", ({ db, audit }) => {
          const a = find(db.apps, appId);
          checkRevision(a, expectedRevision);
          if (a.kind !== "web" || !a.web) fail("invalid_argument", { field: "appId" });
          const changed = WEB_PERMISSION_KEYS.filter((k) => a.web!.permissions[k] !== permissions[k]);
          if (changed.length === 0) return { revision: a.revision };
          a.web = { ...a.web, permissions: { ...permissions } };
          a.revision++;
          audit({
            action: "app.permissionsChanged",
            targetType: "app",
            targetId: a._id,
            targetLabel: a.name,
            summary: `Changed permissions of ${a.name}: ${changed.map((k) => `${k} ${permissions[k] ? "allowed" : "blocked"}`).join(", ")}`,
          });
          return { revision: a.revision };
        }),
      [],
    );
  },

  useSetAppArchived() {
    return useCallback(({ appId, archived }) => {
      let before = false;
      return runOptimistic(
        "admin",
        (db) => {
          const a = db.apps.find((x) => x._id === appId);
          if (a) {
            before = a.archived;
            a.archived = archived;
          }
        },
        (db) => {
          const a = db.apps.find((x) => x._id === appId);
          if (a) a.archived = before;
        },
        ({ db, audit }) => {
          const a = find(db.apps, appId);
          a.archived = archived;
          a.revision++;
          audit({ action: archived ? "app.archived" : "app.updated", targetType: "app", targetId: a._id, targetLabel: a.name, summary: archived ? "Archived." : "Restored from the archive." });
        },
      );
    }, []);
  },

  useDeleteApp() {
    return useCallback(
      ({ appId }) =>
        runMutation("admin", ({ db, audit }) => {
          const a = find(db.apps, appId);
          if (!a.archived) fail("invalid_argument", { field: "archived" });
          if (db.assignments.some((x) => x.appId === appId) || db.fileHandlers.some((f) => f.appId === appId)) fail("has_dependents");
          db.apps = db.apps.filter((x) => x._id !== appId);
          db.installs = db.installs.filter((x) => x.appId !== appId);
          db.employeeApps = db.employeeApps.filter((x) => x.appId !== appId);
          audit({ action: "app.deleted", targetType: "app", targetId: a._id, targetLabel: a.name, summary: `App “${a.name}” deleted.` });
        }),
      [],
    );
  },

  useRetryApp() {
    return useCallback(
      ({ appId }) =>
        runMutation("admin", ({ db, audit, now }) => {
          const a = find(db.apps, appId);
          a.revision++;
          for (const i of db.installs) {
            if (i.appId === appId && i.state === "failed") {
              i.state = "pending";
              i.attempts = 0;
              i.detail = undefined;
              i.exitCode = undefined;
              i.updatedAt = now;
            }
          }
          audit({ action: "app.retryRequested", targetType: "app", targetId: a._id, targetLabel: a.name, summary: "Retry requested for failed installs." });
        }),
      [],
    );
  },

  useResolveWinget() {
    return useCallback(async ({ packageId, version }) => {
      await sleep(latency() + 400);
      const id = packageId.trim();
      if (validate.wingetId(id)) fail("invalid_argument", { field: "packageId" });
      const known: Record<string, { kind: "msi" | "exe"; version: string; silent: string[]; where?: string; product?: string; name: string; publisher: string }> = {
        "7zip.7zip": { kind: "msi", version: "24.08", silent: [], where: "{ProgramFiles}\\7-Zip", product: "{23170F69-40C1-2702-2408-000001000000}", name: "7-Zip", publisher: "Igor Pavlov" },
        "videolan.vlc": { kind: "exe", version: "3.0.21", silent: ["/S"], where: "{ProgramFiles}\\VideoLAN\\VLC", name: "VLC media player", publisher: "VideoLAN" },
        "notepad++.notepad++": { kind: "exe", version: "8.7.1", silent: ["/S"], where: "{ProgramFiles}\\Notepad++", name: "Notepad++", publisher: "Notepad++ Team" },
      };
      const lower = id.toLowerCase();
      if (lower === "spotify.spotify") fail("winget_unsupported", { detail: "it only offers a per-user (Scope: user) installer" });
      if (lower.startsWith("offline.")) fail("winget_unreachable");
      const k = known[lower];
      if (!k) fail("winget_unsupported", { detail: "no machine-wide x64 installer with a silent switch was found" });
      const v = version?.trim() || k.version;
      const hexChars = "0123456789abcdef";
      let sha = "";
      for (let i = 0; i < 64; i++) sha += hexChars[(i * 7 + lower.length) % 16];
      return {
        packageId: id,
        version: v,
        name: k.name,
        publisher: k.publisher,
        defaultInstallLocation: k.where,
        install: {
          kind: k.kind,
          url: `https://downloads.example.com/winget/${lower}/${v}/setup.${k.kind}`,
          sha256: sha,
          sizeBytes: 12_345_678,
          silentArgs: k.silent,
          productCode: k.product,
          successExitCodes: [0],
          removeWhenUnassigned: k.kind === "msi",
        },
      };
    }, []);
  },

  useFetchWebMeta() {
    return useCallback(async ({ url }) => {
      await sleep(latency() + 300);
      if (validate.webUrl(url)) fail("invalid_argument", { field: "url" });
      const host = new URL(url).hostname;
      if (host.includes("fail")) fail("webmeta_failed");
      const base = host.replace(/^www\./, "").split(".")[0] ?? host;
      let hash = 0;
      for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
      // A drawn tile stands in for the PNG a real site would offer (the demo stores nothing).
      const icon = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="hsl(${hash} 55% 48%)"/><text x="32" y="43" font-size="32" text-anchor="middle" fill="white" font-family="sans-serif">${(base[0] ?? "?").toUpperCase()}</text></svg>`)}`;
      return { name: base.charAt(0).toUpperCase() + base.slice(1), hue: hash, ...(host.includes("noicon") ? {} : { iconPreviewUrl: icon }) };
    }, []);
  },

  useSaveAppIcon() {
    return useCallback(
      ({ appId, png }) =>
        runMutation("admin", ({ db, audit }) => {
          const a = find(db.apps, appId);
          a.iconUrl = png;
          audit({ action: "app.updated", targetType: "app", targetId: a._id, targetLabel: a.name, summary: "Icon changed." });
        }),
      [],
    );
  },

  // ---- networks (Phase 5 Step 13). The demo twin of convex/networks.ts and convex/wifi.ts: the passphrase is checked
  // and then dropped on the floor, exactly like a client could never read it back.
  useNetworks() {
    return useDemoQuery("networks:list", (db): NetworksScreen => {
      requireReader();
      return {
        wifi: [...db.wifi].sort((a, b) => a.name.localeCompare(b.name)).map((w) => wifiRow(db, w)),
        printers: [...db.printers].sort((a, b) => a.name.localeCompare(b.name)).map((p) => printerRow(db, p)),
        approvedDrivers: driverChoices(db.approvedDrivers),
      };
    });
  },

  useWifiDetail(id) {
    return useDemoQuery(`networks:wifiDetail:${id}`, (db): WifiDetail => {
      requireReader();
      const w = find(db.wifi, id);
      return { ...wifiRow(db, w), groupIds: [...w.groupIds], counts: wifiCounts(db, w) };
    });
  },

  useSaveWifi() {
    return useCallback(
      (input) =>
        runMutation("admin", ({ db, audit }) => {
          const name = nameOrFail(input.name, MAX_WIFI_NAME);
          if (ssidProblem(input.ssid) !== null) fail("invalid_argument", { field: "ssid" });
          if (!WIFI_SECURITIES.includes(input.security)) fail("invalid_argument", { field: "security" });
          const groupIds = [...new Set(input.groupIds)];
          for (const g of groupIds) if (!db.groups.some((x) => x._id === g)) fail("not_found");
          const existing = input.id === undefined ? null : find(db.wifi, input.id);
          if (existing) checkRevision(existing, input.expectedRevision ?? -1);
          const before = existing?.groupIds ?? [];
          const changed = groupIds.filter((g) => !before.includes(g)).length + before.filter((g) => !groupIds.includes(g)).length;
          // The server snapshots every group the profile is in or goes into, in the same call: at most 10 of them.
          const touched = new Set([...before, ...groupIds]).size;

          if (!existing) {
            if (touched > MAX_WIFI_GROUPS_PER_SAVE) fail("too_large", { detail: "groups" });
            if (db.wifi.length >= MAX_WIFI_PROFILES) fail("too_large", { detail: "wifi" });
            const row: DbWifi = {
              _id: newId("wifi"),
              name,
              ssid: input.ssid,
              hidden: input.hidden,
              security: input.security,
              autoConnect: input.autoConnect,
              hasPassphrase: false,
              passphraseSetAt: null,
              groupIds,
              revision: 1,
            };
            db.wifi.push(row);
            audit({ action: "wifi.created", targetType: "wifi", targetId: row._id, targetLabel: name, summary: `Added the Wi-Fi network ${name}` });
            return { id: row._id, revision: row.revision };
          }
          const same =
            existing.name === name && existing.ssid === input.ssid && existing.hidden === input.hidden && existing.security === input.security &&
            existing.autoConnect === input.autoConnect && changed === 0;
          if (same) return { id: existing._id, revision: existing.revision };
          if (touched > MAX_WIFI_GROUPS_PER_SAVE) fail("too_large", { detail: "groups" });
          // An open network has no password: switching to it drops the one that was set.
          if (input.security === "open" && existing.security !== "open") {
            existing.hasPassphrase = false;
            existing.passphraseSetAt = null;
          }
          Object.assign(existing, { name, ssid: input.ssid, hidden: input.hidden, security: input.security, autoConnect: input.autoConnect, groupIds });
          existing.revision++;
          audit({ action: "wifi.updated", targetType: "wifi", targetId: existing._id, targetLabel: name, summary: `Changed the Wi-Fi network ${name}` });
          return { id: existing._id, revision: existing.revision };
        }),
      [],
    );
  },

  useDeleteWifi() {
    return useCallback(
      ({ id }) =>
        runMutation("admin", ({ db, audit }) => {
          const w = find(db.wifi, id);
          if (w.groupIds.length > MAX_WIFI_GROUPS_PER_SAVE) fail("too_large", { detail: "groups" });
          db.wifi = db.wifi.filter((x) => x._id !== id);
          audit({ action: "wifi.deleted", targetType: "wifi", targetId: w._id, targetLabel: w.name, summary: `Removed the Wi-Fi network ${w.name}` });
        }),
      [],
    );
  },

  useSetWifiPassphrase() {
    return useCallback(
      ({ id, passphrase, expectedRevision }) =>
        runMutation("admin", ({ db, audit, now }) => {
          const w = find(db.wifi, id);
          checkRevision(w, expectedRevision);
          if (w.security === "open") fail("invalid_argument", { field: "id", detail: "open" });
          const problem = passphraseProblem(passphrase);
          if (problem !== null) fail("invalid_argument", { field: "passphrase", detail: problem === "chars" ? "characters" : "length" });
          // Only the fact is kept. The text is never stored, audited or returned.
          w.hasPassphrase = true;
          w.passphraseSetAt = now;
          w.revision++;
          audit({ action: "wifi.passphraseSet", targetType: "wifi", targetId: w._id, targetLabel: w.name, summary: `Replaced the password of ${w.name}` });
          return { revision: w.revision };
        }),
      [],
    );
  },

  // ---- printers (Phase 5 Step 14). The demo twin of `networks:printerDetail` / `savePrinter` / `deletePrinter`.
  usePrinterDetail(id) {
    return useDemoQuery(`networks:printerDetail:${id}`, (db): PrinterDetail => {
      requireReader();
      const p = find(db.printers, id);
      return { ...printerRow(db, p), groupIds: [...p.groupIds], defaultForGroupIds: [...p.defaultForGroupIds], counts: printerCounts(db, p) };
    });
  },

  useSavePrinter() {
    return useCallback(
      (input) =>
        runMutation("admin", ({ db, audit }) => {
          const name = input.name.trim();
          const nameProblem = printerNameProblem(name);
          if (nameProblem !== null) fail("invalid_argument", { field: "name", detail: nameProblem });
          if (!PRINTER_KINDS.includes(input.kind)) fail("invalid_argument", { field: "kind" });
          const addr = addressProblem(input.kind, input.address);
          if (addr !== null) fail("invalid_argument", { field: "address", detail: addr });
          const address = input.address.trim();
          if (input.kind === "raw" && input.port !== undefined && portProblem(String(input.port)) !== null) fail("invalid_argument", { field: "port", detail: "range" });
          if (input.kind !== "raw" && input.port !== undefined) fail("invalid_argument", { field: "port", detail: "not_used" });
          const queue = input.queue?.trim() ? input.queue.trim() : null;
          if (input.kind === "lpr") {
            const q = queueProblem(queue ?? "");
            if (q !== null) fail("invalid_argument", { field: "queue", detail: q });
          } else if (queue !== null) {
            fail("invalid_argument", { field: "queue", detail: "not_used" });
          }
          const driver = driverChoices(db.approvedDrivers).find((d) => d.toLowerCase() === input.driver.trim().toLowerCase());
          if (driver === undefined) fail("invalid_argument", { field: "driver", detail: "not_approved" });
          const groupIds = [...new Set(input.groupIds)];
          for (const g of groupIds) if (!db.groups.some((x) => x._id === g)) fail("not_found");
          const defaults = [...new Set(input.defaultForGroupIds)];
          for (const g of defaults) if (!groupIds.includes(g)) fail("invalid_argument", { field: "defaultForGroupIds", detail: "not_assigned" });
          const existing = input.id === undefined ? null : find(db.printers, input.id);
          if (existing) checkRevision(existing, input.expectedRevision ?? -1);
          const others = db.printers.filter((p) => p !== existing);
          if (!existing && db.printers.length >= MAX_PRINTERS) fail("too_large", { detail: "printers" });
          if (others.some((p) => p.name.toLowerCase() === name.toLowerCase())) fail("invalid_argument", { field: "name", detail: "taken" });
          if (defaults.some((g) => others.some((p) => p.defaultForGroupIds.includes(g)))) fail("invalid_argument", { field: "defaultForGroupIds", detail: "taken" });
          const before = existing?.groupIds ?? [];
          const touched = new Set([...before, ...groupIds]).size;
          const port = input.kind === "raw" && input.port !== undefined ? input.port : null;
          const fields = { name, kind: input.kind, address, port, queue, driver: driver as string, groupIds, defaultForGroupIds: defaults };

          if (!existing) {
            if (touched > MAX_WIFI_GROUPS_PER_SAVE) fail("too_large", { detail: "groups" });
            const row: DbPrinter = { _id: newId("printer"), ...fields, revision: 1 };
            db.printers.push(row);
            audit({ action: "printer.created", targetType: "printer", targetId: row._id, targetLabel: name, summary: `Added the printer ${name}` });
            return { id: row._id, revision: row.revision };
          }
          const same =
            existing.name === name && existing.kind === fields.kind && existing.address === address && existing.port === port && existing.queue === queue &&
            existing.driver === fields.driver && existing.groupIds.length === groupIds.length && groupIds.every((g) => existing.groupIds.includes(g)) &&
            existing.defaultForGroupIds.length === defaults.length && defaults.every((g) => existing.defaultForGroupIds.includes(g));
          if (same) return { id: existing._id, revision: existing.revision };
          if (touched > MAX_WIFI_GROUPS_PER_SAVE) fail("too_large", { detail: "groups" });
          Object.assign(existing, fields);
          existing.revision++;
          audit({ action: "printer.updated", targetType: "printer", targetId: existing._id, targetLabel: name, summary: `Changed the printer ${name}` });
          return { id: existing._id, revision: existing.revision };
        }),
      [],
    );
  },

  useDeletePrinter() {
    return useCallback(
      ({ id }) =>
        runMutation("admin", ({ db, audit }) => {
          const p = find(db.printers, id);
          if (p.groupIds.length > MAX_WIFI_GROUPS_PER_SAVE) fail("too_large", { detail: "groups" });
          db.printers = db.printers.filter((x) => x._id !== id);
          audit({ action: "printer.deleted", targetType: "printer", targetId: p._id, targetLabel: p.name, summary: `Removed the printer ${p.name}` });
        }),
      [],
    );
  },

  // ---- file types
  // (the rules table is `useFileTypesPage` in the apps seam; the program picker is `useAppOptions`)
  useSetFileHandler() {
    return useCallback(
      ({ extension, appId }) =>
        runMutation("admin", ({ db, audit }) => {
          if (validate.extension(extension)) fail("invalid_argument", { field: "extension" });
          const ext = validate.normalizeExtension(extension);
          const app = find(db.apps, appId);
          if (!canOpenFiles(app)) fail("invalid_argument", { field: "app" });
          const existing = db.fileHandlers.find((f) => f.extension === ext);
          if (existing) existing.appId = appId;
          else db.fileHandlers.push({ _id: newId("fh"), extension: ext, appId });
          audit({ action: "fileHandler.set", targetType: "app", targetId: app._id, targetLabel: app.name, summary: `${ext} opens with “${app.name}”.` });
        }),
      [],
    );
  },

  useRemoveFileHandler() {
    return useCallback(
      ({ handlerId }) =>
        runMutation("admin", ({ db, audit }) => {
          const f = find(db.fileHandlers, handlerId);
          db.fileHandlers = db.fileHandlers.filter((x) => x._id !== handlerId);
          audit({ action: "fileHandler.removed", summary: `${f.extension} no longer opens from Rulebox.` });
        }),
      [],
    );
  },

  // ---- settings
  useSettingsScreen() {
    return useDemoQuery("settings:get", (db) => {
      requireReader();
      return {
        name: db.org.name,
        revision: db.org.revision,
        settings: structuredClone(db.org.settings),
        exitPin: { set: db.org.exitPinSetAt !== undefined, setAt: db.org.exitPinSetAt },
      };
    });
  },

  // `settings:update`: every rule of convex/lib/orgSettings.ts; nothing changed =
  // no write; a changed admin exit is a major action (fresh step-up).
  useUpdateSettings() {
    return useCallback(async ({ expectedRevision, name, settings }) => {
      const check = (db: DemoDb) => {
        checkRevision(db.org, expectedRevision);
        const clean = nameOrFail(name, validate.NAME_MAX.org);
        const whole = (n: number, max: number) => Number.isInteger(n) && n >= 0 && n <= max;
        if (!whole(settings.offlineDays, 30)) fail("invalid_argument", { field: "offlineDays" });
        if (!whole(settings.defaultQuotaGb, 2000)) fail("invalid_argument", { field: "defaultQuotaGb" });
        if (settings.adminExit.hotkey.length > validate.HOTKEY_MAX) fail("invalid_argument", { field: "adminExit.hotkey" });
        const hk = validate.parseHotkey(settings.adminExit.hotkey);
        if (!hk.ok) fail("invalid_argument", { field: "adminExit.hotkey", detail: hk.reason });
        const next = { ...settings, power: { ...settings.power }, adminExit: { enabled: settings.adminExit.enabled, hotkey: hk.canonical } };
        const before = db.org.settings;
        const changed: string[] = [];
        if (db.org.name !== clean) changed.push("name");
        if (before.offlineDays !== next.offlineDays) changed.push("offlineDays");
        if (before.defaultQuotaGb !== next.defaultQuotaGb) changed.push("defaultQuotaGb");
        if (JSON.stringify(before.power) !== JSON.stringify(next.power)) changed.push("power");
        if (JSON.stringify(before.adminExit) !== JSON.stringify(next.adminExit)) changed.push("adminExit");
        return { clean, next, changed };
      };
      // The step-up level depends on what changes, as in the server's handler.
      let level: "unlocked" | "fresh" = "unlocked";
      try {
        if (check(getDb()).changed.includes("adminExit")) level = "fresh";
      } catch {
        // Invalid input: the mutation below throws the same error.
      }
      return runMutation(
        "admin",
        ({ db, audit }) => {
          const { clean, next, changed } = check(db);
          if (changed.length === 0) return { revision: db.org.revision, changed };
          db.org.name = clean;
          db.org.settings = next;
          db.org.revision++;
          audit({ action: "org.settingsChanged", targetType: "organization", targetId: db.org._id, targetLabel: clean, summary: `Changed organization settings: ${changed.join(", ")}` });
          return { revision: db.org.revision, changed };
        },
        level,
      );
    }, []);
  },

  usePlan() {
    return useDemoQuery("settings:plan", (db) => {
      requireReader();
      const now = Date.now();
      return {
        plan: db.org.plan.plan,
        status: db.org.plan.status,
        limits: { ...db.org.plan.limits },
        usage: {
          devices: db.devices.filter((d) => !d.revoked).length,
          employees: db.employees.length,
          apps: db.apps.length,
          groups: db.groups.length,
          members: db.members.filter((m) => m.status === "active").length,
          enrollmentCodes: db.tokens.filter((t) => codeState(t, now) === "active").length,
        },
        pingIntervalMs: db.pingIntervalMs,
      };
    });
  },

  // `settings:setExitPin` (admin action, major): the server's rule, only a "set at" is kept.
  useSetExitPin() {
    return useCallback(
      ({ pin }) =>
        runMutation(
          "admin",
          ({ db, audit, now }) => {
            const problem = validate.exitPinProblem(pin);
            if (problem !== null) fail("invalid_argument", { field: "pin", detail: problem });
            const replaced = db.org.exitPinSetAt !== undefined;
            db.org.exitPinSetAt = now;
            audit({ action: "org.exitPinSet", targetType: "organization", targetId: db.org._id, summary: replaced ? "Changed the device exit PIN" : "Set the device exit PIN" });
          },
          "fresh",
        ),
      [],
    );
  },

  useClearExitPin() {
    return useCallback(
      () =>
        runMutation(
          "admin",
          ({ db, audit }) => {
            if (db.org.exitPinSetAt === undefined) return;
            db.org.exitPinSetAt = undefined;
            audit({ action: "org.exitPinCleared", targetType: "organization", targetId: db.org._id, summary: "Removed the device exit PIN" });
          },
          "fresh",
        ),
      [],
    );
  },

  useKeysScreen() {
    return useDemoQuery("keys:status", (db) => {
      requireReader();
      const next = db.keys.find((k) => k.status === "next");
      const live = db.devices.filter((d) => !d.revoked);
      const hasActive = db.keys.some((k) => k.status === "active");
      return {
        envKeyPresent: db.env.key,
        envNextKeyPresent: db.env.next,
        signing: !db.env.key ? ("missing" as const) : hasActive ? ("ok" as const) : ("mismatch" as const),
        publishFailedAt: db.publishFailedAt ?? null,
        rosterPending: db.rosterPending === true,
        keys: [...db.keys].sort((a, b) => a.createdAt - b.createdAt),
        trust: next
          ? {
              trusting: live.filter((d) => db.reports.get(d._id)?.trustedKeyIds?.includes(next.keyId)).length,
              total: live.length,
            }
          : null,
      };
    });
  },

  useRegisterKey() {
    return useCallback(
      () =>
        runMutation("owner", ({ db, audit, now }) => {
          if (!db.env.key) fail("not_ready");
          if (db.keys.some((k) => k.status === "active")) fail("conflict");
          const keyId = token(16).toLowerCase().replace(/[^0-9a-f]/g, "a");
          db.keys.push({ keyId, fingerprint: `SHA256:${token(43)}`, status: "active", createdAt: now });
          audit({ action: "policy.keyRegistered", summary: `Signing key ${keyId} registered.` });
        }),
      [],
    );
  },

  usePublishAgain() {
    return useCallback(
      () =>
        runMutation(
          "owner",
          ({ db }) => {
            // `keys:registerActive` without `force`: with the active key in the deployment it only publishes
            // again (and signs the queued removals); nothing is registered or audited.
            if (!db.env.key) fail("not_ready");
            if (!db.keys.some((k) => k.status === "active")) fail("not_ready");
            db.publishFailedAt = undefined;
            db.rosterPending = false;
          },
          "fresh",
        ),
      [],
    );
  },

  usePrepareRotation() {
    return useCallback(
      () =>
        runMutation("owner", ({ db, audit, now }) => {
          if (!db.env.next) {
            // Demo: pretend the Owner just set RULEBOX_POLICY_KEY_NEXT.
            db.env.next = true;
          }
          if (db.keys.some((k) => k.status === "next")) fail("conflict");
          const keyId = token(16).toLowerCase().replace(/[^0-9a-f]/g, "b");
          db.keys.push({ keyId, fingerprint: `SHA256:${token(43)}`, status: "next", createdAt: now });
          // About 70 % of the online PCs already picked it up.
          for (const d of db.devices) {
            const r = db.reports.get(d._id);
            if (r && db.onlineIds.has(d._id) && d.name.charCodeAt(d.name.length - 1) % 10 < 7) {
              r.trustedKeyIds = [...(r.trustedKeyIds ?? []), keyId];
            }
          }
          audit({ action: "policy.rotationPrepared", summary: `Next key ${keyId} endorsed.` });
        }),
      [],
    );
  },

  useFinishRotation() {
    return useCallback(
      () =>
        runMutation("owner", ({ db, audit }) => {
          const next = db.keys.find((k) => k.status === "next");
          if (!next) fail("not_ready");
          for (const k of db.keys) if (k.status === "active") k.status = "retired";
          next.status = "active";
          db.env.next = false;
          audit({ action: "policy.rotationFinished", summary: `Key ${next.keyId} is now active.` });
        }),
      [],
    );
  },

  // (the members and invites tables are `useMembersPage` / `useInvitesPage` in the members seam)
  useInviteMember() {
    return useCallback(
      ({ email, role }) =>
        runMutation("owner", ({ db, audit, now }) => {
          if (validate.email(email)) fail("invalid_argument", { field: "email" });
          const addr = email.trim().toLowerCase();
          if (db.members.some((m) => m.email === addr)) fail("already_member");
          const code = token(20);
          const expiresAt = now + 7 * DAY;
          db.invites.push({ _id: newId("inv"), email: addr, role, kind: "join", code, expiresAt, createdAt: now });
          audit({ action: "member.invited", targetLabel: addr, summary: `Invited ${addr} as ${role}.` });
          return { code, expiresAt };
        }, "fresh"),
      [],
    );
  },

  useRevokeInvite() {
    return useCallback(
      ({ inviteId }) =>
        runMutation("owner", ({ db }) => {
          find(db.invites, inviteId);
          db.invites = db.invites.filter((i) => i._id !== inviteId);
        }, "fresh"),
      [],
    );
  },

  useChangeRole() {
    return useCallback(
      ({ memberId, role, expectedRevision }) =>
        runMutation("owner", ({ db, me, audit }) => {
          const m = find(db.members, memberId);
          if (m._id === me._id) fail("forbidden");
          checkRevision(m, expectedRevision);
          const owners = db.members.filter((x) => x.role === "owner" && x.status === "active");
          if (m.role === "owner" && role !== "owner" && owners.length <= 1) fail("last_owner");
          m.role = role;
          m.revision++;
          audit({ action: "member.roleChanged", targetLabel: m.email, summary: `Role changed to ${role}.` });
        }, "fresh"),
      [],
    );
  },

  useSetMemberDisabled() {
    return useCallback(
      ({ memberId, disabled, expectedRevision }) =>
        runMutation("owner", ({ db, me, audit }) => {
          const m = find(db.members, memberId);
          if (m._id === me._id) fail("forbidden");
          checkRevision(m, expectedRevision);
          const owners = db.members.filter((x) => x.role === "owner" && x.status === "active");
          if (disabled && m.role === "owner" && owners.length <= 1) fail("last_owner");
          m.status = disabled ? "disabled" : "active";
          m.revision++;
          audit({ action: disabled ? "member.disabled" : "member.enabled", targetLabel: m.email, summary: disabled ? "Disabled." : "Enabled." });
        }, "fresh"),
      [],
    );
  },

  useCreateResetCode() {
    return useCallback(
      ({ memberId }) =>
        runMutation("owner", ({ db, audit, now }) => {
          const m = find(db.members, memberId);
          if (m.status !== "active") fail("account_disabled");
          const code = token(20);
          const expiresAt = now + DAY;
          db.invites.push({ _id: newId("inv"), email: m.email, role: m.role, kind: "passwordReset", code, expiresAt, createdAt: now });
          audit({ action: "member.resetCodeCreated", targetLabel: m.email, summary: "Password reset code created." });
          return { code, expiresAt };
        }, "fresh"),
      [],
    );
  },
};

// ---------------------------------------------------------------- publish simulation

function bumpVersion(db: DemoDb, deviceId: string, reason: string) {
  const list = db.versions.get(deviceId) ?? [];
  const next = (list[0]?.version ?? 0) + 1;
  db.versions.set(deviceId, [{ version: next, createdAt: Date.now(), reason }, ...list].slice(0, 5));
  // Online PCs apply it shortly after; offline ones wait (edge case 1).
  if (db.onlineIds.has(deviceId)) {
    setTimeout(() => {
      const r = db.reports.get(deviceId);
      if (r) r.appliedVersion = next;
    }, 4000);
  }
}

function republishGroup(db: DemoDb, groupId: string, reason: string) {
  for (const d of db.devices) if (d.groupId === groupId) bumpVersion(db, d._id, reason);
}

/** The total of the devices table (`fleet:count`): null for one group or a search, like the server. */
function deviceTotal(db: DemoDb, { groupId, search }: { groupId?: string; search?: string }): number | null {
  if (search?.trim()) return null;
  if (groupId === NO_GROUP_FILTER) return db.devices.filter((d) => !d.groupId).length;
  if (groupId) return null;
  return db.devices.length;
}

/** Device lists: their own seam (`data/devices`), re-exported by `data/devices/demo.ts`. */
export const demoDevicesApi: DevicesApi = {
  useDevicesCount(filter) {
    const q = useDemoQuery(`fleet:count:${filter.groupId ?? ""}:${filter.search?.trim() ?? ""}`, (db) => {
      requireReader();
      return deviceTotal(db, filter);
    });
    return q.status === "ready" ? q.data : q.status === "error" ? null : undefined;
  },

  useDevicesScreen({ groupId, ...query }) {
    return useDemoServerPage("fleet:list", groupId ?? "", query, (db, sort, search) => {
      requireReader();
      if (sort && sort.key !== "created" && sort.key !== "name") fail("invalid_argument", { field: "sort" });
      if (groupId && groupId !== NO_GROUP_FILTER) find(db.groups, groupId);
      let list = db.devices;
      if (groupId === NO_GROUP_FILTER) list = list.filter((d) => !d.groupId);
      else if (groupId) list = list.filter((d) => d.groupId === groupId);
      // A search is the index's best matches in relevance order: `sort` is ignored.
      const ordered = search
        ? relevance(list, search, (d) => d.name, (d) => d.enrolledAt)
        : [...list].sort(sort?.key === "name" ? byKey((d) => d.name, sort.dir) : byKey((d) => d.enrolledAt, sort?.dir ?? "desc"));
      return ordered.map((d) => deviceRow(db, d));
    });
  },

  useDeviceInstalls(deviceId, query) {
    return useDemoServerPage("fleet:installs", deviceId, query, (db, sort) => {
      requireReader();
      return db.installs
        .filter((i) => i.deviceId === deviceId)
        .sort(byKey((i) => i.updatedAt, sort?.dir ?? "desc"))
        .map((i) => ({
          _id: i._id,
          appId: i.appId,
          appName: db.apps.find((a) => a._id === i.appId)?.name ?? "",
          state: i.state,
          attempts: i.attempts,
          exitCode: i.exitCode,
          detail: i.detail,
          updatedAt: i.updatedAt,
        }));
    });
  },
};

/** Enrollment codes: their own seam (`data/enrollment`), re-exported by `data/enrollment/demo.ts`. */
export const demoEnrollmentApi: EnrollmentApi = {
  useEnrollmentScreen(nowMinute, query) {
    // `enrollmentCodes:list`: sort keys created (default, newest first) and expires; no search, no total.
    return useDemoServerPage("enrollmentCodes:list", "", query, (db, sort) => {
      requireReader();
      if (sort && sort.key !== "created" && sort.key !== "expires") fail("invalid_argument", { field: "sort" });
      return [...db.tokens]
        .sort(sort?.key === "expires" ? byKey((t) => t.expiresAt, sort.dir) : byKey((t) => t.createdAt, sort?.dir ?? "desc"))
        .map((t) => ({
          _id: t._id,
          label: t.label,
          groupId: t.groupId,
          groupName: groupName(db, t.groupId),
          usesLeft: t.usesLeft,
          usesTotal: t.usesTotal,
          expiresAt: t.expiresAt,
          createdAt: t.createdAt,
          state: codeState(t, nowMinute),
          createdByEmail: db.members.find((m) => m._id === t.createdBy)?.email,
        }));
    });
  },

  useCreateEnrollmentCode() {
    return useCallback(
      ({ groupId, uses, ttlMinutes, label }) =>
        runMutation("admin", ({ db, me, audit, now }) => {
          const g = find(db.groups, groupId);
          if (!Number.isInteger(uses) || uses < 1 || uses > 100) fail("invalid_argument", { field: "uses" });
          if (!Number.isInteger(ttlMinutes) || ttlMinutes < 15 || ttlMinutes > 10080) fail("invalid_argument", { field: "ttlMinutes" });
          const clean = label?.trim();
          if (clean && (Array.from(clean).length > 64 || [...clean].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f))) {
            fail("invalid_argument", { field: "label" });
          }
          // As `enrollmentCodes:storeCode`: suspended, then the active-code limit (expired codes do not count).
          if (db.org.plan.status !== "active") fail("plan_limit", { detail: "suspended" });
          if (db.tokens.filter((t) => codeState(t, now) === "active").length + 1 > db.org.plan.limits.maxEnrollmentCodesActive) {
            fail("plan_limit", { detail: "enrollmentCodes" });
          }
          const id = newId("tok");
          const expiresAt = now + ttlMinutes * MIN;
          db.tokens.push({ _id: id, label: label?.trim() || undefined, groupId, usesLeft: uses, usesTotal: uses, expiresAt, revoked: false, createdAt: now, createdBy: me._id });
          audit({ action: "enrollment.codeCreated", targetType: "enrollmentCode", targetId: id, targetLabel: label?.trim() || undefined, summary: `Code for “${g.name}”, ${uses} uses.` });
          const code = `RBX1.${base64Url(`https://demo-deployment-123.convex.cloud#${token(20)}`)}`;
          return { code, expiresAt };
        }),
      [],
    );
  },

  useRevokeEnrollmentCode() {
    return useCallback(
      ({ tokenId }) =>
        runMutation(
          "admin",
          ({ db, audit }) => {
            const t = find(db.tokens, tokenId);
            if (t.revoked) return;
            t.revoked = true;
            audit({ action: "enrollment.codeRevoked", targetType: "enrollmentCode", targetId: t._id, targetLabel: t.label, summary: "Code revoked." });
          },
          // A major action on the server (plan 4.16): fresh step-up.
          "fresh",
        ),
      [],
    );
  },
};

/** Resolved through the `@rulebox/data-impl` alias in demo builds. */
export const dataApi = demoApi;

/** Audit lists: their own seam (data/audit), re-exported by data/audit/demo.ts. */
export const demoAuditApi: AuditApi = {
  // `audit:list`: sort key "at" only (newest first by default), no search, no total.
  useAuditScreen(query) {
    return useDemoServerPage("audit:list", "", query, (db, sort) => {
      requireReader();
      if (sort && sort.key !== "at") fail("invalid_argument", { field: "sort" });
      return [...db.audit].sort(byKey((e) => e.at, sort?.dir ?? "desc")).map(auditEntry);
    });
  },

  // `audit:forTarget`: the same for one device, employee, app or group.
  useHistory(targetId, query) {
    return useDemoServerPage("audit:forTarget", targetId, query, (db, sort) => {
      requireReader();
      if (sort && sort.key !== "at") fail("invalid_argument", { field: "sort" });
      return db.audit
        .filter((e) => e.targetId === targetId)
        .sort(byKey((e) => e.at, sort?.dir ?? "desc"))
        .map(auditEntry);
    });
  },
};

/** App lists: their own seam (data/apps), re-exported by data/apps/demo.ts. */
export const demoAppsApi: AppsApi = {
  // `apps:list`: sort keys created (default, newest first) and name; a search is the name index's best matches
  // (`sort` ignored).
  useAppsScreen({ archived, ...query }) {
    return useDemoServerPage("apps:list", String(archived), query, (db, sort, search) => {
      requireReader();
      if (sort && sort.key !== "created" && sort.key !== "name") fail("invalid_argument", { field: "sort" });
      const list = db.apps.filter((a) => a.archived === archived);
      const ordered = search
        ? relevance(list, search, (a) => a.name, (a) => a.createdAt)
        : [...list].sort(sort?.key === "name" ? byKey((a) => a.name, sort.dir) : byKey((a) => a.createdAt, sort?.dir ?? "desc"));
      return ordered.map(
        (a): AppRow => ({
          _id: a._id,
          name: a.name,
          description: a.description,
          kind: a.kind,
          source: a.desktop?.source,
          hue: a.hue,
          iconUrl: a.iconUrl,
          archived: a.archived,
          createdAt: a.createdAt,
          ...appGroupCount(db.assignments.filter((x) => x.appId === a._id).length),
          summary: a.kind === "desktop" ? installSummary(db, a._id) : null,
        }),
      );
    });
  },

  // `apps:count`: `appCount` counts the non-archived apps; null for the archived tab or a search.
  useAppsCount({ archived, search }) {
    const text = search?.trim() ?? "";
    const q = useDemoQuery(`apps:count:${archived}:${text}`, (db) => {
      requireReader();
      return archived || text ? null : db.apps.filter((a) => !a.archived).length;
    });
    return q.status === "ready" ? q.data : q.status === "error" ? null : undefined;
  },

  // `fileHandlers:page`: a bounded list (offset cursors, exact total inside the page); contains-search on the
  // extension and the program name; sort keys extension (default) and app.
  useFileTypesPage(query) {
    return useDemoServerPage(
      "fileHandlers:page",
      "",
      query,
      (db, sort, search) => {
        requireReader();
        if (sort && sort.key !== "extension" && sort.key !== "app") fail("invalid_argument", { field: "sort" });
        return db.fileHandlers
          .map((f) => ({ _id: f._id, extension: f.extension, appId: f.appId, appName: db.apps.find((a) => a._id === f.appId)?.name ?? "" }))
          .filter((r) => !search || contains(search, r.extension, r.appName))
          .sort(byKey((r) => (sort?.key === "app" ? `${r.appName}\u0000${r.extension}` : r.extension), sort?.dir ?? "asc"));
      },
      "o",
    );
  },

  // `apps:installs`: sort key "updated" only, no search, no total.
  useAppInstalls(appId, state, query) {
    return useDemoServerPage("apps:installs", `${appId}:${state}`, query, (db, sort) => {
      requireReader();
      if (sort && sort.key !== "updated") fail("invalid_argument", { field: "sort" });
      return db.installs
        .filter((i) => i.appId === appId && i.state === state)
        .sort(byKey((i) => i.updatedAt, sort?.dir ?? "desc"))
        .map((i) => ({
          _id: i._id,
          deviceId: i.deviceId,
          deviceName: db.devices.find((d) => d._id === i.deviceId)?.name ?? "",
          state: i.state,
          attempts: i.attempts,
          exitCode: i.exitCode,
          detail: i.detail,
          updatedAt: i.updatedAt,
        }));
    });
  },
};

/** Employee list: its own seam (data/employees), re-exported by data/employees/demo.ts. */
export const demoEmployeesApi: EmployeesApi = {
  // `employees:count`: the whole organization only; null with a group filter or a search.
  useEmployeesCount({ groupId, search }) {
    const q = useDemoQuery(`employees:count:${groupId ?? ""}:${search?.trim() ?? ""}`, (db) => {
      requireReader();
      return groupId || search?.trim() ? null : db.employees.length;
    });
    return q.status === "ready" ? q.data : q.status === "error" ? null : undefined;
  },

  useEmployeesScreen({ groupId, ...query }) {
    return useDemoServerPage("employees:list", groupId ?? "", query, (db, sort, search) => {
      requireReader();
      const key = sort?.key ?? "created";
      if (key !== "created" && key !== "name" && key !== "username") fail("invalid_argument", { field: "sort" });
      if (groupId) {
        find(db.groups, groupId);
        // As the server: a group's members come in the order they were added, nothing else.
        if (!search && key !== "created") fail("invalid_argument", { field: "sort" });
      }
      let list = db.employees;
      if (groupId) {
        const ids = new Set(db.groupMembers.filter((m) => m.groupId === groupId).map((m) => m.employeeId));
        list = list.filter((e) => ids.has(e._id));
      }
      const ordered = search
        ? relevance(list, search, (e) => `${e.name} ${e.username}`, (e) => e.createdAt)
        : [...list].sort(byKey((e) => (key === "name" ? e.name : key === "username" ? e.username : e.createdAt), sort?.dir ?? "desc"));
      return ordered.map((e) => employeeRow(db, e));
    });
  },

  // `employees:search`: the bounded picker form.
  useEmployeePicker(text) {
    const t = text.trim();
    const q = useDemoQuery(`employees:search:${t}`, (db) => {
      requireReader();
      if (!t) return { rows: [] as EmployeeRow[], capped: false };
      const hits = relevance(db.employees, t, (e) => `${e.name} ${e.username}`, (e) => e.createdAt);
      return { rows: hits.slice(0, 50).map((e) => employeeRow(db, e)), capped: hits.length > 50 };
    });
    return t ? q : { status: "ready", data: { rows: [], capped: false } };
  },
};
