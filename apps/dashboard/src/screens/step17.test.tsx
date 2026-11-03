import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { ReactNode } from "react";
import type { Me } from "../data/types";
import { MeContext } from "../lib/member";
import { strings } from "../lib/strings";

// Phase 4 Step 17 screens (Overview, Audit, the install cards of AppEdit and
// DeviceDetail, the history panel) against the LIVE data seam with the Convex
// React hooks mocked: queries answer from `cx.results`, paginated ones from
// `cx.pages` (convex/overview.test.ts, audit.test.ts, apps.test.ts and
// fleet.test.ts cover the backend).
const cx = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  pages: {} as Record<string, unknown[]>,
  paged: [] as { name: string; args: unknown }[],
  queried: [] as { name: string; args: unknown }[],
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
  /** Paginated queries whose arguments this accepts are still loading their first page (no rows yet). */
  loading: null as null | ((name: string, args: unknown) => boolean),
  /** The status a paginated query reports (default "Exhausted"); "CanLoadMore" with few or no rows is a short page. */
  statuses: {} as Record<string, string>,
  loadMore: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: unknown }>) =>
    Object.fromEntries(
      Object.entries(req).map(([k, r]) => {
        const name = getFunctionName(r.query);
        cx.queried.push({ name, args: r.args });
        if (cx.results[name] !== undefined) return [k, cx.results[name]];
        // A list query (`paginationOpts` argument): one page of `cx.pages[name]`; `cx.statuses[name]` other than
        // "Exhausted" means the server has more rows after this page.
        if ((r.args as { paginationOpts?: unknown } | undefined)?.paginationOpts) {
          cx.paged.push({ name, args: r.args });
          if (cx.loading?.(name, r.args)) return [k, undefined];
          const rows = (cx.pages[name] ??= []);
          return [k, { page: rows, isDone: (cx.statuses[name] ?? "Exhausted") === "Exhausted", continueCursor: `c:${rows.length}` }];
        }
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

import { ToastProvider } from "../app/Toasts";
import Overview from "./Overview";
import Audit from "./Audit";
import AppEdit from "./AppEdit";
import DeviceDetail from "./DeviceDetail";
import { SigningTab } from "./settings/SigningTab";
import { AppError } from "../lib/errors";

const admin: Me = {
  email: "admin@x.test",
  role: "admin",
  status: "active",
  orgId: "org",
  orgName: "Acme",
  mfa: { enrolled: true, required: true, verified: true },
  serverApiVersion: 1,
};

function ui(node: ReactNode, role: Me["role"], path: string) {
  return render(tree(node, role, path));
}

function tree(node: ReactNode, role: Me["role"], path: string) {
  return (
    <ToastProvider>
      <MeContext.Provider value={{ ...admin, role }}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/" element={node} />
            <Route path="/audit" element={node} />
            <Route path="/apps/:id" element={node} />
            <Route path="/devices/:id" element={node} />
          </Routes>
        </MemoryRouter>
      </MeContext.Provider>
    </ToastProvider>
  );
}

beforeEach(() => {
  cx.results = {};
  cx.pages = {};
  cx.paged = [];
  cx.queried = [];
  cx.fns = {};
  cx.loading = null;
  cx.statuses = {};
  cx.loadMore.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(cleanup);

const lastPaged = (name: string) => cx.paged.filter((p) => p.name === name).at(-1);

const limits = {
  maxDevices: 50,
  maxEmployees: 500,
  maxApps: 200,
  maxGroups: 50,
  maxMembers: 10,
  auditRetentionDays: 365,
  storageQuotaBytes: 1024 ** 3,
  maxUploadBytes: 1024 ** 3,
  watchMode: true,
  maxEnrollmentCodesActive: 20,
};
const counts = { deviceCount: 12, employeeCount: 3, appCount: 4, groupCount: 2, noGroupDeviceCount: 0, outOfSupportCount: 0, failedInstallCount: 0 };
const overviewData = (over: Record<string, unknown> = {}, c: Partial<typeof counts> = {}) => ({
  counts: { ...counts, ...c },
  onlineCount: 9,
  plan: { name: "team", status: "active", limits },
  signing: "active",
  publishFailedAt: null,
  rosterPending: false,
  recentAudit: [],
  ...over,
});
const entry = (id: string, over: Record<string, unknown> = {}) => ({
  _id: id,
  at: Date.now() - 60_000,
  actorType: "member",
  actorId: "m1",
  actorLabel: "owner@acme.test",
  action: "group.renamed",
  summary: "Renamed the group Front to Office",
  ...over,
});

describe("Overview (overview:get)", () => {
  it("asks for the overview without arguments and never for the failed installs while the counter is zero", () => {
    cx.results["overview:get"] = overviewData({}, {});
    ui(<Overview />, "viewer", "/");
    expect(cx.queried.filter((q) => q.name === "overview:get").every((q) => JSON.stringify(q.args) === "{}")).toBe(true);
    expect(cx.queried.some((q) => q.name === "overview:failedInstallsPage")).toBe(false);
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText(strings.overview.online)).toBeTruthy();
    expect(screen.getByText(strings.overview.onlineOf(12))).toBeTruthy();
    expect(screen.getByText(strings.overview.failedInstallsNone)).toBeTruthy();
    expect(screen.getByText(strings.overview.attentionNone)).toBeTruthy();
  });

  it("failed installs: the counter turns the list on, one page of 10 newest first, naming the app and the PC and linking to both", () => {
    cx.results["overview:get"] = overviewData({}, { failedInstallCount: 25 });
    cx.pages["overview:failedInstallsPage"] = [
      { _id: "i1", deviceId: "d1", deviceName: "Front desk", appId: "a1", appName: "Reader", detail: "The download did not match its checksum.", updatedAt: Date.now() - 5_000 },
    ];
    cx.statuses["overview:failedInstallsPage"] = "CanLoadMore";
    ui(<Overview />, "viewer", "/");
    expect(lastPaged("overview:failedInstallsPage")?.args).toEqual({ paginationOpts: { numItems: 10, cursor: null }, sort: { key: "updated", dir: "desc" } });
    expect(screen.getByRole("link", { name: "Reader" }).getAttribute("href")).toBe("/apps/a1");
    expect(screen.getByRole("link", { name: "Front desk" }).getAttribute("href")).toBe("/devices/d1");
    // The total is the overview's own counter; the pager can open the last page at once.
    expect(screen.getByText(`${strings.pager.records(25)} · ${strings.pager.pageOf(1, 3)}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: strings.pager.goTo(3) })).toBeTruthy();
  });

  it("failed installs: Next reads the next page by its cursor, a sort click starts over, and the row opens the PC", () => {
    cx.results["overview:get"] = overviewData({}, { failedInstallCount: 25 });
    cx.pages["overview:failedInstallsPage"] = [
      { _id: "i1", deviceId: "d1", deviceName: "Front desk", appId: "a1", appName: "Reader", updatedAt: Date.now() - 5_000 },
    ];
    cx.statuses["overview:failedInstallsPage"] = "CanLoadMore";
    ui(<Overview />, "viewer", "/");
    fireEvent.click(screen.getByRole("button", { name: strings.pager.next }));
    expect(lastPaged("overview:failedInstallsPage")?.args).toMatchObject({ paginationOpts: { numItems: 10, cursor: "c:1" } });
    const updated = screen.getByRole("columnheader", { name: new RegExp(strings.overview.colUpdated) });
    expect(updated.getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(within(updated).getByRole("button"));
    expect(lastPaged("overview:failedInstallsPage")?.args).toEqual({ paginationOpts: { numItems: 10, cursor: null }, sort: { key: "updated", dir: "asc" } });
    expect(screen.getByText(`${strings.pager.records(25)} · ${strings.pager.pageOf(1, 3)}`)).toBeTruthy();
  });
  it("attention: no key, no group, out of support, a failed publish, a suspended organization and a reached limit", () => {
    cx.results["overview:get"] = overviewData(
      { signing: "none", publishFailedAt: 5, plan: { name: "free", status: "suspended", limits: { ...limits, maxApps: 4 } } },
      { noGroupDeviceCount: 2, outOfSupportCount: 3 },
    );
    ui(<Overview />, "viewer", "/");
    for (const text of [
      strings.overview.noKeyTitle,
      strings.overview.noGroupTitle(2),
      strings.overview.outOfSupportTitle(3),
      strings.overview.publishFailedTitle,
      strings.overview.suspendedTitle,
      strings.overview.limitTitle(strings.overview.limitKinds.apps),
    ]) {
      expect(screen.getByText(text), text).toBeTruthy();
    }
  });

  it("exactly at a limit is information: it is listed, but the lead stays calm", () => {
    cx.results["overview:get"] = overviewData({ plan: { name: "free", status: "active", limits: { ...limits, maxDevices: 2 } } }, { deviceCount: 2 });
    ui(<Overview />, "viewer", "/");
    expect(screen.getByText(strings.overview.limitTitle(strings.overview.limitKinds.devices))).toBeTruthy();
    expect(screen.getByText(strings.overview.leadCalm)).toBeTruthy();
    expect(screen.queryByText(/need a look/)).toBeNull();
  });

  it("over a limit is urgent: its own wording and it counts in the lead", () => {
    cx.results["overview:get"] = overviewData({ plan: { name: "free", status: "active", limits: { ...limits, maxDevices: 2 } } }, { deviceCount: 3 });
    ui(<Overview />, "viewer", "/");
    expect(screen.getByText(strings.overview.overLimitTitle(strings.overview.limitKinds.devices))).toBeTruthy();
    expect(screen.queryByText(strings.overview.limitTitle(strings.overview.limitKinds.devices))).toBeNull();
    expect(screen.getByText(strings.overview.leadAttention(1))).toBeTruthy();
  });

  it("a plan without limits (self-host) shows no limit warning", () => {
    cx.results["overview:get"] = overviewData({ plan: { name: "custom", status: "active", limits: { ...limits, maxDevices: 1_000_000_000, maxApps: 1_000_000_000, maxEmployees: 1_000_000_000, maxGroups: 1_000_000_000 } } });
    ui(<Overview />, "viewer", "/");
    expect(screen.queryByText(/reached the limit/)).toBeNull();
  });

  it("recent activity lists the audit rows the overview carries", () => {
    cx.results["overview:get"] = overviewData({ recentAudit: [entry("e1")] });
    ui(<Overview />, "viewer", "/");
    expect(screen.getByText("Renamed the group Front to Office")).toBeTruthy();
  });
});

describe("Audit (audit:list)", () => {
  it("is the paginated log with time, action, actor, target link and summary", () => {
    cx.pages["audit:list"] = [
      entry("e1", { action: "device.renamed", targetType: "device", targetId: "d1", targetLabel: "Front desk", summary: "Renamed the PC Desk to Front desk" }),
      entry("e2", { actorType: "system", actorLabel: "Rulebox", action: "policy.publishFailed", summary: "Could not publish: signing key not configured" }),
    ];
    ui(<Audit />, "viewer", "/audit");
    expect(cx.paged.at(-1)).toEqual({ name: "audit:list", args: { paginationOpts: { numItems: 10, cursor: null }, sort: { key: "at", dir: "desc" } } });
    expect(screen.getByRole("link", { name: "Front desk" }).getAttribute("href")).toBe("/devices/d1");
    expect(screen.getByText("Renamed the PC Desk to Front desk")).toBeTruthy();
    expect(screen.getByText("Could not publish: signing key not configured")).toBeTruthy();
  });

  it("an empty log says so", () => {
    ui(<Audit />, "viewer", "/audit");
    expect(screen.getByText(strings.audit.emptyTitle)).toBeTruthy();
  });
});

const sha = "ab".repeat(32);
const program = {
  _id: "a1",
  name: "Reader",
  kind: "desktop",
  desktop: {
    source: "msi",
    exe: "{ProgramFiles}\\Reader\\reader.exe",
    args: [],
    fileArgTemplate: [],
    resetFolders: [],
    install: { kind: "msi", url: "https://dl.example.com/r.msi", sha256: sha, sizeBytes: 10, silentArgs: [], successExitCodes: [0], removeWhenUnassigned: true },
  },
  archived: false,
  revision: 3,
  createdAt: 1,
  assignments: [],
  fileTypes: [],
  directEmployeeCount: 0,
  groupOptions: [],
};

describe("AppEdit: install status (apps:installSummary, apps:installs)", () => {
  it("counts per state, the first state with PCs is listed, and Retry shows while something failed (admin)", () => {
    cx.results["apps:get"] = program;
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 7, failed: 1001, removing: 0, removed: 0, unsupported: 0 };
    cx.pages["apps:installs"] = [{ _id: "i1", deviceId: "d1", deviceName: "Front desk", state: "installed", attempts: 1, updatedAt: Date.now() }];
    ui(<AppEdit />, "admin", "/apps/a1");
    expect(cx.queried.some((q) => q.name === "apps:installSummary" && JSON.stringify(q.args) === JSON.stringify({ appId: "a1" }))).toBe(true);
    // The tabs show the counts (the cap shows as 1,000+); the list asks for the first state that has PCs (installed).
    expect(screen.getByRole("button", { name: new RegExp(`${strings.installState.failed}\\s*1,?000\\+`) })).toBeTruthy();
    expect(lastPaged("apps:installs")?.args).toEqual({ appId: "a1", state: "installed", paginationOpts: { numItems: 10, cursor: null }, sort: { key: "updated", dir: "desc" } });
    expect(screen.getByRole("button", { name: strings.install.retry })).toBeTruthy();
  });

  it("choosing another state asks for that state; a viewer has no Retry", async () => {
    cx.results["apps:get"] = program;
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 7, failed: 1, removing: 0, removed: 0, unsupported: 0 };
    ui(<AppEdit />, "viewer", "/apps/a1");
    expect(screen.queryByRole("button", { name: strings.install.retry })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`${strings.installState.failed}\\s*1$`) }));
    await waitFor(() => expect(lastPaged("apps:installs")?.args).toMatchObject({ appId: "a1", state: "failed" }));
  });

  it("switching to a state whose first page is still loading never shows the previous state's rows", async () => {
    cx.results["apps:get"] = program;
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 7, failed: 1, removing: 0, removed: 0, unsupported: 0 };
    cx.pages["apps:installs"] = [{ _id: "i1", deviceId: "d1", deviceName: "Front desk", state: "installed", attempts: 1, updatedAt: Date.now() }];
    ui(<AppEdit />, "viewer", "/apps/a1");
    expect(screen.getByRole("link", { name: "Front desk" })).toBeTruthy();
    cx.loading = (name, args) => name === "apps:installs" && (args as { state: string }).state === "failed";
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`${strings.installState.failed}\\s*1$`) }));
    await waitFor(() => expect(lastPaged("apps:installs")?.args).toMatchObject({ appId: "a1", state: "failed" }));
    expect(screen.queryByRole("link", { name: "Front desk" })).toBeNull();
  });

  it("the state on screen does not move on its own when an earlier state fills later", () => {
    cx.results["apps:get"] = program;
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 0, failed: 2, removing: 0, removed: 0, unsupported: 0 };
    const view = ui(<AppEdit />, "viewer", "/apps/a1");
    expect(lastPaged("apps:installs")?.args).toMatchObject({ appId: "a1", state: "failed" });
    // The first installed PC reports: the list stays on Failed until the user clicks Installed.
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 1, failed: 2, removing: 0, removed: 0, unsupported: 0 };
    view.rerender(tree(<AppEdit />, "viewer", "/apps/a1"));
    expect(lastPaged("apps:installs")?.args).toMatchObject({ appId: "a1", state: "failed" });
    expect(screen.getByRole("button", { name: new RegExp(`${strings.installState.failed}\\s*2$`) }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`${strings.installState.installed}\\s*1$`) }));
    expect(lastPaged("apps:installs")?.args).toMatchObject({ appId: "a1", state: "installed" });
  });

  it("an app no PC has reported on says so", () => {
    cx.results["apps:get"] = program;
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 0, failed: 0, removing: 0, removed: 0, unsupported: 0 };
    ui(<AppEdit />, "viewer", "/apps/a1");
    expect(screen.getAllByText(strings.appEdit.installStatusNone).length).toBeGreaterThanOrEqual(1);
  });
});

describe("DeviceDetail: installs (fleet:installs) and history (audit:forTarget)", () => {
  const detail = {
    _id: "d1",
    name: "Front desk",
    revision: 7,
    kioskEnabled: true,
    enrolledAt: Date.now() - 3_600_000,
    group: { _id: "g1", name: "Sales" },
    state: "active",
    presence: { online: true, since: 1, revoked: false },
    summary: { agentVersion: "0.4.0", outOfSupport: false, updatedAt: 1 },
    report: null,
    versions: [],
    flags: { noGroup: false, revoked: false, rotateCredential: false },
    groups: [{ _id: "g1", name: "Sales" }],
  };

  it("lists the PC's results with state pills and a Retry on a failed one (admin); the history asks for this PC", async () => {
    cx.results["fleet:get"] = detail;
    cx.results["fleet:liveness"] = { lastContactAt: Date.now(), online: true, fastUntil: null };
    cx.fns["fleet:watch"] = async () => ({ fastUntil: null });
    cx.pages["fleet:installs"] = [
      { _id: "i1", appId: "a1", appName: "Reader", state: "failed", attempts: 3, detail: "The installer exited with an error.", updatedAt: Date.now() },
      { _id: "i2", appId: "a2", appName: "Docs", state: "installed", attempts: 1, updatedAt: Date.now() },
    ];
    cx.pages["audit:forTarget"] = [entry("e1", { action: "device.renamed", summary: "Renamed the PC Desk to Front desk" })];
    ui(<DeviceDetail />, "admin", "/devices/d1");
    expect(lastPaged("fleet:installs")?.args).toMatchObject({ deviceId: "d1", paginationOpts: { numItems: 10, cursor: null }, sort: { key: "updated", dir: "desc" } });
    expect(cx.paged.some((p) => p.name === "audit:forTarget" && (p.args as { targetId: string }).targetId === "d1")).toBe(true);
    const reader = screen.getByRole("link", { name: "Reader" }).closest("tr") as HTMLElement;
    expect(within(reader).getByText(strings.installState.failed)).toBeTruthy();
    expect(within(reader).getByRole("button", { name: strings.install.retry })).toBeTruthy();
    const docs = screen.getByRole("link", { name: "Docs" }).closest("tr") as HTMLElement;
    expect(within(docs).getByText(strings.installState.installed)).toBeTruthy();
    expect(within(docs).queryByRole("button", { name: strings.install.retry })).toBeNull();
    expect(screen.getByText("Renamed the PC Desk to Front desk")).toBeTruthy();
  });

  function withFailedInstall(extra: Record<string, unknown> = {}) {
    cx.results["fleet:get"] = detail;
    cx.results["fleet:liveness"] = { lastContactAt: Date.now(), online: true, fastUntil: null };
    cx.fns["fleet:watch"] = async () => ({ fastUntil: null });
    cx.pages["fleet:installs"] = [{ _id: "i1", appId: "a1", appName: "Reader", state: "failed", attempts: 3, updatedAt: Date.now(), ...extra }];
  }

  it("Retry asks first, says it affects every PC with the app, and only a confirm calls apps:retry", async () => {
    withFailedInstall();
    const retry = vi.fn(async () => undefined);
    cx.fns["apps:retry"] = retry;
    ui(<DeviceDetail />, "admin", "/devices/d1");
    fireEvent.click(screen.getByRole("button", { name: strings.install.retry }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(strings.install.retryConfirmBody("Reader"))).toBeTruthy();
    expect(retry).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: strings.common.cancel }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(retry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: strings.install.retry }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: strings.install.retryConfirmAction }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith({ appId: "a1" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(strings.install.retried)).toBeTruthy();
  });

  it("Retry is disabled, with the reason, for an app the server says cannot be retried", () => {
    withFailedInstall({ retryable: false });
    ui(<DeviceDetail />, "admin", "/devices/d1");
    const button = screen.getByRole("button", { name: strings.install.retry }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe(strings.install.retryUnavailable);
  });

  it("the history of another PC does not show this PC's rows while its first page loads", () => {
    withFailedInstall();
    cx.pages["audit:forTarget"] = [entry("e1", { summary: "Renamed the PC Desk to Front desk" })];
    const view = ui(<DeviceDetail />, "viewer", "/devices/d1");
    expect(screen.getByText("Renamed the PC Desk to Front desk")).toBeTruthy();
    cx.loading = (name) => name === "audit:forTarget";
    cx.results["fleet:get"] = { ...detail, _id: "d2" };
    view.rerender(tree(<DeviceDetail />, "viewer", "/devices/d1"));
    expect(screen.queryByText("Renamed the PC Desk to Front desk")).toBeNull();
  });
});

describe("Step 17 follow-ups: roster notice, no-group link, short pages, capped counts", () => {
  it("Overview: a waiting roster update is listed and points to the signing settings; without one it is absent", () => {
    cx.results["overview:get"] = overviewData({ rosterPending: true });
    ui(<Overview />, "viewer", "/");
    expect(screen.getByText(strings.overview.rosterPendingTitle)).toBeTruthy();
    expect(screen.getByText(strings.overview.rosterPendingDetail)).toBeTruthy();
    const item = screen.getByText(strings.overview.rosterPendingTitle).closest("li") as HTMLElement;
    expect(within(item).getByRole("link", { name: strings.overview.noKeyAction }).getAttribute("href")).toBe("/settings?tab=signing");
    cleanup();
    cx.results["overview:get"] = overviewData({ rosterPending: false });
    ui(<Overview />, "viewer", "/");
    expect(screen.queryByText(strings.overview.rosterPendingTitle)).toBeNull();
  });

  it("Overview: the no-group warning opens the device list already filtered to PCs without a group", () => {
    cx.results["overview:get"] = overviewData({}, { noGroupDeviceCount: 2 });
    ui(<Overview />, "viewer", "/");
    const item = screen.getByText(strings.overview.noGroupTitle(2)).closest("li") as HTMLElement;
    expect(within(item).getByRole("link", { name: strings.overview.noGroupAction }).getAttribute("href")).toBe("/devices?group=none");
  });

  it("AppEdit: a short or empty page with more to read still offers Next, and reads the next page by its cursor", () => {
    cx.results["apps:get"] = program;
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 0, failed: 3, removing: 0, removed: 0, unsupported: 0 };
    cx.pages["apps:installs"] = [];
    cx.statuses["apps:installs"] = "CanLoadMore";
    ui(<AppEdit />, "viewer", "/apps/a1");
    expect(screen.getByText(strings.table.emptyPage)).toBeTruthy();
    expect(screen.queryByText(strings.appEdit.installStatusNone)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: strings.pager.next }));
    expect(lastPaged("apps:installs")?.args).toMatchObject({ appId: "a1", state: "failed", paginationOpts: { numItems: 10, cursor: "c:0" } });
  });

  it("AppEdit: an empty list that is exhausted says nothing is there, without a pager", () => {
    cx.results["apps:get"] = program;
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 0, failed: 3, removing: 0, removed: 0, unsupported: 0 };
    cx.pages["apps:installs"] = [];
    ui(<AppEdit />, "viewer", "/apps/a1");
    expect(screen.getAllByText(strings.appEdit.installStatusNone).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: strings.pager.next })).toBeNull();
  });

  it("AppEdit: a capped summary says the counts mean at least; an exact one does not", () => {
    cx.results["apps:get"] = program;
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 1001, failed: 0, removing: 0, removed: 0, unsupported: 0, capped: true };
    ui(<AppEdit />, "viewer", "/apps/a1");
    expect(screen.getByText(strings.appEdit.installCapped)).toBeTruthy();
    expect(screen.getByRole("button", { name: new RegExp(`${strings.installState.installed}\\s*1,?000\\+`) })).toBeTruthy();
    cleanup();
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 12, failed: 0, removing: 0, removed: 0, unsupported: 0 };
    ui(<AppEdit />, "viewer", "/apps/a1");
    expect(screen.queryByText(strings.appEdit.installCapped)).toBeNull();
  });

  it("DeviceDetail: an empty page with more to read offers Next instead of 'no apps are assigned'", () => {
    cx.results["fleet:get"] = {
      _id: "d1",
      name: "Front desk",
      revision: 7,
      kioskEnabled: true,
      enrolledAt: Date.now() - 3_600_000,
      group: { _id: "g1", name: "Sales" },
      state: "active",
      presence: { online: true, since: 1, revoked: false },
      summary: null,
      report: null,
      versions: [],
      flags: { noGroup: false, revoked: false, rotateCredential: false },
      groups: [{ _id: "g1", name: "Sales" }],
    };
    cx.results["fleet:liveness"] = { lastContactAt: Date.now(), online: true, fastUntil: null };
    cx.fns["fleet:watch"] = async () => ({ fastUntil: null });
    cx.pages["fleet:installs"] = [];
    cx.statuses["fleet:installs"] = "CanLoadMore";
    ui(<DeviceDetail />, "viewer", "/devices/d1");
    expect(screen.queryByText(strings.device.installsNone)).toBeNull();
    expect(screen.getByText(strings.table.emptyPage)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.pager.next }));
    expect(lastPaged("fleet:installs")?.args).toMatchObject({ deviceId: "d1", paginationOpts: { numItems: 10, cursor: "c:0" } });
  });
});

describe("Settings, Signing: publish again and the waiting roster update (keys:status, keys:registerActive)", () => {
  const keys = (over: Record<string, unknown> = {}) => ({
    keys: [{ keyId: "a3f19c07d2e8b456", fingerprint: "SHA256:abc", status: "active", createdAt: 1 }],
    signing: "ok",
    env: { active: { keyId: "a3f19c07d2e8b456", fingerprint: "SHA256:abc" }, next: null },
    publishFailedAt: null,
    rosterPending: false,
    ...over,
  });

  it("a failed publish offers Publish again to an Owner: it calls registerActive without force, with progress", async () => {
    cx.results["keys:status"] = keys({ publishFailedAt: Date.now() - 60_000 });
    let done: () => void = () => undefined;
    const call = vi.fn(() => new Promise<unknown>((resolve) => (done = () => resolve({ keyId: "a3f19c07d2e8b456", fingerprint: "SHA256:abc" }))));
    cx.fns["keys:registerActive"] = call;
    ui(<SigningTab />, "owner", "/");
    fireEvent.click(screen.getByRole("button", { name: strings.publish.again }));
    expect(call).toHaveBeenCalledWith({});
    const busy = screen.getByRole("button", { name: strings.publish.publishing }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    done();
    await waitFor(() => expect(screen.getByText(strings.publish.done)).toBeTruthy());
  });

  it("a refusal shows a plain sentence under the notice", async () => {
    cx.results["keys:status"] = keys({ publishFailedAt: Date.now() - 60_000 });
    cx.fns["keys:registerActive"] = async () => {
      throw new AppError({ code: "not_ready", detail: "RULEBOX_POLICY_KEY is not set or not 32 bytes of base64" });
    };
    ui(<SigningTab />, "owner", "/");
    fireEvent.click(screen.getByRole("button", { name: strings.publish.again }));
    expect(await screen.findByText(strings.publish.notReady)).toBeTruthy();
  });

  it("an Admin sees the failure but no Publish again button", () => {
    cx.results["keys:status"] = keys({ publishFailedAt: Date.now() - 60_000 });
    ui(<SigningTab />, "admin", "/");
    expect(screen.getByText(strings.publish.signingHint)).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.publish.again })).toBeNull();
  });

  it("a waiting roster update is explained, with one Publish again button even when publishing also failed", () => {
    cx.results["keys:status"] = keys({ rosterPending: true });
    ui(<SigningTab />, "owner", "/");
    expect(screen.getByText(strings.publish.rosterTitle)).toBeTruthy();
    expect(screen.getByText(strings.publish.rosterBody)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: strings.publish.again })).toHaveLength(1);
    cleanup();
    cx.results["keys:status"] = keys({ rosterPending: true, publishFailedAt: Date.now() - 1000 });
    ui(<SigningTab />, "owner", "/");
    expect(screen.getAllByRole("button", { name: strings.publish.again })).toHaveLength(1);
  });

  it("with nothing wrong there is no notice and no Publish again", () => {
    cx.results["keys:status"] = keys();
    ui(<SigningTab />, "owner", "/");
    expect(screen.queryByText(strings.publish.rosterTitle)).toBeNull();
    expect(screen.queryByRole("button", { name: strings.publish.again })).toBeNull();
  });
});
