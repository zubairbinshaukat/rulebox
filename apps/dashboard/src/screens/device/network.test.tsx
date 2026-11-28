import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { DeviceNetwork, Me } from "../../data/types";
import { MeContext } from "../../lib/member";
import { installStrings } from "../../lib/screenStrings/install";

// The Network tab against the LIVE data seam with the Convex hooks mocked: the states, the plain sentence for a detail code (and the
// code itself only under "Technical details"), the empty states with their "Add one" link (administrators only).
const cx = vi.hoisted(() => ({ results: {} as Record<string, unknown>, queried: [] as string[] }));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: unknown }>) =>
    Object.fromEntries(
      Object.entries(req).map(([k, r]) => {
        const name = getFunctionName(r.query);
        cx.queried.push(name);
        return [k, cx.results[name]];
      }),
    ),
  useQuery: () => undefined,
  useAction: () => () => Promise.resolve(),
  useMutation: () => () => Promise.resolve(),
  useConvexConnectionState: () => ({ isWebSocketConnected: true }),
}));

import NetworkTab from "./NetworkTab";
import { networkDetailText, networkStrings as s } from "./networkStrings";

const admin: Me = { email: "admin@x.test", role: "admin", status: "active", orgId: "org", orgName: "Acme", pin: { required: true, set: true }, serverApiVersion: 1 };

function open(role: Me["role"] = "admin") {
  return render(
    <MeContext.Provider value={{ ...admin, role }}>
      <MemoryRouter>
        <NetworkTab d={{ _id: "d1" }} />
      </MemoryRouter>
    </MeContext.Provider>,
  );
}

const net = (over: Partial<DeviceNetwork> = {}): DeviceNetwork => ({
  groupId: "g1",
  reportedAt: Date.now() - 60_000,
  wifi: [],
  printers: [],
  drivers: [],
  ...over,
});
const card = (title: string) => within(screen.getByRole("region", { name: title }));

beforeEach(() => {
  cx.results = {};
  cx.queried = [];
});
afterEach(cleanup);

describe("Network tab", () => {
  it("shows every item with its state in words; a failure says why, the code is only a technical detail", () => {
    cx.results["fleet:network"] = net({
      wifi: [
        { _id: "w1", name: "Shop floor", state: "working", detail: null },
        { _id: "w2", name: "Back office (hidden)", state: "failed", detail: "connect_failed" },
      ],
      printers: [
        { _id: "p1", name: "Front desk", isDefault: true, state: "working", detail: null },
        { _id: "p2", name: "Label printer", state: "waiting", isDefault: false, detail: null },
        { _id: "p3", name: "Old plotter", state: "notSupported", isDefault: false, detail: null },
      ],
      drivers: [
        { _id: "x1", name: "Flatbed scanner", state: "failed", detail: "hash_mismatch" },
        { _id: "x2", name: "Laser driver", state: "installed", detail: null },
        { _id: "x3", name: "New driver", state: "pending", detail: null },
      ],
    });
    open();
    expect(card(s.wifi).getByText(s.state.working)).toBeTruthy();
    expect(card(s.wifi).getByText(s.state.failed)).toBeTruthy();
    expect(card(s.wifi).getByText(s.wifiDetails.connect_failed!)).toBeTruthy();
    // The code is in the closed technical details, never in a sentence.
    const code = card(s.wifi).getByText("connect_failed");
    expect((code.closest("details") as HTMLDetailsElement).open).toBe(false);
    expect(card(s.printers).getByText(s.defaultPrinter)).toBeTruthy();
    expect(card(s.printers).getByText(s.state.waiting)).toBeTruthy();
    expect(card(s.printers).getByText(s.waitingLine)).toBeTruthy();
    expect(card(s.printers).getByText(s.state.notSupported)).toBeTruthy();
    expect(card(s.printers).getByText(s.unsupportedGeneric)).toBeTruthy();
    expect(card(s.drivers).getByText(s.driverDetails.hash_mismatch!)).toBeTruthy();
    expect(card(s.drivers).getByText(s.state.working)).toBeTruthy();
    expect(card(s.drivers).getByText(s.state.waiting)).toBeTruthy();
    // One word per card: the worst thing first.
    expect(card(s.wifi).getByText(s.summary.failed(1))).toBeTruthy();
    expect(card(s.printers).getByText(s.summary.notSupported(1))).toBeTruthy();
    expect(card(s.drivers).getByText(s.summary.failed(1))).toBeTruthy();
  });

  it("says all working when everything works, and subscribes to fleet:network only", () => {
    cx.results["fleet:network"] = net({ wifi: [{ _id: "w1", name: "Shop floor", state: "working", detail: null }] });
    open();
    expect(card(s.wifi).getByText(s.summary.allWorking)).toBeTruthy();
    expect(cx.queried).toEqual(["fleet:network"]);
  });

  it("an empty group says so, and an administrator gets an Add one link per kind; a viewer does not", () => {
    cx.results["fleet:network"] = net();
    open();
    expect(screen.getByText(s.none.wifi)).toBeTruthy();
    expect(screen.getByText(s.none.printers)).toBeTruthy();
    expect(screen.getByText(s.none.drivers)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: s.addOne }).map((a) => a.getAttribute("href"))).toEqual(["/networks/wifi/new", "/networks/printers/new", "/networks/drivers/new"]);
    expect(screen.getByRole("link", { name: s.openNetworks }).getAttribute("href")).toBe("/networks");
    cleanup();
    open("viewer");
    expect(screen.getByText(s.none.wifi)).toBeTruthy();
    expect(screen.queryByRole("link", { name: s.addOne })).toBeNull();
    expect(screen.queryByRole("link", { name: s.openNetworks })).toBeNull();
  });

  it("a PC that has not reported says so; a PC without a group asks for one", () => {
    cx.results["fleet:network"] = net({ reportedAt: null, wifi: [{ _id: "w1", name: "Shop floor", state: "waiting", detail: null }] });
    open();
    expect(screen.getByText(s.notReported)).toBeTruthy();
    cleanup();
    cx.results["fleet:network"] = net({ groupId: null, reportedAt: null });
    open();
    expect(screen.getByText(s.noGroup)).toBeTruthy();
    expect(screen.queryByRole("region", { name: s.wifi })).toBeNull();
  });

  it("an unknown code gets the generic sentence of its kind, the known ones their own; drivers reuse the install words", () => {
    expect(networkDetailText("wifi", "future_code", "failed")).toBe(s.failedGeneric.wifi);
    expect(networkDetailText("printers", "future_code", "failed")).toBe(s.failedGeneric.printers);
    expect(networkDetailText("drivers", "future_code", "failed")).toBe(s.failedGeneric.drivers);
    expect(networkDetailText("drivers", "unsigned_driver", "failed")).toBe(installStrings.details.unsigned_driver);
    expect(networkDetailText("printers", "driver_missing", "failed")).toBe(s.printerDetails.driver_missing);
    expect(networkDetailText("wifi", null, "working")).toBeNull();
    for (const sentence of [...Object.values(s.wifiDetails), ...Object.values(s.printerDetails), ...Object.values(s.driverDetails)]) {
      expect(sentence.endsWith("."), sentence).toBe(true);
      expect(sentence).not.toMatch(/_/);
    }
  });

  it("a failing query is a visible error, not a blank tab", () => {
    cx.results["fleet:network"] = new ConvexError({ code: "internal" });
    open();
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
