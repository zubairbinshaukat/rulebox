import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { AppError, errorCodeOf, messageFor } from "../../lib/errors";
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
    const { result } = renderHook(() => live.useMfaStatus());
    expect(result.current.status).toBe("loading");
    expect(cx.requests.at(-1)).toEqual({});
  });

  it("keep one subscription across renders (api.x.y is a new Proxy on every access)", () => {
    const { rerender } = renderHook(() => live.useMfaStatus());
    rerender();
    rerender();
    expect(cx.requests.length).toBeGreaterThanOrEqual(3);
    expect(new Set(cx.requests).size).toBe(1);
  });

  it("loading, then ready", () => {
    const { result, rerender } = renderHook(() => live.useMfaStatus());
    expect(result.current.status).toBe("loading");
    expect(Object.keys(cx.requests.at(-1)!)).toEqual(["q"]);
    cx.queryResult = { enrolled: true, required: true, verified: false, lockedUntil: null, recoveryCodesLeft: 10 };
    rerender();
    expect(result.current).toEqual({ status: "ready", data: cx.queryResult });
  });

  it("an error becomes status error with a mapped code; retry re-subscribes", async () => {
    cx.queryResult = new ConvexError({ code: "forbidden" });
    const { result } = renderHook(() => live.useMembersScreen());
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
    const { rerender } = renderHook(() => live.useMfaStatus());
    rerender();
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });
});

describe("MFA actions", () => {
  it("beginSetup returns the secret and URI from the action", async () => {
    cx.fns["mfa:beginSetup"] = vi.fn(async () => ({ secret: "ABCD", uri: "otpauth://totp/x" }));
    const { result } = renderHook(() => live.useBeginMfaSetup());
    await expect(result.current()).resolves.toEqual({ secret: "ABCD", uri: "otpauth://totp/x" });
  });

  it("confirmSetup returns the recovery codes", async () => {
    cx.fns["mfa:confirmSetup"] = vi.fn(async () => ["AAAA-BBBB"]);
    const { result } = renderHook(() => live.useConfirmMfaSetup());
    await expect(result.current({ code: "123456" })).resolves.toEqual(["AAAA-BBBB"]);
  });

  it("verify: a wrong code and the lockout map to their codes", async () => {
    cx.fns["mfa:verify"] = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "mfa_invalid_code" }))
      .mockRejectedValueOnce(new ConvexError({ code: "mfa_locked", retryAfterMs: 900_000 }));
    const { result } = renderHook(() => live.useVerifyMfa());
    expect(messageFor(await rejection(result.current({ code: "000000" })))).toBe(strings.errors.mfaInvalidCode);
    const locked = await rejection(result.current({ code: "000000" }));
    expect(errorCodeOf(locked)).toBe("mfa_locked");
    expect(messageFor(locked)).toBe(strings.errors.mfaLockedFor(900_000));
  });

  it("an unauthenticated action reports the expired session", async () => {
    const seen = vi.fn();
    const off = onUnauthenticated(seen);
    cx.fns["mfa:useRecoveryCode"] = vi.fn(async () => {
      throw new ConvexError({ code: "unauthenticated" });
    });
    const { result } = renderHook(() => live.useRedeemRecoveryCode());
    expect(errorCodeOf(await rejection(result.current({ code: "AAAA-BBBB" })))).toBe("unauthenticated");
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

describe("hooks without a backend step yet", () => {
  it("still answer not_ready in live builds", () => {
    const { result } = renderHook(() => live.useOverview(0));
    expect(result.current.status).toBe("error");
    if (result.current.status === "error") expect(errorCodeOf(result.current.error)).toBe("not_ready");
  });
});
