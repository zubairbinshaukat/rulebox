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
    });
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

describe("device list (paginated)", () => {
  it("is skipped until the session is confirmed", () => {
    cx.auth = { isLoading: true, isAuthenticated: false };
    renderHook(() => liveDevicesApi.useDevicesScreen({}));
    expect(cx.paged.at(-1)).toEqual({ name: "fleet:list", args: "skip" });
  });

  it("sends only the arguments that are set; the search is fleet:list's own", () => {
    renderHook(() => liveDevicesApi.useDevicesScreen({}));
    expect(cx.paged.at(-1)!.args).toEqual({});
    renderHook(() => liveDevicesApi.useDevicesScreen({ groupId: "g1", search: "front" }));
    expect(cx.paged.at(-1)).toEqual({ name: "fleet:list", args: { groupId: "g1", search: "front" } });
  });

  it("maps the rows, offers Load more while pages remain", () => {
    cx.pageResults = [serverRow];
    cx.pageStatus = "CanLoadMore";
    const { result } = renderHook(() => liveDevicesApi.useDevicesScreen({}));
    if (result.current.status !== "ready") throw new Error("expected ready");
    expect(result.current.items[0]).toMatchObject({ _id: "d1", presence: { online: false, since: 500 }, latestVersion: 4 });
    expect(result.current.canLoadMore).toBe(true);
  });

  it("the first page is loading", () => {
    cx.pageStatus = "LoadingFirstPage";
    const { result } = renderHook(() => liveDevicesApi.useDevicesScreen({}));
    expect(result.current.status).toBe("loading");
  });

  it("install results are fleet:installs of that PC, paginated; skipped until the session is confirmed", () => {
    cx.pageResults = [{ _id: "i1", appId: "a1", appName: "Docs", state: "failed", attempts: 3, updatedAt: 5 }];
    cx.pageStatus = "Exhausted";
    const { result } = renderHook(() => liveDevicesApi.useDeviceInstalls("d1"));
    expect(cx.paged.at(-1)).toEqual({ name: "fleet:installs", args: { deviceId: "d1" } });
    expect(result.current).toMatchObject({ status: "ready", items: [{ _id: "i1", appName: "Docs", state: "failed" }], canLoadMore: false });
    cx.auth = { isLoading: true, isAuthenticated: false };
    renderHook(() => liveDevicesApi.useDeviceInstalls("d1"));
    expect(cx.paged.at(-1)).toEqual({ name: "fleet:installs", args: "skip" });
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
