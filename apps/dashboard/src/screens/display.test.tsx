import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { ReactNode } from "react";
import type { DeviceDetail, GroupDetail, Me } from "../data/types";
import { MeContext } from "../lib/member";
import { strings } from "../lib/strings";
import { displayStrings as s } from "../lib/screenStrings/display";

// Phase 6 Step 19: the group's and the PC's display settings cards against the LIVE data seam with the Convex React hooks mocked
// (convex/displayMode.test.ts covers the backend).
const cx = vi.hoisted(() => ({ fns: {} as Record<string, (args?: unknown) => Promise<unknown>> }));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: () => ({}),
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
import { DeviceDisplayCard } from "./display/DeviceDisplayCard";
import { standardOnSmallPc } from "./display/rules";
import { GroupDisplayCard } from "./display/GroupDisplayCard";

const admin: Me = { email: "a@x.test", role: "admin", status: "active", orgId: "org", orgName: "Acme", pin: { required: true, set: true }, serverApiVersion: 1 };

function ui(node: ReactNode, role: Me["role"] = "admin") {
  return render(
    <ToastProvider>
      <MeContext.Provider value={{ ...admin, role }}>{node}</MeContext.Provider>
    </ToastProvider>,
  );
}

const group = (over: Partial<GroupDetail> = {}): GroupDetail => ({
  _id: "g1",
  name: "Sales",
  revision: 3,
  assignments: [],
  deviceCount: 2,
  employeeCount: 1,
  ...over,
});

const device = (over: Partial<DeviceDetail> = {}): DeviceDetail => ({
  _id: "d1",
  name: "Front desk",
  revision: 7,
  revoked: false,
  kioskEnabled: true,
  enrolledAt: 1,
  group: { _id: "g1", name: "Sales" },
  presence: { online: true, since: 1 },
  report: null,
  versions: [],
  flags: { noGroup: false, revoked: false, rotateCredential: false },
  lock: null,
  groups: [],
  ...over,
});

beforeEach(() => {
  cx.fns = {};
});
afterEach(() => cleanup());

describe("GroupDisplayCard (groups:setDisplay)", () => {
  it("sends the mode, the window limit and the idle close with the loaded revision; null means the default", async () => {
    const set = vi.fn(async () => ({ revision: 4 }));
    cx.fns["groups:setDisplay"] = set;
    ui(<GroupDisplayCard g={group()} />);
    expect(screen.getByRole("button", { name: strings.common.save }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText(s.mode), { target: { value: "lite" } });
    fireEvent.change(screen.getByLabelText(s.windowCap), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(s.idleClose), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.save }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith({ groupId: "g1", expectedRevision: 3, displayMode: "lite", webWindowCap: 2, webIdleCloseMin: 0 });
    expect(await screen.findByText(s.saved)).toBeTruthy();
  });

  it("shows what the group holds, offers every cap from 1 to 12 and a stored odd idle time, and sends null for the defaults", async () => {
    const set = vi.fn(async () => ({ revision: 4 }));
    cx.fns["groups:setDisplay"] = set;
    ui(<GroupDisplayCard g={group({ displayMode: "standard", webWindowCap: 5, webIdleCloseMin: 17 })} />);
    expect((screen.getByLabelText(s.mode) as HTMLSelectElement).value).toBe("standard");
    expect((screen.getByLabelText(s.windowCap) as HTMLSelectElement).value).toBe("5");
    expect((screen.getByLabelText(s.idleClose) as HTMLSelectElement).value).toBe("17");
    expect(screen.getAllByRole("option").filter((o) => /window/.test(o.textContent ?? "") && !/Default/.test(o.textContent ?? ""))).toHaveLength(12);
    // Standard on small PCs: a warning is shown for the group too.
    expect(screen.getByText(s.standardOnSmallGroup)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(s.mode), { target: { value: "auto" } });
    fireEvent.change(screen.getByLabelText(s.windowCap), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText(s.idleClose), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.save }));
    await waitFor(() => expect(set).toHaveBeenCalled());
    expect(set).toHaveBeenCalledWith({ groupId: "g1", expectedRevision: 3, displayMode: "auto", webWindowCap: null, webIdleCloseMin: null });
  });

  it("a stale edit is reported and the form is not cleared; a viewer only reads", async () => {
    cx.fns["groups:setDisplay"] = vi.fn(async () => {
      throw new ConvexError({ code: "stale_edit" });
    });
    const view = ui(<GroupDisplayCard g={group()} />);
    fireEvent.change(screen.getByLabelText(s.mode), { target: { value: "lite" } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.save }));
    await waitFor(() => expect(cx.fns["groups:setDisplay"]).toBeDefined());
    expect(await screen.findByText(/changed|someone/i)).toBeTruthy();
    expect((screen.getByLabelText(s.mode) as HTMLSelectElement).value).toBe("lite");
    view.unmount();
    ui(<GroupDisplayCard g={group({ displayMode: "lite" })} />, "viewer");
    expect(screen.queryByRole("button", { name: strings.common.save })).toBeNull();
    expect(screen.getByText(new RegExp(`${s.mode}: ${s.modeLite}`))).toBeTruthy();
  });
});

describe("DeviceDisplayCard (fleet:setDisplayMode)", () => {
  it("sends the PC's own choice with the loaded revision", async () => {
    const set = vi.fn(async () => ({ revision: 8 }));
    cx.fns["fleet:setDisplayMode"] = set;
    ui(<DeviceDisplayCard d={device({ displayMode: "auto", groupDisplayMode: "lite" })} />);
    expect(screen.getByText(s.groupChoice(s.modeLite))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(s.mode), { target: { value: "standard" } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.save }));
    await waitFor(() => expect(set).toHaveBeenCalledWith({ deviceId: "d1", expectedRevision: 7, displayMode: "standard" }));
  });

  it("warns when Standard (the PC's own or its group's) applies to a PC with 4 GB or less, never for automatic or a bigger PC", () => {
    expect(standardOnSmallPc("standard", "auto", 4096)).toBe(true);
    expect(standardOnSmallPc("standard", "auto", 4352)).toBe(true);
    expect(standardOnSmallPc("auto", "standard", 4096)).toBe(true);
    expect(standardOnSmallPc("lite", "standard", 4096)).toBe(false);
    expect(standardOnSmallPc("standard", "auto", 4353)).toBe(false);
    expect(standardOnSmallPc("auto", "auto", 2048)).toBe(false);
    expect(standardOnSmallPc("standard", "auto", undefined)).toBe(false);

    ui(<DeviceDisplayCard d={device({ displayMode: "standard", report: { ramMb: 4096, updatedAt: 1, outOfSupport: false } as DeviceDetail["report"] })} />);
    expect(screen.getByText(s.standardOnSmallPc)).toBeTruthy();
  });

  it("an older server (no display fields) reads as automatic; a revoked PC cannot be changed", () => {
    ui(<DeviceDisplayCard d={device({ revoked: true })} />);
    expect((screen.getByLabelText(s.mode) as HTMLSelectElement).value).toBe("auto");
    expect((screen.getByLabelText(s.mode) as HTMLSelectElement).disabled).toBe(true);
  });
});
