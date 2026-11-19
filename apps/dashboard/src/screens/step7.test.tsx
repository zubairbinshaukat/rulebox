import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { ReactNode } from "react";
import type { Me } from "../data/types";
import { MeContext } from "../lib/member";
import { setStepUpHandler } from "../lib/stepUpRetry";
import { strings } from "../lib/strings";
import { deviceStrings } from "../lib/screenStrings/device";
import { devicesStrings } from "../lib/screenStrings/devices";

// Phase 4 Step 7 screens (Devices, DeviceDetail) against the LIVE data seam
// with the Convex React hooks mocked: queries answer from `cx.results`,
// paginated ones from `cx.pages`, writes call `cx.fns` (convex/fleet.test.ts
// covers the backend).
const cx = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  pages: {} as Record<string, unknown[]>,
  paged: [] as { name: string; args: unknown }[],
  queried: [] as string[],
  /** Every query the screen subscribed to (Phase 4b lists are plain queries with `paginationOpts`). */
  queries: [] as { name: string; args: Record<string, unknown> }[],
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: unknown }>) =>
    Object.fromEntries(
      Object.entries(req).map(([k, r]) => {
        cx.queried.push(getFunctionName(r.query));
        cx.queries.push({ name: getFunctionName(r.query), args: r.args as Record<string, unknown> });
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

const stable = new Map<string, (args?: unknown) => Promise<unknown>>();
function fnFor(name: string) {
  let f = stable.get(name);
  if (!f) {
    f = (args?: unknown) => {
      const impl = cx.fns[name];
      if (!impl) throw new Error(`no mock for ${name}`);
      return impl(args);
    };
    stable.set(name, f);
  }
  return f;
}

import { ToastProvider } from "../app/Toasts";
import Devices from "./Devices";
import DeviceDetail from "./DeviceDetail";

const admin: Me = {
  email: "admin@x.test",
  role: "admin",
  status: "active",
  orgId: "org",
  orgName: "Acme",
  pin: { required: true, set: true },
  serverApiVersion: 1,
};

function ui(node: ReactNode, role: Me["role"], path: string) {
  return render(
    <ToastProvider>
      <MeContext.Provider value={{ ...admin, role }}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/devices" element={node} />
            <Route path="/devices/:id" element={node} />
          </Routes>
        </MemoryRouter>
      </MeContext.Provider>
    </ToastProvider>,
  );
}

interface ListCall {
  paginationOpts: { numItems: number; cursor: string | null };
  sort?: { key: string; dir: string };
  search?: string;
  groupId?: string;
}

const HOUR = 3_600_000;
const row = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  _id: id,
  name,
  groupId: "g1",
  groupName: "Sales",
  kioskEnabled: true,
  enrolledAt: 1,
  revision: 0,
  presence: { online: true, since: 1, revoked: false },
  summary: { agentVersion: "0.4.0", windowsBuild: "26100", kioskPhase: "applied", outOfSupport: false, appliedVersion: 2, updatedAt: 1 },
  latestVersion: 3,
  ...over,
});

const detail = (over: Record<string, unknown> = {}) => ({
  _id: "d1",
  name: "Front desk",
  revision: 7,
  kioskEnabled: true,
  enrolledAt: Date.now() - 5 * HOUR,
  group: { _id: "g1", name: "Sales" },
  state: "active",
  presence: { online: true, since: 1, revoked: false },
  summary: { agentVersion: "0.4.0", outOfSupport: false, updatedAt: 1 },
  report: { agentVersion: "0.4.0", os: "Windows 11", osBuild: "26100", updatedAt: Date.now() - 60_000 },
  versions: [],
  flags: { noGroup: false, revoked: false, rotateCredential: false },
  groups: [
    { _id: "g1", name: "Sales" },
    { _id: "g2", name: "Back office" },
  ],
  ...over,
});

beforeEach(() => {
  cx.results = {};
  cx.pages = {};
  cx.paged = [];
  cx.queried = [];
  cx.queries = [];
  cx.fns = {};
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.removeAttribute("data-view");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Devices (fleet:list, one server-driven page at a time)", () => {
  const GROUP = { _id: "g1", name: "Sales", createdAt: 1, revision: 0, devices: { count: 1, more: false }, employees: { count: 0, more: false } };
  const listPage = (rows: unknown[], over: Record<string, unknown> = {}) => ({ page: rows, isDone: true, continueCursor: "cur-next", ...over });
  const lastQuery = (name: string) => [...cx.queries].reverse().find((q) => q.name === name);
  const listArgs = () => lastQuery("fleet:list")!.args as unknown as ListCall;
  const DEFAULT_ARGS = { paginationOpts: { numItems: 10, cursor: null }, sort: { key: "created", dir: "desc" } };
  const pagerNav = () => screen.getByRole("navigation", { name: strings.pager.nav });
  const submitSearch = (text: string) => {
    const box = screen.getByRole("searchbox") as HTMLInputElement;
    fireEvent.change(box, { target: { value: text } });
    fireEvent.submit(box.closest("form")!);
  };

  /** `/devices` plus a stand-in detail route, to see where a click goes. */
  function uiNav(path: string) {
    return render(
      <ToastProvider>
        <MeContext.Provider value={{ ...admin, role: "viewer" }}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/devices" element={<Devices />} />
              <Route path="/devices/:id" element={<p>detail page</p>} />
            </Routes>
          </MemoryRouter>
        </MeContext.Provider>
      </ToastProvider>,
    );
  }

  it("shows online and offline from the presence row, the group, the summary and the policy columns", () => {
    cx.results["groups:list"] = [];
    cx.results["fleet:list"] = listPage([
      row("d1", "Front desk"),
      row("d2", "Back office PC", { presence: { online: false, since: Date.now() - 3 * HOUR, revoked: false }, groupId: undefined, groupName: undefined }),
      row("d3", "Never seen", { presence: { online: false, since: null, revoked: false }, summary: null, latestVersion: null }),
    ]);
    ui(<Devices />, "viewer", "/devices");
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]!).getByText(strings.common.online)).toBeTruthy();
    expect(within(rows[1]!).getByText("26100")).toBeTruthy();
    expect(within(rows[2]!).getByText(strings.common.offline)).toBeTruthy();
    expect(within(rows[2]!).getByText(/^since /)).toBeTruthy();
    expect(within(rows[2]!).getByText(devicesStrings.noGroup)).toBeTruthy();
    expect(within(rows[3]!).getByText(strings.common.neverSeen)).toBeTruthy();
    // The viewer sees no admin action.
    expect(screen.queryByRole("button", { name: devicesStrings.checkNow })).toBeNull();
    // One page, newest first, ten rows: the default list arguments.
    expect(listArgs()).toEqual(DEFAULT_ARGS);
    expect(lastQuery("fleet:count")!.args).toEqual({});
  });

  it("passes the group filter to the list and to the count", () => {
    cx.results["groups:list"] = [GROUP];
    ui(<Devices />, "viewer", "/devices?group=g1");
    expect(listArgs()).toEqual({ ...DEFAULT_ARGS, groupId: "g1" });
    expect(lastQuery("fleet:count")!.args).toEqual({ groupId: "g1" });
  });

  it("offers a No group filter: it sends groupId none at once (no waiting for the groups) and keeps it in the URL", () => {
    ui(<Devices />, "viewer", "/devices?group=none");
    expect(listArgs()).toEqual({ ...DEFAULT_ARGS, groupId: "none" });
    expect((screen.getByLabelText(devicesStrings.groupFilter) as HTMLSelectElement).value).toBe("none");
  });

  it("choosing No group in the filter lists the PCs without a group, and All groups goes back", async () => {
    cx.results["groups:list"] = [GROUP];
    ui(<Devices />, "viewer", "/devices");
    const select = screen.getByLabelText(devicesStrings.groupFilter) as HTMLSelectElement;
    expect(within(select).getByRole("option", { name: devicesStrings.noGroupFilter })).toBeTruthy();
    fireEvent.change(select, { target: { value: "none" } });
    await waitFor(() => expect(listArgs()).toEqual({ ...DEFAULT_ARGS, groupId: "none" }));
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(listArgs()).toEqual(DEFAULT_ARGS));
  });

  it("badges a PC that is over the plan limit or suspended; ok, null and a missing state show nothing", () => {
    cx.results["groups:list"] = [];
    cx.results["fleet:list"] = listPage([
      row("d1", "Over PC", { planState: "overLimit" }),
      row("d2", "Suspended PC", { planState: "suspended" }),
      row("d3", "Fine PC", { planState: "ok" }),
      row("d4", "Unpublished PC", { planState: null }),
      row("d5", "Older server PC"),
    ]);
    ui(<Devices />, "viewer", "/devices");
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(within(rows[1]!).getByText(devicesStrings.planOverLimit).getAttribute("title")).toBe(devicesStrings.planOverLimitHint);
    expect(within(rows[2]!).getByText(devicesStrings.planSuspended)).toBeTruthy();
    for (const i of [3, 4, 5]) {
      expect(within(rows[i]!).queryByText(devicesStrings.planOverLimit)).toBeNull();
      expect(within(rows[i]!).queryByText(devicesStrings.planSuspended)).toBeNull();
    }
  });

  it("ignores a group filter that is not a group of this organization and clears it from the URL", async () => {
    cx.results["groups:list"] = [GROUP];
    ui(<Devices />, "viewer", "/devices?group=gone");
    await waitFor(() => expect(listArgs()).toEqual(DEFAULT_ARGS));
    // The unknown id never reaches fleet:list (it would answer not_found).
    expect(cx.queries.some((q) => JSON.stringify(q.args).includes("gone"))).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByLabelText(devicesStrings.groupFilter) as HTMLSelectElement).value).toBe("");
  });

  it("waits for the groups before running a list that has a group filter", () => {
    ui(<Devices />, "viewer", "/devices?group=g1");
    expect(cx.queries.filter((q) => q.name === "fleet:list")).toEqual([]);
  });

  it("searches on Enter, not while typing, at most 100 characters; a search sends no sort (the server ranks by relevance)", async () => {
    cx.results["groups:list"] = [];
    ui(<Devices />, "viewer", "/devices");
    const box = screen.getByRole("searchbox") as HTMLInputElement;
    expect(box.maxLength).toBe(100);
    fireEvent.change(box, { target: { value: "front" } });
    expect(listArgs()).toEqual(DEFAULT_ARGS);
    fireEvent.submit(box.closest("form")!);
    await waitFor(() => expect(listArgs()).toEqual({ paginationOpts: { numItems: 10, cursor: null }, search: "front" }));
    expect(lastQuery("fleet:count")!.args).toEqual({ search: "front" });
    submitSearch("x".repeat(150));
    await waitFor(() => expect(listArgs().search).toBe("x".repeat(100)));
    // The sort headers are inactive while the matches come by relevance.
    expect(screen.getByText(strings.table.byRelevance)).toBeTruthy();
  });

  it("keeps the page, page size, sort, search and group in the URL and reads them back; invalid values fall back to the defaults", () => {
    cx.results["groups:list"] = [GROUP];
    cx.results["fleet:list"] = listPage([row("d1", "Front desk")]);
    ui(<Devices />, "viewer", "/devices?size=25&sort=name&dir=desc&group=g1");
    expect(listArgs()).toEqual({ paginationOpts: { numItems: 25, cursor: null }, groupId: "g1", sort: { key: "name", dir: "desc" } });
    expect((screen.getByLabelText(strings.pager.rowsPerPage) as HTMLSelectElement).value).toBe("25");
    cleanup();
    cx.queries = [];
    ui(<Devices />, "viewer", "/devices?size=7&sort=bogus&dir=sideways&page=-3");
    expect(listArgs()).toEqual(DEFAULT_ARGS);
    expect((screen.getByLabelText(strings.pager.rowsPerPage) as HTMLSelectElement).value).toBe("10");
  });

  it("a header click sorts on the server (name first A-Z, then Z-A); the active column says so with aria-sort", async () => {
    cx.results["groups:list"] = [];
    cx.results["fleet:list"] = listPage([row("d1", "Front desk")]);
    ui(<Devices />, "viewer", "/devices");
    const header = (name: string) => screen.getByRole("columnheader", { name: new RegExp(name) });
    expect(header(devicesStrings.colEnrolled).getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(within(header(devicesStrings.colName)).getByRole("button"));
    await waitFor(() => expect(listArgs().sort).toEqual({ key: "name", dir: "asc" }));
    expect(header(devicesStrings.colName).getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(within(header(devicesStrings.colName)).getByRole("button"));
    await waitFor(() => expect(listArgs().sort).toEqual({ key: "name", dir: "desc" }));
    // Columns the server cannot sort by are no buttons.
    expect(within(header(devicesStrings.colStatus)).queryByRole("button")).toBeNull();
  });

  it("shows the total and the page count; with a search or one group there is no total, only Page N", () => {
    cx.results["groups:list"] = [GROUP];
    cx.results["fleet:count"] = { total: 524 };
    cx.results["fleet:list"] = listPage([row("d1", "Front desk")], { isDone: false });
    ui(<Devices />, "viewer", "/devices");
    expect(screen.getByText(`${strings.pager.records(524)} · ${strings.pager.pageOf(1, 53)}`)).toBeTruthy();
    expect(within(pagerNav()).getByRole("button", { name: strings.pager.goTo(53) })).toBeTruthy();
    cleanup();
    cx.results["fleet:count"] = { total: null };
    ui(<Devices />, "viewer", "/devices?group=g1");
    expect(screen.getByText(strings.pager.page(1))).toBeTruthy();
    expect(within(pagerNav()).queryByRole("button", { name: strings.pager.goTo(53) })).toBeNull();
  });

  it("Next page asks for the cursor the server gave; a sort, search or page size change starts over on page 1", async () => {
    cx.results["groups:list"] = [];
    cx.results["fleet:count"] = { total: 524 };
    cx.results["fleet:list"] = listPage([row("d1", "Front desk")], { isDone: false, continueCursor: "cur-2" });
    ui(<Devices />, "viewer", "/devices");
    fireEvent.click(screen.getByRole("button", { name: strings.pager.next }));
    await waitFor(() => expect(listArgs().paginationOpts).toEqual({ numItems: 10, cursor: "cur-2" }));
    expect(screen.getByText(`${strings.pager.records(524)} · ${strings.pager.pageOf(2, 53)}`)).toBeTruthy();
    fireEvent.click(within(screen.getByRole("columnheader", { name: new RegExp(devicesStrings.colName) })).getByRole("button"));
    await waitFor(() => expect(listArgs().paginationOpts).toEqual({ numItems: 10, cursor: null }));
    expect(screen.getByText(`${strings.pager.records(524)} · ${strings.pager.pageOf(1, 53)}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.pager.next }));
    await waitFor(() => expect(listArgs().paginationOpts.cursor).toBe("cur-2"));
    fireEvent.change(screen.getByLabelText(strings.pager.rowsPerPage), { target: { value: "25" } });
    await waitFor(() => expect(listArgs().paginationOpts).toEqual({ numItems: 25, cursor: null }));
    fireEvent.click(screen.getByRole("button", { name: strings.pager.next }));
    await waitFor(() => expect(listArgs().paginationOpts.cursor).toBe("cur-2"));
    submitSearch("fro");
    await waitFor(() => expect(listArgs()).toEqual({ paginationOpts: { numItems: 25, cursor: null }, search: "fro" }));
  });

  it("the last page is the same list read in the opposite order with total mod page size rows, shown reversed", async () => {
    cx.results["groups:list"] = [];
    cx.results["fleet:count"] = { total: 524 };
    cx.results["fleet:list"] = listPage([row("d1", "Front desk")], { isDone: false });
    ui(<Devices />, "viewer", "/devices");
    cx.results["fleet:list"] = listPage([row("a", "Newest"), row("b", "Second"), row("c", "Third"), row("d", "Fourth")], { isDone: true });
    fireEvent.click(within(pagerNav()).getByRole("button", { name: strings.pager.goTo(53) }));
    await waitFor(() => expect(listArgs()).toEqual({ paginationOpts: { numItems: 4, cursor: null }, sort: { key: "created", dir: "asc" } }));
    const names = within(screen.getByRole("table"))
      .getAllByRole("row")
      .slice(1)
      .map((r) => within(r).getAllByRole("link")[0]!.textContent);
    // The server's reverse read comes oldest first; the screen shows the usual order.
    expect(names).toEqual(["Fourth", "Third", "Second", "Newest"]);
    expect(screen.getByText(`${strings.pager.records(524)} · ${strings.pager.pageOf(53, 53)}`)).toBeTruthy();
  });

  it("the whole row opens the PC and the name stays a real link", async () => {
    cx.results["groups:list"] = [];
    cx.results["fleet:list"] = listPage([row("d1", "Front desk")]);
    uiNav("/devices");
    const link = screen.getByRole("link", { name: "Front desk" });
    expect(link.getAttribute("href")).toBe("/devices/d1");
    fireEvent.click(within(screen.getByRole("table")).getByText("26100"));
    expect(await screen.findByText("detail page")).toBeTruthy();
  });

  it("the cards view draws the same rows as cards, with a sort select", () => {
    cx.results["groups:list"] = [];
    cx.results["fleet:list"] = listPage([row("d1", "Front desk")]);
    ui(<Devices />, "viewer", "/devices");
    fireEvent.click(screen.getByRole("radio", { name: strings.table.viewCards }));
    expect(document.documentElement.getAttribute("data-view")).toBe("cards");
    expect(screen.queryByRole("region", { name: devicesStrings.title })).toBeNull();
    expect(screen.getByRole("link", { name: "Front desk" })).toBeTruthy();
    const select = screen.getByLabelText(strings.table.sortSelect) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "name:asc" } });
    expect(listArgs().sort).toEqual({ key: "name", dir: "asc" });
  });

  it("Check now asks the PCs of a page of 50", async () => {
    cx.results["groups:list"] = [];
    cx.results["fleet:list"] = listPage(Array.from({ length: 50 }, (_, i) => row(`d${i}`, `PC ${i}`)));
    const checkNow = vi.fn(async () => ({ checkId: "c1" }));
    cx.fns["fleet:checkNow"] = checkNow;
    ui(<Devices />, "admin", "/devices?size=50");
    expect(listArgs().paginationOpts).toEqual({ numItems: 50, cursor: null });
    fireEvent.click(screen.getByRole("button", { name: devicesStrings.checkNow }));
    await waitFor(() => expect(checkNow).toHaveBeenCalledOnce());
    const calls = checkNow.mock.calls as unknown as [{ deviceIds: string[] }][];
    expect(calls[0]![0].deviceIds).toHaveLength(50);
  });

  it("an empty fleet points an admin at the enrollment screen; an empty filter says nothing matches", () => {
    cx.results["groups:list"] = [GROUP];
    cx.results["fleet:list"] = listPage([]);
    ui(<Devices />, "admin", "/devices");
    expect(screen.getByText(devicesStrings.emptyTitle)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /enrollment code|Add a PC/i }).length).toBeGreaterThan(0);
    cleanup();
    ui(<Devices />, "admin", "/devices?group=g1");
    expect(screen.getByText(devicesStrings.noMatchTitle)).toBeTruthy();
    cleanup();
    ui(<Devices />, "admin", "/devices?q=zzz");
    expect(screen.getByText(strings.table.noResults("zzz"))).toBeTruthy();
  });

  it("Check now asks the visible, non-revoked PCs and shows who answered", async () => {
    cx.results["groups:list"] = [];
    cx.results["fleet:list"] = listPage([row("d1", "Front desk"), row("d2", "Old PC", { presence: { online: false, since: 1, revoked: true } })]);
    const checkNow = vi.fn(async () => ({ checkId: "c1" }));
    cx.fns["fleet:checkNow"] = checkNow;
    ui(<Devices />, "admin", "/devices");
    cx.results["fleet:checkResult"] = { requestedAt: 1, items: [{ deviceId: "d1", answered: true }] };
    fireEvent.click(screen.getByRole("button", { name: devicesStrings.checkNow }));
    await waitFor(() => expect(checkNow).toHaveBeenCalledWith({ deviceIds: ["d1"] }));
    expect(await screen.findByText(devicesStrings.checkResult(1, 1))).toBeTruthy();
  });

  it("Check now: the 1-per-minute limit is shown as a sentence", async () => {
    cx.results["groups:list"] = [];
    cx.results["fleet:list"] = listPage([row("d1", "Front desk")]);
    cx.fns["fleet:checkNow"] = vi.fn(async () => {
      throw new ConvexError({ code: "rate_limited" });
    });
    ui(<Devices />, "admin", "/devices");
    fireEvent.click(screen.getByRole("button", { name: devicesStrings.checkNow }));
    expect(await screen.findByText(strings.errors.rateLimited)).toBeTruthy();
  });

  it("a failing list is a visible error with Try again, not a blank page", () => {
    cx.results["groups:list"] = [];
    cx.results["fleet:list"] = new ConvexError({ code: "internal" });
    ui(<Devices />, "viewer", "/devices");
    expect(screen.getByRole("alert").textContent).toContain(strings.common.regionFailed);
  });
});

describe("DeviceDetail (fleet:get)", () => {
  const open = (role: Me["role"] = "admin") => ui(<DeviceDetail />, role, "/devices/d1");

  it("shows the PC, its last contact and asks for watch mode while visible", async () => {
    cx.results["fleet:get"] = detail();
    cx.results["fleet:liveness"] = { lastContactAt: Date.now() - 20_000, online: true, fastUntil: null };
    const watch = vi.fn(async () => ({ fastUntil: Date.now() + 300_000 }));
    cx.fns["fleet:watch"] = watch;
    open();
    expect(screen.getByRole("heading", { level: 1, name: "Front desk" })).toBeTruthy();
    expect(screen.getByText(deviceStrings.lastContact)).toBeTruthy();
    await waitFor(() => expect(watch).toHaveBeenCalledWith({ deviceId: "d1" }));
  });

  it("lists the signing keys the PC trusts; reported empty it warns, reported nothing (older agent) it shows a dash and no warning", () => {
    cx.fns["fleet:watch"] = vi.fn(async () => ({ fastUntil: null }));
    cx.results["fleet:liveness"] = { lastContactAt: Date.now() - 20_000, online: true, fastUntil: null };
    const withKeys = (trustedKeyIds?: string[]) => detail({ report: { agentVersion: "0.4.0", os: "Windows 11", osBuild: "26100", updatedAt: Date.now() - 60_000, trustedKeyIds } });
    cx.results["fleet:get"] = withKeys(["a3f19c07d2e8b456", "00112233445566ff"]);
    open();
    expect(screen.getByText(deviceStrings.trustedKeys)).toBeTruthy();
    expect(screen.getByText("a3f19c07d2e8b456")).toBeTruthy();
    expect(screen.getByText("00112233445566ff")).toBeTruthy();
    expect(screen.queryByText(deviceStrings.noTrustedKeyTitle)).toBeNull();
    cleanup();
    cx.results["fleet:get"] = withKeys([]);
    open();
    expect(screen.getByText(deviceStrings.noTrustedKeyTitle)).toBeTruthy();
    expect(screen.getByText(deviceStrings.trustedKeysNone)).toBeTruthy();
    cleanup();
    cx.results["fleet:get"] = withKeys(undefined);
    open();
    expect(screen.queryByText(deviceStrings.noTrustedKeyTitle)).toBeNull();
  });

  describe("compatibility card (Phase 6 Step 6)", () => {
    const os = { build: 26100, ubr: 1, displayVersion: "24H2", editionId: "Professional", productType: 1, arch: "x86_64", sMode: false, domainJoined: false, entraJoined: false, ramMb: 8192, systemDiskFreeGb: 50 };
    const withCompat = (compat: Record<string, unknown>) => {
      cx.fns["fleet:watch"] = vi.fn(async () => ({ fastUntil: null }));
      cx.results["fleet:liveness"] = { lastContactAt: Date.now() - 20_000, online: true, fastUntil: null };
      cx.results["fleet:get"] = detail({ report: { agentVersion: "0.4.0", os: "Windows 11", osBuild: "26100", updatedAt: Date.now() - 60_000, compat } });
    };
    const card = () => within(screen.getByRole("region", { name: deviceStrings.compat }));

    it("shows Full protection, the WebView2 version and the browsers found", () => {
      withCompat({
        os, blockers: [], warnings: [], liteMode: false,
        webview2: { present: true, version: "131.0.2903.51", source: "machine" },
        protection: "full", layers: { appLocker: true, appControl: true },
        browsers: { edge: true, chrome: true }, protectedPrint: false, lowRam: false,
      });
      ui(<DeviceDetail />, "admin", "/devices/d1");
      expect(card().getByText(deviceStrings.protection)).toBeTruthy();
      expect(card().getByText(deviceStrings.protectionFull)).toBeTruthy();
      expect(card().queryByText(deviceStrings.reducedTitle)).toBeNull();
      expect(card().getByText("131.0.2903.51")).toBeTruthy();
      expect(card().getByText("Edge, Chrome")).toBeTruthy();
      expect(card().getByText(deviceStrings.noIssues)).toBeTruthy();
    });

    it("shows Reduced protection with the missing layers, a missing WebView2 and the warnings in words", () => {
      withCompat({
        os: { ...os, editionId: "CoreSingleLanguage" }, blockers: [], warnings: ["webview2_missing", "protected_print_on", "future_code"], liteMode: true,
        webview2: { present: false, version: null, source: "none" },
        protection: "reduced", layers: { appLocker: false, appControl: true },
        browsers: { edge: false, chrome: false }, protectedPrint: true, lowRam: false,
      });
      ui(<DeviceDetail />, "admin", "/devices/d1");
      expect(card().getByText(deviceStrings.protectionReduced)).toBeTruthy();
      expect(card().getByText(deviceStrings.reducedTitle)).toBeTruthy();
      expect(card().getByText(deviceStrings.reducedDetail([deviceStrings.layerAppLocker]))).toBeTruthy();
      expect(card().getByText(deviceStrings.webview2Missing)).toBeTruthy();
      expect(card().getByText(deviceStrings.browsersNone)).toBeTruthy();
      const words = [deviceStrings.compatCode("webview2_missing"), deviceStrings.compatCode("protected_print_on"), "future_code"].join(" ");
      expect(card().getByText(words)).toBeTruthy();
      // A warning is not a blocker: no blocker notice, no "no issues".
      expect(card().queryByText(deviceStrings.blockers)).toBeNull();
      expect(card().queryByText(deviceStrings.noIssues)).toBeNull();
    });

    it("an older agent's report (no Phase 6 fields) shows dashes, never a wrong level", () => {
      withCompat({ os, blockers: [], warnings: [], liteMode: false });
      ui(<DeviceDetail />, "admin", "/devices/d1");
      expect(card().getByText(deviceStrings.protectionNotReported)).toBeTruthy();
      expect(card().queryByText(deviceStrings.protectionFull)).toBeNull();
      expect(card().queryByText(deviceStrings.reducedTitle)).toBeNull();
      expect(card().getAllByText(deviceStrings.notReported)).toHaveLength(2);
    });

    it("a blocker after the WebView2 install attempt is shown as a blocker", () => {
      withCompat({ os, blockers: ["webview2_too_old"], warnings: [], liteMode: false, webview2: { present: true, version: "124.0.1", source: "machine" } });
      ui(<DeviceDetail />, "admin", "/devices/d1");
      expect(card().getByText(deviceStrings.blockers)).toBeTruthy();
      expect(card().getByText(deviceStrings.compatCode("webview2_too_old"))).toBeTruthy();
    });
  });

  it("subscribes to liveness next to fleet:get, and a PC that pinged but never reported still shows its last contact", () => {
    // fleet:get has not answered yet: liveness is already requested (no waterfall).
    cx.results["fleet:liveness"] = { lastContactAt: Date.now() - 20_000, online: true, fastUntil: null };
    open();
    expect(cx.queried).toContain("fleet:liveness");

    cx.results["fleet:get"] = detail({ report: null });
    cx.fns["fleet:watch"] = vi.fn(async () => ({ fastUntil: null }));
    cleanup();
    open();
    expect(screen.getByText(deviceStrings.lastContact)).toBeTruthy();
    expect(screen.queryByText(strings.common.neverSeen)).toBeNull();
    // The report-less Status card and the Compatibility card both say there is no report yet.
    expect(screen.getAllByText(deviceStrings.compatNone)).toHaveLength(2);
  });

  it("shows a dash, not 'Not seen yet', when the liveness query fails; 'Not seen yet' when it says never", () => {
    cx.results["fleet:get"] = detail();
    cx.fns["fleet:watch"] = vi.fn(async () => ({ fastUntil: null }));
    cx.results["fleet:liveness"] = new ConvexError({ code: "internal" });
    open();
    expect(screen.queryByText(strings.common.neverSeen)).toBeNull();
    cleanup();
    cx.results["fleet:liveness"] = { lastContactAt: null, online: false, fastUntil: null };
    open();
    expect(screen.getByText(strings.common.neverSeen)).toBeTruthy();
  });

  it("renews watch mode every 4 minutes and stops when the page closes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    cx.results["fleet:get"] = detail();
    const watch = vi.fn(async () => ({ fastUntil: null }));
    cx.fns["fleet:watch"] = watch;
    const view = open();
    expect(watch).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(4 * 60_000);
    });
    expect(watch).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => {
      vi.advanceTimersByTime(8 * 60_000);
    });
    expect(watch).toHaveBeenCalledTimes(2);
  });

  it("a revoked PC is not watched and offers Remove", () => {
    cx.results["fleet:get"] = detail({ state: "revoked", presence: { online: false, since: 5, revoked: true }, flags: { noGroup: false, revoked: true, rotateCredential: false } });
    const watch = vi.fn(async () => ({ fastUntil: null }));
    cx.fns["fleet:watch"] = watch;
    open();
    expect(watch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: strings.common.remove })).toBeTruthy();
  });

  it("warns when the PC has no group", () => {
    cx.results["fleet:get"] = detail({ group: null, flags: { noGroup: true, revoked: false, rotateCredential: false } });
    cx.fns["fleet:watch"] = vi.fn(async () => ({ fastUntil: null }));
    open();
    expect(screen.getByText(deviceStrings.noGroupWarning)).toBeTruthy();
  });

  it("kiosk off sends the revision, and the fresh step-up dialog is retried once", async () => {
    cx.results["fleet:get"] = detail();
    cx.fns["fleet:watch"] = vi.fn(async () => ({ fastUntil: null }));
    const setKiosk = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "step_up_required" }))
      .mockResolvedValueOnce({ revision: 8 });
    cx.fns["fleet:setKiosk"] = setKiosk;
    const handler = vi.fn(async () => true);
    const off = setStepUpHandler(handler);
    open();
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(setKiosk).toHaveBeenCalledTimes(2));
    expect(setKiosk).toHaveBeenLastCalledWith({ deviceId: "d1", expectedRevision: 7, enabled: false });
    expect(handler).toHaveBeenCalledOnce();
    off();
  });

  it("revoke needs the PC's name typed, then calls fleet:revoke", async () => {
    cx.results["fleet:get"] = detail();
    cx.fns["fleet:watch"] = vi.fn(async () => ({ fastUntil: null }));
    const revoke = vi.fn(async () => null);
    cx.fns["fleet:revoke"] = revoke;
    open();
    fireEvent.click(screen.getByRole("button", { name: deviceStrings.revoke }));
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: deviceStrings.revoke });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Front desk" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(revoke).toHaveBeenCalledWith({ deviceId: "d1" }));
  });

  it("move sends the revision; a viewer sees no actions; an unknown PC says not found", async () => {
    cx.results["fleet:get"] = detail();
    cx.fns["fleet:watch"] = vi.fn(async () => ({ fastUntil: null }));
    const move = vi.fn(async () => ({ revision: 8 }));
    cx.fns["fleet:move"] = move;
    const view = open();
    // (Phase 5 Step 19 added the ring and "Allow USB" selects: the group picker is named.)
    fireEvent.change(screen.getByLabelText(deviceStrings.group), { target: { value: "g2" } });
    fireEvent.click(screen.getByRole("button", { name: deviceStrings.move }));
    await waitFor(() => expect(move).toHaveBeenCalledWith({ deviceId: "d1", expectedRevision: 7, groupId: "g2" }));
    view.unmount();

    open("viewer");
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: deviceStrings.revoke })).toBeNull();
    expect(screen.queryByRole("button", { name: strings.common.rename })).toBeNull();
  });

  it("an unknown PC is a visible error (not_found has no Try again), not a blank page", () => {
    cx.results["fleet:get"] = new ConvexError({ code: "not_found" });
    open();
    expect(screen.getByRole("alert").textContent).toContain(strings.common.regionFailed);
    expect(screen.queryByRole("button", { name: strings.common.tryAgain })).toBeNull();
  });
});
