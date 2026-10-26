/**
 * Demo implementation of every data hook (`VITE_DEMO=1`). Each query hook
 * computes exactly what its Convex function will return; each mutation
 * applies the server's rules (roles, revisions, uniqueness, dependents) so
 * the screens' error paths can be exercised without a backend.
 */
import { useCallback, useEffect, useState } from "react";
import type { DataApi } from "../api";
import {
  DEMO_TOTP,
  type DbApp,
  type DbDevice,
  type DemoDb,
} from "../fixtures/seed";
import {
  INSTALL_STATES,
  type AppDetail,
  type AppKind,
  type AppOption,
  type AppRow,
  type AssignmentRow,
  type AuditEntry,
  type DeviceRow,
  type EmployeeDetail,
  type EmployeeRow,
  type EnrollmentCodeRow,
  type GroupOption,
  type InstallState,
  type InstallSummary,
  type Me,
  type MeResult,
  type OverviewScreen,
} from "../types";
import * as validate from "../../lib/validate";
import {
  bumpFailedSignIns,
  checkRevision,
  clearFailedSignIns,
  controls,
  currentMember,
  db as getDb,
  fail,
  latency,
  newId,
  runMutation,
  runOptimistic,
  session,
  setSession,
  sleep,
  startHeartbeats,
  useDemoPaged,
  useDemoQuery,
  useStoreVersion,
} from "./store";

const SERVER_API_VERSION = 1;
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
  };
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
    groups: groups.slice(0, 3),
    moreGroups: groups.length > 3,
  };
}

const IN_PROGRESS: InstallState[] = ["pending", "downloading", "installing", "removing"];

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
    mfa: { enrolled: m.mfa.enrolled, required: m.role !== "viewer", verified: s.mfaVerified },
    serverApiVersion: SERVER_API_VERSION,
  };
  return me;
}

let mfaFailures = 0;
let mfaLockedUntil = 0;

function checkMfaLock() {
  const now = Date.now();
  if (mfaLockedUntil > now) fail("mfa_locked", { retryAfterMs: mfaLockedUntil - now });
}

function mfaFailed(): never {
  mfaFailures++;
  if (mfaFailures >= 5) {
    mfaFailures = 0;
    mfaLockedUntil = Date.now() + 15 * MIN;
    fail("mfa_locked", { retryAfterMs: 15 * MIN });
  }
  fail("mfa_invalid_code");
}

let pendingSecret: string | null = null;

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
        setSession({ memberId: m._id, mfaVerified: false });
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
          mfa: { enrolled: false, recoveryCodes: [] },
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
        setSession({ memberId: id, mfaVerified: false });
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

  // ---- MFA
  useMfaStatus() {
    return useDemoQuery("mfa:status", () => {
      const me = requireReader();
      const s = session();
      return {
        enrolled: me.mfa.enrolled,
        required: me.role !== "viewer",
        verified: s?.mfaVerified ?? false,
        lockedUntil: mfaLockedUntil > Date.now() ? mfaLockedUntil : null,
        recoveryCodesLeft: me.mfa.recoveryCodes.length,
      };
    });
  },

  useBeginMfaSetup() {
    return async () => {
      await sleep(latency());
      const me = currentMember();
      if (!me) fail("unauthenticated");
      if (me.mfa.enrolled) fail("mfa_already_enabled");
      pendingSecret = pendingSecret ?? token(32).replace(/[^A-Z2-7]/g, "A");
      const uri = `otpauth://totp/Rulebox:${encodeURIComponent(me.email)}?secret=${pendingSecret}&issuer=Rulebox&algorithm=SHA1&digits=6&period=30`;
      return { secret: pendingSecret, uri };
    };
  },

  useConfirmMfaSetup() {
    return async ({ code }) => {
      await sleep(latency());
      checkMfaLock();
      const m = getDb().members.find((x) => x._id === session()?.memberId);
      if (!m) fail("unauthenticated");
      if (m.mfa.enrolled) fail("mfa_already_enabled");
      if (code.replace(/\s/g, "") !== DEMO_TOTP) mfaFailed();
      const codes = Array.from({ length: 10 }, () => {
        const t = token(8);
        return `${t.slice(0, 4)}-${t.slice(4)}`;
      });
      m.mfa = { enrolled: true, recoveryCodes: codes };
      pendingSecret = null;
      mfaFailures = 0;
      setSession({ memberId: m._id, mfaVerified: true });
      return codes;
    };
  },

  useVerifyMfa() {
    return async ({ code }) => {
      await sleep(latency());
      checkMfaLock();
      const s = session();
      if (!s) fail("unauthenticated");
      if (code.replace(/\s/g, "") !== DEMO_TOTP) mfaFailed();
      mfaFailures = 0;
      setSession({ ...s, mfaVerified: true });
    };
  },

  useRedeemRecoveryCode() {
    return async ({ code }) => {
      await sleep(latency());
      checkMfaLock();
      const s = session();
      const m = getDb().members.find((x) => x._id === s?.memberId);
      if (!s || !m) fail("unauthenticated");
      const norm = validate.normalizeRecoveryCode(code);
      const i = m.mfa.recoveryCodes.indexOf(norm);
      if (i < 0) mfaFailed();
      m.mfa.recoveryCodes.splice(i, 1);
      mfaFailures = 0;
      setSession({ ...s, mfaVerified: true });
    };
  },

  // ---- overview
  useOverview(nowMinute) {
    return useDemoQuery(`overview:get:${nowMinute}`, (db): OverviewScreen => {
      requireReader();
      const window = 2.5 * db.pingIntervalMs + MIN;
      let seen = 0;
      for (const t of db.lastSeen.values()) if (nowMinute - t <= window) seen++;
      const failed = db.installs
        .filter((i) => i.state === "failed")
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 20)
        .map((i) => ({
          _id: i._id,
          deviceId: i.deviceId,
          deviceName: db.devices.find((d) => d._id === i.deviceId)?.name ?? "",
          appId: i.appId,
          appName: db.apps.find((a) => a._id === i.appId)?.name ?? "",
          detail: i.detail,
          updatedAt: i.updatedAt,
        }));
      const recent = [...db.audit].sort(byNewest);
      const publishFailed = recent.slice(0, 50).find((e) => e.action === "policy.publishFailed" && nowMinute - e.at < DAY);
      const active = db.keys.find((k) => k.status === "active");
      const next = db.keys.find((k) => k.status === "next");
      return {
        deviceCount: db.devices.length,
        pingIntervalMs: db.pingIntervalMs,
        seenRecently: Math.min(seen, 1001),
        devicesWithoutGroup: Math.min(db.devices.filter((d) => !d.groupId && !d.revoked).length, 101),
        groupCount: db.groups.length,
        employeeCount: db.employees.length,
        appCount: db.apps.filter((a) => !a.archived).length,
        failedInstalls: failed,
        recentAudit: recent.slice(0, 10).map(auditEntry),
        signing: active ? { state: next ? "rotating" : "active", keyId: active.keyId } : { state: "none" },
        publishFailedAt: publishFailed?.at,
      };
    });
  },

  // ---- devices
  useDevicesScreen({ groupId, search }) {
    const text = search?.trim().toLowerCase() ?? "";
    const paged = useDemoPaged(`fleet:list:${groupId ?? ""}:${text}`, (db) => {
      requireReader();
      let list = db.devices;
      if (groupId === "none") list = list.filter((d) => !d.groupId);
      else if (groupId) list = list.filter((d) => d.groupId === groupId);
      if (text) {
        // fleet:search: search index on name, `.take(50)`, no pagination.
        return list.filter((d) => d.name.toLowerCase().includes(text)).slice(0, 51).map((d) => deviceRow(db, d));
      }
      return [...list].sort((a, b) => b.enrolledAt - a.enrolledAt).map((d) => deviceRow(db, d));
    });
    if (text && paged.status === "ready") {
      return { ...paged, canLoadMore: false, searchCapped: paged.canLoadMore };
    }
    return paged;
  },

  useLiveStatus(deviceIds) {
    useStoreVersion();
    const db = getDb();
    const [ready, setReady] = useState(false);
    useEffect(() => {
      const t = setTimeout(() => setReady(true), 120);
      return () => clearTimeout(t);
    }, []);
    if (!ready) return undefined;
    return {
      pingIntervalMs: db.pingIntervalMs,
      items: deviceIds.slice(0, 100).flatMap((id) => {
        const t = db.lastSeen.get(id);
        return t === undefined ? [] : [{ deviceId: id, lastSeenAt: t }];
      }),
    };
  },

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
        report: db.reports.get(d._id) ?? null,
        versions: (db.versions.get(d._id) ?? []).slice(0, 5),
        flags: { noGroup: !d.groupId, revoked: d.revoked, rotateCredential: d.rotateCredential },
        groups: groupOptions(db),
      };
    });
  },

  useDeviceInstalls(deviceId) {
    return useDemoPaged(`fleet:installs:${deviceId}`, (db) => {
      requireReader();
      return db.installs
        .filter((i) => i.deviceId === deviceId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
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

  useSetKiosk() {
    return useCallback(({ deviceId, enabled }) => {
      let before = true;
      return runOptimistic(
        "admin",
        (db) => {
          const d = db.devices.find((x) => x._id === deviceId);
          if (d) {
            before = d.kioskEnabled;
            d.kioskEnabled = enabled;
          }
        },
        (db) => {
          const d = db.devices.find((x) => x._id === deviceId);
          if (d) d.kioskEnabled = before;
        },
        ({ db, audit }) => {
          const d = find(db.devices, deviceId);
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
      );
    }, []);
  },

  useRevokeDevice() {
    return useCallback(
      ({ deviceId }) =>
        runMutation("admin", ({ db, audit }) => {
          const d = find(db.devices, deviceId);
          d.revoked = true;
          d.revision++;
          db.onlineIds.delete(d._id);
          audit({ action: "device.revoked", targetType: "device", targetId: d._id, targetLabel: d.name, summary: "Revoked." });
        }),
      [],
    );
  },

  useRemoveDevice() {
    return useCallback(
      ({ deviceId }) =>
        runMutation("admin", ({ db, audit }) => {
          const d = find(db.devices, deviceId);
          if (!d.revoked) fail("invalid_argument", { field: "revoked" });
          db.devices = db.devices.filter((x) => x._id !== deviceId);
          db.installs = db.installs.filter((x) => x.deviceId !== deviceId);
          db.reports.delete(deviceId);
          db.lastSeen.delete(deviceId);
          db.versions.delete(deviceId);
          audit({ action: "device.removed", targetType: "device", targetId: d._id, targetLabel: d.name, summary: "Removed from Rulebox." });
        }),
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
          createdAt: g.createdAt,
          deviceCount: Math.min(db.devices.filter((d) => d.groupId === g._id).length, 501),
          employeeCount: Math.min(db.groupMembers.filter((m) => m.groupId === g._id).length, 501),
        }));
    });
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
        enrollmentCodeCount: db.tokens.filter((t) => t.groupId === g._id && codeState(t, Date.now()) === "active").length,
        appOptions: appOptions(db),
      };
    });
  },

  useCreateGroup() {
    return useCallback(
      ({ name, description }) =>
        runMutation("admin", ({ db, audit, now }) => {
          const clean = nameOrFail(name, validate.NAME_MAX.group);
          if (db.groups.some((g) => g.name.toLowerCase() === clean.toLowerCase())) fail("conflict", { field: "name" });
          const id = newId("grp");
          db.groups.push({ _id: id, name: clean, description: description?.trim() || undefined, revision: 0, createdAt: now });
          audit({ action: "group.created", targetType: "group", targetId: id, targetLabel: clean, summary: `Group “${clean}” created.` });
          return id;
        }),
      [],
    );
  },

  useUpdateGroup() {
    return useCallback(
      ({ groupId, expectedRevision, name, description }) =>
        runMutation("admin", ({ db, audit }) => {
          const g = find(db.groups, groupId);
          checkRevision(g, expectedRevision);
          const clean = nameOrFail(name, validate.NAME_MAX.group);
          if (db.groups.some((x) => x._id !== g._id && x.name.toLowerCase() === clean.toLowerCase())) fail("conflict", { field: "name" });
          const renamed = g.name !== clean;
          g.name = clean;
          g.description = description?.trim() || undefined;
          g.revision++;
          audit({ action: renamed ? "group.renamed" : "group.renamed", targetType: "group", targetId: g._id, targetLabel: clean, summary: renamed ? `Renamed to “${clean}”.` : "Description changed." });
        }),
      [],
    );
  },

  useDeleteGroup() {
    return useCallback(
      ({ groupId }) =>
        runMutation("admin", ({ db, audit }) => {
          const g = find(db.groups, groupId);
          const busy =
            db.devices.some((d) => d.groupId === groupId) ||
            db.groupMembers.some((m) => m.groupId === groupId) ||
            db.assignments.some((a) => a.groupId === groupId) ||
            db.tokens.some((t) => t.groupId === groupId && !t.revoked && t.expiresAt > Date.now() && t.usesLeft > 0);
          if (busy) fail("has_dependents");
          db.groups = db.groups.filter((x) => x._id !== groupId);
          audit({ action: "group.deleted", targetType: "group", targetId: g._id, targetLabel: g.name, summary: `Group “${g.name}” deleted.` });
        }),
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
          if (db.groupMembers.some((m) => m.groupId === groupId && m.employeeId === employeeId)) fail("conflict");
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

  // ---- employees
  useEmployeesScreen({ groupId, search }) {
    const text = search?.trim().toLowerCase() ?? "";
    const paged = useDemoPaged(`employees:list:${groupId ?? ""}:${text}`, (db) => {
      requireReader();
      let list = db.employees;
      if (groupId) {
        const ids = new Set(db.groupMembers.filter((m) => m.groupId === groupId).map((m) => m.employeeId));
        list = list.filter((e) => ids.has(e._id));
      }
      if (text) {
        return list
          .filter((e) => `${e.name} ${e.username}`.toLowerCase().includes(text))
          .slice(0, 51)
          .map((e) => employeeRow(db, e));
      }
      return [...list].sort((a, b) => b.createdAt - a.createdAt).map((e) => employeeRow(db, e));
    });
    if (text && paged.status === "ready") {
      return { ...paged, canLoadMore: false, searchCapped: paged.canLoadMore };
    }
    return paged;
  },

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
          e.name = name;
          e.username = username;
          e.quotaGb = input.quotaGb;
          e.revision++;
          const oldGroups = db.groupMembers.filter((m) => m.employeeId === e._id).map((m) => m.groupId).sort();
          if (oldGroups.join() !== [...input.groupIds].sort().join()) changed.push("groups");
          db.groupMembers = db.groupMembers.filter((m) => m.employeeId !== e._id);
          for (const g of input.groupIds) db.groupMembers.push({ groupId: g, employeeId: e._id });
          const oldApps = db.employeeApps.filter((m) => m.employeeId === e._id).map((m) => m.appId).sort();
          if (oldApps.join() !== [...input.appIds].sort().join()) changed.push("apps");
          db.employeeApps = db.employeeApps.filter((m) => m.employeeId !== e._id);
          for (const a of input.appIds) db.employeeApps.push({ employeeId: e._id, appId: a });
          audit({
            action: "employee.updated",
            targetType: "employee",
            targetId: e._id,
            targetLabel: name,
            summary: changed.length ? `Changed: ${changed.join(", ")}.` : "Saved without changes.",
          });
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
          e.disabled = disabled;
          e.revision++;
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
  useAppsScreen({ archived }) {
    return useDemoPaged(`apps:list:${archived}`, (db) => {
      requireReader();
      return db.apps
        .filter((a) => a.archived === archived)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(
          (a): AppRow => ({
            _id: a._id,
            name: a.name,
            description: a.description,
            kind: a.kind,
            source: a.desktop?.source,
            hue: a.hue,
            archived: a.archived,
            groupCount: db.assignments.filter((x) => x.appId === a._id).length,
            summary: a.kind === "desktop" ? installSummary(db, a._id) : null,
          }),
        );
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
          installCounts: {},
          groupOptions: groupOptions(db),
        };
      }
      const a = find(db.apps, appId);
      const counts: Partial<Record<InstallState, number>> = {};
      for (const s of INSTALL_STATES) {
        const c = db.installs.filter((i) => i.appId === a._id && i.state === s).length;
        if (c) counts[s] = Math.min(c, 1001);
      }
      return {
        _id: a._id,
        name: a.name,
        description: a.description,
        kind: a.kind,
        hue: a.hue,
        web: a.web,
        desktop: a.desktop,
        archived: a.archived,
        revision: a.revision,
        createdAt: a.createdAt,
        assignments: db.assignments.filter((x) => x.appId === a._id).map((x) => assignmentRow(db, x)),
        fileTypes: db.fileHandlers.filter((f) => f.appId === a._id).map((f) => f.extension).sort(),
        directEmployeeCount: Math.min(db.employeeApps.filter((m) => m.appId === a._id).length, 1001),
        installCounts: counts,
        groupOptions: groupOptions(db),
      };
    });
  },

  useAppInstalls(appId, state) {
    return useDemoPaged(`apps:installs:${appId}:${state}`, (db) => {
      requireReader();
      return db.installs
        .filter((i) => i.appId === appId && i.state === state)
        .sort((a, b) => b.updatedAt - a.updatedAt)
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
              permissions: { camera: false, microphone: false, screenShare: false, clipboardRead: false, notifications: true, downloads: true, printing: false, geolocation: false },
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
            a.web = { ...(a.web ?? { permissions: { camera: false, microphone: false, screenShare: false, clipboardRead: false, notifications: true, downloads: true, printing: false, geolocation: false } }), url: web.url.trim(), allowedDomains: [...new Set([host, ...web.allowedDomains])] };
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
      return { name: base.charAt(0).toUpperCase() + base.slice(1), hue: hash };
    }, []);
  },

  // ---- file types
  useFileTypesScreen() {
    return useDemoQuery("fileHandlers:list", (db) => {
      requireReader();
      return {
        rows: [...db.fileHandlers]
          .sort((a, b) => a.extension.localeCompare(b.extension))
          .map((f) => ({ ...f, appName: db.apps.find((a) => a._id === f.appId)?.name ?? "" })),
        appOptions: appOptions(db).filter((a) => a.canOpenFiles),
      };
    });
  },

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

  // ---- enrollment
  useEnrollmentScreen(nowMinute) {
    return useDemoPaged(`enrollmentCodes:list:${nowMinute}`, (db) => {
      requireReader();
      return [...db.tokens]
        .sort((a, b) => b.createdAt - a.createdAt)
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
          if (ttlMinutes < 15 || ttlMinutes > 10080) fail("invalid_argument", { field: "ttlMinutes" });
          if (!db.keys.some((k) => k.status === "active")) fail("not_ready");
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
        runMutation("admin", ({ db, audit }) => {
          const t = find(db.tokens, tokenId);
          t.revoked = true;
          audit({ action: "enrollment.codeRevoked", targetType: "enrollmentCode", targetId: t._id, targetLabel: t.label, summary: "Code revoked." });
        }),
      [],
    );
  },

  // ---- audit
  useAuditScreen() {
    return useDemoPaged("audit:list", (db) => {
      requireReader();
      return [...db.audit].sort(byNewest).map(auditEntry);
    });
  },

  useHistory(targetId) {
    return useDemoPaged(`audit:forTarget:${targetId}`, (db) => {
      requireReader();
      return db.audit.filter((e) => e.targetId === targetId).sort(byNewest).map(auditEntry);
    });
  },

  // ---- settings
  useSettingsScreen() {
    return useDemoQuery("settings:get", (db) => {
      requireReader();
      return {
        name: db.org.name,
        revision: db.org.revision,
        settings: structuredClone(db.org.settings),
        exitPin: { set: db.org.exitPinSet },
      };
    });
  },

  useUpdateSettings() {
    return useCallback(
      ({ expectedRevision, name, settings }) =>
        runMutation("admin", ({ db, audit }) => {
          checkRevision(db.org, expectedRevision);
          const clean = nameOrFail(name, validate.NAME_MAX.org);
          if (settings.offlineDays < 0 || settings.offlineDays > 30) fail("invalid_argument", { field: "offlineDays" });
          if (settings.defaultQuotaGb < 0 || settings.defaultQuotaGb > 2000) fail("invalid_argument", { field: "defaultQuotaGb" });
          const hk = validate.parseHotkey(settings.adminExit.hotkey);
          if (!hk.ok) fail("invalid_argument", { field: "hotkey" });
          const before = db.org.settings;
          const changed: string[] = [];
          if (db.org.name !== clean) changed.push("name");
          if (before.offlineDays !== settings.offlineDays) changed.push("offlineDays");
          if (before.defaultQuotaGb !== settings.defaultQuotaGb) changed.push("defaultQuotaGb");
          if (JSON.stringify(before.power) !== JSON.stringify(settings.power)) changed.push("power");
          if (JSON.stringify(before.adminExit) !== JSON.stringify({ ...settings.adminExit, hotkey: hk.canonical })) changed.push("adminExit");
          db.org.name = clean;
          db.org.settings = { ...settings, adminExit: { ...settings.adminExit, hotkey: hk.canonical } };
          db.org.revision++;
          audit({ action: "org.settingsChanged", summary: changed.length ? `Changed: ${changed.join(", ")}.` : "Saved without changes." });
        }),
      [],
    );
  },

  useSetExitPin() {
    return useCallback(
      ({ pin }) =>
        runMutation("admin", ({ db, audit }) => {
          if (validate.exitPin(pin)) fail("invalid_argument", { field: "pin" });
          db.org.exitPinSet = true;
          audit({ action: "org.exitPinSet", summary: "Exit PIN set." });
        }),
      [],
    );
  },

  useClearExitPin() {
    return useCallback(
      () =>
        runMutation("admin", ({ db, audit }) => {
          db.org.exitPinSet = false;
          audit({ action: "org.exitPinCleared", summary: "Exit PIN cleared." });
        }),
      [],
    );
  },

  useKeysScreen() {
    return useDemoQuery("keys:status", (db) => {
      requireReader();
      const next = db.keys.find((k) => k.status === "next");
      const live = db.devices.filter((d) => !d.revoked);
      return {
        envKeyPresent: db.env.key,
        envNextKeyPresent: db.env.next,
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

  useMembersScreen() {
    return useDemoQuery("members:list", (db) => {
      const me = requireReader();
      return {
        members: [...db.members]
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(0, 200)
          .map((m) => ({
            _id: m._id,
            email: m.email,
            role: m._id === me._id ? me.role : m.role,
            status: m.status,
            createdAt: m.createdAt,
            mfaEnrolled: m.mfa.enrolled,
            isYou: m._id === me._id,
            revision: m.revision,
          })),
        invites: db.invites
          .filter((i) => !i.usedAt && i.expiresAt > Date.now())
          .map((i) => ({ _id: i._id, email: i.email, role: i.role, kind: i.kind, expiresAt: i.expiresAt })),
      };
    });
  },

  useInviteMember() {
    return useCallback(
      ({ email, role }) =>
        runMutation("owner", ({ db, audit, now }) => {
          if (validate.email(email)) fail("invalid_argument", { field: "email" });
          const addr = email.trim().toLowerCase();
          if (db.members.some((m) => m.email === addr)) fail("already_member");
          const code = token(20);
          const expiresAt = now + 7 * DAY;
          db.invites.push({ _id: newId("inv"), email: addr, role, kind: "join", code, expiresAt });
          audit({ action: "member.invited", targetLabel: addr, summary: `Invited ${addr} as ${role}.` });
          return { code, expiresAt };
        }),
      [],
    );
  },

  useRevokeInvite() {
    return useCallback(
      ({ inviteId }) =>
        runMutation("owner", ({ db }) => {
          find(db.invites, inviteId);
          db.invites = db.invites.filter((i) => i._id !== inviteId);
        }),
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
        }),
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
        }),
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
          db.invites.push({ _id: newId("inv"), email: m.email, role: m.role, kind: "passwordReset", code, expiresAt });
          audit({ action: "member.resetCodeCreated", targetLabel: m.email, summary: "Password reset code created." });
          return { code, expiresAt };
        }),
      [],
    );
  },

  useResetMemberMfa() {
    return useCallback(
      ({ memberId }) =>
        runMutation("owner", ({ db, audit }) => {
          const m = find(db.members, memberId);
          m.mfa = { enrolled: false, recoveryCodes: [] };
          audit({ action: "member.mfaReset", targetLabel: m.email, summary: "Two-step sign-in reset." });
        }),
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

/** Resolved through the `@rulebox/data-impl` alias in demo builds. */
export const dataApi = demoApi;

