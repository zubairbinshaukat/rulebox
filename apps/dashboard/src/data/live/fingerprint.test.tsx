import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { errorCodeOf } from "../../lib/errors";

// `useFingerprintInstaller` maps to the `apps:fingerprintInstaller` action and `useAppByWinget` to the `apps:byWinget` query (UI pass
// add-app.md section 8). The Convex React hooks are mocked, as in `inspect.test.tsx`.
const cx = vi.hoisted(() => ({
  queryResult: undefined as unknown,
  requests: [] as Record<string, { query: unknown; args: unknown }>[],
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: unknown; args: unknown }>) => {
    cx.requests.push(req);
    return Object.fromEntries(Object.keys(req).map((k) => [k, cx.queryResult]));
  },
  useQuery: () => undefined,
  useAction: (ref: FunctionReference<"action">) => fnFor(getFunctionName(ref)),
  useMutation: (ref: FunctionReference<"mutation">) => fnFor(getFunctionName(ref)),
  useConvexConnectionState: () => ({ isWebSocketConnected: true }),
}));
vi.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signIn: vi.fn(), signOut: vi.fn() }) }));
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

beforeEach(() => {
  cx.queryResult = undefined;
  cx.requests = [];
  cx.fns = {};
});

describe("live useFingerprintInstaller", () => {
  const URL1 = "https://dl.example.com/a.exe";

  it("calls apps:fingerprintInstaller with the address and returns its answer", async () => {
    const answer = {
      sha256: "ab".repeat(32),
      sizeBytes: 1234,
      inspection: { tech: "nsis", kind: "exe", confidence: "high", silentArgs: ["/S"], successExitCodes: [0], needsAnswerFile: false, perUserLikely: false },
    };
    cx.fns["apps:fingerprintInstaller"] = vi.fn(async () => answer);
    expect(await renderHook(() => live.useFingerprintInstaller()).result.current({ url: URL1 })).toEqual(answer);
    expect(cx.fns["apps:fingerprintInstaller"]).toHaveBeenCalledWith({ url: URL1 });
  });

  it("a refusal keeps its code and detail (too large, blocked, failed, not an installer, rate limited)", async () => {
    for (const detail of ["fingerprint_too_large", "fingerprint_blocked", "fingerprint_failed", "fingerprint_not_installer"]) {
      cx.fns["apps:fingerprintInstaller"] = vi.fn(async () => {
        throw new ConvexError({ code: "invalid_argument", field: "url", detail });
      });
      const err = (await renderHook(() => live.useFingerprintInstaller()).result.current({ url: URL1 }).catch((e: unknown) => e)) as { code: string; field?: string; detail?: string };
      expect(errorCodeOf(err), detail).toBe("invalid_argument");
      expect({ field: err.field, detail: err.detail }, detail).toEqual({ field: "url", detail });
    }
    cx.fns["apps:fingerprintInstaller"] = vi.fn(async () => {
      throw new ConvexError({ code: "rate_limited", retryAfterMs: 60_000 });
    });
    const limited = await renderHook(() => live.useFingerprintInstaller()).result.current({ url: URL1 }).catch((e: unknown) => e);
    expect(errorCodeOf(limited)).toBe("rate_limited");
  });
});

describe("live useAppByWinget", () => {
  it("subscribes to apps:byWinget with the package id and returns the app or null", () => {
    cx.queryResult = { _id: "a1", name: "VLC", archived: false };
    const { result } = renderHook(() => live.useAppByWinget("VideoLAN.VLC"));
    expect(result.current).toEqual({ status: "ready", data: { _id: "a1", name: "VLC", archived: false } });
    const request = cx.requests.at(-1)!["q"]!;
    expect(getFunctionName(request.query as FunctionReference<"query">)).toBe("apps:byWinget");
    expect(request.args).toEqual({ packageId: "VideoLAN.VLC" });
    cx.queryResult = null;
    expect(renderHook(() => live.useAppByWinget("7zip.7zip")).result.current).toEqual({ status: "ready", data: null });
  });

  it("keeps the plus of an id as it is (the id is an argument, never part of a URL)", () => {
    cx.queryResult = null;
    renderHook(() => live.useAppByWinget("Notepad++.Notepad++"));
    expect(cx.requests.at(-1)!["q"]!.args).toEqual({ packageId: "Notepad++.Notepad++" });
  });

  it('"skip" subscribes to nothing and stays loading', () => {
    cx.queryResult = null;
    const { result } = renderHook(() => live.useAppByWinget("skip"));
    expect(result.current).toEqual({ status: "loading" });
    expect(cx.requests.at(-1)).toEqual({});
  });
});
