import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice, probe } from "../tests/convex/devices";
import { asMember, expectCode, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auditPolicy } from "./lib/audit";

// Phase 6 Step 10 (plan 4.4, 4.16): versions and update modes on the server. The vendor feed itself is Step 12; here the
// rows it will read are kept in step with the app, `previous` is the server's field, and a device never learns a feed.

beforeEach(() => {
  auditPolicy.strict = true;
});
afterEach(() => {
  auditPolicy.strict = false;
  vi.useRealTimers();
});

async function admin(t: T, orgId: Id<"organizations">) {
  const m = await asMember(t, { role: "admin", orgId });
  await giveStepUp(t, m);
  return m;
}

const FEED = { kind: "tauri" as const, url: "https://updates.example.com/latest.json", pubkey: "RWTestKeyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", target: "windows-x86_64-nsis" };
const V1 = { kind: "msi" as const, url: "https://downloads.example.com/a1.msi", sha256: "ab".repeat(32), sizeBytes: 1000, silentArgs: [], successExitCodes: [0], removeWhenUnassigned: true };
const V2 = { ...V1, url: "https://downloads.example.com/a2.msi", sha256: "cd".repeat(32), sizeBytes: 2000 };
const V3 = { ...V1, url: "https://downloads.example.com/a3.msi", sha256: "ef".repeat(32), sizeBytes: 3000 };

type Over = Record<string, unknown>;
const program = (over: Over = {}) => ({
  source: "msi" as const,
  exe: "{ProgramFiles}\\Acme\\acme.exe",
  args: [],
  fileArgTemplate: [],
  resetFolders: [],
  install: V1,
  ...over,
});
const app = (name: string, over: Over = {}) => ({ name, desktop: program(over) });
const managed = (over: Over = {}, update: Over = {}) => app("Acme", { version: "1.0.0", update: { mode: "managed", feed: FEED, ...update }, ...over });

/** The refusal's data (`code`, `field`, `detail`), or null when the call succeeded. */
async function refusal(p: Promise<unknown>): Promise<{ code: string; field?: string; detail?: string } | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as { data: { code: string; field?: string; detail?: string } }).data;
  }
}

const rowOf = (t: T, id: Id<"apps">) => t.run((ctx) => ctx.db.get(id));
const feedRows = (t: T, id: Id<"apps">) => t.run((ctx) => ctx.db.query("appFeeds").withIndex("by_app", (q) => q.eq("appId", id)).take(5));

async function setup() {
  const t = await setupAuth();
  const orgId = await makeOrg(t);
  const a = await admin(t, orgId);
  return { t, orgId, a };
}

/** `apps:update` with the current revision of the app. */
async function save(s: Awaited<ReturnType<typeof setup>>, id: Id<"apps">, name: string, desktop: Over) {
  const cur = (await rowOf(s.t, id))!;
  return await s.a.as.mutation(api.apps.update, { appId: id, expectedRevision: cur.revision, desktop: { name, desktop: desktop as never } });
}

describe("update modes: the refusals of plan 4.4", () => {
  test("Vendor needs a publisher; a Windows signer needs a product; minVersion must be ordered and not above the bootstrap", async () => {
    const { a } = await setup();
    const create = (over: Over) => refusal(a.as.mutation(api.apps.createDesktop, app("Acme", over)));
    expect(await create({ update: { mode: "vendor" } })).toMatchObject({ code: "invalid_argument", field: "update.publisher", detail: "vendor_mode_needs_publisher" });
    expect(await create({ update: { mode: "vendor", publisher: "  " } })).toMatchObject({ detail: "vendor_mode_needs_publisher" });
    expect(await create({ update: { mode: "vendor", publisher: "Microsoft Corporation" } })).toMatchObject({ field: "update.publisher", detail: "publisher_too_broad" });
    expect(await create({ update: { mode: "vendor", publisher: "CN=Microsoft Windows, O=Microsoft Corporation, C=US" } })).toMatchObject({ detail: "publisher_too_broad" });
    // The same subject is fine with a product.
    expect(await create({ update: { mode: "vendor", publisher: "Microsoft Corporation", publisherProduct: "Microsoft Teams" } })).toBeNull();
    // minVersion: an installer, an ordered version and a bootstrap that delivers it.
    const vendor = (minVersion: string) => ({ version: "1.0.0", update: { mode: "vendor", publisher: "Acme Inc", minVersion } });
    expect(await create(vendor("2.0.0"))).toMatchObject({ field: "update.minVersion", detail: "min_above_bootstrap" });
    expect(await create(vendor("latest"))).toMatchObject({ field: "update.minVersion", detail: "version_not_ordered" });
    expect(await create({ update: vendor("1.0.0").update })).toMatchObject({ field: "version", detail: "version_not_ordered" }); // no bootstrap version
    expect(await create({ ...vendor("1.0.0"), version: "v1" })).toMatchObject({ field: "version", detail: "version_not_ordered" });
    expect(await create(vendor("1.0.0"))).toBeNull();
    expect(await create(vendor("0.9"))).toBeNull();
  });

  test("Managed needs an installer and an ordered version; a feed address must be https; the form's mistakes name the field", async () => {
    const { a } = await setup();
    const create = (over: Over) => refusal(a.as.mutation(api.apps.createDesktop, app("Acme", over)));
    expect(await create({ version: "v1", update: { mode: "managed" } })).toMatchObject({ field: "version", detail: "version_not_ordered" });
    expect(await create({ update: { mode: "managed" } })).toMatchObject({ field: "version", detail: "version_not_ordered" });
    expect(await create({ source: "preinstalled", install: undefined, version: "1.0.0", update: { mode: "managed" } })).toMatchObject({ code: "invalid_argument", field: "update.mode" });
    expect(await create({ version: "1.0.0", update: { mode: "managed", feed: { ...FEED, url: "http://updates.example.com/latest.json" } } })).toMatchObject({ field: "update.feed.url" });
    expect(await create({ version: "1.0.0", update: { mode: "managed", feed: { ...FEED, pubkey: "short" } } })).toMatchObject({ field: "update.feed.pubkey" });
    expect(await create({ version: "1.0.0", update: { mode: "managed", feed: { ...FEED, target: "Windows x64" } } })).toMatchObject({ field: "update.feed.target" });
    expect(await create({ version: "1".repeat(41) })).toMatchObject({ code: "invalid_argument", field: "version" });
    // Without a feed (versions published by hand) it is allowed.
    expect(await create({ version: "1.0.0", update: { mode: "managed" } })).toBeNull();
  });

  test("the same refusals hold in apps:update, and a refused save changes nothing", async () => {
    const s = await setup();
    const id = await s.a.as.mutation(api.apps.createDesktop, app("Acme", { version: "1.0.0" }));
    const before = await rowOf(s.t, id);
    const out = await refusal(save(s, id, "Acme", program({ update: { mode: "vendor" } })));
    expect(out).toMatchObject({ code: "invalid_argument", detail: "vendor_mode_needs_publisher" });
    expect(await rowOf(s.t, id)).toEqual(before);
  });

  test("Chrome and Edge are always Vendor, with the vendor's publisher and product unless the admin gave one", async () => {
    const { a, t } = await setup();
    const chrome = await a.as.mutation(api.apps.createDesktop, app("Chrome", { exe: "{ProgramFiles}\\Google\\Chrome\\Application\\Chrome.EXE", update: { mode: "pinned" } }));
    expect((await rowOf(t, chrome))?.desktop?.update).toEqual({ mode: "vendor", publisher: "Google LLC", publisherProduct: "Google Chrome" });
    const edge = await a.as.mutation(api.apps.createDesktop, app("Edge", { exe: "{ProgramFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe" }));
    expect((await rowOf(t, edge))?.desktop?.update).toEqual({ mode: "vendor", publisher: "Microsoft Corporation", publisherProduct: "Microsoft Edge" });
    const own = await a.as.mutation(api.apps.createDesktop, app("Chrome 2", { exe: "{ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe", version: "1", update: { mode: "managed", publisher: "Google LLC" } }));
    expect((await rowOf(t, own))?.desktop?.update).toEqual({ mode: "vendor", publisher: "Google LLC" });
  });

  test("Pinned stores no update block, only display text for the version; versions of the old shape are untouched", async () => {
    const { a, t } = await setup();
    const id = await a.as.mutation(api.apps.createDesktop, app("Acme", { version: "build-7+x", update: { mode: "pinned", publisher: "Acme Inc", feed: FEED } }));
    const d = (await rowOf(t, id))?.desktop;
    expect(d?.version).toBe("build-7+x");
    expect(d?.update).toBeUndefined();
    const plain = await a.as.mutation(api.apps.createDesktop, app("Plain"));
    const p = (await rowOf(t, plain))?.desktop;
    expect(p).not.toHaveProperty("version");
    expect(p).not.toHaveProperty("update");
    expect(p).not.toHaveProperty("previous");
  });
});

describe("previous is the server's field", () => {
  test("a client-sent previous is ignored on create and on update", async () => {
    const s = await setup();
    const sent = { version: "0.1.0", url: "https://evil.example.com/x.msi", sha256: "11".repeat(32), sizeBytes: 5 };
    const id = await s.a.as.mutation(api.apps.createDesktop, managed({ previous: sent }));
    expect((await rowOf(s.t, id))?.desktop?.previous).toBeUndefined();
    // Same installer: nothing was stored, the sent one is still ignored.
    await save(s, id, "Acme", managed({ previous: sent }).desktop);
    expect((await rowOf(s.t, id))?.desktop?.previous).toBeUndefined();
    // A new installer: the OLD coordinates become previous, whatever the form said.
    await save(s, id, "Acme", managed({ version: "1.1.0", install: V2, previous: sent }).desktop);
    expect((await rowOf(s.t, id))?.desktop?.previous).toEqual({ version: "1.0.0", url: V1.url, sha256: V1.sha256, sizeBytes: V1.sizeBytes });
    // Another edit that keeps the installer keeps previous (and a client value does not replace it).
    await save(s, id, "Acme", managed({ version: "1.1.0", install: V2, args: ["/quiet"], previous: sent }).desktop);
    expect((await rowOf(s.t, id))?.desktop?.previous?.sha256).toBe(V1.sha256);
    // The next version moves the window one step: previous is now 1.1.0.
    await save(s, id, "Acme", managed({ version: "1.2.0", install: V3 }).desktop);
    expect((await rowOf(s.t, id))?.desktop?.previous).toEqual({ version: "1.1.0", url: V2.url, sha256: V2.sha256, sizeBytes: V2.sizeBytes });
  });

  test("leaving Managed drops previous; an old version that is not ordered, or missing, is never kept", async () => {
    const s = await setup();
    const id = await s.a.as.mutation(api.apps.createDesktop, managed());
    await save(s, id, "Acme", managed({ version: "1.1.0", install: V2 }).desktop);
    expect((await rowOf(s.t, id))?.desktop?.previous).toBeDefined();
    await save(s, id, "Acme", program({ version: "1.1.0", install: V2 }));
    expect((await rowOf(s.t, id))?.desktop).not.toHaveProperty("previous");

    const pinned = await s.a.as.mutation(api.apps.createDesktop, app("Display", { version: "release candidate".replace(" ", "-") }));
    await save(s, pinned, "Display", managed({ version: "2.0.0", install: V2 }).desktop);
    expect((await rowOf(s.t, pinned))?.desktop).not.toHaveProperty("previous"); // "release-candidate" cannot be rolled back to
    const bare = await s.a.as.mutation(api.apps.createDesktop, app("Bare"));
    await save(s, bare, "Bare", managed({ version: "2.0.0", install: V2 }).desktop);
    expect((await rowOf(s.t, bare))?.desktop).not.toHaveProperty("previous");
  });
});

describe("apps:rollbackVersion", () => {
  test("swaps the installers and versions, takes a new revision, tells the feed not to publish the version it left, and swaps back", async () => {
    const s = await setup();
    const id = await s.a.as.mutation(api.apps.createDesktop, managed());
    await save(s, id, "Acme", managed({ version: "1.1.0", install: V2 }).desktop);
    const before = (await rowOf(s.t, id))!;
    const { revision } = await s.a.as.mutation(api.apps.rollbackVersion, { appId: id, expectedRevision: before.revision });
    const rolled = (await rowOf(s.t, id))!;
    expect(revision).toBe(before.revision + 1);
    expect(rolled.revision).toBe(revision);
    expect(rolled.desktop?.version).toBe("1.0.0");
    expect(rolled.desktop?.install).toEqual(V1);
    expect(rolled.desktop?.previous).toEqual({ version: "1.1.0", url: V2.url, sha256: V2.sha256, sizeBytes: V2.sizeBytes });
    expect(rolled.desktop?.update).toEqual(before.desktop?.update);
    expect((await feedRows(s.t, id))[0]?.seenVersion).toBe("1.1.0");
    const audit = await s.t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", s.orgId)).take(50));
    expect(audit.filter((r) => r.action === "app.updated").map((r) => r.summary)).toContain("Rolled back Acme from 1.1.0 to 1.0.0");
    // Again: forward to 1.1.0 (the admin may change their mind).
    await s.a.as.mutation(api.apps.rollbackVersion, { appId: id, expectedRevision: revision });
    expect((await rowOf(s.t, id))?.desktop?.version).toBe("1.1.0");
    expect((await rowOf(s.t, id))?.desktop?.install).toEqual(V2);
  });

  test("refused: no older version, a stale revision, a website, an app that is not Managed; nothing is written", async () => {
    const s = await setup();
    const id = await s.a.as.mutation(api.apps.createDesktop, managed());
    const row = (await rowOf(s.t, id))!;
    expect(await refusal(s.a.as.mutation(api.apps.rollbackVersion, { appId: id, expectedRevision: row.revision }))).toMatchObject({ code: "invalid_argument", field: "previous" });
    await save(s, id, "Acme", managed({ version: "1.1.0", install: V2 }).desktop);
    await expectCode(s.a.as.mutation(api.apps.rollbackVersion, { appId: id, expectedRevision: row.revision }), "stale_edit");
    const web = await s.a.as.mutation(api.apps.createWeb, { name: "Docs", url: "https://example.com", allowedDomains: [] });
    expect(await refusal(s.a.as.mutation(api.apps.rollbackVersion, { appId: web, expectedRevision: 0 }))).toMatchObject({ code: "invalid_argument", field: "appId" });
    const pinned = await s.a.as.mutation(api.apps.createDesktop, app("Pinned"));
    expect(await refusal(s.a.as.mutation(api.apps.rollbackVersion, { appId: pinned, expectedRevision: 0 }))).toMatchObject({ field: "appId" });
    const { io } = await probe(() => refusal(s.a.as.mutation(api.apps.rollbackVersion, { appId: pinned, expectedRevision: 0 })));
    expect(io.writes).toBe(0);
  });

  test("a viewer cannot roll back; another organization gets not_found", async () => {
    const s = await setup();
    const id = await s.a.as.mutation(api.apps.createDesktop, managed());
    const viewer = await asMember(s.t, { role: "viewer", orgId: s.orgId });
    await expectCode(viewer.as.mutation(api.apps.rollbackVersion, { appId: id, expectedRevision: 0 }), "forbidden");
    const foreign = await admin(s.t, await makeOrg(s.t, "Other"));
    await expectCode(foreign.as.mutation(api.apps.rollbackVersion, { appId: id, expectedRevision: 0 }), "not_found");
  });
});

describe("appFeeds follows the app (same mutation)", () => {
  test("created with a feed (due now), none without one, reset when the feed changes, untouched by other edits, deleted when the mode or feed goes", async () => {
    const s = await setup();
    const none = await s.a.as.mutation(api.apps.createDesktop, managed({}, { feed: undefined }));
    expect(await feedRows(s.t, none)).toEqual([]);
    const pinned = await s.a.as.mutation(api.apps.createDesktop, app("Pinned"));
    expect(await feedRows(s.t, pinned)).toEqual([]);

    const before = Date.now();
    const id = await s.a.as.mutation(api.apps.createDesktop, managed());
    const [row] = await feedRows(s.t, id);
    expect(row).toMatchObject({ orgId: s.orgId, appId: id, status: "ok", failures: 0, revision: 0 });
    expect(row!.nextCheckAt).toBeGreaterThanOrEqual(before);
    expect(row!.nextCheckAt).toBeLessThanOrEqual(Date.now());

    // Something the resolver would have stored, then an edit that does not touch the feed settings.
    await s.t.run((ctx) => ctx.db.patch(row!._id, { status: "unreachable", failures: 2, etag: "W/1", seenVersion: "1.0.0", lastCheckedAt: 5, nextCheckAt: 99 }));
    const stored = (await feedRows(s.t, id))[0];
    await save(s, id, "Acme renamed", managed({ args: ["/x"] }, { autoPublish: false, applyWhen: "when_closed" }).desktop);
    expect((await feedRows(s.t, id))[0]).toEqual(stored);

    // The feed itself changes: reset, and the revision lets a check that started earlier know.
    await save(s, id, "Acme renamed", managed({ args: ["/x"] }, { feed: { ...FEED, url: "https://updates.example.com/other.json" } }).desktop);
    const reset = (await feedRows(s.t, id))[0]!;
    expect(reset).toMatchObject({ status: "ok", failures: 0, revision: 1 });
    expect(reset.etag).toBeUndefined();
    expect(reset.seenVersion).toBeUndefined();
    expect(reset.lastCheckedAt).toBeUndefined();
    expect(reset.nextCheckAt).toBeGreaterThan(99);
    expect(await feedRows(s.t, id)).toHaveLength(1);

    // A feed added to a Managed app without one; removed again.
    await save(s, none, "Acme", managed({}, {}).desktop);
    expect(await feedRows(s.t, none)).toHaveLength(1);
    await save(s, none, "Acme", managed({}, { feed: undefined }).desktop);
    expect(await feedRows(s.t, none)).toEqual([]);

    // Leaving Managed deletes the row.
    await save(s, id, "Acme renamed", program({ version: "1.0.0" }));
    expect(await feedRows(s.t, id)).toEqual([]);
  });

  test("a Pinned edit reads no appFeeds row; a Managed one reads it and an unchanged feed writes nothing to it", async () => {
    const s = await setup();
    const pinned = await s.a.as.mutation(api.apps.createDesktop, app("Pinned"));
    const cur = (await rowOf(s.t, pinned))!;
    const out = await probe(() => s.a.as.mutation(api.apps.update, { appId: pinned, expectedRevision: cur.revision, desktop: { name: "Pinned 2", desktop: program() } }));
    expect(out.io.tables.has("appFeeds")).toBe(false);

    const id = await s.a.as.mutation(api.apps.createDesktop, managed());
    const m = (await rowOf(s.t, id))!;
    const again = await probe(() => s.a.as.mutation(api.apps.update, { appId: id, expectedRevision: m.revision, desktop: { name: "Acme 2", desktop: managed().desktop as never } }));
    expect(again.io.tables.has("appFeeds")).toBe(true);
    // The same feed: the row is read to compare, and the only writes are the app, the audit record and the publish bookkeeping.
    expect((await feedRows(s.t, id))[0]).toMatchObject({ revision: 0, status: "ok" });
  });

  test("an update that changes nothing writes nothing", async () => {
    const s = await setup();
    const id = await s.a.as.mutation(api.apps.createDesktop, managed());
    const cur = (await rowOf(s.t, id))!;
    const same = await probe(() => s.a.as.mutation(api.apps.update, { appId: id, expectedRevision: cur.revision, desktop: managed() as never }));
    expect(same.io.writes).toBe(0);
    expect((await rowOf(s.t, id))?.revision).toBe(cur.revision);
  });

  test("apps:remove deletes the row with the app", async () => {
    const s = await setup();
    const id = await s.a.as.mutation(api.apps.createDesktop, managed());
    expect(await feedRows(s.t, id)).toHaveLength(1);
    await s.a.as.mutation(api.apps.setArchived, { appId: id, archived: true });
    expect(await feedRows(s.t, id)).toHaveLength(1); // archiving keeps it (the resolver, Step 12, skips archived apps)
    await s.a.as.mutation(api.apps.remove, { appId: id });
    expect(await feedRows(s.t, id)).toEqual([]);
    expect(await s.t.run((ctx) => ctx.db.query("appFeeds").take(10))).toEqual([]);
  });
});

describe("apps:get feedStatus and the installed version", () => {
  test("a Managed app with a feed answers its status without the address, key, hash or etag; others have none; every role reads it", async () => {
    const s = await setup();
    const id = await s.a.as.mutation(api.apps.createDesktop, managed());
    const [row] = await feedRows(s.t, id);
    await s.t.run((ctx) =>
      ctx.db.patch(row!._id, {
        status: "bad_signature",
        failures: 3,
        lastCheckedAt: 1234,
        etag: "W/secret-etag",
        seenVersion: "1.2.0",
        pending: { version: "1.3.0", url: "https://cdn.example.com/a.msi", sha256: "99".repeat(32), sizeBytes: 9, foundAt: 4321 },
      }),
    );
    const viewer = await asMember(s.t, { role: "viewer", orgId: s.orgId });
    const got = await viewer.as.query(api.apps.get, { appId: id });
    expect(got.feedStatus).toEqual({ status: "bad_signature", failures: 3, lastCheckedAt: 1234, seenVersion: "1.2.0", pending: { version: "1.3.0", foundAt: 4321 } });
    const text = JSON.stringify(got.feedStatus);
    for (const secret of ["secret-etag", "cdn.example.com", "9999"]) expect(text).not.toContain(secret);
    expect(got.desktop?.update?.mode).toBe("managed");
    expect(got.desktop?.version).toBe("1.0.0");

    const fresh = await s.a.as.mutation(api.apps.createDesktop, managed({ version: "2.0.0" }));
    expect((await s.a.as.query(api.apps.get, { appId: fresh })).feedStatus).toMatchObject({ status: "ok", failures: 0 });
    const pinned = await s.a.as.mutation(api.apps.createDesktop, app("Pinned"));
    const p = await probe(() => s.a.as.query(api.apps.get, { appId: pinned }));
    expect(p.result.feedStatus).toBeUndefined();
    expect(p.io.tables.has("appFeeds")).toBe(false); // no feed, no read
    const foreign = await asMember(s.t, { role: "viewer", orgId: await makeOrg(s.t, "Other") });
    await expectCode(foreign.as.query(api.apps.get, { appId: id }), "not_found");
  });

  test("apps:installs returns the installed version of each PC", async () => {
    const s = await setup();
    const id = await s.a.as.mutation(api.apps.createDesktop, managed());
    const groupId = await s.t.run((ctx) => ctx.db.insert("groups", { orgId: s.orgId, name: "Floor", revision: 0, createdAt: 0 }));
    const { deviceId } = await enrollDevice(s.t, s.orgId, { groupId });
    await s.t.run(async (ctx) => {
      await ctx.db.insert("appAssignments", { orgId: s.orgId, groupId, appId: id, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
      await ctx.db.insert("installResults", { orgId: s.orgId, deviceId, appId: id, groupId, state: "installed", appRevision: 0, attempts: 1, updatedAt: 5, installedVersion: "1.0.4" });
    });
    const page = await s.a.as.query(api.apps.installs, { appId: id, state: "installed", paginationOpts: { numItems: 10, cursor: null } });
    expect(page.page.map((r) => r.installedVersion)).toEqual(["1.0.4"]);
  });
});

describe("a device never learns a feed", () => {
  test("the signed document carries version and the device's view of update, never feed, key, autoPublish or previous", async () => {
    vi.useFakeTimers();
    const s = await setup();
    const drain = () => s.t.finishAllScheduledFunctions(vi.runAllTimers);
    const groupId = await s.t.run((ctx) => ctx.db.insert("groups", { orgId: s.orgId, name: "Front", revision: 0, createdAt: Date.now() }));
    const { deviceId } = await enrollDevice(s.t, s.orgId, { groupId });
    await drain();
    const id = await s.a.as.mutation(api.apps.createDesktop, managed({}, { autoPublish: false, applyWhen: "when_closed", rollbackOnFail: false }));
    await save(s, id, "Acme", managed({ version: "1.1.0", install: V2 }, { autoPublish: false, applyWhen: "when_closed", rollbackOnFail: false }).desktop);
    expect((await rowOf(s.t, id))?.desktop?.previous).toBeDefined(); // the server has it...
    await s.a.as.mutation(api.groups.assignApp, { groupId, appId: id, audience: "everyone", pinnedTaskbar: true, pinnedDesktop: false });
    await drain();

    const head = await s.t.run((ctx) => ctx.db.query("desiredHeads").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique());
    const body = await s.t.run((ctx) => ctx.db.get(head!.bodyId));
    const payload = body!.payload;
    const doc = (JSON.parse(payload) as { doc: { catalog: { id: string; desktop: Record<string, unknown> | null }[] } }).doc;
    const entry = doc.catalog.find((c) => c.id === id)!;
    expect(entry.desktop).toMatchObject({ version: "1.1.0", update: { mode: "managed", applyWhen: "when_closed", rollbackOnFail: false } });
    expect(entry.desktop).not.toHaveProperty("previous");
    expect(Object.keys(entry.desktop!.update as object).sort()).toEqual(["applyWhen", "mode", "rollbackOnFail"]);
    for (const secret of [FEED.url, FEED.pubkey, "autoPublish", "latest.json", V1.sha256, V1.url]) expect(payload, secret).not.toContain(secret);
    expect(payload).toContain(V2.sha256); // the current installer is in the document
  });
});
