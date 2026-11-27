import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { useState } from "react";
import type { Me, StepUpStatus } from "../data/types";
import { AppError, errorCodeOf } from "../lib/errors";
import { MeContext } from "../lib/member";
import { strings } from "../lib/strings";
import { RECOVERY_SECRET_DETAIL, sec } from "../lib/stepup/strings";
import { ToastProvider } from "../app/Toasts";

// The data seam is mocked: these tests cover the step-up UI, not the backend
// (convex/stepUp.test.ts and convex/passkeys.test.ts cover that).
const m = vi.hoisted(() => ({
  status: { status: "loading" } as { status: "loading" } | { status: "ready"; data: unknown },
  verifyPin: vi.fn(),
  setPin: vi.fn(),
  keepAlive: vi.fn(),
  lock: vi.fn(),
  beginVerify: vi.fn(),
  finishVerify: vi.fn(),
  beginRegister: vi.fn(),
  finishRegister: vi.fn(),
  generate: vi.fn(),
  requestReset: vi.fn(),
  changePassword: vi.fn(),
  removePasskey: vi.fn(),
  renamePasskey: vi.fn(),
  recovery: vi.fn(),
  resetMember: vi.fn(),
  startAuthentication: vi.fn(),
  signOut: vi.fn(async () => undefined),
  connected: true,
}));

// Writes go through the step-up retry like the real seam (`useMapped` / `runMutation`).
vi.mock("../data/stepup", async () => {
  const { withStepUp } = await import("../lib/stepUpRetry");
  const seam = (fn: (a?: unknown) => Promise<unknown>) => (a?: unknown) => withStepUp(() => fn(a));
  return {
  useStepUpStatus: () => m.status,
  useVerifyActionPin: () => m.verifyPin,
  useSetActionPin: () => seam(m.setPin),
  useKeepAlive: () => m.keepAlive,
  useLockSession: () => m.lock,
  useBeginPasskeyVerification: () => m.beginVerify,
  useFinishPasskeyVerification: () => m.finishVerify,
  useBeginPasskeyRegistration: () => m.beginRegister,
  useFinishPasskeyRegistration: () => m.finishRegister,
  useGenerateRecoveryCodes: () => seam(m.generate),
  useRequestPinReset: () => m.requestReset,
  useChangePassword: () => seam(m.changePassword),
  useRemovePasskey: () => m.removePasskey,
  useRenamePasskey: () => m.renamePasskey,
  useResetStepUpWithRecoveryCode: () => m.recovery,
  useResetMemberStepUp: () => m.resetMember,
  };
});

vi.mock("../data", () => ({
  IS_DEMO: false,
  useAuthActions: () => ({ signIn: vi.fn(), signUp: vi.fn(), signOut: m.signOut }),
  useConnectionState: () => ({ isWebSocketConnected: m.connected }),
}));

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: m.startAuthentication,
  startRegistration: vi.fn(),
  WebAuthnAbortService: { cancelCeremony: vi.fn() },
}));

import { PasskeyReminder } from "./PasskeyReminder";
import { StepUpProvider } from "./StepUpProvider";
import { useStepUpController } from "./context";
import { withStepUp } from "../lib/stepUpRetry";
import SecurityTab from "../screens/settings/SecurityTab";

const owner: Me = {
  email: "owner@x.test",
  role: "owner",
  status: "active",
  orgId: "org",
  orgName: "Acme",
  pin: { required: true, set: true },
  serverApiVersion: 1,
};

const pinOf = (over: Partial<StepUpStatus["pin"]> = {}): StepUpStatus["pin"] => ({
  set: true,
  lockedUntil: null,
  lockKind: null,
  failedSinceUnlock: 0,
  attemptsBeforeLockout: 10,
  recoveryCodesLeft: 3,
  recoveryAvailable: true,
  resetByEmail: true,
  ...over,
});

function st(over: Partial<StepUpStatus> = {}, session: Partial<StepUpStatus["session"]> = {}): StepUpStatus {
  return {
    pin: pinOf(),
    passkeys: [],
    passkeysAvailable: true,
    session: { verifiedAt: null, lastActiveAt: null, method: null, ...session },
    bootstrapUntil: null,
    policy: { idleMs: 600_000, keepAliveMs: 300_000, freshMs: 300_000, maxAgeMs: 8 * 3600_000 },
    ...over,
  };
}

const ready = (s: StepUpStatus) => ({ status: "ready" as const, data: s });
const verified = { verifiedAt: 1, freshUntil: 2, serverNow: 1 };
const required = () => new AppError({ code: "step_up_required", detail: "fresh" });

/** A screen with one major action, wired like the Members tab. */
function Probe({ action }: { action: () => Promise<string> }) {
  const controller = useStepUpController();
  const [out, setOut] = useState("idle");
  const [pending, setPending] = useState(false);
  return (
    <div>
      <button
        disabled={pending}
        onClick={() => {
          setPending(true);
          withStepUp(action).then(
            (r) => setOut(`done:${r}`),
            (e: unknown) => setOut(`error:${errorCodeOf(e) ?? "unknown"}`),
          ).finally(() => setPending(false));
        }}
      >
        Do it
      </button>
      <button onClick={() => controller?.lockNow("manual")}>Lock</button>
      <p data-testid="out">{out}</p>
      <p data-testid="pending">{String(pending)}</p>
    </div>
  );
}

function ui(
  children: React.ReactNode,
  options?: ConstructorParameters<typeof import("../lib/stepup/controller").StepUpController>[0],
  member: Me = owner,
) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <MeContext.Provider value={member}>
          <StepUpProvider options={{ openChannel: () => null, isRealInput: () => true, lockOnStart: false, ...options }}>{children}</StepUpProvider>
        </MeContext.Provider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

let pkc: unknown;
beforeEach(() => {
  for (const fn of Object.values(m)) if (typeof fn === "function" && "mockReset" in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  m.status = ready(st());
  m.connected = true;
  m.keepAlive.mockResolvedValue({ serverNow: Date.now() });
  m.lock.mockResolvedValue(undefined);
  m.signOut.mockResolvedValue(undefined);
  pkc = (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
});
afterEach(() => {
  (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = pkc;
  vi.useRealTimers();
});

describe("confirm dialog and retry", () => {
  it("opens on step_up_required, a wrong PIN says so, the right one retries the call exactly once", async () => {
    const action = vi.fn().mockRejectedValueOnce(required()).mockResolvedValueOnce("ok");
    m.verifyPin.mockRejectedValueOnce(new AppError({ code: "step_up_invalid" })).mockResolvedValueOnce(verified);
    ui(<Probe action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    const dialog = await screen.findByRole("dialog", { name: sec.confirmTitle });
    expect(dialog.textContent).toContain(sec.confirmLeadFresh);
    // Passkey unsupported in this browser (no PublicKeyCredential): PIN only.
    expect(screen.queryByRole("button", { name: sec.usePasskey })).toBeNull();
    const pin = screen.getByLabelText(sec.pin) as HTMLInputElement;
    expect(pin.type).toBe("password");
    expect(pin.inputMode).toBe("numeric");
    expect(pin.autocomplete).toBe("off");
    fireEvent.change(pin, { target: { value: "111222" } });
    fireEvent.click(screen.getByRole("button", { name: sec.confirm }));
    expect(await screen.findByText(strings.errors.stepUpInvalid)).toBeTruthy();
    expect(pin.value).toBe("");
    fireEvent.change(pin, { target: { value: "482915" } });
    fireEvent.click(screen.getByRole("button", { name: sec.confirm }));
    await waitFor(() => expect(screen.getByTestId("out").textContent).toBe("done:ok"));
    expect(action).toHaveBeenCalledTimes(2);
    expect(m.verifyPin).toHaveBeenLastCalledWith({ pin: "482915" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancel rejects with the original error and nothing stays pending", async () => {
    const action = vi.fn().mockRejectedValue(required());
    ui(<Probe action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    await screen.findByRole("dialog");
    expect(screen.getByTestId("pending").textContent).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: strings.common.cancel }));
    await waitFor(() => expect(screen.getByTestId("out").textContent).toBe("error:step_up_required"));
    expect(screen.getByTestId("pending").textContent).toBe("false");
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("Escape closes it like Cancel", async () => {
    ui(<Probe action={vi.fn().mockRejectedValue(required())} />);
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("out").textContent).toBe("error:step_up_required"));
  });

  it("lockout: the wait is shown and the button stays disabled until it is over", async () => {
    m.verifyPin.mockRejectedValueOnce(new AppError({ code: "step_up_invalid", retryAfterMs: 30_000 }));
    ui(<Probe action={vi.fn().mockRejectedValue(required())} />);
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByLabelText(sec.pin), { target: { value: "111222" } });
    fireEvent.click(screen.getByRole("button", { name: sec.confirm }));
    expect(await screen.findByText(strings.errors.stepUpInvalidWait(30_000))).toBeTruthy();
    expect((screen.getByRole("button", { name: sec.confirm }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a server-reported short wait and the tries already used are shown", async () => {
    m.status = ready(st({ pin: pinOf({ lockedUntil: Date.now() + 60_000, lockKind: "backoff", failedSinceUnlock: 3, attemptsBeforeLockout: 7 }) }));
    ui(<Probe action={vi.fn().mockRejectedValue(required())} />);
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    await screen.findByRole("dialog");
    expect(screen.getByText(/Too many wrong PINs/)).toBeTruthy();
    expect(screen.getByText(sec.pinTriesLeft(3, 7))).toBeTruthy();
  });

  it("the long lockout hides the PIN field and says until when", async () => {
    m.status = ready(st({ pin: pinOf({ lockedUntil: Date.now() + 24 * 3600_000, lockKind: "lockout", failedSinceUnlock: 10 }) }));
    ui(<Probe action={vi.fn().mockRejectedValue(required())} />);
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    await screen.findByRole("dialog");
    expect(screen.getByText(/Your PIN is locked until/)).toBeTruthy();
    expect(screen.queryByLabelText(sec.pin)).toBeNull();
  });

  it("passkey first when one can be used; a closed prompt is not an error", async () => {
    (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = function PublicKeyCredential() {};
    m.status = ready(st({ passkeys: [{ _id: "pk1", name: "Laptop", createdAt: 1, lastUsedAt: null, synced: false, suspended: false }] }));
    m.beginVerify.mockResolvedValue({ optionsJson: JSON.stringify({ challenge: "abc", allowCredentials: [] }), expiresAt: 0 });
    m.startAuthentication.mockRejectedValueOnce(Object.assign(new Error("closed"), { name: "NotAllowedError" }));
    m.startAuthentication.mockResolvedValueOnce({ id: "cred", rawId: "cred", type: "public-key", response: {} });
    m.finishVerify.mockResolvedValue(verified);
    const action = vi.fn().mockRejectedValueOnce(required()).mockResolvedValueOnce("ok");
    ui(<Probe action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    await screen.findByRole("dialog");
    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons.indexOf(sec.usePasskey)).toBeLessThan(buttons.indexOf(sec.confirm));
    fireEvent.click(screen.getByRole("button", { name: sec.usePasskey }));
    expect(await screen.findByText(sec.passkeyCancelled)).toBeTruthy();
    expect(m.finishVerify).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: sec.usePasskey }));
    await waitFor(() => expect(screen.getByTestId("out").textContent).toBe("done:ok"));
    expect(JSON.parse((m.finishVerify.mock.calls[0]![0] as { responseJson: string }).responseJson)).toMatchObject({ id: "cred" });
  });

  it("no PIN yet (status): the dialog sets the first PIN, then retries", async () => {
    m.status = ready(st({ pin: pinOf({ set: false }) }));
    // A write that needs a PIN while the setup screen is not up (account:me still said "set").
    const action = vi.fn().mockRejectedValueOnce(new AppError({ code: "step_up_setup_required" })).mockResolvedValueOnce("ok");
    m.setPin.mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <MeContext.Provider value={owner}>
          <StepUpProvider options={{ openChannel: () => null, lockOnStart: false }}>
            <Probe action={action} />
          </StepUpProvider>
        </MeContext.Provider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    await screen.findByRole("dialog", { name: sec.noFactorTitle });
    fireEvent.change(screen.getByLabelText(sec.newPin), { target: { value: "123456" } });
    fireEvent.change(screen.getByLabelText(sec.repeatPin), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: sec.setPin }));
    expect(await screen.findByText(strings.validate.pinWeak)).toBeTruthy();
    expect(m.setPin).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(sec.newPin), { target: { value: "482915" } });
    fireEvent.change(screen.getByLabelText(sec.repeatPin), { target: { value: "482915" } });
    fireEvent.click(screen.getByRole("button", { name: sec.setPin }));
    await waitFor(() => expect(screen.getByTestId("out").textContent).toBe("done:ok"));
  });
});

describe("lock on every load", () => {
  it("asks for the PIN before any screen, shows the tries left, and a wrong then right PIN opens it", async () => {
    m.status = ready(st({ pin: pinOf({ failedSinceUnlock: 2, attemptsBeforeLockout: 8 }) }, { verifiedAt: 5, lastActiveAt: 5, method: "actionPin" }));
    m.verifyPin.mockRejectedValueOnce(new AppError({ code: "step_up_invalid" })).mockResolvedValueOnce(verified);
    ui(<p>secret screen</p>, { lockOnStart: true });
    expect(await screen.findByRole("heading", { name: sec.lockTitle })).toBeTruthy();
    // The server's earlier verification of this session is NOT an unlock for a freshly loaded tab.
    expect(screen.queryByText("secret screen")).toBeNull();
    expect(screen.getByText(sec.lockLeadLoad("owner@x.test"))).toBeTruthy();
    expect(screen.getByText(sec.pinTriesLeft(2, 8))).toBeTruthy();
    // Per tab: the server is not told to lock.
    expect(m.lock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(sec.pin), { target: { value: "111222" } });
    fireEvent.click(screen.getByRole("button", { name: sec.unlock }));
    expect(await screen.findByText(strings.errors.stepUpInvalid)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(sec.pin), { target: { value: "482915" } });
    fireEvent.click(screen.getByRole("button", { name: sec.unlock }));
    expect(await screen.findByText("secret screen")).toBeTruthy();
  });

  it("the long lockout is shown with the other ways in", async () => {
    m.status = ready(st({ pin: pinOf({ lockedUntil: Date.now() + 20 * 3600_000, lockKind: "lockout" }) }));
    ui(<p>secret screen</p>, { lockOnStart: true });
    expect(await screen.findByText(/Your PIN is locked until/)).toBeTruthy();
    expect(screen.getByText(sec.pinLockoutHelp)).toBeTruthy();
    expect(screen.queryByLabelText(sec.pin)).toBeNull();
    expect(screen.getByRole("button", { name: sec.forgotPin })).toBeTruthy();
    expect(screen.getByRole("button", { name: sec.useRecoveryCode })).toBeTruthy();
  });

  it("Forgot PIN: no email field, one neutral sentence", async () => {
    m.requestReset.mockResolvedValue(undefined);
    ui(<p>secret screen</p>, { lockOnStart: true });
    fireEvent.click(await screen.findByRole("button", { name: sec.forgotPin }));
    expect(await screen.findByText(sec.forgotSent("owner@x.test"))).toBeTruthy();
    expect(m.requestReset).toHaveBeenCalledWith();
    expect(screen.queryByLabelText(/email/i)).toBeNull();
  });

  it("Forgot PIN says so when the email flow is off", async () => {
    m.status = ready(st({ pin: pinOf({ resetByEmail: false }) }));
    ui(<p>secret screen</p>, { lockOnStart: true });
    expect(await screen.findByText(sec.emailOff)).toBeTruthy();
    expect(screen.queryByRole("button", { name: sec.forgotPin })).toBeNull();
  });

  it("recovery code: asks for the code AND a new PIN, then opens", async () => {
    m.recovery.mockResolvedValue(undefined);
    ui(<p>secret screen</p>, { lockOnStart: true });
    fireEvent.click(await screen.findByRole("button", { name: sec.useRecoveryCode }));
    fireEvent.change(screen.getByLabelText(sec.recoveryCode), { target: { value: "abcd efgh" } });
    fireEvent.change(screen.getByLabelText(sec.newPin), { target: { value: "123456" } });
    fireEvent.change(screen.getByLabelText(sec.repeatPin), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: sec.recoveryUseSubmit }));
    expect(await screen.findByText(strings.validate.pinWeak)).toBeTruthy();
    expect(m.recovery).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(sec.newPin), { target: { value: "482915" } });
    fireEvent.change(screen.getByLabelText(sec.repeatPin), { target: { value: "482915" } });
    fireEvent.click(screen.getByRole("button", { name: sec.recoveryUseSubmit }));
    await waitFor(() => expect(m.recovery).toHaveBeenCalledWith({ code: "ABCD-EFGH", newPin: "482915" }));
    expect(await screen.findByText("secret screen")).toBeTruthy();
  });

  it("recovery code, sign-in too old: asks to sign in again", async () => {
    m.recovery.mockRejectedValue(new AppError({ code: "step_up_setup_required", detail: "reauthenticate" }));
    ui(<p>secret screen</p>, { lockOnStart: true });
    fireEvent.click(await screen.findByRole("button", { name: sec.useRecoveryCode }));
    fireEvent.change(screen.getByLabelText(sec.recoveryCode), { target: { value: "ABCD-EFGH" } });
    fireEvent.change(screen.getByLabelText(sec.newPin), { target: { value: "482915" } });
    fireEvent.change(screen.getByLabelText(sec.repeatPin), { target: { value: "482915" } });
    fireEvent.click(screen.getByRole("button", { name: sec.recoveryUseSubmit }));
    expect(await screen.findByRole("button", { name: sec.signOutAndIn })).toBeTruthy();
  });

  it("recovery code, refused: the code and the PIN are not kept in the fields", async () => {
    m.recovery.mockRejectedValue(new AppError({ code: "step_up_invalid" }));
    ui(<p>secret screen</p>, { lockOnStart: true });
    fireEvent.click(await screen.findByRole("button", { name: sec.useRecoveryCode }));
    fireEvent.change(screen.getByLabelText(sec.recoveryCode), { target: { value: "ABCD-EFGH" } });
    fireEvent.change(screen.getByLabelText(sec.newPin), { target: { value: "482915" } });
    fireEvent.change(screen.getByLabelText(sec.repeatPin), { target: { value: "482915" } });
    fireEvent.click(screen.getByRole("button", { name: sec.recoveryUseSubmit }));
    await screen.findByRole("alert");
    for (const label of [sec.recoveryCode, sec.newPin, sec.repeatPin]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe("");
    }
  });

  it("no recovery codes left: the link is replaced by a sentence", async () => {
    m.status = ready(st({ pin: pinOf({ recoveryCodesLeft: 0 }) }));
    ui(<p>secret screen</p>, { lockOnStart: true });
    expect(await screen.findByText(sec.noRecoveryCodes)).toBeTruthy();
    expect(screen.queryByRole("button", { name: sec.useRecoveryCode })).toBeNull();
  });
});

describe("idle lock", () => {
  it("locks after idle, hides the screens, calls stepUp:lock; the PIN unlocks", async () => {
    m.status = ready(st({}, { verifiedAt: 5, lastActiveAt: 5, method: "actionPin" }));
    m.verifyPin.mockResolvedValue(verified);
    ui(<p>secret screen</p>, { idleOverrideMs: 1500 });
    expect(screen.getByText("secret screen")).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1700));
    });
    expect(await screen.findByRole("heading", { name: sec.lockTitle })).toBeTruthy();
    expect(screen.queryByText("secret screen")).toBeNull();
    expect(m.lock).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText(sec.pin), { target: { value: "482915" } });
    fireEvent.click(screen.getByRole("button", { name: sec.unlock }));
    expect(await screen.findByText("secret screen")).toBeTruthy();
  });

  it("checks on becoming visible (sleep / hidden tab) instead of trusting timers", async () => {
    m.status = ready(st({}, { verifiedAt: 5, lastActiveAt: 5, method: "actionPin" }));
    const now = Date.now();
    let fakeNow = now;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
    ui(<p>secret screen</p>);
    fakeNow = now + 11 * 60_000; // came back after 11 minutes; no timer has fired
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await screen.findByRole("heading", { name: sec.lockTitle })).toBeTruthy();
    spy.mockRestore();
  });

  it("two tabs, end to end: lock → server row gone → another tab verifies → unlocked here", async () => {
    m.status = ready(st({}, { verifiedAt: 5, lastActiveAt: 5, method: "actionPin" }));
    const tree = (probe: React.ReactNode) => (
      <MemoryRouter>
        <ToastProvider>
          <MeContext.Provider value={owner}>
            <StepUpProvider options={{ openChannel: () => null, lockOnStart: false }}>{probe}</StepUpProvider>
          </MeContext.Provider>
        </ToastProvider>
      </MemoryRouter>
    );
    const { rerender } = render(tree(<Probe action={async () => "x"} />));
    fireEvent.click(screen.getByRole("button", { name: "Lock" }));
    expect(await screen.findByRole("heading", { name: sec.lockTitle })).toBeTruthy();
    m.status = ready(st({}, { verifiedAt: null, lastActiveAt: null, method: null }));
    rerender(tree(<Probe action={async () => "x"} />));
    expect(screen.getByRole("heading", { name: sec.lockTitle })).toBeTruthy();
    m.status = ready(st({}, { verifiedAt: 99, lastActiveAt: 99, method: "passkey" }));
    rerender(tree(<Probe action={async () => "x"} />));
    expect(await screen.findByRole("button", { name: "Do it" })).toBeTruthy();
  });

  it("offline: the lock screen shows the reconnecting banner and stays locked", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    m.connected = false;
    m.status = ready(st({}, { verifiedAt: 5, lastActiveAt: 5, method: "actionPin" }));
    ui(<Probe action={async () => "x"} />);
    fireEvent.click(screen.getByRole("button", { name: "Lock" }));
    await screen.findByRole("heading", { name: sec.lockTitle });
    await act(async () => {
      vi.advanceTimersByTime(3500);
    });
    expect(screen.getByText(strings.app.reconnecting)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Do it" })).toBeNull();
  });
});

describe("PIN setup after the first sign-in", () => {
  const noPin = { ...owner, pin: { required: true, set: false } } satisfies Me;
  const fillPin = (pin: string) => {
    fireEvent.change(screen.getByLabelText(sec.newPin), { target: { value: pin } });
    fireEvent.change(screen.getByLabelText(sec.repeatPin), { target: { value: pin } });
    fireEvent.click(screen.getByRole("button", { name: sec.setPin }));
  };
  const CODES = ["AAAA-BBBB", "CCCC-DDDD"];
  /** `account:me` shows the PIN once it is saved: the same tree with the member that has one. */
  const pinSaved = (view: ReturnType<typeof ui>) =>
    view.rerender(
      <MemoryRouter>
        <ToastProvider>
          <MeContext.Provider value={owner}>
            <StepUpProvider options={{ openChannel: () => null, lockOnStart: true }}>
              <p>overview</p>
            </StepUpProvider>
          </MeContext.Provider>
        </ToastProvider>
      </MemoryRouter>,
    );

  it("PIN (with the warning) → recovery codes shown once → passkey offer with Skip → the dashboard", async () => {
    (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = function PublicKeyCredential() {};
    m.status = ready(st({ pin: pinOf({ set: false }), bootstrapUntil: Date.now() + 600_000 }));
    m.setPin.mockResolvedValue(undefined);
    m.generate.mockResolvedValue(CODES);
    const view = ui(<p>overview</p>, { lockOnStart: true }, noPin);
    expect(await screen.findByRole("heading", { name: sec.setupTitle })).toBeTruthy();
    expect(screen.queryByText("overview")).toBeNull();
    expect(screen.getByText(sec.setupWarnTitle)).toBeTruthy();
    expect(screen.getByRole("button", { name: sec.signOut })).toBeTruthy();
    // Two different PINs are refused before any call.
    fireEvent.change(screen.getByLabelText(sec.newPin), { target: { value: "482915" } });
    fireEvent.change(screen.getByLabelText(sec.repeatPin), { target: { value: "482916" } });
    fireEvent.click(screen.getByRole("button", { name: sec.setPin }));
    expect(await screen.findByText(strings.validate.pinsDiffer)).toBeTruthy();
    expect(m.setPin).not.toHaveBeenCalled();
    fillPin("482915");
    expect(await screen.findByRole("heading", { name: sec.codesTitle })).toBeTruthy();
    expect(m.setPin).toHaveBeenCalledWith({ pin: "482915" });
    expect(await screen.findByText("AAAA-BBBB")).toBeTruthy();
    expect(screen.getByRole("button", { name: sec.codesDownload })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy/ })).toBeTruthy();
    // The codes are never stored in the browser.
    expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toContain("AAAA-BBBB");
    // Continue stays off until the box is ticked.
    const cont = screen.getByRole("button", { name: sec.codesContinue }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: sec.codesSaved }));
    expect(cont.disabled).toBe(false);
    // The PIN exists now; the screen stays up until the last step.
    m.status = ready(st({}, { verifiedAt: 5, lastActiveAt: 5, method: "actionPin" }));
    pinSaved(view);
    fireEvent.click(cont);
    expect(await screen.findByRole("heading", { name: sec.setupPasskeyTitle })).toBeTruthy();
    expect(screen.queryByText("AAAA-BBBB")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: sec.setupPasskeySkip }));
    expect(await screen.findByText("overview")).toBeTruthy();
  });

  it("no passkey step when this browser cannot use passkeys", async () => {
    m.status = ready(st({ pin: pinOf({ set: false }) }));
    m.setPin.mockResolvedValue(undefined);
    m.generate.mockResolvedValue(CODES);
    const view = ui(<p>overview</p>, { lockOnStart: true }, noPin);
    await screen.findByRole("heading", { name: sec.setupTitle });
    fillPin("482915");
    await screen.findByRole("list", { name: sec.codesList });
    pinSaved(view);
    fireEvent.click(screen.getByRole("checkbox", { name: sec.codesSaved }));
    fireEvent.click(screen.getByRole("button", { name: sec.setupDone }));
    expect(await screen.findByText("overview")).toBeTruthy();
  });

  it("a failed code creation offers Try again", async () => {
    m.status = ready(st({ pin: pinOf({ set: false }) }));
    m.setPin.mockResolvedValue(undefined);
    m.generate.mockRejectedValueOnce(new AppError({ code: "rate_limited" })).mockResolvedValueOnce(CODES);
    ui(<p>overview</p>, { lockOnStart: true }, noPin);
    await screen.findByRole("heading", { name: sec.setupTitle });
    fillPin("482915");
    fireEvent.click(await screen.findByRole("button", { name: sec.codesRetry }));
    expect(await screen.findByText("AAAA-BBBB")).toBeTruthy();
  });

  it("an idle lock while the recovery codes are shown drops them; the PIN brings setup back with a fresh set", async () => {
    m.status = ready(st({ pin: pinOf({ set: false }) }));
    m.setPin.mockResolvedValue(undefined);
    m.generate.mockResolvedValueOnce(CODES).mockResolvedValueOnce(["EEEE-FFFF", "GGGG-HHHH"]);
    m.verifyPin.mockResolvedValue(verified);
    const view = ui(<p>overview</p>, { lockOnStart: true, idleOverrideMs: 1500 }, noPin);
    await screen.findByRole("heading", { name: sec.setupTitle });
    fillPin("482915");
    expect(await screen.findByText("AAAA-BBBB")).toBeTruthy();
    m.status = ready(st({}, { verifiedAt: 5, lastActiveAt: 5, method: "actionPin" }));
    pinSaved(view);
    // No input: the idle limit passes while the codes are on screen.
    expect(await screen.findByRole("heading", { name: sec.lockTitle }, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByText("AAAA-BBBB")).toBeNull();
    expect(screen.queryByRole("heading", { name: sec.codesTitle })).toBeNull();
    fireEvent.change(screen.getByLabelText(sec.pin), { target: { value: "482915" } });
    fireEvent.click(screen.getByRole("button", { name: sec.unlock }));
    // Back in setup at the codes step (the PIN is set): a new set, the old one is not shown again.
    expect(await screen.findByText("EEEE-FFFF")).toBeTruthy();
    expect(screen.queryByText("AAAA-BBBB")).toBeNull();
    expect(m.setPin).toHaveBeenCalledTimes(1);
    expect(m.generate).toHaveBeenCalledTimes(2);
  });

  it("reload after step 1: the PIN screen first, then setup resumes at the codes (step 2), not the dashboard", async () => {
    const unfinished = { ...owner, pin: { required: true, set: true, codesPending: true } } satisfies Me;
    m.status = ready(st({}, { verifiedAt: 5, lastActiveAt: 5, method: "actionPin" }));
    m.verifyPin.mockResolvedValue(verified);
    m.generate.mockResolvedValue(CODES);
    const view = ui(<p>overview</p>, { lockOnStart: true }, unfinished);
    // A fresh load asks for the PIN (it is set), and the dashboard stays hidden.
    expect(await screen.findByRole("heading", { name: sec.lockTitle })).toBeTruthy();
    expect(screen.queryByText("overview")).toBeNull();
    expect(m.generate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(sec.pin), { target: { value: "482915" } });
    fireEvent.click(screen.getByRole("button", { name: sec.unlock }));
    // No PIN form again: straight to step 2, with codes made once.
    expect(await screen.findByRole("heading", { name: sec.codesTitle })).toBeTruthy();
    expect(await screen.findByText("AAAA-BBBB")).toBeTruthy();
    expect(screen.queryByLabelText(sec.newPin)).toBeNull();
    expect(screen.getByText(sec.setupStepOf(2, 2, sec.setupSteps[1]))).toBeTruthy();
    expect(m.setPin).not.toHaveBeenCalled();
    expect(m.generate).toHaveBeenCalledTimes(1);
    // The server now knows the codes exist: Continue ends setup.
    pinSaved(view);
    fireEvent.click(screen.getByRole("checkbox", { name: sec.codesSaved }));
    fireEvent.click(screen.getByRole("button", { name: sec.setupDone }));
    expect(await screen.findByText("overview")).toBeTruthy();
  });

  it("a PIN with its codes made is not set up again after a reload (the PIN screen, then the dashboard)", async () => {
    m.status = ready(st({}, { verifiedAt: 5, lastActiveAt: 5, method: "actionPin" }));
    m.verifyPin.mockResolvedValue(verified);
    ui(<p>overview</p>, { lockOnStart: true });
    expect(await screen.findByRole("heading", { name: sec.lockTitle })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(sec.pin), { target: { value: "482915" } });
    fireEvent.click(screen.getByRole("button", { name: sec.unlock }));
    expect(await screen.findByText("overview")).toBeTruthy();
    expect(m.generate).not.toHaveBeenCalled();
  });

  it("the server cannot make recovery codes: said before any PIN is saved, with no PIN form", async () => {
    m.status = ready(st({ pin: pinOf({ set: false, recoveryAvailable: false }) }));
    ui(<p>overview</p>, { lockOnStart: true }, noPin);
    expect(await screen.findByText(sec.setupBlockedTitle)).toBeTruthy();
    expect(screen.getByText(sec.setupBlockedDetail)).toBeTruthy();
    expect(screen.queryByLabelText(sec.newPin)).toBeNull();
    expect(screen.queryByRole("button", { name: sec.setPin })).toBeNull();
    expect(screen.getByRole("button", { name: sec.setupBlockedAgain })).toBeTruthy();
    expect(screen.getByRole("button", { name: sec.signOut })).toBeTruthy();
    expect(m.setPin).not.toHaveBeenCalled();
  });

  it("a missing server secret at step 2 gets its own message: what is missing, who fixes it, the PIN is saved", async () => {
    m.status = ready(st({ pin: pinOf({ set: false }) }));
    m.setPin.mockResolvedValue(undefined);
    m.generate.mockRejectedValue(new AppError({ code: "not_ready", detail: RECOVERY_SECRET_DETAIL }));
    ui(<p>overview</p>, { lockOnStart: true }, noPin);
    await screen.findByRole("heading", { name: sec.setupTitle });
    fillPin("482915");
    expect(await screen.findByText(sec.notReady[RECOVERY_SECRET_DETAIL]!)).toBeTruthy();
    expect(screen.getByText(sec.codesPinSaved)).toBeTruthy();
    expect(screen.queryByText(strings.errors.notReady)).toBeNull();
  });

  it("a not_ready of another kind keeps the generic sentence and no 'PIN saved' note", async () => {
    m.status = ready(st({ pin: pinOf({ set: false }) }));
    m.setPin.mockResolvedValue(undefined);
    m.generate.mockRejectedValue(new AppError({ code: "not_ready" }));
    ui(<p>overview</p>, { lockOnStart: true }, noPin);
    await screen.findByRole("heading", { name: sec.setupTitle });
    fillPin("482915");
    expect(await screen.findByText(strings.errors.notReady)).toBeTruthy();
    expect(screen.queryByText(sec.codesPinSaved)).toBeNull();
  });

  it("a refused PIN is not kept in the fields", async () => {
    m.status = ready(st({ pin: pinOf({ set: false }) }));
    m.setPin.mockRejectedValue(new AppError({ code: "rate_limited" }));
    ui(<p>overview</p>, { lockOnStart: true }, noPin);
    await screen.findByRole("heading", { name: sec.setupTitle });
    fillPin("482915");
    await screen.findByRole("alert");
    expect((screen.getByLabelText(sec.newPin) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(sec.repeatPin) as HTMLInputElement).value).toBe("");
  });

  it("too long after sign-in: asks to sign in again", async () => {
    m.status = ready(st({ pin: pinOf({ set: false }) }));
    m.setPin.mockRejectedValue(new AppError({ code: "step_up_setup_required", detail: "reauthenticate" }));
    ui(<p>overview</p>, { lockOnStart: true }, noPin);
    await screen.findByRole("heading", { name: sec.setupTitle });
    fillPin("482915");
    fireEvent.click(await screen.findByRole("button", { name: sec.signOutAndIn }));
    await waitFor(() => expect(m.signOut).toHaveBeenCalled());
  });
});

describe("passkey reminder banner", () => {
  beforeEach(() => {
    (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = function PublicKeyCredential() {};
    try {
      window.localStorage.clear();
    } catch {
      /* no storage */
    }
  });

  it("shows when there is no passkey, links to Settings → Security, and Dismiss hides it for good", async () => {
    const view = ui(<PasskeyReminder />);
    expect(await screen.findByText(sec.passkeyReminderTitle)).toBeTruthy();
    expect(screen.getByRole("link", { name: sec.passkeyReminderAction }).getAttribute("href")).toBe("/settings?tab=security");
    fireEvent.click(screen.getByRole("button", { name: sec.passkeyReminderDismiss }));
    expect(screen.queryByText(sec.passkeyReminderTitle)).toBeNull();
    view.unmount();
    ui(<PasskeyReminder />);
    // Remembered in this browser (status is already "ready", so nothing is still loading here).
    expect(screen.queryByText(sec.passkeyReminderTitle)).toBeNull();
  });

  it("stays away with a passkey, without passkey support, or while codes are still pending", async () => {
    m.status = ready(st({ passkeys: [{ _id: "p1", name: "Laptop", createdAt: 1, lastUsedAt: null, synced: false, suspended: false }] }));
    const first = ui(<PasskeyReminder />);
    await waitFor(() => expect(screen.queryByText(sec.passkeyReminderTitle)).toBeNull());
    first.unmount();

    m.status = ready(st());
    delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
    const second = ui(<PasskeyReminder />);
    await waitFor(() => expect(screen.queryByText(sec.passkeyReminderTitle)).toBeNull());
    second.unmount();

    (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = function PublicKeyCredential() {};
    ui(<PasskeyReminder />, undefined, { ...owner, pin: { required: true, set: true, codesPending: true } });
    await waitFor(() => expect(screen.queryByText(sec.passkeyReminderTitle)).toBeNull());
  });
});

describe("Settings → Security", () => {
  it("lists passkeys, shows that passkeys are off, and has no way to remove the PIN", async () => {
    m.status = ready(
      st({
        passkeys: [{ _id: "pk1", name: "Laptop", createdAt: 1_700_000_000_000, lastUsedAt: null, synced: true, suspended: false }],
        passkeysAvailable: false,
      }),
    );
    ui(<SecurityTab />);
    expect(await screen.findByText("Laptop")).toBeTruthy();
    expect(screen.getByText(sec.synced)).toBeTruthy();
    expect(screen.getByText(sec.passkeysOff)).toBeTruthy();
    expect(screen.getByText(sec.pinRequiredHint)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Remove PIN/ })).toBeNull();
    expect(screen.queryByRole("button", { name: sec.addPasskey })).toBeNull();
  });

  it("change PIN asks for a fresh confirmation, then saves", async () => {
    m.status = ready(st());
    m.setPin.mockRejectedValueOnce(required()).mockResolvedValueOnce(undefined);
    m.verifyPin.mockResolvedValue(verified);
    ui(<SecurityTab />);
    fireEvent.click(await screen.findByRole("button", { name: sec.changePin }));
    fireEvent.change(screen.getByLabelText(sec.newPin), { target: { value: "90817263" } });
    fireEvent.change(screen.getByLabelText(sec.repeatPin), { target: { value: "90817263" } });
    fireEvent.click(screen.getByRole("button", { name: sec.setPin }));
    const confirm = await screen.findByRole("dialog", { name: sec.confirmTitle });
    fireEvent.change(within(confirm).getByLabelText(sec.pin), { target: { value: "482915" } });
    fireEvent.click(within(confirm).getByRole("button", { name: sec.confirm }));
    await waitFor(() => expect(m.setPin).toHaveBeenCalledTimes(2));
    expect(m.setPin).toHaveBeenLastCalledWith({ pin: "90817263" });
    expect(await screen.findByText(sec.pinSaved)).toBeTruthy();
  });

  it("recovery codes: shows how many are left; new codes need a confirmation and are shown once", async () => {
    m.status = ready(st({ pin: pinOf({ recoveryCodesLeft: 4 }) }));
    m.generate.mockRejectedValueOnce(required()).mockResolvedValueOnce(["EEEE-FFFF"]);
    m.verifyPin.mockResolvedValue(verified);
    ui(<SecurityTab />);
    expect(await screen.findByText(sec.recoveryLeft(4))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: sec.recoveryCreate }));
    const ask = await screen.findByRole("dialog", { name: sec.recoveryCreateTitle });
    fireEvent.click(within(ask).getByRole("button", { name: sec.recoveryCreate }));
    const confirm = await screen.findByRole("dialog", { name: sec.confirmTitle });
    fireEvent.change(within(confirm).getByLabelText(sec.pin), { target: { value: "482915" } });
    fireEvent.click(within(confirm).getByRole("button", { name: sec.confirm }));
    expect(within(await screen.findByRole("list", { name: sec.codesList })).getByText("EEEE-FFFF")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.common.done }));
    await waitFor(() => expect(screen.queryByRole("list", { name: sec.codesList })).toBeNull());
  });

  it("change password: the confirmation comes first, then current + new + repeat are sent", async () => {
    // Confirmed 20 minutes ago: the confirm dialog opens BEFORE the form.
    m.status = ready(st({}, { verifiedAt: Date.now() - 20 * 60_000, lastActiveAt: Date.now(), method: "actionPin" }));
    m.verifyPin.mockResolvedValue(verified);
    m.changePassword.mockResolvedValue(undefined);
    ui(<SecurityTab />);
    fireEvent.click(await screen.findByRole("button", { name: sec.passwordChange }));
    const confirm = await screen.findByRole("dialog", { name: sec.confirmTitle });
    expect(screen.queryByLabelText(sec.passwordCurrent)).toBeNull();
    fireEvent.change(within(confirm).getByLabelText(sec.pin), { target: { value: "482915" } });
    fireEvent.click(within(confirm).getByRole("button", { name: sec.confirm }));
    const current = await screen.findByLabelText(sec.passwordCurrent, { selector: "input" });
    fireEvent.change(current, { target: { value: "old-password-1" } });
    fireEvent.change(screen.getByLabelText(sec.passwordNew, { selector: "input" }), { target: { value: "short1" } });
    fireEvent.change(screen.getByLabelText(sec.passwordRepeat, { selector: "input" }), { target: { value: "short1" } });
    const submit = () => screen.getAllByRole("button", { name: sec.passwordChange }).at(-1)!;
    fireEvent.click(submit());
    expect(await screen.findByText(strings.validate.passwordMember)).toBeTruthy();
    expect(m.changePassword).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(sec.passwordNew, { selector: "input" }), { target: { value: "a-new-password-2" } });
    fireEvent.change(screen.getByLabelText(sec.passwordRepeat, { selector: "input" }), { target: { value: "a-new-password-2" } });
    fireEvent.click(submit());
    await waitFor(() => expect(m.changePassword).toHaveBeenCalledWith({ currentPassword: "old-password-1", newPassword: "a-new-password-2" }));
    expect(await screen.findByText(sec.passwordChanged)).toBeTruthy();
  });

  it("change password: a wrong current password is said plainly", async () => {
    m.status = ready(st({}, { verifiedAt: Date.now(), lastActiveAt: Date.now(), method: "actionPin" }));
    m.changePassword.mockRejectedValue(new AppError({ code: "invalid_argument", field: "currentPassword" }));
    ui(<SecurityTab />);
    fireEvent.click(await screen.findByRole("button", { name: sec.passwordChange }));
    fireEvent.change(await screen.findByLabelText(sec.passwordCurrent, { selector: "input" }), { target: { value: "wrong-password-1" } });
    fireEvent.change(screen.getByLabelText(sec.passwordNew, { selector: "input" }), { target: { value: "a-new-password-2" } });
    fireEvent.change(screen.getByLabelText(sec.passwordRepeat, { selector: "input" }), { target: { value: "a-new-password-2" } });
    fireEvent.click(screen.getAllByRole("button", { name: sec.passwordChange }).at(-1)!);
    expect(await screen.findByText(sec.passwordWrong)).toBeTruthy();
  });
});
