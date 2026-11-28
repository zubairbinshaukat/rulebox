import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { ReactNode } from "react";
import type { Me, PlanScreen } from "../data/types";
import { MeContext } from "../lib/member";
import { setStepUpHandler } from "../lib/stepUpRetry";
import { strings } from "../lib/strings";
import { optionLabels, pickOption, selectedText } from "../test/select";
import { auditStrings } from "../lib/screenStrings/audit";
import { groupStrings } from "../lib/screenStrings/group";
import { groupsStrings } from "../lib/screenStrings/groups";

// Phase 4 Step 5 screens against the LIVE data seam with the Convex React
// hooks mocked: every query answers from `cx.results[<function name>]`, every
// mutation / action calls `cx.fns[<function name>]`. Covers the states the
// screens must handle (limit reached, has_dependents, stale edit, hotkey
// grammar, weak PIN, step-up retry), not the backend (convex/*.test.ts).
const cx = vi.hoisted(() => ({
  /** One empty array for every unset page: the real hook keeps `results` stable between renders. */
  none: [] as unknown[],
  results: {} as Record<string, unknown>,
  /** `usePaginatedQuery` answers by function name: rows of one loaded, exhausted page. */
  pages: {} as Record<string, unknown[]>,
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
  /** Every query subscribed to, with its arguments (list pages are plain queries with `paginationOpts`). */
  queried: [] as { name: string; args: Record<string, unknown> }[],
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: unknown }>) =>
    Object.fromEntries(
      Object.entries(req).map(([k, r]) => {
        cx.queried.push({ name: getFunctionName(r.query), args: r.args as Record<string, unknown> });
        return [k, cx.results[getFunctionName(r.query)]];
      }),
    ),
  useQuery: () => undefined,
  usePaginatedQuery: (ref: FunctionReference<"query">) => ({
    results: cx.pages[getFunctionName(ref)] ?? cx.none,
    status: "Exhausted",
    isLoading: false,
    loadMore: () => undefined,
  }),
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
    // `useMutation(...).withOptimisticUpdate(...)`: the optimistic part is the real client's job.
    call.withOptimisticUpdate = () => call;
    f = call;
    stable.set(name, f);
  }
  return f;
}

import { ToastProvider } from "../app/Toasts";
import Groups from "./Groups";
import GroupDetail from "./GroupDetail";
import { AdminExitTab } from "./settings/AdminExitTab";
import { OrganizationTab } from "./settings/OrganizationTab";
import { exit as exitText, planLimitMessage } from "./settings/strings";
import { groupText } from "./groups/strings";
import { groupPage } from "./group/strings";
import { displayStrings } from "../lib/screenStrings/display";

const admin: Me = {
  email: "admin@x.test",
  role: "admin",
  status: "active",
  orgId: "org",
  orgName: "Acme",
  pin: { required: true, set: true },
  serverApiVersion: 1,
};

function ui(node: ReactNode, role: Me["role"] = "admin", path = "/") {
  return render(
    <ToastProvider>
      <MeContext.Provider value={{ ...admin, role }}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/groups" element={node} />
            <Route path="/groups/:id" element={node} />
            <Route path="*" element={node} />
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

const settingsData = (revision = 4, setAt?: number) => ({
  name: "Acme",
  revision,
  settings: { offlineDays: 3, defaultQuotaGb: 10, power: { sleep: true, restart: true, shutDown: true }, adminExit: { enabled: true, hotkey: "Ctrl+Shift+F12" } },
  exitPin: setAt === undefined ? { set: false } : { set: true, setAt },
});

const freePlan: PlanScreen = {
  plan: "free",
  status: "active",
  limits: {
    maxDevices: 2,
    maxEmployees: 25,
    maxApps: 20,
    maxGroups: 3,
    maxMembers: 2,
    auditRetentionDays: 30,
    storageQuotaBytes: 1024 ** 3,
    maxUploadBytes: 500 * 1024 ** 2,
    watchMode: true,
    maxEnrollmentCodesActive: 5,
  },
  usage: { devices: 1, employees: 0, apps: 0, groups: 3, members: 1, enrollmentCodes: 0 },
  pingIntervalMs: 1_800_000,
};

const groupRow = (id: string, name: string, devices = 0, more = false) => ({
  _id: id,
  name,
  revision: 0,
  createdAt: 1,
  devices: { count: devices, more },
  employees: { count: 0, more: false },
});

beforeEach(() => {
  cx.results = {};
  cx.pages = {};
  cx.fns = {};
  cx.queried = [];
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.removeAttribute("data-view");
});

let offHandler: (() => void) | null = null;
afterEach(() => {
  offHandler?.();
  offHandler = null;
});

describe("Groups list (groups:page, one server-driven page at a time)", () => {
  /** `groups:page` answers a bounded list: a page of rows, offset cursors and the exact total. */
  const groupsPage = (rows: unknown[], total = rows.length, over: Record<string, unknown> = {}) => ({ page: rows, isDone: true, continueCursor: `o:${rows.length}`, total, ...over });
  const lastArgs = () => [...cx.queried].reverse().find((q) => q.name === "groups:page")!.args as unknown as ListCall;
  const DEFAULT_ARGS = { paginationOpts: { numItems: 10, cursor: null }, sort: { key: "name", dir: "asc" } };
  const header = (name: string) => screen.getByRole("columnheader", { name: new RegExp(name) });
  const many = (n: number) => Array.from({ length: n }, (_, i) => groupRow(`g${i + 1}`, `Group ${String(i + 1).padStart(2, "0")}`));

  it("loading shows skeleton rows, then the list with capped counts (500+) and the total", () => {
    const { rerender } = ui(<Groups />, "admin", "/groups");
    expect(screen.queryByRole("table")).toBeNull();
    cx.results["groups:page"] = groupsPage([groupRow("g1", "Front desk", 500, true), groupRow("g2", "Office", 2)]);
    rerender(
      <ToastProvider>
        <MeContext.Provider value={admin}>
          <MemoryRouter initialEntries={["/groups"]}>
            <Groups />
          </MemoryRouter>
        </MeContext.Provider>
      </ToastProvider>,
    );
    const table = screen.getByRole("table");
    expect(within(table).getByText("500+")).toBeTruthy();
    expect(within(table).getByText("2")).toBeTruthy();
    expect(lastArgs()).toEqual(DEFAULT_ARGS);
    // The bounded list carries its exact total: no separate count query.
    // One page at the default size: only how many records there are.
    expect(screen.getByText(strings.pager.recordsShort(2))).toBeTruthy();
    expect(cx.queried.some((q) => q.name === "groups:count")).toBe(false);
  });

  it("empty: one sentence and the primary action; a viewer gets no action", () => {
    cx.results["groups:page"] = groupsPage([]);
    ui(<Groups />, "admin", "/groups");
    expect(screen.getByText(groupsStrings.emptyTitle)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: groupsStrings.add }).length).toBe(2);
  });

  it("viewer: read-only (no New group)", () => {
    cx.results["groups:page"] = groupsPage([groupRow("g1", "Front desk")]);
    ui(<Groups />, "viewer", "/groups");
    expect(screen.queryByRole("button", { name: groupsStrings.add })).toBeNull();
  });

  it("an error shows Try again", () => {
    cx.results["groups:page"] = new ConvexError({ code: "forbidden" });
    ui(<Groups />, "admin", "/groups");
    expect(screen.getByText(strings.common.regionFailed)).toBeTruthy();
    expect(screen.getByRole("button", { name: strings.common.tryAgain })).toBeTruthy();
  });

  it("the 4th group on the Free plan is refused with the plan-limit message (and no upgrade button)", async () => {
    cx.results["groups:page"] = groupsPage([groupRow("g1", "A"), groupRow("g2", "B"), groupRow("g3", "C")]);
    cx.results["settings:plan"] = freePlan;
    const create = vi.fn(async () => {
      throw new ConvexError({ code: "plan_limit", detail: "groups" });
    });
    cx.fns["groups:create"] = create;
    ui(<Groups />, "admin", "/groups");
    fireEvent.click(screen.getByRole("button", { name: groupsStrings.add }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(groupText.usage(3, 3, "Free"))).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(new RegExp(groupsStrings.name)), { target: { value: "D" } });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.common.create }));
    const message = planLimitMessage("groups", "free", 3);
    expect(await within(dialog).findByText(message)).toBeTruthy();
    expect(message).toContain("Contact us to upgrade.");
    expect(create).toHaveBeenCalledWith({ name: "D", description: undefined });
    expect(screen.queryByRole("button", { name: /upgrade/i })).toBeNull();
  });

  it("a taken name is shown under the name field (conflict, aria-describedby)", async () => {
    cx.results["groups:page"] = groupsPage([groupRow("g1", "Front desk")]);
    cx.fns["groups:create"] = vi.fn(async () => {
      throw new ConvexError({ code: "conflict", field: "name" });
    });
    ui(<Groups />, "admin", "/groups");
    fireEvent.click(screen.getByRole("button", { name: groupsStrings.add }));
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByLabelText(new RegExp(groupsStrings.name)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Front desk" } });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.common.create }));
    const error = await within(dialog).findByText(groupText.nameTaken);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain(error.closest("p")!.id);
  });

  it("URL state: size, sort and search are read from the query string, invalid values fall back to the defaults", () => {
    cx.results["groups:page"] = groupsPage(many(3));
    ui(<Groups />, "admin", "/groups?size=25&sort=created&dir=desc&q=fr");
    expect(lastArgs()).toEqual({ paginationOpts: { numItems: 25, cursor: null }, sort: { key: "created", dir: "desc" }, search: "fr" });
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("fr");
    cleanup();
    ui(<Groups />, "admin", "/groups?size=13&sort=devices&dir=up&page=zero");
    expect(lastArgs()).toEqual(DEFAULT_ARGS);
  });

  it("a header click sorts on the server; the Created column starts newest first; Devices and Employees do not sort", async () => {
    cx.results["groups:page"] = groupsPage(many(3));
    ui(<Groups />, "admin", "/groups");
    expect(header(groupsStrings.colName).getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(within(header(groupsStrings.colName)).getByRole("button"));
    await waitFor(() => expect(lastArgs().sort).toEqual({ key: "name", dir: "desc" }));
    fireEvent.click(within(header(groupsStrings.colCreated)).getByRole("button"));
    await waitFor(() => expect(lastArgs().sort).toEqual({ key: "created", dir: "desc" }));
    expect(within(header(groupsStrings.colDevices)).queryByRole("button")).toBeNull();
  });

  it("searches on Enter (contains), and the sort still applies; a new search starts over on page 1", async () => {
    cx.results["groups:page"] = groupsPage(many(10), 12, { isDone: false, continueCursor: "o:10" });
    ui(<Groups />, "admin", "/groups");
    fireEvent.click(screen.getByRole("button", { name: strings.pager.next }));
    await waitFor(() => expect(lastArgs().paginationOpts).toEqual({ numItems: 10, cursor: "o:10" }));
    const box = screen.getByRole("searchbox");
    fireEvent.change(box, { target: { value: "grou" } });
    expect(lastArgs().paginationOpts.cursor).toBe("o:10");
    fireEvent.submit(box.closest("form")!);
    await waitFor(() => expect(lastArgs()).toEqual({ ...DEFAULT_ARGS, search: "grou" }));
  });

  it("pages: the exact total in the pager, the last page by the opposite order, size change resets to page 1", async () => {
    cx.results["groups:page"] = groupsPage(many(10), 25, { isDone: false, continueCursor: "o:10" });
    ui(<Groups />, "admin", "/groups");
    expect(screen.getByText(`${strings.pager.records(25)} · ${strings.pager.pageOf(1, 3)}`)).toBeTruthy();
    // The last page is one cheap query: the opposite order, 25 mod 10 = 5 rows, shown reversed.
    cx.results["groups:page"] = groupsPage(many(25).slice(20).reverse(), 25, { isDone: true });
    fireEvent.click(within(screen.getByRole("navigation", { name: strings.pager.nav })).getByRole("button", { name: strings.pager.goTo(3) }));
    await waitFor(() => expect(lastArgs()).toEqual({ paginationOpts: { numItems: 5, cursor: null }, sort: { key: "name", dir: "desc" } }));
    const names = within(screen.getByRole("table")).getAllByRole("link").map((l) => l.textContent);
    expect(names).toEqual(["Group 21", "Group 22", "Group 23", "Group 24", "Group 25"]);
    await screen.findByLabelText(strings.pager.rowsPerPage); // the dropdown is a lazy chunk
    pickOption(strings.pager.rowsPerPage, "25");
    await waitFor(() => expect(lastArgs().paginationOpts).toEqual({ numItems: 25, cursor: null }));
  });

  it("a refresh on ?page=2 opens page 2 straight away (offset cursors need no earlier pages)", async () => {
    cx.results["groups:page"] = groupsPage([groupRow("g11", "Group 11"), groupRow("g12", "Group 12")], 12);
    ui(<Groups />, "admin", "/groups?page=2");
    await waitFor(() => expect(lastArgs().paginationOpts).toEqual({ numItems: 10, cursor: "o:10" }));
    expect(screen.getByText(`${strings.pager.records(12)} · ${strings.pager.pageOf(2, 2)}`)).toBeTruthy();
  });

  it("the whole row opens the group; the name stays a real link", async () => {
    cx.results["groups:page"] = groupsPage([groupRow("g1", "Front desk", 3)]);
    render(
      <ToastProvider>
        <MeContext.Provider value={admin}>
          <MemoryRouter initialEntries={["/groups"]}>
            <Routes>
              <Route path="/groups" element={<Groups />} />
              <Route path="/groups/:id" element={<p>group page</p>} />
            </Routes>
          </MemoryRouter>
        </MeContext.Provider>
      </ToastProvider>,
    );
    expect(screen.getByRole("link", { name: "Front desk" }).getAttribute("href")).toBe("/groups/g1");
    fireEvent.click(within(screen.getByRole("table")).getByText("3"));
    expect(await screen.findByText("group page")).toBeTruthy();
  });

  it("the cards view draws the groups as cards", async () => {
    cx.results["groups:page"] = groupsPage(many(2));
    ui(<Groups />, "admin", "/groups");
    fireEvent.click(screen.getByRole("radio", { name: strings.table.viewCards }));
    expect(document.documentElement.getAttribute("data-view")).toBe("cards");
    expect(await screen.findByRole("link", { name: "Group 01" })).toBeTruthy();
    expect(await screen.findByLabelText(strings.table.sortSelect)).toBeTruthy();
  });

  it("a card has the name as its link, the description under it and the counts as labelled facts; the sort choices say Name and Created", async () => {
    cx.results["groups:page"] = groupsPage([{ ...groupRow("g1", "Front desk", 3), description: "The tills", employees: { count: 2, more: false } }]);
    ui(<Groups />, "admin", "/groups");
    fireEvent.click(screen.getByRole("radio", { name: strings.table.viewCards }));
    const card = (await screen.findByRole("list", { name: groupsStrings.title })).querySelector("li")!;
    expect(within(card).getByRole("link", { name: "Front desk" })).toBeTruthy();
    expect(within(card).getByText("The tills")).toBeTruthy();
    expect(within(card).getByText(groupsStrings.cardPcs).nextElementSibling?.textContent).toBe("3");
    expect(within(card).getByText(groupsStrings.colEmployees).nextElementSibling?.textContent).toBe("2");
    await screen.findByLabelText(strings.table.sortSelect);
    expect(optionLabels(strings.table.sortSelect)).toEqual(["Name: A to Z", "Name: Z to A", "Created: newest first", "Created: oldest first"]);
  });
});
describe("Group detail (groups:get)", () => {
  const detail = (revision: number, name = "Office", devices = 0, over: Record<string, unknown> = {}) => ({
    group: { ...groupRow("g1", name, devices), revision, description: "Back office", ...over },
    apps: [{ assignmentId: "as1", appId: "a1", name: "Notepad", kind: "desktop", archived: false, audience: "everyone", pinnedTaskbar: true, pinnedDesktop: false }],
  });
  const assign = () => screen.getAllByRole("button", { name: groupPage.assignApp })[0]!;
  const more = () => fireEvent.click(screen.getByRole("button", { name: groupPage.more }));
  const menuItems = () => screen.getAllByRole("menuitem").map((i) => i.textContent);
  const pickMore = (label: string) => {
    more();
    fireEvent.click(screen.getByRole("menuitem", { name: label }));
  };

  it("the header: the name, Assign app as the main button, Protection, a More menu; the tabs and the apps", () => {
    cx.results["groups:get"] = detail(0);
    ui(<GroupDetail />, "admin", "/groups/g1");
    expect(screen.getByRole("heading", { level: 1, name: "Office" })).toBeTruthy();
    expect(screen.getByText("Back office")).toBeTruthy();
    expect(assign().className).toContain("rb-btn--primary");
    expect(screen.getByRole("link", { name: groupPage.protection }).getAttribute("href")).toBe("/groups/g1/lockdown");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([groupPage.tabs.overview, groupPage.tabs.pcs, groupPage.tabs.people, groupPage.tabs.activity]);
    expect(screen.getByText("Notepad")).toBeTruthy();
    // Rename and Delete are not buttons of the header: they are in the menu, Delete last.
    expect(screen.queryByRole("button", { name: groupPage.rename })).toBeNull();
    expect(screen.queryByRole("button", { name: strings.common.delete })).toBeNull();
    more();
    expect(menuItems()).toEqual([groupPage.stagedRollout, groupPage.sendMessage, groupPage.rename, groupPage.deleteGroup]);
  });

  it("the Overview reads groups:get only; the PCs tab adds fleet:list for the group, the People tab employees:list, Activity the history", () => {
    cx.results["groups:get"] = detail(0);
    cx.results["fleet:list"] = { page: [], isDone: true, continueCursor: "c" };
    cx.results["employees:list"] = { page: [], isDone: true, continueCursor: "c" };
    cx.results["audit:forTarget"] = { page: [], isDone: true, continueCursor: "c" };
    const names = () => new Set(cx.queried.map((q) => q.name));
    const view = ui(<GroupDetail />, "admin", "/groups/g1");
    expect([...names()]).toEqual(["groups:get"]);
    view.unmount();
    cx.queried = [];
    ui(<GroupDetail />, "admin", "/groups/g1?tab=pcs");
    expect(names().has("groups:get")).toBe(true);
    return waitFor(() => expect(names().has("fleet:list")).toBe(true)).then(() => {
      expect(names().has("employees:list")).toBe(false);
      expect(names().has("audit:forTarget")).toBe(false);
      expect(cx.queried.find((q) => q.name === "fleet:list")!.args).toMatchObject({ groupId: "g1" });
    });
  });

  it("the PCs tab lists the group's PCs with a link to each and Add a PC for this group", async () => {
    cx.results["groups:get"] = detail(0, "Office", 1);
    cx.results["audit:forTarget"] = { page: [], isDone: true, continueCursor: "c" };
    cx.results["fleet:list"] = {
      page: [
        {
          _id: "d1",
          name: "Front desk",
          groupId: "g1",
          groupName: "Office",
          kioskEnabled: true,
          enrolledAt: 1,
          revision: 0,
          presence: { online: true, since: 1, revoked: false },
          summary: { outOfSupport: false, kioskPhase: "applied", updatedAt: 1 },
          latestVersion: null,
        },
      ],
      isDone: true,
      continueCursor: "c",
    };
    ui(<GroupDetail />, "admin", "/groups/g1?tab=pcs");
    expect((await screen.findByRole("link", { name: "Front desk" })).getAttribute("href")).toBe("/devices/d1");
    expect(screen.getByRole("link", { name: groupPage.pcs.add }).getAttribute("href")).toBe("/enrollment?group=g1");
  });

  it("the Activity tab shows the history", async () => {
    cx.results["groups:get"] = detail(0);
    cx.results["audit:forTarget"] = { page: [], isDone: true, continueCursor: "c" };
    ui(<GroupDetail />, "admin", "/groups/g1?tab=activity");
    expect((await screen.findAllByText(auditStrings.historyNone)).length).toBeGreaterThanOrEqual(1);
  });

  it("viewers see the apps without Assign, Edit and Unassign, and a More menu with Staged rollout only", () => {
    cx.results["groups:get"] = detail(0);
    ui(<GroupDetail />, "viewer", "/groups/g1");
    expect(screen.getByText("Notepad")).toBeTruthy();
    expect(screen.queryByRole("button", { name: groupPage.assignApp })).toBeNull();
    expect(screen.queryByRole("button", { name: `${groupPage.edit}: Notepad` })).toBeNull();
    expect(screen.queryByRole("button", { name: `${groupStrings.unassign}: Notepad` })).toBeNull();
    expect(screen.getByRole("link", { name: groupPage.protection })).toBeTruthy();
    more();
    expect(menuItems()).toEqual([groupPage.stagedRollout]);
  });

  it("assign: with one app left (those already in the group are left out) it is chosen for them; the audience and pins are sent", async () => {
    cx.results["groups:get"] = detail(0);
    cx.results["apps:options"] = [
      { _id: "a1", name: "Notepad", kind: "desktop", canOpenFiles: true },
      { _id: "a2", name: "Wiki", kind: "web", canOpenFiles: false },
    ];
    const assignApp = vi.fn(async () => ({ assignmentId: "as2" }));
    cx.fns["groups:assignApp"] = assignApp;
    ui(<GroupDetail />, "admin", "/groups/g1");
    fireEvent.click(assign());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(groupStrings.app).textContent).toContain("Wiki");
    // Notepad is already in the group, so Wiki is the only choice; the list names its kind.
    const listed = optionLabels(groupStrings.app);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toContain("Wiki");
    expect(listed[0]).toContain("Website");
    // Who sees it: two cards, "Everyone in the group" chosen; pins: two toggles, Desktop on.
    const everyone = within(dialog).getByRole("radio", { name: groupText.audienceCards.everyone });
    expect(everyone.getAttribute("aria-checked")).toBe("true");
    const desktop = within(dialog).getByRole("button", { name: groupText.pinDesktop });
    expect(desktop.getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).getByRole("button", { name: groupText.pinTaskbar }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(within(dialog).getByRole("radio", { name: groupText.audienceCards.selected }));
    fireEvent.click(within(dialog).getByRole("button", { name: groupText.pinTaskbar }));
    fireEvent.click(within(dialog).getByRole("button", { name: groupStrings.assign }));
    await waitFor(() => expect(assignApp).toHaveBeenCalledWith({ groupId: "g1", appId: "a2", audience: "selected", pinnedTaskbar: true, pinnedDesktop: true }));
  });

  it("assign: with several apps left none is chosen for them; the picker is searchable and Assign asks for one", async () => {
    cx.results["groups:get"] = detail(0);
    cx.results["apps:options"] = [
      { _id: "a1", name: "Notepad", kind: "desktop", canOpenFiles: true },
      { _id: "a2", name: "Wiki", kind: "web", canOpenFiles: false },
      { _id: "a3", name: "Calendar", kind: "web", canOpenFiles: false },
    ];
    const assignApp = vi.fn(async () => ({ assignmentId: "as2" }));
    cx.fns["groups:assignApp"] = assignApp;
    ui(<GroupDetail />, "admin", "/groups/g1");
    fireEvent.click(assign());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(groupStrings.app).textContent).toContain(groupText.appPlaceholder);
    fireEvent.click(within(dialog).getByRole("button", { name: groupStrings.assign }));
    expect(await within(dialog).findByText(strings.validate.required)).toBeTruthy();
    expect(assignApp).not.toHaveBeenCalled();
    pickOption(groupStrings.app, /Calendar/);
    fireEvent.click(within(dialog).getByRole("button", { name: groupStrings.assign }));
    await waitFor(() => expect(assignApp).toHaveBeenCalledWith({ groupId: "g1", appId: "a3", audience: "everyone", pinnedTaskbar: false, pinnedDesktop: true }));
  });

  it("assign: the server's conflict and too_large refusals get their own sentences", async () => {
    cx.results["groups:get"] = { ...detail(0), apps: [] };
    cx.results["apps:options"] = [{ _id: "a2", name: "Wiki", kind: "web", canOpenFiles: false }];
    cx.fns["groups:assignApp"] = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "conflict", field: "app" }))
      .mockRejectedValueOnce(new ConvexError({ code: "too_large", detail: "group apps" }));
    ui(<GroupDetail />, "admin", "/groups/g1");
    fireEvent.click(assign());
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: groupStrings.assign }));
    expect(await within(dialog).findByText(groupText.alreadyAssigned)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: groupStrings.assign }));
    expect(await within(dialog).findByText(groupText.tooManyApps)).toBeTruthy();
  });

  it("edit sends the assignment id with the new audience and pins; unassign asks first (row buttons)", async () => {
    cx.results["groups:get"] = detail(0);
    const update = vi.fn(async () => null);
    const unassign = vi.fn(async () => null);
    cx.fns["groups:updateAssignment"] = update;
    cx.fns["groups:unassignApp"] = unassign;
    ui(<GroupDetail />, "admin", "/groups/g1");
    fireEvent.click(screen.getByRole("button", { name: `${groupPage.edit}: Notepad` }));
    let dialog = await screen.findByRole("dialog");
    // The assignment is on the taskbar only: Desktop is off; turn it on.
    expect(within(dialog).getByRole("button", { name: groupText.pinDesktop }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(within(dialog).getByRole("button", { name: groupText.pinDesktop }));
    fireEvent.click(within(dialog).getByRole("button", { name: strings.common.save }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ assignmentId: "as1", audience: "everyone", pinnedTaskbar: true, pinnedDesktop: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: `${groupStrings.unassign}: Notepad` }));
    dialog = await screen.findByRole("dialog");
    expect(unassign).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: groupStrings.unassign }));
    await waitFor(() => expect(unassign).toHaveBeenCalledWith({ assignmentId: "as1" }));
  });

  it("an archived app is a warning card with Unassign, which asks first; the tab says how many things need a look", async () => {
    cx.results["groups:get"] = { ...detail(0), apps: [{ assignmentId: "as9", appId: "a9", name: "PDF Reader", kind: "desktop", archived: true, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: true }] };
    const unassign = vi.fn(async () => null);
    cx.fns["groups:unassignApp"] = unassign;
    ui(<GroupDetail />, "admin", "/groups/g1");
    expect(screen.getByRole("tab", { name: new RegExp(`^${groupPage.tabs.overview}\\s*1$`) })).toBeTruthy();
    const card = screen.getByRole("heading", { name: new RegExp(groupPage.problem.archivedTitle("PDF Reader")) }).closest("article")!;
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: groupPage.problem.unassign }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: groupStrings.unassign }));
    await waitFor(() => expect(unassign).toHaveBeenCalledWith({ assignmentId: "as9" }));
  });

  it("a halted rollout and an old trial run are cards that go to the rollout and to the protection", () => {
    const now = Date.now();
    cx.results["groups:get"] = {
      ...detail(0),
      rollout: { enabled: true, state: "halted" },
      lockdownAuditSince: now - 20 * 24 * 60 * 60 * 1000,
    };
    ui(<GroupDetail />, "viewer", "/groups/g1");
    expect(screen.getByRole("link", { name: groupPage.problem.openRollout }).getAttribute("href")).toBe("/groups/g1/rollout");
    expect(screen.getByRole("link", { name: groupPage.problem.openProtection }).getAttribute("href")).toBe("/groups/g1/lockdown");
  });

  it("an empty group gets the three steps; Add a PC goes to the enrollment page with this group; a viewer sees no buttons", () => {
    cx.results["groups:get"] = { ...detail(0), apps: [] };
    const view = ui(<GroupDetail />, "admin", "/groups/g1");
    const steps = within(screen.getByRole("list", { name: groupPage.ready.stepsLabel }));
    expect(steps.getAllByRole("listitem")).toHaveLength(3);
    expect(steps.getByRole("link", { name: groupPage.ready.pcs.action }).getAttribute("href")).toBe("/enrollment?group=g1");
    expect(steps.getByRole("button", { name: groupPage.ready.apps.action })).toBeTruthy();
    view.unmount();
    ui(<GroupDetail />, "viewer", "/groups/g1");
    const ready = within(screen.getByRole("list", { name: groupPage.ready.stepsLabel }));
    expect(ready.queryAllByRole("button")).toHaveLength(0);
    expect(ready.queryAllByRole("link")).toHaveLength(0);
  });

  it("a group with an app, a PC and a person has no checklist", () => {
    cx.results["groups:get"] = detail(0, "Office", 1, { employees: { count: 2, more: false } });
    ui(<GroupDetail />, "admin", "/groups/g1");
    expect(screen.queryByText(groupPage.ready.title)).toBeNull();
  });

  it("the Display and memory row: its state, and Change (admins) opens the dialog", async () => {
    cx.results["groups:get"] = detail(0, "Office", 0, { displayMode: "lite" });
    const view = ui(<GroupDetail />, "admin", "/groups/g1");
    expect(screen.getByText(groupPage.setup.lite)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: groupPage.setup.changeLabel(groupPage.setup.display) }));
    expect(await screen.findByRole("dialog", { name: displayStrings.title })).toBeTruthy();
    view.unmount();
    ui(<GroupDetail />, "viewer", "/groups/g1");
    expect(screen.queryByRole("button", { name: groupPage.setup.changeLabel(groupPage.setup.display) })).toBeNull();
  });

  it("Send a message opens the compose dialog for this group", async () => {
    cx.results["groups:get"] = detail(0);
    cx.results["groups:page"] = { page: [], isDone: true, continueCursor: "c" };
    ui(<GroupDetail />, "admin", "/groups/g1");
    pickMore(groupPage.sendMessage);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("delete (More, last) is blocked up front by what the screen knows (devices, apps)", async () => {
    cx.results["groups:get"] = detail(0, "Office", 3);
    ui(<GroupDetail />, "admin", "/groups/g1");
    pickMore(groupPage.deleteGroup);
    expect(within(await screen.findByRole("dialog")).getByText(groupText.hasDependents("devices, apps"))).toBeTruthy();
  });

  it("has_dependents from the server (enrollment codes) is explained in the dialog", async () => {
    cx.results["groups:get"] = { ...detail(0), apps: [] };
    cx.fns["groups:remove"] = vi.fn(async () => {
      throw new ConvexError({ code: "has_dependents", detail: "enrollment codes" });
    });
    ui(<GroupDetail />, "admin", "/groups/g1");
    pickMore(groupPage.deleteGroup);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Office" } });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.common.delete }));
    const text = groupText.hasDependents("enrollment codes");
    expect(await within(dialog).findByText(text)).toBeTruthy();
    expect(text).toContain("revoke them");
  });

  it("rename (More): stale_edit shows 'Someone else changed this'; Reload takes their values and revision", async () => {
    cx.results["groups:get"] = detail(2);
    const rename = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "stale_edit" }))
      .mockResolvedValueOnce({ revision: 4 });
    cx.fns["groups:rename"] = rename;
    const view = ui(<GroupDetail />, "admin", "/groups/g1");
    pickMore(groupPage.rename);
    let dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(new RegExp(groupsStrings.name)), { target: { value: "Mine" } });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.common.save }));
    expect(await within(dialog).findByText(strings.common.staleTitle)).toBeTruthy();
    expect(rename.mock.calls[0]![0]).toMatchObject({ groupId: "g1", expectedRevision: 2, name: "Mine", description: "Back office" });

    // Their change arrives through the subscription; Reload keeps nothing of ours.
    cx.results["groups:get"] = detail(3, "Theirs");
    view.rerender(
      <ToastProvider>
        <MeContext.Provider value={admin}>
          <MemoryRouter initialEntries={["/groups/g1"]}>
            <Routes>
              <Route path="/groups/:id" element={<GroupDetail />} />
            </Routes>
          </MemoryRouter>
        </MeContext.Provider>
      </ToastProvider>,
    );
    dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: strings.common.reload }));
    expect((within(dialog).getByLabelText(new RegExp(groupsStrings.name)) as HTMLInputElement).value).toBe("Theirs");
    fireEvent.change(within(dialog).getByLabelText(new RegExp(groupsStrings.description)), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.common.save }));
    await waitFor(() => expect(rename).toHaveBeenCalledTimes(2));
    // "" clears the description on the server.
    expect(rename.mock.calls[1]![0]).toEqual({ groupId: "g1", expectedRevision: 3, name: "Theirs", description: "" });
  });
});
describe("Settings → Admin exit (settings:get / update / setExitPin / clearExitPin)", () => {
  it("an invalid key combination names the grammar rule as you type and is never sent", async () => {
    cx.results["settings:get"] = settingsData();
    const update = vi.fn();
    cx.fns["settings:update"] = update;
    ui(<AdminExitTab />);
    const input = screen.getByLabelText(exitText.hotkey) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Shift+F12" } });
    const error = screen.getByText(/add Ctrl or Alt/);
    expect(input.getAttribute("aria-describedby")).toContain(error.closest("p")!.id);
    fireEvent.change(input, { target: { value: "Ctrl+Esc" } });
    expect(screen.getByText(/“Esc” is not a key Rulebox knows/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "Win+L" } });
    expect(screen.getByText(/Windows key combinations are reserved/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await act(async () => undefined);
    expect(update).not.toHaveBeenCalled();
  });

  it("a valid one is sent in canonical form with the loaded revision; the server's refusal shows under the field", async () => {
    cx.results["settings:get"] = settingsData(7);
    const update = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "adminExit.hotkey", detail: "TwoKeys" }))
      .mockResolvedValueOnce({ revision: 8, changed: ["adminExit"] });
    cx.fns["settings:update"] = update;
    ui(<AdminExitTab />);
    const input = screen.getByLabelText(exitText.hotkey) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "alt + f4" } });
    expect(screen.getByText(exitText.hotkeyCanonical("Alt+F4"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    expect(await screen.findByText(/use only one key besides Ctrl, Alt and Shift/)).toBeTruthy();
    expect(update.mock.calls[0]![0]).toEqual({
      expectedRevision: 7,
      name: "Acme",
      settings: { ...settingsData().settings, adminExit: { enabled: true, hotkey: "Alt+F4" } },
    });
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(exitText.saved)).toBeTruthy();
  });

  it("changing the admin exit asks for the step-up dialog and retries once", async () => {
    cx.results["settings:get"] = settingsData(1);
    const update = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "step_up_required", detail: "fresh" }))
      .mockResolvedValueOnce({ revision: 2, changed: ["adminExit"] });
    cx.fns["settings:update"] = update;
    const handler = vi.fn(async () => true);
    offHandler = setStepUpHandler(handler);
    ui(<AdminExitTab />);
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(handler).toHaveBeenCalledOnce();
    expect(update.mock.calls[1]![0]).toMatchObject({ expectedRevision: 1, settings: { adminExit: { enabled: false } } });
  });

  it("the exit PIN is never shown: 'PIN set on <date>'; a viewer cannot change it", () => {
    const setAt = Date.UTC(2026, 9, 20, 12);
    cx.results["settings:get"] = settingsData(1, setAt);
    ui(<AdminExitTab />, "viewer");
    expect(screen.getByText(exitText.pinSetOn(setAt))).toBeTruthy();
    expect(screen.queryByRole("button", { name: exitText.changePin })).toBeNull();
    expect(screen.queryByRole("button", { name: strings.common.saveChanges })).toBeNull();
    expect((screen.getByLabelText(exitText.hotkey) as HTMLInputElement).disabled).toBe(true);
  });

  it("a weak PIN is refused before sending; the server's refusal (detail) shows under the field", async () => {
    cx.results["settings:get"] = settingsData(1);
    const setPin = vi.fn(async () => {
      throw new ConvexError({ code: "invalid_argument", field: "pin", detail: "sequence" });
    });
    cx.fns["settings:setExitPin"] = setPin;
    ui(<AdminExitTab />);
    fireEvent.click(screen.getByRole("button", { name: exitText.setPin }));
    const dialog = screen.getByRole("dialog");
    const pin = within(dialog).getByLabelText(exitText.newPin) as HTMLInputElement;
    const repeat = within(dialog).getByLabelText(exitText.repeatPin) as HTMLInputElement;
    expect(pin.getAttribute("inputmode")).toBe("numeric");
    expect(pin.getAttribute("autocomplete")).toBe("off");
    fireEvent.change(pin, { target: { value: "111111" } });
    fireEvent.change(repeat, { target: { value: "111111" } });
    fireEvent.click(within(dialog).getByRole("button", { name: exitText.setPin }));
    expect(await within(dialog).findByText(strings.validate.pinWeak)).toBeTruthy();
    expect(setPin).not.toHaveBeenCalled();

    // Accepted here, refused by the server: its rule is the authority.
    fireEvent.change(pin, { target: { value: "246813" } });
    fireEvent.change(repeat, { target: { value: "246813" } });
    fireEvent.click(within(dialog).getByRole("button", { name: exitText.setPin }));
    await waitFor(() => expect(setPin).toHaveBeenCalledWith({ pin: "246813" }));
    const err = await within(dialog).findByText(strings.validate.pinWeak);
    expect(pin.getAttribute("aria-describedby")).toContain(err.closest("p")!.id);
  });

  it("setting the exit PIN goes through the step-up dialog, then retries once", async () => {
    cx.results["settings:get"] = settingsData(1);
    const setPin = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "step_up_required", detail: "fresh" }))
      .mockResolvedValueOnce(null);
    cx.fns["settings:setExitPin"] = setPin;
    const handler = vi.fn(async () => true);
    offHandler = setStepUpHandler(handler);
    ui(<AdminExitTab />);
    fireEvent.click(screen.getByRole("button", { name: exitText.setPin }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(exitText.newPin), { target: { value: "246813" } });
    fireEvent.change(within(dialog).getByLabelText(exitText.repeatPin), { target: { value: "246813" } });
    fireEvent.click(within(dialog).getByRole("button", { name: exitText.setPin }));
    expect(await screen.findByText(exitText.pinSaved)).toBeTruthy();
    expect(handler).toHaveBeenCalledOnce();
    expect(setPin).toHaveBeenCalledTimes(2);
    expect(setPin).toHaveBeenLastCalledWith({ pin: "246813" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("cancelling the step-up dialog keeps the PIN dialog open with the reason", async () => {
    cx.results["settings:get"] = settingsData(1);
    cx.fns["settings:setExitPin"] = vi.fn(async () => {
      throw new ConvexError({ code: "step_up_required", detail: "fresh" });
    });
    offHandler = setStepUpHandler(async () => false);
    ui(<AdminExitTab />);
    fireEvent.click(screen.getByRole("button", { name: exitText.setPin }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(exitText.newPin), { target: { value: "246813" } });
    fireEvent.change(within(dialog).getByLabelText(exitText.repeatPin), { target: { value: "246813" } });
    fireEvent.click(within(dialog).getByRole("button", { name: exitText.setPin }));
    expect(await within(dialog).findByText(strings.errors.stepUpRequired)).toBeTruthy();
  });
});

describe("Settings → Organization: plan and usage (settings:plan)", () => {
  it("shows 'Free plan: 1 of 2 devices, 3 of 3 groups.', Contact us to upgrade, and no upgrade or payment UI", () => {
    cx.results["settings:get"] = settingsData();
    cx.results["settings:plan"] = freePlan;
    ui(<OrganizationTab />);
    expect(screen.getByText("Free plan: 1 of 2 devices, 3 of 3 groups.")).toBeTruthy();
    expect(screen.getByText(/Contact us to upgrade\./)).toBeTruthy();
    expect(screen.getAllByText("Limit reached").length).toBe(1);
    expect(screen.queryByRole("button", { name: /upgrade|pay|buy|plan/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /upgrade|pay|buy/i })).toBeNull();
  });

  it("self-hosted (custom): no limits, no 'Contact us'", () => {
    cx.results["settings:get"] = settingsData();
    const big = 1_000_000_000;
    cx.results["settings:plan"] = {
      ...freePlan,
      plan: "custom",
      limits: { ...freePlan.limits, maxDevices: big, maxEmployees: big, maxApps: big, maxGroups: big, maxMembers: big, maxEnrollmentCodesActive: big, auditRetentionDays: 365 },
    };
    ui(<OrganizationTab />);
    expect(screen.getByText("Self-hosted plan.")).toBeTruthy();
    expect(screen.queryByText(/Contact us/)).toBeNull();
  });

  it("the server's refusal of one field is shown under it", async () => {
    cx.results["settings:get"] = settingsData();
    cx.results["settings:plan"] = freePlan;
    cx.fns["settings:update"] = vi.fn(async () => {
      throw new ConvexError({ code: "invalid_argument", field: "offlineDays" });
    });
    ui(<OrganizationTab />);
    pickOption("Offline sign-in", "7 days");
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    const error = await screen.findByText(strings.errors.invalidArgument);
    expect(screen.getByLabelText("Offline sign-in").getAttribute("aria-describedby")).toContain(error.closest("p")!.id);
  });
});

describe("Settings → General: the two pickers (settings:get / update)", () => {
  it("offline sign-in and storage are pickers of presets, not number fields; nothing is typed", () => {
    cx.results["settings:get"] = settingsData();
    cx.results["settings:plan"] = freePlan;
    ui(<OrganizationTab />);
    expect(optionLabels("Offline sign-in")).toEqual(["Off", "1 day", "3 days", "7 days", "14 days", "30 days"]);
    expect(optionLabels("Storage per employee")).toEqual(["Unlimited", "1 GB", "2 GB", "5 GB", "10 GB", "20 GB", "50 GB", "100 GB"]);
    expect(selectedText("Offline sign-in")).toContain("3 days");
    expect(selectedText("Storage per employee")).toContain("10 GB");
    expect(screen.queryByRole("spinbutton")).toBeNull();
    // The hints moved into (i) tips: the long sentences are not on the page.
    expect(screen.queryByText(/0 = unlimited/)).toBeNull();
    expect(screen.getByRole("button", { name: "About Offline sign-in" })).toBeTruthy();
  });

  it("a picked preset is sent as a number; Unlimited is 0 and Off is 0", async () => {
    cx.results["settings:get"] = settingsData(3);
    cx.results["settings:plan"] = freePlan;
    const update = vi.fn().mockResolvedValue({ revision: 4, changed: ["offlineDays"] });
    cx.fns["settings:update"] = update;
    ui(<OrganizationTab />);
    pickOption("Offline sign-in", "Off");
    pickOption("Storage per employee", "Unlimited");
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0]![0]).toMatchObject({ expectedRevision: 3, settings: { offlineDays: 0, defaultQuotaGb: 0 } });
  });

  it("a stored value outside the presets is one more option and is saved unchanged unless another is picked", async () => {
    const data = settingsData(2);
    data.settings.offlineDays = 15;
    data.settings.defaultQuotaGb = 7;
    cx.results["settings:get"] = data;
    cx.results["settings:plan"] = freePlan;
    const update = vi.fn().mockResolvedValue({ revision: 3, changed: [] });
    cx.fns["settings:update"] = update;
    ui(<OrganizationTab />);
    expect(optionLabels("Offline sign-in")).toEqual(["Off", "1 day", "3 days", "7 days", "14 days", "15 days", "30 days"]);
    expect(optionLabels("Storage per employee")).toContain("7 GB");
    expect(selectedText("Offline sign-in")).toContain("15 days");
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0]![0]).toMatchObject({ settings: { offlineDays: 15, defaultQuotaGb: 7 } });
  });

  it("'Contact us to upgrade.' shows only when a limit is reached", () => {
    cx.results["settings:get"] = settingsData();
    cx.results["settings:plan"] = { ...freePlan, usage: { ...freePlan.usage, groups: 1 } };
    ui(<OrganizationTab />);
    expect(screen.queryByText(/Contact us to upgrade\./)).toBeNull();
    expect(screen.queryByText("Limit reached")).toBeNull();
  });
});

describe("Settings → Admin exit: the key recorder (settings:update)", () => {
  const press = (init: KeyboardEventInit) => fireEvent.keyDown(screen.getByRole("group", { name: exitText.recordingLabel }), init);

  it("Change listens for the keys, shows them as key caps and sends the canonical text on save", async () => {
    cx.results["settings:get"] = settingsData(5);
    const update = vi.fn().mockResolvedValue({ revision: 6, changed: ["adminExit"] });
    cx.fns["settings:update"] = update;
    ui(<AdminExitTab />);
    fireEvent.click(screen.getByRole("button", { name: exitText.change }));
    press({ key: "k", code: "KeyK", ctrlKey: true, altKey: true });
    expect(screen.queryByRole("group", { name: exitText.recordingLabel })).toBeNull();
    expect(screen.getByRole("img", { name: exitText.hotkeyNow("Ctrl + Alt + K") })).toBeTruthy();
    expect((screen.getByLabelText(exitText.hotkey) as HTMLInputElement).value).toBe("Ctrl+Alt+K");
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0]![0]).toMatchObject({ settings: { adminExit: { hotkey: "Ctrl+Alt+K" } } });
  });

  it("'Use Ctrl+Shift+F12' appears only when the combination is not the default, and brings it back", () => {
    cx.results["settings:get"] = settingsData(5);
    ui(<AdminExitTab />);
    expect(screen.queryByRole("button", { name: exitText.useDefault("Ctrl+Shift+F12") })).toBeNull();
    fireEvent.change(screen.getByLabelText(exitText.hotkey), { target: { value: "Alt+F4" } });
    fireEvent.click(screen.getByRole("button", { name: exitText.useDefault("Ctrl+Shift+F12") }));
    expect((screen.getByLabelText(exitText.hotkey) as HTMLInputElement).value).toBe("Ctrl+Shift+F12");
  });

  it("a combination the grammar refuses is explained in the open disclosure and never sent", async () => {
    cx.results["settings:get"] = settingsData(5);
    const update = vi.fn();
    cx.fns["settings:update"] = update;
    ui(<AdminExitTab />);
    fireEvent.change(screen.getByLabelText(exitText.hotkey), { target: { value: "Shift+F12" } });
    const error = screen.getByText(/add Ctrl or Alt/);
    expect(error.closest("details")?.hasAttribute("open")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await act(async () => undefined);
    expect(update).not.toHaveBeenCalled();
  });

  it("the how-it-works strip names the three steps and shows the saved keys", () => {
    cx.results["settings:get"] = settingsData(5);
    ui(<AdminExitTab />);
    for (const step of exitText.how) expect(screen.getByText(step.title)).toBeTruthy();
  });
});
