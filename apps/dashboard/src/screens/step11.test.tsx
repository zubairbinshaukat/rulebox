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
});
afterEach(cleanup);

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

describe("Employees list (employees:list / employees:search)", () => {
  it("lists a page with groups, quota and status; a viewer cannot add", () => {
    cx.pages["employees:list"] = [row("e1", "Maya Lee", { quotaGb: 25 }), row("e2", "Noor Ali", { disabled: true, groups: [] })];
    cx.results["groups:list"] = [groupRow];
    ui(<Employees />, "viewer", "/employees");
    expect(cx.paged.at(-1)).toEqual({ name: "employees:list", args: {} });
    expect(screen.getByRole("link", { name: "Maya Lee" }).getAttribute("href")).toBe("/employees/e1");
    expect(screen.getAllByText("Sales").length).toBeGreaterThan(0);
    expect(screen.getByText("25 GB")).toBeTruthy();
    expect(screen.getByText(strings.employees.disabled)).toBeTruthy();
    expect(screen.queryByRole("link", { name: strings.employees.add })).toBeNull();
  });

  it("typing subscribes to employees:search and stops the list; the cap is announced", async () => {
    cx.pages["employees:list"] = [row("e1", "Maya Lee")];
    cx.results["groups:list"] = [];
    ui(<Employees />, "admin", "/employees");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "maya" } });
    cx.results["employees:search"] = { rows: [row("e1", "Maya Lee")], capped: true };
    await waitFor(() => expect(cx.queried.some((q) => q.name === "employees:search" && JSON.stringify(q.args) === JSON.stringify({ text: "maya" }))).toBe(true));
    await waitFor(() => expect(cx.paged.at(-1)?.args).toBe("skip"));
    await waitFor(() => expect(screen.getByText(strings.devices.searchCap)).toBeTruthy());
  });

  it("the group filter goes to the server as groupId", () => {
    cx.results["groups:list"] = [groupRow];
    ui(<Employees />, "admin", "/employees?group=g1");
    expect(cx.paged.at(-1)).toEqual({ name: "employees:list", args: { groupId: "g1" } });
  });
});

describe("EmployeeDetail (employees:get)", () => {
  it("saving chains update, setGroups and setDirectApps with the revision each one returned", async () => {
    cx.results["employees:get"] = detail();
    const update = vi.fn(async () => ({ revision: 4 }));
    const setGroups = vi.fn(async () => ({ revision: 5 }));
    const setApps = vi.fn(async () => ({ revision: 6 }));
    cx.fns["employees:update"] = update;
    cx.fns["employees:setGroups"] = setGroups;
    cx.fns["employees:setDirectApps"] = setApps;
    ui(<EmployeeDetail />, "admin", "/employees/e1");
    fireEvent.click(screen.getByLabelText("Ops"));
    fireEvent.click(screen.getByLabelText(/Docs/));
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(setApps).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith({ employeeId: "e1", expectedRevision: 3, name: "Maya Lee", username: "maya", quotaGb: undefined });
    expect(setGroups).toHaveBeenCalledWith({ employeeId: "e1", expectedRevision: 4, groupIds: ["g1", "g2"] });
    expect(setApps).toHaveBeenCalledWith({ employeeId: "e1", expectedRevision: 5, appIds: ["a1"] });
    // the next save starts from the last revision the server returned
    fireEvent.click(screen.getByLabelText("Ops"));
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 6 }));
  });

  it("a stale edit shows the reload notice", async () => {
    cx.results["employees:get"] = detail();
    cx.fns["employees:update"] = async () => {
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

  it("lists the members from employees:list({ groupId }) and removes one", async () => {
    cx.results["groups:get"] = group;
    cx.pages["employees:list"] = [row("e1", "Maya Lee")];
    const remove = vi.fn(async () => null);
    cx.fns["groups:removeEmployee"] = remove;
    ui(<GroupDetail />, "admin", "/groups/g1");
    expect(cx.paged.some((p) => p.name === "employees:list" && JSON.stringify(p.args) === JSON.stringify({ groupId: "g1" }))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: `${strings.group.removeEmployee}: Maya Lee` }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ groupId: "g1", employeeId: "e1" }));
  });

  it("the add dialog subscribes to nothing until something is typed, then searches the organization and adds", async () => {
    cx.results["groups:get"] = group;
    cx.pages["employees:list"] = [];
    const add = vi.fn(async () => null);
    cx.fns["groups:addEmployee"] = add;
    ui(<GroupDetail />, "admin", "/groups/g1");
    fireEvent.click(screen.getByRole("button", { name: strings.group.addEmployee }));
    const dialog = screen.getByRole("dialog");
    // the dialog's own list hook is idle: no employees:list subscription for it, no search
    expect(cx.queried.some((q) => q.name === "employees:search")).toBe(false);
    fireEvent.change(within(dialog).getByRole("searchbox"), { target: { value: "noor" } });
    cx.results["employees:search"] = { rows: [row("e2", "Noor Ali", { groups: [] })], capped: false };
    await waitFor(() => expect(cx.queried.some((q) => q.name === "employees:search" && JSON.stringify(q.args) === JSON.stringify({ text: "noor" }))).toBe(true));
    await waitFor(() => within(dialog).getByText("Noor Ali"));
    fireEvent.click(within(dialog).getByRole("button", { name: `${strings.common.add}: Noor Ali` }));
    await waitFor(() => expect(add).toHaveBeenCalledWith({ groupId: "g1", employeeId: "e2" }));
  });
});
