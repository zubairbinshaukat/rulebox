import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleApp } from "./apps/testKit";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { ReactNode } from "react";
import type { Me } from "../data/types";
import { MeContext } from "../lib/member";
import { VIEW_KEY } from "../lib/viewMode";
import { strings } from "../lib/strings";
import { pickOption } from "../test/select";
import { appEditStrings } from "../lib/screenStrings/appEdit";
import { appsStrings } from "../lib/screenStrings/apps";
import { auditStrings } from "../lib/screenStrings/audit";
import { fileTypesStrings } from "../lib/screenStrings/fileTypes";
import { installStateStrings } from "../lib/screenStrings/installState";
import { settingsStrings } from "../lib/screenStrings/settings";

// Phase 4b, work package 3b: Apps, App (assignments, installs), Audit, File types, Enrollment, Settings > Members
// and the history panel against the LIVE data seam with the Convex React hooks mocked. What is checked here is
// the list contract on the wire: which query and arguments each action produces (sort click, Enter search, page,
// page size), and what the URL keeps. The backend is covered by convex/listing.test.ts.
type Result = unknown | ((args: Record<string, unknown>) => unknown);
const cx = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  requests: [] as { name: string; args: Record<string, unknown> }[],
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
  cache: new Map<string, unknown>(),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: Record<string, unknown> }>) =>
    Object.fromEntries(
      Object.entries(req).map(([k, r]) => {
        const name = getFunctionName(r.query);
        cx.requests.push({ name, args: r.args });
        const res = cx.results[name] as Result;
        if (typeof res !== "function") return [k, res];
        // Like Convex, the same arguments give the same object (a new one on every render would loop).
        const key = `${name}|${JSON.stringify(r.args)}`;
        if (!cx.cache.has(key)) cx.cache.set(key, res(r.args));
        return [k, cx.cache.get(key)];
      }),
    ),
  useQuery: () => undefined,
  useAction: (ref: FunctionReference<"action">) => fnFor(getFunctionName(ref)),
  useMutation: (ref: FunctionReference<"mutation">) => fnFor(getFunctionName(ref)),
  useConvexConnectionState: () => ({ isWebSocketConnected: true }),
}));
vi.mock("../data/stepup", () => ({ useResetMemberStepUp: () => vi.fn() }));

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
import { HistoryPanel } from "../components/HistoryPanel";
import Apps from "./Apps";
import AppEdit from "./AppEdit";
import Audit from "./Audit";
import Enrollment from "./Enrollment";
import FileTypes from "./FileTypes";
import { MembersTab } from "./settings/MembersTab";

const me: Me = {
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
  return <output data-testid="where">{l.pathname + l.search}</output>;
}
const where = () => screen.getByTestId("where").textContent;

async function ui(node: ReactNode, path: string, role: Me["role"] = "admin") {
  const result = render(
    <ToastProvider>
      <MeContext.Provider value={{ ...me, role }}>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/apps" element={node} />
            <Route path="/apps/:id" element={node} />
            <Route path="/audit" element={node} />
            <Route path="/enrollment" element={node} />
            <Route path="/file-types" element={node} />
            <Route path="/settings" element={node} />
            <Route path="/groups/:id" element={<p>group page</p>} />
            <Route path="/devices/:id" element={<p>device page</p>} />
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
  cx.requests = [];
  cx.fns = {};
  cx.cache.clear();
  localStorage.clear();
  document.documentElement.removeAttribute("data-view");
});
afterEach(cleanup);

const last = (name: string) => cx.requests.filter((r) => r.name === name).at(-1)?.args;
const page = (rows: unknown[], extra: object = {}) => ({ page: rows, isDone: true, continueCursor: `c:${rows.length}`, ...extra });
const app = (i: number, over: object = {}) => ({
  _id: `a${i}`,
  name: `App ${String(i).padStart(2, "0")}`,
  kind: "web",
  archived: false,
  groupCount: 1,
  groupCountMore: false,
  summary: null,
  createdAt: 1_000 * i,
  ...over,
});
const apps = (n: number, from = 1) => Array.from({ length: n }, (_, i) => app(from + i));
const searchBox = (label: string) => screen.getByRole("searchbox", { name: label }) as HTMLInputElement;
const enter = (label: string, text: string) => {
  const box = searchBox(label);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.submit(box.closest("form")!);
};
const header = (name: string) => screen.getByRole("columnheader", { name: new RegExp(`^${name}`) });

describe("Apps: URL state, sort, search, pager", () => {
  it("reads page size, sort and filters from the URL; invalid values fall back silently", async () => {
    cx.results["apps:list"] = page(apps(3));
    await ui(<Apps />, "/apps?size=25&sort=name&dir=desc");
    expect(last("apps:list")).toEqual({ archived: false, paginationOpts: { numItems: 25, cursor: null }, sort: { key: "name", dir: "desc" } });
    expect(header(appsStrings.colName).getAttribute("aria-sort")).toBe("descending");
    cleanup();
    cx.requests = [];
    await ui(<Apps />, "/apps?size=7&sort=bogus&dir=up&page=-3&archived=maybe");
    expect(last("apps:list")).toEqual({ archived: false, paginationOpts: { numItems: 10, cursor: null }, sort: { key: "created", dir: "desc" } });
    expect(header(appsStrings.colAdded).getAttribute("aria-sort")).toBe("descending");
  });

  it("clicking a sort header sends that sort to the server, toggles it, and starts over on page 1", async () => {
    cx.results["apps:list"] = page(apps(10), { isDone: false, continueCursor: "CUR1" });
    await ui(<Apps />, "/apps");
    fireEvent.click(screen.getByRole("button", { name: strings.pager.next }));
    expect(where()).toBe("/apps?page=2");
    expect(last("apps:list")).toMatchObject({ paginationOpts: { numItems: 10, cursor: "CUR1" } });

    fireEvent.click(within(header(appsStrings.colName)).getByRole("button"));
    expect(where()).toBe("/apps?sort=name&dir=asc");
    expect(last("apps:list")).toEqual({ archived: false, paginationOpts: { numItems: 10, cursor: null }, sort: { key: "name", dir: "asc" } });
    expect(header(appsStrings.colName).getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(within(header(appsStrings.colName)).getByRole("button"));
    expect(last("apps:list")).toMatchObject({ sort: { key: "name", dir: "desc" } });
    // The date column's first click is "newest first" (sortDefaultDir).
    fireEvent.click(within(header(appsStrings.colAdded)).getByRole("button"));
    expect(where()).toBe("/apps");
    expect(last("apps:list")).toMatchObject({ sort: { key: "created", dir: "desc" } });
  });

  it("typing does not search; Enter does (and so does the clear button); the text is in the URL", async () => {
    cx.results["apps:list"] = page(apps(2));
    await ui(<Apps />, "/apps");
    const before = cx.requests.filter((r) => r.name === "apps:list").length;
    fireEvent.change(searchBox(appsStrings.searchLabel), { target: { value: "pos" } });
    expect(cx.requests.filter((r) => r.name === "apps:list").length).toBe(before);
    fireEvent.submit(searchBox(appsStrings.searchLabel).closest("form")!);
    expect(where()).toBe("/apps?q=pos");
    // The index answers by relevance: no sort is sent, the headers are not sort buttons, the count takes the search.
    expect(last("apps:list")).toEqual({ archived: false, paginationOpts: { numItems: 10, cursor: null }, search: "pos" });
    expect(last("apps:count")).toEqual({ archived: false, search: "pos" });
    expect(within(header(appsStrings.colName)).queryByRole("button")).toBeNull();
    expect(screen.getByText(strings.table.byRelevance)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.common.clearSearch }));
    expect(where()).toBe("/apps");
    expect(last("apps:list")).toMatchObject({ sort: { key: "created", dir: "desc" } });
    expect(last("apps:list")).not.toHaveProperty("search");
  });

  it("a search restored from the URL shows in the box; no result says so", async () => {
    cx.results["apps:list"] = page([]);
    await ui(<Apps />, "/apps?q=zzz");
    expect(searchBox(appsStrings.searchLabel).value).toBe("zzz");
    expect(screen.getByText(strings.table.noResults("zzz"))).toBeTruthy();
  });

  it("with a total: records, page count, the last page is the opposite order with total mod page size rows", async () => {
    cx.results["apps:count"] = { total: 23 };
    cx.results["apps:list"] = (args: Record<string, unknown>) => {
      const { numItems, cursor } = args.paginationOpts as { numItems: number; cursor: string | null };
      return page(apps(numItems), { isDone: cursor === null && numItems === 10 ? false : true, continueCursor: "CUR" });
    };
    await ui(<Apps />, "/apps");
    expect(screen.getByText(`${strings.pager.records(23)} · ${strings.pager.pageOf(1, 3)}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.pager.goTo(3) }));
    expect(where()).toBe("/apps?page=3");
    expect(last("apps:list")).toEqual({ archived: false, paginationOpts: { numItems: 3, cursor: null }, sort: { key: "created", dir: "asc" } });
    // The rows of the reverse read are shown in the list's own order.
    const names = screen.getAllByRole("link", { name: /^App / }).map((a) => a.textContent);
    expect(names).toEqual([...names].sort().reverse());
    expect(screen.getByText(`${strings.pager.records(23)} · ${strings.pager.pageOf(3, 3)}`)).toBeTruthy();
  });

  it("a refresh on the last page (a total is known) reopens it; a page that cannot be reached falls back to page 1", async () => {
    cx.results["apps:count"] = { total: 23 };
    cx.results["apps:list"] = page(apps(3));
    await ui(<Apps />, "/apps?page=3");
    await waitFor(() => expect(last("apps:list")).toMatchObject({ paginationOpts: { numItems: 3, cursor: null }, sort: { key: "created", dir: "asc" } }));
    expect(where()).toBe("/apps?page=3");
    cleanup();
    cx.requests = [];
    await ui(<Apps />, "/apps?page=2");
    await waitFor(() => expect(where()).toBe("/apps"));
    expect(last("apps:list")).toMatchObject({ paginationOpts: { numItems: 10, cursor: null } });
  });

  it("without a total (archived tab) the pager shows Page N only and Next/Previous", async () => {
    cx.results["apps:count"] = { total: null };
    cx.results["apps:list"] = page(apps(10), { isDone: false, continueCursor: "CUR1" });
    await ui(<Apps />, "/apps?archived=1");
    expect(screen.getByText(strings.pager.page(1))).toBeTruthy();
    expect(screen.queryByText(/records/)).toBeNull();
    expect(last("apps:list")).toMatchObject({ archived: true });
    fireEvent.click(screen.getByRole("button", { name: strings.pager.next }));
    expect(screen.getByText(strings.pager.page(2))).toBeTruthy();
    expect(where()).toBe("/apps?archived=1&page=2");
    fireEvent.click(screen.getByRole("button", { name: strings.pager.previous }));
    expect(last("apps:list")).toMatchObject({ paginationOpts: { numItems: 10, cursor: null } });
  });

  it("changing the page size or the tab starts over on page 1 and keeps the rest", async () => {
    cx.results["apps:list"] = page(apps(10), { isDone: false, continueCursor: "CUR1" });
    await ui(<Apps />, "/apps?sort=name&dir=asc");
    fireEvent.click(screen.getByRole("button", { name: strings.pager.next }));
    expect(where()).toBe("/apps?sort=name&dir=asc&page=2");
    await screen.findByLabelText(strings.pager.rowsPerPage); // the dropdown is a lazy chunk
    pickOption(strings.pager.rowsPerPage, "50");
    expect(where()).toBe("/apps?sort=name&dir=asc&size=50");
    expect(last("apps:list")).toEqual({ archived: false, paginationOpts: { numItems: 50, cursor: null }, sort: { key: "name", dir: "asc" } });
    fireEvent.click(screen.getByRole("radio", { name: appsStrings.archived }));
    expect(where()).toContain("archived=1");
    expect(where()).not.toContain("page=");
  });

  it("the whole row opens the app; the real link in the name cell still works", async () => {
    cx.results["apps:list"] = page([app(1), app(2)]);
    await ui(<Apps />, "/apps");
    const row = screen.getByRole("link", { name: "App 01" }).closest("tr") as HTMLElement;
    expect(row.getAttribute("data-clickable")).toBe("true");
    expect(screen.getByRole("link", { name: "App 01" }).getAttribute("href")).toBe("/apps/a1");
    fireEvent.click(within(row).getAllByRole("cell")[1]!); // the Type cell
    expect(where()).toBe("/apps/a1");
  });

  it("the Cards view keeps the same rows and offers a sort select that sends the same sort", async () => {
    localStorage.setItem(VIEW_KEY, "cards");
    cx.results["apps:list"] = page(apps(2));
    await ui(<Apps />, "/apps");
    // The cards code is a lazy chunk: the list appears a moment after the first render.
    const list = await screen.findByRole("list", { name: appsStrings.title });
    expect(screen.queryByRole("table")).toBeNull();
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    await screen.findByLabelText(strings.table.sortSelect);
    pickOption(strings.table.sortSelect, strings.table.sortOption(appsStrings.colName, strings.table.sortDir.name.desc));
    expect(where()).toBe("/apps?sort=name&dir=desc");
    expect(last("apps:list")).toMatchObject({ sort: { key: "name", dir: "desc" } });
    expect(screen.getAllByRole("link", { name: /^App / })).toHaveLength(2);
  });

  it("an error shows Try again; an empty tab shows its own sentence", async () => {
    cx.results["apps:list"] = new Error("boom");
    await ui(<Apps />, "/apps");
    expect(screen.getByText(strings.common.regionFailed)).toBeTruthy();
    cleanup();
    cx.results["apps:list"] = page([]);
    await ui(<Apps />, "/apps?archived=1");
    expect(screen.getByText(appsStrings.emptyArchivedTitle)).toBeTruthy();
  });
});

describe("Audit: time sort, Previous / Next, no total", () => {
  const entry = (i: number) => ({ _id: `e${i}`, at: 10_000 - i, actorType: "member", actorLabel: "owner@x.test", action: "group.renamed", summary: `Entry ${i}` });

  it("pages with the cursor the server gave, reads the direction from the URL and toggles it from the Time header", async () => {
    cx.results["audit:list"] = page(Array.from({ length: 10 }, (_, i) => entry(i)), { isDone: false, continueCursor: "CUR1" });
    await ui(<Audit />, "/audit");
    expect(last("audit:list")).toEqual({ paginationOpts: { numItems: 10, cursor: null }, sort: { key: "at", dir: "desc" } });
    expect(screen.getByText(strings.pager.page(1))).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.pager.goTo(5) })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: strings.pager.next }));
    expect(last("audit:list")).toMatchObject({ paginationOpts: { numItems: 10, cursor: "CUR1" } });
    expect(where()).toBe("/audit?page=2");
    fireEvent.click(within(header(auditStrings.colTime)).getByRole("button"));
    expect(last("audit:list")).toEqual({ paginationOpts: { numItems: 10, cursor: null }, sort: { key: "at", dir: "asc" } });
    expect(where()).toBe("/audit?sort=at&dir=asc");
    expect(header(auditStrings.colTime).getAttribute("aria-sort")).toBe("ascending");
  });

  it("has no search box, and a refresh on page 3 falls back to page 1 (no cursors, no total)", async () => {
    cx.results["audit:list"] = page([entry(1)]);
    await ui(<Audit />, "/audit?page=3&size=25");
    expect(screen.queryByRole("searchbox")).toBeNull();
    await waitFor(() => expect(where()).toBe("/audit?size=25"));
    expect(last("audit:list")).toMatchObject({ paginationOpts: { numItems: 25, cursor: null } });
  });

  it("an empty log says so", async () => {
    cx.results["audit:list"] = page([]);
    await ui(<Audit />, "/audit");
    expect(screen.getByText(auditStrings.emptyTitle)).toBeTruthy();
  });
});

describe("File types: a bounded table with offset cursors and an inline total", () => {
  const rule = (i: number) => ({ _id: `h${i}`, extension: `.e${String(i).padStart(2, "0")}`, appId: `a${i}`, appName: `Prog ${i}` });
  const rules = (n: number, from = 0) => Array.from({ length: n }, (_, i) => rule(from + i));

  it("reopens any page after a refresh (offset cursor), shows the total, and sorts by program", async () => {
    cx.results["fileHandlers:page"] = (args: Record<string, unknown>) => {
      const { cursor } = args.paginationOpts as { cursor: string | null };
      return page(cursor === "o:10" ? rules(4, 10) : rules(10), { total: 14, continueCursor: cursor === "o:10" ? "o:14" : "o:10", isDone: cursor === "o:10" });
    };
    await ui(<FileTypes />, "/file-types?page=2");
    await waitFor(() => expect(last("fileHandlers:page")).toMatchObject({ paginationOpts: { numItems: 10, cursor: "o:10" } }));
    expect(screen.getByText(`${strings.pager.records(14)} · ${strings.pager.pageOf(2, 2)}`)).toBeTruthy();
    expect(where()).toBe("/file-types?page=2");
    fireEvent.click(within(header(fileTypesStrings.colApp)).getByRole("button"));
    expect(last("fileHandlers:page")).toEqual({ paginationOpts: { numItems: 10, cursor: null }, sort: { key: "app", dir: "asc" } });
    expect(where()).toBe("/file-types?sort=app&dir=asc");
  });

  it("a stale page past the end goes back to page 1 once the total is known", async () => {
    cx.results["fileHandlers:page"] = page(rules(3), { total: 3, continueCursor: "o:3" });
    await ui(<FileTypes />, "/file-types?page=5");
    await waitFor(() => expect(where()).toBe("/file-types"));
    expect(last("fileHandlers:page")).toMatchObject({ paginationOpts: { numItems: 10, cursor: null } });
  });

  it("Enter searches the server (contains on extension or program); the box offers no live search", async () => {
    cx.results["fileHandlers:page"] = page(rules(1), { total: 1, continueCursor: "o:1" });
    await ui(<FileTypes />, "/file-types");
    enter(fileTypesStrings.searchLabel, "pdf");
    expect(last("fileHandlers:page")).toEqual({ paginationOpts: { numItems: 10, cursor: null }, sort: { key: "extension", dir: "asc" }, search: "pdf" });
    expect(where()).toBe("/file-types?q=pdf");
  });

  it("the row opens the program; Remove (a button in the row) opens its dialog and does not navigate", async () => {
    cx.results["fileHandlers:page"] = page(rules(2), { total: 2, continueCursor: "o:2" });
    await ui(<FileTypes />, "/file-types");
    fireEvent.click(screen.getByRole("button", { name: `${strings.common.remove} .e00` }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(where()).toBe("/file-types");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: strings.common.cancel }));
    const row = screen.getByText(".e01").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByText(".e01"));
    expect(where()).toBe("/apps/a1");
  });

  it("the program picker subscribes to apps:options only while the add dialog is open", async () => {
    cx.results["fileHandlers:page"] = page(rules(1), { total: 1, continueCursor: "o:1" });
    cx.results["apps:options"] = [{ _id: "a9", name: "Reader", kind: "desktop", canOpenFiles: true }];
    await ui(<FileTypes />, "/file-types");
    expect(cx.requests.some((r) => r.name === "apps:options")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: fileTypesStrings.add }));
    expect(cx.requests.some((r) => r.name === "apps:options")).toBe(true);
    expect(screen.getByRole("option", { name: "Reader" })).toBeTruthy();
  });
});

describe("Enrollment: action rows", () => {
  const code = (i: number) => ({
    _id: `t${i}`,
    label: `Code ${i}`,
    groupId: "g1",
    groupName: "Front desk",
    usesLeft: 1,
    usesTotal: 2,
    expiresAt: Date.now() + 3_600_000,
    createdAt: Date.now() - 60_000,
    state: "active",
    createdByEmail: "admin@x.test",
  });

  it("is a list of cards: the sort control sorts by created or expires on the server; Next opens the next page; a click on the card does nothing", async () => {
    cx.results["groups:list"] = [{ _id: "g1", name: "Front desk", revision: 0, createdAt: 1, devices: { count: 0, more: false }, employees: { count: 0, more: false } }];
    cx.results["enrollmentCodes:list"] = page(Array.from({ length: 10 }, (_, i) => code(i)), { isDone: false, continueCursor: "CUR1" });
    await ui(<Enrollment />, "/enrollment");
    await screen.findByRole("list", { name: "Enrollment codes" });
    expect(screen.queryByRole("table")).toBeNull();
    expect(last("enrollmentCodes:list")).toMatchObject({ paginationOpts: { numItems: 10, cursor: null }, sort: { key: "created", dir: "desc" } });
    pickOption(strings.table.sortSelect, "Expires: newest first");
    expect(last("enrollmentCodes:list")).toMatchObject({ sort: { key: "expires", dir: "desc" } });
    expect(where()).toBe("/enrollment?sort=expires&dir=desc");
    fireEvent.click(screen.getByRole("button", { name: strings.pager.next }));
    expect(last("enrollmentCodes:list")).toMatchObject({ paginationOpts: { numItems: 10, cursor: "CUR1" }, sort: { key: "expires", dir: "desc" } });
    const card = screen.getByText("Code 0").closest("article") as HTMLElement;
    expect(card.getAttribute("data-clickable")).toBeNull();
    fireEvent.click(card);
    expect(where()).toBe("/enrollment?sort=expires&dir=desc&page=2");
  });

  it("Revoke (a button on the card) opens the confirm dialog", async () => {
    cx.results["groups:list"] = [];
    cx.results["enrollmentCodes:list"] = page([code(1)]);
    await ui(<Enrollment />, "/enrollment");
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Code 1" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
describe("Settings > Members: two lists on one page", () => {
  const member = (i: number, over: object = {}) => ({
    _id: `m${i}`,
    email: `user${String(i).padStart(2, "0")}@x.test`,
    role: "viewer",
    status: "active",
    createdAt: 1_000 * i,
    isYou: false,
    revision: 0,
    ...over,
  });
  const invite = (i: number) => ({ _id: `i${i}`, email: `invitee${i}@x.test`, role: "viewer", kind: "join", expiresAt: Date.now() + 86_400_000, createdAt: 1_000 * i });

  it("members and invites keep separate page, sort and search in one URL (invites use the i prefix)", async () => {
    cx.results["members:page"] = page(Array.from({ length: 10 }, (_, i) => member(i)), { total: 14, continueCursor: "o:10", isDone: false });
    cx.results["members:invitesPage"] = page(Array.from({ length: 10 }, (_, i) => invite(i)), { total: 12, continueCursor: "o:10", isDone: false });
    await ui(<MembersTab />, "/settings?tab=members");
    expect(last("members:page")).toEqual({ paginationOpts: { numItems: 10, cursor: null }, sort: { key: "email", dir: "asc" } });
    expect(last("members:invitesPage")).toMatchObject({ paginationOpts: { numItems: 10, cursor: null }, sort: { key: "created", dir: "desc" } });
    const [membersPager, invitesPager] = screen.getAllByRole("navigation", { name: strings.pager.nav });

    // Members page 2 uses the offset cursor and does not move the invites list.
    fireEvent.click(within(membersPager!).getByRole("button", { name: strings.pager.next }));
    expect(last("members:page")).toMatchObject({ paginationOpts: { numItems: 10, cursor: "o:10" } });
    expect(last("members:invitesPage")).toMatchObject({ paginationOpts: { numItems: 10, cursor: null } });
    expect(where()).toBe("/settings?tab=members&page=2");

    // Invites: a header click and a search use the prefixed names.
    fireEvent.click(within(header(settingsStrings.members.colExpires)).getByRole("button"));
    expect(last("members:invitesPage")).toMatchObject({ sort: { key: "expires", dir: "asc" } });
    expect(where()).toBe("/settings?tab=members&page=2&isort=expires&idir=asc");
    enter(settingsStrings.members.invitesSearchLabel, "invitee1");
    expect(last("members:invitesPage")).toMatchObject({ search: "invitee1" });
    expect(where()).toContain("iq=invitee1");
    // Both totals are the exact ones the server reported.
    expect(within(membersPager!.parentElement!).getByText(`${strings.pager.records(14)} · ${strings.pager.pageOf(2, 2)}`)).toBeTruthy();
    expect(within(invitesPager!.parentElement!).getByText(/12 records/)).toBeTruthy();
  });

  it("sorting the members by role goes to the server and starts over on page 1", async () => {
    cx.results["members:page"] = page([member(1)], { total: 1, continueCursor: "o:1" });
    cx.results["members:invitesPage"] = page([], { total: 0, continueCursor: "o:0" });
    await ui(<MembersTab />, "/settings?tab=members&page=1");
    fireEvent.click(within(header(settingsStrings.members.colRole)).getByRole("button"));
    expect(last("members:page")).toEqual({ paginationOpts: { numItems: 10, cursor: null }, sort: { key: "role", dir: "asc" } });
    expect(where()).toBe("/settings?tab=members&sort=role&dir=asc");
    // No pending invites: no invites card.
    expect(screen.queryByText(settingsStrings.members.pendingInvites)).toBeNull();
  });

  it("Revoke on an invite row is a button of the row; the member actions stay buttons too", async () => {
    cx.results["members:page"] = page([member(1)], { total: 1, continueCursor: "o:1" });
    cx.results["members:invitesPage"] = page([invite(1)], { total: 1, continueCursor: "o:1" });
    await ui(<MembersTab />, "/settings?tab=members", "owner");
    fireEvent.click(screen.getByRole("button", { name: `${settingsStrings.members.revokeInvite}: invitee1@x.test` }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: `${settingsStrings.members.changeRole}: user01@x.test` })).toBeTruthy();
  });
});

describe("HistoryPanel: a small list in a card", () => {
  const entry = (i: number) => ({ _id: `e${i}`, at: 10_000 - i, actorType: "member", actorLabel: "owner@x.test", action: "group.renamed", summary: `Entry ${i}` });

  it("keeps its page in the component (not the URL), reads audit:forTarget one page at a time, and has no total", async () => {
    cx.results["audit:forTarget"] = page(Array.from({ length: 10 }, (_, i) => entry(i)), { isDone: false, continueCursor: "CUR1" });
    await ui(<HistoryPanel targetId="d1" />, "/apps/a1");
    expect(last("audit:forTarget")).toEqual({ targetId: "d1", paginationOpts: { numItems: 10, cursor: null }, sort: { key: "at", dir: "desc" } });
    fireEvent.click(screen.getByRole("button", { name: strings.pager.next }));
    expect(last("audit:forTarget")).toMatchObject({ paginationOpts: { numItems: 10, cursor: "CUR1" } });
    expect(screen.getByText(strings.pager.page(2))).toBeTruthy();
    expect(where()).toBe("/apps/a1");
    await screen.findByLabelText(strings.pager.rowsPerPage); // the dropdown is a lazy chunk
    pickOption(strings.pager.rowsPerPage, "25");
    expect(last("audit:forTarget")).toMatchObject({ paginationOpts: { numItems: 25, cursor: null } });
    expect(where()).toBe("/apps/a1");
  });

  it("an empty history says so", async () => {
    cx.results["audit:forTarget"] = page([]);
    await ui(<HistoryPanel targetId="d1" />, "/apps/a1");
    expect(screen.getByText(auditStrings.historyNone)).toBeTruthy();
  });
});

describe("App page: install status and group assignments", () => {
  const program = {
    _id: "a1",
    name: "Reader",
    kind: "desktop",
    desktop: { source: "preinstalled", exe: "{ProgramFiles}\\Reader\\reader.exe", args: [], fileArgTemplate: [], resetFolders: [] },
    archived: false,
    revision: 3,
    createdAt: 1,
    assignments: [] as unknown[],
    fileTypes: [],
    directEmployeeCount: 0,
    groupOptions: [],
  };
  const assignment = (i: number) => ({
    _id: `x${i}`,
    appId: "a1",
    appName: "Reader",
    appKind: "desktop",
    audience: i % 2 ? "everyone" : "selected",
    pinnedTaskbar: false,
    pinnedDesktop: true,
    groupId: `g${i}`,
    groupName: `Group ${String(i).padStart(2, "0")}`,
  });

  it("assignments are a table with a small pager once there are more than 10; the row opens the group", async () => {
    cx.results["apps:get"] = { ...program, assignments: Array.from({ length: 12 }, (_, i) => assignment(i)) };
    await ui(<AppEdit />, "/apps/a1?tab=access");
    const table = screen.getByRole("table", { name: appEditStrings.assignments });
    expect(within(table).getAllByRole("row")).toHaveLength(11); // header + 10
    fireEvent.click(screen.getByRole("button", { name: strings.pager.goTo(2) }));
    expect(within(table).getAllByRole("row")).toHaveLength(3); // header + 2
    expect(within(table).getByRole("link", { name: "Group 10" })).toBeTruthy();
    fireEvent.click(within(table).getByText("Group 11"));
    expect(screen.getByText("group page")).toBeTruthy();
    // Nothing was asked of the server for it: the groups come with apps:get.
    expect(cx.requests.some((r) => r.name.startsWith("groups:"))).toBe(false);
  });

  it("a few assignments show no pager", async () => {
    cx.results["apps:get"] = { ...program, assignments: [assignment(1), assignment(2)] };
    await ui(<AppEdit />, "/apps/a1?tab=access");
    const table = screen.getByRole("table", { name: appEditStrings.assignments });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: strings.pager.goTo(2) })).toBeNull();
  });

  it("the install list sorts by update time on the server and starts over when the state changes; its row opens the PC", async () => {
    cx.results["apps:get"] = program;
    cx.results["apps:installSummary"] = { pending: 0, downloading: 0, installing: 0, installed: 20, failed: 3, removing: 0, removed: 0, unsupported: 0 };
    cx.results["apps:installs"] = (args: Record<string, unknown>) =>
      page([{ _id: "i1", deviceId: "d1", deviceName: "Front desk", state: args.state, attempts: 1, updatedAt: Date.now() }], { isDone: false, continueCursor: "CUR1" });
    await ui(<AppEdit />, "/apps/a1?tab=installs");
    expect(last("apps:installs")).toEqual({ appId: "a1", state: "installed", paginationOpts: { numItems: 10, cursor: null }, sort: { key: "updated", dir: "desc" } });
    fireEvent.click(screen.getByRole("button", { name: strings.pager.next }));
    expect(last("apps:installs")).toMatchObject({ paginationOpts: { numItems: 10, cursor: "CUR1" } });
    fireEvent.click(within(header(appEditStrings.colUpdated)).getByRole("button"));
    expect(last("apps:installs")).toMatchObject({ paginationOpts: { numItems: 10, cursor: null }, sort: { key: "updated", dir: "asc" } });
    fireEvent.click(screen.getByRole("button", { name: strings.pager.next }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`${installStateStrings.failed}\\s*3$`) }));
    expect(last("apps:installs")).toMatchObject({ state: "failed", paginationOpts: { numItems: 10, cursor: null } });
    // The URL is not touched by a list inside a card.
    expect(where()).toBe("/apps/a1?tab=installs");
    fireEvent.click(screen.getByText("Front desk").closest("tr")!.querySelectorAll("td")[1]!);
    expect(screen.getByText("device page")).toBeTruthy();
  });
});
