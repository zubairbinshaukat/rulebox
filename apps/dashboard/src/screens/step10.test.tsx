import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { ReactNode } from "react";
import type { Me } from "../data/types";
import { MeContext } from "../lib/member";
import { strings } from "../lib/strings";
import { appEditStrings } from "../lib/screenStrings/appEdit";
import { appsStrings } from "../lib/screenStrings/apps";
import { fileTypesStrings } from "../lib/screenStrings/fileTypes";

// Phase 4 Step 10 screens (Apps, AppEdit, File types) against the LIVE data
// seam with the Convex React hooks mocked: queries answer from `cx.results`,
// paginated ones from `cx.pages`, writes call `cx.fns` (convex/apps.test.ts
// covers the backend).
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
import Apps from "./Apps";
import AppEdit from "./AppEdit";
import FileTypes from "./FileTypes";

const admin: Me = {
  email: "admin@x.test",
  role: "admin",
  status: "active",
  orgId: "org",
  orgName: "Acme",
  pin: { required: true, set: true },
  serverApiVersion: 1,
};

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname}</output>;
}

function ui(node: ReactNode, role: Me["role"], path: string) {
  return render(
    <ToastProvider>
      <MeContext.Provider value={{ ...admin, role }}>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/apps" element={node} />
            <Route path="/apps/new" element={node} />
            <Route path="/apps/:id" element={node} />
            <Route path="/file-types" element={node} />
          </Routes>
        </MemoryRouter>
      </MeContext.Provider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  cx.results = {};
  cx.queried = [];
  cx.fns = {};
});
afterEach(cleanup);

/** A list page as the server answers it (`paginationOpts` queries). */
const pageOf = (rows: unknown[], extra: object = {}) => ({ page: rows, isDone: true, continueCursor: `c:${rows.length}`, ...extra });
const lastArgs = (name: string) => cx.queried.filter((q) => q.name === name).at(-1)?.args;

const sha = "ab".repeat(32);
const webApp = {
  _id: "a1",
  name: "Docs",
  kind: "web",
  hue: 175,
  web: { url: "https://docs.example.com", allowedDomains: ["docs.example.com"], permissions: { camera: false, microphone: false, screenShare: false, clipboardRead: false, notifications: true, downloads: true, printing: false, geolocation: false } },
  archived: false,
  revision: 3,
  createdAt: 1,
  assignments: [],
  fileTypes: [],
  directEmployeeCount: 0,
  groupOptions: [{ _id: "g1", name: "Sales" }],
  denials30d: [] as { kind: string; count: number }[],
};

describe("Apps list (apps:list)", () => {
  it("asks for the active or the archived page, shows rows with the icon, source and group count; no install numbers yet", () => {
    cx.results["apps:list"] = pageOf([
      { _id: "a1", name: "Docs", kind: "web", archived: false, groupCount: 2, groupCountMore: false, summary: null, iconUrl: "https://x.convex.cloud/api/storage/1" },
      { _id: "a2", name: "Reader", kind: "desktop", source: "msi", archived: false, groupCount: 0, groupCountMore: false, summary: null },
    ]);
    ui(<Apps />, "viewer", "/apps");
    expect(lastArgs("apps:list")).toEqual({ archived: false, paginationOpts: { numItems: 10, cursor: null }, sort: { key: "created", dir: "desc" } });
    expect(screen.getByRole("link", { name: "Docs" }).getAttribute("href")).toBe("/apps/a1");
    expect(screen.getByText("2 groups")).toBeTruthy();
    expect(screen.getByText(appsStrings.sources.msi)).toBeTruthy();
    expect(screen.getByText(appsStrings.noInstalls)).toBeTruthy();
    expect(document.querySelector("img[src='https://x.convex.cloud/api/storage/1']")).not.toBeNull();
    // a viewer cannot add
    expect(screen.queryByRole("link", { name: appsStrings.addWeb })).toBeNull();
  });

  it("a long group list is shown as 10+ (the query reads only the first assignments)", () => {
    cx.results["apps:list"] = pageOf([{ _id: "a1", name: "Busy", kind: "web", archived: false, groupCount: 10, groupCountMore: true, summary: null }]);
    ui(<Apps />, "viewer", "/apps");
    expect(screen.getByText("10+ groups")).toBeTruthy();
  });

  it("archived apps are a separate page of the same query", () => {
    cx.results["apps:list"] = pageOf([]);
    ui(<Apps />, "admin", "/apps?archived=1");
    expect(lastArgs("apps:list")).toMatchObject({ archived: true });
    expect(screen.getByText(appsStrings.emptyArchivedTitle)).toBeTruthy();
  });
});

describe("AppEdit: a website", () => {
  it("Fetch details fills the name, colour and icon; Save creates the app, then stores the icon, then opens it", async () => {
    const createWeb = vi.fn(async () => "a9");
    const saveIcon = vi.fn(async () => null);
    cx.fns["apps:createWeb"] = createWeb;
    cx.fns["apps:saveIcon"] = saveIcon;
    cx.fns["apps:fetchWebMeta"] = vi.fn(async () => ({ name: "Example Docs", hue: 150, iconPreviewUrl: "data:image/png;base64,AAAA" }));
    ui(<AppEdit />, "admin", "/apps/new?kind=web");
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(`^${appEditStrings.url}`) }), { target: { value: "https://docs.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: appEditStrings.fetch }));
    expect(await screen.findByText(appEditStrings.fetchedWithIcon)).toBeTruthy();
    expect(screen.getByText(appEditStrings.iconPreview)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: new RegExp(`^${appEditStrings.name}`) }) as HTMLInputElement).value).toBe("Example Docs");
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(`^${appEditStrings.allowedDomains}`) }), { target: { value: "*.cdn.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.create }));
    await waitFor(() => expect(saveIcon).toHaveBeenCalledWith({ appId: "a9", png: "data:image/png;base64,AAAA" }));
    expect(createWeb).toHaveBeenCalledWith({
      name: "Example Docs",
      description: undefined,
      hue: 150,
      url: "https://docs.example.com",
      allowedDomains: ["*.cdn.example.com"],
    });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/apps/a9"));
  });

  it("changing the address drops the previewed icon: a previous site's icon is neither shown nor saved", async () => {
    const saveIcon = vi.fn(async () => null);
    cx.fns["apps:createWeb"] = vi.fn(async () => "a9");
    cx.fns["apps:saveIcon"] = saveIcon;
    cx.fns["apps:fetchWebMeta"] = vi.fn(async () => ({ name: "Docs", iconPreviewUrl: "data:image/png;base64,AAAA" }));
    ui(<AppEdit />, "admin", "/apps/new?kind=web");
    const url = screen.getByRole("textbox", { name: new RegExp(`^${appEditStrings.url}`) });
    fireEvent.change(url, { target: { value: "https://docs.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: appEditStrings.fetch }));
    await screen.findByText(appEditStrings.iconPreview);
    fireEvent.change(url, { target: { value: "https://other.example.org" } });
    expect(screen.queryByText(appEditStrings.iconPreview)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: strings.common.create }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/apps/a9"));
    expect(saveIcon).not.toHaveBeenCalled();
  });

  it("a failed icon upload does not undo the saved app", async () => {
    cx.fns["apps:createWeb"] = vi.fn(async () => "a9");
    cx.fns["apps:saveIcon"] = vi.fn(async () => {
      throw new ConvexError({ code: "invalid_argument", field: "png" });
    });
    cx.fns["apps:fetchWebMeta"] = vi.fn(async () => ({ name: "Docs", iconPreviewUrl: "data:image/png;base64,AAAA" }));
    ui(<AppEdit />, "admin", "/apps/new?kind=web");
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(`^${appEditStrings.url}`) }), { target: { value: "https://docs.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: appEditStrings.fetch }));
    await screen.findByText(appEditStrings.fetchedWithIcon);
    fireEvent.click(screen.getByRole("button", { name: strings.common.create }));
    expect(await screen.findByText(new RegExp(appEditStrings.iconNotSaved))).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/apps/a9"));
  });

  it("inline validation blocks an http address and a private one before anything is sent", async () => {
    const createWeb = vi.fn(async () => "a9");
    cx.fns["apps:createWeb"] = createWeb;
    ui(<AppEdit />, "admin", "/apps/new?kind=web");
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(`^${appEditStrings.name}`) }), { target: { value: "Docs" } });
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(`^${appEditStrings.url}`) }), { target: { value: "http://docs.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.create }));
    expect(await screen.findByText(strings.validate.httpsUrl)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(`^${appEditStrings.url}`) }), { target: { value: "https://10.0.0.1" } });
    expect(await screen.findByText(strings.validate.privateHost)).toBeTruthy();
    expect(createWeb).not.toHaveBeenCalled();
  });

  it("an existing app loads by id; Save sends the loaded revision; stale_edit offers Reload", async () => {
    cx.results["apps:get"] = webApp;
    const update = vi.fn().mockRejectedValueOnce(new ConvexError({ code: "stale_edit" })).mockResolvedValueOnce({ revision: 4 });
    cx.fns["apps:update"] = update;
    ui(<AppEdit />, "admin", "/apps/a1");
    expect(cx.queried.find((q) => q.name === "apps:get")).toEqual({ name: "apps:get", args: { appId: "a1" } });
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(`^${appEditStrings.name}`) }), { target: { value: "Docs 2" } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![0]).toMatchObject({ appId: "a1", expectedRevision: 3, web: { name: "Docs 2", url: "https://docs.example.com" } });
    expect(await screen.findByText(strings.common.staleTitle)).toBeTruthy();
  });

  it("a new app asks the server for nothing", () => {
    ui(<AppEdit />, "admin", "/apps/new?kind=web");
    expect(cx.queried.filter((q) => q.name === "apps:get")).toEqual([]);
  });

  it("assign to a group sends the app, group, audience and pins; the server's conflict has its own sentence", async () => {
    cx.results["apps:get"] = webApp;
    const assign = vi.fn().mockRejectedValueOnce(new ConvexError({ code: "conflict", field: "app" })).mockResolvedValueOnce({ assignmentId: "x" });
    cx.fns["groups:assignApp"] = assign;
    ui(<AppEdit />, "admin", "/apps/a1");
    fireEvent.click(screen.getByRole("button", { name: appEditStrings.assign }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: appEditStrings.assign }));
    expect(await within(dialog).findByText("This group already has this app.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: appEditStrings.assign }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(2));
    expect(assign).toHaveBeenLastCalledWith({ appId: "a1", groupId: "g1", audience: "everyone", pinnedTaskbar: false, pinnedDesktop: true });
  });

  it("archive, restore and delete call their functions; delete needs the name typed", async () => {
    cx.results["apps:get"] = { ...webApp, archived: true };
    const setArchived = vi.fn(async () => null);
    const remove = vi.fn(async () => null);
    cx.fns["apps:setArchived"] = setArchived;
    cx.fns["apps:remove"] = remove;
    ui(<AppEdit />, "admin", "/apps/a1");
    fireEvent.click(screen.getByRole("button", { name: appEditStrings.unarchive }));
    await waitFor(() => expect(setArchived).toHaveBeenCalledWith({ appId: "a1", archived: false }));
    fireEvent.click(screen.getByRole("button", { name: strings.common.delete }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Docs" } });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.common.delete }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ appId: "a1" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/apps"));
  });

  it("a viewer sees the app read-only", () => {
    cx.results["apps:get"] = webApp;
    ui(<AppEdit />, "viewer", "/apps/a1");
    expect(screen.queryByRole("button", { name: strings.common.saveChanges })).toBeNull();
    expect(screen.getByText(strings.app.readOnly)).toBeTruthy();
  });
});

describe("AppEdit: site permissions (apps:setPermissions, apps:get denials30d; Phase 5 Step 11)", () => {
  const withDenials = { ...webApp, denials30d: [{ kind: "microphone", count: 41 }, { kind: "camera", count: 12 }, { kind: "printing", count: 2 }] };
  const permCard = () => screen.getByRole("list", { name: appEditStrings.permissions });
  const kindsOn = () => within(permCard()).getAllByRole("switch").map((el) => el.getAttribute("aria-checked") === "true");

  it("shows all eight switches in the saved state, each with its default, and the printing note", () => {
    cx.results["apps:get"] = withDenials;
    ui(<AppEdit />, "admin", "/apps/a1");
    // camera, microphone, screen sharing, clipboard, notifications, downloads, printing, location
    expect(kindsOn()).toEqual([false, false, false, false, true, true, false, false]);
    const rows = within(permCard()).getAllByRole("listitem");
    expect(rows).toHaveLength(8);
    expect(within(rows[0]!).getByText(appEditStrings.permissionDefault(false))).toBeTruthy(); // camera
    expect(within(rows[4]!).getByText(appEditStrings.permissionDefault(true))).toBeTruthy(); // notifications
    expect(within(rows[6]!).getByText(appEditStrings.permissionDefault(true))).toBeTruthy(); // printing is allowed by default (PRD 24.1)
    expect(screen.getByText(appEditStrings.printingNote)).toBeTruthy();
    // nothing to save until something changes
    expect((screen.getByRole("button", { name: appEditStrings.permissionsSave }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the 30-day counts list each kind; Allow flips and highlights the switch without saving; Save sends the revision and the draft", async () => {
    cx.results["apps:get"] = withDenials;
    const save = vi.fn(async () => ({ revision: 4 }));
    cx.fns["apps:setPermissions"] = save;
    ui(<AppEdit />, "admin", "/apps/a1");
    expect(screen.getByText(appEditStrings.blocked30)).toBeTruthy();
    expect(screen.getByText(appEditStrings.blockedCount("41"))).toBeTruthy();
    expect(screen.getByText(appEditStrings.blockedCount("12"))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: appEditStrings.allowKind("Microphone") }));
    expect(save).not.toHaveBeenCalled();
    expect(kindsOn()[1]).toBe(true);
    expect(within(permCard()).getAllByRole("listitem")[1]!.hasAttribute("data-highlight")).toBe(true);
    expect(screen.getByText(appEditStrings.allowKindDone)).toBeTruthy();
    fireEvent.click(within(permCard()).getAllByRole("switch")[0]!); // camera on too: the highlight moves off
    expect(within(permCard()).getAllByRole("listitem")[1]!.hasAttribute("data-highlight")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: appEditStrings.permissionsSave }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({
      appId: "a1",
      expectedRevision: 3,
      permissions: { camera: true, microphone: true, screenShare: false, clipboardRead: false, notifications: true, downloads: true, printing: false, geolocation: false },
    });
    expect(await screen.findByText(appEditStrings.permissionsSaved)).toBeTruthy();
  });

  it("the next save uses the revision the server returned; a stale edit offers Reload and keeps the draft", async () => {
    cx.results["apps:get"] = webApp;
    const save = vi.fn().mockResolvedValueOnce({ revision: 4 }).mockRejectedValueOnce(new ConvexError({ code: "stale_edit" }));
    cx.fns["apps:setPermissions"] = save;
    ui(<AppEdit />, "admin", "/apps/a1");
    fireEvent.click(within(permCard()).getAllByRole("switch")[2]!);
    fireEvent.click(screen.getByRole("button", { name: appEditStrings.permissionsSave }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    fireEvent.click(within(permCard()).getAllByRole("switch")[3]!);
    fireEvent.click(screen.getByRole("button", { name: appEditStrings.permissionsSave }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![0]).toMatchObject({ expectedRevision: 4 });
    expect(await screen.findByText(strings.common.staleTitle)).toBeTruthy();
  });

  it("a viewer sees the switches and the counts but cannot change or save anything", () => {
    cx.results["apps:get"] = withDenials;
    ui(<AppEdit />, "viewer", "/apps/a1");
    expect(within(permCard()).getAllByRole("switch").every((el) => (el as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.queryByRole("button", { name: appEditStrings.permissionsSave })).toBeNull();
    expect(screen.queryByRole("button", { name: appEditStrings.allowKind("Microphone") })).toBeNull();
    expect(screen.getByText(appEditStrings.blockedCount("41"))).toBeTruthy();
    expect(screen.getByText(appEditStrings.permissionsReadOnly)).toBeTruthy();
  });

  it("no denials says so; an already allowed kind has no Allow button; a program has no permissions card", () => {
    cx.results["apps:get"] = { ...webApp, denials30d: [{ kind: "notifications", count: 3 }] };
    ui(<AppEdit />, "admin", "/apps/a1");
    expect(screen.queryByRole("button", { name: appEditStrings.allowKind("Notifications") })).toBeNull();
    cleanup();
    cx.results["apps:get"] = webApp;
    ui(<AppEdit />, "admin", "/apps/a1");
    expect(screen.getByText(appEditStrings.blocked30None)).toBeTruthy();
    cleanup();
    cx.results["apps:get"] = { _id: "a2", name: "Reader", kind: "desktop", archived: false, revision: 1, createdAt: 1, assignments: [], fileTypes: [], directEmployeeCount: 0, groupOptions: [], denials30d: [], desktop: { source: "preinstalled", exe: "{ProgramFiles}\\R\\r.exe", args: [], fileArgTemplate: [], resetFolders: [] } };
    ui(<AppEdit />, "admin", "/apps/a2");
    expect(screen.queryByText(appEditStrings.blocked30)).toBeNull();
  });
});

describe("AppEdit: a Windows program", () => {
  it("Resolve fills the install from winget; Save creates the program with that install and the exe path", async () => {
    const resolved = {
      packageId: "7zip.7zip",
      version: "24.08",
      name: "7-Zip",
      defaultInstallLocation: "%ProgramFiles%\\7-Zip",
      install: { kind: "msi", url: "https://www.7-zip.org/a/7z.msi", sha256: sha, sizeBytes: 0, silentArgs: [], productCode: "{23170F69-40C1-2702-2408-000001000000}", successExitCodes: [0], removeWhenUnassigned: true },
    };
    const resolve = vi.fn<(input: unknown) => Promise<typeof resolved>>(async () => resolved);
    const createDesktop = vi.fn<(input: unknown) => Promise<string>>(async () => "a8");
    cx.fns["apps:resolveWinget"] = resolve;
    cx.fns["apps:createDesktop"] = createDesktop;
    ui(<AppEdit />, "admin", "/apps/new?kind=desktop");
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(`^${appEditStrings.wingetId}`) }), { target: { value: "7zip.7zip" } });
    fireEvent.click(screen.getByRole("button", { name: appEditStrings.resolve }));
    expect(await screen.findByText(appEditStrings.resolved("7zip.7zip", "24.08"))).toBeTruthy();
    expect(resolve).toHaveBeenCalledWith({ packageId: "7zip.7zip", version: undefined });
    expect((screen.getByRole("textbox", { name: new RegExp(`^${appEditStrings.name}`) }) as HTMLInputElement).value).toBe("7-Zip");
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(`^${appEditStrings.exe}`) }), { target: { value: "{ProgramFiles}\\7-Zip\\7zFM.exe" } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.create }));
    await waitFor(() => expect(createDesktop).toHaveBeenCalledTimes(1));
    expect(createDesktop.mock.calls[0]![0]).toMatchObject({
      name: "7-Zip",
      desktop: { source: "winget", exe: "{ProgramFiles}\\7-Zip\\7zFM.exe", wingetId: "7zip.7zip", wingetVersion: "24.08", install: resolved.install },
    });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/apps/a8"));
  });

  it("winget errors are explained in the form: unsupported with the reason, unreachable", async () => {
    cx.fns["apps:resolveWinget"] = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "winget_unsupported", detail: "it only offers a per-user installer" }))
      .mockRejectedValueOnce(new ConvexError({ code: "winget_unreachable" }));
    ui(<AppEdit />, "admin", "/apps/new?kind=desktop");
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(`^${appEditStrings.wingetId}`) }), { target: { value: "Spotify.Spotify" } });
    fireEvent.click(screen.getByRole("button", { name: appEditStrings.resolve }));
    expect(await screen.findByText(strings.errors.wingetUnsupportedBecause("it only offers a per-user installer"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: appEditStrings.resolve }));
    expect(await screen.findByText(strings.errors.wingetUnreachable)).toBeTruthy();
  });

  it("path rules are checked inline: C:\\x.exe and a script are refused", async () => {
    const createDesktop = vi.fn(async () => "a8");
    cx.fns["apps:createDesktop"] = createDesktop;
    ui(<AppEdit />, "admin", "/apps/new?kind=desktop");
    fireEvent.click(screen.getByRole("radio", { name: appsStrings.sources.preinstalled }));
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(`^${appEditStrings.name}`) }), { target: { value: "Tool" } });
    for (const bad of ["C:\\x.exe", "{ProgramFiles}\\a\\b.bat", "{ProgramFiles}\\..\\x.exe"]) {
      fireEvent.change(screen.getByRole("textbox", { name: new RegExp(`^${appEditStrings.exe}`) }), { target: { value: bad } });
      fireEvent.click(screen.getByRole("button", { name: strings.common.create }));
      expect(await screen.findByText(strings.validate.exePath)).toBeTruthy();
    }
    expect(createDesktop).not.toHaveBeenCalled();
  });
});

describe("File types (fileHandlers:page, apps:options)", () => {
  const data = pageOf([{ _id: "h1", extension: ".pdf", appId: "a2", appName: "Reader" }], { total: 1, continueCursor: "o:1" });
  // `apps:options` lists every active app with a `canOpenFiles` flag; the dialog offers only the programs that can open files.
  const options = [
    { _id: "a2", name: "Reader", kind: "desktop", canOpenFiles: true },
    { _id: "a1", name: "Docs", kind: "web", canOpenFiles: false },
  ];

  it("lists the rules; adding sends the normalized extension and the app; removing sends the rule id", async () => {
    cx.results["fileHandlers:page"] = data;
    cx.results["apps:options"] = options;
    const set = vi.fn(async () => null);
    const remove = vi.fn(async () => null);
    cx.fns["fileHandlers:set"] = set;
    cx.fns["fileHandlers:remove"] = remove;
    ui(<FileTypes />, "admin", "/file-types");
    expect(screen.getByText(".pdf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: fileTypesStrings.add }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(new RegExp(`^${fileTypesStrings.extension}`)), { target: { value: "DOCX" } });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.common.add }));
    await waitFor(() => expect(set).toHaveBeenCalledWith({ extension: ".docx", appId: "a2" }));

    fireEvent.click(screen.getByRole("button", { name: `${strings.common.remove} .pdf` }));
    const confirm = await screen.findByRole("dialog");
    fireEvent.click(within(confirm).getByRole("button", { name: strings.common.remove }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ handlerId: "h1" }));
  });

  it("executables and scripts are refused in the dialog before the server is asked", async () => {
    cx.results["fileHandlers:page"] = data;
    cx.results["apps:options"] = options;
    const set = vi.fn(async () => null);
    cx.fns["fileHandlers:set"] = set;
    ui(<FileTypes />, "admin", "/file-types");
    fireEvent.click(screen.getByRole("button", { name: fileTypesStrings.add }));
    const dialog = await screen.findByRole("dialog");
    for (const ext of ["exe", ".BAT", "ps1", "msi"]) {
      fireEvent.change(within(dialog).getByLabelText(new RegExp(`^${fileTypesStrings.extension}`)), { target: { value: ext } });
      fireEvent.click(within(dialog).getByRole("button", { name: strings.common.add }));
      expect(await within(dialog).findByText(strings.validate.extensionDenied)).toBeTruthy();
    }
    expect(set).not.toHaveBeenCalled();
  });

  it("a viewer sees the rules without add or remove", () => {
    cx.results["fileHandlers:page"] = data;
    cx.results["apps:options"] = options;
    ui(<FileTypes />, "viewer", "/file-types");
    expect(screen.getByText(".pdf")).toBeTruthy();
    expect(screen.queryByRole("button", { name: fileTypesStrings.add })).toBeNull();
    expect(screen.queryByRole("button", { name: `${strings.common.remove} .pdf` })).toBeNull();
  });
});
