import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { toAppError } from "../../lib/errors";

// The live seam of the "Add a PC" wizard and of the Wi-Fi form (UI pass): `enrollmentCodes:progress` (subscribed only with an id),
// `enrollmentCodes:create` (returns the row id) and `wifi:createWithPassphrase`. The Convex React hooks are mocked, like live.test.tsx.
const cx = vi.hoisted(() => ({
  auth: { isLoading: false, isAuthenticated: true },
  queryResult: undefined as unknown,
  requests: [] as Record<string, { query: unknown; args: unknown }>[],
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => cx.auth,
  useQueries: (req: Record<string, { query: unknown; args: unknown }>) => {
    cx.requests.push(req);
    return Object.fromEntries(Object.keys(req).map((k) => [k, cx.queryResult]));
  },
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

import { liveApi as live } from "./hooks";
import { liveEnrollmentApi } from "../enrollment/live";

beforeEach(() => {
  cx.auth = { isLoading: false, isAuthenticated: true };
  cx.queryResult = undefined;
  cx.requests = [];
  cx.fns = {};
});

const PROGRESS = {
  label: "Front desk · 28 Nov",
  groupId: "g1",
  groupName: "Tills",
  usesTotal: 3,
  usesLeft: 1,
  expiresAt: 1_900_000_000_000,
  revoked: false,
  joined: 2,
  pcs: [
    { _id: "d2", name: "FRONT-02", enrolledAt: 2000, online: true, kioskPhase: "applied" },
    { _id: "d1", name: "FRONT-01", enrolledAt: 1000, online: false, kioskPhase: "something-new" },
  ],
  download: { version: "0.4.0", url: "https://github.com/x/y/releases/download/v0.4.0/Rulebox-0.4.0-x64.msi", sizeBytes: 31_000_000 },
};

describe("enrollmentCodes:progress", () => {
  it("null subscribes to nothing: no request, state loading", () => {
    const { result } = renderHook(() => liveEnrollmentApi.useEnrollmentProgress(null));
    expect(result.current).toEqual({ status: "loading" });
    expect(cx.requests.length).toBeGreaterThan(0);
    for (const req of cx.requests) expect(Object.keys(req)).toEqual([]); // `useQueries({})`: nothing asked
  });

  it("a row id is one query with that id and nothing else (no clock argument)", () => {
    cx.queryResult = PROGRESS;
    renderHook(() => liveEnrollmentApi.useEnrollmentProgress("tok1"));
    const asked = Object.values(cx.requests.at(-1)!);
    expect(asked).toHaveLength(1);
    expect(getFunctionName(asked[0]!.query as FunctionReference<"query">)).toBe("enrollmentCodes:progress");
    expect(asked[0]!.args).toEqual({ tokenId: "tok1" });
  });

  it("loading while Convex has no answer; the answer is mapped, an unknown kiosk phase shows as unknown", () => {
    const loading = renderHook(() => liveEnrollmentApi.useEnrollmentProgress("tok1"));
    expect(loading.result.current).toEqual({ status: "loading" });

    cx.queryResult = PROGRESS;
    const { result } = renderHook(() => liveEnrollmentApi.useEnrollmentProgress("tok1"));
    expect(result.current.status).toBe("ready");
    if (result.current.status !== "ready") return;
    expect(result.current.data).toMatchObject({ label: "Front desk · 28 Nov", groupName: "Tills", usesTotal: 3, usesLeft: 1, joined: 2, revoked: false, download: PROGRESS.download });
    expect(result.current.data.pcs).toEqual([
      { _id: "d2", name: "FRONT-02", enrolledAt: 2000, online: true, kioskPhase: "applied" },
      { _id: "d1", name: "FRONT-01", enrolledAt: 1000, online: false, kioskPhase: "unknown" },
    ]);
  });

  it("optional fields stay absent, and no download is null", () => {
    cx.queryResult = { usesTotal: 1, usesLeft: 1, expiresAt: 5, revoked: false, joined: 0, pcs: [{ _id: "d", name: "N", enrolledAt: 1, online: false }], download: null };
    const { result } = renderHook(() => liveEnrollmentApi.useEnrollmentProgress("tok1"));
    if (result.current.status !== "ready") throw new Error("not ready");
    expect(Object.keys(result.current.data).sort()).toEqual(["download", "expiresAt", "joined", "pcs", "revoked", "usesLeft", "usesTotal"]);
    expect(result.current.data.pcs[0]).toEqual({ _id: "d", name: "N", enrolledAt: 1, online: false });
    expect(result.current.data.download).toBeNull();
  });

  it("an error stays an error with its code (not_found for another organization's id)", () => {
    cx.queryResult = new ConvexError({ code: "not_found" });
    const { result } = renderHook(() => liveEnrollmentApi.useEnrollmentProgress("tok1"));
    expect(result.current.status).toBe("error");
    if (result.current.status === "error") expect(toAppError(result.current.error)).toMatchObject({ code: "not_found" });
  });
});

describe("enrollmentCodes:create", () => {
  it("answers the code once together with the row id", async () => {
    cx.fns["enrollmentCodes:create"] = vi.fn(async () => ({ code: "RBX1.abc", expiresAt: 5, tokenId: "tok1" }));
    const create = renderHook(() => liveEnrollmentApi.useCreateEnrollmentCode()).result.current;
    await expect(create({ groupId: "g1", uses: 1, ttlMinutes: 1440, label: "Front desk · 28 Nov" })).resolves.toEqual({ code: "RBX1.abc", expiresAt: 5, tokenId: "tok1" });
    expect(cx.fns["enrollmentCodes:create"]).toHaveBeenCalledWith({ groupId: "g1", uses: 1, ttlMinutes: 1440, label: "Front desk · 28 Nov" });
  });
});

describe("wifi:createWithPassphrase", () => {
  const input = { name: "Shop", ssid: "Acme", hidden: false, security: "wpa2Personal" as const, autoConnect: true, groupIds: ["g1"], passphrase: "correct horse" };

  it("goes to the action with the fields and the password, nothing else; it never calls saveWifi or setPassphrase", async () => {
    cx.fns["wifi:createWithPassphrase"] = vi.fn(async () => ({ id: "w1", revision: 2 }));
    cx.fns["networks:saveWifi"] = vi.fn(async () => ({ id: "x", revision: 1 }));
    cx.fns["wifi:setPassphrase"] = vi.fn(async () => ({ revision: 3 }));
    const create = renderHook(() => live.useCreateWifiWithPassphrase()).result.current;
    // A caller that spreads a full `WifiInput` (id, expectedRevision) must not send them: the server refuses unknown arguments.
    const sloppy = { ...input, id: "stray", expectedRevision: 4 } as typeof input;
    expect(await create(sloppy)).toEqual({ id: "w1", revision: 2 });
    expect(cx.fns["wifi:createWithPassphrase"]).toHaveBeenCalledWith(input);
    expect(cx.fns["networks:saveWifi"]).not.toHaveBeenCalled();
    expect(cx.fns["wifi:setPassphrase"]).not.toHaveBeenCalled();
  });

  it("errors keep their code, field and detail, and never carry the password", async () => {
    cx.fns["wifi:createWithPassphrase"] = vi.fn(async () => {
      throw new ConvexError({ code: "invalid_argument", field: "passphrase", detail: "length" });
    });
    const create = renderHook(() => live.useCreateWifiWithPassphrase()).result.current;
    let error: unknown;
    try {
      await create(input);
    } catch (e) {
      error = e;
    }
    expect(toAppError(error)).toMatchObject({ code: "invalid_argument", field: "passphrase", detail: "length" });
    expect(JSON.stringify(error)).not.toContain(input.passphrase);
    expect(String(error)).not.toContain(input.passphrase);

    cx.fns["wifi:createWithPassphrase"] = vi.fn(async () => {
      throw new ConvexError({ code: "not_ready", detail: "sealing_key" });
    });
    let notReady: unknown;
    try {
      await renderHook(() => live.useCreateWifiWithPassphrase()).result.current(input);
    } catch (e) {
      notReady = e;
    }
    expect(toAppError(notReady)).toMatchObject({ code: "not_ready", detail: "sealing_key" });
  });
});
