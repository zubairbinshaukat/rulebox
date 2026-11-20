import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { errorCodeOf, messageFor, registerDetailSentences } from "../../lib/errors";
import { installRefusalStrings } from "../../lib/screenStrings/installRefusals";

// `useInspectInstaller` maps to the `apps:inspectInstaller` action and carries its refusals through (Phase 6 Step 13).
const cx = vi.hoisted(() => ({ fns: {} as Record<string, (args?: unknown) => Promise<unknown>> }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: () => ({}),
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

describe("live useInspectInstaller", () => {
  it("calls apps:inspectInstaller with the address and returns its answer", async () => {
    const answer = { tech: "nsis", kind: "exe", confidence: "high", silentArgs: ["/S"], successExitCodes: [0], needsAnswerFile: false, perUserLikely: false };
    cx.fns["apps:inspectInstaller"] = vi.fn(async () => answer);
    expect(await renderHook(() => live.useInspectInstaller()).result.current({ url: "https://dl.example.com/a.exe" })).toEqual(answer);
    expect(cx.fns["apps:inspectInstaller"]).toHaveBeenCalledWith({ url: "https://dl.example.com/a.exe" });
  });

  it("a refusal keeps its code, field and detail, and the detail has its own sentence once the screen registered them", async () => {
    registerDetailSentences(installRefusalStrings);
    cx.fns["apps:inspectInstaller"] = vi.fn(async () => {
      throw new ConvexError({ code: "invalid_argument", field: "url", detail: "inspect_unsupported" });
    });
    const err = await renderHook(() => live.useInspectInstaller()).result.current({ url: "https://dl.example.com/a.exe" }).catch((e: unknown) => e);
    expect(errorCodeOf(err)).toBe("invalid_argument");
    expect(messageFor(err)).toBe(installRefusalStrings.inspect_unsupported);
  });
});
