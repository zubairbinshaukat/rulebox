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
  usePaginatedQuery: (ref: FunctionReference<"query">, args: unknown) => {
    cx.paged.push({ name: getFunctionName(ref), args });
    return { results: (cx.pages[getFunctionName(ref)] ??= []), status: "Exhausted", isLoading: false, loadMore: () => undefined };
  },
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
  return render(
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
    </ToastProvider>,
  );
}

beforeEach(() => {
  cx.results = {};
  cx.pages = {};
  cx.paged = [];
  cx.queried = [];
  cx.fns = {};
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
    expect(cx.queried.some((q) => q.name === "overview:failedInstalls")).toBe(false);
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText(strings.overview.online)).toBeTruthy();
    expect(screen.getByText(strings.overview.onlineOf(12))).toBeTruthy();
    expect(screen.getByText(strings.overview.failedInstallsNone)).toBeTruthy();
    expect(screen.getByText(strings.overview.attentionNone)).toBeTruthy();
  });

  it("failed installs: the counter turns the list on, which names the app and the PC and links to both", () => {
    cx.results["overview:get"] = overviewData({}, { failedInstallCount: 25 });
    cx.results["overview:failedInstalls"] = [
      { _id: "i1", deviceId: "d1", deviceName: "Front desk", appId: "a1", appName: "Reader", detail: "The download did not match its checksum.", updatedAt: Date.now() - 5_000 },
    ];
    ui(<Overview />, "viewer", "/");
    expect(cx.queried.some((q) => q.name === "overview:failedInstalls")).toBe(true);
    expect(screen.getByRole("link", { name: "Reader" }).getAttribute("href")).toBe("/apps/a1");
    expect(screen.getByRole("link", { name: "Front desk" }).getAttribute("href")).toBe("/devices/d1");
    expect(screen.getByText(strings.overview.failedInstallsShown(1, 25))).toBeTruthy();
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
    expect(cx.paged.at(-1)).toEqual({ name: "audit:list", args: {} });
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
    expect(lastPaged("apps:installs")).toEqual({ name: "apps:installs", args: { appId: "a1", state: "installed" } });
    expect(screen.getByRole("button", { name: strings.install.retry })).toBeTruthy();
  });

  it("choosing another state asks for that state; a viewer has no Retry", async () => {
    cx.results["apps:get"] = program;
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 7, failed: 1, removing: 0, removed: 0, unsupported: 0 };
    ui(<AppEdit />, "viewer", "/apps/a1");
    expect(screen.queryByRole("button", { name: strings.install.retry })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`${strings.installState.failed}\\s*1$`) }));
    await waitFor(() => expect(lastPaged("apps:installs")).toEqual({ name: "apps:installs", args: { appId: "a1", state: "failed" } }));
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
    expect(cx.paged.some((p) => p.name === "fleet:installs" && JSON.stringify(p.args) === JSON.stringify({ deviceId: "d1" }))).toBe(true);
    expect(cx.paged.some((p) => p.name === "audit:forTarget" && JSON.stringify(p.args) === JSON.stringify({ targetId: "d1" }))).toBe(true);
    const reader = screen.getByRole("link", { name: "Reader" }).closest("tr") as HTMLElement;
    expect(within(reader).getByText(strings.installState.failed)).toBeTruthy();
    expect(within(reader).getByRole("button", { name: strings.install.retry })).toBeTruthy();
    const docs = screen.getByRole("link", { name: "Docs" }).closest("tr") as HTMLElement;
    expect(within(docs).getByText(strings.installState.installed)).toBeTruthy();
    expect(within(docs).queryByRole("button", { name: strings.install.retry })).toBeNull();
    expect(screen.getByText("Renamed the PC Desk to Front desk")).toBeTruthy();
  });
});
