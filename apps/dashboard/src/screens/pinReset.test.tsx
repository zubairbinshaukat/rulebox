import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { Me } from "../data/types";
import { AppError } from "../lib/errors";
import { captureResetToken, forgetResetToken, heldResetToken } from "../lib/pinResetLink";
import { sec } from "../lib/stepup/strings";
import { strings } from "../lib/strings";

const m = vi.hoisted(() => ({
  auth: { isLoading: false, isAuthenticated: true },
  me: null as unknown,
  redeem: vi.fn(),
  signOut: vi.fn(async () => undefined),
}));

vi.mock("../data", () => ({
  IS_DEMO: false,
  DASHBOARD_API_VERSION: 1,
  useAuthState: () => m.auth,
  useMe: () => m.me,
  useAuthActions: () => ({ signIn: vi.fn(), signUp: vi.fn(), signOut: m.signOut }),
}));
vi.mock("../data/stepup", () => ({ useRedeemPinReset: () => m.redeem }));

import PinReset from "./PinReset";

const owner: Me = {
  email: "owner@x.test",
  role: "owner",
  status: "active",
  orgId: "org",
  orgName: "Acme",
  pin: { required: true, set: true },
  serverApiVersion: 1,
};

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname + loc.search}</p>;
}

function ui() {
  return render(
    <MemoryRouter initialEntries={["/pin-reset"]}>
      <Routes>
        <Route path="/pin-reset" element={<PinReset />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

const fillPin = (pin: string) => {
  fireEvent.change(screen.getByLabelText(sec.newPin), { target: { value: pin } });
  fireEvent.change(screen.getByLabelText(sec.repeatPin), { target: { value: pin } });
  fireEvent.click(screen.getByRole("button", { name: sec.resetSubmit }));
};

beforeEach(() => {
  m.auth = { isLoading: false, isAuthenticated: true };
  m.me = owner;
  m.redeem.mockReset();
  m.signOut.mockClear();
  forgetResetToken();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  forgetResetToken();
  window.history.replaceState(null, "", "/");
});

describe("captureResetToken", () => {
  it("moves the token out of the address bar into memory; the URL keeps its path and query", () => {
    window.history.replaceState({ idx: 3 }, "", "/pin-reset?x=1#token=abc_DEF-123");
    expect(captureResetToken()).toBe("abc_DEF-123");
    expect(window.location.hash).toBe("");
    expect(window.location.pathname + window.location.search).toBe("/pin-reset?x=1");
    // The router's history state survives.
    expect(window.history.state).toEqual({ idx: 3 });
    // Calling again (StrictMode, re-render) still returns it.
    expect(captureResetToken()).toBe("abc_DEF-123");
  });

  it("strips a fragment whose token has the wrong shape and holds nothing", () => {
    window.history.replaceState(null, "", "/pin-reset#token=<script>");
    expect(captureResetToken()).toBeNull();
    expect(window.location.hash).toBe("");
    expect(heldResetToken()).toBeNull();
  });
});

describe("PinReset page", () => {
  it("removes the token from the URL at once, then redeems it with the new PIN", async () => {
    window.history.replaceState(null, "", "/pin-reset#token=tok_123");
    m.redeem.mockResolvedValue(undefined);
    ui();
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain("tok_123");
    // The weak PIN is refused before any call.
    fillPin("123456");
    expect(await screen.findByText(strings.validate.pinWeak)).toBeTruthy();
    expect(m.redeem).not.toHaveBeenCalled();
    fillPin("482915");
    await waitFor(() => expect(m.redeem).toHaveBeenCalledWith({ token: "tok_123", newPin: "482915" }));
    expect(await screen.findByText(sec.resetDone)).toBeTruthy();
    // Single use: the token is dropped from memory too.
    expect(heldResetToken()).toBeNull();
  });

  it("an expired, used or wrong link gets one generic sentence", async () => {
    window.history.replaceState(null, "", "/pin-reset#token=old_token");
    m.redeem.mockRejectedValue(new AppError({ code: "step_up_invalid" }));
    ui();
    fillPin("482915");
    expect(await screen.findByText(sec.resetInvalid)).toBeTruthy();
    expect(screen.queryByLabelText(sec.newPin)).toBeNull();
    expect(heldResetToken()).toBeNull();
  });

  it("a sign-in older than 15 minutes asks to sign in again and keeps the token for the detour", async () => {
    window.history.replaceState(null, "", "/pin-reset#token=tok_keep");
    m.redeem.mockRejectedValue(new AppError({ code: "step_up_setup_required", detail: "reauthenticate" }));
    ui();
    fillPin("482915");
    fireEvent.click(await screen.findByRole("button", { name: sec.signOutAndIn }));
    await waitFor(() => expect(m.signOut).toHaveBeenCalled());
    expect(heldResetToken()).toBe("tok_keep");
  });

  it("signed out: to sign-in and back (the token stays in memory, not in the URL)", () => {
    window.history.replaceState(null, "", "/pin-reset#token=tok_out");
    m.auth = { isLoading: false, isAuthenticated: false };
    m.me = null;
    ui();
    expect(screen.getByTestId("where").textContent).toBe("/sign-in?next=%2Fpin-reset");
    expect(window.location.href).not.toContain("tok_out");
    expect(heldResetToken()).toBe("tok_out");
  });

  it("Cancel drops the token from memory", () => {
    window.history.replaceState(null, "", "/pin-reset#token=tok_cancel");
    ui();
    expect(heldResetToken()).toBe("tok_cancel");
    fireEvent.click(screen.getByRole("link", { name: strings.common.cancel }));
    expect(heldResetToken()).toBeNull();
  });

  it("leaving the page any other way drops it too (also under StrictMode's extra mount)", async () => {
    window.history.replaceState(null, "", "/pin-reset#token=tok_leave");
    const view = render(
      <StrictMode>
        <MemoryRouter initialEntries={["/pin-reset"]}>
          <Routes>
            <Route path="/pin-reset" element={<PinReset />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(heldResetToken()).toBe("tok_leave");
    view.unmount();
    await waitFor(() => expect(heldResetToken()).toBeNull());
  });

  it("the sign-in detour of the reauthenticate step keeps it when the page goes away", async () => {
    window.history.replaceState(null, "", "/pin-reset#token=tok_detour");
    m.redeem.mockRejectedValue(new AppError({ code: "step_up_setup_required", detail: "reauthenticate" }));
    const view = ui();
    fillPin("482915");
    await screen.findByRole("button", { name: sec.signOutAndIn });
    view.unmount();
    await new Promise((r) => setTimeout(r, 10));
    expect(heldResetToken()).toBe("tok_detour");
  });

  it("without a token: says the link is needed", () => {
    ui();
    expect(screen.getByText(sec.resetNoToken)).toBeTruthy();
    expect(screen.queryByLabelText(sec.newPin)).toBeNull();
  });
});
