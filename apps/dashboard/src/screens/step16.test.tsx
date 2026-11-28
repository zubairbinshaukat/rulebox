import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleApp } from "./apps/testKit";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { Me } from "../data/types";
import { MeContext } from "../lib/member";
import { strings } from "../lib/strings";
import { appEditStrings } from "../lib/screenStrings/appEdit";
import { appBrowserStrings, browserRefusalStrings } from "../lib/screenStrings/appBrowser";
import { appUpdateStrings } from "../lib/screenStrings/appUpdates";
import { optionLabels, pickOption, selectedText } from "../test/select";
import { appAddStrings } from "../lib/screenStrings/appAdd";
import { BROWSER_BLOCKED_PERMISSIONS, MAX_BROWSER_SITES, browserSitesProblem } from "../lib/apps/browserRules";

// Phase 6 Step 16: browser web apps on the App screen against the LIVE data seam with the Convex React hooks mocked, like step10.test.tsx
// (the backend is covered by convex/browserApps.test.ts). No server runs here: these are component tests, not a look at the real screen.
const cx = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  queried: [] as { name: string; args: unknown }[],
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: unknown }>) =>
    Object.fromEntries(
      Object.entries(req).map(([k, r]) => {
        cx.queried.push({ name: getFunctionName(r.query), args: r.args });
        return [k, cx.results[getFunctionName(r.query)]];
      }),
    ),
  useQuery: () => undefined,
  useAction: (ref: FunctionReference<"action">) => fnFor(getFunctionName(ref)),
  useMutation: (ref: FunctionReference<"mutation">) => fnFor(getFunctionName(ref)),
  useConvexConnectionState: () => ({ isWebSocketConnected: true }),
}));

type Mock = ((args?: unknown) => Promise<unknown>) & { withOptimisticUpdate: () => Mock };
const stable = new Map<string, Mock>();
function fnFor(name: string): Mock {
  let f = stable.get(name);
  if (!f) {
    const call = ((args?: unknown) => {
      const impl = cx.fns[name];
      if (!impl) throw new Error(`no mock for ${name}`);
      return impl(args);
    }) as Mock;
    call.withOptimisticUpdate = () => call;
    f = call;
    stable.set(name, f);
  }
  return f;
}

import { ToastProvider } from "../app/Toasts";
import AppEdit from "./AppEdit";

const admin: Me = {
  email: "admin@x.test",
  role: "admin",
  status: "active",
  orgId: "org",
  orgName: "Acme",
  pin: { required: true, set: true },
  serverApiVersion: 1,
};

async function ui(role: Me["role"], path: string) {
  const result = render(
    <ToastProvider>
      <MeContext.Provider value={{ ...admin, role }}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/apps/new" element={<AppEdit />} />
            <Route path="/apps/:id" element={<AppEdit />} />
          </Routes>
        </MemoryRouter>
      </MeContext.Provider>
    </ToastProvider>,
  );
  await settleApp();
  return result;
}

beforeEach(() => {
  cx.results = {};
  cx.queried = [];
  cx.fns = {};
});
afterEach(cleanup);

const queried = (name: string) => cx.queried.filter((q) => q.name === name);

const perms = { camera: false, microphone: false, screenShare: false, clipboardRead: false, notifications: true, downloads: true, printing: false, geolocation: false };
const website = (over: Record<string, unknown> = {}, web: Record<string, unknown> = {}) => ({
  _id: "a1",
  name: "Docs",
  kind: "web",
  hue: 175,
  web: { url: "https://docs.example.com", allowedDomains: ["docs.example.com"], permissions: perms, ...web },
  archived: false,
  revision: 3,
  createdAt: 1,
  assignments: [],
  fileTypes: [],
  directEmployeeCount: 0,
  groupOptions: [],
  denials30d: [] as { kind: string; count: number }[],
  ...over,
});
const options = [
  { _id: "c1", name: "Google Chrome", kind: "desktop", canOpenFiles: false, browser: "chrome" },
  { _id: "c2", name: "Chrome Beta", kind: "desktop", canOpenFiles: false, browser: "chrome" },
  { _id: "e1", name: "Microsoft Edge", kind: "desktop", canOpenFiles: false, browser: "edge" },
  { _id: "w1", name: "Writer", kind: "desktop", canOpenFiles: true },
];
const field = (label: string) => screen.getByRole("textbox", { name: new RegExp(`^${label}`) }) as HTMLInputElement;
const opensIn = (name: string) => screen.getByRole("radio", { name });
const permCard = () => screen.getByRole("list", { name: appEditStrings.permissions });
const switches = () => within(permCard()).getAllByRole("switch") as HTMLButtonElement[];
// camera, microphone, screen sharing, clipboard, notifications, downloads, printing, location
const KEYS = ["camera", "microphone", "screenShare", "clipboardRead", "notifications", "downloads", "printing", "geolocation"] as const;

describe("rules (lib/apps/browserRules.ts)", () => {
  it("allowed sites: domains only, lower case, at most 200 distinct", async () => {
    expect(browserSitesProblem(["a.example.com", "*.b.example.com"], "many")).toBeNull();
    expect(browserSitesProblem(["https://a.example.com"], "many")).not.toBeNull();
    expect(browserSitesProblem(Array.from({ length: MAX_BROWSER_SITES + 1 }, (_, i) => `s${i}.example.com`), "many")).toBe("many");
    expect(browserSitesProblem(Array.from({ length: MAX_BROWSER_SITES }, (_, i) => `s${i}.example.com`), "many")).toBeNull();
    // Repeats are one site (the server de-duplicates too).
    expect(browserSitesProblem(Array.from({ length: 300 }, () => "a.example.com"), "many")).toBeNull();
  });

  it("the permissions that do nothing in a browser are screen sharing, clipboard read, downloads and location", async () => {
    expect([...BROWSER_BLOCKED_PERMISSIONS].sort()).toEqual(["clipboardRead", "downloads", "geolocation", "screenShare"]);
  });
});

describe("AppEdit: Opens in (a website)", () => {
  it("starts on the Rulebox window with its help and the fallback note; no browser list, no program query, and Save sends no browser", async () => {
    const create = vi.fn<(input: unknown) => Promise<string>>(async () => "a9");
    cx.fns["apps:createWeb"] = create;
    await ui("admin", "/apps/new?kind=web");
    expect(opensIn(appBrowserStrings.kinds.builtin).getAttribute("aria-checked")).toBe("true");
    // The help and the fallback note sit in the (i) next to "Opens in", not in paragraphs.
    expect(screen.queryByText(appBrowserStrings.fallbackNote)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: `About ${appBrowserStrings.opensIn}` }));
    expect(screen.getByRole("tooltip").textContent).toBe(`${appBrowserStrings.kindHelp.builtin} ${appBrowserStrings.fallbackNote}`);
    expect(screen.queryByText(appBrowserStrings.limitsTitle)).toBeNull();
    expect(queried("apps:options")).toEqual([]); // nothing is subscribed until Chrome is picked
    fireEvent.change(field(appEditStrings.name), { target: { value: "Docs" } });
    fireEvent.change(field(appAddStrings.web.address), { target: { value: "https://docs.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: appAddStrings.web.add }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).not.toHaveProperty("browser");
  });

  it("Edge shows the plain list of what browser mode cannot do; Save sends { kind: edge }", async () => {
    const create = vi.fn<(input: unknown) => Promise<string>>(async () => "a9");
    cx.fns["apps:createWeb"] = create;
    await ui("admin", "/apps/new?kind=web");
    fireEvent.click(opensIn(appBrowserStrings.kinds.edge));
    fireEvent.click(screen.getByRole("button", { name: `About ${appBrowserStrings.opensIn}` }));
    expect(screen.getByRole("tooltip").textContent).toContain(appBrowserStrings.kindHelp.edge);
    // What browser mode cannot do is a closed disclosure ("<details>"), its lines are in the page.
    expect(screen.getByText(appBrowserStrings.limitsTitle).closest("details")?.open).toBe(false);
    for (const line of appBrowserStrings.limits) expect(screen.getByText(line)).toBeTruthy();
    expect(queried("apps:options")).toEqual([]); // Edge needs no program
    fireEvent.change(field(appEditStrings.name), { target: { value: "Docs" } });
    fireEvent.change(field(appAddStrings.web.address), { target: { value: "https://docs.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: appAddStrings.web.add }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toMatchObject({ url: "https://docs.example.com", browser: { kind: "edge" } });
    expect((create.mock.calls[0]![0] as { browser: object }).browser).not.toHaveProperty("appId");
  });

  it("Chrome subscribes to the programs only then, offers only the Chrome ones, and needs a pick before anything is sent", async () => {
    cx.results["apps:options"] = options;
    const create = vi.fn<(input: unknown) => Promise<string>>(async () => "a9");
    cx.fns["apps:createWeb"] = create;
    await ui("admin", "/apps/new?kind=web");
    expect(queried("apps:options")).toEqual([]);
    fireEvent.click(opensIn(appBrowserStrings.kinds.chrome));
    expect(queried("apps:options").length).toBeGreaterThan(0);
    const chromeLabel = new RegExp(`^${appBrowserStrings.chromeApp}`);
    expect(selectedText(chromeLabel)).toBe(appBrowserStrings.chromeAppPick);
    expect(optionLabels(chromeLabel)).toEqual(["Google Chrome", "Chrome Beta"]);
    fireEvent.change(field(appEditStrings.name), { target: { value: "Docs" } });
    fireEvent.change(field(appAddStrings.web.address), { target: { value: "https://docs.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: appAddStrings.web.add }));
    expect(await screen.findByText(appBrowserStrings.chromeNeeded)).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    pickOption(chromeLabel, "Chrome Beta");
    fireEvent.click(screen.getByRole("button", { name: appAddStrings.web.add }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toMatchObject({ browser: { kind: "chrome", appId: "c2" } });
  });

  it("with no Chrome program yet it says so and links to Add a Windows program", async () => {
    cx.results["apps:options"] = options.filter((o) => o.browser !== "chrome");
    await ui("admin", "/apps/new?kind=web");
    fireEvent.click(opensIn(appBrowserStrings.kinds.chrome));
    expect(screen.getByText(appBrowserStrings.chromeNone)).toBeTruthy();
    expect(screen.getByRole("link", { name: appBrowserStrings.chromeAdd }).getAttribute("href")).toBe("/apps/new?kind=desktop");
  });

  it("an existing Chrome website starts on Chrome with its program; going back to the Rulebox window sends no browser", async () => {
    cx.results["apps:get"] = website({ chromeApp: { _id: "c1", name: "Google Chrome", usable: true } }, { browser: { kind: "chrome", appId: "c1" } });
    cx.results["apps:options"] = options;
    const update = vi.fn<(input: unknown) => Promise<{ revision: number }>>(async () => ({ revision: 4 }));
    cx.fns["apps:update"] = update;
    await ui("admin", "/apps/a1");
    expect(opensIn(appBrowserStrings.kinds.chrome).getAttribute("aria-checked")).toBe("true");
    expect(selectedText(new RegExp(`^${appBrowserStrings.chromeApp}`))).toBe("Google Chrome");
    expect(screen.queryByText(appBrowserStrings.chromeUnusable("Google Chrome"))).toBeNull();
    // The save bar shows once something changed.
    fireEvent.change(field(appEditStrings.name), { target: { value: "Docs 2" } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![0]).toMatchObject({ appId: "a1", expectedRevision: 3, web: { browser: { kind: "chrome", appId: "c1" } } });

    fireEvent.click(opensIn(appBrowserStrings.kinds.builtin));
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]![0]).not.toHaveProperty("web.browser");
    expect((update.mock.calls[1]![0] as { web: object }).web).not.toHaveProperty("browser");
  });

  it("an archived or deleted Chrome program is a warning on the app page: PCs use the Rulebox window", async () => {
    cx.results["apps:options"] = options;
    cx.results["apps:get"] = website({ chromeApp: { _id: "c9", name: "Old Chrome", usable: false } }, { browser: { kind: "chrome", appId: "c9" } });
    await ui("admin", "/apps/a1");
    expect(screen.getByText(appBrowserStrings.chromeUnusable("Old Chrome"))).toBeTruthy();
    cleanup();
    cx.results["apps:get"] = website({}, { browser: { kind: "chrome", appId: "c9" } });
    await ui("admin", "/apps/a1");
    expect(screen.getByText(appBrowserStrings.chromeGone)).toBeTruthy();
  });

  it("the server's refusal is one sentence", async () => {
    cx.results["apps:options"] = options;
    cx.fns["apps:createWeb"] = vi.fn().mockRejectedValue(new ConvexError({ code: "invalid_argument", field: "browser", detail: "browser_app_required" }));
    await ui("admin", "/apps/new?kind=web");
    fireEvent.click(opensIn(appBrowserStrings.kinds.chrome));
    fireEvent.change(field(appEditStrings.name), { target: { value: "Docs" } });
    fireEvent.change(field(appAddStrings.web.address), { target: { value: "https://docs.example.com" } });
    pickOption(new RegExp(`^${appBrowserStrings.chromeApp}`), "Google Chrome");
    fireEvent.click(screen.getByRole("button", { name: appAddStrings.web.add }));
    expect(await screen.findByText(browserRefusalStrings.browser_app_required)).toBeTruthy();
  });

  it("a viewer cannot change it", async () => {
    cx.results["apps:get"] = website({}, { browser: { kind: "edge" } });
    await ui("viewer", "/apps/a1");
    expect(opensIn(appBrowserStrings.kinds.edge).getAttribute("aria-checked")).toBe("true");
    expect(opensIn(appBrowserStrings.kinds.builtin).matches(":disabled")).toBe(true);
  });
});

describe("AppEdit: permissions in browser mode (plan 4.9.3, Step 16 item 4)", () => {
  it("Rulebox window: all eight switches work, no browser note", async () => {
    cx.results["apps:get"] = website();
    await ui("admin", "/apps/a1?tab=permissions");
    expect(switches().every((s) => !s.disabled)).toBe(true);
    expect(screen.queryByText(appBrowserStrings.permissionsBrowserNote("Edge"))).toBeNull();
  });

  it("Edge: screen sharing, clipboard, downloads and location are off, disabled and say why; camera, microphone, notifications and printing still work", async () => {
    cx.results["apps:get"] = website({}, { browser: { kind: "edge" } });
    await ui("admin", "/apps/a1?tab=permissions");
    expect(screen.getByText(appBrowserStrings.permissionsBrowserNote("Edge"))).toBeTruthy();
    const sw = switches();
    KEYS.forEach((key, i) => {
      const off = (BROWSER_BLOCKED_PERMISSIONS as readonly string[]).includes(key);
      expect(sw[i]!.disabled, key).toBe(off);
      if (off) expect(sw[i]!.getAttribute("aria-checked"), key).toBe("false"); // downloads were saved as on: shown off
    });
    const rows = within(permCard()).getAllByRole("listitem");
    expect(within(rows[2]!).getByText(appBrowserStrings.forcedOff.screenShare)).toBeTruthy();
    expect(within(rows[3]!).getByText(appBrowserStrings.forcedOff.clipboardRead)).toBeTruthy();
    expect(within(rows[5]!).getByText(appBrowserStrings.forcedOff.downloads)).toBeTruthy();
    expect(within(rows[7]!).getByText(appBrowserStrings.forcedOff.geolocation)).toBeTruthy();
    expect(within(rows[0]!).getByText(appEditStrings.permissionHints.camera)).toBeTruthy();
  });

  it("Chrome says Chrome; saving the others still sends all eight as they were saved", async () => {
    cx.results["apps:get"] = website({}, { browser: { kind: "chrome", appId: "c1" } });
    const save = vi.fn(async () => ({ revision: 4 }));
    cx.fns["apps:setPermissions"] = save;
    await ui("admin", "/apps/a1?tab=permissions");
    expect(screen.getByText(appBrowserStrings.permissionsBrowserNote("Chrome"))).toBeTruthy();
    fireEvent.click(switches()[0]!); // camera on
    fireEvent.click(screen.getByRole("button", { name: appEditStrings.permissionsSave }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({ appId: "a1", expectedRevision: 3, permissions: { ...perms, camera: true } });
  });

  it("no Allow button for a blocked kind in browser mode; the others keep theirs", async () => {
    cx.results["apps:get"] = website({ denials30d: [{ kind: "screenShare", count: 4 }, { kind: "camera", count: 2 }] }, { browser: { kind: "edge" } });
    await ui("admin", "/apps/a1?tab=permissions");
    expect(screen.queryByRole("button", { name: appEditStrings.allowKind("Screen sharing") })).toBeNull();
    expect(screen.getByRole("button", { name: appEditStrings.allowKind("Camera") })).toBeTruthy();
    cleanup();
    cx.results["apps:get"] = website({ denials30d: [{ kind: "screenShare", count: 4 }] });
    await ui("admin", "/apps/a1?tab=permissions");
    expect(screen.getByRole("button", { name: appEditStrings.allowKind("Screen sharing") })).toBeTruthy();
  });
});

describe("AppEdit: Browser rules (Chrome or Edge as a program, plan 4.9.7)", () => {
  const sha = "ab".repeat(32);
  const install = { kind: "msi", url: "https://dl.example.com/chrome.msi", sha256: sha, sizeBytes: 2000, silentArgs: [], successExitCodes: [0], removeWhenUnassigned: true };
  const program = (exe: string, desktop: Record<string, unknown> = {}) => ({
    _id: "p1",
    name: "Chrome",
    kind: "desktop",
    archived: false,
    revision: 5,
    createdAt: 1,
    assignments: [],
    fileTypes: [],
    directEmployeeCount: 0,
    groupOptions: [],
    denials30d: [],
    desktop: { source: "msi", exe, args: [], fileArgTemplate: [], resetFolders: [], install, update: { mode: "vendor", publisher: "Google LLC", publisherProduct: "Google Chrome" }, ...desktop },
  });
  const CHROME = "{ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe";

  it("Chrome and Edge programs get the card with the plain list; another program does not, and its Save sends no browserSites", async () => {
    cx.results["apps:get"] = program(CHROME, { browserSites: ["portal.example.com", "*.cdn.example.com"] });
    await ui("admin", "/apps/p1");
    await screen.findByRole("tab", { name: appAddStrings.tabs.updates });
    expect(screen.getByText(appBrowserStrings.rules)).toBeTruthy();
    expect(field(appBrowserStrings.sites).value).toBe("portal.example.com\n*.cdn.example.com");
    for (const line of appBrowserStrings.limits) expect(screen.getByText(line)).toBeTruthy();
    cleanup();

    cx.results["apps:get"] = program("{ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe");
    await ui("admin", "/apps/p1");
    await screen.findByRole("tab", { name: appAddStrings.tabs.updates });
    expect(screen.getByText(appBrowserStrings.rules)).toBeTruthy();
    expect(screen.getByText(appBrowserStrings.sitesEmpty)).toBeTruthy(); // no list: only the browser's blocked page
    cleanup();

    const update = vi.fn<(input: unknown) => Promise<{ revision: number }>>(async () => ({ revision: 6 }));
    cx.fns["apps:update"] = update;
    cx.results["apps:get"] = program("{ProgramFiles}\\Writer\\writer.exe", { update: undefined });
    await ui("admin", "/apps/p1");
    await screen.findByRole("tab", { name: appAddStrings.tabs.updates });
    expect(screen.queryByText(appBrowserStrings.rules)).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: /^Name/ }), { target: { value: "Writer 2" } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect((update.mock.calls[0]![0] as { desktop: { desktop: object } }).desktop.desktop).not.toHaveProperty("browserSites");
  });

  it("Save sends the sites lower-cased, trimmed and without repeats; a list left empty sends none", async () => {
    cx.results["apps:get"] = program(CHROME);
    const update = vi.fn<(input: unknown) => Promise<{ revision: number }>>(async () => ({ revision: 6 }));
    cx.fns["apps:update"] = update;
    await ui("admin", "/apps/p1");
    await screen.findByText(appUpdateStrings.updates);
    fireEvent.change(field(appBrowserStrings.sites), { target: { value: "  Portal.Example.com \n*.cdn.example.com\nportal.example.com\n\n" } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect((update.mock.calls[0]![0] as { desktop: { desktop: { browserSites: string[] } } }).desktop.desktop.browserSites).toEqual(["portal.example.com", "*.cdn.example.com"]);
    fireEvent.change(field(appBrowserStrings.sites), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect((update.mock.calls[1]![0] as { desktop: { desktop: object } }).desktop.desktop).not.toHaveProperty("browserSites");
  });

  it("a bad site and more than 200 sites are refused inline before anything is sent", async () => {
    cx.results["apps:get"] = program(CHROME);
    const update = vi.fn(async () => ({ revision: 6 }));
    cx.fns["apps:update"] = update;
    await ui("admin", "/apps/p1");
    await screen.findByText(appUpdateStrings.updates);
    fireEvent.change(field(appBrowserStrings.sites), { target: { value: "https://portal.example.com/x" } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    expect(await screen.findByText(strings.validate.domain("https://portal.example.com/x"))).toBeTruthy();
    fireEvent.change(field(appBrowserStrings.sites), { target: { value: Array.from({ length: 201 }, (_, i) => `s${i}.example.com`).join("\n") } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    expect(await screen.findByText(appBrowserStrings.sitesTooMany)).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });

  it("the server's refusal for a program that is not a browser is one sentence", async () => {
    cx.results["apps:get"] = program(CHROME);
    cx.fns["apps:update"] = vi.fn().mockRejectedValue(new ConvexError({ code: "invalid_argument", field: "browserSites", detail: "not_a_browser_app" }));
    await ui("admin", "/apps/p1");
    await screen.findByText(appUpdateStrings.updates);
    fireEvent.change(field(appBrowserStrings.sites), { target: { value: "portal.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    expect(await screen.findByText(browserRefusalStrings.not_a_browser_app)).toBeTruthy();
  });
});
