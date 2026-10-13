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
    },
    notices: [],
    banner: null,
    capabilities: ["session", "apps", "adminExit", "state", "health"],
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

  it("shows lockout countdown", async () => {
    mockedCall.mockResolvedValueOnce({ lockedOut: { retryAfterMs: 90_000 } });
    await submitReturning();
    await waitFor(() => {
      expect(screen.getByText(/Too many tries\. Try again in/)).toBeTruthy();
    });
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
