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
import { optionLabels, pickOption, selectedText } from "../test/select";
import { deviceText } from "./device/strings";
import { ringErrorMessage, settingsText } from "./device/settingsStrings";
import { deviceLockdownStrings as ds } from "./lockdown/deviceStrings";
import { problemStrings, COMPAT_RULES, COMPAT_WARNING_FALLBACK } from "./device/problemStrings";
import { lockStrings } from "./broadcasts/strings";
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

const page = (over: Record<string, unknown> = {}) => ({
  _id: "d1",
  name: "Front desk",
  revision: 7,
  kioskEnabled: true,
  enrolledAt: Date.now() - 5 * HOUR,
  group: { _id: "g1", name: "Sales" },
  presence: { online: true, since: 1, revoked: false },
  outOfSupport: false,
  latestVersion: 3,
  planState: "ok",
  report: { agentVersion: "0.4.0", os: "Windows 11", osBuild: "26100", appliedVersion: 3, updatedAt: Date.now() - 60_000 },
  flags: { noGroup: false, revoked: false, rotateCredential: false },
  lock: null,
  failedInstalls: { count: 0, more: false, names: [] },
  network: { wifiFailed: 0, printersFailed: 0 },
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
    expect(selectedText(devicesStrings.groupFilter)).toBe(devicesStrings.noGroupFilter);
  });

  it("choosing No group in the filter lists the PCs without a group, and All groups goes back", async () => {
    cx.results["groups:list"] = [GROUP];
    ui(<Devices />, "viewer", "/devices");
    expect(optionLabels(devicesStrings.groupFilter)).toEqual([devicesStrings.allGroups, devicesStrings.noGroupFilter, "Sales"]);
    pickOption(devicesStrings.groupFilter, devicesStrings.noGroupFilter);
    await waitFor(() => expect(listArgs()).toEqual({ ...DEFAULT_ARGS, groupId: "none" }));
    pickOption(devicesStrings.groupFilter, devicesStrings.allGroups);
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
    expect(selectedText(devicesStrings.groupFilter)).toBe(devicesStrings.allGroups);
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

  it("keeps the page, page size, sort, search and group in the URL and reads them back; invalid values fall back to the defaults", async () => {
    cx.results["groups:list"] = [GROUP];
    cx.results["fleet:list"] = listPage([row("d1", "Front desk")], { isDone: false });
    ui(<Devices />, "viewer", "/devices?size=25&sort=name&dir=desc&group=g1");
    expect(listArgs()).toEqual({ paginationOpts: { numItems: 25, cursor: null }, groupId: "g1", sort: { key: "name", dir: "desc" } });
    await screen.findByLabelText(strings.pager.rowsPerPage);
    expect(selectedText(strings.pager.rowsPerPage)).toBe("25");
    cleanup();
    cx.queries = [];
    // More rows follow, so the pager (with its size select) shows.
    cx.results["fleet:list"] = listPage([row("d1", "Front desk")], { isDone: false });
    ui(<Devices />, "viewer", "/devices?size=7&sort=bogus&dir=sideways&page=-3");
    expect(listArgs()).toEqual(DEFAULT_ARGS);
    await screen.findByLabelText(strings.pager.rowsPerPage);
    expect(selectedText(strings.pager.rowsPerPage)).toBe("10");
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
    await screen.findByLabelText(strings.pager.rowsPerPage); // the dropdown is a lazy chunk
    pickOption(strings.pager.rowsPerPage, "25");
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

  it("the cards view draws the same rows as cards, with a sort select", async () => {
    cx.results["groups:list"] = [];
    cx.results["fleet:list"] = listPage([row("d1", "Front desk")]);
    ui(<Devices />, "viewer", "/devices");
    fireEvent.click(screen.getByRole("radio", { name: strings.table.viewCards }));
    expect(document.documentElement.getAttribute("data-view")).toBe("cards");
    expect(await screen.findByRole("list", { name: devicesStrings.title })).toBeTruthy();
    expect(screen.queryByRole("region", { name: devicesStrings.title })).toBeNull();
    expect(screen.getByRole("link", { name: "Front desk" })).toBeTruthy();
    await screen.findByLabelText(strings.table.sortSelect);
    pickOption(strings.table.sortSelect, "Name: A to Z");
    expect(listArgs().sort).toEqual({ key: "name", dir: "asc" });
  });

  it("the cards put the group under the name, the alerts with the status, the policy in words and the Windows line last", async () => {
    cx.results["groups:list"] = [];
    cx.results["fleet:list"] = listPage([
      row("d1", "Front desk", {
        planState: "overLimit",
        summary: { agentVersion: "0.4.0", windowsBuild: "26100", kioskPhase: "applied", outOfSupport: true, appliedVersion: 3, updatedAt: 1 },
      }),
      row("d2", "Back office", { groupId: undefined, groupName: undefined }),
    ]);
    ui(<Devices />, "viewer", "/devices");
    fireEvent.click(screen.getByRole("radio", { name: strings.table.viewCards }));
    const [first, second] = within(await screen.findByRole("list", { name: devicesStrings.title })).getAllByRole("listitem");
    // Name, group under it, then the status pills (online, kiosk, over the limit, out of support).
    expect(within(first!).getByRole("link", { name: "Front desk" })).toBeTruthy();
    expect(within(first!).getByText("Sales")).toBeTruthy();
    for (const word of [strings.common.online, devicesStrings.planOverLimit, devicesStrings.outOfSupport]) expect(within(first!).getByText(word)).toBeTruthy();
    // The policy in words; the numbers are in the tooltip, never on the card.
    expect(within(first!).getByText(devicesStrings.policyUpToDate)).toBeTruthy();
    const waiting = within(second!).getByText(devicesStrings.policyWaiting);
    expect(waiting.getAttribute("title")).toBe(devicesStrings.policyWaitingHint(2, 3));
    expect(first!.textContent).not.toMatch(/\bv\d/);
    expect(within(second!).getByText(devicesStrings.noGroup)).toBeTruthy();
    // The Windows build and the agent are the last, muted line.
    expect(within(first!).getByText(devicesStrings.windowsDetail("26100", "0.4.0"))).toBeTruthy();
    expect(within(second!).queryByText(devicesStrings.planOverLimit)).toBeNull();
  });

  it("the table shows the policy in words and keeps Windows last; Check now is in the list's toolbar, not above it", () => {
    cx.results["groups:list"] = [];
    cx.results["fleet:list"] = listPage([row("d1", "Front desk"), row("d2", "Back office", { summary: { windowsBuild: "26100", appliedVersion: 3, updatedAt: 1 } })]);
    ui(<Devices />, "admin", "/devices");
    const heads = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads.slice(0, 6)).toEqual([devicesStrings.colName, devicesStrings.colStatus, devicesStrings.colKiosk, devicesStrings.colPolicy, expect.stringContaining(devicesStrings.colEnrolled), devicesStrings.colWindows]);
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(within(rows[1]!).getByText(devicesStrings.policyWaiting)).toBeTruthy();
    expect(within(rows[2]!).getByText(devicesStrings.policyUpToDate)).toBeTruthy();
    expect(screen.getByRole("button", { name: devicesStrings.checkNow }).closest(".dash-dt__toolbar")).not.toBeNull();
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

describe("DeviceDetail (fleet:page)", () => {
  const open = (role: Me["role"] = "admin", path = "/devices/d1") => ui(<DeviceDetail />, role, path);
  const live = (lastContactAt: number | null = Date.now() - 20_000) => {
    cx.results["fleet:liveness"] = { lastContactAt, online: true, fastUntil: null };
  };
  const report = (over: Record<string, unknown> = {}) => ({ agentVersion: "0.4.0", os: "Windows 11", osBuild: "26100", appliedVersion: 3, updatedAt: Date.now() - 60_000, ...over });
  beforeEach(() => {
    cx.fns["fleet:watch"] = vi.fn(async () => ({ fastUntil: null }));
  });

  it("shows the PC, its state and what it is, and asks for watch mode while visible", async () => {
    cx.results["fleet:page"] = page();
    live();
    const watch = vi.fn(async () => ({ fastUntil: Date.now() + 300_000 }));
    cx.fns["fleet:watch"] = watch;
    open();
    expect(screen.getByRole("heading", { level: 1, name: "Front desk" })).toBeTruthy();
    expect(screen.getByText(deviceText.onlineAgo(deviceText.justNow))).toBeTruthy();
    expect(screen.getByText(deviceText.kioskWaiting)).toBeTruthy();
    const meta = within(screen.getByRole("list", { name: deviceText.metaLabel }));
    expect(meta.getByRole("link", { name: "Sales" }).getAttribute("href")).toBe("/groups/g1");
    expect(meta.getByText("Windows 11")).toBeTruthy();
    expect(meta.getByText(deviceText.rulebox("0.4.0"))).toBeTruthy();
    await waitFor(() => expect(watch).toHaveBeenCalledWith({ deviceId: "d1" }));
  });

  it("an up-to-date, healthy PC says nothing needs attention; the tiles say why", () => {
    cx.results["fleet:page"] = page({ report: report({ kioskPhase: "applied" }) });
    live();
    open();
    expect(screen.getByText(deviceText.allClear)).toBeTruthy();
    const tiles = within(screen.getByRole("list", { name: deviceText.tilesLabel }));
    expect(tiles.getByText(deviceText.tile.upToDate)).toBeTruthy();
    expect(tiles.getByText(deviceText.tile.noFailures)).toBeTruthy();
    expect(screen.getByText(deviceText.kioskOn)).toBeTruthy();
  });

  it("lists the signing keys the PC trusts in the technical details; reported empty it is a problem, reported nothing (older agent) it is not", () => {
    live();
    const withKeys = (trustedKeyIds?: string[]) => page({ report: report({ trustedKeyIds }) });
    cx.results["fleet:page"] = withKeys(["a3f19c07d2e8b456", "00112233445566ff"]);
    open();
    expect(screen.getByText(deviceText.techKeys)).toBeTruthy();
    expect(screen.getByText("a3f19c07d2e8b456, 00112233445566ff")).toBeTruthy();
    expect(screen.queryByText(problemStrings.untrusted.title)).toBeNull();
    cleanup();
    cx.results["fleet:page"] = withKeys([]);
    open();
    expect(screen.getByText(problemStrings.untrusted.title)).toBeTruthy();
    expect(screen.getAllByText(deviceText.techKeysNone).length).toBeGreaterThanOrEqual(1);
    cleanup();
    cx.results["fleet:page"] = withKeys(undefined);
    open();
    expect(screen.queryByText(problemStrings.untrusted.title)).toBeNull();
    expect(screen.queryByText(deviceText.techKeys)).toBeNull();
  });

  describe("what the compatibility report says (Phase 6 Step 6)", () => {
    const os = { build: 26100, ubr: 1, displayVersion: "24H2", editionId: "Professional", productType: 1, arch: "x86_64", sMode: false, domainJoined: false, entraJoined: false, ramMb: 8192, systemDiskFreeGb: 50 };
    const withCompat = (compat: Record<string, unknown>) => {
      live();
      cx.results["fleet:page"] = page({ report: report({ compat }) });
    };

    it("tells the Windows edition, the browsers found and the WebView2 version (in the technical details)", () => {
      withCompat({
        os, blockers: [], warnings: [], liteMode: false,
        webview2: { present: true, version: "131.0.2903.51", source: "machine" },
        protection: "full", layers: { appLocker: true, appControl: true },
        browsers: { edge: true, chrome: true }, protectedPrint: false, lowRam: false,
      });
      open();
      const about = within(screen.getByRole("region", { name: deviceText.about }));
      expect(about.getByText("Windows 11 Pro, 24H2")).toBeTruthy();
      expect(about.getByText("Edge, Chrome")).toBeTruthy();
      expect(about.getByText("8 GB")).toBeTruthy();
      expect(about.getByText("131.0.2903.51")).toBeTruthy();
      expect(screen.getByText(deviceText.allClear)).toBeTruthy();
      expect(screen.queryByText(deviceText.companyDomain)).toBeNull();
    });

    it("turns warnings into problems in words (an unknown code gets the generic title), Home as Home, and Reduced into a Protection notice", async () => {
      withCompat({
        os: { ...os, editionId: "CoreSingleLanguage", domainJoined: true }, blockers: [], warnings: ["webview2_missing", "protected_print_on", "future_code"], liteMode: true,
        webview2: { present: false, version: null, source: "none" },
        protection: "reduced", layers: { appLocker: false, appControl: true },
        browsers: { edge: false, chrome: false }, protectedPrint: true, lowRam: false,
      });
      open();
      expect(screen.getByText(COMPAT_RULES.webview2_missing!.title)).toBeTruthy();
      expect(screen.getByText(COMPAT_RULES.protected_print_on!.title)).toBeTruthy();
      expect(screen.getByText(COMPAT_WARNING_FALLBACK.title)).toBeTruthy();
      // The raw code is for support only: in the technical details, never in a title.
      expect(screen.getAllByText("future_code").length).toBeGreaterThanOrEqual(1);
      const about = within(screen.getByRole("region", { name: deviceText.about }));
      expect(about.getByText("Windows 11 Home, 24H2")).toBeTruthy();
      expect(about.getByText(deviceText.browsersNone)).toBeTruthy();
      expect(about.getByText(deviceText.companyDomain)).toBeTruthy();
      expect(about.getByText(new RegExp(deviceText.lite))).toBeTruthy();
      expect(screen.queryByText(deviceText.allClear)).toBeNull();
      fireEvent.click(screen.getByRole("tab", { name: /Protection/ }));
      expect(await screen.findByText(ds.reducedTitle)).toBeTruthy();
      expect(screen.getByText(ds.reducedDetail([ds.layerAppLocker]))).toBeTruthy();
    });

    it("an older agent's report (no Phase 6 fields) shows no browsers row and no notice, never a wrong value", async () => {
      withCompat({ os, blockers: [], warnings: [], liteMode: false });
      open();
      expect(screen.queryByText(deviceText.browsers)).toBeNull();
      fireEvent.click(screen.getByRole("tab", { name: /Protection/ }));
      // The Lockdown card has nothing reported to show; there is no notice about a layer the report does not mention.
      expect(await screen.findByText(ds.lockdownTitle)).toBeTruthy();
      expect(screen.queryByText(ds.reducedTitle)).toBeNull();
    });

    it("a blocker after the WebView2 install attempt is a red problem", () => {
      withCompat({ os, blockers: ["webview2_too_old"], warnings: [], liteMode: false, webview2: { present: true, version: "124.0.1", source: "machine" } });
      open();
      const card = screen.getByText(COMPAT_RULES.webview2_too_old!.title).closest("article") as HTMLElement;
      expect(card.getAttribute("data-severity")).toBe("danger");
    });
  });

  it("subscribes to liveness next to fleet:page, and a PC that pinged but never reported still says so", () => {
    // fleet:page has not answered yet: liveness is already requested (no waterfall).
    live();
    open();
    expect(cx.queried).toContain("fleet:liveness");
    cleanup();

    cx.results["fleet:page"] = page({ report: null });
    open();
    expect(screen.getByText(deviceText.noReport)).toBeTruthy();
    expect(screen.queryByText(problemStrings.neverSeen.title)).toBeNull();
    cleanup();
    // The server says this PC never called in: a note with the way to add it.
    live(null);
    open();
    expect(screen.getByText(problemStrings.neverSeen.title)).toBeTruthy();
    expect(screen.getByRole("link", { name: problemStrings.neverSeen.action }).getAttribute("href")).toBe("/enrollment");
  });

  it("shows 'Offline', not 'Not connected yet', when the liveness query fails; 'Not connected yet' when it says never", () => {
    cx.results["fleet:page"] = page({ presence: { online: false, since: null, revoked: false }, report: null });
    cx.results["fleet:liveness"] = new ConvexError({ code: "internal" });
    open();
    expect(screen.queryByText(deviceText.notConnected)).toBeNull();
    expect(screen.getByText(deviceText.offline)).toBeTruthy();
    cleanup();
    cx.results["fleet:liveness"] = { lastContactAt: null, online: false, fastUntil: null };
    open();
    expect(screen.getByText(deviceText.notConnected)).toBeTruthy();
  });

  it("renews watch mode every 4 minutes and stops when the page closes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    cx.results["fleet:page"] = page();
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

  it("a disconnected PC is not watched, says so, and its action leads to Remove", async () => {
    cx.results["fleet:page"] = page({ revoked: true, presence: { online: false, since: 5, revoked: true }, flags: { noGroup: false, revoked: true, rotateCredential: false } });
    const watch = vi.fn(async () => ({ fastUntil: null }));
    cx.fns["fleet:watch"] = watch;
    open();
    expect(watch).not.toHaveBeenCalled();
    expect(screen.getByText(problemStrings.revoked.title)).toBeTruthy();
    expect(screen.queryByRole("button", { name: deviceText.lockPc })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: problemStrings.revoked.action }));
    expect(await screen.findByRole("button", { name: settingsText.remove })).toBeTruthy();
  });

  it("warns when the PC has no group, and offers to turn kiosk mode back on in one click", async () => {
    cx.results["fleet:page"] = page({ group: null, kioskEnabled: false, flags: { noGroup: true, revoked: false, rotateCredential: false } });
    const setKiosk = vi.fn(async () => ({ revision: 8 }));
    cx.fns["fleet:setKiosk"] = setKiosk;
    open();
    expect(screen.getByText(problemStrings.noGroup.title)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: problemStrings.kioskOff.action }));
    await waitFor(() => expect(setKiosk).toHaveBeenCalledWith({ deviceId: "d1", expectedRevision: 7, enabled: true }));
  });

  it("a viewer sees every problem but no button that runs something, no header actions and no rename", () => {
    cx.results["fleet:page"] = page({ kioskEnabled: false });
    open("viewer");
    expect(screen.getByText(problemStrings.kioskOff.title)).toBeTruthy();
    expect(screen.queryByRole("button", { name: problemStrings.kioskOff.action })).toBeNull();
    expect(screen.queryByRole("button", { name: deviceText.sendMessage })).toBeNull();
    expect(screen.queryByRole("button", { name: deviceText.lockPc })).toBeNull();
    expect(screen.queryByRole("button", { name: deviceText.rename })).toBeNull();
  });

  it("Lock this PC (header) opens the lock form and sends the message", async () => {
    cx.results["fleet:page"] = page();
    const lock = vi.fn(async () => ({ lockId: "l1" }));
    cx.fns["fleet:lock"] = lock;
    open();
    fireEvent.click(screen.getByRole("button", { name: deviceText.lockPc }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(new RegExp(lockStrings.message)), { target: { value: "Back in five minutes" } });
    fireEvent.click(within(dialog).getByRole("button", { name: lockStrings.lock }));
    await waitFor(() => expect(lock).toHaveBeenCalledWith({ deviceId: "d1", message: "Back in five minutes" }));
  });

  it("a locked PC shows Locked, a danger problem with Unlock, and the header offers the same", async () => {
    cx.results["fleet:page"] = page({ lock: { lockId: "l1", message: "Back soon", lockedAt: Date.now() - 60_000 } });
    const unlock = vi.fn(async () => null);
    cx.fns["fleet:unlock"] = unlock;
    open();
    expect(screen.getByText(deviceText.locked)).toBeTruthy();
    expect(screen.getByText(problemStrings.locked.title)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: problemStrings.locked.action }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: lockStrings.unlock }));
    await waitFor(() => expect(unlock).toHaveBeenCalledWith({ deviceId: "d1" }));
  });

  describe("Settings tab", () => {
    const settings = (role: Me["role"] = "admin") => open(role, "/devices/d1?tab=settings");
    const options = { groups: [{ _id: "g1", name: "Sales" }, { _id: "g2", name: "Back office" }], rolloutRevision: 4 };
    const asAdmin = (over: Record<string, unknown> = {}) => {
      cx.results["fleet:page"] = page(over);
      cx.results["fleet:deviceSettings"] = options;
    };

    it("kiosk off sends the revision, and the fresh step-up dialog is retried once", async () => {
      asAdmin();
      const setKiosk = vi
        .fn()
        .mockRejectedValueOnce(new ConvexError({ code: "step_up_required" }))
        .mockResolvedValueOnce({ revision: 8 });
      cx.fns["fleet:setKiosk"] = setKiosk;
      const handler = vi.fn(async () => true);
      const off = setStepUpHandler(handler);
      settings();
      fireEvent.click(await screen.findByRole("switch"));
      await waitFor(() => expect(setKiosk).toHaveBeenCalledTimes(2));
      expect(setKiosk).toHaveBeenLastCalledWith({ deviceId: "d1", expectedRevision: 7, enabled: false });
      expect(handler).toHaveBeenCalledOnce();
      off();
    });

    it("says what kiosk mode does now, in words", async () => {
      asAdmin({ kioskEnabled: false });
      settings();
      expect(await screen.findByText(settingsText.kioskOffLine)).toBeTruthy();
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    });

    it("Disconnect needs the PC's name typed, then calls fleet:revoke", async () => {
      asAdmin();
      const revoke = vi.fn(async () => null);
      cx.fns["fleet:revoke"] = revoke;
      settings();
      fireEvent.click(await screen.findByRole("button", { name: settingsText.revoke }));
      const dialog = screen.getByRole("dialog");
      const confirm = within(dialog).getByRole("button", { name: settingsText.revoke });
      expect((confirm as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Front desk" } });
      fireEvent.click(confirm);
      await waitFor(() => expect(revoke).toHaveBeenCalledWith({ deviceId: "d1" }));
    });

    it("move: the group picker searches the groups of fleet:deviceSettings and sends the revision", async () => {
      asAdmin();
      const move = vi.fn(async () => ({ revision: 8 }));
      cx.fns["fleet:move"] = move;
      settings();
      await screen.findByText(settingsText.general);
      expect(selectedText(settingsText.group)).toContain("Sales");
      fireEvent.click(screen.getByLabelText(settingsText.group));
      fireEvent.change(screen.getByPlaceholderText(settingsText.groupSearch), { target: { value: "back" } });
      const list = within(screen.getByRole("listbox"));
      expect(list.queryByRole("option", { name: "Sales" })).toBeNull();
      fireEvent.click(list.getByRole("option", { name: "Back office" }));
      fireEvent.click(screen.getByRole("button", { name: settingsText.move }));
      await waitFor(() => expect(move).toHaveBeenCalledWith({ deviceId: "d1", expectedRevision: 7, groupId: "g2" }));
    });

    it("a viewer reads the values and has no actions; nothing but the page is subscribed", async () => {
      cx.results["fleet:page"] = page();
      cx.queried = [];
      settings("viewer");
      await screen.findByText(settingsText.general);
      expect(within(screen.getByRole("region", { name: settingsText.general })).getByText("Sales")).toBeTruthy();
      expect(screen.queryByRole("switch")).toBeNull();
      expect(screen.queryByRole("button", { name: settingsText.revoke })).toBeNull();
      expect(screen.queryByRole("button", { name: settingsText.rename })).toBeNull();
      expect(screen.queryByText(settingsText.dangerZone)).toBeNull();
      expect(cx.queried).not.toContain("fleet:deviceSettings");
    });

    it("Rename opens the rename dialog with this PC's name", async () => {
      asAdmin();
      const rename = vi.fn(async () => ({ revision: 8 }));
      cx.fns["fleet:rename"] = rename;
      settings();
      fireEvent.click(await screen.findByRole("button", { name: settingsText.rename }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Reception" } });
      fireEvent.click(within(dialog).getByRole("button", { name: strings.common.save }));
      await waitFor(() => expect(rename).toHaveBeenCalledWith({ deviceId: "d1", expectedRevision: 7, name: "Reception" }));
    });

    it("Gets changes (the rollout ring) sends the rollout revision of fleet:deviceSettings; a viewer reads it", async () => {
      asAdmin();
      const setRings = vi.fn(async () => ({ revision: 5, changed: 1 }));
      cx.fns["rollouts:setRings"] = setRings;
      settings();
      await screen.findByText(settingsText.advanced);
      expect(selectedText(settingsText.ring)).toBe(settingsText.rings.everyone);
      pickOption(settingsText.ring, settingsText.rings.pilot);
      await waitFor(() => expect(setRings).toHaveBeenCalledWith({ groupId: "g1", deviceIds: ["d1"], ring: "pilot", expectedRevision: 4 }));
      expect(await screen.findByText(settingsText.ringSaved)).toBeTruthy();
      cleanup();

      cx.results["fleet:page"] = page({ ring: "early" });
      settings("viewer");
      await screen.findByText(settingsText.advanced);
      expect(screen.queryByLabelText(settingsText.ring)).toBeNull();
      expect(screen.getByText(settingsText.rings.early)).toBeTruthy();
    });

    it("Gets changes: emptying the first group is refused in words; a PC without a group has none to choose", async () => {
      asAdmin();
      cx.fns["rollouts:setRings"] = vi.fn().mockRejectedValue(new ConvexError({ code: "conflict", detail: "no_pilot_devices" }));
      cx.results["fleet:page"] = page({ ring: "pilot" });
      settings();
      await screen.findByText(settingsText.advanced);
      pickOption(settingsText.ring, settingsText.rings.everyone);
      expect(await screen.findByText(ringErrorMessage(new ConvexError({ code: "conflict", detail: "no_pilot_devices" }))!)).toBeTruthy();
      cleanup();

      asAdmin({ group: null, flags: { noGroup: true, revoked: false, rotateCredential: false } });
      settings();
      await screen.findByText(settingsText.advanced);
      expect(screen.queryByLabelText(settingsText.ring)).toBeNull();
      expect(screen.getByText(settingsText.ringNoGroup)).toBeTruthy();
    });

    it("Renew this PC's key asks first, then requests it; while one is waiting the button is off and the line says so", async () => {
      asAdmin();
      const rotate = vi.fn(async () => null);
      cx.fns["fleet:requestCredentialRotation"] = rotate;
      settings();
      fireEvent.click(await screen.findByRole("button", { name: settingsText.rotateAction }));
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: settingsText.rotateAction }));
      await waitFor(() => expect(rotate).toHaveBeenCalledWith({ deviceId: "d1" }));
      cleanup();

      asAdmin({ flags: { noGroup: false, revoked: false, rotateCredential: true } });
      settings();
      expect(await screen.findByText(settingsText.rotatePending)).toBeTruthy();
      expect((screen.getByRole("button", { name: settingsText.rotateAction }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("'Choose a group' on a PC without one lands on the group picker, focused", async () => {
      asAdmin({ group: null, flags: { noGroup: true, revoked: false, rotateCredential: false } });
      open("admin", "/devices/d1");
      fireEvent.click(screen.getByRole("button", { name: problemStrings.noGroup.action }));
      await screen.findByText(settingsText.general);
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(settingsText.group)));
      expect(selectedText(settingsText.group)).toBe(settingsText.chooseGroup);
    });

    it("a disconnected PC offers only Remove (name typed first); it subscribes to no group list", async () => {
      cx.results["fleet:page"] = page({ revoked: true, presence: { online: false, since: 5, revoked: true }, flags: { noGroup: false, revoked: true, rotateCredential: false } });
      const remove = vi.fn(async () => null);
      cx.fns["fleet:remove"] = remove;
      open("admin", "/devices/d1?tab=settings");
      expect(screen.queryByRole("switch")).toBeNull();
      expect(screen.queryByRole("button", { name: settingsText.revoke })).toBeNull();
      expect(cx.queried).not.toContain("fleet:deviceSettings");
      fireEvent.click(await screen.findByRole("button", { name: settingsText.remove }));
      const dialog = screen.getByRole("dialog");
      fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Front desk" } });
      fireEvent.click(within(dialog).getByRole("button", { name: settingsText.remove }));
      await waitFor(() => expect(remove).toHaveBeenCalledWith({ deviceId: "d1" }));
    });

    it("'Remove this PC' from the Overview lands on the Remove button, focused", async () => {
      cx.results["fleet:page"] = page({ revoked: true, presence: { online: false, since: 5, revoked: true }, flags: { noGroup: false, revoked: true, rotateCredential: false } });
      open("admin", "/devices/d1");
      fireEvent.click(screen.getByRole("button", { name: problemStrings.revoked.action }));
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: settingsText.remove })));
    });
  });
  it("an unknown PC is a visible error (not_found has no Try again), not a blank page", () => {
    cx.results["fleet:page"] = new ConvexError({ code: "not_found" });
    open();
    expect(screen.getByRole("alert").textContent).toContain(strings.common.regionFailed);
    expect(screen.queryByRole("button", { name: strings.common.tryAgain })).toBeNull();
  });
});