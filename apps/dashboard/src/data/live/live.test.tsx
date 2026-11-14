import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { AppError, errorCodeOf, messageFor, toAppError } from "../../lib/errors";
import { onUnauthenticated } from "../../lib/session";
import { signInMessage } from "../../lib/signin";
import { strings } from "../../lib/strings";

// The Convex React hooks are mocked: these tests cover the mapping from
// Convex (useQueries / useAction / useMutation / Convex Auth) to the
// dashboard's data seam, not the backend (convex/*.test.ts covers that).
const cx = vi.hoisted(() => ({
  auth: { isLoading: false, isAuthenticated: true },
  queryResult: undefined as unknown,
  requests: [] as Record<string, unknown>[],
  me: undefined as unknown,
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
  connected: true,
  signIn: vi.fn(),
  signOut: vi.fn(async () => undefined),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => cx.auth,
  useQueries: (req: Record<string, unknown>) => {
    cx.requests.push(req);
    return Object.fromEntries(Object.keys(req).map((k) => [k, cx.queryResult]));
  },
  useQuery: () => cx.me,
  useAction: (ref: FunctionReference<"action">) => fnFor(getFunctionName(ref)),
  useMutation: (ref: FunctionReference<"mutation">) => fnFor(getFunctionName(ref)),
  useConvexConnectionState: () => ({ isWebSocketConnected: cx.connected }),
}));

vi.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signIn: cx.signIn, signOut: cx.signOut }),
}));

/** One stable function per Convex function name (like the real hooks). */
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
    call.withOptimisticUpdate = () => call; // the optimistic part is the real client's job
    f = call;
    stable.set(name, f);
  }
  return f;
}

import { liveApi as live } from "./hooks";
import { liveStepUpApi } from "../stepup/live";

const SERVER_TEXT = "[CONVEX A(x)] Server Error Uncaught Error: Invalid credentials at handler (auth.ts:34)";

beforeEach(() => {
  cx.auth = { isLoading: false, isAuthenticated: true };
  cx.queryResult = undefined;
  cx.requests = [];
  cx.me = undefined;
  cx.fns = {};
  cx.connected = true;
  cx.signIn.mockReset();
  cx.signOut.mockClear();
});

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("session hooks", () => {
  it("useAuthState is Convex's confirmed auth state", () => {
    cx.auth = { isLoading: true, isAuthenticated: false };
    const { result } = renderHook(() => live.useAuthState());
    expect(result.current).toEqual({ isLoading: true, isAuthenticated: false });
  });

  it("useMe passes account:me through (undefined while loading, null signed out)", () => {
    const { result, rerender } = renderHook(() => live.useMe());
    expect(result.current).toBeUndefined();
    cx.me = null;
    rerender();
    expect(result.current).toBeNull();
  });

  it("useConnectionState follows the real WebSocket state", () => {
    cx.connected = false;
    const { result } = renderHook(() => live.useConnectionState());
    expect(result.current.isWebSocketConnected).toBe(false);
  });
});

describe("sign-in, join, reset", () => {
  it("signs in through the password provider with flow signIn", async () => {
    cx.signIn.mockResolvedValue({ signingIn: true });
    const { result } = renderHook(() => live.useAuthActions());
    await result.current.signIn({ email: "a@b.test", password: "pw" });
    expect(cx.signIn).toHaveBeenCalledWith("password", { flow: "signIn", email: "a@b.test", password: "pw" });
  });

  it("a wrong password (no code) reads 'Email or password is not right', never the server text", async () => {
    cx.signIn.mockRejectedValue(new Error(SERVER_TEXT));
    const { result } = renderHook(() => live.useAuthActions());
    const e = await rejection(result.current.signIn({ email: "a@b.test", password: "x" }));
    expect(errorCodeOf(e)).toBeNull();
    expect(signInMessage(e)).toBe(strings.auth.wrongCredentials);
    expect(messageFor(e)).toBe(strings.errors.unknown);
  });

  it("rate limit maps to rate_limited and its sentence", async () => {
    cx.signIn.mockRejectedValue(new ConvexError({ code: "rate_limited", retryAfterMs: 120_000 }));
    const { result } = renderHook(() => live.useAuthActions());
    const e = await rejection(result.current.signIn({ email: "a@b.test", password: "x" }));
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).retryAfterMs).toBe(120_000);
    expect(signInMessage(e)).toBe(strings.errors.rateLimited);
  });

  it("a sign-in that does not complete is a failure", async () => {
    cx.signIn.mockResolvedValue({ signingIn: false });
    const { result } = renderHook(() => live.useAuthActions());
    const e = await rejection(result.current.signIn({ email: "a@b.test", password: "x" }));
    expect(signInMessage(e)).toBe(strings.auth.wrongCredentials);
  });

  it("join uses flow signUp with the invite code; invite_invalid and the password rule map to sentences", async () => {
    cx.signIn.mockRejectedValueOnce(new ConvexError({ code: "invite_invalid" }));
    const { result } = renderHook(() => live.useAuthActions());
    const e1 = await rejection(result.current.signUp({ inviteCode: "C0DE", email: "a@b.test", password: "pw" }));
    expect(cx.signIn).toHaveBeenCalledWith("password", { flow: "signUp", inviteCode: "C0DE", email: "a@b.test", password: "pw" });
    expect(messageFor(e1)).toBe(strings.errors.inviteInvalid);

    cx.signIn.mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "password" }));
    const e2 = await rejection(result.current.signUp({ inviteCode: "C0DE", email: "a@b.test", password: "short" }));
    expect(messageFor(e2)).toBe(strings.validate.passwordMember);
  });

  it("a disabled account says so", async () => {
    cx.signIn.mockRejectedValue(new ConvexError({ code: "account_disabled" }));
    const { result } = renderHook(() => live.useAuthActions());
    const e = await rejection(result.current.signIn({ email: "a@b.test", password: "x" }));
    expect(signInMessage(e)).toBe(strings.errors.accountDisabled);
  });

  it("reset calls account:redeemReset and maps a failed action", async () => {
    const redeem = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new ConvexError({ code: "invite_invalid" }));
    cx.fns["account:redeemReset"] = redeem;
    const { result } = renderHook(() => live.useRedeemReset());
    await expect(result.current({ email: "a@b.test", code: "C", newPassword: "longpassword12" })).resolves.toBeUndefined();
    expect(redeem).toHaveBeenCalledWith({ email: "a@b.test", code: "C", newPassword: "longpassword12" });
    const e = await rejection(result.current({ email: "a@b.test", code: "C", newPassword: "longpassword12" }));
    expect(errorCodeOf(e)).toBe("invite_invalid");
  });

  it("signOut is Convex Auth's", async () => {
    const { result } = renderHook(() => live.useAuthActions());
    await result.current.signOut();
    expect(cx.signOut).toHaveBeenCalledOnce();
  });
});

describe("member queries (useQueries, no throw during render)", () => {
  it("are skipped until the session is confirmed", () => {
    cx.auth = { isLoading: false, isAuthenticated: false };
    const { result } = renderHook(() => live.useOverview());
    expect(result.current.status).toBe("loading");
    expect(cx.requests.at(-1)).toEqual({});
  });

  it("keep one subscription across renders (api.x.y is a new Proxy on every access)", () => {
    const { rerender } = renderHook(() => live.useOverview());
    rerender();
    rerender();
    expect(cx.requests.length).toBeGreaterThanOrEqual(3);
    expect(new Set(cx.requests).size).toBe(1);
  });

  it("loading, then ready", () => {
    const { result, rerender } = renderHook(() => live.useOverview());
    expect(result.current.status).toBe("loading");
    expect(Object.keys(cx.requests.at(-1)!)).toEqual(["q"]);
    cx.queryResult = { enrolled: true, required: true, verified: false, lockedUntil: null, recoveryCodesLeft: 10 };
    rerender();
    expect(result.current).toEqual({ status: "ready", data: cx.queryResult });
  });

  it("an error becomes status error with a mapped code; retry re-subscribes", async () => {
    cx.queryResult = new ConvexError({ code: "forbidden" });
    const { result } = renderHook(() => live.useOverview());
    expect(result.current.status).toBe("error");
    if (result.current.status !== "error") return;
    expect(errorCodeOf(result.current.error)).toBe("forbidden");
    const before = cx.requests.length;
    act(() => {
      if (result.current.status === "error") result.current.retry();
    });
    // One render without the subscription, then it is back.
    expect(cx.requests.slice(before).some((r) => Object.keys(r).length === 0)).toBe(true);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(Object.keys(cx.requests.at(-1)!)).toEqual(["q"]);
  });

  it("an unauthenticated query reports the expired session (once)", () => {
    const seen = vi.fn();
    const off = onUnauthenticated(seen);
    cx.queryResult = new ConvexError({ code: "unauthenticated" });
    const { rerender } = renderHook(() => live.useOverview());
    rerender();
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });
});

describe("PIN calls", () => {
  it("requestPinReset takes no arguments (it is bound to the signed-in session)", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    cx.fns["account:requestPinReset"] = request;
    const { result } = renderHook(() => liveStepUpApi.useRequestPinReset());
    await expect(result.current()).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith({});
  });

  it("redeemPinReset sends the token and the new PIN; every token problem is step_up_invalid", async () => {
    const redeem = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new ConvexError({ code: "step_up_invalid" }));
    cx.fns["account:redeemPinReset"] = redeem;
    const { result } = renderHook(() => liveStepUpApi.useRedeemPinReset());
    await expect(result.current({ token: "t0k", newPin: "482915" })).resolves.toBeUndefined();
    expect(redeem).toHaveBeenCalledWith({ token: "t0k", newPin: "482915" });
    expect(errorCodeOf(await rejection(result.current({ token: "old", newPin: "482915" })))).toBe("step_up_invalid");
  });

  it("changePassword sends both passwords; a wrong current one is invalid_argument on currentPassword", async () => {
    const change = vi.fn().mockRejectedValue(new ConvexError({ code: "invalid_argument", field: "currentPassword" }));
    cx.fns["account:changePassword"] = change;
    const { result } = renderHook(() => liveStepUpApi.useChangePassword());
    const e = await rejection(result.current({ currentPassword: "wrong-one-1", newPassword: "a-new-password-2" }));
    expect(change).toHaveBeenCalledWith({ currentPassword: "wrong-one-1", newPassword: "a-new-password-2" });
    expect(toAppError(e)).toMatchObject({ code: "invalid_argument", field: "currentPassword" });
  });

  it("resetWithRecoveryCode sends the new PIN with the code", async () => {
    const reset = vi.fn(async () => null);
    cx.fns["stepUp:resetWithRecoveryCode"] = reset;
    const { result } = renderHook(() => liveStepUpApi.useResetStepUpWithRecoveryCode());
    await result.current({ code: "ABCD-EFGH", newPin: "482915" });
    expect(reset).toHaveBeenCalledWith({ code: "ABCD-EFGH", newPin: "482915" });
  });

  it("generateRecoveryCodes returns the codes the action returns", async () => {
    cx.fns["stepUp:generateRecoveryCodes"] = vi.fn(async () => ["AAAA-BBBB", "CCCC-DDDD"]);
    const { result } = renderHook(() => liveStepUpApi.useGenerateRecoveryCodes());
    await expect(result.current()).resolves.toEqual(["AAAA-BBBB", "CCCC-DDDD"]);
  });

  it("a locked PIN says how long and what else works", async () => {
    cx.fns["stepUp:verifyActionPin"] = vi.fn().mockRejectedValue(new ConvexError({ code: "step_up_locked", retryAfterMs: 86_400_000, detail: "lockout" }));
    const { result } = renderHook(() => liveStepUpApi.useVerifyActionPin());
    const e = await rejection(result.current({ pin: "000000" }));
    expect(messageFor(e)).toBe(strings.errors.stepUpLockout(86_400_000));
  });

  it("an unauthenticated action reports the expired session", async () => {
    const seen = vi.fn();
    const off = onUnauthenticated(seen);
    cx.fns["account:requestPinReset"] = vi.fn(async () => {
      throw new ConvexError({ code: "unauthenticated" });
    });
    const { result } = renderHook(() => liveStepUpApi.useRequestPinReset());
    expect(errorCodeOf(await rejection(result.current()))).toBe("unauthenticated");
    expect(seen).toHaveBeenCalledOnce();
    off();
  });
});

describe("members", () => {
  it("changeRole and setDisabled send expectedRevision; stale_edit maps", async () => {
    const change = vi.fn().mockRejectedValue(new ConvexError({ code: "stale_edit" }));
    const disable = vi.fn().mockResolvedValue(null);
    cx.fns["members:changeRole"] = change;
    cx.fns["members:setDisabled"] = disable;
    const role = renderHook(() => live.useChangeRole()).result;
    const dis = renderHook(() => live.useSetMemberDisabled()).result;
    const e = await rejection(role.current({ memberId: "m1", role: "viewer", expectedRevision: 3 }));
    expect(change).toHaveBeenCalledWith({ memberId: "m1", role: "viewer", expectedRevision: 3 });
    expect(errorCodeOf(e)).toBe("stale_edit");
    await dis.current({ memberId: "m1", disabled: true, expectedRevision: 4 });
    expect(disable).toHaveBeenCalledWith({ memberId: "m1", disabled: true, expectedRevision: 4 });
  });

  it("invite and reset code return { code, expiresAt } once", async () => {
    cx.fns["members:invite"] = vi.fn(async () => ({ code: "X".repeat(26), expiresAt: 5 }));
    cx.fns["members:createResetCode"] = vi.fn(async () => ({ code: "Y".repeat(26), expiresAt: 6 }));
    const inv = renderHook(() => live.useInviteMember()).result;
    const rc = renderHook(() => live.useCreateResetCode()).result;
    await expect(inv.current({ email: "n@b.test", role: "admin" })).resolves.toEqual({ code: "X".repeat(26), expiresAt: 5 });
    await expect(rc.current({ memberId: "m1" })).resolves.toEqual({ code: "Y".repeat(26), expiresAt: 6 });
  });

  it("an unknown error code is not trusted: the generic sentence", async () => {
    cx.fns["members:revokeInvite"] = vi.fn(async () => {
      throw new ConvexError({ code: "token_invalid", message: "secret detail" });
    });
    const { result } = renderHook(() => live.useRevokeInvite());
    const e = await rejection(result.current({ inviteId: "i1" }));
    expect(errorCodeOf(e)).toBeNull();
    expect(messageFor(e)).toBe(strings.errors.unknown);
  });
});

describe("step-up (data/stepup/live.ts)", () => {
  it("status subscribes to stepUp:status; verify / keepAlive / lock map their errors", async () => {
    const { result } = renderHook(() => liveStepUpApi.useStepUpStatus());
    expect(result.current.status).toBe("loading");
    expect(getFunctionName((cx.requests.at(-1)!.q as { query: FunctionReference<"query"> }).query)).toBe("stepUp:status");

    cx.fns["stepUp:verifyActionPin"] = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "step_up_locked", retryAfterMs: 60_000 }))
      .mockResolvedValueOnce({ verifiedAt: 1, freshUntil: 2, serverNow: 3 });
    const verify = renderHook(() => liveStepUpApi.useVerifyActionPin()).result;
    const e = await rejection(verify.current({ pin: "000000" }));
    expect(messageFor(e)).toBe(strings.errors.stepUpLocked(60_000));
    await expect(verify.current({ pin: "482915" })).resolves.toEqual({ verifiedAt: 1, freshUntil: 2, serverNow: 3 });

    cx.fns["stepUp:keepAlive"] = vi.fn(async () => ({ serverNow: 9 }));
    cx.fns["stepUp:lock"] = vi.fn(async () => null);
    await expect(renderHook(() => liveStepUpApi.useKeepAlive()).result.current()).resolves.toEqual({ serverNow: 9 });
    await expect(renderHook(() => liveStepUpApi.useLockSession()).result.current()).resolves.toBeUndefined();
    expect(cx.fns["stepUp:lock"]).toHaveBeenCalledWith({});
  });

  it("passkey begin calls take no arguments; finish passes the credential JSON", async () => {
    cx.fns["passkeys:beginVerification"] = vi.fn(async () => ({ optionsJson: "{}", expiresAt: 1 }));
    cx.fns["passkeys:finishRegistration"] = vi.fn(async () => ({ passkeyId: "pk" }));
    await renderHook(() => liveStepUpApi.useBeginPasskeyVerification()).result.current();
    expect(cx.fns["passkeys:beginVerification"]).toHaveBeenCalledWith({});
    await renderHook(() => liveStepUpApi.useFinishPasskeyRegistration()).result.current({ responseJson: "{}", name: "PC" });
    expect(cx.fns["passkeys:finishRegistration"]).toHaveBeenCalledWith({ responseJson: "{}", name: "PC" });
  });
});

describe("apps, assignments and file types (Step 10)", () => {
  it("a new app asks the server for nothing; an existing one is apps:get (the install counts are a query of their own)", () => {
    const fresh = renderHook(() => live.useAppDetail("new"));
    expect(fresh.result.current).toMatchObject({ status: "ready", data: { _id: "new", kind: "web", assignments: [] } });
    expect(cx.requests.flatMap((r) => Object.values(r))).toEqual([]);

    cx.queryResult = { _id: "a1", name: "Docs", kind: "web", archived: false, revision: 2, createdAt: 1, assignments: [], fileTypes: [], directEmployeeCount: 0, groupOptions: [] };
    const { result } = renderHook(() => live.useAppDetail("a1"));
    const req = Object.values(cx.requests.at(-1)!)[0] as { args: unknown };
    expect(req.args).toEqual({ appId: "a1" });
    expect(result.current).toMatchObject({ status: "ready", data: { _id: "a1", revision: 2 } });
  });

  it("writes go to their functions with the dashboard's arguments and errors keep their code", async () => {
    cx.fns["apps:createWeb"] = vi.fn(async () => "a9");
    const create = renderHook(() => live.useCreateWebApp()).result.current;
    const input = { name: "Docs", url: "https://docs.example.com", allowedDomains: [] };
    expect(await create(input)).toBe("a9");
    expect(cx.fns["apps:createWeb"]).toHaveBeenCalledWith(input);

    cx.fns["apps:update"] = vi.fn(async () => ({ revision: 3 }));
    await renderHook(() => live.useUpdateApp()).result.current({ appId: "a1", expectedRevision: 2, web: input });
    expect(cx.fns["apps:update"]).toHaveBeenCalledWith({ appId: "a1", expectedRevision: 2, web: input });

    // Phase 5 Step 11: permissions are saved on their own; the answer carries the revision to send next.
    const permissions = { camera: false, microphone: true, screenShare: false, clipboardRead: false, notifications: true, downloads: true, printing: true, geolocation: false };
    cx.fns["apps:setPermissions"] = vi.fn(async () => ({ revision: 3 }));
    expect(await renderHook(() => live.useSetAppPermissions()).result.current({ appId: "a1", expectedRevision: 2, permissions })).toEqual({ revision: 3 });
    expect(cx.fns["apps:setPermissions"]).toHaveBeenCalledWith({ appId: "a1", expectedRevision: 2, permissions });

    cx.fns["groups:assignApp"] = vi.fn(async () => ({ assignmentId: "as" }));
    await renderHook(() => live.useAssignApp()).result.current({ groupId: "g1", appId: "a1", audience: "selected", pinnedTaskbar: true, pinnedDesktop: false });
    expect(cx.fns["groups:assignApp"]).toHaveBeenCalledWith({ groupId: "g1", appId: "a1", audience: "selected", pinnedTaskbar: true, pinnedDesktop: false });

    cx.fns["fileHandlers:set"] = vi.fn(async () => {
      throw new ConvexError({ code: "invalid_argument", field: "extension", detail: "denied" });
    });
    const err = await renderHook(() => live.useSetFileHandler()).result.current({ extension: ".exe", appId: "a1" }).catch((e: unknown) => e);
    expect(errorCodeOf(err)).toBe("invalid_argument");
    expect((err as AppError).field).toBe("extension");

    cx.fns["apps:resolveWinget"] = vi.fn(async () => {
      throw new ConvexError({ code: "winget_unsupported", detail: "no silent install" });
    });
    const winget = await renderHook(() => live.useResolveWinget()).result.current({ packageId: "A.B" }).catch((e: unknown) => e);
    expect(messageFor(winget)).toBe(strings.errors.wingetUnsupportedBecause("no silent install"));
  });

  it("groups:get assignments carry the assignment id the edit and unassign calls need", () => {
    cx.queryResult = {
      group: { _id: "g1", name: "Office", revision: 0, createdAt: 1, isDefault: false, devices: { count: 0, more: false }, employees: { count: 0, more: false } },
      apps: [{ assignmentId: "as1", appId: "a1", name: "Notepad", kind: "desktop", hue: 40, archived: false, audience: "everyone", pinnedTaskbar: true, pinnedDesktop: false }],
    };
    const { result } = renderHook(() => live.useGroupDetail("g1"));
    expect(result.current).toMatchObject({
      status: "ready",
      data: { assignments: [{ _id: "as1", appId: "a1", appName: "Notepad", hue: 40, audience: "everyone", pinnedTaskbar: true, pinnedDesktop: false }] },
    });
  });
});

describe("install status, overview, audit and history (Step 17)", () => {
  const lastRequest = () => Object.values(cx.requests.at(-1)!)[0] as { query: FunctionReference<"query">; args: unknown };

  it("the overview is overview:get with no arguments, passed through as it is", () => {
    cx.queryResult = {
      counts: { deviceCount: 3, employeeCount: 1, appCount: 2, groupCount: 1, noGroupDeviceCount: 1, outOfSupportCount: 0, failedInstallCount: 4 },
      onlineCount: 2,
      plan: { name: "free", status: "active", limits: {} },
      signing: "active",
      publishFailedAt: null,
      recentAudit: [],
    };
    const { result } = renderHook(() => live.useOverview());
    expect(getFunctionName(lastRequest().query)).toBe("overview:get");
    expect(lastRequest().args).toEqual({});
    expect(result.current).toEqual({ status: "ready", data: cx.queryResult });
  });

  it("the failed-installs page subscribes only while it is enabled; disabled it answers an empty page", () => {
    cx.requests = [];
    const query = { numItems: 10, cursor: null, sort: { key: "updated", dir: "desc" as const } };
    const off = renderHook(() => live.useFailedInstallsPage({ ...query, enabled: false }));
    expect(off.result.current).toMatchObject({ status: "ready", items: [], isDone: true });
    expect(cx.requests.flatMap((r) => Object.values(r))).toEqual([]);
    cx.queryResult = { page: [{ _id: "i1", deviceId: "d1", deviceName: "PC", appId: "a1", appName: "Docs", updatedAt: 1 }], isDone: false, continueCursor: "cur1" };
    const on = renderHook(() => live.useFailedInstallsPage({ ...query, enabled: true }));
    expect(getFunctionName(lastRequest().query)).toBe("overview:failedInstallsPage");
    // One page: the cursor and the page size go to the server; "updated" is the only sort key.
    expect(lastRequest().args).toEqual({ paginationOpts: { numItems: 10, cursor: null }, sort: { key: "updated", dir: "desc" } });
    expect(on.result.current).toMatchObject({ status: "ready", items: [{ _id: "i1" }], isDone: false, continueCursor: "cur1" });
  });

  it("the groups table is groups:page: sort, search and the page cursor are arguments; the exact total comes back in the page", () => {
    cx.queryResult = {
      page: [{ _id: "g1", name: "Front", revision: 0, createdAt: 5, isDefault: false, devices: { count: 3, more: false }, employees: { count: 600, more: true } }],
      isDone: true,
      continueCursor: "o:10",
      total: 1,
    };
    const { result } = renderHook(() => live.useGroupsPage({ numItems: 10, cursor: "o:10", sort: { key: "created", dir: "desc" }, search: " fr " }));
    expect(getFunctionName(lastRequest().query)).toBe("groups:page");
    expect(lastRequest().args).toEqual({ paginationOpts: { numItems: 10, cursor: "o:10" }, sort: { key: "created", dir: "desc" }, search: "fr" });
    expect(result.current).toMatchObject({ status: "ready", total: 1, items: [{ _id: "g1", deviceCount: 3, employeeCount: 501 }] });
  });

  it("the install summary is apps:installSummary; only the states that have PCs come back", () => {
    cx.queryResult = { pending: 0, downloading: 0, installing: 0, installed: 12, failed: 1001, removing: 0, removed: 0, unsupported: 2 };
    const { result } = renderHook(() => live.useAppInstallSummary("a1"));
    expect(getFunctionName(lastRequest().query)).toBe("apps:installSummary");
    expect(lastRequest().args).toEqual({ appId: "a1" });
    expect(result.current).toEqual({ status: "ready", data: { installed: 12, failed: 1001, unsupported: 2 } });
  });

  it("the install summary carries capped only when the server says so", () => {
    cx.queryResult = { pending: 0, downloading: 0, installing: 0, installed: 1001, failed: 0, removing: 0, removed: 0, unsupported: 0, capped: true };
    expect(renderHook(() => live.useAppInstallSummary("a1")).result.current).toEqual({ status: "ready", data: { installed: 1001, capped: true } });
    cx.queryResult = { pending: 0, downloading: 0, installing: 0, installed: 3, failed: 0, removing: 0, removed: 0, unsupported: 0, capped: false };
    expect(renderHook(() => live.useAppInstallSummary("a1")).result.current).toEqual({ status: "ready", data: { installed: 3 } });
  });

  it("the signing screen carries publishFailedAt and rosterPending from keys:status", () => {
    cx.queryResult = {
      keys: [],
      signing: "missing",
      env: { active: null, next: null },
      publishFailedAt: 5,
      rosterPending: true,
    };
    const { result } = renderHook(() => live.useKeysScreen());
    expect(cx.requests.flatMap((r) => Object.values(r)).some((r) => getFunctionName((r as { query: FunctionReference<"query"> }).query) === "keys:status")).toBe(true);
    expect(result.current).toMatchObject({ status: "ready", data: { publishFailedAt: 5, rosterPending: true, envKeyPresent: false } });
  });

  it("Publish again is keys:registerActive without force", async () => {
    const register = vi.fn().mockResolvedValue({ keyId: "k", fingerprint: "f" });
    cx.fns["keys:registerActive"] = register;
    const { result } = renderHook(() => live.usePublishAgain());
    await result.current();
    expect(register).toHaveBeenCalledWith({});
  });
});

describe("hooks that fail for want of a backend", () => {
  it("a refused overview reads as an error with its code", () => {
    cx.queryResult = new ConvexError({ code: "forbidden" });
    const { result } = renderHook(() => live.useOverview());
    expect(result.current.status === "error" && errorCodeOf(result.current.error)).toBe("forbidden");
  });
});
