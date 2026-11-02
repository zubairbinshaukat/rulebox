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

// Phase 4 Step 7 screens (Devices, DeviceDetail) against the LIVE data seam
// with the Convex React hooks mocked: queries answer from `cx.results`,
// paginated ones from `cx.pages`, writes call `cx.fns` (convex/fleet.test.ts
// covers the backend).
const cx = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  pages: {} as Record<string, unknown[]>,
  paged: [] as { name: string; args: unknown }[],
  queried: [] as string[],
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: unknown }>) =>
    Object.fromEntries(
      Object.entries(req).map(([k, r]) => {
        cx.queried.push(getFunctionName(r.query));
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
  mfa: { enrolled: true, required: true, verified: true },
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
  cx.fns = {};
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Devices (fleet:list)", () => {
  it("shows online and offline from the presence row, the group, the summary and the policy columns", () => {
    cx.results["groups:list"] = [];
    cx.pages["fleet:list"] = [
      row("d1", "Front desk"),
      row("d2", "Back office PC", { presence: { online: false, since: Date.now() - 3 * HOUR, revoked: false }, groupId: undefined, groupName: undefined }),
      row("d3", "Never seen", { presence: { online: false, since: null, revoked: false }, summary: null, latestVersion: null }),
    ];
    ui(<Devices />, "viewer", "/devices");
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]!).getByText(strings.common.online)).toBeTruthy();
    expect(within(rows[1]!).getByText("26100")).toBeTruthy();
    expect(within(rows[2]!).getByText(strings.common.offline)).toBeTruthy();
    expect(within(rows[2]!).getByText(/^since /)).toBeTruthy();
    expect(within(rows[2]!).getByText(strings.devices.noGroup)).toBeTruthy();
    expect(within(rows[3]!).getByText(strings.common.neverSeen)).toBeTruthy();
    // The viewer sees no admin action.
    expect(screen.queryByRole("button", { name: strings.devices.checkNow })).toBeNull();
    expect(cx.paged.at(-1)).toEqual({ name: "fleet:list", args: {} });
  });

  it("passes the group filter to the list", () => {
    cx.results["groups:list"] = [{ _id: "g1", name: "Sales", createdAt: 1, revision: 0, devices: { count: 1, more: false }, employees: { count: 0, more: false } }];
    ui(<Devices />, "viewer", "/devices?group=g1");
    expect(cx.paged.at(-1)).toEqual({ name: "fleet:list", args: { groupId: "g1" } });
  });

  it("offers a No group filter: it sends groupId none at once (no waiting for the groups) and keeps it in the URL", () => {
    ui(<Devices />, "viewer", "/devices?group=none");
    expect(cx.paged.at(-1)).toEqual({ name: "fleet:list", args: { groupId: "none" } });
    expect((screen.getByLabelText(strings.devices.groupFilter) as HTMLSelectElement).value).toBe("none");
  });

  it("choosing No group in the filter lists the PCs without a group, and All groups goes back", async () => {
    cx.results["groups:list"] = [{ _id: "g1", name: "Sales", createdAt: 1, revision: 0, devices: { count: 1, more: false }, employees: { count: 0, more: false } }];
    ui(<Devices />, "viewer", "/devices");
    const select = screen.getByLabelText(strings.devices.groupFilter) as HTMLSelectElement;
    expect(within(select).getByRole("option", { name: strings.devices.noGroupFilter })).toBeTruthy();
    fireEvent.change(select, { target: { value: "none" } });
    await waitFor(() => expect(cx.paged.at(-1)).toEqual({ name: "fleet:list", args: { groupId: "none" } }));
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(cx.paged.at(-1)).toEqual({ name: "fleet:list", args: {} }));
  });

  it("badges a PC that is over the plan limit or suspended; ok, null and a missing state show nothing", () => {
    cx.results["groups:list"] = [];
    cx.pages["fleet:list"] = [
      row("d1", "Over PC", { planState: "overLimit" }),
      row("d2", "Suspended PC", { planState: "suspended" }),
      row("d3", "Fine PC", { planState: "ok" }),
      row("d4", "Unpublished PC", { planState: null }),
      row("d5", "Older server PC"),
    ];
    ui(<Devices />, "viewer", "/devices");
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(within(rows[1]!).getByText(strings.devices.planOverLimit).getAttribute("title")).toBe(strings.devices.planOverLimitHint);
    expect(within(rows[2]!).getByText(strings.devices.planSuspended)).toBeTruthy();
    for (const i of [3, 4, 5]) {
      expect(within(rows[i]!).queryByText(strings.devices.planOverLimit)).toBeNull();
      expect(within(rows[i]!).queryByText(strings.devices.planSuspended)).toBeNull();
    }
  });

  it("ignores a group filter that is not a group of this organization and clears it from the URL", async () => {
    cx.results["groups:list"] = [{ _id: "g1", name: "Sales", createdAt: 1, revision: 0, devices: { count: 1, more: false }, employees: { count: 0, more: false } }];
    ui(<Devices />, "viewer", "/devices?group=gone");
    await waitFor(() => expect(cx.paged.at(-1)).toEqual({ name: "fleet:list", args: {} }));
    // The unknown id never reaches fleet:list (it would throw not_found into the region boundary).
    expect(cx.paged.some((p) => JSON.stringify(p.args).includes("gone"))).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByLabelText(strings.devices.groupFilter) as HTMLSelectElement).value).toBe("");
  });

  it("waits for the groups before running a list that has a group filter", () => {
    ui(<Devices />, "viewer", "/devices?group=g1");
    expect(cx.paged).toEqual([]);
  });

  it("caps the search text at 100 characters, typed, pasted or both", async () => {
    cx.results["groups:list"] = [];
    ui(<Devices />, "viewer", "/devices");
    const box = screen.getByRole("searchbox") as HTMLInputElement;
    expect(box.maxLength).toBe(100);
    fireEvent.change(box, { target: { value: "x".repeat(150) } });
    expect(box.value).toHaveLength(100);
    await waitFor(() => expect(cx.paged.at(-1)).toEqual({ name: "fleet:list", args: { search: "x".repeat(100) } }));
  });

  it("with more than 50 PCs loaded, Check now says it checks the first 50", async () => {
    cx.results["groups:list"] = [];
    cx.pages["fleet:list"] = Array.from({ length: 60 }, (_, i) => row(`d${i}`, `PC ${i}`));
    const checkNow = vi.fn(async () => ({ checkId: "c1" }));
    cx.fns["fleet:checkNow"] = checkNow;
    ui(<Devices />, "admin", "/devices");
    expect(screen.queryByRole("button", { name: strings.devices.checkNow })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: strings.devices.checkNowFirst(50) }));
    await waitFor(() => expect(checkNow).toHaveBeenCalledOnce());
    const calls = checkNow.mock.calls as unknown as [{ deviceIds: string[] }][];
    expect(calls[0]![0].deviceIds).toHaveLength(50);
  });

  it("an empty fleet points an admin at the enrollment screen", () => {
    cx.results["groups:list"] = [];
    ui(<Devices />, "admin", "/devices");
    expect(screen.getByText(strings.devices.emptyTitle)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /enrollment code|Add a PC/i }).length).toBeGreaterThan(0);
  });

  it("Check now asks the visible, non-revoked PCs and shows who answered", async () => {
    cx.results["groups:list"] = [];
    cx.pages["fleet:list"] = [row("d1", "Front desk"), row("d2", "Old PC", { presence: { online: false, since: 1, revoked: true } })];
    const checkNow = vi.fn(async () => ({ checkId: "c1" }));
    cx.fns["fleet:checkNow"] = checkNow;
    ui(<Devices />, "admin", "/devices");
    cx.results["fleet:checkResult"] = { requestedAt: 1, items: [{ deviceId: "d1", answered: true }] };
    fireEvent.click(screen.getByRole("button", { name: strings.devices.checkNow }));
    await waitFor(() => expect(checkNow).toHaveBeenCalledWith({ deviceIds: ["d1"] }));
    expect(await screen.findByText(strings.devices.checkResult(1, 1))).toBeTruthy();
  });

  it("Check now: the 1-per-minute limit is shown as a sentence", async () => {
    cx.results["groups:list"] = [];
    cx.pages["fleet:list"] = [row("d1", "Front desk")];
    cx.fns["fleet:checkNow"] = vi.fn(async () => {
      throw new ConvexError({ code: "rate_limited" });
    });
    ui(<Devices />, "admin", "/devices");
    fireEvent.click(screen.getByRole("button", { name: strings.devices.checkNow }));
    expect(await screen.findByText(strings.errors.rateLimited)).toBeTruthy();
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
    expect(screen.getByText(strings.device.lastContact)).toBeTruthy();
    await waitFor(() => expect(watch).toHaveBeenCalledWith({ deviceId: "d1" }));
  });

  it("lists the signing keys the PC trusts; reported empty it warns, reported nothing (older agent) it shows a dash and no warning", () => {
    cx.fns["fleet:watch"] = vi.fn(async () => ({ fastUntil: null }));
    cx.results["fleet:liveness"] = { lastContactAt: Date.now() - 20_000, online: true, fastUntil: null };
    const withKeys = (trustedKeyIds?: string[]) => detail({ report: { agentVersion: "0.4.0", os: "Windows 11", osBuild: "26100", updatedAt: Date.now() - 60_000, trustedKeyIds } });
    cx.results["fleet:get"] = withKeys(["a3f19c07d2e8b456", "00112233445566ff"]);
    open();
    expect(screen.getByText(strings.device.trustedKeys)).toBeTruthy();
    expect(screen.getByText("a3f19c07d2e8b456")).toBeTruthy();
    expect(screen.getByText("00112233445566ff")).toBeTruthy();
    expect(screen.queryByText(strings.device.noTrustedKeyTitle)).toBeNull();
    cleanup();
    cx.results["fleet:get"] = withKeys([]);
    open();
    expect(screen.getByText(strings.device.noTrustedKeyTitle)).toBeTruthy();
    expect(screen.getByText(strings.device.trustedKeysNone)).toBeTruthy();
    cleanup();
    cx.results["fleet:get"] = withKeys(undefined);
    open();
    expect(screen.queryByText(strings.device.noTrustedKeyTitle)).toBeNull();
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
    expect(screen.getByText(strings.device.lastContact)).toBeTruthy();
    expect(screen.queryByText(strings.common.neverSeen)).toBeNull();
    // The report-less Status card and the Compatibility card both say there is no report yet.
    expect(screen.getAllByText(strings.device.compatNone)).toHaveLength(2);
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
    expect(screen.getByText(strings.device.noGroupWarning)).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: strings.device.revoke }));
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: strings.device.revoke });
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
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "g2" } });
    fireEvent.click(screen.getByRole("button", { name: strings.device.move }));
    await waitFor(() => expect(move).toHaveBeenCalledWith({ deviceId: "d1", expectedRevision: 7, groupId: "g2" }));
    view.unmount();

    open("viewer");
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: strings.device.revoke })).toBeNull();
    expect(screen.queryByRole("button", { name: strings.common.rename })).toBeNull();
  });

  it("an unknown PC is a visible error (not_found has no Try again), not a blank page", () => {
    cx.results["fleet:get"] = new ConvexError({ code: "not_found" });
    open();
    expect(screen.getByRole("alert").textContent).toContain(strings.common.regionFailed);
    expect(screen.queryByRole("button", { name: strings.common.tryAgain })).toBeNull();
  });
});
