import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { ReactNode } from "react";
import type { Me } from "../data/types";
import { MeContext } from "../lib/member";
import { strings } from "../lib/strings";

// Phase 4 Step 11 screens (Employees, EmployeeDetail, the group page's
// employees) against the LIVE data seam with the Convex React hooks mocked:
// queries answer from `cx.results`, paginated ones from `cx.pages`, writes call
// `cx.fns` (convex/employees.test.ts covers the backend).
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
import { employeeDetailOf, newEmployeeOf } from "../data/live/employees";
import { messageFor } from "../lib/errors";
import EmployeeDetail from "./EmployeeDetail";
import Employees from "./Employees";
import GroupDetail from "./GroupDetail";

const admin: Me = {
  email: "admin@x.test",
  role: "admin",
  status: "active",
  orgId: "org",
  orgName: "Acme",
  mfa: { enrolled: true, required: true, verified: true },
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
            <Route path="/employees" element={node} />
            <Route path="/employees/new" element={node} />
            <Route path="/employees/:id" element={node} />
            <Route path="/groups/:id" element={node} />
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
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.removeAttribute("data-view");
});
afterEach(cleanup);

interface ListCall {
  paginationOpts: { numItems: number; cursor: string | null };
  sort?: { key: string; dir: string };
  search?: string;
  groupId?: string;
}

const row = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  _id: id,
  name,
  username: name.toLowerCase().replace(/\W+/g, "."),
  disabled: false,
  groups: [{ _id: "g1", name: "Sales" }],
  moreGroups: false,
  ...over,
});

const groupRow = { _id: "g1", name: "Sales", revision: 0, createdAt: 1, isDefault: false, devices: { count: 0, more: false }, employees: { count: 1, more: false } };

const detail = (over: Record<string, unknown> = {}) => ({
  _id: "e1",
  name: "Maya Lee",
  username: "maya",
  disabled: false,
  revision: 3,
  passwordSet: true,
  passwordSetAt: Date.now() - 60_000,
  createdAt: 1,
  groupIds: ["g1"],
  appIds: [],
  lockout: null,
  groupOptions: [
    { _id: "g1", name: "Sales" },
    { _id: "g2", name: "Ops" },
  ],
  appOptions: [{ _id: "a1", name: "Docs", kind: "web", canOpenFiles: false }],
  defaultQuotaGb: 10,
  ...over,
});

describe("Employees list (employees:list, one server-driven page at a time)", () => {
  const listPage = (rows: unknown[], over: Record<string, unknown> = {}) => ({ page: rows, isDone: true, continueCursor: "cur-next", ...over });
  const last = (name: string) => [...cx.queried].reverse().find((q) => q.name === name);
  const listArgs = () => last("employees:list")!.args as unknown as ListCall;
  const DEFAULT_ARGS = { paginationOpts: { numItems: 10, cursor: null }, sort: { key: "created", dir: "desc" } };
  const header = (name: string) => screen.getByRole("columnheader", { name: new RegExp(name) });

  it("lists a page with groups, quota and status; a viewer cannot add", () => {
    cx.results["employees:list"] = listPage([row("e1", "Maya Lee", { quotaGb: 25 }), row("e2", "Noor Ali", { disabled: true, groups: [] })]);
    cx.results["groups:list"] = [groupRow];
    ui(<Employees />, "viewer", "/employees");
    expect(listArgs()).toEqual(DEFAULT_ARGS);
    expect(last("employees:count")!.args).toEqual({});
    expect(screen.getByRole("link", { name: "Maya Lee" }).getAttribute("href")).toBe("/employees/e1");
    expect(screen.getAllByText("Sales").length).toBeGreaterThan(0);
    expect(screen.getByText("25 GB")).toBeTruthy();
    expect(screen.getByText(strings.employees.disabled)).toBeTruthy();
    expect(screen.queryByRole("link", { name: strings.employees.add })).toBeNull();
  });

  it("a search is employees:list's own argument, run on Enter; the server ranks it, so no sort is sent, and there is no total", async () => {
    cx.results["employees:list"] = listPage([row("e1", "Maya Lee")]);
    cx.results["employees:count"] = { total: 140 };
    cx.results["groups:list"] = [];
    ui(<Employees />, "admin", "/employees");
    expect(screen.getByText(`${strings.pager.records(140)} · ${strings.pager.pageOf(1, 14)}`)).toBeTruthy();
    const box = screen.getByRole("searchbox");
    fireEvent.change(box, { target: { value: "maya" } });
    // Typing alone asks the server for nothing new.
    expect(listArgs()).toEqual(DEFAULT_ARGS);
    cx.results["employees:count"] = { total: null };
    fireEvent.submit(box.closest("form")!);
    await waitFor(() => expect(listArgs()).toEqual({ paginationOpts: { numItems: 10, cursor: null }, search: "maya" }));
    expect(last("employees:count")!.args).toEqual({ search: "maya" });
    expect(cx.queried.some((q) => q.name === "employees:search")).toBe(false);
    expect(screen.getByText(strings.pager.page(1))).toBeTruthy();
  });

  it("the group filter goes to the server as groupId; a group's members have one order, so no header sorts", () => {
    cx.results["groups:list"] = [groupRow];
    cx.results["employees:list"] = listPage([row("e1", "Maya Lee")]);
    ui(<Employees />, "admin", "/employees?group=g1&sort=name&dir=asc");
    expect(listArgs()).toEqual({ paginationOpts: { numItems: 10, cursor: null }, groupId: "g1", sort: { key: "created", dir: "desc" } });
    expect(within(header(strings.employees.colName)).queryByRole("button")).toBeNull();
    expect(last("employees:count")!.args).toEqual({ groupId: "g1" });
  });

  it("sorts by name and username on the server; a third click on a header returns to the newest-first default", async () => {
    cx.results["groups:list"] = [];
    cx.results["employees:list"] = listPage([row("e1", "Maya Lee")]);
    ui(<Employees />, "admin", "/employees");
    const sortButton = (name: string) => within(header(name)).getByRole("button");
    fireEvent.click(sortButton(strings.employees.colName));
    await waitFor(() => expect(listArgs().sort).toEqual({ key: "name", dir: "asc" }));
    fireEvent.click(sortButton(strings.employees.colName));
    await waitFor(() => expect(listArgs().sort).toEqual({ key: "name", dir: "desc" }));
    fireEvent.click(sortButton(strings.employees.colName));
    await waitFor(() => expect(listArgs().sort).toEqual({ key: "created", dir: "desc" }));
    fireEvent.click(sortButton(strings.employees.colUsername));
    await waitFor(() => expect(listArgs().sort).toEqual({ key: "username", dir: "asc" }));
    expect(header(strings.employees.colUsername).getAttribute("aria-sort")).toBe("ascending");
    // Not every column sorts: the server has no order by groups, storage or status.
    expect(within(header(strings.employees.colGroups)).queryByRole("button")).toBeNull();
  });

  it("URL state: page size and sort are read back, invalid values fall back; page and size changes reset to page 1", async () => {
    cx.results["groups:list"] = [];
    cx.results["employees:count"] = { total: 140 };
    cx.results["employees:list"] = listPage([row("e1", "Maya Lee")], { isDone: false, continueCursor: "cur-2" });
    ui(<Employees />, "admin", "/employees?size=25&sort=username&dir=desc");
    expect(listArgs()).toEqual({ paginationOpts: { numItems: 25, cursor: null }, sort: { key: "username", dir: "desc" } });
    fireEvent.click(screen.getByRole("button", { name: strings.pager.next }));
    await waitFor(() => expect(listArgs().paginationOpts).toEqual({ numItems: 25, cursor: "cur-2" }));
    fireEvent.change(screen.getByLabelText(strings.pager.rowsPerPage), { target: { value: "50" } });
    await waitFor(() => expect(listArgs().paginationOpts).toEqual({ numItems: 50, cursor: null }));
    cleanup();
    ui(<Employees />, "admin", "/employees?size=9&sort=password&dir=asc");
    expect(listArgs()).toEqual(DEFAULT_ARGS);
  });

  it("the whole row opens the employee; the name stays a real link", async () => {
    cx.results["groups:list"] = [];
    cx.results["employees:list"] = listPage([row("e1", "Maya Lee", { quotaGb: 25 })]);
    ui(<Employees />, "admin", "/employees");
    fireEvent.click(screen.getByText("25 GB"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/employees/e1"));
  });

  it("the cards view lists the same employees as cards", () => {
    cx.results["groups:list"] = [];
    cx.results["employees:list"] = listPage([row("e1", "Maya Lee")]);
    ui(<Employees />, "admin", "/employees");
    fireEvent.click(screen.getByRole("radio", { name: strings.table.viewCards }));
    expect(document.documentElement.getAttribute("data-view")).toBe("cards");
    expect(screen.getByRole("link", { name: "Maya Lee" })).toBeTruthy();
    expect(screen.getByLabelText(strings.table.sortSelect)).toBeTruthy();
  });

  it("an empty organization says so; an empty search says nothing matched", () => {
    cx.results["groups:list"] = [];
    cx.results["employees:list"] = listPage([]);
    ui(<Employees />, "admin", "/employees");
    expect(screen.getByText(strings.employees.emptyTitle)).toBeTruthy();
    cleanup();
    ui(<Employees />, "admin", "/employees?q=zzz");
    expect(screen.getByText(strings.table.noResults("zzz"))).toBeTruthy();
  });
});

describe("EmployeeDetail (employees:get)", () => {
  it("saving is ONE call, employees:save, with the whole form and the revision; the next save uses the revision it returned", async () => {
    cx.results["employees:get"] = detail();
    const save = vi.fn(async () => ({ revision: 4 }));
    const update = vi.fn(async () => ({ revision: 99 }));
    cx.fns["employees:save"] = save;
    cx.fns["employees:update"] = update;
    cx.fns["employees:setGroups"] = update;
    cx.fns["employees:setDirectApps"] = update;
    ui(<EmployeeDetail />, "admin", "/employees/e1");
    fireEvent.click(screen.getByLabelText("Ops"));
    fireEvent.click(screen.getByLabelText(/Docs/));
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith({
      employeeId: "e1",
      expectedRevision: 3,
      name: "Maya Lee",
      username: "maya",
      quotaGb: undefined,
      groupIds: ["g1", "g2"],
      appIds: ["a1"],
    });
    // the next save starts from the revision the server returned
    fireEvent.click(screen.getByLabelText("Ops"));
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 4 }));
    expect(update).not.toHaveBeenCalled(); // none of the part-by-part functions
  });

  it("a failed save (not_ready) keeps the form's revision, so the retry is not a stale edit", async () => {
    cx.results["employees:get"] = detail();
    let calls = 0;
    const save = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new ConvexError({ code: "not_ready", detail: "signing key" });
      return { revision: 4 };
    });
    cx.fns["employees:save"] = save;
    ui(<EmployeeDetail />, "admin", "/employees/e1");
    fireEvent.click(screen.getByLabelText("Ops"));
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls.map((c) => (c as unknown as [{ expectedRevision: number }])[0].expectedRevision)).toEqual([3, 3]);
  });

  it("a stale edit shows the reload notice", async () => {
    cx.results["employees:get"] = detail();
    cx.fns["employees:save"] = async () => {
      throw new ConvexError({ code: "stale_edit" });
    };
    ui(<EmployeeDetail />, "admin", "/employees/e1");
    fireEvent.change(screen.getByLabelText(new RegExp(strings.employee.name)), { target: { value: "Maya L" } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(screen.getByText(strings.common.staleTitle)).toBeTruthy());
  });

  it("Set password: two fields, never echoed, sent to the action only; the old rule sentences", async () => {
    cx.results["employees:get"] = detail();
    const set = vi.fn(async () => null);
    cx.fns["employees:setPassword"] = set;
    ui(<EmployeeDetail />, "admin", "/employees/e1");
    fireEvent.click(screen.getByRole("button", { name: strings.employee.setPassword }));
    const dialog = screen.getByRole("dialog");
    const first = within(dialog).getByLabelText(new RegExp(`^${strings.auth.newPassword}`)) as HTMLInputElement;
    const second = within(dialog).getByLabelText(new RegExp(`^${strings.auth.repeatPassword}`)) as HTMLInputElement;
    expect(first.type).toBe("password");
    expect(second.type).toBe("password");
    // too short and not equal: nothing is sent
    fireEvent.change(first, { target: { value: "short" } });
    fireEvent.change(second, { target: { value: "other" } });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.employee.setPassword }));
    await waitFor(() => expect(within(dialog).getAllByText(strings.validate.passwordEmployee).length).toBeGreaterThan(0));
    expect(set).not.toHaveBeenCalled();
    fireEvent.change(first, { target: { value: "correct horse" } });
    fireEvent.change(second, { target: { value: "correct horse" } });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.employee.setPassword }));
    await waitFor(() => expect(set).toHaveBeenCalledWith({ employeeId: "e1", password: "correct horse" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain("correct horse");
  });

  it("a lockout in the future shows the banner and Unlock; an expired one shows nothing", async () => {
    cx.results["employees:get"] = { ...detail(), lockout: { failures: 10, lockedUntil: Date.now() + 600_000 } };
    const unlock = vi.fn(async () => null);
    cx.fns["employees:unlock"] = unlock;
    ui(<EmployeeDetail />, "admin", "/employees/e1");
    expect(screen.getByText(strings.employee.lockedTitle)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.employee.unlock }));
    await waitFor(() => expect(unlock).toHaveBeenCalledWith({ employeeId: "e1" }));
    cleanup();
    cx.results["employees:get"] = { ...detail(), lockout: { failures: 10, lockedUntil: Date.now() - 1000 } };
    ui(<EmployeeDetail />, "admin", "/employees/e1");
    expect(screen.queryByText(strings.employee.lockedTitle)).toBeNull();
  });

  it("disable and delete: the delete needs the username typed and a disabled employee", async () => {
    cx.results["employees:get"] = detail({ disabled: true });
    const remove = vi.fn(async () => null);
    cx.fns["employees:remove"] = remove;
    ui(<EmployeeDetail />, "admin", "/employees/e1");
    fireEvent.click(screen.getByRole("button", { name: strings.common.delete }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "maya" } });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.common.delete }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ employeeId: "e1" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/employees"));
  });

  it("the disable button calls setDisabled", async () => {
    cx.results["employees:get"] = detail();
    const set = vi.fn(async () => null);
    cx.fns["employees:setDisabled"] = set;
    ui(<EmployeeDetail />, "admin", "/employees/e1");
    fireEvent.click(screen.getByRole("button", { name: strings.employee.disable }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: strings.employee.disable }));
    await waitFor(() => expect(set).toHaveBeenCalledWith({ employeeId: "e1", disabled: true }));
  });

  it("a new employee: the pickers come from employees:options; create sends the form, password only to the action", async () => {
    cx.results["employees:options"] = {
      groupOptions: [{ _id: "g1", name: "Sales" }],
      appOptions: [],
      defaultQuotaGb: 10,
    };
    const create = vi.fn(async () => "e9");
    cx.fns["employees:create"] = create;
    ui(<EmployeeDetail />, "admin", "/employees/new");
    expect(cx.queried.some((q) => q.name === "employees:get")).toBe(false);
    fireEvent.change(screen.getByLabelText(new RegExp(strings.employee.name)), { target: { value: "Noor Ali" } });
    fireEvent.click(screen.getByLabelText("Sales"));
    fireEvent.change(screen.getByLabelText(new RegExp(strings.employee.passwordInitial)), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.create }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({
      name: "Noor Ali",
      username: "noor.ali",
      quotaGb: undefined,
      groupIds: ["g1"],
      appIds: [],
      password: "12345678",
    });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/employees/e9"));
  });

  it("server refusals read as sentences: taken username, signing key, plan limit, password rules", async () => {
    expect(messageFor(new ConvexError({ code: "conflict", field: "username" }))).toBe(strings.validate.usernameTaken);
    expect(messageFor(new ConvexError({ code: "not_ready", detail: "signing key" }))).toBe(strings.errors.notReadySigningKey);
    expect(messageFor(new ConvexError({ code: "plan_limit", detail: "employees" }))).toBe(strings.errors.planLimit);
    expect(messageFor(new ConvexError({ code: "invalid_argument", field: "password", detail: "length" }))).toBe(strings.validate.passwordEmployee);
    expect(messageFor(new ConvexError({ code: "invalid_argument", field: "password", detail: "username" }))).toBe(strings.validate.passwordEqualsUsername);
    // the member password rule is still the default for the field
    expect(messageFor(new ConvexError({ code: "invalid_argument", field: "password" }))).toBe(strings.validate.passwordMember);

    cx.results["employees:options"] = { groupOptions: [], appOptions: [], defaultQuotaGb: 10 };
    cx.fns["employees:create"] = async () => {
      throw new ConvexError({ code: "plan_limit", detail: "employees" });
    };
    ui(<EmployeeDetail />, "admin", "/employees/new");
    fireEvent.change(screen.getByLabelText(new RegExp(strings.employee.name)), { target: { value: "Noor" } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.create }));
    await waitFor(() => expect(screen.getByText(strings.errors.planLimit)).toBeTruthy());
  });
});

describe("live mapping", () => {
  const base = { ...detail(), _id: "e1" } as unknown as Parameters<typeof employeeDetailOf>[0];

  it("the lockout counts only while it lasts", () => {
    const until = 5_000;
    expect(employeeDetailOf({ ...base, lockout: { failures: 10, lockedUntil: until } }, 4_000).lockout).toEqual({ failures: 10, lockedUntil: until });
    expect(employeeDetailOf({ ...base, lockout: { failures: 10, lockedUntil: until } }, 5_000).lockout).toBeNull();
    expect(employeeDetailOf({ ...base, lockout: null }, 0).lockout).toBeNull();
  });

  it("the blank form carries the pickers and the default quota only", () => {
    const blank = newEmployeeOf({ groupOptions: [{ _id: "g1" as never, name: "Sales" }], appOptions: [], defaultQuotaGb: 10 });
    expect(blank).toMatchObject({ _id: "new", name: "", username: "", revision: 0, groupIds: [], appIds: [], lockout: null, defaultQuotaGb: 10 });
    expect(blank.groupOptions).toHaveLength(1);
  });
});

describe("Group page employees", () => {
  const group = {
    group: { _id: "g1", name: "Sales", revision: 0, createdAt: 1, isDefault: false, devices: { count: 0, more: false }, employees: { count: 1, more: false } },
    apps: [],
  };
  const listPage = (rows: unknown[]) => ({ page: rows, isDone: true, continueCursor: "c" });

  it("lists the members from employees:list({ groupId }) and removes one", async () => {
    cx.results["groups:get"] = group;
    cx.results["employees:list"] = listPage([row("e1", "Maya Lee")]);
    const remove = vi.fn(async () => null);
    cx.fns["groups:removeEmployee"] = remove;
    ui(<GroupDetail />, "admin", "/groups/g1");
    expect(cx.queried.find((p) => p.name === "employees:list")!.args).toEqual({ paginationOpts: { numItems: 10, cursor: null }, sort: { key: "created", dir: "desc" }, groupId: "g1" });
    fireEvent.click(screen.getByRole("button", { name: `${strings.group.removeEmployee}: Maya Lee` }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ groupId: "g1", employeeId: "e1" }));
  });

  it("the whole member row opens the employee, but its Remove button does not", async () => {
    cx.results["groups:get"] = group;
    cx.results["employees:list"] = listPage([row("e1", "Maya Lee")]);
    cx.fns["groups:removeEmployee"] = vi.fn(async () => null);
    ui(<GroupDetail />, "admin", "/groups/g1");
    fireEvent.click(screen.getByRole("button", { name: `${strings.group.removeEmployee}: Maya Lee` }));
    expect(screen.getByTestId("where").textContent).toBe("/groups/g1");
    fireEvent.click(screen.getByText("maya.lee"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/employees/e1"));
  });

  it("the add dialog subscribes to nothing until Enter, then searches the organization (employees:search) and adds", async () => {
    cx.results["groups:get"] = group;
    cx.results["employees:list"] = listPage([]);
    const add = vi.fn(async () => null);
    cx.fns["groups:addEmployee"] = add;
    ui(<GroupDetail />, "admin", "/groups/g1");
    fireEvent.click(screen.getByRole("button", { name: strings.group.addEmployee }));
    const dialog = screen.getByRole("dialog");
    // Idle until something is searched for: no employees:search subscription.
    expect(cx.queried.some((q) => q.name === "employees:search")).toBe(false);
    const box = within(dialog).getByRole("searchbox");
    fireEvent.change(box, { target: { value: "noor" } });
    expect(cx.queried.some((q) => q.name === "employees:search")).toBe(false);
    cx.results["employees:search"] = { rows: [row("e2", "Noor Ali", { groups: [] })], capped: false };
    fireEvent.submit(box.closest("form")!);
    await waitFor(() => expect(cx.queried.some((q) => q.name === "employees:search" && JSON.stringify(q.args) === JSON.stringify({ text: "noor" }))).toBe(true));
    await waitFor(() => within(dialog).getByText("Noor Ali"));
    fireEvent.click(within(dialog).getByRole("button", { name: `${strings.common.add}: Noor Ali` }));
    await waitFor(() => expect(add).toHaveBeenCalledWith({ groupId: "g1", employeeId: "e2" }));
  });
});