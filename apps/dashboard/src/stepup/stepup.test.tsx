import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { useState } from "react";
import type { Me, StepUpStatus } from "../data/types";
import { AppError, errorCodeOf } from "../lib/errors";
import { MeContext } from "../lib/member";
import { strings } from "../lib/strings";
import { sec } from "../lib/stepup/strings";
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
  clearPin: vi.fn(),
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
  useClearActionPin: () => m.clearPin,
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
  mfa: { enrolled: true, required: true, verified: true },
  serverApiVersion: 1,
};

function st(over: Partial<StepUpStatus> = {}, session: Partial<StepUpStatus["session"]> = {}): StepUpStatus {
  return {
    actionPin: { set: true, lockedUntil: null, disabled: false, attemptsBeforeDisable: 10 },
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

function ui(children: React.ReactNode, options?: ConstructorParameters<typeof import("../lib/stepup/controller").StepUpController>[0]) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <MeContext.Provider value={owner}>
          <StepUpProvider options={{ openChannel: () => null, isRealInput: () => true, ...options }}>{children}</StepUpProvider>
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

  it("a server-reported lock (lockedUntil) and a turned-off PIN are shown", async () => {
    m.status = ready(st({ actionPin: { set: true, lockedUntil: Date.now() + 60_000, disabled: false, attemptsBeforeDisable: 7 } }));
    const { unmount } = ui(<Probe action={vi.fn().mockRejectedValue(required())} />);
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    await screen.findByRole("dialog");
    expect(screen.getByText(/Too many wrong PINs/)).toBeTruthy();
    expect(screen.getByText(sec.pinTriesLeft(7))).toBeTruthy();
    unmount();
    m.status = ready(st({ actionPin: { set: true, lockedUntil: null, disabled: true, attemptsBeforeDisable: 0 } }));
    ui(<Probe action={vi.fn().mockRejectedValue(required())} />);
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    await screen.findByRole("dialog");
    expect(screen.getByText(sec.pinDisabledNoPasskey)).toBeTruthy();
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

  it("no factor yet: the dialog sets the first PIN, then retries", async () => {
    m.status = ready(st({ actionPin: { set: false, lockedUntil: null, disabled: false, attemptsBeforeDisable: 10 } }));
    // A Viewer (no forced setup screen) hitting a write that needs a factor.
    const action = vi.fn().mockRejectedValueOnce(new AppError({ code: "step_up_setup_required" })).mockResolvedValueOnce("ok");
    m.setPin.mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <MeContext.Provider value={{ ...owner, role: "viewer" }}>
          <StepUpProvider options={{ openChannel: () => null }}>
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
            <StepUpProvider options={{ openChannel: () => null }}>{probe}</StepUpProvider>
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

describe("first-factor setup", () => {
  it("an Owner without a factor sees the setup screen first; Continue only after the PIN; sign-out always", async () => {
    m.status = ready(st({ actionPin: { set: false, lockedUntil: null, disabled: false, attemptsBeforeDisable: 10 }, bootstrapUntil: Date.now() + 600_000 }));
    m.setPin.mockResolvedValue(undefined);
    const { rerender } = ui(<p>overview</p>);
    expect(await screen.findByRole("heading", { name: sec.setupTitle })).toBeTruthy();
    expect(screen.queryByText("overview")).toBeNull();
    expect(screen.getByRole("button", { name: sec.signOut })).toBeTruthy();
    expect(screen.queryByRole("button", { name: sec.setupDone })).toBeNull();
    fireEvent.change(screen.getByLabelText(sec.newPin), { target: { value: "482915" } });
    fireEvent.change(screen.getByLabelText(sec.repeatPin), { target: { value: "482915" } });
    fireEvent.click(screen.getByRole("button", { name: sec.setPin }));
    expect(await screen.findByText(sec.pinSaved)).toBeTruthy();
    // The query now shows the PIN; the screen stays until Continue.
    m.status = ready(st({}, { verifiedAt: 5, lastActiveAt: 5, method: "actionPin" }));
    rerender(
      <MemoryRouter>
        <ToastProvider>
          <MeContext.Provider value={owner}>
            <StepUpProvider options={{ openChannel: () => null }}>
              <p>overview</p>
            </StepUpProvider>
          </MeContext.Provider>
        </ToastProvider>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: sec.setupDone }));
    expect(await screen.findByText("overview")).toBeTruthy();
  });

  it("too long after sign-in: asks to sign in again (the Owner is never locked out)", async () => {
    m.status = ready(st({ actionPin: { set: false, lockedUntil: null, disabled: false, attemptsBeforeDisable: 10 } }));
    m.setPin.mockRejectedValue(new AppError({ code: "step_up_setup_required", detail: "reauthenticate" }));
    ui(<p>overview</p>);
    await screen.findByRole("heading", { name: sec.setupTitle });
    fireEvent.change(screen.getByLabelText(sec.newPin), { target: { value: "482915" } });
    fireEvent.change(screen.getByLabelText(sec.repeatPin), { target: { value: "482915" } });
    fireEvent.click(screen.getByRole("button", { name: sec.setPin }));
    fireEvent.click(await screen.findByRole("button", { name: sec.signOutAndIn }));
    await waitFor(() => expect(m.signOut).toHaveBeenCalled());
  });
});

describe("Settings → Security", () => {
  it("lists passkeys, keeps the last factor, and shows 'passkeys off'", async () => {
    m.status = ready(
      st({
        actionPin: { set: false, lockedUntil: null, disabled: false, attemptsBeforeDisable: 10 },
        passkeys: [{ _id: "pk1", name: "Laptop", createdAt: 1_700_000_000_000, lastUsedAt: null, synced: true, suspended: false }],
        passkeysAvailable: false,
      }),
    );
    ui(<SecurityTab />);
    expect(await screen.findByText("Laptop")).toBeTruthy();
    expect(screen.getByText(sec.synced)).toBeTruthy();
    expect(screen.getByText(sec.passkeysOff)).toBeTruthy();
    expect((screen.getByRole("button", { name: `${sec.removePasskey}: Laptop` }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(sec.lastPasskeyHint)).toBeTruthy();
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
});
