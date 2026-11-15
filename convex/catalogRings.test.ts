import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice, probe } from "../tests/convex/devices";
import { asMember, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { MASTER_A, setMaster } from "../tests/convex/phase5";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auditPolicy } from "./lib/audit";
import { buildConfigCatalog, parseGroupConfig, snapshotGroupConfig } from "./lib/groupConfig";
import { requestPublish } from "./lib/publish";

// Phase 5 Step 16b (owner decision 2026-11-15, plan 4.3 rule 6 and 4.14): the Phase 4 catalogue inputs are ring-gated. App
// assignments, the records of the assigned apps and the file-type rules are part of the group configuration version, so a change
// goes to the pilot ring first, is promoted like every other change, and a rollback brings the old app set back. Rings off = every
// PC at once, with the same document as before. Direct employee grants stay live.

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

type Dev = { deviceId: Id<"devices">; secret: string };

/** One group of three PCs (one per ring once rings are on) and an admin. The group has NO configuration version yet (a Phase 4 group). */
async function setup(o: { rings?: boolean } = {}) {
  const t = await setupAuth();
  const orgId = await makeOrg(t, "Acme");
  const groupId = await t.run((ctx) => ctx.db.insert("groups", { orgId, name: "Sales", revision: 0, createdAt: Date.now() }));
  const pilot = await enrollDevice(t, orgId, { groupId, name: "Pilot PC" });
  const early = await enrollDevice(t, orgId, { groupId, name: "Early PC" });
  const everyone = await enrollDevice(t, orgId, { groupId, name: "Everyone PC" });
  const adm = await asMember(t, { role: "admin", orgId });
  await giveStepUp(t, adm);
  const e = { t, orgId, groupId, pilot, early, everyone, admin: adm.as, all: [pilot, early, everyone] };
  await drain(t);
  if (o.rings === true) {
    await t.run((ctx) => snapshotGroupConfig(ctx, groupId, "first"));
    await e.admin.mutation(api.rollouts.setRings, { groupId, deviceIds: [pilot.deviceId], ring: "pilot", expectedRevision: await rev(e) });
    await e.admin.mutation(api.rollouts.setRings, { groupId, deviceIds: [early.deviceId], ring: "early", expectedRevision: await rev(e) });
    await e.admin.mutation(api.rollouts.setEnabled, { groupId, enabled: true, expectedRevision: await rev(e) });
    await drain(t);
  }
  return e;
}
type Env = Awaited<ReturnType<typeof setup>>;

const rolloutRow = (e: Pick<Env, "t" | "groupId">) => e.t.run((ctx) => ctx.db.query("groupRollouts").withIndex("by_group", (q) => q.eq("groupId", e.groupId)).unique());
const rev = async (e: Pick<Env, "t" | "groupId">) => (await rolloutRow(e))?.revision ?? 0;
const pointers = async (e: Env) => (await rolloutRow(e))?.pointers;

type CatalogEntry = { id: string; name: string; revision: number; employeeIds: string[]; audience: string; pinnedTaskbar: boolean };
type Parsed = {
  version: number;
  doc: { apps: string[]; catalog: CatalogEntry[]; fileHandlers: Record<string, string>; config?: { version: number; ring: string }; lockdown?: unknown };
};
async function docOf(e: Env, d: Dev): Promise<Parsed> {
  const head = await e.t.query(api.devices.headState, { deviceId: d.deviceId, deviceSecret: d.secret });
  if (head.kind !== "ok" || head.head === null) throw new Error("no head");
  const env = await e.t.query(api.devices.fetchDesired, { deviceId: d.deviceId, deviceSecret: d.secret, version: head.head.version });
  return { version: head.head.version, doc: (JSON.parse(env.payload) as { doc: Parsed["doc"] }).doc };
}
/** The names of the PC's apps without the built-in Files app, sorted. */
const names = async (e: Env, d: Dev) => (await docOf(e, d)).doc.catalog.filter((c) => c.id !== "files").map((c) => c.name).sort();
const versionCount = (e: Env, d: Dev) =>
  e.t.run(async (ctx) => (await ctx.db.query("desiredVersions").withIndex("by_device_version", (q) => q.eq("deviceId", d.deviceId)).collect()).length);

const web = (name: string) => ({ name, url: `https://${name.toLowerCase().replace(/[^a-z0-9]/g, "")}.example.com/start`, allowedDomains: [] as string[] });
const program = (name: string) => ({
  name,
  desktop: {
    source: "msi" as const,
    exe: `{ProgramFiles}\\${name}\\${name.toLowerCase()}.exe`,
    args: [],
    fileArgTemplate: ["{file}"],
    resetFolders: [],
    install: { kind: "msi" as const, url: `https://downloads.example.com/${name.toLowerCase()}.msi`, sha256: "ab".repeat(32), sizeBytes: 1000, silentArgs: [], successExitCodes: [0], removeWhenUnassigned: true },
  },
});
async function assign(e: Env, appId: Id<"apps">, pinnedTaskbar = false): Promise<Id<"appAssignments">> {
  const r = await e.admin.mutation(api.groups.assignApp, { groupId: e.groupId, appId, audience: "everyone", pinnedTaskbar, pinnedDesktop: false });
  await drain(e.t);
  return r.assignmentId;
}
const promote = async (e: Env, to: "early" | "everyone") => {
  await e.admin.mutation(api.rollouts.promote, { groupId: e.groupId, to, expectedRevision: await rev(e) });
  await drain(e.t);
};
const promoteAll = async (e: Env) => {
  await e.admin.mutation(api.rollouts.promoteAll, { groupId: e.groupId, expectedRevision: await rev(e) });
  await drain(e.t);
};

describe("rings off: the catalogue is immediate and the document is the one the live publisher built", () => {
  test("an assignment reaches every PC at once; the group gets its first configuration version from it", async () => {
    const e = await setup();
    expect(await rolloutRow(e)).toBeNull(); // a Phase 4 group: read live
    for (const d of e.all) expect((await docOf(e, d)).doc.config).toBeUndefined();

    const docs = await e.admin.mutation(api.apps.createWeb, web("Docs"));
    await assign(e, docs, true);
    expect(await pointers(e)).toEqual({ pilot: 1, early: 1, everyone: 1 });
    for (const d of e.all) {
      const p = await docOf(e, d);
      expect(p.doc.apps).toEqual(["files", docs]);
      expect(p.doc.catalog.find((c) => c.id === docs)).toMatchObject({ name: "Docs", audience: "everyone", pinnedTaskbar: true });
      expect(p.doc.config).toMatchObject({ version: 1, ring: "everyone" });
    }
    // An edit of the app record and an unassignment are immediate too.
    await e.admin.mutation(api.apps.update, { appId: docs, expectedRevision: 0, web: web("Docs 2") });
    await drain(e.t);
    for (const d of e.all) expect(await names(e, d)).toEqual(["Docs 2"]);
    expect(await pointers(e)).toEqual({ pilot: 2, early: 2, everyone: 2 });
  });

  test("the frozen catalogue gives byte-for-byte the document the live inputs give (no new document when the version loses its `catalog`)", async () => {
    const e = await setup();
    const reader = await e.admin.mutation(api.apps.createDesktop, program("Reader"));
    const wiki = await e.admin.mutation(api.apps.createWeb, { ...web("Wiki"), description: "Team wiki", hue: 120 });
    const other = await e.admin.mutation(api.apps.createDesktop, program("Other")); // not assigned: its rule must not reach the group
    await assign(e, reader, true);
    await assign(e, wiki);
    await e.admin.mutation(api.fileHandlers.set, { extension: "pdf", appId: reader });
    await e.admin.mutation(api.fileHandlers.set, { extension: "txt", appId: other });
    await drain(e.t);
    const before = await Promise.all(e.all.map((d) => docOf(e, d)));
    expect(before[0]!.doc.fileHandlers).toEqual({ ".pdf": reader });
    expect(before[0]!.doc.apps).toEqual(["files", ...[reader, wiki].sort()]);

    // The stored version says what was frozen: two assignments, two records, the one rule that names an assigned program.
    const rows = await e.t.run((ctx) => ctx.db.query("groupConfigs").withIndex("by_group_version", (q) => q.eq("groupId", e.groupId)).collect());
    const newest = parseGroupConfig(rows.at(-1)!.config)!;
    expect(newest.catalog?.assignments.map((a) => a.appId)).toEqual([reader, wiki].sort());
    expect(newest.catalog?.apps.map((a) => a.name).sort()).toEqual(["Reader", "Wiki"]);
    expect(newest.catalog?.fileHandlers).toEqual([{ extension: ".pdf", appId: reader }]);

    // Take `catalog` out of every stored version (what a version made before Step 16b looks like): the publisher reads the live
    // tables instead. Same content hash for every PC = not one new document.
    await e.t.run(async (ctx) => {
      for (const row of rows) {
        const rest = JSON.parse(row.config) as Record<string, unknown>;
        delete rest.catalog;
        await ctx.db.patch(row._id, { config: JSON.stringify(rest) });
      }
      await requestPublish(ctx, e.orgId, { groupIds: [e.groupId] });
    });
    await drain(e.t);
    for (const [i, d] of e.all.entries()) expect((await docOf(e, d)).version).toBe(before[i]!.version);
  });

  test("an unchanged save writes no configuration version; archived apps and other groups' rules are left out of the frozen catalogue", async () => {
    const e = await setup();
    const docs = await e.admin.mutation(api.apps.createWeb, web("Docs"));
    const assignmentId = await assign(e, docs);
    const same = await probe(() => e.admin.mutation(api.groups.updateAssignment, { assignmentId, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false }));
    expect(same.io.writes).toBe(0);
    await e.admin.mutation(api.apps.setArchived, { appId: docs, archived: true });
    await drain(e.t);
    for (const d of e.all) expect(await names(e, d)).toEqual([]);
    const app = (await e.t.run((ctx) => ctx.db.get(docs)))!;
    expect(buildConfigCatalog({ assignments: [{ appId: docs, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false }], apps: [app], fileHandlers: [] }).apps).toEqual([]);
  });
});

describe("rings on: assignments, app records and file types go to the pilot ring first", () => {
  test("an assignment reaches the pilot ring only; promotion moves it; a rollback brings the old app set back under a higher document version", async () => {
    const e = await setup({ rings: true });
    const docs = await e.admin.mutation(api.apps.createWeb, web("Docs"));
    const wiki = await e.admin.mutation(api.apps.createWeb, web("Wiki"));
    const before = { early: await versionCount(e, e.early), everyone: await versionCount(e, e.everyone) };

    const docsAssignment = await assign(e, docs);
    expect(await pointers(e)).toEqual({ pilot: 2, early: 1, everyone: 1 });
    expect(await names(e, e.pilot)).toEqual(["Docs"]);
    expect(await names(e, e.early)).toEqual([]);
    expect(await names(e, e.everyone)).toEqual([]);
    expect(await versionCount(e, e.early)).toBe(before.early); // not even re-signed
    expect(await versionCount(e, e.everyone)).toBe(before.everyone);

    await promote(e, "early");
    expect(await names(e, e.early)).toEqual(["Docs"]);
    expect(await names(e, e.everyone)).toEqual([]);
    await promote(e, "everyone");
    expect(await names(e, e.everyone)).toEqual(["Docs"]);
    expect((await rolloutRow(e))!).toMatchObject({ pointers: { pilot: 2, early: 2, everyone: 2 }, state: "idle" });

    // Version 3 adds Wiki, version 4 takes Docs away: both on the pilot ring only.
    await assign(e, wiki);
    await e.admin.mutation(api.groups.unassignApp, { assignmentId: docsAssignment });
    await drain(e.t);
    expect(await pointers(e)).toEqual({ pilot: 4, early: 2, everyone: 2 });
    expect(await names(e, e.pilot)).toEqual(["Wiki"]);
    expect(await names(e, e.early)).toEqual(["Docs"]);

    // Rollback of the pilot ring to version 2: Docs is back, Wiki is gone, although the live tables say the opposite.
    const pilotVersion = (await docOf(e, e.pilot)).version;
    await e.admin.mutation(api.rollouts.rollback, { groupId: e.groupId, toVersion: 2, rings: ["pilot"], expectedRevision: await rev(e) });
    await drain(e.t);
    const back = await docOf(e, e.pilot);
    expect(back.version).toBe(pilotVersion + 1);
    expect(back.doc.apps).toEqual(["files", docs]);
    expect(back.doc.config).toMatchObject({ version: 2, ring: "pilot" });
    const live = await e.t.run((ctx) => ctx.db.query("appAssignments").withIndex("by_group", (q) => q.eq("groupId", e.groupId)).collect());
    expect(live.map((a) => a.appId)).toEqual([wiki]);
  });

  test("a PC that was offline for several catalogue changes and promotions gets its ring's current app set in one document", async () => {
    const e = await setup({ rings: true });
    const ids: Id<"apps">[] = [];
    for (const name of ["One", "Two", "Three"]) {
      const id = await e.admin.mutation(api.apps.createWeb, web(name));
      ids.push(id);
      await assign(e, id);
    }
    await e.admin.mutation(api.apps.update, { appId: ids[0]!, expectedRevision: 0, web: web("One b") });
    await drain(e.t);
    expect(await pointers(e)).toEqual({ pilot: 5, early: 1, everyone: 1 });
    const before = await versionCount(e, e.everyone);
    expect(await names(e, e.everyone)).toEqual([]);
    await promoteAll(e);
    const doc = await docOf(e, e.everyone);
    expect(doc.doc.config).toMatchObject({ version: 5, ring: "everyone" });
    expect(await names(e, e.everyone)).toEqual(["One b", "Three", "Two"]);
    expect(await versionCount(e, e.everyone)).toBe(before + 1); // one document, never an in-between app set
  });

  test("app record edits, archiving, retry and file types are ring-gated; turning rings off delivers them at once", async () => {
    const e = await setup({ rings: true });
    const reader = await e.admin.mutation(api.apps.createDesktop, program("Reader"));
    await assign(e, reader);
    await promoteAll(e);
    for (const d of e.all) expect(await names(e, d)).toEqual(["Reader"]);

    await e.admin.mutation(api.fileHandlers.set, { extension: "pdf", appId: reader });
    await drain(e.t);
    expect((await docOf(e, e.pilot)).doc.fileHandlers).toEqual({ ".pdf": reader });
    expect((await docOf(e, e.early)).doc.fileHandlers).toEqual({});
    expect((await docOf(e, e.everyone)).doc.fileHandlers).toEqual({});

    const { revision } = await e.admin.mutation(api.apps.retry, { appId: reader });
    await drain(e.t);
    expect((await docOf(e, e.pilot)).doc.catalog.find((c) => c.id === reader)?.revision).toBe(revision);
    expect((await docOf(e, e.everyone)).doc.catalog.find((c) => c.id === reader)?.revision).toBe(0);

    await e.admin.mutation(api.apps.update, { appId: reader, expectedRevision: revision, desktop: program("Reader Pro") });
    await drain(e.t);
    expect(await names(e, e.pilot)).toEqual(["Reader Pro"]);
    expect(await names(e, e.everyone)).toEqual(["Reader"]);

    await promoteAll(e);
    expect((await docOf(e, e.everyone)).doc.fileHandlers).toEqual({ ".pdf": reader });
    expect(await names(e, e.everyone)).toEqual(["Reader Pro"]);

    // Removing the rule and archiving the program: pilot first again.
    const rule = await e.t.run((ctx) => ctx.db.query("fileHandlers").withIndex("by_app", (q) => q.eq("appId", reader)).first());
    await e.admin.mutation(api.fileHandlers.remove, { handlerId: rule!._id });
    await e.admin.mutation(api.apps.setArchived, { appId: reader, archived: true });
    await drain(e.t);
    expect((await docOf(e, e.pilot)).doc).toMatchObject({ apps: ["files"], fileHandlers: {} });
    expect((await docOf(e, e.early)).doc).toMatchObject({ apps: ["files", reader], fileHandlers: { ".pdf": reader } });

    // Rings off: every pointer moves to the newest version.
    await e.admin.mutation(api.rollouts.setEnabled, { groupId: e.groupId, enabled: false, expectedRevision: await rev(e) });
    await drain(e.t);
    for (const d of e.all) expect((await docOf(e, d)).doc).toMatchObject({ apps: ["files"], fileHandlers: {} });
  });

  test("direct employee grants are never ring-gated: a granted website reaches every ring at once, with its live record", async () => {
    const e = await setup({ rings: true });
    const docs = await e.admin.mutation(api.apps.createWeb, web("Docs"));
    await assign(e, docs); // pilot only
    const chat = await e.admin.mutation(api.apps.createWeb, web("Chat"));
    const employeeId = await e.t.run(async (ctx) => {
      const id = await ctx.db.insert("employees", { orgId: e.orgId, name: "Pat", username: "pat", searchText: "pat", disabled: false, credentialRevision: 0, revision: 0, createdAt: 0 });
      await ctx.db.insert("groupMembers", { orgId: e.orgId, groupId: e.groupId, employeeId: id, grantsActive: true });
      await ctx.db.insert("employeeApps", { orgId: e.orgId, employeeId: id, appId: chat });
      await ctx.db.insert("employeeApps", { orgId: e.orgId, employeeId: id, appId: docs });
      await requestPublish(ctx, e.orgId, { groupIds: [e.groupId] });
      return id;
    });
    await drain(e.t);
    // Chat is granted only: on every ring at once. Docs is assigned on the pilot ring (audience "everyone", from the version) and
    // only granted on the other rings, where it shows as a direct website (audience "selected"), exactly as before Step 16b.
    for (const d of e.all) expect(await names(e, d)).toEqual(["Chat", "Docs"]);
    expect((await docOf(e, e.pilot)).doc.catalog.find((c) => c.id === docs)).toMatchObject({ audience: "everyone", employeeIds: [employeeId] });
    expect((await docOf(e, e.everyone)).doc.catalog.find((c) => c.id === docs)).toMatchObject({ audience: "selected", employeeIds: [employeeId] });

    // The record of a website a ring carries only through a grant is live: a rename reaches every ring at once.
    await e.admin.mutation(api.apps.update, { appId: chat, expectedRevision: 0, web: web("Chat 2") });
    await drain(e.t);
    for (const d of e.all) expect(await names(e, d)).toContain("Chat 2");
  });
});

describe("many groups (Step 20b: scheduler batches replace the 10-group cap)", () => {
  test("a file type whose program is assigned to 11 groups is saved: 10 groups get a version in the call, the 11th by a scheduled batch", async () => {
    const e = await setup();
    const reader = await e.admin.mutation(api.apps.createDesktop, program("Reader"));
    await e.t.run(async (ctx) => {
      for (let i = 0; i < 11; i++) {
        const g = await ctx.db.insert("groups", { orgId: e.orgId, name: `G${i}`, revision: 0, createdAt: i });
        await ctx.db.insert("appAssignments", { orgId: e.orgId, groupId: g, appId: reader, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
      }
    });
    const versions = () => e.t.run(async (ctx) => (await ctx.db.query("groupConfigs").collect()).length);
    await e.admin.mutation(api.fileHandlers.set, { extension: "pdf", appId: reader });
    expect((await e.t.run((ctx) => ctx.db.query("fileHandlers").collect())).length).toBe(1);
    expect(await versions()).toBe(10); // synchronous part
    await drain(e.t);
    expect(await versions()).toBe(11); // the batch of the 11th group
    await e.admin.mutation(api.apps.retry, { appId: reader });
    await drain(e.t);
    expect(await versions()).toBe(22); // a retry bumps the app revision, so each of the 11 groups gets a new version (10 in the call, 1 later)
  });
});
