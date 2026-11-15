import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice, probe } from "../tests/convex/devices";
import { asMember, expectCode, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auditPolicy } from "./lib/audit";
import { sha256HexOfBytes } from "./lib/crypto";
import { MINUTE_MS, WINGET_CACHE_MS } from "./lib/limits";
import { installerManifestUrl, localeManifestUrl } from "./lib/winget";
import sevenZip from "./testdata/winget/7zip.7zip.installer.yaml?raw";
import sevenZipLocale from "./testdata/winget/7zip.7zip.locale.en-US.yaml?raw";
import manifestPage from "./testdata/webmeta/manifest-page.html?raw";

// Apps (plan Step 10): the Convex side of the Apps, AppEdit, File types and
// group-assignment screens. `fetch` is stubbed wherever an action reaches for
// the network: no test makes a real request.

beforeEach(() => {
  auditPolicy.strict = true;
});
afterEach(() => {
  auditPolicy.strict = false;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function admin(t: T, orgId: Id<"organizations">, stepUp: "fresh" | "stale" = "fresh") {
  const m = await asMember(t, { role: "admin", orgId });
  if (stepUp === "fresh") await giveStepUp(t, m);
  else await giveStepUp(t, m, { verifiedAgoMs: 6 * MINUTE_MS, activeAgoMs: 0 });
  return m;
}

const web = (name: string, over: Record<string, unknown> = {}) => ({ name, url: "https://docs.example.com/start", allowedDomains: [] as string[], ...over });

const sha = "ab".repeat(32);
const msiInstall = { kind: "msi" as const, url: "https://downloads.example.com/a.msi", sha256: sha, sizeBytes: 1000, silentArgs: [], successExitCodes: [0], removeWhenUnassigned: true };
const desktop = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  desktop: {
    source: "msi" as const,
    exe: "{ProgramFiles}\\Acme\\acme.exe",
    args: [],
    fileArgTemplate: ["{file}"],
    resetFolders: [],
    install: msiInstall,
    ...over,
  },
});

async function stats(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());
}
async function appRow(t: T, appId: Id<"apps">) {
  return await t.run((ctx) => ctx.db.get(appId));
}
async function queueOf(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("publishQueue").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());
}
async function actions(t: T, orgId: Id<"organizations">) {
  return (await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(100))).map((r) => r.action);
}
async function group(t: T, orgId: Id<"organizations">, name = "Sales") {
  return await t.run((ctx) => ctx.db.insert("groups", { orgId, name, revision: 0, createdAt: Date.now() }));
}

describe("apps: create, read, update", () => {
  test("a website: the host is always allowed and listed first; defaults for permissions; counters and audit", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const id = await a.as.mutation(api.apps.createWeb, web("  Docs ", { description: " Team docs ", hue: 175, allowedDomains: ["*.cdn.example.com", "docs.example.com"] }));
    const app = (await appRow(t, id))!;
    expect(app).toMatchObject({ name: "Docs", description: "Team docs", kind: "web", hue: 175, archived: false, revision: 0 });
    expect(app.web).toEqual({
      url: "https://docs.example.com/start",
      allowedDomains: ["docs.example.com", "*.cdn.example.com"],
      // PRD 24.1 defaults; printing is allowed from Phase 5 on (the Staff App also needs a printer).
      permissions: { camera: false, microphone: false, screenShare: false, clipboardRead: false, notifications: true, downloads: true, printing: true, geolocation: false },
    });
    expect((await stats(t, orgId))?.appCount).toBe(1);
    expect(await actions(t, orgId)).toEqual(["app.created"]);
    expect(await queueOf(t, orgId)).toBeNull(); // an unassigned app is in no document: nothing to publish
  });

  test("web validation names the field: scheme, private hosts, domains, name, hue", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const field = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        expect((e as { data: { code: string } }).data.code).toBe("invalid_argument");
        return (e as { data: { field?: string } }).data.field;
      }
      return "no error";
    };
    expect(await field(a.as.mutation(api.apps.createWeb, web("A", { url: "http://docs.example.com" })))).toBe("url");
    expect(await field(a.as.mutation(api.apps.createWeb, web("A", { url: "https://10.0.0.1" })))).toBe("url");
    expect(await field(a.as.mutation(api.apps.createWeb, web("A", { url: "https://localhost" })))).toBe("url");
    expect(await field(a.as.mutation(api.apps.createWeb, web("A", { url: "javascript:alert(1)" })))).toBe("url");
    expect(await field(a.as.mutation(api.apps.createWeb, web("A", { allowedDomains: ["Bad.Example.com"] })))).toBe("allowedDomains");
    expect(await field(a.as.mutation(api.apps.createWeb, web("A", { allowedDomains: Array.from({ length: 21 }, (_, i) => `h${i}.example.com`) })))).toBe("allowedDomains");
    expect(await field(a.as.mutation(api.apps.createWeb, web("")))).toBe("name");
    expect(await field(a.as.mutation(api.apps.createWeb, web("x".repeat(61))))).toBe("name");
    expect(await field(a.as.mutation(api.apps.createWeb, web("A", { hue: 360 })))).toBe("hue");
    expect(await field(a.as.mutation(api.apps.createWeb, web("A", { description: "d".repeat(301) })))).toBe("description");
    expect((await stats(t, orgId))?.appCount ?? 0).toBe(0);
  });

  test("a program: path rules, SHA-256 and https are enforced; a portable app's {AppId} becomes its id", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const field = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        return (e as { data: { field?: string } }).data.field;
      }
      return "no error";
    };
    for (const exe of ["C:\\x.exe", "{ProgramFiles}\\..\\x.exe", "{ProgramFiles}\\a\\b.bat", "{ProgramFiles}\\1\\2\\3\\4\\5\\6\\7\\8\\x.exe", "{RuleboxApps}\\other\\x.exe"]) {
      expect(await field(a.as.mutation(api.apps.createDesktop, desktop("P", { exe }))), exe).toBe("exe");
    }
    expect(await field(a.as.mutation(api.apps.createDesktop, desktop("P", { install: { ...msiInstall, sha256: "xyz" } })))).toBe("install.sha256");
    expect(await field(a.as.mutation(api.apps.createDesktop, desktop("P", { install: { ...msiInstall, url: "http://downloads.example.com/a.msi" } })))).toBe("install.url");
    expect(await field(a.as.mutation(api.apps.createDesktop, desktop("P", { fileArgTemplate: ["--open"] })))).toBe("fileArgTemplate");
    expect(await field(a.as.mutation(api.apps.createDesktop, desktop("P", { resetFolders: ["C:\\Users"] })))).toBe("resetFolders");
    expect((await stats(t, orgId))?.appCount ?? 0).toBe(0);

    const ok = await a.as.mutation(api.apps.createDesktop, desktop("Acme", { install: { ...msiInstall, sha256: sha.toUpperCase() } }));
    expect((await appRow(t, ok))?.desktop?.install?.sha256).toBe(sha); // stored lower-case

    const portable = await a.as.mutation(
      api.apps.createDesktop,
      desktop("Tool", { source: "portable", exe: "{RuleboxApps}\\{AppId}\\tool.exe", install: { ...msiInstall, kind: "portable", url: "https://downloads.example.com/tool.exe" } }),
    );
    expect((await appRow(t, portable))?.desktop?.exe).toBe(`{RuleboxApps}\\${portable}\\tool.exe`);
    expect((await stats(t, orgId))?.appCount).toBe(2);
  });

  test("get: assignments with group names, file types, direct employee count; list: paging, archived filter, group count, icon-free rows", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g1 = await group(t, orgId, "Sales");
    const g2 = await group(t, orgId, "Ops");
    const reader = await a.as.mutation(api.apps.createDesktop, desktop("Reader"));
    const site = await a.as.mutation(api.apps.createWeb, web("Wiki"));
    await a.as.mutation(api.fileHandlers.set, { extension: ".pdf", appId: reader });
    await a.as.mutation(api.groups.assignApp, { groupId: g1, appId: reader, audience: "everyone", pinnedTaskbar: true, pinnedDesktop: false });
    await a.as.mutation(api.groups.assignApp, { groupId: g2, appId: reader, audience: "selected", pinnedTaskbar: false, pinnedDesktop: true });
    await t.run(async (ctx) => {
      const e = await ctx.db.insert("employees", { orgId, name: "E", username: "e", searchText: "e", disabled: false, credentialRevision: 0, revision: 0, createdAt: 0 });
      await ctx.db.insert("employeeApps", { orgId, employeeId: e, appId: reader });
    });

    const d = await a.as.query(api.apps.get, { appId: reader });
    expect(d).toMatchObject({ name: "Reader", kind: "desktop", archived: false, revision: 0, fileTypes: [".pdf"], directEmployeeCount: 1 });
    expect(d.assignments.map((x) => [x.groupName, x.audience, x.pinnedTaskbar, x.pinnedDesktop])).toEqual([
      ["Ops", "selected", false, true],
      ["Sales", "everyone", true, false],
    ]);
    expect(d.groupOptions.map((g) => g.name)).toEqual(["Ops", "Sales"]);
    expect(d.desktop?.install?.sha256).toBe(sha);

    const page = await a.as.query(api.apps.list, { paginationOpts: { numItems: 10, cursor: null }, archived: false });
    expect(page.page.map((r) => [r.name, r.groupCount, r.summary])).toEqual([
      ["Wiki", 0, null],
      ["Reader", 2, null],
    ]);
    expect(page.page[1]!.source).toBe("msi");
    await a.as.mutation(api.apps.setArchived, { appId: site, archived: true });
    expect((await a.as.query(api.apps.list, { paginationOpts: { numItems: 10, cursor: null }, archived: true })).page.map((r) => r.name)).toEqual(["Wiki"]);
    expect((await a.as.query(api.apps.list, { paginationOpts: { numItems: 10, cursor: null }, archived: false })).page.map((r) => r.name)).toEqual(["Reader"]);
    // pages are bounded
    await expectCode(a.as.query(api.apps.list, { paginationOpts: { numItems: 51, cursor: null }, archived: false }), "invalid_argument");
    await expectCode(a.as.query(api.apps.list, { paginationOpts: { numItems: 0, cursor: null }, archived: false }), "invalid_argument");
  });

  test("list reads at most 11 assignments per app and says 10+ through groupCountMore", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const busy = await a.as.mutation(api.apps.createWeb, web("Busy"));
    const edge = await a.as.mutation(api.apps.createWeb, web("Edge"));
    await t.run(async (ctx) => {
      // 25 groups carry "Busy" (more than the cap), 10 carry "Edge" (exactly the cap)
      for (let i = 0; i < 25; i++) {
        const g = await ctx.db.insert("groups", { orgId, name: `G${i}`, revision: 0, createdAt: i });
        await ctx.db.insert("appAssignments", { orgId, groupId: g, appId: busy, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
        if (i < 10) await ctx.db.insert("appAssignments", { orgId, groupId: g, appId: edge, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
      }
    });
    const page = await a.as.query(api.apps.list, { paginationOpts: { numItems: 10, cursor: null }, archived: false });
    expect(page.page.map((r) => [r.name, r.groupCount, r.groupCountMore])).toEqual([
      ["Edge", 10, false],
      ["Busy", 10, true],
    ]);
    // the detail screen still lists every assignment (bounded by the assignment cap, not by the list cap)
    expect((await a.as.query(api.apps.get, { appId: busy })).assignments).toHaveLength(25);
  });

  test("get names every assignment even when the organization has more groups than the picker holds", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const id = await a.as.mutation(api.apps.createWeb, web("Wiki"));
    const foreignOrg = await makeOrg(t, "Other");
    const lateGroup = await t.run(async (ctx) => {
      for (let i = 0; i < 510; i++) await ctx.db.insert("groups", { orgId, name: `Filler ${String(i).padStart(3, "0")}`, revision: 0, createdAt: i });
      const late = await ctx.db.insert("groups", { orgId, name: "Late group", revision: 0, createdAt: 9_999 }); // beyond the first 500
      const foreign = await ctx.db.insert("groups", { orgId: foreignOrg, name: "Not ours", revision: 0, createdAt: 0 });
      await ctx.db.insert("appAssignments", { orgId, groupId: late, appId: id, audience: "everyone", pinnedTaskbar: true, pinnedDesktop: false });
      await ctx.db.insert("appAssignments", { orgId, groupId: foreign, appId: id, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
      return late;
    });
    const d = await a.as.query(api.apps.get, { appId: id });
    expect(d.assignments.map((x) => [x.groupId, x.groupName])).toEqual([[lateGroup, "Late group"]]); // the other organization's group never shows
    expect(d.groupOptions).toHaveLength(500); // the picker stays bounded
  });

  test("options: a shell or script host is never offered as a file opener, even when an older app has one", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const old = await t.run((ctx) =>
      ctx.db.insert("apps", {
        orgId,
        name: "Old script host",
        kind: "desktop",
        desktop: { source: "preinstalled", exe: "{SystemRoot}\\System32\\wscript.exe", args: [], fileArgTemplate: ["{file}"], resetFolders: [] },
        archived: false,
        revision: 0,
        createdAt: 0,
      }),
    );
    expect(await a.as.query(api.apps.options, {})).toEqual([{ _id: old, name: "Old script host", kind: "desktop", canOpenFiles: false }]);
    await expectCode(a.as.mutation(api.apps.createDesktop, desktop("Shell", { exe: "{SystemRoot}\\System32\\cmd.exe" })), "invalid_argument");
  });

  test("options: non-archived apps by name with whether they can open files; other organizations excluded", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const reader = await a.as.mutation(api.apps.createDesktop, desktop("Reader"));
    const calc = await a.as.mutation(api.apps.createDesktop, desktop("Calc", { fileArgTemplate: [] }));
    const site = await a.as.mutation(api.apps.createWeb, web("Wiki"));
    const old = await a.as.mutation(api.apps.createWeb, web("Old"));
    await a.as.mutation(api.apps.setArchived, { appId: old, archived: true });
    const other = await admin(t, await makeOrg(t, "Other"));
    await other.as.mutation(api.apps.createWeb, web("Theirs"));
    expect(await a.as.query(api.apps.options, {})).toEqual([
      { _id: calc, name: "Calc", kind: "desktop", canOpenFiles: false },
      { _id: reader, name: "Reader", kind: "desktop", canOpenFiles: true },
      { _id: site, name: "Wiki", kind: "web", canOpenFiles: false },
    ]);
  });

  test("update: stale_edit; the same values write nothing; a change bumps the revision, audits and republishes the groups", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g = await group(t, orgId);
    const id = await a.as.mutation(api.apps.createWeb, web("Docs"));
    await a.as.mutation(api.groups.assignApp, { groupId: g, appId: id, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: true });
    await t.run(async (ctx) => {
      const q = (await ctx.db.query("publishQueue").withIndex("by_org", (x) => x.eq("orgId", orgId)).unique())!;
      await ctx.db.delete(q._id); // start from an empty queue
    });

    const same = { appId: id, expectedRevision: 0, web: web("Docs") };
    const { io, result } = await probe(() => a.as.mutation(api.apps.update, same));
    expect(result).toEqual({ revision: 0 });
    expect(io.writes).toBe(0);
    expect(await queueOf(t, orgId)).toBeNull();

    expect(await a.as.mutation(api.apps.update, { ...same, web: web("Docs 2", { allowedDomains: ["api.example.com"] }) })).toEqual({ revision: 1 });
    expect((await appRow(t, id))?.web?.allowedDomains).toEqual(["docs.example.com", "api.example.com"]);
    expect((await queueOf(t, orgId))?.groupIds).toEqual([g]);
    await expectCode(a.as.mutation(api.apps.update, { ...same, web: web("Docs 3") }), "stale_edit");
    expect((await actions(t, orgId)).filter((x) => x === "app.updated")).toHaveLength(1);

    // the kind never changes
    await expectCode(a.as.mutation(api.apps.update, { appId: id, expectedRevision: 1, desktop: desktop("X") }), "invalid_argument");
    await expectCode(a.as.mutation(api.apps.update, { appId: id, expectedRevision: 1 }), "invalid_argument");
    await expectCode(a.as.mutation(api.apps.update, { appId: id, expectedRevision: 1, web: web("Docs", { url: "https://10.0.0.1" }) }), "invalid_argument");
  });

  test("a program that can no longer open files keeps no file-type rule", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const id = await a.as.mutation(api.apps.createDesktop, desktop("Reader"));
    await a.as.mutation(api.fileHandlers.set, { extension: ".pdf", appId: id });
    await expectCode(a.as.mutation(api.apps.update, { appId: id, expectedRevision: 0, desktop: desktop("Reader", { fileArgTemplate: [] }) }), "has_dependents");
    await a.as.mutation(api.apps.update, { appId: id, expectedRevision: 0, desktop: desktop("Reader", { fileArgTemplate: ["--open", "{file}"] }) });
  });

  test("a program's {AppId} in an update is the app's own id; another app's folder is refused", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const portable = (exe: string) =>
      desktop("Tool", { source: "portable", exe, install: { ...msiInstall, kind: "portable", url: "https://downloads.example.com/tool.exe" } });
    const id = await a.as.mutation(api.apps.createDesktop, portable("{RuleboxApps}\\{AppId}\\tool.exe"));
    await a.as.mutation(api.apps.update, { appId: id, expectedRevision: 0, desktop: portable(`{RuleboxApps}\\${id}\\tool2.exe`) });
    expect((await appRow(t, id))?.desktop?.exe).toBe(`{RuleboxApps}\\${id}\\tool2.exe`);
    await expectCode(a.as.mutation(api.apps.update, { appId: id, expectedRevision: 1, desktop: portable("{RuleboxApps}\\k17other\\tool.exe") }), "invalid_argument");
  });
});

describe("apps: authorization and organizations", () => {
  test("a viewer cannot create, change or delete; an admin with a stale step-up cannot delete", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const v = await asMember(t, { role: "viewer", orgId });
    await giveStepUp(t, v);
    await expectCode(v.as.mutation(api.apps.createWeb, web("X")), "forbidden");
    await expectCode(v.as.mutation(api.apps.createDesktop, desktop("X")), "forbidden");
    await expectCode(v.as.action(api.apps.resolveWinget, { packageId: "7zip.7zip" }), "forbidden");
    await expectCode(v.as.action(api.apps.fetchWebMeta, { url: "https://example.com" }), "forbidden");
    expect((await v.as.query(api.apps.list, { paginationOpts: { numItems: 10, cursor: null }, archived: false })).page).toEqual([]);

    const a = await admin(t, orgId);
    const id = await a.as.mutation(api.apps.createWeb, web("X"));
    await a.as.mutation(api.apps.setArchived, { appId: id, archived: true });
    const stale = await admin(t, orgId, "stale");
    await expectCode(stale.as.mutation(api.apps.remove, { appId: id }), "step_up_required");
    await a.as.mutation(api.apps.remove, { appId: id });
  });

  test("another organization's app, group, assignment or rule answers not_found for every function", async () => {
    const t = await setupAuth();
    const orgA = await makeOrg(t, "A");
    const orgB = await makeOrg(t, "B");
    const a = await admin(t, orgA);
    const b = await admin(t, orgB);
    const appB = await b.as.mutation(api.apps.createDesktop, desktop("B app"));
    const groupB = await group(t, orgB, "B group");
    const groupA = await group(t, orgA, "A group");
    const appA = await a.as.mutation(api.apps.createDesktop, desktop("A app"));
    const { assignmentId } = await b.as.mutation(api.groups.assignApp, { groupId: groupB, appId: appB, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
    await b.as.mutation(api.fileHandlers.set, { extension: ".pdf", appId: appB });
    const handlerId = (await t.run((ctx) => ctx.db.query("fileHandlers").withIndex("by_org_ext", (q) => q.eq("orgId", orgB)).first()))!._id;

    await expectCode(a.as.query(api.apps.get, { appId: appB }), "not_found");
    await expectCode(a.as.mutation(api.apps.update, { appId: appB, expectedRevision: 0, desktop: desktop("x") }), "not_found");
    await expectCode(a.as.mutation(api.apps.setArchived, { appId: appB, archived: true }), "not_found");
    await expectCode(a.as.mutation(api.apps.remove, { appId: appB }), "not_found");
    await expectCode(a.as.mutation(api.apps.retry, { appId: appB }), "not_found");
    await expectCode(a.as.action(api.apps.saveIcon, { appId: appB, png: TINY_PNG }), "not_found");
    await expectCode(a.as.mutation(api.fileHandlers.set, { extension: ".docx", appId: appB }), "not_found");
    await expectCode(a.as.mutation(api.fileHandlers.remove, { handlerId }), "not_found");
    await expectCode(a.as.mutation(api.groups.assignApp, { groupId: groupB, appId: appA, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false }), "not_found");
    await expectCode(a.as.mutation(api.groups.assignApp, { groupId: groupA, appId: appB, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false }), "not_found");
    await expectCode(a.as.mutation(api.groups.updateAssignment, { assignmentId, audience: "selected", pinnedTaskbar: false, pinnedDesktop: false }), "not_found");
    await expectCode(a.as.mutation(api.groups.unassignApp, { assignmentId }), "not_found");
    // a malformed id is the same answer
    await expectCode(a.as.query(api.apps.get, { appId: "nope" }), "not_found");

    // nothing of B's shows up in A's lists
    expect((await a.as.query(api.apps.list, { paginationOpts: { numItems: 10, cursor: null }, archived: false })).page.map((r) => r.name)).toEqual(["A app"]);
    expect((await a.as.query(api.fileHandlers.page, { paginationOpts: { numItems: 50, cursor: null } })).page).toEqual([]);
    expect((await a.as.query(api.apps.get, { appId: appA })).groupOptions.map((g) => g.name)).toEqual(["A group"]);
    // and B's data is untouched
    expect((await appRow(t, appB))?.archived).toBe(false);
    expect(await t.run((ctx) => ctx.db.get(assignmentId))).not.toBeNull();
  });
});

describe("apps: plan limit, archive, delete, retry", () => {
  test("maxApps counts non-archived apps: archiving frees a slot, restoring needs one", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Free", { plan: "free" });
    await t.run(async (ctx) => {
      const plan = (await ctx.db.query("orgPlans").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())!;
      await ctx.db.patch(plan._id, { limits: { ...plan.limits, maxApps: 2 } });
    });
    const a = await admin(t, orgId);
    const one = await a.as.mutation(api.apps.createWeb, web("One"));
    await a.as.mutation(api.apps.createWeb, web("Two"));
    const full = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        return (e as { data: { code: string; detail?: string } }).data;
      }
      return null;
    };
    expect(await full(a.as.mutation(api.apps.createWeb, web("Three")))).toEqual({ code: "plan_limit", detail: "apps" });
    expect(await full(a.as.mutation(api.apps.createDesktop, desktop("Three")))).toEqual({ code: "plan_limit", detail: "apps" });
    expect((await stats(t, orgId))?.appCount).toBe(2);

    await a.as.mutation(api.apps.setArchived, { appId: one, archived: true });
    expect((await stats(t, orgId))?.appCount).toBe(1);
    const three = await a.as.mutation(api.apps.createWeb, web("Three"));
    expect((await stats(t, orgId))?.appCount).toBe(2);
    expect(await full(a.as.mutation(api.apps.setArchived, { appId: one, archived: false }))).toEqual({ code: "plan_limit", detail: "apps" });
    expect((await appRow(t, one))?.archived).toBe(true); // refused: unchanged
    await a.as.mutation(api.apps.setArchived, { appId: three, archived: true });
    await a.as.mutation(api.apps.setArchived, { appId: one, archived: false });
    expect((await stats(t, orgId))?.appCount).toBe(2);
  });

  test("a suspended organization cannot add apps", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Susp", { plan: "free" });
    await t.run(async (ctx) => {
      const plan = (await ctx.db.query("orgPlans").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())!;
      await ctx.db.patch(plan._id, { status: "suspended" });
    });
    const a = await admin(t, orgId);
    await expectCode(a.as.mutation(api.apps.createWeb, web("X")), "plan_limit");
  });

  test("archiving twice writes nothing; delete only for archived apps with no assignment and no file type", async () => {
    vi.useFakeTimers();
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g = await group(t, orgId);
    const id = await a.as.mutation(api.apps.createDesktop, desktop("Reader"));
    await expectCode(a.as.mutation(api.apps.remove, { appId: id }), "invalid_argument"); // not archived
    const { assignmentId } = await a.as.mutation(api.groups.assignApp, { groupId: g, appId: id, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
    await a.as.mutation(api.fileHandlers.set, { extension: ".pdf", appId: id });
    await a.as.mutation(api.apps.setArchived, { appId: id, archived: true });
    const again = await probe(() => a.as.mutation(api.apps.setArchived, { appId: id, archived: true }));
    expect(again.io.writes).toBe(0);

    const detail = async () => {
      try {
        await a.as.mutation(api.apps.remove, { appId: id });
      } catch (e) {
        return (e as { data: { code: string; detail?: string } }).data;
      }
      return null;
    };
    expect(await detail()).toEqual({ code: "has_dependents", detail: "groups, file types" });
    await a.as.mutation(api.groups.unassignApp, { assignmentId });
    expect(await detail()).toEqual({ code: "has_dependents", detail: "file types" });
    const handlerId = (await t.run((ctx) => ctx.db.query("fileHandlers").withIndex("by_app", (q) => q.eq("appId", id)).first()))!._id;
    await a.as.mutation(api.fileHandlers.remove, { handlerId });
    expect(await detail()).toBeNull();
    expect(await appRow(t, id)).toBeNull();
    expect((await stats(t, orgId))?.appCount).toBe(0); // archiving already freed the slot
    expect(await actions(t, orgId)).toContain("app.deleted");
  });

  test("delete purges the install results and direct grants in batches, and the icon file", async () => {
    vi.useFakeTimers();
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const id = await a.as.mutation(api.apps.createDesktop, desktop("Reader"));
    const g = await group(t, orgId);
    const { deviceId } = await enrollDevice(t, orgId, { groupId: g });
    const { assignmentId } = await a.as.mutation(api.groups.assignApp, { groupId: g, appId: id, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await a.as.action(api.apps.saveIcon, { appId: id, png: TINY_PNG });
    const storageId = (await appRow(t, id))!.icon!.storageId;
    await t.run(async (ctx) => {
      for (let i = 0; i < 230; i++) {
        await ctx.db.insert("installResults", { orgId, deviceId, appId: id, groupId: g, state: i % 2 ? "installed" : "failed", appRevision: 0, attempts: 0, updatedAt: i });
      }
      const e = await ctx.db.insert("employees", { orgId, name: "E", username: "e", searchText: "e", disabled: false, credentialRevision: 0, revision: 0, createdAt: 0 });
      await ctx.db.insert("employeeApps", { orgId, employeeId: e, appId: id });
      expect(await ctx.storage.get(storageId)).not.toBeNull();
      // 115 of the rows are failed; 5 more failed rows (other apps) are counted too.
      const st = (await ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())!;
      await ctx.db.patch(st._id, { failedInstallCount: 120 });
    });
    await a.as.mutation(api.apps.setArchived, { appId: id, archived: true });
    // Step 17 review: archiving takes the app's 115 failed results out of the count at once.
    expect((await stats(t, orgId))?.failedInstallCount).toBe(5);
    await a.as.mutation(api.groups.unassignApp, { assignmentId });
    await a.as.mutation(api.apps.remove, { appId: id });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // The purge deletes rows that no longer count: the counter does not move again.
    expect((await stats(t, orgId))?.failedInstallCount).toBe(5);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("installResults").withIndex("by_app_state_updated", (q) => q.eq("appId", id)).first()).toBeNull();
      expect(await ctx.db.query("employeeApps").withIndex("by_app", (q) => q.eq("appId", id)).first()).toBeNull();
      expect(await ctx.storage.get(storageId)).toBeNull();
    });
  });

  test("retry bumps the revision and republishes; websites and archived apps have nothing to retry", async () => {
    vi.useFakeTimers();
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g = await group(t, orgId);
    const id = await a.as.mutation(api.apps.createDesktop, desktop("Reader"));
    const site = await a.as.mutation(api.apps.createWeb, web("Wiki"));
    await a.as.mutation(api.groups.assignApp, { groupId: g, appId: id, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
    await t.run(async (ctx) => {
      await ctx.db.delete((await ctx.db.query("publishQueue").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())!._id);
    });
    expect(await a.as.mutation(api.apps.retry, { appId: id })).toEqual({ revision: 1 });
    expect((await queueOf(t, orgId))?.groupIds).toEqual([g]);
    expect(await actions(t, orgId)).toContain("app.retryRequested");
    await expectCode(a.as.mutation(api.apps.retry, { appId: site }), "invalid_argument");
    const pre = await a.as.mutation(api.apps.createDesktop, desktop("Pre", { source: "preinstalled", install: undefined }));
    await expectCode(a.as.mutation(api.apps.retry, { appId: pre }), "invalid_argument");
  });
});

/** A minimal valid PNG (signature + a 1 x 1 IHDR), base64. */
const TINY_PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89));
const OTHER_PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0, 0x72, 0xb6, 0x0d, 0x24));

describe("apps: icon", () => {
  test("saveIcon stores the PNG with its SHA-256, replaces and deletes the old file, and the same icon again writes nothing", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const id = await a.as.mutation(api.apps.createWeb, web("Docs"));
    await a.as.action(api.apps.saveIcon, { appId: id, png: TINY_PNG });
    const first = (await appRow(t, id))!.icon!;
    const bytes = Uint8Array.from(atob(TINY_PNG), (c) => c.charCodeAt(0));
    expect(first).toMatchObject({ sha256: sha256HexOfBytes(bytes), sizeBytes: bytes.length });
    const detail = await a.as.query(api.apps.get, { appId: id });
    expect(detail.iconUrl).toMatch(/^https?:/);
    const list = await a.as.query(api.apps.list, { paginationOpts: { numItems: 10, cursor: null }, archived: false });
    expect(list.page[0]!.iconUrl).toBe(detail.iconUrl);

    // the same icon (also as the data URL the preview showed): the stored file stays
    await a.as.action(api.apps.saveIcon, { appId: id, png: `data:image/png;base64,${TINY_PNG}` });
    expect((await appRow(t, id))!.icon!.storageId).toBe(first.storageId);

    await a.as.action(api.apps.saveIcon, { appId: id, png: OTHER_PNG });
    const second = (await appRow(t, id))!.icon!;
    expect(second.sha256).not.toBe(first.sha256);
    await t.run(async (ctx) => {
      expect(await ctx.storage.get(first.storageId)).toBeNull();
      expect(await ctx.storage.get(second.storageId)).not.toBeNull();
    });
    expect((await actions(t, orgId)).filter((x) => x === "app.updated")).toHaveLength(2);
  });

  test("saveIcon refuses what is not a small PNG; nothing is stored", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const id = await a.as.mutation(api.apps.createWeb, web("Docs"));
    const big = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x03, 0xe8, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0, 0, 0, 0));
    const tooBig = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1) + "\0".repeat(33 * 1024));
    for (const png of ["", "AAAA", btoa("<html>"), "not base64 !!", big, tooBig]) {
      await expectCode(a.as.action(api.apps.saveIcon, { appId: id, png }), "invalid_argument");
    }
    expect((await appRow(t, id))?.icon).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.system.query("_storage").take(5))).toEqual([]);
  });

  test("another organization's app: not_found and no orphan file", async () => {
    const t = await setupAuth();
    const orgA = await makeOrg(t, "A");
    const orgB = await makeOrg(t, "B");
    const a = await admin(t, orgA);
    const b = await admin(t, orgB);
    const appB = await b.as.mutation(api.apps.createWeb, web("B"));
    await expectCode(a.as.action(api.apps.saveIcon, { appId: appB, png: TINY_PNG }), "not_found");
    expect(await t.run((ctx) => ctx.db.system.query("_storage").take(5))).toEqual([]);
    // an id that is not an app at all fails the same way, before anything is stored
    await expectCode(a.as.action(api.apps.saveIcon, { appId: "nonsense", png: TINY_PNG }), "not_found");
    expect(await t.run((ctx) => ctx.db.system.query("_storage").take(5))).toEqual([]);
  });

  test("saveIcon shares the 20 per minute metadata limit of the organization", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const id = await a.as.mutation(api.apps.createWeb, web("Docs"));
    for (let i = 0; i < 20; i++) await a.as.action(api.apps.saveIcon, { appId: id, png: TINY_PNG });
    await expectCode(a.as.action(api.apps.saveIcon, { appId: id, png: TINY_PNG }), "rate_limited");
    stubFetch({ [PAGE]: { body: "<html></html>" } });
    await expectCode(a.as.action(api.apps.fetchWebMeta, { url: PAGE }), "rate_limited"); // the same bucket
  });
});

const PAGE = "https://docs.example.com/start";
const stubFetch = (routes: Record<string, { status?: number; body?: BodyInit; headers?: Record<string, string> }>) => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const r = routes[url];
    return r === undefined ? new Response("nope", { status: 404 }) : new Response(r.body ?? "", { status: r.status ?? 200, headers: r.headers });
  });
  return urls;
};

describe("apps: fetchWebMeta action", () => {
  test("answers name, hue and an icon preview; stores nothing", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const icon = new Uint8Array(64);
    icon.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 128, 0, 0, 0, 128]);
    stubFetch({
      [PAGE]: { body: manifestPage },
      "https://docs.example.com/assets/site.webmanifest?v=3&x=1": { body: JSON.stringify({ name: "Example Docs", theme_color: "#0000ff", icons: [{ src: "i.png", sizes: "128x128", type: "image/png" }] }) },
      "https://docs.example.com/assets/i.png": { body: icon },
    });
    const meta = await a.as.action(api.apps.fetchWebMeta, { url: PAGE });
    expect(meta).toMatchObject({ name: "Example Docs", hue: 240 });
    expect(meta.iconPreviewUrl).toMatch(/^data:image\/png;base64,/);
    expect(await t.run((ctx) => ctx.db.query("apps").withIndex("by_org", (q) => q.eq("orgId", orgId)).first())).toBeNull();
    expect(await t.run((ctx) => ctx.db.system.query("_storage").take(1))).toEqual([]);
  });

  test("a bad address is refused before any request; an unreadable page is webmeta_failed; a redirect to a private host is not followed", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const urls = stubFetch({
      [PAGE]: { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data/" } },
      "https://gone.example.com/": { status: 500 },
    });
    for (const url of ["http://docs.example.com", "https://10.0.0.1/", "https://localhost/", "nonsense"]) {
      await expectCode(a.as.action(api.apps.fetchWebMeta, { url }), "invalid_argument");
    }
    expect(urls).toEqual([]);
    await expectCode(a.as.action(api.apps.fetchWebMeta, { url: PAGE }), "webmeta_failed");
    await expectCode(a.as.action(api.apps.fetchWebMeta, { url: "https://gone.example.com/" }), "webmeta_failed");
    expect(urls).toEqual([PAGE, "https://gone.example.com/"]); // the metadata address was never requested
  });

  test("rate limited per organization", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    stubFetch({ [PAGE]: { body: "<html></html>" } });
    for (let i = 0; i < 20; i++) await a.as.action(api.apps.fetchWebMeta, { url: PAGE });
    await expectCode(a.as.action(api.apps.fetchWebMeta, { url: PAGE }), "rate_limited");
  });
});

const API_7Z = "https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/7/7zip/7zip";

describe("apps: resolveWinget action", () => {
  const routes = {
    [API_7Z]: { body: JSON.stringify([{ name: "24.08", type: "dir" }, { name: "23.01", type: "dir" }]) },
    [installerManifestUrl("7zip.7zip", "24.08")]: { body: sevenZip },
    [localeManifestUrl("7zip.7zip", "24.08")]: { body: sevenZipLocale },
  };

  test("resolves from the manifest, caches for 24 hours, then asks GitHub again", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const urls = stubFetch(routes);
    const r = await a.as.action(api.apps.resolveWinget, { packageId: "7zip.7zip" });
    expect(r).toMatchObject({ packageId: "7zip.7zip", version: "24.08", name: "7-Zip", install: { kind: "msi", productCode: "{23170F69-40C1-2702-2408-000001000000}" } });
    expect(urls).toHaveLength(3);

    const cached = await a.as.action(api.apps.resolveWinget, { packageId: " 7zip.7zip ", version: "" });
    expect(cached).toEqual(r);
    expect(urls).toHaveLength(3); // no new request
    expect(await t.run((ctx) => ctx.db.query("wingetCache").withIndex("by_package_version", (q) => q.eq("packageId", "7zip.7zip")).take(5))).toHaveLength(1);

    // a named version is its own cache entry
    await a.as.action(api.apps.resolveWinget, { packageId: "7zip.7zip", version: "24.08" });
    expect(urls).toHaveLength(5); // manifest + locale
    expect(await t.run((ctx) => ctx.db.query("wingetCache").withIndex("by_package_version", (q) => q.eq("packageId", "7zip.7zip")).take(5))).toHaveLength(2);

    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("wingetCache").withIndex("by_package_version", (q) => q.eq("packageId", "7zip.7zip")).take(5)) {
        await ctx.db.patch(row._id, { fetchedAt: Date.now() - WINGET_CACHE_MS - 1000 });
      }
    });
    await a.as.action(api.apps.resolveWinget, { packageId: "7zip.7zip" });
    expect(urls).toHaveLength(8);
    expect(await t.run((ctx) => ctx.db.query("wingetCache").withIndex("by_package_version", (q) => q.eq("packageId", "7zip.7zip").eq("version", "")).take(5))).toHaveLength(1); // replaced, not duplicated
  });

  test("errors: unreachable, unsupported, bad ids; failures are not cached", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    stubFetch({ [API_7Z]: { status: 403 } });
    await expectCode(a.as.action(api.apps.resolveWinget, { packageId: "7zip.7zip" }), "winget_unreachable");
    stubFetch({});
    await expectCode(a.as.action(api.apps.resolveWinget, { packageId: "7zip.7zip" }), "winget_unsupported");
    const urls = stubFetch({});
    await expectCode(a.as.action(api.apps.resolveWinget, { packageId: "../etc.passwd" }), "invalid_argument");
    await expectCode(a.as.action(api.apps.resolveWinget, { packageId: "7zip.7zip", version: "../1" }), "invalid_argument");
    expect(urls).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("wingetCache").take(1))).toEqual([]);
  });
});

describe("apps: assignments and the signed documents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

  async function docOf(t: T, deviceId: Id<"devices">) {
    const head = await t.run((ctx) => ctx.db.query("desiredHeads").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique());
    const body = head === null ? null : await t.run((ctx) => ctx.db.get(head.bodyId));
    return { version: head?.version ?? 0, doc: body === null ? null : (JSON.parse(body.payload) as { doc: { apps: string[]; catalog: { id: string; audience: string; pinnedTaskbar: boolean; pinnedDesktop: boolean; icon: { url: string; sha256: string } | null; kind: string }[]; fileHandlers: Record<string, string> } }).doc };
  }

  async function setup() {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const groupId = await group(t, orgId);
    const { deviceId } = await enrollDevice(t, orgId, { groupId });
    await drain(t);
    return { t, orgId, a, groupId, deviceId };
  }

  test("assign -> the group's devices get the app (audience and pins) in a new version; update and unassign follow", async () => {
    const { t, a, groupId, deviceId } = await setup();
    expect((await docOf(t, deviceId)).doc?.apps).toEqual(["files"]);
    const app = await a.as.mutation(api.apps.createWeb, web("Docs"));
    await drain(t);
    expect((await docOf(t, deviceId)).version).toBe(1); // creating an unassigned app changes no document

    const { assignmentId } = await a.as.mutation(api.groups.assignApp, { groupId, appId: app, audience: "everyone", pinnedTaskbar: true, pinnedDesktop: false });
    await drain(t);
    let d = await docOf(t, deviceId);
    expect(d.version).toBe(2);
    expect(d.doc?.apps).toEqual(["files", app]);
    expect(d.doc?.catalog.find((c) => c.id === app)).toMatchObject({ kind: "web", audience: "everyone", pinnedTaskbar: true, pinnedDesktop: false });

    await a.as.mutation(api.groups.updateAssignment, { assignmentId, audience: "selected", pinnedTaskbar: false, pinnedDesktop: true });
    await drain(t);
    d = await docOf(t, deviceId);
    expect(d.version).toBe(3);
    expect(d.doc?.catalog.find((c) => c.id === app)).toMatchObject({ audience: "selected", pinnedTaskbar: false, pinnedDesktop: true });

    await a.as.mutation(api.groups.unassignApp, { assignmentId });
    await drain(t);
    d = await docOf(t, deviceId);
    expect(d.version).toBe(4);
    expect(d.doc?.apps).toEqual(["files"]);
    expect(await actions(t, (await t.run((ctx) => ctx.db.get(deviceId)))!.orgId)).toEqual(expect.arrayContaining(["app.assigned", "app.unassigned"]));
  });

  test("assignment changes publish only on change: an identical update writes nothing and queues nothing", async () => {
    const { t, orgId, a, groupId, deviceId } = await setup();
    const app = await a.as.mutation(api.apps.createWeb, web("Docs"));
    const { assignmentId } = await a.as.mutation(api.groups.assignApp, { groupId, appId: app, audience: "everyone", pinnedTaskbar: true, pinnedDesktop: true });
    await drain(t);
    const before = (await docOf(t, deviceId)).version;
    expect(await queueOf(t, orgId)).toBeNull();

    const same = await probe(() => a.as.mutation(api.groups.updateAssignment, { assignmentId, audience: "everyone", pinnedTaskbar: true, pinnedDesktop: true }));
    expect(same.io.writes).toBe(0);
    expect(await queueOf(t, orgId)).toBeNull();
    await drain(t);
    expect((await docOf(t, deviceId)).version).toBe(before);

    // a change that leaves the document the same bytes (re-saving a rename-free edit) is dropped by the publisher
    await a.as.mutation(api.apps.update, { appId: app, expectedRevision: 0, web: web("Docs") });
    expect(await queueOf(t, orgId)).toBeNull();
  });

  test("archived apps leave every document and come back when restored; a second group is untouched", async () => {
    const { t, orgId, a, groupId, deviceId } = await setup();
    const other = await group(t, orgId, "Other");
    const { deviceId: otherDevice } = await enrollDevice(t, orgId, { groupId: other });
    const app = await a.as.mutation(api.apps.createWeb, web("Docs"));
    await a.as.mutation(api.groups.assignApp, { groupId, appId: app, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: true });
    await drain(t);
    expect((await docOf(t, deviceId)).doc?.apps).toEqual(["files", app]);
    const otherVersion = (await docOf(t, otherDevice)).version;

    await a.as.mutation(api.apps.setArchived, { appId: app, archived: true });
    await drain(t);
    expect((await docOf(t, deviceId)).doc?.apps).toEqual(["files"]);
    expect((await docOf(t, otherDevice)).version).toBe(otherVersion); // only the groups that carry the app are rebuilt

    await a.as.mutation(api.apps.setArchived, { appId: app, archived: false });
    await drain(t);
    expect((await docOf(t, deviceId)).doc?.apps).toEqual(["files", app]);
    // an archived app cannot be assigned
    await a.as.mutation(api.apps.setArchived, { appId: app, archived: true });
    await expectCode(a.as.mutation(api.groups.assignApp, { groupId: other, appId: app, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false }), "invalid_argument");
  });

  test("an assigned app carries its icon (stable URL + SHA-256) and file types only for apps in the catalogue", async () => {
    const { t, orgId, a, groupId, deviceId } = await setup();
    const reader = await a.as.mutation(api.apps.createDesktop, desktop("Reader"));
    const other = await a.as.mutation(api.apps.createDesktop, desktop("Other", { exe: "{ProgramFiles}\\Other\\other.exe" }));
    await a.as.action(api.apps.saveIcon, { appId: reader, png: TINY_PNG });
    await a.as.mutation(api.fileHandlers.set, { extension: ".pdf", appId: reader });
    await a.as.mutation(api.fileHandlers.set, { extension: ".docx", appId: other }); // not assigned to this group
    await a.as.mutation(api.groups.assignApp, { groupId, appId: reader, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: true });
    await drain(t);
    const d = (await docOf(t, deviceId)).doc!;
    expect(d.apps).toEqual(["files", reader]);
    expect(d.fileHandlers).toEqual({ ".pdf": reader });
    const entry = d.catalog.find((c) => c.id === reader)!;
    const stored = (await appRow(t, reader))!.icon!;
    expect(entry.icon).toEqual({ url: (await t.run((ctx) => ctx.storage.getUrl(stored.storageId)))!, sha256: stored.sha256 });

    // removing the rule, or unassigning the program, takes the extension out of the document
    await a.as.mutation(api.groups.assignApp, { groupId, appId: other, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
    await drain(t);
    expect((await docOf(t, deviceId)).doc?.fileHandlers).toEqual({ ".docx": other, ".pdf": reader });
    const rule = (await t.run((ctx) => ctx.db.query("fileHandlers").withIndex("by_org_ext", (q) => q.eq("orgId", orgId).eq("extension", ".pdf")).first()))!;
    await a.as.mutation(api.fileHandlers.remove, { handlerId: rule._id });
    await drain(t);
    expect((await docOf(t, deviceId)).doc?.fileHandlers).toEqual({ ".docx": other });
  });

  test("assignApp: one assignment per pair (conflict), at most 150 apps per group (too_large)", async () => {
    const { t, orgId, a, groupId } = await setup();
    const app = await a.as.mutation(api.apps.createWeb, web("Docs"));
    const args = { groupId, appId: app, audience: "everyone" as const, pinnedTaskbar: false, pinnedDesktop: false };
    await a.as.mutation(api.groups.assignApp, args);
    await expectCode(a.as.mutation(api.groups.assignApp, args), "conflict");
    await t.run(async (ctx) => {
      for (let i = 1; i < 150; i++) {
        const id = await ctx.db.insert("apps", { orgId, name: `A${i}`, kind: "web", archived: false, revision: 0, createdAt: i });
        await ctx.db.insert("appAssignments", { orgId, groupId, appId: id, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
      }
    });
    const extra = await a.as.mutation(api.apps.createWeb, web("One too many"));
    await expectCode(a.as.mutation(api.groups.assignApp, { ...args, appId: extra }), "too_large");
  });

  test("groups:get returns assignment ids for the dashboard", async () => {
    const { a, groupId } = await setup();
    const app = await a.as.mutation(api.apps.createWeb, web("Docs", { hue: 40 }));
    const { assignmentId } = await a.as.mutation(api.groups.assignApp, { groupId, appId: app, audience: "selected", pinnedTaskbar: true, pinnedDesktop: false });
    const g = await a.as.query(api.groups.get, { groupId });
    expect(g.apps).toEqual([
      { assignmentId, appId: app, name: "Docs", kind: "web", hue: 40, archived: false, audience: "selected", pinnedTaskbar: true, pinnedDesktop: false },
    ]);
  });
});

describe("no unbounded reads", () => {
  test("the Step 10 modules never call .collect() or filter a table", async () => {
    const sources = import.meta.glob(["./apps.ts", "./fileHandlers.ts", "./groups.ts", "./lib/appPublish.ts", "./lib/appRules.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(sources).sort()).toEqual(["./apps.ts", "./fileHandlers.ts", "./groups.ts", "./lib/appPublish.ts", "./lib/appRules.ts"]);
    for (const [path, text] of Object.entries(sources)) {
      expect(text, path).not.toMatch(/\.collect\(/);
      expect(text, path).not.toMatch(/\.filter\(\(?q\b/); // a database filter, not Array#filter
    }
  });

  test("apps:list reads at most the page, its group counts and wrapper rows, never install results", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g = await group(t, orgId);
    await t.run(async (ctx) => {
      for (let i = 0; i < 60; i++) {
        const id = await ctx.db.insert("apps", { orgId, name: `App ${i}`, kind: "web", archived: false, revision: 0, createdAt: i });
        await ctx.db.insert("appAssignments", { orgId, groupId: g, appId: id, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
        await ctx.db.insert("installResults", { orgId, deviceId: (await ctx.db.insert("devices", { orgId, name: "d", enrolledAt: 0, enrollmentTokenId: (await ctx.db.insert("enrollmentTokens", { orgId, tokenHash: "x".repeat(64), expiresAt: 0, usesLeft: 0, createdAt: 0 })) })), appId: id, state: "failed", appRevision: 0, attempts: 1, updatedAt: 0 });
      }
    });
    const { result, io } = await probe(() => a.as.query(api.apps.list, { paginationOpts: { numItems: 50, cursor: null }, archived: false }));
    expect(result.page).toHaveLength(50);
    expect(result.isDone).toBe(false);
    expect(io.tables.has("installResults")).toBe(false);
    expect(io.reads).toBeLessThanOrEqual(3 + 50 + 50 * 2 + 5);
  });
});

// ---------------------------------------------------------------- install status (plan Step 17 items 1-2)

/** The organization's "Floor" group (made once): the bare devices are in it. */
async function floorGroup(t: T, orgId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const g = await ctx.db.query("groups").withIndex("by_org_name", (q) => q.eq("orgId", orgId).eq("name", "Floor")).first();
    return g?._id ?? (await ctx.db.insert("groups", { orgId, name: "Floor", revision: 0, createdAt: 0 }));
  });
}

/** A bare device row in the "Floor" group (no credentials): enough for the install lists, which join only its name. */
async function bareDevice(t: T, orgId: Id<"organizations">, name: string) {
  const groupId = await floorGroup(t, orgId);
  return await t.run(async (ctx) => {
    const enrollmentTokenId = await ctx.db.insert("enrollmentTokens", { orgId, tokenHash: `${name}`.padEnd(64, "x"), expiresAt: 0, usesLeft: 0, createdAt: 0 });
    return await ctx.db.insert("devices", { orgId, name, enrolledAt: 0, enrollmentTokenId, groupId });
  });
}

type SeedState = "pending" | "installed" | "failed" | "removed" | "unsupported";
/** A result tagged with the device's group, the app assigned to that group (so it counts) unless `assign: false`. */
async function seedInstall(t: T, orgId: Id<"organizations">, deviceId: Id<"devices">, appId: Id<"apps">, state: SeedState, extra: { detail?: string; exitCode?: number; updatedAt?: number; assign?: boolean } = {}) {
  const { assign, ...fields } = extra;
  return await t.run(async (ctx) => {
    const groupId = (await ctx.db.get(deviceId))?.groupId;
    if (groupId !== undefined && assign !== false) {
      const has = await ctx.db.query("appAssignments").withIndex("by_group_app", (q) => q.eq("groupId", groupId).eq("appId", appId)).first();
      if (has === null) await ctx.db.insert("appAssignments", { orgId, groupId, appId, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
    }
    return await ctx.db.insert("installResults", { orgId, deviceId, appId, groupId, state, appRevision: 0, attempts: state === "failed" ? 3 : 1, updatedAt: fields.updatedAt ?? 1_000, ...fields });
  });
}

describe("apps:installSummary", () => {
  test("counts per state: none, a few, and the cap (1,001 means 1000+); other apps and organizations do not count", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const app = await a.as.mutation(api.apps.createDesktop, desktop("Acme"));
    const other = await a.as.mutation(api.apps.createDesktop, desktop("Other"));
    const zero = { pending: 0, downloading: 0, installing: 0, installed: 0, failed: 0, removing: 0, removed: 0, unsupported: 0 };
    const viewer = await asMember(t, { role: "viewer", orgId });
    expect(await viewer.as.query(api.apps.installSummary, { appId: app })).toEqual(zero);

    const d1 = await bareDevice(t, orgId, "PC 1");
    const d2 = await bareDevice(t, orgId, "PC 2");
    const d3 = await bareDevice(t, orgId, "PC 3");
    await seedInstall(t, orgId, d1, app, "installed");
    await seedInstall(t, orgId, d2, app, "installed");
    await seedInstall(t, orgId, d3, app, "failed");
    await seedInstall(t, orgId, d1, other, "pending");
    expect(await viewer.as.query(api.apps.installSummary, { appId: app })).toEqual({ ...zero, installed: 2, failed: 1 });

    // Over the cap: the count stops at 1,001, which the screen shows as "1000+".
    const floor = await floorGroup(t, orgId);
    await t.run(async (ctx) => {
      for (let i = 0; i < 1_002; i++) {
        await ctx.db.insert("installResults", { orgId, deviceId: d1, appId: other, groupId: floor, state: "installed", appRevision: 0, attempts: 1, updatedAt: i });
      }
    });
    expect(await viewer.as.query(api.apps.installSummary, { appId: other })).toEqual({ ...zero, pending: 1, installed: 1_001, capped: true });
  });

  test("another organization's app is not_found; every role may read it", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const app = await a.as.mutation(api.apps.createWeb, web("Docs"));
    const foreign = await asMember(t, { role: "viewer", orgId: await makeOrg(t, "Other") });
    await expectCode(foreign.as.query(api.apps.installSummary, { appId: app }), "not_found");
    await expectCode(foreign.as.query(api.apps.installs, { appId: app, state: "failed", paginationOpts: { numItems: 10, cursor: null } }), "not_found");
    expect(await a.as.query(api.apps.installSummary, { appId: app })).toMatchObject({ installed: 0 });
  });

  test("with 3 results it reads 3 results plus one empty range per state, never the devices", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const app = await a.as.mutation(api.apps.createDesktop, desktop("Acme"));
    const d = await bareDevice(t, orgId, "PC");
    for (const s of ["installed", "failed", "pending"] as const) await seedInstall(t, orgId, d, app, s);
    const { io } = await probe(() => a.as.query(api.apps.installSummary, { appId: app }));
    expect(io.tables.has("devices")).toBe(false);
    // + the one assignment row (the results count only for its group; Step 17 review).
    expect(io.reads).toBeLessThanOrEqual(3 + 1 + 3 + 1);
  });
});

describe("apps:installs", () => {
  test("the PCs in one state, newest first, paginated, with their names; a removed PC is left out", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const app = await a.as.mutation(api.apps.createDesktop, desktop("Acme"));
    const ids: Id<"devices">[] = [];
    for (const n of ["Front", "Back", "Lab", "Gone"]) ids.push(await bareDevice(t, orgId, n));
    await seedInstall(t, orgId, ids[0]!, app, "failed", { detail: "The installer exited with an error.", exitCode: 1603 });
    await seedInstall(t, orgId, ids[1]!, app, "failed");
    await seedInstall(t, orgId, ids[2]!, app, "installed");
    await seedInstall(t, orgId, ids[3]!, app, "failed");
    await t.run((ctx) => ctx.db.delete(ids[3]!));

    const failed = await a.as.query(api.apps.installs, { appId: app, state: "failed", paginationOpts: { numItems: 10, cursor: null } });
    expect(failed.page.map((r) => r.deviceName)).toEqual(["Back", "Front"]);
    expect(failed.page[1]).toMatchObject({ deviceId: ids[0], state: "failed", attempts: 3, exitCode: 1603, detail: "The installer exited with an error." });
  });

  test("pages follow each other newest first; the page size is bounded; a foreign state value is refused by the validator", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const app = await a.as.mutation(api.apps.createDesktop, desktop("Acme"));
    for (let i = 0; i < 5; i++) await seedInstall(t, orgId, await bareDevice(t, orgId, `PC ${i}`), app, "failed");
    const q = (cursor: string | null, numItems = 2) => a.as.query(api.apps.installs, { appId: app, state: "failed", paginationOpts: { numItems, cursor } });
    const p1 = await q(null);
    const p2 = await q(p1.continueCursor);
    const p3 = await q(p2.continueCursor);
    expect([p1, p2, p3].map((p) => p.page.map((r) => r.deviceName))).toEqual([["PC 4", "PC 3"], ["PC 2", "PC 1"], ["PC 0"]]);
    expect(p3.isDone).toBe(true);
    await expectCode(q(null, 51), "invalid_argument");
    await expect(a.as.query(api.apps.installs, { appId: app, state: "nonsense" as never, paginationOpts: { numItems: 2, cursor: null } })).rejects.toThrow();
  });
});

describe("install status follows the assignment (Step 17 review)", () => {
  test("an unassigned group's results and an archived app's results stop counting in the summary, the list and failedInstallCount; assigning again brings them back", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const app = await a.as.mutation(api.apps.createDesktop, desktop("Acme"));
    const front = await group(t, orgId, "Front");
    const back = await group(t, orgId, "Back");
    const devices = await t.run(async (ctx) => {
      const mk = async (name: string, groupId: Id<"groups">) => {
        const enrollmentTokenId = await ctx.db.insert("enrollmentTokens", { orgId, tokenHash: name.padEnd(64, "y"), expiresAt: 0, usesLeft: 0, createdAt: 0 });
        return await ctx.db.insert("devices", { orgId, name, enrolledAt: 0, enrollmentTokenId, groupId });
      };
      return { f1: await mk("F1", front), f2: await mk("F2", front), b1: await mk("B1", back) };
    });
    const assign = async (groupId: Id<"groups">) =>
      (await a.as.mutation(api.groups.assignApp, { groupId, appId: app, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false })).assignmentId;
    const frontA = await assign(front);
    await assign(back);
    await t.run(async (ctx) => {
      const row = (deviceId: Id<"devices">, groupId: Id<"groups">, state: "failed" | "installed", updatedAt: number) =>
        ctx.db.insert("installResults", { orgId, deviceId, appId: app, groupId, state, appRevision: 0, attempts: 1, updatedAt });
      await row(devices.f1, front, "failed", 10);
      await row(devices.f2, front, "installed", 20);
      await row(devices.b1, back, "failed", 30);
      const st = (await ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())!;
      await ctx.db.patch(st._id, { failedInstallCount: 2 });
    });
    const summary = () => a.as.query(api.apps.installSummary, { appId: app });
    const failedNames = async () => (await a.as.query(api.apps.installs, { appId: app, state: "failed", paginationOpts: { numItems: 10, cursor: null } })).page.map((r) => r.deviceName);
    expect(await summary()).toMatchObject({ installed: 1, failed: 2 });
    expect(await failedNames()).toEqual(["B1", "F1"]); // newest updatedAt first

    await a.as.mutation(api.groups.unassignApp, { assignmentId: frontA });
    expect(await summary()).toMatchObject({ installed: 0, failed: 1 });
    expect(await failedNames()).toEqual(["B1"]);
    expect((await stats(t, orgId))?.failedInstallCount).toBe(1);
    expect((await a.as.query(api.overview.failedInstallsPage, { paginationOpts: { numItems: 50, cursor: null } })).page.map((r) => r.deviceName)).toEqual(["B1"]);

    await a.as.mutation(api.apps.setArchived, { appId: app, archived: true });
    expect(await summary()).toMatchObject({ installed: 0, failed: 0 });
    expect(await failedNames()).toEqual([]);
    expect((await stats(t, orgId))?.failedInstallCount).toBe(0);
    expect((await a.as.query(api.overview.failedInstallsPage, { paginationOpts: { numItems: 50, cursor: null } })).page).toEqual([]);

    await a.as.mutation(api.apps.setArchived, { appId: app, archived: false });
    expect((await stats(t, orgId))?.failedInstallCount).toBe(1);
    await assign(front);
    expect((await stats(t, orgId))?.failedInstallCount).toBe(2);
    expect(await summary()).toMatchObject({ installed: 1, failed: 2 });
  });

  test("more failed results than one transaction counts: the counter is left to stats:reconcile, which is scheduled", async () => {
    vi.useFakeTimers();
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const app = await a.as.mutation(api.apps.createDesktop, desktop("Acme"));
    const g = await group(t, orgId);
    const d = await bareDevice(t, orgId, "PC");
    await t.run(async (ctx) => {
      for (let i = 0; i < 501; i++) {
        await ctx.db.insert("installResults", { orgId, deviceId: d, appId: app, groupId: g, state: "failed", appRevision: 0, attempts: 1, updatedAt: i });
      }
    });
    await a.as.mutation(api.groups.assignApp, { groupId: g, appId: app, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await stats(t, orgId))?.failedInstallCount).toBe(501);
  });
});
// ---------------------------------------------------------------- web app permissions (Phase 5 Step 11, plan 4.13)

describe("apps:setPermissions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
  const ALLOWED = { camera: false, microphone: true, screenShare: false, clipboardRead: false, notifications: true, downloads: true, printing: true, geolocation: false };

  async function setup() {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const groupId = await group(t, orgId);
    const { deviceId } = await enrollDevice(t, orgId, { groupId });
    const app = await a.as.mutation(api.apps.createWeb, web("Meet"));
    await a.as.mutation(api.groups.assignApp, { groupId, appId: app, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: true });
    await drain(t);
    return { t, orgId, a, groupId, deviceId, app };
  }

  async function catalogPermissions(t: T, deviceId: Id<"devices">, appId: Id<"apps">) {
    const head = await t.run((ctx) => ctx.db.query("desiredHeads").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique());
    const body = head === null ? null : await t.run((ctx) => ctx.db.get(head.bodyId));
    const doc = (JSON.parse(body!.payload) as { doc: { catalog: { id: string; web?: { permissions: Record<string, boolean> } }[] } }).doc;
    return doc.catalog.find((c) => c.id === appId)?.web?.permissions;
  }

  test("an admin saves: revision +1, audit names what changed (no address), the group is snapshotted and the device document carries it", async () => {
    const { t, orgId, a, groupId, deviceId, app } = await setup();
    expect((await catalogPermissions(t, deviceId, app))?.microphone).toBe(false);

    expect(await a.as.mutation(api.apps.setPermissions, { appId: app, expectedRevision: 0, permissions: ALLOWED })).toEqual({ revision: 1 });
    expect((await appRow(t, app))?.web?.permissions).toEqual(ALLOWED);
    expect((await appRow(t, app))?.web?.url).toBe("https://docs.example.com/start"); // only the permissions change
    const log = (await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(100))).filter((r) => r.action === "app.permissionsChanged");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ targetId: app, targetLabel: "Meet", summary: "Changed permissions of Meet: microphone allowed" });
    expect(log[0]!.summary).not.toContain("http");

    const versions = await t.run((ctx) => ctx.db.query("groupConfigs").withIndex("by_group_version", (q) => q.eq("groupId", groupId)).collect());
    expect(versions.length).toBeGreaterThanOrEqual(1); // the group has a configuration version now
    expect(await t.run((ctx) => ctx.db.query("groupRollouts").withIndex("by_group", (q) => q.eq("groupId", groupId)).unique())).not.toBeNull();

    await drain(t);
    expect((await catalogPermissions(t, deviceId, app))?.microphone).toBe(true);
  });

  test("the same permissions again write nothing and publish nothing; a stale revision is refused", async () => {
    const { t, orgId, a, app } = await setup();
    const current = (await appRow(t, app))!.web!.permissions;
    const same = await probe(() => a.as.mutation(api.apps.setPermissions, { appId: app, expectedRevision: 0, permissions: current }));
    expect(same.result).toEqual({ revision: 0 });
    expect(same.io.writes).toBe(0);
    expect(await queueOf(t, orgId)).toBeNull();

    await a.as.mutation(api.apps.setPermissions, { appId: app, expectedRevision: 0, permissions: ALLOWED });
    await expectCode(a.as.mutation(api.apps.setPermissions, { appId: app, expectedRevision: 0, permissions: { ...ALLOWED, camera: true } }), "stale_edit");
    expect((await appRow(t, app))?.web?.permissions.camera).toBe(false);
    // a second save of the new state is a no-op again
    expect(await a.as.mutation(api.apps.setPermissions, { appId: app, expectedRevision: 1, permissions: ALLOWED })).toEqual({ revision: 1 });
  });

  test("a Viewer cannot save; neither can another organization's admin; a program has no permissions", async () => {
    const { t, orgId, a, app } = await setup();
    const v = await asMember(t, { role: "viewer", orgId });
    await giveStepUp(t, v);
    await expectCode(v.as.mutation(api.apps.setPermissions, { appId: app, expectedRevision: 0, permissions: ALLOWED }), "forbidden");
    expect((await appRow(t, app))?.web?.permissions.microphone).toBe(false);

    const other = await admin(t, await makeOrg(t, "Other"));
    await expectCode(other.as.mutation(api.apps.setPermissions, { appId: app, expectedRevision: 0, permissions: ALLOWED }), "not_found");

    const program = await a.as.mutation(api.apps.createDesktop, desktop("Acme"));
    await expectCode(a.as.mutation(api.apps.setPermissions, { appId: program, expectedRevision: 0, permissions: ALLOWED }), "invalid_argument");
  });

  test("saving a site's other settings keeps its permissions; existing rows are not rewritten", async () => {
    const { t, a, app } = await setup();
    await a.as.mutation(api.apps.setPermissions, { appId: app, expectedRevision: 0, permissions: { ...ALLOWED, printing: false } });
    await a.as.mutation(api.apps.update, { appId: app, expectedRevision: 1, web: web("Meet 2") });
    expect((await appRow(t, app))?.web?.permissions).toEqual({ ...ALLOWED, printing: false });
  });

  // Step 16b (deliberate change): the app record is ring-gated, so an edit must snapshot EVERY group that assigns the app. More than
  // MAX_CATALOG_SNAPSHOT_GROUPS groups is refused (as Wi-Fi profiles and printers are) instead of silently snapshotting the first 10.
  test("more than 10 groups: every edit of the app record is refused with too_large and writes nothing; 10 groups pass", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const app = await a.as.mutation(api.apps.createWeb, web("Meet"));
    const groups: Id<"groups">[] = [];
    for (let i = 0; i < 12; i++) {
      const g = await group(t, orgId, `G${i}`);
      groups.push(g);
      await a.as.mutation(api.groups.assignApp, { groupId: g, appId: app, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
    }
    await drain(t);
    const total = () => t.run(async (ctx) => (await ctx.db.query("groupConfigs").collect()).length);
    expect(await total()).toBe(12); // one version per group, from its assignment
    await expectCode(a.as.mutation(api.apps.setPermissions, { appId: app, expectedRevision: 0, permissions: ALLOWED }), "too_large");
    await expectCode(a.as.mutation(api.apps.update, { appId: app, expectedRevision: 0, web: web("Meet 2") }), "too_large");
    await expectCode(a.as.mutation(api.apps.setArchived, { appId: app, archived: true }), "too_large");
    expect(await appRow(t, app)).toMatchObject({ name: "Meet", archived: false, revision: 0 });
    expect(await total()).toBe(12);
    expect(await queueOf(t, orgId)).toBeNull();

    // Two groups fewer: the same save goes through and every remaining group gets a new version.
    for (const g of groups.slice(10)) {
      const row = await t.run((ctx) => ctx.db.query("appAssignments").withIndex("by_group_app", (q) => q.eq("groupId", g).eq("appId", app)).unique());
      await a.as.mutation(api.groups.unassignApp, { assignmentId: row!._id });
    }
    await drain(t);
    expect(await total()).toBe(14);
    await a.as.mutation(api.apps.setPermissions, { appId: app, expectedRevision: 0, permissions: ALLOWED });
    expect(await total()).toBe(24);
    expect([...((await queueOf(t, orgId))?.groupIds ?? [])].sort()).toEqual([...groups.slice(0, 10)].sort());
  });
});

describe("apps:get denials30d", () => {
  const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const blocked = { appLocker: 0, appControl: 0, procWatch: 0, elevation: 0 };
  async function seedDay(t: T, orgId: Id<"organizations">, day: string, permissionDenials: { appId: string; kind: string; count: number }[]) {
    await t.run((ctx) => ctx.db.insert("orgSecurityDaily", { orgId, day, blocked, permissionDenials, devicesReporting: 1 }));
  }

  test("counts sum across days per kind, only for this app and this organization, newest 30 days only, biggest first", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const v = await asMember(t, { role: "viewer", orgId });
    const app = await a.as.mutation(api.apps.createWeb, web("Meet"));
    const other = await a.as.mutation(api.apps.createWeb, web("Wiki", { url: "https://wiki.example.com" }));
    expect((await v.as.query(api.apps.get, { appId: app })).denials30d).toEqual([]); // nothing reported yet

    await seedDay(t, orgId, dayAgo(1), [{ appId: app, kind: "microphone", count: 20 }, { appId: app, kind: "camera", count: 5 }, { appId: other, kind: "microphone", count: 999 }]);
    await seedDay(t, orgId, dayAgo(2), [{ appId: app, kind: "microphone", count: 21 }, { appId: app, kind: "geolocation", count: 1 }]);
    await seedDay(t, orgId, dayAgo(29), [{ appId: app, kind: "camera", count: 7 }]); // the oldest day still inside the window
    await seedDay(t, orgId, dayAgo(30), [{ appId: app, kind: "camera", count: 1000 }]); // outside it
    // another organization's row naming the same id string is never read
    const foreign = await makeOrg(t, "Other");
    await seedDay(t, foreign, dayAgo(1), [{ appId: app, kind: "printing", count: 5000 }]);

    expect((await v.as.query(api.apps.get, { appId: app })).denials30d).toEqual([
      { kind: "microphone", count: 41 },
      { kind: "camera", count: 12 },
      { kind: "geolocation", count: 1 },
    ]);
    expect((await v.as.query(api.apps.get, { appId: other })).denials30d).toEqual([{ kind: "microphone", count: 999 }]);
  });

  test("a program has none; the query reads at most 30 daily rows however many days exist", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const program = await a.as.mutation(api.apps.createDesktop, desktop("Acme"));
    const app = await a.as.mutation(api.apps.createWeb, web("Meet"));
    await seedDay(t, orgId, dayAgo(1), [{ appId: program, kind: "camera", count: 3 }]);
    expect((await a.as.query(api.apps.get, { appId: program })).denials30d).toEqual([]);
    for (let i = 2; i < 80; i++) await seedDay(t, orgId, dayAgo(i), [{ appId: app, kind: "camera", count: 1 }]);
    const { result, io } = await probe(() => a.as.query(api.apps.get, { appId: app }));
    expect(result.denials30d).toEqual([{ kind: "camera", count: 28 }]); // days 2..29
    expect(io.tables.has("orgSecurityDaily")).toBe(true);
    expect(io.reads).toBeLessThan(3 + 1 + 1 + 1 + 30 + 10); // wrapper, app, groups, the 30 rows, small change
  });
});
