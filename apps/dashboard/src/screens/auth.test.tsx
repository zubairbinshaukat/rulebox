import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { Me, MembersScreen, MfaStatus, QueryState } from "../data/types";
import { AppError } from "../lib/errors";
import { MeContext } from "../lib/member";
import { reportUnauthenticated } from "../lib/session";
import { strings } from "../lib/strings";

// The data seam is mocked (Convex is mocked one level down in live.test.tsx):
// these tests cover what each screen does in every state of the real flows.
const m = vi.hoisted(() => ({
  auth: { isLoading: false, isAuthenticated: false },
  me: null as unknown,
  signIn: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(async () => undefined),
  redeemReset: vi.fn(),
  mfaStatus: { status: "loading" } as unknown,
  begin: vi.fn(),
  confirm: vi.fn(),
  verify: vi.fn(),
  recovery: vi.fn(),
  members: { status: "loading" } as unknown,
  changeRole: vi.fn(),
  setDisabled: vi.fn(),
  noop: vi.fn(async () => undefined),
}));

vi.mock("../data", () => {
  const actions = { signIn: m.signIn, signUp: m.signUp, signOut: m.signOut };
  return {
    IS_DEMO: false,
    DASHBOARD_API_VERSION: 1,
    useAuthState: () => m.auth,
    useMe: () => m.me,
    useAuthActions: () => actions,
    useRedeemReset: () => m.redeemReset,
    useConnectionState: () => ({ isWebSocketConnected: true }),
    useMfaStatus: () => m.mfaStatus,
    useBeginMfaSetup: () => m.begin,
    useConfirmMfaSetup: () => m.confirm,
    useVerifyMfa: () => m.verify,
    useRedeemRecoveryCode: () => m.recovery,
    useMembersScreen: () => m.members,
    useChangeRole: () => m.changeRole,
    useSetMemberDisabled: () => m.setDisabled,
    useInviteMember: () => m.noop,
    useRevokeInvite: () => m.noop,
    useCreateResetCode: () => m.noop,
    useResetMemberMfa: () => m.noop,
  };
});

import SignIn from "./SignIn";
import Join from "./Join";
import Reset from "./Reset";
import Mfa from "./Mfa";
import { RequireMember } from "../app/RequireMember";
import { SESSION_LOST_GRACE_MS } from "../app/useSessionGuard";
import { MembersTab } from "./settings/MembersTab";
import { ToastProvider } from "../app/Toasts";
import { AppErrorBoundary } from "../app/AppErrorBoundary";

const owner: Me = {
  email: "owner@x.test",
  role: "owner",
  status: "active",
  orgId: "org",
  orgName: "Acme",
  mfa: { enrolled: true, required: true, verified: true },
  serverApiVersion: 1,
};

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname + loc.search}</p>;
}

function at(path: string, routes: ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        {routes}
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

const where = () => screen.getByTestId("where").textContent;
const field = (label: RegExp | string) => screen.getByLabelText(label, { selector: "input" }) as HTMLInputElement;

/** Nothing secret may be written to browser storage by the dashboard (Convex Auth's own keys excepted). */
function storageDump(): string {
  const all: string[] = [];
  for (const s of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)!;
      all.push(`${k}=${s.getItem(k)}`);
    }
  }
  return all.join("\n");
}

beforeEach(() => {
  m.auth = { isLoading: false, isAuthenticated: false };
  m.me = null;
  for (const f of [m.signIn, m.signUp, m.redeemReset, m.begin, m.confirm, m.verify, m.recovery, m.changeRole, m.setDisabled]) f.mockReset();
  m.signOut.mockClear();
  m.mfaStatus = { status: "loading" };
  m.members = { status: "loading" };
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------- sign-in

describe("SignIn", () => {
  const ui = (path = "/sign-in") => at(path, <Route path="/sign-in" element={<SignIn />} />);

  it("uses the right autocomplete hints", () => {
    ui();
    expect(field(strings.auth.email).getAttribute("autocomplete")).toBe("username");
    expect(field(strings.auth.password).getAttribute("autocomplete")).toBe("current-password");
  });

  it("a wrong password and an unknown email get the same sentence", async () => {
    m.signIn.mockRejectedValue(new Error("[CONVEX A(auth:signIn)] Server Error: Invalid credentials"));
    ui();
    fireEvent.change(field(strings.auth.email), { target: { value: "nobody@x.test" } });
    fireEvent.change(field(strings.auth.password), { target: { value: "whatever" } });
    fireEvent.click(screen.getByRole("button", { name: strings.auth.signIn }));
    expect(await screen.findByText(strings.auth.wrongCredentials)).toBeTruthy();
    expect(screen.queryByText(/Invalid credentials|CONVEX/)).toBeNull();
  });

  it("shows the rate-limit sentence", async () => {
    m.signIn.mockRejectedValue(new AppError({ code: "rate_limited", retryAfterMs: 3_600_000 }));
    ui();
    fireEvent.change(field(strings.auth.email), { target: { value: "a@x.test" } });
    fireEvent.change(field(strings.auth.password), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: strings.auth.signIn }));
    expect(await screen.findByText(strings.errors.rateLimited)).toBeTruthy();
  });

  it("disables submit while pending, then goes to next", async () => {
    let finish: () => void = () => undefined;
    m.signIn.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    ui("/sign-in?next=%2Fdevices");
    fireEvent.change(field(strings.auth.email), { target: { value: "a@x.test" } });
    fireEvent.change(field(strings.auth.password), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: strings.auth.signIn }));
    const busy = await screen.findByRole("button", { name: strings.auth.signingIn });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(busy);
    expect(m.signIn).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(where()).toBe("/devices");
  });

  it("explains an expired session and does not bounce while the old token is dead", () => {
    m.auth = { isLoading: false, isAuthenticated: true };
    m.me = null; // the server no longer knows this session
    ui("/sign-in?next=%2Faudit&expired=1");
    expect(screen.getByText(strings.errors.unauthenticated)).toBeTruthy();
    expect(screen.queryByTestId("where")).toBeNull();
  });

  it("a signed-in member goes to next, but never off-site", () => {
    m.auth = { isLoading: false, isAuthenticated: true };
    m.me = owner;
    ui("/sign-in?next=%2F%2Fevil.test");
    expect(where()).toBe("/");
  });
});

// ---------------------------------------------------------------- join / reset

describe("Join", () => {
  const ui = () => at("/join", <Route path="/join" element={<Join />} />);
  const fill = (password: string) => {
    fireEvent.change(field(strings.auth.inviteCode), { target: { value: "CODE" } });
    fireEvent.change(field(strings.auth.email), { target: { value: "new@x.test" } });
    fireEvent.change(field(strings.auth.newPassword), { target: { value: password } });
    fireEvent.change(field(strings.auth.repeatPassword), { target: { value: password } });
    fireEvent.click(screen.getByRole("button", { name: strings.auth.join }));
  };

  it("autocomplete: one-time-code for the invite, new-password twice", () => {
    ui();
    expect(field(strings.auth.inviteCode).getAttribute("autocomplete")).toBe("one-time-code");
    expect(field(strings.auth.newPassword).getAttribute("autocomplete")).toBe("new-password");
    expect(field(strings.auth.repeatPassword).getAttribute("autocomplete")).toBe("new-password");
  });

  it("mirrors the server's password rule before sending (12+, a letter and a digit)", async () => {
    ui();
    fill("onlyletterslong");
    expect(await screen.findByText(strings.validate.passwordMember)).toBeTruthy();
    expect(m.signUp).not.toHaveBeenCalled();
  });

  it("a bad invite shows the invite sentence; a good one goes to /mfa", async () => {
    m.signUp.mockRejectedValueOnce(new AppError({ code: "invite_invalid" })).mockResolvedValueOnce(undefined);
    ui();
    fill("a-long-password-1");
    expect(await screen.findByText(strings.errors.inviteInvalid)).toBeTruthy();
    expect(m.signUp).toHaveBeenCalledWith({ inviteCode: "CODE", email: "new@x.test", password: "a-long-password-1" });
    fireEvent.click(screen.getByRole("button", { name: strings.auth.join }));
    await waitFor(() => expect(where()).toBe("/mfa"));
  });
});

describe("Reset", () => {
  const ui = () => at("/reset", <Route path="/reset" element={<Reset />} />);
  const fill = () => {
    fireEvent.change(field(strings.auth.resetCode), { target: { value: "CODE" } });
    fireEvent.change(field(strings.auth.email), { target: { value: "a@x.test" } });
    fireEvent.change(field(strings.auth.newPassword), { target: { value: "a-long-password-1" } });
    fireEvent.change(field(strings.auth.repeatPassword), { target: { value: "a-long-password-1" } });
    fireEvent.click(screen.getByRole("button", { name: strings.auth.reset }));
  };

  it("a failed action shows its sentence (rate limit), then success says so", async () => {
    m.redeemReset.mockRejectedValueOnce(new AppError({ code: "rate_limited" })).mockResolvedValueOnce(undefined);
    ui();
    fill();
    expect(await screen.findByText(strings.errors.rateLimited)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.auth.reset }));
    expect(await screen.findByText(strings.auth.resetDone)).toBeTruthy();
    expect(m.redeemReset).toHaveBeenLastCalledWith({ email: "a@x.test", code: "CODE", newPassword: "a-long-password-1" });
  });
});

// ---------------------------------------------------------------- MFA

const status = (s: Partial<MfaStatus>): QueryState<MfaStatus> => ({
  status: "ready",
  data: { enrolled: false, required: true, verified: false, lockedUntil: null, recoveryCodesLeft: 0, ...s },
});

describe("Mfa", () => {
  const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  const CODES = ["AAAA-BBBB", "CCCC-DDDD"];
  const ui = (path = "/mfa?next=%2Fdevices", strict = false) => {
    const tree = (
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/mfa" element={<Mfa />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    );
    return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  };

  beforeEach(() => {
    m.auth = { isLoading: false, isAuthenticated: true };
    m.me = { ...owner, mfa: { enrolled: false, required: true, verified: false } };
  });

  it("setup: starts exactly once (StrictMode), shows the key, then the recovery codes; nothing stored", async () => {
    m.mfaStatus = status({ enrolled: false });
    m.begin.mockResolvedValue({ secret: SECRET, uri: `otpauth://totp/Rulebox:owner%40x.test?secret=${SECRET}&issuer=Rulebox` });
    m.confirm.mockResolvedValue(CODES);
    const { unmount } = ui(undefined, true);
    expect(await screen.findByText("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP")).toBeTruthy();
    expect(m.begin).toHaveBeenCalledTimes(1);
    const code = field(strings.mfa.code);
    expect(code.getAttribute("autocomplete")).toBe("one-time-code");
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: strings.mfa.confirm }));
    expect(await screen.findByText(strings.mfa.recoveryTitle)).toBeTruthy();
    expect(m.confirm).toHaveBeenCalledWith({ code: "123456" });
    expect(screen.getByText("AAAA-BBBB")).toBeTruthy();
    const stored = storageDump();
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain("AAAA-BBBB");
    // "I saved them" stays off until the box is ticked.
    expect((screen.getByRole("button", { name: strings.mfa.saved }) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    expect(document.body.textContent).not.toContain("AAAA-BBBB");
  });

  it("setup: a failed start shows Try again and retries", async () => {
    m.mfaStatus = status({ enrolled: false });
    m.begin.mockRejectedValueOnce(new AppError({ code: "mfa_already_enabled" })).mockResolvedValueOnce({ secret: SECRET, uri: "otpauth://totp/x" });
    ui();
    expect(await screen.findByText(strings.errors.mfaAlreadyEnabled)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.common.tryAgain }));
    expect(await screen.findByText(strings.mfa.step2)).toBeTruthy();
    expect(m.begin).toHaveBeenCalledTimes(2);
  });

  it("verify: a wrong code says so; a good one waits for the server, then goes to next", async () => {
    m.mfaStatus = status({ enrolled: true });
    m.verify.mockRejectedValueOnce(new AppError({ code: "mfa_invalid_code" })).mockResolvedValueOnce(undefined);
    const { rerender } = ui();
    const code = field(strings.mfa.code);
    expect(code.getAttribute("autocomplete")).toBe("one-time-code");
    fireEvent.change(code, { target: { value: "000 000" } });
    fireEvent.click(screen.getByRole("button", { name: strings.mfa.verify }));
    expect(await screen.findByText(strings.errors.mfaInvalidCode)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.mfa.verify }));
    // Accepted, but the session is not shown as verified yet: stay, button busy.
    const busy = await screen.findByRole("button", { name: strings.mfa.confirming });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(m.verify).toHaveBeenLastCalledWith({ code: "000000" });
    m.mfaStatus = status({ enrolled: true, verified: true });
    rerender(
      <MemoryRouter initialEntries={["/mfa?next=%2Fdevices"]}>
        <Routes>
          <Route path="/mfa" element={<Mfa />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(where()).toBe("/devices"));
  });

  it("verify: the lockout says how long", async () => {
    m.mfaStatus = status({ enrolled: true });
    m.verify.mockRejectedValue(new AppError({ code: "mfa_locked", retryAfterMs: 900_000 }));
    ui();
    fireEvent.change(field(strings.mfa.code), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: strings.mfa.verify }));
    expect(await screen.findByText(strings.errors.mfaLockedFor(900_000))).toBeTruthy();
  });

  it("recovery code: normalized before sending", async () => {
    m.mfaStatus = status({ enrolled: true, recoveryCodesLeft: 9 });
    m.recovery.mockResolvedValue(undefined);
    ui();
    fireEvent.click(screen.getByRole("button", { name: strings.mfa.useRecovery }));
    const input = field(strings.mfa.recoveryCode);
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    fireEvent.change(input, { target: { value: "aaaa bbbb" } });
    fireEvent.click(screen.getByRole("button", { name: strings.mfa.verify }));
    await waitFor(() => expect(m.recovery).toHaveBeenCalledWith({ code: "AAAA-BBBB" }));
  });

  it("signed out: to sign-in", () => {
    m.auth = { isLoading: false, isAuthenticated: false };
    m.me = null;
    ui();
    expect(where()).toBe("/sign-in?next=%2Fmfa");
  });
});

// ---------------------------------------------------------------- session expiry

describe("session expiry (RequireMember)", () => {
  const ui = (path: string) =>
    at(
      path,
      <Route element={<RequireMember />}>
        <Route path="/devices" element={<p>inside</p>} />
      </Route>,
    );

  it("a token the server no longer accepts ends the session after the grace period", () => {
    vi.useFakeTimers();
    m.auth = { isLoading: false, isAuthenticated: true };
    m.me = null;
    ui("/devices?group=a");
    expect(screen.getByText(strings.app.signingIn)).toBeTruthy();
    act(() => vi.advanceTimersByTime(SESSION_LOST_GRACE_MS + 10));
    expect(where()).toBe("/sign-in?next=%2Fdevices%3Fgroup%3Da&expired=1");
    expect(m.signOut).toHaveBeenCalledOnce();
  });

  it("a query failing with unauthenticated sends the person to sign-in with next", () => {
    m.auth = { isLoading: false, isAuthenticated: true };
    m.me = owner;
    ui("/devices");
    expect(screen.getByText("inside")).toBeTruthy();
    act(() => reportUnauthenticated());
    expect(where()).toBe("/sign-in?next=%2Fdevices&expired=1");
    expect(m.signOut).toHaveBeenCalledOnce();
  });
});

describe("AppErrorBoundary", () => {
  it("never shows an error's own message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Boom(): never {
      throw new Error("[CONVEX Q(account:me)] Server Error: internal detail");
    }
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    expect(screen.getByText(strings.errors.unknown)).toBeTruthy();
    expect(screen.queryByText(/internal detail/)).toBeNull();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------- members (stale edit)

describe("Members: expectedRevision and stale edit", () => {
  const screenData = (revision: number, role: Me["role"] = "admin"): QueryState<MembersScreen> => ({
    status: "ready",
    data: {
      members: [
        { _id: "me", email: "owner@x.test", role: "owner", status: "active", createdAt: 1, mfaEnrolled: true, isYou: true, revision: 0 },
        { _id: "m2", email: "sam@x.test", role, status: "active", createdAt: 2, mfaEnrolled: true, isYou: false, revision },
      ],
      invites: [
        { _id: "i1", email: "open@x.test", role: "viewer", kind: "join", expiresAt: Date.now() + 60_000 },
        { _id: "i2", email: "used@x.test", role: "viewer", kind: "join", expiresAt: Date.now() + 60_000, usedAt: 5 },
        { _id: "i3", email: "old@x.test", role: "viewer", kind: "join", expiresAt: Date.now() - 60_000 },
      ],
    },
  });
  const tree = () => (
    <ToastProvider>
      <MeContext.Provider value={owner}>
        <MembersTab />
      </MeContext.Provider>
    </ToastProvider>
  );

  it("lists only open invites", () => {
    m.members = screenData(1);
    render(tree());
    expect(screen.getByText("open@x.test")).toBeTruthy();
    expect(screen.queryByText("used@x.test")).toBeNull();
    expect(screen.queryByText("old@x.test")).toBeNull();
  });

  it("role change sends the opened revision; stale_edit offers Reload, which takes the current row", async () => {
    m.members = screenData(3);
    m.changeRole.mockRejectedValueOnce(new AppError({ code: "stale_edit" })).mockResolvedValueOnce(undefined);
    const { rerender } = render(tree());
    fireEvent.click(screen.getByRole("button", { name: `${strings.settings.members.changeRole}: sam@x.test` }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(dialog.querySelector("select")!, { target: { value: "viewer" } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.save }));
    expect(await screen.findByText(strings.common.staleTitle)).toBeTruthy();
    expect(m.changeRole).toHaveBeenCalledWith({ memberId: "m2", role: "viewer", expectedRevision: 3 });

    // Someone else made Sam an Owner meanwhile (revision 4).
    m.members = screenData(4, "owner");
    rerender(tree());
    fireEvent.click(screen.getByRole("button", { name: strings.common.reload }));
    expect((screen.getByRole("dialog").querySelector("select") as HTMLSelectElement).value).toBe("owner");
    expect(screen.queryByText(strings.common.staleTitle)).toBeNull();
    fireEvent.change(screen.getByRole("dialog").querySelector("select")!, { target: { value: "viewer" } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.save }));
    await waitFor(() => expect(m.changeRole).toHaveBeenCalledTimes(2));
    expect(m.changeRole).toHaveBeenLastCalledWith({ memberId: "m2", role: "viewer", expectedRevision: 4 });
  });

  it("disable sends the row's revision", async () => {
    m.members = screenData(7);
    m.setDisabled.mockResolvedValue(undefined);
    render(tree());
    fireEvent.click(screen.getByRole("button", { name: `${strings.settings.members.disable}: sam@x.test` }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(dialog.querySelector("input")!, { target: { value: "sam@x.test" } });
    fireEvent.click(screen.getByRole("button", { name: strings.settings.members.disable }));
    await waitFor(() => expect(m.setDisabled).toHaveBeenCalledWith({ memberId: "m2", disabled: true, expectedRevision: 7 }));
  });
});
