import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice, probe } from "../tests/convex/devices";
import { asMember, expectCode, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { VECTOR_INPUT } from "../tests/convex/vectors";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auditPolicy } from "./lib/audit";
import { browserAppOf, normalizeBrowser, normalizeBrowserSites, normalizeWeb } from "./lib/appRules";
import { BrowserLimitError, buildCatalogChecked, buildDeviceDoc, checkBrowserLimits, type BuildApp, type BuildInput } from "./lib/desired";
import { DEFAULT_WEB_PERMISSIONS } from "./lib/validators";

// Phase 6 Step 16 (plan 4.9, 4.3, 4.16): browser web apps on the server. A website may open in Edge or in Chrome (a Chrome program of the
// organization); the catalogue carries the choice, an unusable Chrome program turns it back into the built-in window with a warning, a
// device document over the browser limits is refused at publish with the group's name, and Chrome / Edge programs get their allowed sites.

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

async function setup() {
  const t = await setupAuth();
  const orgId = await makeOrg(t);
  const a = await admin(t, orgId);
  return { t, orgId, a };
}
type S = Awaited<ReturnType<typeof setup>>;

async function refusal(p: Promise<unknown>): Promise<{ code: string; field?: string; detail?: string } | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as { data: { code: string; field?: string; detail?: string } }).data;
  }
}

const CHROME_EXE = "{ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe";
const EDGE_EXE = "{ProgramFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe";
const program = (name: string, exe: string, over: Record<string, unknown> = {}) => ({
  name,
  desktop: { source: "preinstalled" as const, exe, args: [], fileArgTemplate: [], resetFolders: [], ...over },
});
const site = (name: string, over: Record<string, unknown> = {}) => ({ name, url: "https://docs.example.com", allowedDomains: [] as string[], ...over });
const rowOf = (t: T, id: Id<"apps">) => t.run((ctx) => ctx.db.get(id));

/** A Chrome program, as an admin adds it. */
const addChrome = (s: S) => s.a.as.mutation(api.apps.createDesktop, program("Chrome", CHROME_EXE));

describe("web.browser: the refusals (plan Step 16 item 1)", () => {
  test("chrome needs the id of a real, non-archived Chrome program of the same organization (browser_app_required)", async () => {
    const s = await setup();
    const create = (browser: unknown) => refusal(s.a.as.mutation(api.apps.createWeb, site("Docs", { browser })));
    const needed = { code: "invalid_argument", field: "browser", detail: "browser_app_required" };
    expect(await create({ kind: "chrome" })).toMatchObject(needed);
    expect(await create({ kind: "chrome", appId: "  " })).toMatchObject(needed);
    expect(await create({ kind: "chrome", appId: "not-an-id" })).toMatchObject(needed);

    // An app that is not Chrome: a website, another program, Edge.
    const web = await s.a.as.mutation(api.apps.createWeb, site("Other"));
    const notepad = await s.a.as.mutation(api.apps.createDesktop, program("Writer", "{ProgramFiles}\\Writer\\writer.exe"));
    const edge = await s.a.as.mutation(api.apps.createDesktop, program("Edge", EDGE_EXE));
    for (const id of [web, notepad, edge]) expect(await create({ kind: "chrome", appId: id })).toMatchObject(needed);

    // Archived, and another organization's Chrome: the same refusal (nothing is confirmed about other tenants).
    const chrome = await addChrome(s);
    expect(await create({ kind: "chrome", appId: chrome })).toBeNull();
    await s.a.as.mutation(api.apps.setArchived, { appId: chrome, archived: true });
    expect(await create({ kind: "chrome", appId: chrome })).toMatchObject(needed);
    const other = await admin(s.t, await makeOrg(s.t, "Other"));
    const foreign = await other.as.mutation(api.apps.createDesktop, program("Chrome", CHROME_EXE));
    expect(await create({ kind: "chrome", appId: foreign })).toMatchObject(needed);
  });

  test("Edge and the built-in window carry no program id; an unknown kind is refused by the validator", async () => {
    const s = await setup();
    const chrome = await addChrome(s);
    for (const kind of ["edge", "builtin"]) {
      expect(await refusal(s.a.as.mutation(api.apps.createWeb, site("Docs", { browser: { kind, appId: chrome } })))).toMatchObject({ code: "invalid_argument", field: "browser" });
    }
    await expect(s.a.as.mutation(api.apps.createWeb, site("Docs", { browser: { kind: "firefox" } }) as never)).rejects.toThrow();
  });

  test("the same refusals hold in apps:update, and a refused save changes nothing", async () => {
    const s = await setup();
    const id = await s.a.as.mutation(api.apps.createWeb, site("Docs"));
    const before = await rowOf(s.t, id);
    const out = await refusal(s.a.as.mutation(api.apps.update, { appId: id, expectedRevision: before!.revision, web: site("Docs", { browser: { kind: "chrome", appId: id } }) }));
    expect(out).toMatchObject({ code: "invalid_argument", field: "browser", detail: "browser_app_required" });
    expect(await rowOf(s.t, id)).toEqual(before);
  });

  test("a viewer cannot set it; a program has no browser choice", async () => {
    const s = await setup();
    const viewer = await asMember(s.t, { role: "viewer", orgId: s.orgId });
    await expectCode(viewer.as.mutation(api.apps.createWeb, site("Docs", { browser: { kind: "edge" } })), "forbidden");
    const id = await s.a.as.mutation(api.apps.createDesktop, program("Writer", "{ProgramFiles}\\Writer\\writer.exe"));
    const cur = (await rowOf(s.t, id))!;
    expect(await refusal(s.a.as.mutation(api.apps.update, { appId: id, expectedRevision: cur.revision, web: site("Writer") }))).toMatchObject({ code: "invalid_argument", field: "kind" });
  });
});

describe("web.browser: what is stored", () => {
  test("Built-in is no field (the row keeps its old shape), Edge is {kind}, Chrome is {kind, appId}", async () => {
    const s = await setup();
    const chrome = await addChrome(s);
    const plain = await s.a.as.mutation(api.apps.createWeb, site("Plain"));
    const builtin = await s.a.as.mutation(api.apps.createWeb, site("Builtin", { browser: { kind: "builtin" } }));
    const edge = await s.a.as.mutation(api.apps.createWeb, site("Edge", { browser: { kind: "edge" } }));
    const viaChrome = await s.a.as.mutation(api.apps.createWeb, site("Chrome", { browser: { kind: "chrome", appId: chrome } }));
    expect((await rowOf(s.t, plain))!.web).not.toHaveProperty("browser");
    expect((await rowOf(s.t, builtin))!.web).not.toHaveProperty("browser");
    expect((await rowOf(s.t, edge))!.web!.browser).toEqual({ kind: "edge" });
    expect((await rowOf(s.t, viaChrome))!.web!.browser).toEqual({ kind: "chrome", appId: chrome });
  });

  test("apps:update changes the choice both ways, writes nothing for the same one, and keeps the permissions", async () => {
    const s = await setup();
    const chrome = await addChrome(s);
    const id = await s.a.as.mutation(api.apps.createWeb, site("Docs"));
    const perms = { ...DEFAULT_WEB_PERMISSIONS, camera: true };
    const rev = async () => (await rowOf(s.t, id))!.revision;
    await s.a.as.mutation(api.apps.setPermissions, { appId: id, expectedRevision: await rev(), permissions: perms });

    await s.a.as.mutation(api.apps.update, { appId: id, expectedRevision: await rev(), web: site("Docs", { browser: { kind: "chrome", appId: chrome } }) });
    expect((await rowOf(s.t, id))!.web).toMatchObject({ browser: { kind: "chrome", appId: chrome }, permissions: perms });
    // Same choice again: no write and no new revision.
    const r1 = await rev();
    const same = await probe(() => s.a.as.mutation(api.apps.update, { appId: id, expectedRevision: r1, web: site("Docs", { browser: { kind: "chrome", appId: chrome } }) }));
    expect(same.io.writes).toBe(0);
    expect(await rev()).toBe(r1);
    // The permissions switch does not drop the choice.
    await s.a.as.mutation(api.apps.setPermissions, { appId: id, expectedRevision: r1, permissions: DEFAULT_WEB_PERMISSIONS });
    expect((await rowOf(s.t, id))!.web!.browser).toEqual({ kind: "chrome", appId: chrome });

    await s.a.as.mutation(api.apps.update, { appId: id, expectedRevision: await rev(), web: site("Docs", { browser: { kind: "edge" } }) });
    expect((await rowOf(s.t, id))!.web!.browser).toEqual({ kind: "edge" });
    await s.a.as.mutation(api.apps.update, { appId: id, expectedRevision: await rev(), web: site("Docs") });
    expect((await rowOf(s.t, id))!.web).not.toHaveProperty("browser");
  });

  test("a save of something else still works after the Chrome program was archived; only a CHANGED choice is checked", async () => {
    const s = await setup();
    const chrome = await addChrome(s);
    const id = await s.a.as.mutation(api.apps.createWeb, site("Docs", { browser: { kind: "chrome", appId: chrome } }));
    await s.a.as.mutation(api.apps.setArchived, { appId: chrome, archived: true });
    const cur = (await rowOf(s.t, id))!;
    await s.a.as.mutation(api.apps.update, { appId: id, expectedRevision: cur.revision, web: site("Docs renamed", { browser: { kind: "chrome", appId: chrome } }) });
    expect((await rowOf(s.t, id))!.name).toBe("Docs renamed");
    // Picking the archived program again for another app is refused.
    expect(await refusal(s.a.as.mutation(api.apps.createWeb, site("New", { browser: { kind: "chrome", appId: chrome } })))).toMatchObject({ detail: "browser_app_required" });
  });

  test("the Chrome program is read once when the choice is Chrome, and not at all otherwise", async () => {
    const s = await setup();
    const chrome = await addChrome(s);
    const edge = await probe(() => s.a.as.mutation(api.apps.createWeb, site("Edge", { browser: { kind: "edge" } })));
    const builtin = await probe(() => s.a.as.mutation(api.apps.createWeb, site("Builtin")));
    const viaChrome = await probe(() => s.a.as.mutation(api.apps.createWeb, site("Chrome", { browser: { kind: "chrome", appId: chrome } })));
    expect(viaChrome.io.reads - builtin.io.reads).toBe(1);
    expect(edge.io.reads).toBe(builtin.io.reads);
  });
});

describe("pure rules: normalizeBrowser, normalizeWeb, browser sites", () => {
  test("normalizeBrowser", () => {
    expect(normalizeBrowser(undefined)).toBeUndefined();
    expect(normalizeBrowser({ kind: "builtin" })).toBeUndefined();
    expect(normalizeBrowser({ kind: "edge" })).toEqual({ kind: "edge" });
    expect(normalizeBrowser({ kind: "chrome", appId: " x1 " })).toEqual({ kind: "chrome", appId: "x1" });
    expect(() => normalizeBrowser({ kind: "chrome" })).toThrow();
    expect(() => normalizeBrowser({ kind: "edge", appId: "x" })).toThrow();
  });

  test("normalizeWeb adds the choice only when there is one", () => {
    expect(normalizeWeb("https://a.example.com", [])).not.toHaveProperty("browser");
    expect(normalizeWeb("https://a.example.com", [], undefined, { kind: "edge" }).browser).toEqual({ kind: "edge" });
  });

  test("browserAppOf and the sites list (plan 4.9.7)", () => {
    expect(browserAppOf("{ProgramFiles}\\Google\\Chrome\\Application\\Chrome.EXE")).toBe("chrome");
    expect(browserAppOf("{ProgramFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe")).toBe("edge");
    expect(browserAppOf("{ProgramFiles}\\Writer\\writer.exe")).toBeNull();
    expect(normalizeBrowserSites(undefined, CHROME_EXE)).toBeUndefined();
    expect(normalizeBrowserSites(["  ", ""], "{ProgramFiles}\\Writer\\writer.exe")).toBeUndefined(); // empty is "no list" for any program
    expect(normalizeBrowserSites(["b.example.com", " a.example.com ", "b.example.com", "*.c.example.com"], CHROME_EXE)).toEqual(["b.example.com", "a.example.com", "*.c.example.com"]);
    expect(() => normalizeBrowserSites(["a.example.com"], "{ProgramFiles}\\Writer\\writer.exe")).toThrow();
    expect(() => normalizeBrowserSites(["Not A Domain"], CHROME_EXE)).toThrow();
    expect(() => normalizeBrowserSites(["UPPER.example.com"], CHROME_EXE)).toThrow();
    const many = Array.from({ length: 201 }, (_, i) => `s${i}.example.com`);
    expect(() => normalizeBrowserSites(many, CHROME_EXE)).toThrow();
    expect(normalizeBrowserSites(many.slice(0, 200), CHROME_EXE)).toHaveLength(200);
  });
});

describe("Browser rules of a Chrome or Edge program (plan 4.9.7, Step 16 item 2)", () => {
  test("a browser program stores its allowed sites; a program that is not a browser is refused them", async () => {
    const s = await setup();
    const id = await s.a.as.mutation(api.apps.createDesktop, program("Chrome", CHROME_EXE, { browserSites: ["portal.example.com", "*.cdn.example.com", "portal.example.com"] }));
    const row = (await rowOf(s.t, id))!;
    expect(row.desktop!.browserSites).toEqual(["portal.example.com", "*.cdn.example.com"]);
    expect(row.desktop!.update).toMatchObject({ mode: "vendor", publisher: "Google LLC" }); // Step 10: a browser is always Vendor

    const edge = await s.a.as.mutation(api.apps.createDesktop, program("Edge", EDGE_EXE, { browserSites: ["portal.example.com"] }));
    expect((await rowOf(s.t, edge))!.desktop!.browserSites).toEqual(["portal.example.com"]);

    const refused = await refusal(s.a.as.mutation(api.apps.createDesktop, program("Writer", "{ProgramFiles}\\Writer\\writer.exe", { browserSites: ["a.example.com"] })));
    expect(refused).toMatchObject({ code: "invalid_argument", field: "browserSites", detail: "not_a_browser_app" });
    const bad = await refusal(s.a.as.mutation(api.apps.createDesktop, program("Chrome 2", CHROME_EXE, { browserSites: ["https://a.example.com/x"] })));
    expect(bad).toMatchObject({ code: "invalid_argument", field: "browserSites" });
    const tooMany = await refusal(s.a.as.mutation(api.apps.createDesktop, program("Chrome 3", CHROME_EXE, { browserSites: Array.from({ length: 201 }, (_, i) => `s${i}.example.com`) })));
    expect(tooMany).toMatchObject({ field: "browserSites" });
  });

  test("an empty list is no list; the list changes with apps:update; no list means no field", async () => {
    const s = await setup();
    const id = await s.a.as.mutation(api.apps.createDesktop, program("Chrome", CHROME_EXE, { browserSites: ["a.example.com"] }));
    const rev = async () => (await rowOf(s.t, id))!.revision;
    await s.a.as.mutation(api.apps.update, { appId: id, expectedRevision: await rev(), desktop: program("Chrome", CHROME_EXE, { browserSites: ["b.example.com"] }) });
    expect((await rowOf(s.t, id))!.desktop!.browserSites).toEqual(["b.example.com"]);
    await s.a.as.mutation(api.apps.update, { appId: id, expectedRevision: await rev(), desktop: program("Chrome", CHROME_EXE, { browserSites: [] }) });
    expect((await rowOf(s.t, id))!.desktop).not.toHaveProperty("browserSites");
  });

  test("apps:options says which programs are Chrome or Edge, with no extra read", async () => {
    const s = await setup();
    const chrome = await addChrome(s);
    const edge = await s.a.as.mutation(api.apps.createDesktop, program("Edge", EDGE_EXE));
    const writer = await s.a.as.mutation(api.apps.createDesktop, program("Writer", "{ProgramFiles}\\Writer\\writer.exe"));
    const web = await s.a.as.mutation(api.apps.createWeb, site("Docs"));
    const viewer = await asMember(s.t, { role: "viewer", orgId: s.orgId });
    const { result: options } = await probe(() => viewer.as.query(api.apps.options, {}));
    const by = (id: string) => options.find((o) => o._id === id)!;
    expect(by(chrome).browser).toBe("chrome");
    expect(by(edge).browser).toBe("edge");
    expect(by(writer)).not.toHaveProperty("browser");
    expect(by(web)).not.toHaveProperty("browser");
  });
});

describe("apps:get chromeApp", () => {
  test("names the Chrome program of a website and says whether it is usable; nothing for other apps", async () => {
    const s = await setup();
    const chrome = await addChrome(s);
    const id = await s.a.as.mutation(api.apps.createWeb, site("Docs", { browser: { kind: "chrome", appId: chrome } }));
    const viewer = await asMember(s.t, { role: "viewer", orgId: s.orgId });
    expect((await viewer.as.query(api.apps.get, { appId: id })).chromeApp).toEqual({ _id: chrome, name: "Chrome", usable: true });
    expect((await viewer.as.query(api.apps.get, { appId: id })).web!.browser).toEqual({ kind: "chrome", appId: chrome });

    await s.a.as.mutation(api.apps.setArchived, { appId: chrome, archived: true });
    expect((await viewer.as.query(api.apps.get, { appId: id })).chromeApp).toEqual({ _id: chrome, name: "Chrome", usable: false });
    // Deleted: nothing to name (the page then says it is gone).
    await s.a.as.mutation(api.apps.remove, { appId: chrome });
    expect((await viewer.as.query(api.apps.get, { appId: id })).chromeApp).toBeUndefined();

    const plain = await s.a.as.mutation(api.apps.createWeb, site("Plain"));
    const edge = await s.a.as.mutation(api.apps.createWeb, site("Edge", { browser: { kind: "edge" } }));
    const none = await probe(() => viewer.as.query(api.apps.get, { appId: plain }));
    const viaEdge = await probe(() => viewer.as.query(api.apps.get, { appId: edge }));
    expect(none.result.chromeApp).toBeUndefined();
    expect(viaEdge.result.chromeApp).toBeUndefined();
    expect(viaEdge.io.reads).toBe(none.io.reads); // Edge and the built-in window read nothing extra
  });
});

// ---------------------------------------------------------------- the catalogue (pure)

const WEB_PERMS = { ...DEFAULT_WEB_PERMISSIONS, printing: true };
type BrowserIn = NonNullable<BuildApp["web"]>["browser"];
const webApp = (id: string, browser: BrowserIn, over: Partial<BuildApp> = {}): BuildApp => ({
  _id: id,
  name: id,
  kind: "web",
  archived: false,
  revision: 1,
  web: { url: `https://${id}.example.com/`, allowedDomains: [`${id}.example.com`], permissions: WEB_PERMS, ...(browser !== undefined ? { browser } : {}) },
  ...over,
});
const desktopApp = (id: string, exe: string, over: Partial<BuildApp> = {}): BuildApp => ({
  _id: id,
  name: id,
  kind: "desktop",
  archived: false,
  revision: 1,
  desktop: { exe, args: [], fileArgTemplate: [], resetFolders: [] },
  ...over,
});
const inputOf = (apps: BuildApp[]): BuildInput => ({
  ...VECTOR_INPUT,
  apps,
  assignments: apps.map((a) => ({ appId: a._id, audience: "everyone" as const, pinnedTaskbar: false, pinnedDesktop: false })),
  employees: [],
  employeeApps: [],
  fileHandlers: [],
});
const entryOf = (catalog: { id: string; web: unknown }[], id: string) => catalog.find((c) => c.id === id)!;

describe("the catalogue carries the browser (Step 16 item 5)", () => {
  test("Edge and Chrome are in the entry, in the order of the Rust struct; the built-in window is no key", () => {
    const { catalog, warnings } = buildCatalogChecked(
      inputOf([webApp("w1", { kind: "edge" }), webApp("w2", { kind: "chrome", appId: "c1" }), webApp("w3", undefined), webApp("w4", { kind: "builtin" }), desktopApp("c1", CHROME_EXE)]),
    );
    expect(warnings).toEqual([]);
    const web = (id: string) => entryOf(catalog, id).web as Record<string, unknown>;
    expect(Object.keys(web("w1"))).toEqual(["url", "allowedDomains", "permissions", "browser"]);
    expect(web("w1").browser).toEqual({ kind: "edge" });
    expect(web("w2").browser).toEqual({ kind: "chrome", appId: "c1" });
    expect(Object.keys(web("w3"))).toEqual(["url", "allowedDomains", "permissions"]);
    expect(Object.keys(web("w4"))).toEqual(["url", "allowedDomains", "permissions"]);
    expect(JSON.stringify(buildDeviceDoc(inputOf([webApp("w3", undefined)])))).not.toContain("browser");
  });

  test("an archived, missing, unassigned or no-longer-Chrome program turns the web app back to built-in, with a warning row", () => {
    const chrome = (over: Partial<BuildApp> = {}) => desktopApp("c1", CHROME_EXE, over);
    const wants = webApp("w1", { kind: "chrome", appId: "c1" });
    const cases: [string, BuildApp[], BuildInput?][] = [
      ["archived", [wants, chrome({ archived: true })]],
      ["not in the catalogue", [wants]],
      ["no longer Chrome", [wants, desktopApp("c1", "{ProgramFiles}\\Writer\\writer.exe")]],
      ["a website's id", [wants, webApp("c1", undefined)]],
    ];
    for (const [why, apps] of cases) {
      const { catalog, warnings } = buildCatalogChecked(inputOf(apps));
      expect(warnings, why).toEqual([{ appId: "w1", code: "browser_app_unavailable" }]);
      expect(entryOf(catalog, "w1").web, why).not.toHaveProperty("browser");
    }
    // Assigned in the group's catalogue only through the assignment list: a Chrome program the group does not assign is "not in the catalogue".
    const apart = inputOf([wants, chrome()]);
    const withoutChrome = { ...apart, assignments: apart.assignments.filter((a) => a.appId !== "c1") };
    expect(buildCatalogChecked(withoutChrome).warnings).toHaveLength(1);
    // Edge never needs a program.
    expect(buildCatalogChecked(inputOf([webApp("w2", { kind: "edge" })])).warnings).toEqual([]);
  });

  test("an unchanged built-in catalogue has no warnings and the same bytes as before the field existed", () => {
    expect(buildCatalogChecked(VECTOR_INPUT).warnings).toEqual([]);
  });
});

describe("the allowed sites of a browser program reach the device (Step 17)", () => {
  const withSites = (id: string, exe: string, sites?: string[]): BuildApp => {
    const a = desktopApp(id, exe);
    return { ...a, desktop: { ...a.desktop!, ...(sites !== undefined ? { browserSites: sites } : {}) } };
  };
  const desktopOf = (catalog: { id: string }[], id: string) => (catalog.find((c) => c.id === id) as unknown as { desktop: Record<string, unknown> }).desktop;

  test("browserSites is a key of the desktop spec after resetFolders; absent or empty leaves it out", () => {
    const { catalog } = buildCatalogChecked(
      inputOf([withSites("c1", CHROME_EXE, ["portal.example.com", "*.cdn.example.com"]), withSites("c2", EDGE_EXE, []), withSites("c3", CHROME_EXE)]),
    );
    expect(desktopOf(catalog, "c1").browserSites).toEqual(["portal.example.com", "*.cdn.example.com"]);
    expect(Object.keys(desktopOf(catalog, "c1")).slice(-2)).toEqual(["resetFolders", "browserSites"]);
    expect(desktopOf(catalog, "c2")).not.toHaveProperty("browserSites");
    expect(desktopOf(catalog, "c3")).not.toHaveProperty("browserSites");
  });

  test("the sites count in the 800 patterns of the device, once per distinct site", () => {
    const sites = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}.example.com`);
    const catalogOf = (apps: BuildApp[]) => buildCatalogChecked(inputOf(apps)).catalog;
    const edge = webApp("e1", { kind: "edge" }, { web: { url: "https://start.example.com/", allowedDomains: sites(599, "d"), permissions: WEB_PERMS, browser: { kind: "edge" } } });
    // 200 sites + 599 domains + the start host = 800.
    expect(() => checkBrowserLimits(catalogOf([edge, withSites("c1", CHROME_EXE, sites(200, "s"))]))).not.toThrow();
    expect(() => checkBrowserLimits(catalogOf([edge, withSites("c1", CHROME_EXE, sites(200, "s")), withSites("c2", EDGE_EXE, ["one-more.example.com"])]))).toThrowError(
      expect.objectContaining({ limit: "too_many_browser_urls" }),
    );
    // The same sites on a second program add nothing.
    expect(() => checkBrowserLimits(catalogOf([edge, withSites("c1", CHROME_EXE, sites(200, "s")), withSites("c2", EDGE_EXE, sites(200, "S"))]))).not.toThrow();
  });
});

describe("the per-device browser limits (Step 16 item 3, plan 4.3)", () => {
  const edgeApp = (i: number, domains: string[]): BuildApp => {
    const a = webApp(`e${i}`, { kind: "edge" });
    return { ...a, web: { ...a.web!, allowedDomains: domains } };
  };
  const catalogOf = (apps: BuildApp[]) => buildCatalogChecked(inputOf(apps)).catalog;

  test("800 distinct patterns pass, 801 do not; the same domain in two apps counts once; built-in apps count for nothing", () => {
    // 40 apps x 20 domains = 800 domains, whose start hosts are among them.
    const apps = Array.from({ length: 40 }, (_, i) => edgeApp(i, Array.from({ length: 20 }, (_, j) => (j === 0 ? `e${i}.example.com` : `d${i}-${j}.example.com`))));
    expect(() => checkBrowserLimits(catalogOf(apps))).not.toThrow();
    const over = [...apps, edgeApp(99, ["extra.example.com"])];
    expect(() => checkBrowserLimits(catalogOf(over))).toThrowError(expect.objectContaining({ limit: "too_many_browser_urls" }));
    // The same domains again do not add patterns.
    const dup = [...apps, { ...edgeApp(98, apps[0]!.web!.allowedDomains), web: { ...apps[0]!.web!, url: "https://e0.example.com/", browser: { kind: "edge" as const } } }];
    expect(() => checkBrowserLimits(catalogOf(dup))).not.toThrow();
    // Built-in web apps are not counted at all.
    const builtin = Array.from({ length: 100 }, (_, i) => ({ ...webApp(`b${i}`, undefined), web: { ...webApp(`b${i}`, undefined).web!, allowedDomains: Array.from({ length: 20 }, (_, j) => `b${i}-${j}.example.com`) } }));
    expect(() => checkBrowserLimits(catalogOf(builtin))).not.toThrow();
  });

  test("61 browser web apps are too many", () => {
    expect(() => checkBrowserLimits(catalogOf(Array.from({ length: 60 }, (_, i) => edgeApp(i, [`e${i}.example.com`]))))).not.toThrow();
    const err = (() => {
      try {
        checkBrowserLimits(catalogOf(Array.from({ length: 61 }, (_, i) => edgeApp(i, [`e${i}.example.com`]))));
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(BrowserLimitError);
    expect((err as BrowserLimitError).limit).toBe("too_many_browser_apps");
  });

  test("buildDeviceDoc refuses a document over the limit (the publisher records it)", () => {
    const apps = Array.from({ length: 41 }, (_, i) => edgeApp(i, Array.from({ length: 20 }, (_, j) => `d${i}-${j}.example.com`)));
    expect(() => buildDeviceDoc(inputOf(apps))).toThrow(BrowserLimitError);
  });
});

// ---------------------------------------------------------------- publish (integration)

type DocEntry = { id: string; web: Record<string, unknown> | null };

async function currentDoc(s: S, deviceId: Id<"devices">): Promise<{ catalog: DocEntry[]; version: number }> {
  const head = await s.t.run((ctx) => ctx.db.query("desiredHeads").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique());
  const body = await s.t.run((ctx) => ctx.db.get(head!.bodyId));
  const doc = (JSON.parse(body!.payload) as { doc: { catalog: DocEntry[]; version: number } }).doc;
  return { catalog: doc.catalog, version: head!.version };
}

describe("publish: the signed document", () => {
  test("a website's browser choice reaches the device; an archived Chrome program turns it back to built-in, and restoring it brings it back", async () => {
    vi.useFakeTimers();
    const s = await setup();
    const drain = () => s.t.finishAllScheduledFunctions(vi.runAllTimers);
    const groupId = await s.t.run((ctx) => ctx.db.insert("groups", { orgId: s.orgId, name: "Front", revision: 0, createdAt: Date.now() }));
    const { deviceId } = await enrollDevice(s.t, s.orgId, { groupId });
    await drain();
    const chrome = await addChrome(s);
    const viaChrome = await s.a.as.mutation(api.apps.createWeb, site("Chrome site", { browser: { kind: "chrome", appId: chrome } }));
    const viaEdge = await s.a.as.mutation(api.apps.createWeb, site("Edge site", { url: "https://edge.example.com", browser: { kind: "edge" } }));
    const plain = await s.a.as.mutation(api.apps.createWeb, site("Plain site", { url: "https://plain.example.com" }));
    for (const appId of [chrome, viaChrome, viaEdge, plain]) {
      await s.a.as.mutation(api.groups.assignApp, { groupId, appId, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: true });
    }
    await drain();
    let doc = await currentDoc(s, deviceId);
    const web = (id: string) => doc.catalog.find((c) => c.id === id)!.web!;
    expect(web(viaChrome).browser).toEqual({ kind: "chrome", appId: chrome });
    expect(web(viaEdge).browser).toEqual({ kind: "edge" });
    expect(web(plain)).not.toHaveProperty("browser");

    await s.a.as.mutation(api.apps.setArchived, { appId: chrome, archived: true });
    await drain();
    doc = await currentDoc(s, deviceId);
    expect(doc.catalog.find((c) => c.id === chrome)).toBeUndefined();
    expect(web(viaChrome)).not.toHaveProperty("browser"); // the built-in window, whatever was chosen
    expect(web(viaEdge).browser).toEqual({ kind: "edge" });
    // The choice itself is still stored: restoring the program brings the browser back.
    expect((await rowOf(s.t, viaChrome))!.web!.browser).toEqual({ kind: "chrome", appId: chrome });
    await s.a.as.mutation(api.apps.setArchived, { appId: chrome, archived: false });
    await drain();
    doc = await currentDoc(s, deviceId);
    expect(web(viaChrome).browser).toEqual({ kind: "chrome", appId: chrome });
  });

  test("a group over the 800-pattern limit is refused at publish, naming the group; other groups are published", async () => {
    vi.useFakeTimers();
    const s = await setup();
    const drain = () => s.t.finishAllScheduledFunctions(vi.runAllTimers);
    const big = await s.t.run((ctx) => ctx.db.insert("groups", { orgId: s.orgId, name: "Big group", revision: 0, createdAt: Date.now() }));
    const small = await s.t.run((ctx) => ctx.db.insert("groups", { orgId: s.orgId, name: "Small group", revision: 0, createdAt: Date.now() }));
    const bigDevice = (await enrollDevice(s.t, s.orgId, { groupId: big })).deviceId;
    const smallDevice = (await enrollDevice(s.t, s.orgId, { groupId: small })).deviceId;
    await drain();
    const before = (await currentDoc(s, bigDevice)).version;

    // 41 browser websites with 20 domains each: 41 x 21 patterns > 800. Rows are written directly (the plan's app cap is not the point here).
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 41; i++) {
        const appId = await ctx.db.insert("apps", {
          orgId: s.orgId,
          name: `Site ${i}`,
          kind: "web",
          web: {
            url: `https://site${i}.example.com/`,
            allowedDomains: Array.from({ length: 20 }, (_, j) => `d${i}-${j}.example.com`),
            permissions: WEB_PERMS,
            browser: { kind: "edge" },
          },
          archived: false,
          revision: 0,
          createdAt: Date.now(),
        });
        await ctx.db.insert("appAssignments", { orgId: s.orgId, groupId: big, appId, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
      }
    });
    // One real edit makes the publisher look at the group.
    const trigger = await s.a.as.mutation(api.apps.createWeb, site("Trigger", { url: "https://trigger.example.com", browser: { kind: "edge" } }));
    await s.a.as.mutation(api.groups.assignApp, { groupId: big, appId: trigger, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
    const fine = await s.a.as.mutation(api.apps.createWeb, site("Fine", { url: "https://fine.example.com", browser: { kind: "edge" } }));
    await s.a.as.mutation(api.groups.assignApp, { groupId: small, appId: fine, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
    await drain();

    expect((await currentDoc(s, bigDevice)).version).toBe(before); // nothing new was signed for the big group
    expect((await currentDoc(s, smallDevice)).catalog.some((c) => c.id === fine)).toBe(true);
    const audit = await s.t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", s.orgId)).take(200));
    const failed = audit.filter((r) => r.action === "policy.publishFailed").map((r) => r.summary);
    expect(failed.some((x) => x.includes("Big group") && x.includes("browser web addresses (limit 800)"))).toBe(true);
    expect(failed.some((x) => x.includes("Small group"))).toBe(false);
  });
});
