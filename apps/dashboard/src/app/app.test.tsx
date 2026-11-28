import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { Me, MeResult, SettingsScreen } from "../data/types";
import { AppError } from "../lib/errors";
import { MeContext } from "../lib/member";
import { strings } from "../lib/strings";

// The data seam is mocked: these tests cover the UI's rules, not the backend.
const mock = vi.hoisted(() => ({
  auth: { isLoading: false, isAuthenticated: true },
  me: undefined as unknown,
  connected: true,
  settings: null as unknown,
  updateSettings: vi.fn(),
  overview: { status: "loading" } as unknown,
  publishAgain: vi.fn(),
}));

vi.mock("../data", () => ({
  IS_DEMO: false,
  DASHBOARD_API_VERSION: 1,
  useAuthState: () => mock.auth,
  useMe: () => mock.me,
  useAuthActions: () => ({ signIn: vi.fn(), signUp: vi.fn(), signOut: vi.fn(async () => undefined) }),
  useConnectionState: () => ({ isWebSocketConnected: mock.connected }),
  useSettingsScreen: () => mock.settings,
  useUpdateSettings: () => mock.updateSettings,
  usePlan: () => ({ status: "loading" }),
  useOverview: () => mock.overview,
  usePublishAgain: () => mock.publishAgain,
}));

vi.mock("../data/stepup", () => ({
  // Ready, with no PIN: the shell's start lock opens at once (these tests are about the shell, not the PIN screen).
  useStepUpStatus: () => ({
    status: "ready",
    data: {
      pin: { set: false, lockedUntil: null, lockKind: null, failedSinceUnlock: 0, attemptsBeforeLockout: 10, recoveryCodesLeft: 0, resetByEmail: false },
      passkeys: [],
      passkeysAvailable: false,
      session: { verifiedAt: null, lastActiveAt: null, method: null },
      bootstrapUntil: null,
      policy: { idleMs: 600000, keepAliveMs: 300000, freshMs: 300000, maxAgeMs: 28800000 },
    },
  }),
  useKeepAlive: () => async () => ({ serverNow: Date.now() }),
  useLockSession: () => async () => undefined,
}));

import { RequireMember } from "./RequireMember";
import { Layout } from "./Layout";
import { ConnectionBanner } from "./ConnectionBanner";
import { PublishBanner } from "./PublishBanner";
import { RoleGate } from "../components/RoleGate";
import { CopyField } from "../components/CopyField";
import { OrganizationTab } from "../screens/settings/OrganizationTab";
import { ToastProvider } from "./Toasts";

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

function renderGate(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/sign-in" element={<Where />} />
        <Route element={<RequireMember />}>
          <Route path="*" element={<p>inside</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mock.auth = { isLoading: false, isAuthenticated: true };
  mock.me = owner;
  mock.connected = true;
  mock.updateSettings.mockReset();
  mock.overview = { status: "loading" };
  mock.publishAgain.mockReset();
});

describe("RequireMember", () => {
  it("sends signed-out visitors to sign-in with next", () => {
    mock.auth = { isLoading: false, isAuthenticated: false };
    mock.me = null;
    renderGate("/devices?group=a");
    expect(screen.getByTestId("where").textContent).toBe("/sign-in?next=%2Fdevices%3Fgroup%3Da");
  });
  it("shows the no-access page for a user without a member row", () => {
    mock.me = { noAccess: true, serverApiVersion: 1 } satisfies MeResult;
    renderGate("/");
    expect(screen.getByRole("heading", { name: strings.app.noAccessTitle })).toBeTruthy();
  });
  it("lets a member without a PIN yet in: PIN setup is the step-up shell's job, not the gate's", () => {
    mock.me = { ...owner, pin: { required: true, set: false } };
    renderGate("/audit");
    expect(screen.getByText("inside")).toBeTruthy();
  });
  it("renders the screen for a verified member", () => {
    renderGate("/");
    expect(screen.getByText("inside")).toBeTruthy();
  });
  it("waits while the session loads", () => {
    mock.auth = { isLoading: true, isAuthenticated: false };
    renderGate("/");
    expect(screen.getByText(strings.app.signingIn)).toBeTruthy();
  });
});

describe("Layout", () => {
  it("marks the current page in the navigation with aria-current", () => {
    render(
      <MemoryRouter initialEntries={["/devices/abc"]}>
        <MeContext.Provider value={owner}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="*" element={<p>page</p>} />
            </Route>
          </Routes>
        </MeContext.Provider>
      </MemoryRouter>,
    );
    const nav = screen.getByRole("navigation", { name: strings.app.mainNav });
    const current = nav.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toContain(strings.app.nav.devices);
    expect(screen.getByText(strings.app.skipToContent).getAttribute("href")).toBe("#main");
  });

  it("has a Networks entry (Phase 5 Step 13) that is current on its Wi-Fi pages", () => {
    render(
      <MemoryRouter initialEntries={["/networks/wifi/abc"]}>
        <MeContext.Provider value={owner}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="*" element={<p>page</p>} />
            </Route>
          </Routes>
        </MeContext.Provider>
      </MemoryRouter>,
    );
    const nav = screen.getByRole("navigation", { name: strings.app.mainNav });
    const link = Array.from(nav.querySelectorAll("a")).find((a) => a.textContent?.includes(strings.app.nav.networks));
    expect(link?.getAttribute("href")).toBe("/networks");
    expect(link?.getAttribute("aria-current")).toBe("page");
  });
});

describe("ConnectionBanner", () => {
  it("appears only after 3 seconds without a connection", () => {
    vi.useFakeTimers();
    mock.connected = false;
    render(<ConnectionBanner />);
    expect(screen.queryByText(strings.app.reconnecting)).toBeNull();
    act(() => vi.advanceTimersByTime(3100));
    expect(screen.getByText(strings.app.reconnecting)).toBeTruthy();
    vi.useRealTimers();
  });
});

describe("PublishBanner", () => {
  const failed = (publishFailedAt: number | null) => {
    mock.overview = { status: "ready", data: { publishFailedAt, rosterPending: false } };
  };
  const show = (role: Me["role"] = "owner") =>
    render(
      <ToastProvider>
        <MeContext.Provider value={{ ...owner, role }}>
          <PublishBanner />
        </MeContext.Provider>
      </ToastProvider>,
    );

  it("is absent while the overview loads and while publishing works", () => {
    show();
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();
    failed(null);
    show();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: strings.publish.again })).toBeNull();
  });

  it("tells everyone that publishing failed; an Owner gets Publish again, an Admin is told to ask one", () => {
    failed(Date.now() - 3600_000);
    show("owner");
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain(strings.publish.bannerTitle);
    expect(screen.getByRole("button", { name: strings.publish.again })).toBeTruthy();
    cleanup();
    show("admin");
    expect(screen.getByRole("alert").textContent).toContain("Ask an Owner");
    expect(screen.queryByRole("button", { name: strings.publish.again })).toBeNull();
  });

  it("Publish again shows progress, calls the mutation once, then confirms with a toast", async () => {
    failed(Date.now() - 1000);
    let done: () => void = () => undefined;
    const call = vi.fn(() => new Promise<void>((resolve) => (done = resolve)));
    mock.publishAgain = call;
    show();
    fireEvent.click(screen.getByRole("button", { name: strings.publish.again }));
    const busy = screen.getByRole("button", { name: strings.publish.publishing });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    await act(async () => done());
    expect(screen.getByText(strings.publish.done)).toBeTruthy();
    expect((screen.getByRole("button", { name: strings.publish.again }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a refusal stays on the banner in plain words: no key on the deployment, or another key", async () => {
    failed(Date.now() - 1000);
    mock.publishAgain = vi.fn(async () => {
      throw new AppError({ code: "not_ready", detail: "RULEBOX_POLICY_KEY is not set or not 32 bytes of base64" });
    });
    show();
    fireEvent.click(screen.getByRole("button", { name: strings.publish.again }));
    expect(await screen.findByText(strings.publish.notReady)).toBeTruthy();
    expect((screen.getByRole("button", { name: strings.publish.again }) as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    mock.publishAgain = vi.fn(async () => {
      throw new AppError({ code: "conflict", detail: "key_exists" });
    });
    show();
    fireEvent.click(screen.getByRole("button", { name: strings.publish.again }));
    expect(await screen.findByText(strings.publish.mismatch)).toBeTruthy();
  });

  it("is part of the signed-in shell", () => {
    failed(Date.now() - 1000);
    render(
      <MemoryRouter initialEntries={["/"]}>
        <MeContext.Provider value={owner}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="*" element={<p>page</p>} />
            </Route>
          </Routes>
        </MeContext.Provider>
      </MemoryRouter>,
    );
    expect(screen.getByText(strings.publish.bannerTitle)).toBeTruthy();
  });
});

describe("RoleGate", () => {
  const ui = (role: Me["role"]) =>
    render(
      <MeContext.Provider value={{ ...owner, role }}>
        <RoleGate minRole="admin">
          <button>Edit</button>
        </RoleGate>
        <RoleGate minRole="owner" fallback={<span>owner only</span>}>
          <button>Invite</button>
        </RoleGate>
      </MeContext.Provider>,
    );
  it("hides admin controls from viewers (not disabled, absent)", () => {
    ui("viewer");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByText("owner only")).toBeTruthy();
  });
  it("shows them to admins, owner-only stays hidden", () => {
    ui("admin");
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
  });
});

describe("CopyField", () => {
  it("uses the clipboard in a secure context and says Copied", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CopyField value="RBX1.secret" label="Code" />);
    fireEvent.click(screen.getByRole("button", { name: strings.common.copy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("RBX1.secret"));
    expect(await screen.findByRole("button", { name: strings.common.copied })).toBeTruthy();
  });
  it("falls back to select-all with a hint outside a secure context", async () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    render(<CopyField value="RBX1.secret" label="Code" />);
    fireEvent.click(screen.getByRole("button", { name: strings.common.copy }));
    const input = screen.getByLabelText("Code") as HTMLInputElement;
    expect(await screen.findByText(strings.common.copyFailed)).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("RBX1.secret".length);
  });
});

describe("stale edit", () => {
  const data = (name: string, revision: number): SettingsScreen => ({
    name,
    revision,
    settings: { offlineDays: 3, defaultQuotaGb: 10, power: { sleep: true, restart: true, shutDown: true }, adminExit: { enabled: true, hotkey: "Ctrl+Shift+F12" } },
    exitPin: { set: true },
  });
  const ui = () =>
    render(
      <ToastProvider>
        <MeContext.Provider value={owner}>
          <OrganizationTab />
        </MeContext.Provider>
      </ToastProvider>,
    );

  it("sends the loaded revision, shows 'Someone else changed this' and Reload keeps nothing", async () => {
    mock.settings = { status: "ready", data: data("Acme", 4) };
    mock.updateSettings.mockRejectedValueOnce(new AppError({ code: "stale_edit" }));
    const { rerender } = ui();
    const name = screen.getByLabelText("Organization name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "My edit" } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    expect(await screen.findByText(strings.common.staleTitle)).toBeTruthy();
    expect(mock.updateSettings.mock.calls[0]![0]).toMatchObject({ expectedRevision: 4, name: "My edit" });

    // Someone else's change arrives; Reload shows it and forgets the local edit.
    mock.settings = { status: "ready", data: data("Acme Ltd", 5) };
    rerender(
      <ToastProvider>
        <MeContext.Provider value={owner}>
          <OrganizationTab />
        </MeContext.Provider>
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: strings.common.reload }));
    expect((screen.getByLabelText("Organization name") as HTMLInputElement).value).toBe("Acme Ltd");
    expect(screen.queryByText(strings.common.staleTitle)).toBeNull();

    mock.updateSettings.mockResolvedValueOnce({ revision: 6, changed: ["offlineDays"] });
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(mock.updateSettings).toHaveBeenCalledTimes(2));
    expect(mock.updateSettings.mock.calls[1]![0]).toMatchObject({ expectedRevision: 5, name: "Acme Ltd" });
  });

  it("validates before sending and links the error to the field", async () => {
    mock.settings = { status: "ready", data: data("Acme", 1) };
    ui();
    const name = screen.getByLabelText("Organization name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    const error = await screen.findByText(strings.validate.required);
    expect(mock.updateSettings).not.toHaveBeenCalled();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toContain(error.closest("p")!.id);
  });
  it("is read-only for viewers (no save button)", () => {
    mock.settings = { status: "ready", data: data("Acme", 1) };
    render(
      <ToastProvider>
        <MeContext.Provider value={{ ...owner, role: "viewer" }}>
          <OrganizationTab />
        </MeContext.Provider>
      </ToastProvider>,
    );
    expect(screen.queryByRole("button", { name: strings.common.saveChanges })).toBeNull();
    // Inside a disabled <fieldset>: the input is disabled without its own attribute.
    expect((screen.getByLabelText("Organization name") as HTMLInputElement).matches(":disabled")).toBe(true);
  });
});
