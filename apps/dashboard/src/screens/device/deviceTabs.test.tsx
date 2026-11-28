import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { Me } from "../../data/types";
import { MeContext } from "../../lib/member";
import { deviceText as t } from "./strings";
import { problemStrings } from "./problemStrings";

// The device page shell against the LIVE data seam with the Convex hooks mocked: the tab bar, the `?tab=` address, the badges and the
// promise that a tab that is not open subscribes to nothing (docs/plans/ui-pass/device-detail.md section 3).
const cx = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  pages: {} as Record<string, unknown[]>,
  queried: [] as { name: string; args: unknown }[],
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: unknown }>) =>
    Object.fromEntries(
      Object.entries(req).map(([k, r]) => {
        const name = getFunctionName(r.query);
        cx.queried.push({ name, args: r.args });
        if (cx.results[name] !== undefined) return [k, cx.results[name]];
        if ((r.args as { paginationOpts?: unknown } | undefined)?.paginationOpts) {
          const rows = (cx.pages[name] ??= []);
          return [k, { page: rows, isDone: true, continueCursor: `c:${rows.length}` }];
        }
        return [k, undefined];
      }),
    ),
  useQuery: () => undefined,
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

import { ToastProvider } from "../../app/Toasts";
import DeviceDetail from "../DeviceDetail";

const admin: Me = {
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

function open(path = "/devices/d1", role: Me["role"] = "admin") {
  return render(
    <ToastProvider>
      <MeContext.Provider value={{ ...admin, role }}>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/devices/:id" element={<DeviceDetail />} />
          </Routes>
        </MemoryRouter>
      </MeContext.Provider>
    </ToastProvider>,
  );
}

const page = (over: Record<string, unknown> = {}) => ({
  _id: "d1",
  name: "Front desk",
  revision: 7,
  kioskEnabled: true,
  enrolledAt: Date.now() - 5 * 3_600_000,
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

const names = () => [...new Set(cx.queried.map((q) => q.name))].sort();
const tabs = () => screen.getAllByRole("tab").map((x) => x.textContent ?? "");
const where = () => screen.getByTestId("where").textContent;

beforeEach(() => {
  cx.results = {};
  cx.pages = {};
  cx.queried = [];
  cx.fns = { "fleet:watch": async () => ({ fastUntil: null }) };
  localStorage.clear();
  sessionStorage.clear();
  cx.results["fleet:page"] = page();
  cx.results["fleet:liveness"] = { lastContactAt: Date.now() - 20_000, online: true, fastUntil: null };
});
afterEach(cleanup);

describe("DeviceDetail tabs", () => {
  it("opens on Overview with six tabs, and the default tab leaves the address clean", () => {
    open();
    expect(tabs().map((x) => x.replace(/\d+$/, ""))).toEqual(["Overview", "Apps", "Protection", "Network", "Activity", "Settings"]);
    expect(screen.getByRole("tab", { name: /Overview/ }).getAttribute("aria-selected")).toBe("true");
    expect(where()).toBe("/devices/d1");
  });

  it("round-trips ?tab= (replacing history), and an unknown tab is the Overview", async () => {
    open();
    fireEvent.click(screen.getByRole("tab", { name: /Activity/ }));
    expect(where()).toBe("/devices/d1?tab=activity");
    expect(await screen.findByRole("heading", { name: t.versionsTitle })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Overview/ }));
    expect(where()).toBe("/devices/d1");
    cleanup();

    open("/devices/d1?tab=apps");
    expect(screen.getByRole("tab", { name: /Apps/ }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByRole("heading", { name: t.appsTitle })).toBeTruthy();
    cleanup();

    open("/devices/d1?tab=bogus");
    expect(screen.getByRole("tab", { name: /Overview/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("a disconnected PC has three tabs, and a tab it does not have falls back to the Overview", () => {
    cx.results["fleet:page"] = page({ revoked: true, presence: { online: false, since: 5, revoked: true }, flags: { noGroup: false, revoked: true, rotateCredential: false } });
    open("/devices/d1?tab=apps");
    expect(tabs().map((x) => x.replace(/\d+$/, ""))).toEqual(["Overview", "Activity", "Settings"]);
    expect(screen.getByRole("tab", { name: /Overview/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText(problemStrings.revoked.title)).toBeTruthy();
    // No tiles, no header actions for a disconnected PC.
    expect(screen.queryByRole("list", { name: t.tilesLabel })).toBeNull();
    expect(screen.queryByRole("button", { name: t.sendMessage })).toBeNull();
  });

  it("a tab that is not open subscribes to nothing: the Overview reads fleet:page and fleet:liveness only", async () => {
    open();
    expect(names()).toEqual(["fleet:liveness", "fleet:page"]);

    cx.queried = [];
    fireEvent.click(screen.getByRole("tab", { name: /Apps/ }));
    await screen.findByRole("heading", { name: t.appsTitle });
    expect(names()).toEqual(["fleet:installs", "fleet:liveness", "fleet:page"]);

    cx.results["fleet:network"] = { groupId: "g1", reportedAt: null, wifi: [], printers: [], drivers: [] };
    cx.queried = [];
    fireEvent.click(screen.getByRole("tab", { name: /Network/ }));
    await screen.findByText("No Wi-Fi networks for this group.");
    expect(names()).toEqual(["fleet:liveness", "fleet:network", "fleet:page"]);

    cx.queried = [];
    fireEvent.click(screen.getByRole("tab", { name: /Settings/ }));
    await screen.findByText("Danger zone");
    expect(names()).toEqual(["fleet:deviceSettings", "fleet:liveness", "fleet:page"]);
  });

  it("Activity reads the history, and the settings versions only after the disclosure opens", async () => {
    cx.results["fleet:versions"] = [{ version: 3, createdAt: Date.now() - 3_600_000, reason: "Group settings changed" }];
    open("/devices/d1?tab=activity");
    await screen.findByRole("heading", { name: t.versionsTitle });
    expect(names()).toEqual(["audit:forTarget", "fleet:liveness", "fleet:page"]);
    expect(cx.queried.some((q) => q.name === "audit:forTarget" && (q.args as { targetId: string }).targetId === "d1")).toBe(true);

    const details = screen.getByText(t.versionsShow).closest("details") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(await screen.findByText("Group settings changed")).toBeTruthy();
    expect(names()).toContain("fleet:versions");
    // The version this PC runs is marked.
    expect(screen.getByText(t.versionAppliedNow)).toBeTruthy();
  });

  it("badges: problems on Overview (danger when one is), failed apps, failed Wi-Fi and printers", () => {
    cx.results["fleet:page"] = page({
      kioskEnabled: false,
      failedInstalls: { count: 2, more: false, names: ["Zoom", "7-Zip"] },
      network: { wifiFailed: 1, printersFailed: 1 },
    });
    open();
    // kiosk off (warning) + failed installs (warning) + network (warning) = 3, no danger
    const overview = screen.getByRole("tab", { name: /Overview/ });
    expect(within(overview).getByText("3").getAttribute("data-tone")).toBe("warning");
    expect(within(screen.getByRole("tab", { name: /Apps/ })).getByText("2")).toBeTruthy();
    expect(within(screen.getByRole("tab", { name: /Network/ })).getByText("2")).toBeTruthy();
    expect(within(screen.getByRole("tab", { name: /Protection/ })).queryByText(/\d/)).toBeNull();
    cleanup();

    cx.results["fleet:page"] = page({ lock: { lockId: "l1", message: "Locked", lockedAt: 1 } });
    open();
    expect(within(screen.getByRole("tab", { name: /Overview/ })).getByText("1").getAttribute("data-tone")).toBe("danger");
  });

  it("a problem's button opens the tab it points at", async () => {
    cx.results["fleet:page"] = page({ failedInstalls: { count: 1, more: false, names: ["Zoom"] } });
    cx.pages["fleet:installs"] = [{ _id: "i1", appId: "a1", appName: "Zoom", state: "failed", attempts: 2, updatedAt: Date.now() }];
    open();
    fireEvent.click(screen.getByRole("button", { name: problemStrings.failedInstalls.action }));
    expect(where()).toBe("/devices/d1?tab=apps");
    expect(await screen.findByRole("link", { name: "Zoom" })).toBeTruthy();
  });
});
