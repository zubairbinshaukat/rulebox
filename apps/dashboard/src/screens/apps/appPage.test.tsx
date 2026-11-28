import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { ReactNode } from "react";
import type { AppDetail, Me } from "../../data/types";
import { MeContext } from "../../lib/member";
import { appAddStrings as a } from "../../lib/screenStrings/appAdd";
import { appEditStrings } from "../../lib/screenStrings/appEdit";
import { appUpdateStrings } from "../../lib/screenStrings/appUpdates";
import { strings } from "../../lib/strings";
import { settleApp } from "./testKit";

// The app page (UI pass, add-app plan 3.1.7 and 11): tabs in the address, one query per open tab, the shared save bar of Details and Updates,
// the Permissions draft that survives a tab switch, and the website slot (`renderDetails`), against the LIVE data seam with the hooks mocked.
const cx = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  queried: [] as string[],
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: unknown }>) =>
    Object.fromEntries(
      Object.entries(req).map(([k, r]) => {
        const name = getFunctionName(r.query);
        cx.queried.push(name);
        if (cx.results[name] !== undefined) return [k, cx.results[name]];
        if ((r.args as { paginationOpts?: unknown } | undefined)?.paginationOpts) return [k, { page: [], isDone: true, continueCursor: "c:0" }];
        return [k, undefined];
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

import { ToastProvider } from "../../app/Toasts";
import AppEdit from "../AppEdit";
import AppPage from "./page/AppPage";

const admin: Me = { email: "admin@x.test", role: "admin", status: "active", orgId: "org", orgName: "Acme", pin: { required: true, set: true }, serverApiVersion: 1 };

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}
const where = () => screen.getByTestId("where").textContent;

async function show(node: ReactNode, role: Me["role"], path: string) {
  const result = render(
    <ToastProvider>
      <MeContext.Provider value={{ ...admin, role }}>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/apps/:id" element={node} />
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

const SHA = "ab".repeat(32);
const program = (over: Partial<AppDetail> = {}): AppDetail => ({
  _id: "a2",
  name: "POS",
  kind: "desktop",
  archived: false,
  revision: 5,
  createdAt: 1,
  assignments: [{ _id: "x1", audience: "everyone", pinnedTaskbar: false, pinnedDesktop: true, groupId: "g1", groupName: "Sales" } as AppDetail["assignments"][number]],
  fileTypes: [".pos"],
  directEmployeeCount: 0,
  groupOptions: [{ _id: "g1", name: "Sales" }, { _id: "g2", name: "Back office" }],
  denials30d: [],
  desktop: {
    source: "msi",
    exe: "{ProgramFiles}\\Pos\\pos.exe",
    args: [],
    fileArgTemplate: ["{file}"],
    resetFolders: [],
    install: { kind: "msi", url: "https://dl.example.com/pos.msi", sha256: SHA, sizeBytes: 2000, silentArgs: [], successExitCodes: [0], removeWhenUnassigned: true },
  },
  ...over,
});
const website = (): AppDetail =>
  program({
    _id: "w1",
    name: "Docs",
    kind: "web",
    desktop: undefined,
    web: { url: "https://docs.example.com", allowedDomains: ["docs.example.com"], permissions: { camera: false, microphone: false, screenShare: false, clipboardRead: false, notifications: true, downloads: true, printing: false, geolocation: false } },
  });
const tabNames = () => within(screen.getByRole("tablist")).getAllByRole("tab").map((t) => t.textContent?.replace(/\d+$/, "").trim());
const nameBox = () => screen.getByRole("textbox", { name: new RegExp(`^${appEditStrings.name}`) }) as HTMLInputElement;
const openTab = (name: string) => fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${name}`) }));

describe("the tabs", () => {
  it("a Windows app has Details, Who gets it, Installs, Updates and Activity; the open tab is in the address and Details is the clean address", async () => {
    cx.results["apps:get"] = program();
    await show(<AppEdit />, "admin", "/apps/a2");
    expect(tabNames()).toEqual([a.tabs.details, a.tabs.access, a.tabs.installs, a.tabs.updates, a.tabs.activity]);
    expect(screen.getByRole("tab", { name: new RegExp(`^${a.tabs.details}`) }).getAttribute("aria-selected")).toBe("true");
    openTab(a.tabs.access);
    expect(where()).toBe("/apps/a2?tab=access");
    expect(await screen.findByRole("table", { name: appEditStrings.assignments })).toBeTruthy();
    openTab(a.tabs.details);
    expect(where()).toBe("/apps/a2");
  });

  it("a website has Details, Who gets it, Permissions and Activity", async () => {
    await show(<AppPage d={website()} />, "admin", "/apps/w1");
    expect(tabNames()).toEqual([a.tabs.details, a.tabs.access, a.tabs.permissions, a.tabs.activity]);
  });

  it("a tab that is not open reads nothing: Details asks for no install counts and no history; each opens its own query", async () => {
    cx.results["apps:get"] = program();
    cx.results["apps:installSummary"] = { installed: 2 };
    await show(<AppEdit />, "admin", "/apps/a2");
    expect(cx.queried).toEqual(["apps:get"]);
    openTab(a.tabs.installs);
    await waitFor(() => expect(cx.queried).toContain("apps:installSummary"));
    expect(cx.queried).not.toContain("audit:forTarget");
    openTab(a.tabs.activity);
    await waitFor(() => expect(cx.queried).toContain("audit:forTarget"));
  });

  it("the page opens on the tab in the address", async () => {
    cx.results["apps:get"] = program();
    await show(<AppEdit />, "admin", "/apps/a2?tab=updates");
    expect(await screen.findByRole("heading", { name: appUpdateStrings.updates })).toBeTruthy();
  });
});

describe("Who gets it", () => {
  it("right after an add the banner points at Assign to a group", async () => {
    cx.results["apps:get"] = program({ assignments: [] });
    await show(<AppEdit />, "admin", "/apps/a2?tab=access&added=1");
    expect(await screen.findByText(a.added.banner("POS"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: a.added.assign }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("without the flag there is no banner; a viewer has no Assign", async () => {
    cx.results["apps:get"] = program();
    await show(<AppEdit />, "viewer", "/apps/a2?tab=access");
    await screen.findByRole("table", { name: appEditStrings.assignments });
    expect(screen.queryByText(a.added.banner("POS"))).toBeNull();
    expect(screen.queryByRole("button", { name: appEditStrings.assign })).toBeNull();
  });
});

describe("one form, one save bar", () => {
  it("shows once something changed, stays on every tab, and saves Details and Updates in one apps:update", async () => {
    const update = vi.fn<(input: unknown) => Promise<{ revision: number }>>(async () => ({ revision: 6 }));
    cx.fns["apps:update"] = update;
    cx.results["apps:get"] = program();
    await show(<AppEdit />, "admin", "/apps/a2");
    expect(screen.queryByRole("button", { name: a.saveBar.save })).toBeNull();
    fireEvent.change(nameBox(), { target: { value: "POS 2" } });
    expect(screen.getByText(a.saveBar.unsaved)).toBeTruthy();
    openTab(a.tabs.updates);
    await screen.findByRole("heading", { name: appUpdateStrings.updates });
    expect(screen.getByText(a.saveBar.unsaved)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(`^${appUpdateStrings.version}`) }), { target: { value: "2.0.0" } });
    fireEvent.click(screen.getByRole("button", { name: a.saveBar.save }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![0]).toMatchObject({ appId: "a2", expectedRevision: 5, desktop: { name: "POS 2", desktop: { version: "2.0.0" } } });
    // Saved: the bar goes away, and the next save would carry the new revision.
    await waitFor(() => expect(screen.queryByText(a.saveBar.unsaved)).toBeNull());
  });

  it("Discard brings the saved values back and hides the bar", async () => {
    cx.results["apps:get"] = program();
    await show(<AppEdit />, "admin", "/apps/a2");
    fireEvent.change(nameBox(), { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: a.saveBar.discard }));
    await waitFor(() => expect(nameBox().value).toBe("POS"));
    expect(screen.queryByText(a.saveBar.unsaved)).toBeNull();
  });

  it("a problem on the Updates tab is pointed at from the bar", async () => {
    cx.results["apps:get"] = program();
    cx.fns["apps:update"] = vi.fn();
    await show(<AppEdit />, "admin", "/apps/a2?tab=updates");
    await screen.findByRole("heading", { name: appUpdateStrings.updates });
    fireEvent.click(screen.getByRole("radio", { name: appUpdateStrings.modeLabels.vendor }));
    openTab(a.tabs.details);
    fireEvent.click(screen.getByRole("button", { name: a.saveBar.save }));
    expect(await screen.findByText(strings.validate.fixErrors(1))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: a.tabs.updates }));
    expect(await screen.findByText(appEditStrings.needsPublisher)).toBeTruthy();
  });

  it("a viewer has no bar; an archived app says so", async () => {
    cx.results["apps:get"] = program({ archived: true });
    await show(<AppEdit />, "viewer", "/apps/a2");
    expect(screen.getByText(strings.app.readOnly)).toBeTruthy();
    expect(screen.getByText(appEditStrings.archived)).toBeTruthy();
    expect((nameBox() as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText(a.saveBar.unsaved)).toBeNull();
  });
});

describe("the website slot and the Permissions draft", () => {
  it("the Details tab is whatever renderDetails gives, with the page's one form; its edits use the shared save bar", async () => {
    const update = vi.fn<(input: unknown) => Promise<{ revision: number }>>(async () => ({ revision: 6 }));
    cx.fns["apps:update"] = update;
    await show(
      <AppPage
        d={website()}
        renderDetails={(ctx) => (
          <button type="button" onClick={() => ctx.f.set("name", "Docs 2")}>
            slot for {ctx.d.name}
          </button>
        )}
        buildUpdate={(values, d) => ({ web: { name: values.name, url: values.url, allowedDomains: ["docs.example.com", "x.example.com"], hue: d.hue } })}
      />,
      "admin",
      "/apps/w1",
    );
    fireEvent.click(screen.getByRole("button", { name: "slot for Docs" }));
    fireEvent.click(screen.getByRole("button", { name: a.saveBar.save }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![0]).toMatchObject({ appId: "w1", expectedRevision: 5, web: { name: "Docs 2", url: "https://docs.example.com", allowedDomains: ["docs.example.com", "x.example.com"] } });
  });

  it("a website without a form plugged in still has its name and description", async () => {
    await show(<AppPage d={website()} />, "admin", "/apps/w1");
    expect(nameBox().value).toBe("Docs");
  });

  it("the Permissions draft survives a tab switch and saves with its own call", async () => {
    const save = vi.fn<(input: unknown) => Promise<{ revision: number }>>(async () => ({ revision: 6 }));
    cx.fns["apps:setPermissions"] = save;
    await show(<AppPage d={website()} />, "admin", "/apps/w1?tab=permissions");
    const camera = () => screen.getByRole("switch", { name: appEditStrings.permissionNames.camera });
    fireEvent.click(camera());
    expect(camera().getAttribute("aria-checked")).toBe("true");
    openTab(a.tabs.details);
    openTab(a.tabs.permissions);
    expect(await screen.findByRole("switch", { name: appEditStrings.permissionNames.camera })).toBeTruthy();
    expect(camera().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: appEditStrings.permissionsSave }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({ appId: "w1", expectedRevision: 5, permissions: { camera: true } });
  });
});
