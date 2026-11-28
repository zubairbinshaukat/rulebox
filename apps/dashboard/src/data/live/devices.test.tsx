import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { errorCodeOf } from "../../lib/errors";
import { setStepUpHandler } from "../../lib/stepUpRetry";

// Step 7 hooks against the mocked Convex React hooks: which function and
// arguments each hook uses, how the rows are shaped, and the step-up retry
// of the major actions. The backend itself is covered by convex/fleet.test.ts.
const cx = vi.hoisted(() => ({
  auth: { isLoading: false, isAuthenticated: true },
  queryResult: undefined as unknown,
  requests: [] as Record<string, { args: unknown }>[],
  paged: [] as { name: string; args: unknown }[],
  pageResults: [] as unknown[],
  pageStatus: "Exhausted" as string,
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => cx.auth,
  useQueries: (req: Record<string, { args: unknown }>) => {
    cx.requests.push(req);
    return Object.fromEntries(Object.keys(req).map((k) => [k, cx.queryResult]));
  },
  useQuery: () => undefined,
  usePaginatedQuery: (ref: FunctionReference<"query">, args: unknown) => {
    cx.paged.push({ name: getFunctionName(ref), args });
    return { results: cx.pageResults, status: cx.pageStatus, isLoading: false, loadMore: () => undefined };
  },
  useAction: () => async () => undefined,
  useMutation: (ref: FunctionReference<"mutation">) => fnFor(getFunctionName(ref)),
  useConvexConnectionState: () => ({ isWebSocketConnected: true }),
}));

vi.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signIn: vi.fn(), signOut: vi.fn() }) }));

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

import { liveApi as live } from "./hooks";
import { liveDevicesApi } from "../devices/live";
import { compatOf, deviceDetailOf, deviceRowOf, kioskPhaseOf, shellHealthOf } from "./devices";

/** The server's ids are branded; fixtures use plain strings. */
const asRow = (r: unknown) => r as Parameters<typeof deviceRowOf>[0];
const asDetail = (r: unknown) => r as Parameters<typeof deviceDetailOf>[0];

const serverRow = {
  _id: "d1",
  name: "Front desk",
  groupId: "g1",
  groupName: "Sales",
  kioskEnabled: true,
  enrolledAt: 10,
  revision: 2,
  presence: { online: false, since: 500, revoked: false },
  summary: { agentVersion: "0.4.0", windowsBuild: "26100", kioskPhase: "applied", outOfSupport: true, appliedVersion: 3, updatedAt: 9 },
  latestVersion: 4,
  planState: "overLimit",
};

beforeEach(() => {
  cx.auth = { isLoading: false, isAuthenticated: true };
  cx.queryResult = undefined;
  cx.requests = [];
  cx.paged = [];
  cx.pageResults = [];
  cx.pageStatus = "Exhausted";
  cx.fns = {};
});

describe("row mapping", () => {
  it("a list row keeps the presence transition and the summary columns", () => {
    expect(deviceRowOf(asRow(serverRow))).toEqual({
      _id: "d1",
      name: "Front desk",
      groupId: "g1",
      groupName: "Sales",
      revoked: false,
      kioskEnabled: true,
      enrolledAt: 10,
      presence: { online: false, since: 500 },
      report: { agentVersion: "0.4.0", osBuild: "26100", kioskPhase: "applied", appliedVersion: 3, outOfSupport: true },
      latestVersion: 4,
      planState: "overLimit",
    });
  });

  it("the plan state is kept for the badge; a row without one (an older server, no head yet) reads as null", () => {
    expect(deviceRowOf(asRow({ ...serverRow, planState: "suspended" })).planState).toBe("suspended");
    expect(deviceRowOf(asRow({ ...serverRow, planState: null })).planState).toBeNull();
    const old = Object.fromEntries(Object.entries(serverRow).filter(([key]) => key !== "planState"));
    expect(deviceRowOf(asRow(old)).planState).toBeNull();
  });

  it("no summary yet: report null; no head yet: no latest version; revoked comes from the presence row", () => {
    const row = deviceRowOf(asRow({ ...serverRow, summary: null, latestVersion: null, presence: { online: false, since: null, revoked: true } }));
    expect(row.report).toBeNull();
    expect(row.latestVersion).toBeUndefined();
    expect(row.revoked).toBe(true);
    expect(row.presence).toEqual({ online: false, since: null });
  });

  it("free-text phases the screen does not know read as unknown", () => {
    expect(kioskPhaseOf("applied")).toBe("applied");
    expect(kioskPhaseOf("rebooting")).toBe("unknown");
    expect(kioskPhaseOf(undefined)).toBeUndefined();
    expect(shellHealthOf("healthy")).toBe("healthy");
    expect(shellHealthOf("???")).toBe("unknown");
  });

  it("a compatibility report is used whole or not at all", () => {
    const ok = { os: { build: 26100 }, blockers: [], warnings: ["w"], liteMode: true };
    expect(compatOf(ok)).toMatchObject({ warnings: ["w"], liteMode: true });
    expect(compatOf({ os: {}, blockers: [] })).toBeUndefined();
    expect(compatOf("text")).toBeUndefined();
    expect(compatOf(null)).toBeUndefined();
  });

  it("the Phase 6 compatibility fields are kept when well formed and left out when not", () => {
    const base = { os: { build: 26100 }, blockers: [], warnings: [], liteMode: false };
    const good = {
      ...base,
      webview2: { present: true, version: "131.0.1", source: "machine" },
      protection: "reduced",
      layers: { appLocker: false, appControl: true },
      browsers: { edge: true, chrome: false },
      protectedPrint: false,
      lowRam: true,
    };
    expect(compatOf(good)).toMatchObject(good);
    const bad = compatOf({ ...base, webview2: "x", protection: "half", layers: { appLocker: 1 }, browsers: null });
    expect(bad).toBeDefined();
    for (const key of ["webview2", "protection", "layers", "browsers"]) expect(key in bad!).toBe(false);
    // An older agent sends none of them.
    expect(compatOf(base)?.protection).toBeUndefined();
  });

  it("the detail takes out-of-support from the summary and revoked from the flags", () => {
    const detail = deviceDetailOf(asDetail({
      _id: "d1",
      name: "Front desk",
      revision: 5,
      kioskEnabled: false,
      enrolledAt: 10,
      group: null,
      state: "revoked",
      presence: { online: false, since: 7, revoked: true },
      summary: serverRow.summary,
      report: { agentVersion: "0.4.0", kioskPhase: "weird", shellHealth: "healthy", compat: "nope", updatedAt: 8 },
      versions: [],
      flags: { noGroup: true, revoked: true, rotateCredential: false },
      groups: [{ _id: "g1", name: "Sales" }],
    }));
    expect(detail.revoked).toBe(true);
    expect(detail.presence).toEqual({ online: false, since: 7 });
    expect(detail.report).toMatchObject({ kioskPhase: "unknown", shellHealth: "healthy", compat: undefined, outOfSupport: true, updatedAt: 8 });
    expect(detail.groups).toEqual([{ _id: "g1", name: "Sales" }]);
  });
});

describe("queries", () => {
  it("useDeviceDetail subscribes to fleet:get with the id and maps the result", () => {
    cx.queryResult = {
      _id: "d1",
      name: "Front desk",
      revision: 5,
      kioskEnabled: true,
      enrolledAt: 10,
      group: null,
      state: "active",
      presence: { online: true, since: 7, revoked: false },
      summary: null,
      report: null,
      versions: [],
      flags: { noGroup: true, revoked: false, rotateCredential: true },
      groups: [],
    };
    const { result } = renderHook(() => live.useDeviceDetail("d1"));
    expect(cx.requests.at(-1)!.q!.args).toEqual({ deviceId: "d1" });
    expect(result.current.status === "ready" && result.current.data.flags.rotateCredential).toBe(true);
  });

  it("useDevicePage subscribes to fleet:page and maps it; fields an older server lacks read as their defaults", () => {
    cx.queryResult = {
      _id: "d1",
      name: "Front desk",
      revision: 5,
      kioskEnabled: true,
      enrolledAt: 10,
      revoked: false,
      group: { _id: "g1", name: "Sales" },
      presence: { online: true, since: 7, revoked: false },
      outOfSupport: true,
      report: { agentVersion: "0.4.1", kioskPhase: "weird", shellHealth: "healthy", compat: "nope", updatedAt: 8 },
      flags: { noGroup: false, revoked: false, rotateCredential: false },
      failedInstalls: { count: 2, more: true, names: ["Zoom", "Teams"] },
      network: { wifiFailed: 1, printersFailed: 0 },
      latestVersion: 4,
      planState: "overLimit",
    };
    const { result } = renderHook(() => live.useDevicePage("d1"));
    expect(getFunctionName((cx.requests.at(-1)!.q as unknown as { query: FunctionReference<"query"> }).query)).toBe("fleet:page");
    expect(cx.requests.at(-1)!.q!.args).toEqual({ deviceId: "d1" });
    if (result.current.status !== "ready") throw new Error("expected ready");
    const page = result.current.data;
    expect(page).toMatchObject({
      revoked: false,
      outOfSupport: true,
      latestVersion: 4,
      planState: "overLimit",
      failedInstalls: { count: 2, more: true, names: ["Zoom", "Teams"] },
      network: { wifiFailed: 1, printersFailed: 0 },
    });
    expect(page.report).toMatchObject({ kioskPhase: "unknown", shellHealth: "healthy", compat: undefined, outOfSupport: true, updatedAt: 8 });
    // The lockdown, lock and display fields the (older) server did not send.
    expect(page).toMatchObject({ lock: null, ring: "everyone", usbAllowUntil: null, protection: null, lockdownCapable: null, apply: null, displayMode: "auto", groupDisplayMode: "auto" });
    expect("groups" in page || "versions" in page || "rolloutRevision" in page).toBe(false);
  });

  it("the device page's tab queries pass the PC id; the versions disclosure subscribes to nothing while closed", () => {
    const name = () => getFunctionName((cx.requests.at(-1)!.q as unknown as { query: FunctionReference<"query"> }).query);
    cx.queryResult = { groups: [{ _id: "g1", name: "Sales" }], rolloutRevision: 3 };
    const settings = renderHook(() => liveDevicesApi.useDeviceSettingsOptions("d1")).result;
    expect(name()).toBe("fleet:deviceSettings");
    expect(cx.requests.at(-1)!.q!.args).toEqual({ deviceId: "d1" });
    expect(settings.current).toEqual({ status: "ready", data: cx.queryResult });

    cx.queryResult = { groupId: "g1", reportedAt: null, wifi: [], printers: [], drivers: [] };
    renderHook(() => liveDevicesApi.useDeviceNetwork("d1"));
    expect(name()).toBe("fleet:network");
    expect(cx.requests.at(-1)!.q!.args).toEqual({ deviceId: "d1" });

    cx.requests = [];
    cx.queryResult = [{ version: 4, createdAt: 1, reason: "settings changed" }];
    const closed = renderHook(() => liveDevicesApi.useDeviceVersions("d1", false)).result;
    expect(cx.requests.flatMap((r) => Object.keys(r))).toEqual([]);
    expect(closed.current.status).toBe("loading");
    const open = renderHook(() => liveDevicesApi.useDeviceVersions("d1", true)).result;
    expect(name()).toBe("fleet:versions");
    expect(cx.requests.at(-1)!.q!.args).toEqual({ deviceId: "d1" });
    expect(open.current).toEqual({ status: "ready", data: cx.queryResult });
  });

  it("useDeviceLiveness and useCheckResult pass the liveness row / result through", () => {
    cx.queryResult = { lastContactAt: 60_000, online: true, fastUntil: null };
    const live1 = renderHook(() => live.useDeviceLiveness("d1")).result;
    expect(live1.current).toEqual({ status: "ready", data: cx.queryResult });
    cx.queryResult = { requestedAt: 1, items: [{ deviceId: "d1", answered: true }] };
    const check = renderHook(() => live.useCheckResult("c1")).result;
    expect(cx.requests.at(-1)!.q!.args).toEqual({ checkId: "c1" });
    expect(check.current.status).toBe("ready");
  });

  it("a PC the server refuses reads as an error with its code, not a throw", () => {
    cx.queryResult = new ConvexError({ code: "not_found" });
    const { result } = renderHook(() => live.useDeviceDetail("gone"));
    expect(result.current.status === "error" && errorCodeOf(result.current.error)).toBe("not_found");
  });
});

describe("device list (one page per subscription)", () => {
  const page = (rows: unknown[], over: Record<string, unknown> = {}) => ({ page: rows, isDone: true, continueCursor: "c1", ...over });
  const lastArgs = () => cx.requests.at(-1)!.q!.args as Record<string, unknown>;
  const lastName = () => getFunctionName((cx.requests.at(-1)!.q as unknown as { query: FunctionReference<"query"> }).query);
  const Q = { numItems: 10, cursor: null as string | null };

  it("is skipped until the session is confirmed", () => {
    cx.auth = { isLoading: true, isAuthenticated: false };
    renderHook(() => liveDevicesApi.useDevicesScreen(Q));
    expect(cx.requests.flatMap((r) => Object.keys(r))).toEqual([]);
  });

  it("sends the page size, cursor, sort and group as arguments of fleet:list; a plain query, not usePaginatedQuery", () => {
    cx.queryResult = page([]);
    renderHook(() => liveDevicesApi.useDevicesScreen({ ...Q, sort: { key: "created", dir: "desc" } }));
    expect(lastName()).toBe("fleet:list");
    expect(lastArgs()).toEqual({ paginationOpts: { numItems: 10, cursor: null }, sort: { key: "created", dir: "desc" } });
    renderHook(() => liveDevicesApi.useDevicesScreen({ numItems: 25, cursor: "cur-7", groupId: "g1", sort: { key: "name", dir: "asc" } }));
    expect(lastArgs()).toEqual({ paginationOpts: { numItems: 25, cursor: "cur-7" }, groupId: "g1", sort: { key: "name", dir: "asc" } });
    // The server's own paginated hook is never used (it would accumulate pages).
    expect(cx.paged).toEqual([]);
  });

  it("a search is fleet:list's own argument and the server ignores the sort for it, so none is sent", () => {
    cx.queryResult = page([]);
    renderHook(() => liveDevicesApi.useDevicesScreen({ ...Q, search: " front ", sort: { key: "name", dir: "asc" } }));
    expect(lastArgs()).toEqual({ paginationOpts: { numItems: 10, cursor: null }, search: "front" });
  });

  it("the total is fleet:count, a query of its own, with the same group and search", () => {
    cx.queryResult = { total: 524 };
    const none = renderHook(() => liveDevicesApi.useDevicesCount({}));
    expect(lastName()).toBe("fleet:count");
    expect(lastArgs()).toEqual({});
    expect(none.result.current).toBe(524);
    cx.queryResult = { total: null };
    const some = renderHook(() => liveDevicesApi.useDevicesCount({ groupId: "g1", search: "x" }));
    expect(lastArgs()).toEqual({ groupId: "g1", search: "x" });
    expect(some.result.current).toBeNull();
    cx.queryResult = undefined;
    expect(renderHook(() => liveDevicesApi.useDevicesCount({})).result.current).toBeUndefined();
  });

  it("maps the rows and hands the cursor to the pager; isDone says whether Next exists", () => {
    cx.queryResult = page([serverRow], { isDone: false, continueCursor: "next-cursor" });
    const { result } = renderHook(() => liveDevicesApi.useDevicesScreen(Q));
    if (result.current.status !== "ready") throw new Error("expected ready");
    expect(result.current.items[0]).toMatchObject({ _id: "d1", presence: { online: false, since: 500 }, latestVersion: 4 });
    expect(result.current).toMatchObject({ isDone: false, continueCursor: "next-cursor", total: null });
  });

  it("the first page is loading", () => {
    cx.queryResult = undefined;
    const { result } = renderHook(() => liveDevicesApi.useDevicesScreen(Q));
    expect(result.current.status).toBe("loading");
  });

  it("install results are fleet:installs of that PC, sorted by updated only; skipped until the session is confirmed", () => {
    cx.queryResult = page([{ _id: "i1", appId: "a1", appName: "Docs", state: "failed", attempts: 3, updatedAt: 5 }]);
    const { result } = renderHook(() => liveDevicesApi.useDeviceInstalls("d1", { ...Q, sort: { key: "updated", dir: "asc" } }));
    expect(lastName()).toBe("fleet:installs");
    expect(lastArgs()).toEqual({ deviceId: "d1", paginationOpts: { numItems: 10, cursor: null }, sort: { key: "updated", dir: "asc" } });
    expect(result.current).toMatchObject({ status: "ready", items: [{ _id: "i1", appName: "Docs", state: "failed" }], isDone: true });
    cx.auth = { isLoading: true, isAuthenticated: false };
    cx.requests = [];
    renderHook(() => liveDevicesApi.useDeviceInstalls("d1", Q));
    expect(cx.requests.flatMap((r) => Object.keys(r))).toEqual([]);
  });
});

describe("writes", () => {
  it("rename, move and kiosk send the revision; stale_edit maps", async () => {
    const rename = vi.fn().mockResolvedValue({ revision: 6 });
    const move = vi.fn().mockRejectedValue(new ConvexError({ code: "stale_edit" }));
    const kiosk = vi.fn().mockResolvedValue({ revision: 6 });
    cx.fns["fleet:rename"] = rename;
    cx.fns["fleet:move"] = move;
    cx.fns["fleet:setKiosk"] = kiosk;
    await renderHook(() => live.useRenameDevice()).result.current({ deviceId: "d1", expectedRevision: 5, name: "Desk" });
    expect(rename).toHaveBeenCalledWith({ deviceId: "d1", expectedRevision: 5, name: "Desk" });
    await expect(renderHook(() => live.useMoveDevice()).result.current({ deviceId: "d1", expectedRevision: 5, groupId: "g2" })).rejects.toSatisfy(
      (e) => errorCodeOf(e) === "stale_edit",
    );
    await renderHook(() => live.useSetKiosk()).result.current({ deviceId: "d1", expectedRevision: 5, enabled: true });
    expect(kiosk).toHaveBeenCalledWith({ deviceId: "d1", expectedRevision: 5, enabled: true });
  });

  it("turning the kiosk off asks for a fresh step-up once, then retries", async () => {
    const kiosk = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "step_up_required" }))
      .mockResolvedValueOnce({ revision: 6 });
    cx.fns["fleet:setKiosk"] = kiosk;
    const handler = vi.fn(async () => true);
    const off = setStepUpHandler(handler);
    await renderHook(() => live.useSetKiosk()).result.current({ deviceId: "d1", expectedRevision: 5, enabled: false });
    expect(handler).toHaveBeenCalledOnce();
    expect(kiosk).toHaveBeenCalledTimes(2);
    off();
  });

  it("a cancelled step-up leaves the original error; revoke and remove map their codes", async () => {
    cx.fns["fleet:revoke"] = vi.fn().mockRejectedValue(new ConvexError({ code: "step_up_required" }));
    cx.fns["fleet:remove"] = vi.fn().mockRejectedValue(new ConvexError({ code: "conflict", detail: "revoke the device first" }));
    const off = setStepUpHandler(async () => false);
    const e = await renderHook(() => live.useRevokeDevice()).result.current({ deviceId: "d1" }).catch((x: unknown) => x);
    expect(errorCodeOf(e)).toBe("step_up_required");
    const c = await renderHook(() => live.useRemoveDevice()).result.current({ deviceId: "d1" }).catch((x: unknown) => x);
    expect(errorCodeOf(c)).toBe("conflict");
    off();
  });

  it("rotation, watch and check now call their functions and return what the server answers", async () => {
    cx.fns["fleet:requestCredentialRotation"] = vi.fn().mockResolvedValue(null);
    cx.fns["fleet:watch"] = vi.fn().mockResolvedValue({ fastUntil: 300_000 });
    cx.fns["fleet:checkNow"] = vi.fn().mockResolvedValue({ checkId: "c1" });
    await renderHook(() => live.useRequestRotation()).result.current({ deviceId: "d1" });
    expect(cx.fns["fleet:requestCredentialRotation"]).toHaveBeenCalledWith({ deviceId: "d1" });
    await expect(renderHook(() => live.useWatchDevice()).result.current({ deviceId: "d1" })).resolves.toEqual({ fastUntil: 300_000 });
    await expect(renderHook(() => live.useCheckNow()).result.current({ deviceIds: ["d1", "d2"] })).resolves.toEqual({ checkId: "c1" });
    expect(cx.fns["fleet:checkNow"]).toHaveBeenCalledWith({ deviceIds: ["d1", "d2"] });
  });
});
