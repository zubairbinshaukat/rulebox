import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { ReactNode } from "react";
import type { Me, PlanScreen } from "../data/types";
import { MeContext } from "../lib/member";
import { setStepUpHandler } from "../lib/stepUpRetry";
import { strings } from "../lib/strings";

// Phase 4 Step 5 screens against the LIVE data seam with the Convex React
// hooks mocked: every query answers from `cx.results[<function name>]`, every
// mutation / action calls `cx.fns[<function name>]`. Covers the states the
// screens must handle (limit reached, has_dependents, stale edit, hotkey
// grammar, weak PIN, step-up retry), not the backend (convex/*.test.ts).
const cx = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: unknown }>) =>
    Object.fromEntries(Object.entries(req).map(([k, r]) => [k, cx.results[getFunctionName(r.query)]])),
  useQuery: () => undefined,
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
import Groups from "./Groups";
import GroupDetail from "./GroupDetail";
import { AdminExitTab } from "./settings/AdminExitTab";
import { OrganizationTab } from "./settings/OrganizationTab";
import { exit as exitText, planLimitMessage } from "./settings/strings";
import { groupText } from "./groups/strings";

const admin: Me = {
  email: "admin@x.test",
  role: "admin",
  status: "active",
  orgId: "org",
  orgName: "Acme",
  mfa: { enrolled: true, required: true, verified: true },
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
  cx.fns = {};
});

let offHandler: (() => void) | null = null;
afterEach(() => {
  offHandler?.();
  offHandler = null;
});

describe("Groups list (groups:list)", () => {
  it("loading shows skeleton rows, then the list with capped counts (500+)", () => {
    const { rerender } = ui(<Groups />, "admin", "/groups");
    expect(screen.queryByRole("table")).toBeNull();
    cx.results["groups:list"] = [groupRow("g1", "Front desk", 500, true), groupRow("g2", "Office", 2)];
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
  });

  it("empty: one sentence and the primary action; a viewer gets no action", () => {
    cx.results["groups:list"] = [];
    ui(<Groups />, "admin", "/groups");
    expect(screen.getByText(strings.groups.emptyTitle)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: strings.groups.add }).length).toBe(2);
  });

  it("viewer: read-only (no New group)", () => {
    cx.results["groups:list"] = [groupRow("g1", "Front desk")];
    ui(<Groups />, "viewer", "/groups");
    expect(screen.queryByRole("button", { name: strings.groups.add })).toBeNull();
  });

  it("an error shows Try again", () => {
    cx.results["groups:list"] = new ConvexError({ code: "forbidden" });
    ui(<Groups />, "admin", "/groups");
    expect(screen.getByText(strings.common.regionFailed)).toBeTruthy();
    expect(screen.getByRole("button", { name: strings.common.tryAgain })).toBeTruthy();
  });

  it("the 4th group on the Free plan is refused with the plan-limit message (and no upgrade button)", async () => {
    cx.results["groups:list"] = [groupRow("g1", "A"), groupRow("g2", "B"), groupRow("g3", "C")];
    cx.results["settings:plan"] = freePlan;
    const create = vi.fn(async () => {
      throw new ConvexError({ code: "plan_limit", detail: "groups" });
    });
    cx.fns["groups:create"] = create;
    ui(<Groups />, "admin", "/groups");
    fireEvent.click(screen.getByRole("button", { name: strings.groups.add }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(groupText.usage(3, 3, "Free"))).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(new RegExp(strings.groups.name)), { target: { value: "D" } });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.common.create }));
    const message = planLimitMessage("groups", "free", 3);
    expect(await within(dialog).findByText(message)).toBeTruthy();
    expect(message).toContain("Contact us to upgrade.");
    expect(create).toHaveBeenCalledWith({ name: "D", description: undefined });
    expect(screen.queryByRole("button", { name: /upgrade/i })).toBeNull();
  });

  it("a taken name is shown under the name field (conflict, aria-describedby)", async () => {
    cx.results["groups:list"] = [groupRow("g1", "Front desk")];
    cx.fns["groups:create"] = vi.fn(async () => {
      throw new ConvexError({ code: "conflict", field: "name" });
    });
    ui(<Groups />, "admin", "/groups");
    fireEvent.click(screen.getByRole("button", { name: strings.groups.add }));
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByLabelText(new RegExp(strings.groups.name)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Front desk" } });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.common.create }));
    const error = await within(dialog).findByText(groupText.nameTaken);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain(error.closest("p")!.id);
  });
});

describe("Group detail (groups:get)", () => {
  const detail = (revision: number, name = "Office", devices = 0) => ({
    group: { ...groupRow("g1", name, devices), revision, description: "Back office" },
    apps: [{ appId: "a1", name: "Notepad", kind: "desktop", audience: "everyone", pinnedTaskbar: true, pinnedDesktop: false }],
  });

  it("apps are read-only; devices and employees say 'Coming in a later step'", () => {
    cx.results["groups:get"] = detail(0);
    ui(<GroupDetail />, "admin", "/groups/g1");
    expect(screen.getByRole("heading", { level: 1, name: "Office" })).toBeTruthy();
    expect(screen.getByText("Notepad")).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.group.assign })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getAllByText(strings.app.comingLater).length).toBeGreaterThanOrEqual(2);
  });

  it("delete is blocked up front by what the screen knows (devices, apps)", () => {
    cx.results["groups:get"] = detail(0, "Office", 3);
    ui(<GroupDetail />, "admin", "/groups/g1");
    fireEvent.click(screen.getByRole("button", { name: strings.common.delete }));
    expect(within(screen.getByRole("dialog")).getByText(groupText.hasDependents("devices, apps"))).toBeTruthy();
  });

  it("has_dependents from the server (enrollment codes) is explained in the dialog", async () => {
    cx.results["groups:get"] = { ...detail(0), apps: [] };
    cx.fns["groups:remove"] = vi.fn(async () => {
      throw new ConvexError({ code: "has_dependents", detail: "enrollment codes" });
    });
    ui(<GroupDetail />, "admin", "/groups/g1");
    fireEvent.click(screen.getByRole("button", { name: strings.common.delete }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Office" } });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.common.delete }));
    const text = groupText.hasDependents("enrollment codes");
    expect(await within(dialog).findByText(text)).toBeTruthy();
    expect(text).toContain("revoke them");
  });

  it("rename: stale_edit shows 'Someone else changed this'; Reload takes their values and revision", async () => {
    cx.results["groups:get"] = detail(2);
    const rename = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "stale_edit" }))
      .mockResolvedValueOnce({ revision: 4 });
    cx.fns["groups:rename"] = rename;
    const view = ui(<GroupDetail />, "admin", "/groups/g1");
    fireEvent.click(screen.getByRole("button", { name: strings.common.edit }));
    let dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(new RegExp(strings.groups.name)), { target: { value: "Mine" } });
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
    expect((within(dialog).getByLabelText(new RegExp(strings.groups.name)) as HTMLInputElement).value).toBe("Theirs");
    fireEvent.change(within(dialog).getByLabelText(new RegExp(strings.groups.description)), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.common.save }));
    await waitFor(() => expect(rename).toHaveBeenCalledTimes(2));
    // "" clears the description on the server.
    expect(rename.mock.calls[1]![0]).toEqual({ groupId: "g1", expectedRevision: 3, name: "Theirs", description: "" });
  });

  it("viewer: no Edit or Delete", () => {
    cx.results["groups:get"] = detail(0);
    ui(<GroupDetail />, "viewer", "/groups/g1");
    expect(screen.queryByRole("button", { name: strings.common.edit })).toBeNull();
    expect(screen.queryByRole("button", { name: strings.common.delete })).toBeNull();
  });
});

describe("Settings → Admin exit (settings:get / update / setExitPin / clearExitPin)", () => {
  it("an invalid key combination names the grammar rule as you type and is never sent", async () => {
    cx.results["settings:get"] = settingsData();
    const update = vi.fn();
    cx.fns["settings:update"] = update;
    ui(<AdminExitTab />);
    const input = screen.getByLabelText(new RegExp(exitText.hotkey)) as HTMLInputElement;
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
    const input = screen.getByLabelText(new RegExp(exitText.hotkey)) as HTMLInputElement;
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
    expect((screen.getByLabelText(new RegExp(exitText.hotkey)) as HTMLInputElement).disabled).toBe(true);
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
    const pin = within(dialog).getByLabelText(new RegExp(exitText.newPin)) as HTMLInputElement;
    const repeat = within(dialog).getByLabelText(new RegExp(exitText.repeatPin)) as HTMLInputElement;
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
    fireEvent.change(within(dialog).getByLabelText(new RegExp(exitText.newPin)), { target: { value: "246813" } });
    fireEvent.change(within(dialog).getByLabelText(new RegExp(exitText.repeatPin)), { target: { value: "246813" } });
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
    fireEvent.change(within(dialog).getByLabelText(new RegExp(exitText.newPin)), { target: { value: "246813" } });
    fireEvent.change(within(dialog).getByLabelText(new RegExp(exitText.repeatPin)), { target: { value: "246813" } });
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
    const days = screen.getByLabelText(/Offline sign-in/) as HTMLInputElement;
    fireEvent.change(days, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    const error = await screen.findByText(strings.errors.invalidArgument);
    expect(days.getAttribute("aria-describedby")).toContain(error.closest("p")!.id);
  });
});
