import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellState } from "@rulebox/types";

import { call } from "../../lib/tauri";
import { SignIn } from "./SignIn";

vi.mock("../../lib/tauri", () => ({
  call: vi.fn(),
  isTauri: () => false,
}));

const mockedCall = vi.mocked(call);

function baseShell(over: Partial<ShellState> = {}): ShellState {
  return {
    mode: "dev",
    link: "linked",
    agent: {
      enrollment: "enrolled",
      connection: "online",
      kioskPhase: "applied",
      clockSuspect: false,
      orgName: "Demo Org",
    },
    display: { lite: false, theme: "light", reducedMotion: false },
    session: { status: "signedOut", last: null },
    apps: { status: "idle", items: [] },
    tasks: [],
    system: {
      volume: null,
      battery: null,
      network: "internet",
      canPowerOff: false,
      canSleep: false,
      brightness: null,
    },
    notices: [],
    banner: null,
    capabilities: ["session", "apps", "adminExit", "state", "health"],
    broadcasts: [],
    ...over,
  };
}

describe("SignIn states", () => {
  beforeEach(() => {
    mockedCall.mockReset();
  });

  it("shows switch-user form when there is no last employee", () => {
    render(<SignIn shell={baseShell()} last={null} onSuccess={() => undefined} />);
    expect(screen.getByLabelText("Username")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });

  it("shows returning employee name and switch link", () => {
    render(
      <SignIn
        shell={baseShell()}
        last={{ username: "maya", name: "Maya Chen" }}
        onSuccess={() => undefined}
      />,
    );
    expect(screen.getByText("Maya Chen")).toBeTruthy();
    expect(screen.getByText(/Not Maya\? Switch user/)).toBeTruthy();
    expect(screen.queryByLabelText("Username")).toBeNull();
  });

  it("shows unsupported when session capability is missing", () => {
    render(
      <SignIn
        shell={baseShell({ capabilities: ["state", "health"] })}
        last={null}
        onSuccess={() => undefined}
      />,
    );
    expect(
      screen.getByText("This PC's Rulebox agent cannot sign employees in yet."),
    ).toBeTruthy();
  });

  it("shows reconnecting banner when not linked", () => {
    render(
      <SignIn
        shell={baseShell({ link: "connecting" })}
        last={null}
        onSuccess={() => undefined}
      />,
    );
    expect(screen.getByText("Rulebox is reconnecting…")).toBeTruthy();
  });

  it("shows clock suspect banner", () => {
    render(
      <SignIn
        shell={baseShell({
          agent: {
            enrollment: "enrolled",
            connection: "online",
            kioskPhase: "applied",
            clockSuspect: true,
            orgName: "Demo Org",
          },
        })}
        last={null}
        onSuccess={() => undefined}
      />,
    );
    expect(screen.getByText(/date and time look wrong/)).toBeTruthy();
  });

  async function submitReturning(password = "nope") {
    render(
      <SignIn
        shell={baseShell()}
        last={{ username: "maya", name: "Maya Chen" }}
        onSuccess={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: password },
    });
    fireEvent.click(screen.getByLabelText("Sign in"));
  }

  it("shows wrong-credentials error", async () => {
    mockedCall.mockResolvedValueOnce("wrongCredentials");
    await submitReturning();
    await waitFor(() => {
      expect(
        screen.getByText("That username or password is not right."),
      ).toBeTruthy();
    });
  });

  it("shows disabled account error", async () => {
    mockedCall.mockResolvedValueOnce("disabled");
    await submitReturning();
    await waitFor(() => {
      expect(
        screen.getByText(
          "Your account has been turned off. Contact your administrator.",
        ),
      ).toBeTruthy();
    });
  });

  it("shows the not-allowed-here error (protocol 1.2)", async () => {
    mockedCall.mockResolvedValueOnce("notAllowedHere");
    await submitReturning();
    await waitFor(() => {
      expect(screen.getByTestId("sign-in-error").textContent).toBe(
        "You can't sign in on this PC. Ask your administrator.",
      );
    });
  });

  it("shows no note when the agent did not end a session", () => {
    render(<SignIn shell={baseShell()} last={null} onSuccess={() => undefined} />);
    expect(screen.queryByTestId("session-ended-note")).toBeNull();
  });

  it.each([
    ["employeeRemoved", "Your account can't be used on this PC any more."],
    ["credentialChanged", "Your password was changed. Sign in again."],
    ["revoked", "This PC was removed from your organization."],
    ["unknown", "You were signed out."],
  ] as const)("explains why the session ended: %s", (reason, text) => {
    render(
      <SignIn shell={baseShell({ sessionEnded: reason })} last={null} onSuccess={() => undefined} />,
    );
    const note = screen.getByTestId("session-ended-note");
    expect(note.textContent).toBe(text);
    expect(note.getAttribute("role")).toBe("status");
    // The form is still usable: the note is not an error state.
    expect(screen.getByLabelText("Password").hasAttribute("disabled")).toBe(false);
  });

  it("shows lockout countdown", async () => {
    mockedCall.mockResolvedValueOnce({ lockedOut: { retryAfterMs: 90_000 } });
    await submitReturning();
    await waitFor(() => {
      expect(screen.getByText(/Too many tries\. Try again in/)).toBeTruthy();
    });
    // The agent's real payload: externally tagged, camelCase fields (a snake_case
    // `retry_after_ms` once made this read "NaN:NaN").
    const text = screen.getByTestId("sign-in-error").textContent ?? "";
    expect(text).not.toContain("NaN");
    expect(text).toMatch(/Try again in 1:[23]\d/);
  });

  it("shows offline-never and offline-expired errors", async () => {
    mockedCall.mockResolvedValueOnce("offlineNeverSignedIn");
    await submitReturning();
    await waitFor(() => {
      expect(
        screen.getByText(
          "You need an internet connection the first time you sign in on this PC.",
        ),
      ).toBeTruthy();
    });

    mockedCall.mockResolvedValueOnce("offlineExpired");
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "demo" },
    });
    fireEvent.click(screen.getByLabelText("Sign in"));
    await waitFor(() => {
      expect(
        screen.getByText("Connect to the internet to sign in again."),
      ).toBeTruthy();
    });
  });
});
