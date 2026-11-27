import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice, probe } from "../tests/convex/devices";
import { asMember, expectCode, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { addWifi, MASTER_A, setMaster } from "../tests/convex/phase5";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auditPolicy } from "./lib/audit";
import { snapshotGroupConfig } from "./lib/groupConfig";
import { DAY_MS, MAX_ALLOW_GROUPS, MAX_GROUP_EXCEPTIONS, MINUTE_MS, OPEN_FINDINGS_CAP } from "./lib/limits";
import { DEFAULT_LOCKDOWN_SETTINGS, type LockdownSettings } from "./lib/lockdownValidators";
import { exceptionPath } from "./lockdown";

// The lockdown screens (Phase 5 Step 19, plan 4.20): group settings, findings review, exceptions, "Allow USB for this PC", the device
// page's Protection / Lockdown data and the overview warnings.

beforeEach(() => {
  vi.useFakeTimers();
  auditPolicy.strict = true;
  setMaster(MASTER_A);
});
afterEach(() => {
  vi.useRealTimers();
  auditPolicy.strict = false;
  setMaster(undefined);
});
const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

async function setup() {
  const t = await setupAuth();
  const orgId = await makeOrg(t, "Acme");
  const groupId = await t.run((ctx) => ctx.db.insert("groups", { orgId, name: "Sales", revision: 0, createdAt: Date.now() }));
  const pc = await enrollDevice(t, orgId, { groupId, name: "Front desk PC" });
  const adm = await asMember(t, { role: "admin", orgId });
  await giveStepUp(t, adm);
  // Unlocked but not fresh: verified 6 minutes ago, active now.
  const stale = await asMember(t, { role: "admin", orgId });
  await giveStepUp(t, stale, { verifiedAgoMs: 6 * MINUTE_MS, activeAgoMs: 0 });
  const view = await asMember(t, { role: "viewer", orgId });
  await t.run((ctx) => snapshotGroupConfig(ctx, groupId, "first"));
  await drain(t);
  return { t, orgId, groupId, pc, admin: adm.as, stale: stale.as, viewer: view.as };
}
type Env = Awaited<ReturnType<typeof setup>>;

const D = DEFAULT_LOCKDOWN_SETTINGS;
const view = (e: Env) => e.admin.query(api.lockdown.groupView, { groupId: e.groupId });
/** The audit actions written after the fixture's own (the PC's enrollment). */
const audits = (e: Env) => e.t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).map((a) => a.action).filter((a) => a !== "device.enrolled"));
const save = (e: Env, settings: LockdownSettings, expectedRevision: number, as = e.admin) =>
  as.mutation(api.lockdown.update, { groupId: e.groupId, settings, expectedRevision });
const detailOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err instanceof ConvexError ? (err.data as { code: string; detail?: string; field?: string }) : null;
  }
  return null;
};

type FindingSeed = { layer?: "appLocker" | "appControl" | "procWatch"; fileName?: string; folderClass?: string; signer?: string; sha256?: string; status?: "new" | "allowed" | "ignored"; seen?: number };
let n = 0;
async function addFinding(e: Env, f: FindingSeed = {}): Promise<Id<"lockdownFindings">> {
  n++;
  return await e.t.run((ctx) =>
    ctx.db.insert("lockdownFindings", {
      orgId: e.orgId,
      fingerprint: n.toString(16).padStart(64, "0"),
      layer: f.layer ?? "appLocker",
      fileName: f.fileName ?? `tool${n}.exe`,
      folderClass: f.folderClass ?? "userProfile",
      signer: "signer" in f ? f.signer : "Contoso Ltd",
      product: "Tool",
      sha256: "sha256" in f ? f.sha256 : "e".repeat(64),
      firstSeenAt: f.seen ?? Date.now(),
      lastSeenAt: f.seen ?? Date.now(),
      deviceCount: 1,
      sampleDeviceId: e.pc.deviceId,
      status: f.status ?? "new",
    }),
  );
}
const findingOf = (e: Env, id: Id<"lockdownFindings">) => e.t.run((ctx) => ctx.db.get(id));
const exceptionsOf = (e: Env) => e.t.run((ctx) => ctx.db.query("lockdownExceptions").collect());
const configVersions = (e: Env) =>
  e.t.run(async (ctx) => (await ctx.db.query("groupConfigs").withIndex("by_group_version", (q) => q.eq("groupId", e.groupId)).collect()).length);

describe("lockdown:groupView and lockdown:update", () => {
  test("a group that never saved shows the defaults at revision 0; a viewer reads, and cannot save", async () => {
    const e = await setup();
    const v = await e.viewer.query(api.lockdown.groupView, { groupId: e.groupId });
    expect(v).toMatchObject({ groupName: "Sales", settings: D, revision: 0, auditSince: null, exceptions: [], openFindings: 0, openFindingsMore: false });
    await expectCode(save(e, { ...D, accessibilityTools: true }, 0, e.viewer), "forbidden");
  });

  test("`hideAdminTiles` is off for a new group (owner 2026-11-28); a group that already saved it on keeps it", async () => {
    expect(D.machine.hideAdminTiles).toBe(false);
    const e = await setup();
    const fresh = await e.viewer.query(api.lockdown.groupView, { groupId: e.groupId });
    expect(fresh.settings.machine.hideAdminTiles).toBe(false);
    // An existing group's stored value is never flipped by the new default (no migration).
    await e.t.run((ctx) =>
      ctx.db.insert("groupLockdown", { orgId: e.orgId, groupId: e.groupId, settings: { ...D, machine: { ...D.machine, hideAdminTiles: true } }, revision: 1 }),
    );
    const stored = await e.viewer.query(api.lockdown.groupView, { groupId: e.groupId });
    expect(stored.settings.machine.hideAdminTiles).toBe(true);
  });

  test("the same settings again write nothing; a plain switch needs no fresh step-up and audits settingsChanged", async () => {
    const e = await setup();
    const same = await probe(() => save(e, D, 0));
    expect(same.io.writes).toBe(0);
    expect(same.result).toEqual({ revision: 0 });

    const before = await configVersions(e);
    expect(await save(e, { ...D, accessibilityTools: true }, 0, e.stale)).toEqual({ revision: 1 });
    expect((await view(e)).settings.accessibilityTools).toBe(true);
    expect(await configVersions(e)).toBe(before + 1);
    expect(await audits(e)).toEqual(["lockdown.settingsChanged"]);
    // The first save starts the audit clock (the program rules are in audit mode by default).
    expect((await view(e)).auditSince).not.toBeNull();
  });

  test("a mode change is a major action: refused with a step-up older than 5 minutes, done with a fresh one", async () => {
    const e = await setup();
    const enforce = { ...D, appLocker: { mode: "enforce" as const } };
    await expectCode(save(e, enforce, 0, e.stale), "step_up_required");
    expect((await view(e)).revision).toBe(0);
    expect(await save(e, enforce, 0)).toEqual({ revision: 1 });
    expect(await audits(e)).toEqual(["lockdown.layerModeChanged"]);
    // The App Control level is the same kind of change.
    await expectCode(save(e, { ...enforce, appControl: { mode: "audit", level: "allowlist" } }, 1, e.stale), "step_up_required");
  });

  test("the audit clock stops when no program rule is in audit mode", async () => {
    const e = await setup();
    await save(e, { ...D, accessibilityTools: true }, 0);
    const off = { ...D, appLocker: { mode: "enforce" as const }, appControl: { mode: "enforce" as const, level: "recommendedBlocks" as const }, procWatch: { mode: "off" as const } };
    await save(e, off, 1);
    expect((await view(e)).auditSince).toBeNull();
  });

  test("a stale revision is refused", async () => {
    const e = await setup();
    await save(e, { ...D, accessibilityTools: true }, 0);
    await expectCode(save(e, { ...D, accessibilityTools: false }, 0), "stale_edit");
  });

  test("account lockout: a threshold under 5 and a window longer than the lockout are refused; null is accepted", async () => {
    const e = await setup();
    const lock = (accountLockout: LockdownSettings["machine"]["accountLockout"]) => save(e, { ...D, machine: { ...D.machine, accountLockout } }, 0);
    expect(await detailOf(lock({ threshold: 4, durationMin: 15, windowMin: 15 }))).toMatchObject({ code: "invalid_argument", field: "accountLockout.threshold" });
    expect(await detailOf(lock({ threshold: 10, durationMin: 15, windowMin: 30 }))).toMatchObject({ code: "invalid_argument", field: "accountLockout.windowMin" });
    expect(await detailOf(lock({ threshold: 10, durationMin: 0, windowMin: 1 }))).toMatchObject({ code: "invalid_argument", field: "accountLockout.durationMin" });
    expect(await lock(null)).toEqual({ revision: 1 });
  });

  test("managed networks only needs a Wi-Fi network in the group", async () => {
    const e = await setup();
    expect(await detailOf(save(e, { ...D, wifiManagedOnly: true }, 0))).toMatchObject({ code: "conflict", detail: "managed_networks_empty" });
    await addWifi(e.t, e.orgId, { groupIds: [e.groupId], ssid: "Acme-Staff", security: "open", passphrase: null });
    expect(await save(e, { ...D, wifiManagedOnly: true }, 0)).toEqual({ revision: 1 });
  });

  test("the saved settings reach the group's next configuration version", async () => {
    const e = await setup();
    await save(e, { ...D, usb: { ...D.usb, storage: "block", other: "block", retroactive: true } }, 0);
    const newest = await e.t.run(async (ctx) =>
      ctx.db.query("groupConfigs").withIndex("by_group_version", (q) => q.eq("groupId", e.groupId)).order("desc").first(),
    );
    expect(newest?.reason).toBe("Lockdown settings changed");
    expect((JSON.parse(newest!.config) as { lockdown: { usb: unknown } }).lockdown.usb).toEqual({ storage: "block", printers: "allow", imaging: "allow", phones: "allow", other: "block", retroactive: true });
  });

  test("the open findings count stops at the cap", async () => {
    const e = await setup();
    for (let i = 0; i < OPEN_FINDINGS_CAP + 2; i++) await addFinding(e);
    await addFinding(e, { status: "ignored" });
    expect(await view(e)).toMatchObject({ openFindings: OPEN_FINDINGS_CAP, openFindingsMore: true });
  });
});

describe("lockdown:findings", () => {
  test("pages through one status, last seen first, and never returns a hash or a path", async () => {
    const e = await setup();
    for (let i = 0; i < 5; i++) await addFinding(e, { fileName: `p${i}.exe`, seen: 1_000 + i });
    await addFinding(e, { status: "ignored", fileName: "old.exe" });
    const first = await e.viewer.query(api.lockdown.findings, { status: "new", paginationOpts: { numItems: 2, cursor: null } });
    expect(first.page.map((f) => f.fileName)).toEqual(["p4.exe", "p3.exe"]);
    expect(first.isDone).toBe(false);
    const second = await e.viewer.query(api.lockdown.findings, { status: "new", paginationOpts: { numItems: 2, cursor: first.continueCursor } });
    expect(second.page.map((f) => f.fileName)).toEqual(["p2.exe", "p1.exe"]);
    const oldest = await e.viewer.query(api.lockdown.findings, { status: "new", paginationOpts: { numItems: 2, cursor: null }, sort: { key: "seen", dir: "asc" } });
    expect(oldest.page.map((f) => f.fileName)).toEqual(["p0.exe", "p1.exe"]);
    const ignored = await e.viewer.query(api.lockdown.findings, { status: "ignored", paginationOpts: { numItems: 10, cursor: null } });
    expect(ignored.page.map((f) => f.fileName)).toEqual(["old.exe"]);
    const text = JSON.stringify(first);
    expect(text).not.toContain("e".repeat(64));
    expect(first.page[0]).toMatchObject({ hasHash: true, signer: "Contoso Ltd", folderClass: "userProfile", layer: "appLocker" });
    expect(Object.keys(first.page[0]!)).not.toContain("sha256");
  });

  test("an unknown sort key and a page over 50 are refused", async () => {
    const e = await setup();
    await expectCode(e.viewer.query(api.lockdown.findings, { status: "new", paginationOpts: { numItems: 10, cursor: null }, sort: { key: "name", dir: "asc" } }), "invalid_argument");
    await expectCode(e.viewer.query(api.lockdown.findings, { status: "new", paginationOpts: { numItems: 51, cursor: null } }), "invalid_argument");
  });

  test("another organization's findings are not listed", async () => {
    const e = await setup();
    await addFinding(e);
    const other = await makeOrg(e.t, "Other");
    const stranger = await asMember(e.t, { role: "owner", orgId: other });
    const page = await stranger.as.query(api.lockdown.findings, { status: "new", paginationOpts: { numItems: 10, cursor: null } });
    expect(page.page).toEqual([]);
  });
});

describe("lockdown:allow, ignore, removeException", () => {
  test("a publisher rule: exception for the group, finding allowed, new configuration version, audit", async () => {
    const e = await setup();
    const id = await addFinding(e, { fileName: "tool.exe" });
    const before = await configVersions(e);
    expect(await e.admin.mutation(api.lockdown.allow, { findingId: id, kind: "publisher", groupIds: [e.groupId], reason: "Needed by sales" })).toEqual({ added: 1 });
    const rows = await exceptionsOf(e);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      groupId: e.groupId,
      findingId: id,
      reason: "Needed by sales",
      rule: { kind: "publisher", publisher: { subject: "Contoso Ltd", product: "Tool", fileName: "tool.exe" }, layers: ["appLocker", "procWatch"] },
    });
    expect((await findingOf(e, id))?.status).toBe("allowed");
    expect(await configVersions(e)).toBe(before + 1);
    expect(await audits(e)).toEqual(["lockdown.exceptionAdded"]);
    const v = await view(e);
    expect(v.exceptions).toHaveLength(1);
    expect(v.exceptions[0]!.rule).toMatchObject({ kind: "publisher", subject: "Contoso Ltd", fileName: "tool.exe", hashStart: null, path: null });
    // The same rule again adds nothing.
    const again = await probe(() => e.admin.mutation(api.lockdown.allow, { findingId: id, kind: "publisher", groupIds: [e.groupId] }));
    expect(again.result).toEqual({ added: 0 });
    expect(again.io.writes).toBe(0);
  });

  test("a hash rule carries the file's hash; the view shows only its start", async () => {
    const e = await setup();
    const id = await addFinding(e, { signer: undefined });
    await e.admin.mutation(api.lockdown.allow, { findingId: id, kind: "hash", groupIds: [e.groupId] });
    expect((await exceptionsOf(e))[0]!.rule).toEqual({ kind: "hash", sha256: "e".repeat(64), layers: ["appLocker", "procWatch"] });
    expect((await view(e)).exceptions[0]!.rule.hashStart).toBe("e".repeat(12));
  });

  test("refusals: no signer, no hash, App Control findings, a path rule outside admin-only folders, a bad folder", async () => {
    const e = await setup();
    const unsigned = await addFinding(e, { signer: undefined, sha256: undefined });
    const allow = (findingId: string, kind: "publisher" | "hash" | "path", folder?: string) =>
      detailOf(e.admin.mutation(api.lockdown.allow, { findingId, kind, groupIds: [e.groupId], folder }));
    expect(await allow(unsigned, "publisher")).toMatchObject({ code: "conflict", detail: "no_signer" });
    expect(await allow(unsigned, "hash")).toMatchObject({ code: "conflict", detail: "no_hash" });
    expect(await allow(await addFinding(e, { layer: "appControl" }), "publisher")).toMatchObject({ code: "conflict", detail: "app_control_finding" });
    expect(await allow(await addFinding(e, { folderClass: "userProfile" }), "path", "{ProgramFiles}\\Acme")).toMatchObject({ code: "conflict", detail: "path_not_admin_only" });
    const inProgramFiles = await addFinding(e, { folderClass: "programFiles", fileName: "tool.exe" });
    expect(await allow(inProgramFiles, "path")).toMatchObject({ code: "invalid_argument", field: "folder" });
    expect(await allow(inProgramFiles, "path", "C:\\Users\\maya")).toMatchObject({ code: "invalid_argument", field: "folder" });
    expect(await allow(inProgramFiles, "path", "{LocalAppData}\\Acme")).toMatchObject({ code: "invalid_argument", field: "folder" });
    expect(await allow(inProgramFiles, "path", "{SystemRoot}\\System32")).toMatchObject({ code: "invalid_argument", field: "folder" });
    expect(await allow(inProgramFiles, "path", "{ProgramFiles}\\..\\Users")).toMatchObject({ code: "invalid_argument", field: "folder" });
    expect(await exceptionsOf(e)).toEqual([]);
    await e.admin.mutation(api.lockdown.allow, { findingId: inProgramFiles, kind: "path", groupIds: [e.groupId], folder: "{ProgramFiles}\\Acme\\" });
    expect((await exceptionsOf(e))[0]!.rule).toEqual({ kind: "path", path: "{ProgramFiles}\\Acme\\tool.exe", layers: ["appLocker", "procWatch"] });
  });

  test("exceptionPath accepts the three admin-only roots only", () => {
    expect(exceptionPath("{ProgramFilesX86}\\Acme", "a.exe")).toBe("{ProgramFilesX86}\\Acme\\a.exe");
    expect(exceptionPath("{RuleboxApps}\\app1", "a.exe")).toBe("{RuleboxApps}\\app1\\a.exe");
    expect(() => exceptionPath("{ProgramFiles}\\Acme", "a.bat")).toThrow();
    expect(() => exceptionPath("{ProgramFiles}\\PowerShell\\7", "pwsh.exe")).toThrow();
  });

  test("more than 100 groups, no group and an unknown group are refused; a viewer cannot allow", async () => {
    const e = await setup();
    const id = await addFinding(e);
    const many = await e.t.run(async (ctx) => {
      const ids: string[] = [];
      for (let i = 0; i < MAX_ALLOW_GROUPS + 1; i++) ids.push(await ctx.db.insert("groups", { orgId: e.orgId, name: `G${i}`, revision: 0, createdAt: Date.now() }));
      return ids;
    });
    expect(await detailOf(e.admin.mutation(api.lockdown.allow, { findingId: id, kind: "publisher", groupIds: many }))).toMatchObject({ code: "too_large", detail: "groups" });
    expect(await detailOf(e.admin.mutation(api.lockdown.allow, { findingId: id, kind: "publisher", groupIds: [] }))).toMatchObject({ code: "invalid_argument", field: "groupIds" });
    await expectCode(e.admin.mutation(api.lockdown.allow, { findingId: id, kind: "publisher", groupIds: [id] }), "not_found");
    await expectCode(e.viewer.mutation(api.lockdown.allow, { findingId: id, kind: "publisher", groupIds: [e.groupId] }), "forbidden");
    expect((await findingOf(e, id))?.status).toBe("new");
  });

  test("Step 20b: 25 groups get the exception, 10 in the call and the other 15 by scheduled batches; a group at the cap is skipped in a batch", async () => {
    const e = await setup();
    const id = await addFinding(e);
    const many = await e.t.run(async (ctx) => {
      const ids: Id<"groups">[] = [];
      for (let i = 0; i < 25; i++) ids.push(await ctx.db.insert("groups", { orgId: e.orgId, name: `G${i}`, revision: 0, createdAt: Date.now() }));
      return ids;
    });
    // The 25th group is full: its batch skips it, the call still succeeds.
    await e.t.run(async (ctx) => {
      for (let i = 0; i < MAX_GROUP_EXCEPTIONS; i++) {
        await ctx.db.insert("lockdownExceptions", { orgId: e.orgId, groupId: many[24]!, rule: { kind: "hash", sha256: String(i).padStart(64, "0"), layers: ["appLocker"] }, reason: "", createdAt: 1 });
      }
    });
    const count = () => e.t.run(async (ctx) => (await ctx.db.query("lockdownExceptions").collect()).filter((x) => x.findingId === id).length);
    const versions = () => e.t.run(async (ctx) => (await ctx.db.query("groupConfigs").collect()).length);
    const before = await versions();
    expect(await e.admin.mutation(api.lockdown.allow, { findingId: id, kind: "publisher", groupIds: many })).toEqual({ added: 25 });
    expect(await count()).toBe(10);
    expect(await versions()).toBe(before + 10);
    await e.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await count()).toBe(24);
    expect(await versions()).toBe(before + 24);
    expect((await findingOf(e, id))?.status).toBe("allowed");
    expect(await audits(e)).toEqual(["lockdown.exceptionAdded"]);
  });

  test("Step 20b: wifiManagedOnlyConfirmed is stored only when true and managed-only is on, and it is part of the next configuration version", async () => {
    const e = await setup();
    const base = (await view(e)).settings;
    const save = async (settings: object, expectedRevision: number) => e.admin.mutation(api.lockdown.update, { groupId: e.groupId, settings: settings as never, expectedRevision });
    await e.t.run((ctx) => ctx.db.insert("wifiProfiles", { orgId: e.orgId, name: "A", ssid: "A", hidden: false, security: "open", autoConnect: true, groupIds: [e.groupId], revision: 1, createdAt: 1 }));
    // Confirmed without managed-only is dropped: nothing changed, no write.
    const noop = await probe(() => save({ ...base, wifiManagedOnlyConfirmed: true }, 0));
    expect(noop.io.writes).toBe(0);
    expect((await save({ ...base, wifiManagedOnly: true, wifiManagedOnlyConfirmed: true }, 0)).revision).toBe(1);
    expect((await view(e)).settings).toMatchObject({ wifiManagedOnly: true, wifiManagedOnlyConfirmed: true });
    const latest = async () => JSON.parse((await e.t.run((ctx) => ctx.db.query("groupConfigs").withIndex("by_group_version", (q) => q.eq("groupId", e.groupId)).order("desc").first()))!.config) as Record<string, unknown>;
    expect(Object.keys(await latest()).slice(0, 4)).toEqual(["lockdown", "wifiManagedOnly", "wifiManagedOnlyConfirmed", "wifi"]);
    // False is never stored: the key goes away again.
    expect((await save({ ...base, wifiManagedOnly: true, wifiManagedOnlyConfirmed: false }, 1)).revision).toBe(2);
    expect((await view(e)).settings).not.toHaveProperty("wifiManagedOnlyConfirmed");
    expect(await latest()).not.toHaveProperty("wifiManagedOnlyConfirmed");
  });
  test("ignore: the finding leaves the open list; again writes nothing; an allowed finding is refused", async () => {
    const e = await setup();
    const id = await addFinding(e);
    await e.admin.mutation(api.lockdown.ignore, { findingId: id });
    expect((await findingOf(e, id))?.status).toBe("ignored");
    expect(await audits(e)).toEqual(["lockdown.findingIgnored"]);
    expect((await probe(() => e.admin.mutation(api.lockdown.ignore, { findingId: id }))).io.writes).toBe(0);
    // An ignored finding can still be allowed later.
    await e.admin.mutation(api.lockdown.allow, { findingId: id, kind: "publisher", groupIds: [e.groupId] });
    expect(await detailOf(e.admin.mutation(api.lockdown.ignore, { findingId: id }))).toMatchObject({ code: "conflict", detail: "already_allowed" });
  });

  test("removing the last exception of a finding opens it again and takes a new configuration version", async () => {
    const e = await setup();
    const id = await addFinding(e, { fileName: "tool.exe" });
    await e.admin.mutation(api.lockdown.allow, { findingId: id, kind: "publisher", groupIds: [e.groupId] });
    const before = await configVersions(e);
    const row = (await exceptionsOf(e))[0]!;
    await expectCode(e.viewer.mutation(api.lockdown.removeException, { exceptionId: row._id }), "forbidden");
    await e.admin.mutation(api.lockdown.removeException, { exceptionId: row._id });
    expect(await exceptionsOf(e)).toEqual([]);
    expect((await findingOf(e, id))?.status).toBe("new");
    expect(await configVersions(e)).toBe(before + 1);
    expect(await audits(e)).toEqual(["lockdown.exceptionAdded", "lockdown.exceptionRemoved"]);
  });
});

describe("fleet:allowUsb and the device page (fleet:get)", () => {
  test("1 to 8 whole hours; 0 ends it; the PC's document carries the window; audited", async () => {
    const e = await setup();
    const get = () => e.admin.query(api.fleet.get, { deviceId: e.pc.deviceId });
    expect((await get()).usbAllowUntil).toBeNull();
    for (const hours of [9, -1, 1.5]) {
      expect(await detailOf(e.admin.mutation(api.fleet.allowUsb, { deviceId: e.pc.deviceId, hours }))).toMatchObject({ code: "invalid_argument", field: "hours" });
    }
    expect((await probe(() => e.admin.mutation(api.fleet.allowUsb, { deviceId: e.pc.deviceId, hours: 0 }))).io.writes).toBe(0);
    await expectCode(e.viewer.mutation(api.fleet.allowUsb, { deviceId: e.pc.deviceId, hours: 1 }), "forbidden");

    const now = Date.now();
    const { until } = await e.admin.mutation(api.fleet.allowUsb, { deviceId: e.pc.deviceId, hours: 8 });
    expect(until).toBe(now + 8 * 3_600_000);
    expect((await get()).usbAllowUntil).toBe(until);
    await drain(e.t);
    const head = await e.t.query(api.devices.headState, { deviceId: e.pc.deviceId, deviceSecret: e.pc.secret });
    if (head.kind !== "ok" || head.head === null) throw new Error("no head");
    const env = await e.t.query(api.devices.fetchDesired, { deviceId: e.pc.deviceId, deviceSecret: e.pc.secret, version: head.head.version });
    expect((JSON.parse(env.payload) as { doc: { usbTempAllow: unknown } }).doc.usbTempAllow).toEqual({ untilMs: until });

    expect(await e.admin.mutation(api.fleet.allowUsb, { deviceId: e.pc.deviceId, hours: 0 })).toEqual({ until: null });
    expect((await get()).usbAllowUntil).toBeNull();
    expect(await audits(e)).toEqual(["device.usbTempAllow", "device.usbTempAllow"]);
  });

  test("fleet:get carries the ring, the apply report in fixed codes, the posture and whether the agent knows lockdown", async () => {
    const e = await setup();
    const get = () => e.viewer.query(api.fleet.get, { deviceId: e.pc.deviceId });
    expect(await get()).toMatchObject({ ring: "everyone", apply: null, protection: null });
    await e.t.run(async (ctx) => {
      const ok = { mode: "audit", state: "ok" };
      await ctx.db.insert("deviceApplyReports", {
        orgId: e.orgId,
        deviceId: e.pc.deviceId,
        appliedVersion: 3,
        config: { groupId: e.groupId, version: 1, ring: "everyone" },
        state: "refused",
        refusal: "would_block_input_device",
        layers: { staff: ok, machine: ok, appLocker: ok, appControl: ok, procWatch: ok, boot: ok, performance: { mode: "on", state: "partial", detail: "no_printing_ignored" } },
        wifi: [],
        printers: [],
        lkgVersion: 2,
        capabilities: ["lockdown/1"],
        contentHash: "a".repeat(64),
        updatedAt: Date.now(),
      });
      const report = await ctx.db.query("deviceReports").withIndex("by_device", (q) => q.eq("deviceId", e.pc.deviceId)).unique();
      const security = { secureBoot: "on", bitLocker: "off", autoRecovery: "off", safeModeAgent: true };
      if (report === null) await ctx.db.insert("deviceReports", { orgId: e.orgId, deviceId: e.pc.deviceId, security, capabilities: ["lockdown/1"], updatedAt: Date.now() });
      else await ctx.db.patch(report._id, { security, capabilities: ["lockdown/1"] });
    });
    const d = await get();
    expect(d.apply).toMatchObject({ state: "refused", refusal: "would_block_input_device", appliedVersion: 3, lkgVersion: 2, configVersion: 1 });
    expect(d.apply?.layers.performance).toEqual({ mode: "on", state: "partial", detail: "no_printing_ignored" });
    expect(d.protection).toMatchObject({ secureBoot: "on", bitLocker: "off" });
    expect(d.lockdownCapable).toBe(true);
  });
});

describe("overview:get lockdown warnings", () => {
  test("nothing to warn about reads no lockdown row", async () => {
    const e = await setup();
    const o = await e.viewer.query(api.overview.get, {});
    expect(o.lockdown).toEqual({ auditOverdue: [], auditOverdueMore: false, halted: [], haltedMore: false, notApplied: [], notAppliedMore: false });
  });

  test("groups in audit for more than 14 days, halted rollouts and PCs that refused or rolled back", async () => {
    const e = await setup();
    await e.t.run(async (ctx) => {
      await ctx.db.insert("groupLockdown", { orgId: e.orgId, groupId: e.groupId, settings: D, revision: 1, auditSince: Date.now() - 16 * DAY_MS });
      // A newer group: still inside its 14 days.
      const young = await ctx.db.insert("groups", { orgId: e.orgId, name: "Young", revision: 0, createdAt: Date.now() });
      await ctx.db.insert("groupLockdown", { orgId: e.orgId, groupId: young, settings: D, revision: 1, auditSince: Date.now() - 3 * DAY_MS });
      const rollout = (await ctx.db.query("groupRollouts").withIndex("by_group", (q) => q.eq("groupId", e.groupId)).unique())!;
      await ctx.db.patch(rollout._id, { state: "halted", haltReason: "failure_rate" });
      const off = { mode: "off", state: "ok" };
      await ctx.db.insert("deviceApplyReports", {
        orgId: e.orgId,
        deviceId: e.pc.deviceId,
        appliedVersion: 1,
        state: "refused",
        refusal: "would_block_exit",
        layers: { staff: off, machine: off, appLocker: off, appControl: off, procWatch: off, boot: off, performance: off },
        wifi: [],
        printers: [],
        capabilities: [],
        contentHash: "b".repeat(64),
        updatedAt: Date.now(),
      });
    });
    const o = await e.viewer.query(api.overview.get, {});
    expect(o.lockdown.auditOverdue.map((g) => g.name)).toEqual(["Sales"]);
    expect(o.lockdown.halted).toEqual([{ groupId: e.groupId, name: "Sales" }]);
    expect(o.lockdown.notApplied).toEqual([{ deviceId: e.pc.deviceId, name: "Front desk PC", state: "refused", refusal: "would_block_exit" }]);
  });

  test("another organization's warnings are not shown", async () => {
    const e = await setup();
    await e.t.run((ctx) => ctx.db.insert("groupLockdown", { orgId: e.orgId, groupId: e.groupId, settings: D, revision: 1, auditSince: Date.now() - 30 * DAY_MS }));
    const other = await makeOrg(e.t, "Other");
    const stranger = await asMember(e.t, { role: "owner", orgId: other });
    expect((await stranger.as.query(api.overview.get, {})).lockdown.auditOverdue).toEqual([]);
  });
});

describe("groups:create and groups:remove keep the lockdown row", () => {
  test("a new group starts with the defaults and the audit clock; deleting the group deletes the row", async () => {
    const e = await setup();
    const { groupId } = await e.admin.mutation(api.groups.create, { name: "Warehouse" });
    const row = await e.t.run((ctx) => ctx.db.query("groupLockdown").withIndex("by_group", (q) => q.eq("groupId", groupId)).unique());
    expect(row).toMatchObject({ settings: D, revision: 0 });
    expect(row?.auditSince).toBeTypeOf("number");
    await e.admin.mutation(api.groups.remove, { groupId });
    expect(await e.t.run((ctx) => ctx.db.query("groupLockdown").withIndex("by_group", (q) => q.eq("groupId", groupId)).unique())).toBeNull();
  });
});
