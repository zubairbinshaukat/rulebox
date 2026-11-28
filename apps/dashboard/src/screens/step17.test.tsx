import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleApp } from "./apps/testKit";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { ReactNode } from "react";
import type { Me } from "../data/types";
import { MeContext } from "../lib/member";
import { strings } from "../lib/strings";
import { appEditStrings } from "../lib/screenStrings/appEdit";
import { auditStrings } from "../lib/screenStrings/audit";
import { actorKind } from "../lib/auditText";
import { timeZoneName } from "../lib/format";
import { sinceFor } from "./audit/since";
import { deviceText } from "./device/strings";
import { installStrings } from "../lib/screenStrings/install";
import { overviewText as s } from "./overview/text";
import { installStateStrings } from "../lib/screenStrings/installState";

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
  pin: { required: true, set: true },
  serverApiVersion: 1,
};

async function ui(node: ReactNode, role: Me["role"], path: string) {
  const result = render(tree(node, role, path));
  await settleApp();
  return result;
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
  it("asks for the overview without arguments and never for the failed installs while the counter is zero", async () => {
    cx.results["overview:get"] = overviewData({}, {});
    await ui(<Overview />, "viewer", "/");
    expect(cx.queried.filter((q) => q.name === "overview:get").every((q) => JSON.stringify(q.args) === "{}")).toBe(true);
    expect(cx.queried.some((q) => q.name === "overview:failedInstallsPage")).toBe(false);
    // One status line and four compact tiles: PCs with how many are online, employees, apps with their groups, failed installs.
    expect(screen.getByText(s.statusCalm(12))).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText(s.pcsOnline(9))).toBeTruthy();
    expect(screen.getByText(s.inGroups(2))).toBeTruthy();
    expect(screen.getByRole("link", { name: new RegExp(s.employees) }).getAttribute("href")).toBe("/employees");
    expect(screen.getByText(s.failedInstallsNone)).toBeTruthy();
    expect(screen.getByText(s.attentionNone)).toBeTruthy();
  });

  it("an organization without a PC is welcomed, with a way to add the first one", async () => {
    cx.results["overview:get"] = overviewData({}, { deviceCount: 0, employeeCount: 0, appCount: 0, groupCount: 0 });
    await ui(<Overview />, "admin", "/");
    expect(screen.getByText(s.statusWelcome, { exact: false })).toBeTruthy();
    expect(screen.queryByText(s.statusCalm(0))).toBeNull();
    expect(screen.getAllByRole("link", { name: s.addFirstPc }).some((a) => a.getAttribute("href") === "/enrollment")).toBe(true);
  });

  it("failed installs: the counter turns the card on, the newest five, naming the app and the PC and linking to both", async () => {
    cx.results["overview:get"] = overviewData({}, { failedInstallCount: 25 });
    cx.pages["overview:failedInstallsPage"] = [
      { _id: "i1", deviceId: "d1", deviceName: "Front desk", appId: "a1", appName: "Reader", detail: "download_failed", updatedAt: Date.now() - 5_000 },
    ];
    cx.statuses["overview:failedInstallsPage"] = "CanLoadMore";
    await ui(<Overview />, "viewer", "/");
    expect(lastPaged("overview:failedInstallsPage")?.args).toEqual({ paginationOpts: { numItems: 5, cursor: null }, sort: { key: "updated", dir: "desc" } });
    expect(screen.getByRole("link", { name: "Reader" }).getAttribute("href")).toBe("/apps/a1");
    expect(screen.getByRole("link", { name: "Front desk" }).getAttribute("href")).toBe("/devices/d1");
    expect(screen.getByText(installStrings.details.download_failed!)).toBeTruthy();
    // The table, its pager and the search box are not part of the first look.
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("button", { name: s.seeAll(25) })).toBeTruthy();
  });

  it("failed installs: a few of them (five or fewer) are all on the card, with nothing to open", async () => {
    cx.results["overview:get"] = overviewData({}, { failedInstallCount: 2 });
    cx.pages["overview:failedInstallsPage"] = [
      { _id: "i1", deviceId: "d1", deviceName: "Front desk", appId: "a1", appName: "Reader", updatedAt: Date.now() - 5_000 },
      { _id: "i2", deviceId: "d2", deviceName: "Back office", appId: "a2", appName: "Zoom", updatedAt: Date.now() - 9_000 },
    ];
    await ui(<Overview />, "viewer", "/");
    expect(screen.getByRole("link", { name: "Back office" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^See all/ })).toBeNull();
  });

  it("failed installs: See all opens the table (10 a page, newest first) and pauses the card; Next reads the next page by its cursor, a sort click starts over, and the row opens the PC", async () => {
    cx.results["overview:get"] = overviewData({}, { failedInstallCount: 25 });
    cx.pages["overview:failedInstallsPage"] = [
      { _id: "i1", deviceId: "d1", deviceName: "Front desk", appId: "a1", appName: "Reader", updatedAt: Date.now() - 5_000 },
    ];
    cx.statuses["overview:failedInstallsPage"] = "CanLoadMore";
    await ui(<Overview />, "viewer", "/");
    fireEvent.click(screen.getByRole("button", { name: s.seeAll(25) }));
    const dialog = await screen.findByRole("dialog", { name: s.failedInstalls });
    await waitFor(() => expect(lastPaged("overview:failedInstallsPage")?.args).toEqual({ paginationOpts: { numItems: 10, cursor: null }, sort: { key: "updated", dir: "desc" } }));
    // The total is the overview's own counter; the pager can open the last page at once.
    expect(within(dialog).getByText(`${strings.pager.records(25)} · ${strings.pager.pageOf(1, 3)}`)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: strings.pager.goTo(3) })).toBeTruthy();
    // One list at a time: the card behind the dialog asks for nothing more.
    const asked = cx.paged.length;
    fireEvent.click(within(dialog).getByRole("button", { name: strings.pager.next }));
    expect(lastPaged("overview:failedInstallsPage")?.args).toMatchObject({ paginationOpts: { numItems: 10, cursor: "c:1" } });
    expect(cx.paged.slice(asked).every((p) => (p.args as { paginationOpts: { numItems: number } }).paginationOpts.numItems === 10)).toBe(true);
    const updated = within(dialog).getByRole("columnheader", { name: new RegExp(s.colUpdated) });
    expect(updated.getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(within(updated).getByRole("button"));
    expect(lastPaged("overview:failedInstallsPage")?.args).toEqual({ paginationOpts: { numItems: 10, cursor: null }, sort: { key: "updated", dir: "asc" } });
    expect(within(dialog).getByText(`${strings.pager.records(25)} · ${strings.pager.pageOf(1, 3)}`)).toBeTruthy();
  });

  it("failed installs: the tile opens the same table and closing it brings the card back", async () => {
    cx.results["overview:get"] = overviewData({}, { failedInstallCount: 7 });
    cx.pages["overview:failedInstallsPage"] = [{ _id: "i1", deviceId: "d1", deviceName: "Front desk", appId: "a1", appName: "Reader", updatedAt: Date.now() - 5_000 }];
    await ui(<Overview />, "viewer", "/");
    fireEvent.click(screen.getByRole("button", { name: new RegExp(s.failedTile) }));
    const dialog = await screen.findByRole("dialog", { name: s.failedInstalls });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.common.close }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(lastPaged("overview:failedInstallsPage")?.args).toEqual({ paginationOpts: { numItems: 5, cursor: null }, sort: { key: "updated", dir: "desc" } });
  });

  it("attention: no key, no group, out of support, a failed publish, a suspended organization and a reached limit", async () => {
    cx.results["overview:get"] = overviewData(
      { signing: "none", publishFailedAt: 5, plan: { name: "free", status: "suspended", limits: { ...limits, maxApps: 4 } } },
      { noGroupDeviceCount: 2, outOfSupportCount: 3 },
    );
    await ui(<Overview />, "viewer", "/");
    // Six cards: the list shows five and keeps the least urgent behind "Show all".
    fireEvent.click(screen.getByRole("button", { name: "Show all (6)" }));
    for (const text of [
      s.noKeyTitle,
      s.noGroupTitle(2),
      s.outOfSupportTitle(3),
      s.publishFailedTitle,
      s.suspendedTitle,
      s.limitTitle(s.limitKinds.apps),
    ]) {
      expect(screen.getByText(text), text).toBeTruthy();
    }
  });

  it("attention: five cards first, most urgent first; Show all (n) reveals the rest", async () => {
    cx.results["overview:get"] = overviewData(
      { signing: "none", publishFailedAt: 5, rosterPending: true, plan: { name: "free", status: "suspended", limits: { ...limits, maxApps: 4, maxDevices: 12 } } },
      { noGroupDeviceCount: 2, outOfSupportCount: 3 },
    );
    await ui(<Overview />, "viewer", "/");
    // Danger (no key, failed publish, suspended), then warnings (roster, no group), then notes (out of support, limits): 8 in all.
    const titles = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent ?? "");
    expect(titles()).toHaveLength(5);
    expect(titles()[0]).toContain(s.noKeyTitle);
    expect(titles().every((t) => !t.includes(s.outOfSupportTitle(3)))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Show all (8)" }));
    expect(titles()).toHaveLength(8);
  });

  it("exactly at a limit is information: it is listed, but the status stays calm", async () => {
    cx.results["overview:get"] = overviewData({ plan: { name: "free", status: "active", limits: { ...limits, maxDevices: 2 } } }, { deviceCount: 2 });
    await ui(<Overview />, "viewer", "/");
    expect(screen.getByText(s.limitTitle(s.limitKinds.devices))).toBeTruthy();
    expect(screen.getByText(s.statusCalm(2))).toBeTruthy();
    expect(screen.queryByText(/need you\./)).toBeNull();
  });

  it("over a limit is urgent: its own wording and it counts in the status line", async () => {
    cx.results["overview:get"] = overviewData({ plan: { name: "free", status: "active", limits: { ...limits, maxDevices: 2 } } }, { deviceCount: 3 });
    await ui(<Overview />, "viewer", "/");
    expect(screen.getByText(s.overLimitTitle(s.limitKinds.devices))).toBeTruthy();
    expect(screen.queryByText(s.limitTitle(s.limitKinds.devices))).toBeNull();
    expect(screen.getByText(s.statusAttention(1))).toBeTruthy();
  });

  it("a plan without limits (self-host) shows no limit warning", async () => {
    cx.results["overview:get"] = overviewData({ plan: { name: "custom", status: "active", limits: { ...limits, maxDevices: 1_000_000_000, maxApps: 1_000_000_000, maxEmployees: 1_000_000_000, maxGroups: 1_000_000_000 } } });
    await ui(<Overview />, "viewer", "/");
    expect(screen.queryByText(/can't add more/)).toBeNull();
  });

  it("a large fleet is told to owners only, without a vendor name", async () => {
    cx.results["overview:get"] = overviewData({ plan: { name: "team", status: "active", limits: { ...limits, maxDevices: 1000 } } }, { deviceCount: 301 });
    await ui(<Overview />, "owner", "/");
    expect(screen.getByText(s.largeFleetTitle)).toBeTruthy();
    expect(screen.getByText(s.largeFleetDetail)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/convex/i);
    cleanup();
    await ui(<Overview />, "admin", "/");
    expect(screen.queryByText(s.largeFleetTitle)).toBeNull();
    // A note, not a problem: the status stays calm.
    expect(screen.getByText(s.statusCalm(301))).toBeTruthy();
  });

  it("a viewer has no add buttons; an admin has them", async () => {
    cx.results["overview:get"] = overviewData();
    await ui(<Overview />, "viewer", "/");
    expect(screen.queryByRole("link", { name: s.addPc })).toBeNull();
    cleanup();
    await ui(<Overview />, "admin", "/");
    expect(screen.getByRole("link", { name: s.addPc }).getAttribute("href")).toBe("/enrollment");
    expect(screen.getByRole("link", { name: s.addApp }).getAttribute("href")).toBe("/apps/new");
  });

  it("recent activity lists the audit rows the overview carries", async () => {
    cx.results["overview:get"] = overviewData({ recentAudit: [entry("e1")] });
    await ui(<Overview />, "viewer", "/");
    expect(screen.getByText("Renamed the group Front to Office")).toBeTruthy();
  });
});

/** The Audit screen with its address on show, for the filters that live in the URL. */
function AuditWithUrl() {
  const l = useLocation();
  return (
    <>
      <output data-testid="url">{l.pathname + l.search}</output>
      <Audit />
    </>
  );
}

describe("Audit (audit:list)", () => {
  it("is the paginated log with time, action, actor, target link and summary", async () => {
    cx.pages["audit:list"] = [
      entry("e1", { action: "device.renamed", targetType: "device", targetId: "d1", targetLabel: "Front desk", summary: "Renamed the PC Desk to Front desk" }),
      entry("e2", { actorType: "system", actorLabel: "Rulebox", action: "policy.publishFailed", summary: "Could not publish: signing key not configured" }),
    ];
    await ui(<Audit />, "viewer", "/audit");
    expect(cx.paged.at(-1)).toEqual({ name: "audit:list", args: { paginationOpts: { numItems: 10, cursor: null }, sort: { key: "at", dir: "desc" } } });
    expect(screen.getByRole("link", { name: "Front desk" }).getAttribute("href")).toBe("/devices/d1");
    expect(screen.getByText("Renamed the PC Desk to Front desk")).toBeTruthy();
    expect(screen.getByText("Could not publish: signing key not configured")).toBeTruthy();
  });

  it("an empty log says so", async () => {
    await ui(<Audit />, "viewer", "/audit");
    expect(screen.getByText(auditStrings.emptyTitle)).toBeTruthy();
  });

  it("who did it is in plain words: a team member, a PC (a link), Rulebox (no second word)", async () => {
    cx.pages["audit:list"] = [
      entry("e1"),
      entry("e2", { actorType: "device", actorId: "d9", actorLabel: "Reception", action: "device.adminExitSuccess", summary: "Admin exit used" }),
      entry("e3", { actorType: "system", actorLabel: "Rulebox", action: "policy.publishFailed", summary: "Could not publish" }),
    ];
    await ui(<Audit />, "viewer", "/audit");
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText(actorKind("member"))).toBeTruthy();
    expect(within(rows[1]!).getByText(actorKind("device"))).toBeTruthy();
    expect(within(rows[1]!).getByRole("link", { name: "Reception" }).getAttribute("href")).toBe("/devices/d9");
    // "Rulebox" already says it: no sub-line repeating it.
    expect(within(rows[2]!).getAllByText("Rulebox")).toHaveLength(1);
    // The old words are gone.
    expect(screen.queryByText("Member")).toBeNull();
    expect(screen.queryByText("Device")).toBeNull();
  });

  it("the details lose the field names; other summaries stay as the server wrote them", async () => {
    cx.pages["audit:list"] = [
      entry("e1", { action: "org.settingsChanged", summary: "Changed organization settings: offlineDays, power" }),
      entry("e2", { action: "app.permissionsChanged", summary: "Changed permissions of Docs: screenShare allowed, clipboardRead blocked" }),
      entry("e3", { action: "group.renamed", summary: "Renamed the group Front to Office" }),
    ];
    await ui(<Audit />, "viewer", "/audit");
    expect(screen.getByText("Changed organization settings: offline sign-in days, power options")).toBeTruthy();
    expect(screen.getByText("Changed permissions of Docs: screen sharing allowed, clipboard blocked")).toBeTruthy();
    expect(screen.getByText("Renamed the group Front to Office")).toBeTruthy();
    expect(screen.queryByText(/offlineDays|screenShare/)).toBeNull();
  });

  it("the time zone is not in the sentence: 'your local time', the zone in the (i); Print has its own (i)", async () => {
    await ui(<Audit />, "viewer", "/audit");
    expect(screen.getByText(new RegExp(auditStrings.timesLocal))).toBeTruthy();
    expect(screen.queryByText(new RegExp(timeZoneName().replace("/", "\\/")))).toBeNull();
    expect(screen.getByRole("button", { name: auditStrings.timeZoneInfoLabel })).toBeTruthy();
    expect(screen.getByRole("button", { name: auditStrings.printInfoLabel })).toBeTruthy();
    expect(screen.getByRole("button", { name: auditStrings.print })).toBeTruthy();
  });

  it("When: all time sends no 'since'; the URL value sends the start of that local day; the segments change it", async () => {
    cx.pages["audit:list"] = [entry("e1")];
    const view = await ui(<AuditWithUrl />, "viewer", "/audit");
    expect(lastPaged("audit:list")!.args).toEqual({ paginationOpts: { numItems: 10, cursor: null }, sort: { key: "at", dir: "desc" } });
    expect(within(screen.getByRole("radiogroup", { name: auditStrings.whenLabel })).getAllByRole("radio").map((r) => r.textContent)).toEqual(Object.values(auditStrings.when));
    fireEvent.click(screen.getByRole("radio", { name: auditStrings.when["7d"] }));
    expect(screen.getByTestId("url").textContent).toBe("/audit?since=7d");
    expect(lastPaged("audit:list")!.args).toMatchObject({ since: sinceFor("7d") });
    fireEvent.click(screen.getByRole("radio", { name: auditStrings.when.today }));
    expect(lastPaged("audit:list")!.args).toMatchObject({ since: sinceFor("today") });
    fireEvent.click(screen.getByRole("radio", { name: auditStrings.when.all }));
    expect(screen.getByTestId("url").textContent).toBe("/audit");
    expect(lastPaged("audit:list")!.args).not.toHaveProperty("since");
    view.unmount();
    await ui(<Audit />, "viewer", "/audit?since=30d&size=25");
    expect(lastPaged("audit:list")!.args).toMatchObject({ since: sinceFor("30d"), paginationOpts: { numItems: 25, cursor: null } });
    // A value nobody offers is all time.
    cleanup();
    await ui(<Audit />, "viewer", "/audit?since=bogus");
    expect(lastPaged("audit:list")!.args).not.toHaveProperty("since");
  });

  it("Only this: the log switches to that item (audit:forTarget), a chip says so, its x brings everything back", async () => {
    cx.pages["audit:list"] = [entry("e1", { action: "device.renamed", targetType: "device", targetId: "d1", targetLabel: "Front desk", summary: "Renamed" })];
    cx.pages["audit:forTarget"] = [entry("e2", { action: "device.renamed", targetType: "device", targetId: "d1", targetLabel: "Front desk", summary: "Renamed again" })];
    await ui(<AuditWithUrl />, "viewer", "/audit?page=2&since=7d");
    fireEvent.click(screen.getByRole("button", { name: auditStrings.onlyThis("Front desk") }));
    expect(screen.getByTestId("url").textContent).toBe("/audit?since=7d&about=d1&label=Front+desk");
    expect(lastPaged("audit:forTarget")!.args).toMatchObject({ targetId: "d1", since: sinceFor("7d"), paginationOpts: { numItems: 10, cursor: null } });
    expect(screen.getByText("Renamed again")).toBeTruthy();
    expect(screen.getByText("Front desk", { selector: "strong" })).toBeTruthy();
    // Everything on the page is about it: no "Only this" on the rows now.
    expect(screen.queryByRole("button", { name: auditStrings.onlyThis("Front desk") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: auditStrings.clearAbout("Front desk") }));
    expect(screen.getByTestId("url").textContent).toBe("/audit?since=7d");
    expect(screen.getByText("Renamed")).toBeTruthy();
  });

  it("a filter with no rows says so in words and offers Clear filters; the chip works for a deleted item (by id)", async () => {
    await ui(<AuditWithUrl />, "viewer", "/audit?since=today");
    expect(screen.getByText(auditStrings.emptyPeriodTitle)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: auditStrings.clearFilters }));
    expect(screen.getByTestId("url").textContent).toBe("/audit");
    expect(screen.getByText(auditStrings.emptyTitle)).toBeTruthy();
    cleanup();
    await ui(<AuditWithUrl />, "viewer", "/audit?about=gone1&label=Old+PC&since=30d");
    expect(lastPaged("audit:forTarget")!.args).toMatchObject({ targetId: "gone1" });
    expect(screen.getByText(auditStrings.emptyAboutTitle("Old PC", true))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: auditStrings.clearFilters }));
    expect(screen.getByTestId("url").textContent).toBe("/audit");
  });

  it("an item without an id (a code, a deleted record) has no Only this button", async () => {
    cx.pages["audit:list"] = [entry("e1", { targetType: "enrollmentCode", targetLabel: "Front code", summary: "x" })];
    await ui(<Audit />, "viewer", "/audit");
    expect(screen.getByRole("link", { name: "Front code" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: auditStrings.onlyThis("Front code") })).toBeNull();
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
  it("counts per state, the first state with PCs is listed, and Retry shows while something failed (admin)", async () => {
    cx.results["apps:get"] = program;
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 7, failed: 1001, removing: 0, removed: 0, unsupported: 0 };
    cx.pages["apps:installs"] = [{ _id: "i1", deviceId: "d1", deviceName: "Front desk", state: "installed", attempts: 1, updatedAt: Date.now() }];
    await ui(<AppEdit />, "admin", "/apps/a1?tab=installs");
    expect(cx.queried.some((q) => q.name === "apps:installSummary" && JSON.stringify(q.args) === JSON.stringify({ appId: "a1" }))).toBe(true);
    // The tabs show the counts (the cap shows as 1,000+); the list asks for the first state that has PCs (installed).
    expect(screen.getByRole("button", { name: new RegExp(`${installStateStrings.failed}\\s*1,?000\\+`) })).toBeTruthy();
    expect(lastPaged("apps:installs")?.args).toEqual({ appId: "a1", state: "installed", paginationOpts: { numItems: 10, cursor: null }, sort: { key: "updated", dir: "desc" } });
    expect(screen.getByRole("button", { name: installStrings.retry })).toBeTruthy();
  });

  it("choosing another state asks for that state; a viewer has no Retry", async () => {
    cx.results["apps:get"] = program;
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 7, failed: 1, removing: 0, removed: 0, unsupported: 0 };
    await ui(<AppEdit />, "viewer", "/apps/a1?tab=installs");
    expect(screen.queryByRole("button", { name: installStrings.retry })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`${installStateStrings.failed}\\s*1$`) }));
    await waitFor(() => expect(lastPaged("apps:installs")?.args).toMatchObject({ appId: "a1", state: "failed" }));
  });

  it("switching to a state whose first page is still loading never shows the previous state's rows", async () => {
    cx.results["apps:get"] = program;
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 7, failed: 1, removing: 0, removed: 0, unsupported: 0 };
    cx.pages["apps:installs"] = [{ _id: "i1", deviceId: "d1", deviceName: "Front desk", state: "installed", attempts: 1, updatedAt: Date.now() }];
    await ui(<AppEdit />, "viewer", "/apps/a1?tab=installs");
    expect(screen.getByRole("link", { name: "Front desk" })).toBeTruthy();
    cx.loading = (name, args) => name === "apps:installs" && (args as { state: string }).state === "failed";
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`${installStateStrings.failed}\\s*1$`) }));
    await waitFor(() => expect(lastPaged("apps:installs")?.args).toMatchObject({ appId: "a1", state: "failed" }));
    expect(screen.queryByRole("link", { name: "Front desk" })).toBeNull();
  });

  it("the state on screen does not move on its own when an earlier state fills later", async () => {
    cx.results["apps:get"] = program;
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 0, failed: 2, removing: 0, removed: 0, unsupported: 0 };
    const view = await ui(<AppEdit />, "viewer", "/apps/a1?tab=installs");
    expect(lastPaged("apps:installs")?.args).toMatchObject({ appId: "a1", state: "failed" });
    // The first installed PC reports: the list stays on Failed until the user clicks Installed.
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 1, failed: 2, removing: 0, removed: 0, unsupported: 0 };
    view.rerender(tree(<AppEdit />, "viewer", "/apps/a1?tab=installs"));
    expect(lastPaged("apps:installs")?.args).toMatchObject({ appId: "a1", state: "failed" });
    expect(screen.getByRole("button", { name: new RegExp(`${installStateStrings.failed}\\s*2$`) }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`${installStateStrings.installed}\\s*1$`) }));
    expect(lastPaged("apps:installs")?.args).toMatchObject({ appId: "a1", state: "installed" });
  });

  it("an app no PC has reported on says so", async () => {
    cx.results["apps:get"] = program;
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 0, failed: 0, removing: 0, removed: 0, unsupported: 0 };
    await ui(<AppEdit />, "viewer", "/apps/a1?tab=installs");
    expect(screen.getAllByText(appEditStrings.installStatusNone).length).toBeGreaterThanOrEqual(1);
  });
});

describe("DeviceDetail: installs (fleet:installs, Apps tab) and history (audit:forTarget, Activity tab)", () => {
  const page = {
    _id: "d1",
    name: "Front desk",
    revision: 7,
    kioskEnabled: true,
    enrolledAt: Date.now() - 3_600_000,
    group: { _id: "g1", name: "Sales" },
    presence: { online: true, since: 1, revoked: false },
    outOfSupport: false,
    latestVersion: null,
    planState: null,
    report: null,
    flags: { noGroup: false, revoked: false, rotateCredential: false },
    lock: null,
    failedInstalls: { count: 0, more: false, names: [] },
    network: { wifiFailed: 0, printersFailed: 0 },
  };
  const APPS = "/devices/d1?tab=apps";
  const ACTIVITY = "/devices/d1?tab=activity";

  it("Apps lists the PC's results with state pills and a Retry on a failed one (admin)", async () => {
    cx.results["fleet:page"] = page;
    cx.results["fleet:liveness"] = { lastContactAt: Date.now(), online: true, fastUntil: null };
    cx.fns["fleet:watch"] = async () => ({ fastUntil: null });
    cx.pages["fleet:installs"] = [
      { _id: "i1", appId: "a1", appName: "Reader", state: "failed", attempts: 3, detail: "The installer exited with an error.", updatedAt: Date.now() },
      { _id: "i2", appId: "a2", appName: "Docs", state: "installed", attempts: 1, updatedAt: Date.now() },
    ];
    await ui(<DeviceDetail />, "admin", APPS);
    const reader = ((await screen.findByRole("link", { name: "Reader" })).closest("tr")) as HTMLElement;
    expect(lastPaged("fleet:installs")?.args).toMatchObject({ deviceId: "d1", paginationOpts: { numItems: 10, cursor: null }, sort: { key: "updated", dir: "desc" } });
    expect(within(reader).getByText(installStateStrings.failed)).toBeTruthy();
    expect(within(reader).getByRole("button", { name: installStrings.retry })).toBeTruthy();
    const docs = screen.getByRole("link", { name: "Docs" }).closest("tr") as HTMLElement;
    expect(within(docs).getByText(installStateStrings.installed)).toBeTruthy();
    expect(within(docs).queryByRole("button", { name: installStrings.retry })).toBeNull();
    // The history belongs to the Activity tab: nothing asks for it here.
    expect(cx.paged.some((p) => p.name === "audit:forTarget")).toBe(false);
  });

  it("Activity shows this PC's history (audit:forTarget asks for this PC) and does not ask for installs", async () => {
    cx.results["fleet:page"] = page;
    cx.results["fleet:liveness"] = { lastContactAt: Date.now(), online: true, fastUntil: null };
    cx.fns["fleet:watch"] = async () => ({ fastUntil: null });
    cx.pages["audit:forTarget"] = [entry("e1", { action: "device.renamed", summary: "Renamed the PC Desk to Front desk" })];
    await ui(<DeviceDetail />, "admin", ACTIVITY);
    expect(await screen.findByText("Renamed the PC Desk to Front desk")).toBeTruthy();
    expect(cx.paged.some((p) => p.name === "audit:forTarget" && (p.args as { targetId: string }).targetId === "d1")).toBe(true);
    expect(cx.paged.some((p) => p.name === "fleet:installs")).toBe(false);
  });

  function withFailedInstall(extra: Record<string, unknown> = {}) {
    cx.results["fleet:page"] = page;
    cx.results["fleet:liveness"] = { lastContactAt: Date.now(), online: true, fastUntil: null };
    cx.fns["fleet:watch"] = async () => ({ fastUntil: null });
    cx.pages["fleet:installs"] = [{ _id: "i1", appId: "a1", appName: "Reader", state: "failed", attempts: 3, updatedAt: Date.now(), ...extra }];
  }

  it("Retry asks first, says it affects every PC with the app, and only a confirm calls apps:retry", async () => {
    withFailedInstall();
    const retry = vi.fn(async () => undefined);
    cx.fns["apps:retry"] = retry;
    await ui(<DeviceDetail />, "admin", APPS);
    fireEvent.click(await screen.findByRole("button", { name: installStrings.retry }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(installStrings.retryConfirmBody("Reader"))).toBeTruthy();
    expect(retry).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: strings.common.cancel }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(retry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: installStrings.retry }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: installStrings.retryConfirmAction }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith({ appId: "a1" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(installStrings.retried)).toBeTruthy();
  });

  it("Retry is disabled, with the reason, for an app the server says cannot be retried", async () => {
    withFailedInstall({ retryable: false });
    await ui(<DeviceDetail />, "admin", APPS);
    const button = (await screen.findByRole("button", { name: installStrings.retry })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe(installStrings.retryUnavailable);
  });

  it("the history of another PC does not show this PC's rows while its first page loads", async () => {
    withFailedInstall();
    cx.pages["audit:forTarget"] = [entry("e1", { summary: "Renamed the PC Desk to Front desk" })];
    const view = await ui(<DeviceDetail />, "viewer", ACTIVITY);
    expect(await screen.findByText("Renamed the PC Desk to Front desk")).toBeTruthy();
    cx.loading = (name) => name === "audit:forTarget";
    cx.results["fleet:page"] = { ...page, _id: "d2" };
    view.rerender(tree(<DeviceDetail />, "viewer", ACTIVITY));
    expect(screen.queryByText("Renamed the PC Desk to Front desk")).toBeNull();
  });
});
describe("Step 17 follow-ups: roster notice, no-group link, short pages, capped counts", () => {
  it("Overview: a waiting roster update is listed and points to the signing settings; without one it is absent", async () => {
    cx.results["overview:get"] = overviewData({ rosterPending: true });
    await ui(<Overview />, "viewer", "/");
    expect(screen.getByText(s.rosterPendingTitle)).toBeTruthy();
    expect(screen.getByText(s.rosterPendingDetail)).toBeTruthy();
    const item = screen.getByText(s.rosterPendingTitle).closest("li") as HTMLElement;
    expect(within(item).getByRole("link", { name: s.openSettings }).getAttribute("href")).toBe("/settings?tab=signing");
    cleanup();
    cx.results["overview:get"] = overviewData({ rosterPending: false });
    await ui(<Overview />, "viewer", "/");
    expect(screen.queryByText(s.rosterPendingTitle)).toBeNull();
  });

  it("Overview: the no-group warning opens the device list already filtered to PCs without a group", async () => {
    cx.results["overview:get"] = overviewData({}, { noGroupDeviceCount: 2 });
    await ui(<Overview />, "viewer", "/");
    const item = screen.getByText(s.noGroupTitle(2)).closest("li") as HTMLElement;
    expect(within(item).getByRole("link", { name: s.noGroupAction }).getAttribute("href")).toBe("/devices?group=none");
  });

  it("AppEdit: a short or empty page with more to read still offers Next, and reads the next page by its cursor", async () => {
    cx.results["apps:get"] = program;
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 0, failed: 3, removing: 0, removed: 0, unsupported: 0 };
    cx.pages["apps:installs"] = [];
    cx.statuses["apps:installs"] = "CanLoadMore";
    await ui(<AppEdit />, "viewer", "/apps/a1?tab=installs");
    expect(screen.getByText(strings.table.emptyPage)).toBeTruthy();
    expect(screen.queryByText(appEditStrings.installStatusNone)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: strings.pager.next }));
    expect(lastPaged("apps:installs")?.args).toMatchObject({ appId: "a1", state: "failed", paginationOpts: { numItems: 10, cursor: "c:0" } });
  });

  it("AppEdit: an empty list that is exhausted says nothing is there, without a pager", async () => {
    cx.results["apps:get"] = program;
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 0, failed: 3, removing: 0, removed: 0, unsupported: 0 };
    cx.pages["apps:installs"] = [];
    await ui(<AppEdit />, "viewer", "/apps/a1?tab=installs");
    expect(screen.getAllByText(appEditStrings.installStatusNone).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: strings.pager.next })).toBeNull();
  });

  it("AppEdit: a capped summary says the counts mean at least; an exact one does not", async () => {
    cx.results["apps:get"] = program;
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 1001, failed: 0, removing: 0, removed: 0, unsupported: 0, capped: true };
    await ui(<AppEdit />, "viewer", "/apps/a1?tab=installs");
    expect(screen.getByText(appEditStrings.installCapped)).toBeTruthy();
    expect(screen.getByRole("button", { name: new RegExp(`${installStateStrings.installed}\\s*1,?000\\+`) })).toBeTruthy();
    cleanup();
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 12, failed: 0, removing: 0, removed: 0, unsupported: 0 };
    await ui(<AppEdit />, "viewer", "/apps/a1?tab=installs");
    expect(screen.queryByText(appEditStrings.installCapped)).toBeNull();
  });

  it("DeviceDetail Apps: an empty page with more to read offers Next instead of 'no apps are assigned'", async () => {
    cx.results["fleet:page"] = {
      _id: "d1",
      name: "Front desk",
      revision: 7,
      kioskEnabled: true,
      enrolledAt: Date.now() - 3_600_000,
      group: { _id: "g1", name: "Sales" },
      presence: { online: true, since: 1, revoked: false },
      outOfSupport: false,
      latestVersion: null,
      planState: null,
      report: null,
      flags: { noGroup: false, revoked: false, rotateCredential: false },
      lock: null,
      failedInstalls: { count: 0, more: false, names: [] },
      network: { wifiFailed: 0, printersFailed: 0 },
    };
    cx.results["fleet:liveness"] = { lastContactAt: Date.now(), online: true, fastUntil: null };
    cx.fns["fleet:watch"] = async () => ({ fastUntil: null });
    cx.pages["fleet:installs"] = [];
    cx.statuses["fleet:installs"] = "CanLoadMore";
    await ui(<DeviceDetail />, "viewer", "/devices/d1?tab=apps");
    expect(await screen.findByText(strings.table.emptyPage)).toBeTruthy();
    expect(screen.queryByText(deviceText.appsNone)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: strings.pager.next }));
    expect(lastPaged("fleet:installs")?.args).toMatchObject({ deviceId: "d1", paginationOpts: { numItems: 10, cursor: "c:0" } });
  });

  it("DeviceDetail Apps: nothing assigned says so and an admin can open the group", async () => {
    cx.results["fleet:page"] = {
      _id: "d1", name: "Front desk", revision: 7, kioskEnabled: true, enrolledAt: 1, group: { _id: "g1", name: "Sales" },
      presence: { online: true, since: 1, revoked: false }, outOfSupport: false, latestVersion: null, planState: null, report: null,
      flags: { noGroup: false, revoked: false, rotateCredential: false }, lock: null,
      failedInstalls: { count: 0, more: false, names: [] }, network: { wifiFailed: 0, printersFailed: 0 },
    };
    cx.results["fleet:liveness"] = { lastContactAt: Date.now(), online: true, fastUntil: null };
    cx.fns["fleet:watch"] = async () => ({ fastUntil: null });
    cx.pages["fleet:installs"] = [];
    await ui(<DeviceDetail />, "admin", "/devices/d1?tab=apps");
    expect(await screen.findByText(deviceText.appsNone)).toBeTruthy();
    expect(screen.getByRole("link", { name: deviceText.appsOpenGroup }).getAttribute("href")).toBe("/groups/g1");
    cleanup();
    await ui(<DeviceDetail />, "viewer", "/devices/d1?tab=apps");
    expect(await screen.findByText(deviceText.appsNone)).toBeTruthy();
    expect(screen.queryByRole("link", { name: deviceText.appsOpenGroup })).toBeNull();
  });
});
describe("Settings, Signing: publish again and the waiting roster update (keys:status, keys:registerActive)", () => {
  const keys = (over: Record<string, unknown> = {}) => ({
    keys: [{ keyId: "a3f19c07d2e8b456", fingerprint: "SHA256:abc", status: "active", createdAt: 1 }],
    signing: "ok",
    env: { active: { keyId: "a3f19c07d2e8b456", fingerprint: "SHA256:abc" }, next: null },
    orgKeys: { signing: null, sealing: null, locked: false },
    publishFailedAt: null,
    rosterPending: false,
    ...over,
  });

  it("a failed publish offers Publish again to an Owner: it calls registerActive without force, with progress", async () => {
    cx.results["keys:status"] = keys({ publishFailedAt: Date.now() - 60_000 });
    let done: () => void = () => undefined;
    const call = vi.fn(() => new Promise<unknown>((resolve) => (done = () => resolve({ keyId: "a3f19c07d2e8b456", fingerprint: "SHA256:abc" }))));
    cx.fns["keys:registerActive"] = call;
    await ui(<SigningTab />, "owner", "/");
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
    await ui(<SigningTab />, "owner", "/");
    fireEvent.click(screen.getByRole("button", { name: strings.publish.again }));
    expect(await screen.findByText(strings.publish.notReady)).toBeTruthy();
  });

  it("an Admin sees the failure but no Publish again button", async () => {
    cx.results["keys:status"] = keys({ publishFailedAt: Date.now() - 60_000 });
    await ui(<SigningTab />, "admin", "/");
    expect(screen.getByText(strings.publish.signingHint)).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.publish.again })).toBeNull();
  });

  it("a waiting roster update is explained, with one Publish again button even when publishing also failed", async () => {
    cx.results["keys:status"] = keys({ rosterPending: true });
    await ui(<SigningTab />, "owner", "/");
    expect(screen.getByText(strings.publish.rosterTitle)).toBeTruthy();
    expect(screen.getByText(strings.publish.rosterBody)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: strings.publish.again })).toHaveLength(1);
    cleanup();
    cx.results["keys:status"] = keys({ rosterPending: true, publishFailedAt: Date.now() - 1000 });
    await ui(<SigningTab />, "owner", "/");
    expect(screen.getAllByRole("button", { name: strings.publish.again })).toHaveLength(1);
  });

  it("with nothing wrong there is no notice and no Publish again", async () => {
    cx.results["keys:status"] = keys();
    await ui(<SigningTab />, "owner", "/");
    expect(screen.queryByText(strings.publish.rosterTitle)).toBeNull();
    expect(screen.queryByRole("button", { name: strings.publish.again })).toBeNull();
  });
});

import { settingsStrings as signText } from "../lib/screenStrings/settings";

describe("Settings, Signing: who holds the key (keys:status orgKeys)", () => {
  const sg = signText.signing;
  const key = { keyId: "a3f19c07d2e8b456", fingerprint: "SHA256:abc", status: "active", createdAt: Date.UTC(2026, 7, 1) };
  const status = (over: Record<string, unknown> = {}) => ({
    keys: [key],
    signing: "ok",
    env: { active: null, next: null },
    orgKeys: { signing: { keyId: key.keyId, fingerprint: "SHA256:abc", origin: "generated" }, sealing: null, locked: false },
    publishFailedAt: null,
    rosterPending: false,
    ...over,
  });
  const deployment = (over: Record<string, unknown> = {}) =>
    status({ env: { active: { keyId: key.keyId, fingerprint: "SHA256:abc" }, next: null }, orgKeys: { signing: null, sealing: null, locked: false }, ...over });

  it("an organization with its own key (keyring) is told signing is automatic, and sees no environment warning, no commands and no rotation", async () => {
    cx.results["keys:status"] = status();
    await ui(<SigningTab />, "owner", "/");
    expect(screen.getByText(sg.statusKeyring)).toBeTruthy();
    expect(screen.getAllByText(sg.statusOn).length).toBeGreaterThan(0);
    expect(screen.queryByText(sg.envMissing)).toBeNull();
    expect(screen.queryByText(sg.setupTitle)).toBeNull();
    expect(screen.queryByText(sg.rotateTitle)).toBeNull();
    expect(screen.queryByRole("button", { name: sg.prepare })).toBeNull();
    // The key is listed, but only under Advanced.
    const details = screen.getByText(sg.keyDetails).closest("details")!;
    expect(details.hasAttribute("open")).toBe(false);
    expect(within(details).getByText(key.keyId)).toBeTruthy();
  });

  it("a locked keyring is a danger notice for everyone, in plain words", async () => {
    cx.results["keys:status"] = status({ orgKeys: { signing: { keyId: key.keyId, fingerprint: "f", origin: "generated" }, sealing: null, locked: true } });
    await ui(<SigningTab />, "viewer", "/");
    expect(screen.getByText(sg.lockedTitle)).toBeTruthy();
    expect(screen.getByText(sg.lockedBody)).toBeTruthy();
    expect(screen.getByText(sg.statusOff)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("an organization that signs with the deployment key sees its status line, the rotation under Advanced and, for an Owner, Prepare rotation", async () => {
    cx.results["keys:status"] = deployment();
    await ui(<SigningTab />, "owner", "/");
    expect(screen.getByText(sg.statusDeployment)).toBeTruthy();
    const rotate = screen.getByText(sg.rotateTitle).closest("details")!;
    expect(rotate.hasAttribute("open")).toBe(false);
    expect(within(rotate).getByRole("button", { name: sg.prepare })).toBeTruthy();
  });

  it("deployment key missing from the server: the environment warning shows, only there", async () => {
    cx.results["keys:status"] = deployment({ env: { active: null, next: null } });
    await ui(<SigningTab />, "owner", "/");
    expect(screen.getByText(sg.envMissing)).toBeTruthy();
  });

  it("deployment, no key yet: an Owner gets the setup commands (open) and Register key; a viewer neither", async () => {
    cx.results["keys:status"] = deployment({ keys: [], signing: "missing" });
    await ui(<SigningTab />, "owner", "/");
    expect(screen.getByText(sg.noKeyTitle)).toBeTruthy();
    expect(screen.getByRole("button", { name: sg.register })).toBeTruthy();
    expect(screen.getByText(sg.setupTitle).closest("details")!.hasAttribute("open")).toBe(true);
    cleanup();
    await ui(<SigningTab />, "viewer", "/");
    expect(screen.getByText(sg.noKeyTitle)).toBeTruthy();
    expect(screen.queryByRole("button", { name: sg.register })).toBeNull();
    expect(screen.queryByText(sg.setupTitle)).toBeNull();
  });

  it("a mismatching deployment key is a danger notice (deployment only); a keyring organization never sees it", async () => {
    cx.results["keys:status"] = deployment({ signing: "mismatch" });
    await ui(<SigningTab />, "owner", "/");
    expect(screen.getByText(sg.mismatchTitle)).toBeTruthy();
    cleanup();
    cx.results["keys:status"] = status({ signing: "mismatch" });
    await ui(<SigningTab />, "owner", "/");
    expect(screen.queryByText(sg.mismatchTitle)).toBeNull();
  });

  it("'If something goes wrong' is under Advanced, in two short parts", async () => {
    cx.results["keys:status"] = status();
    await ui(<SigningTab />, "admin", "/");
    const wrong = screen.getByText(sg.wrongTitle).closest("details")!;
    expect(wrong.hasAttribute("open")).toBe(false);
    expect(within(wrong).getByText(sg.lostBody)).toBeTruthy();
    expect(within(wrong).getByText(sg.stolenBody)).toBeTruthy();
  });
});