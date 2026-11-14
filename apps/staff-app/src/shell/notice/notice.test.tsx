import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BroadcastDto, DeviceLockDto, ShellState } from "@rulebox/types";

import { __setShellStateForTests, EMPTY_SHELL_STATE } from "../../lib/store";
import { call } from "../../lib/tauri";
import { DesktopRoot } from "../DesktopRoot";
import { BroadcastBanner } from "./BroadcastBanner";
import { BroadcastFullscreen } from "./BroadcastFullscreen";
import { CoverRoot } from "./CoverRoot";
import { DeviceLock } from "./DeviceLock";

// jsdom runs no animation clock: the tweens are spies, so "cleaned up" can be asserted.
const gsapMock = vi.hoisted(() => {
  const kill = vi.fn();
  return {
    kill,
    fromTo: vi.fn((el: unknown, from: unknown, to: unknown) => {
      void [el, from, to];
      return { kill };
    }),
    to: vi.fn(() => ({ kill })),
  };
});
vi.mock("gsap", () => ({ default: gsapMock }));

vi.mock("../../lib/tauri", () => ({
  call: vi.fn(async () => undefined),
  isTauri: () => false,
  anchorOf: () => null,
}));
vi.mock("../../lib/events", () => ({ useTauriEvent: () => undefined }));
vi.mock("../../lib/files", () => ({ openFile: vi.fn(async () => undefined) }));

const mockedCall = vi.mocked(call);

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1200 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  }
});

beforeEach(() => {
  mockedCall.mockClear();
  gsapMock.kill.mockClear();
  gsapMock.fromTo.mockClear();
});

afterEach(() => {
  cleanup();
  act(() => __setShellStateForTests(EMPTY_SHELL_STATE));
});

const EVIL_TITLE = `<img src=x onerror="alert(1)"> & <b>Title</b>`;
const EVIL_BODY = `<script>window.hacked = true</script> a < b && c > d\n<a href="https://evil.test">click</a>`;

function broadcast(over: Partial<BroadcastDto> = {}): BroadcastDto {
  return {
    id: "b1",
    style: "banner",
    title: "Water off",
    body: "Back at noon",
    ackRequired: false,
    acknowledged: false,
    ...over,
  };
}

const LOCK: DeviceLockDto = { lockId: "l1", message: "Back in an hour", contact: "front desk" };

const maya = { id: "e1", username: "maya", name: "Maya Chen", role: null, quotaBytes: 0 };

function shellState(over: Partial<ShellState> = {}): ShellState {
  return {
    ...EMPTY_SHELL_STATE,
    link: "linked",
    agent: {
      enrollment: "enrolled",
      connection: "online",
      kioskPhase: "applied",
      clockSuspect: false,
      orgName: "Demo Org",
    },
    display: { lite: false, theme: "light", reducedMotion: false },
    session: {
      status: "signedIn",
      locked: false,
      employee: maya,
      filesRoot: "C:\\x",
      offline: false,
    } as unknown as ShellState["session"],
    apps: { status: "idle", items: [] },
    capabilities: ["session", "apps", "adminExit", "state", "health", "lockdown"],
    ...over,
  };
}

describe("broadcast text is plain text", () => {
  it("the banner shows HTML characters literally and creates no elements from them", () => {
    const { container } = render(
      <BroadcastBanner broadcasts={[broadcast({ title: EVIL_TITLE, body: EVIL_BODY })]} />,
    );
    expect(screen.getByTestId("broadcast-title").textContent).toBe(EVIL_TITLE);
    expect(screen.getByTestId("broadcast-body").textContent).toBe(EVIL_BODY);
    expect(container.querySelector("img, script, b, a")).toBeNull();
    expect((window as unknown as { hacked?: boolean }).hacked).toBeUndefined();
  });

  it("the full-screen notice shows HTML characters literally", () => {
    const { container } = render(
      <BroadcastFullscreen
        broadcast={broadcast({ style: "fullscreen", ackRequired: true, title: EVIL_TITLE, body: EVIL_BODY })}
        orgName="<i>Org</i>"
      />,
    );
    expect(screen.getByTestId("broadcast-title").textContent).toBe(EVIL_TITLE);
    expect(screen.getByTestId("broadcast-body").textContent).toBe(EVIL_BODY);
    expect(screen.getByText("<i>Org</i>")).toBeTruthy();
    expect(container.querySelector("img, script, b, a, i")).toBeNull();
  });

  it("the lock view shows the message and the contact literally", () => {
    const { container } = render(
      <DeviceLock lock={{ lockId: "l", message: EVIL_BODY, contact: "<b>boss</b>" }} orgName={null} />,
    );
    expect(screen.getByTestId("device-lock-message").textContent).toBe(EVIL_BODY);
    expect(screen.getByTestId("device-lock-contact").textContent).toBe("Contact: <b>boss</b>");
    expect(container.querySelector("img, script, b > b, a")).toBeNull();
  });
});

describe("broadcast banner behaviour", () => {
  it("a banner that needs no acknowledgement can be closed, and closing hides it", () => {
    render(<BroadcastBanner broadcasts={[broadcast()]} />);
    expect(screen.queryByRole("button", { name: "OK" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Close Water off/ }));
    expect(screen.queryByTestId("broadcast-banner")).toBeNull();
    expect(mockedCall).not.toHaveBeenCalled();
  });

  it("a banner that needs an acknowledgement has OK only, and OK sends broadcast_ack", async () => {
    render(<BroadcastBanner broadcasts={[broadcast({ ackRequired: true })]} />);
    expect(screen.queryByRole("button", { name: /Close/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(mockedCall).toHaveBeenCalledWith("broadcast_ack", { id: "b1" }));
  });

  it("shows nothing for an acknowledged broadcast or a full-screen one", () => {
    render(
      <BroadcastBanner
        broadcasts={[broadcast({ acknowledged: true }), broadcast({ id: "f", style: "fullscreen" })]}
      />,
    );
    expect(screen.queryByTestId("broadcast-banner")).toBeNull();
  });

  it("says so when OK could not be sent", async () => {
    mockedCall.mockRejectedValueOnce(new Error("pipe closed"));
    render(<BroadcastBanner broadcasts={[broadcast({ ackRequired: true })]} />);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("the banner sits at the top of the desktop, before the greeting", async () => {
    act(() =>
      __setShellStateForTests(shellState({ broadcasts: [broadcast()] })),
    );
    render(<DesktopRoot />);
    const banner = await screen.findByTestId("broadcast-banner");
    const desktop = screen.getByTestId("desktop");
    expect(desktop.contains(banner)).toBe(true);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(banner.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("motion cleanup", () => {
  it("the lock view, the banner and the full-screen notice kill their tween on unmount", () => {
    const lock = render(<DeviceLock lock={LOCK} orgName="Org" />);
    expect(gsapMock.fromTo).toHaveBeenCalledTimes(1);
    lock.unmount();
    expect(gsapMock.kill).toHaveBeenCalledTimes(1);

    const banner = render(<BroadcastBanner broadcasts={[broadcast()]} />);
    expect(gsapMock.fromTo).toHaveBeenCalledTimes(2);
    banner.unmount();
    expect(gsapMock.kill).toHaveBeenCalledTimes(2);

    const full = render(
      <BroadcastFullscreen broadcast={broadcast({ style: "fullscreen", ackRequired: true })} orgName={null} />,
    );
    expect(gsapMock.fromTo).toHaveBeenCalledTimes(3);
    full.unmount();
    expect(gsapMock.kill).toHaveBeenCalledTimes(3);
  });

  it("animates opacity and transform only, and only opacity in Lite mode", () => {
    act(() => __setShellStateForTests(shellState({ display: { lite: true, theme: "light", reducedMotion: false } })));
    render(<DeviceLock lock={LOCK} orgName="Org" />);
    const [, from, to] = gsapMock.fromTo.mock.calls[0] as unknown as [unknown, Record<string, unknown>, Record<string, unknown>];
    const allowed = new Set(["autoAlpha", "opacity", "x", "y", "scale", "duration", "ease"]);
    for (const key of [...Object.keys(from), ...Object.keys(to)]) {
      expect(allowed.has(key)).toBe(true);
    }
    expect(Object.keys(from)).toEqual(["autoAlpha"]);
  });
});

describe("DesktopRoot and the lock view", () => {
  it("shows the lock view with no sign-in field while a lock is set", async () => {
    act(() => __setShellStateForTests(shellState({ session: { status: "signedOut", last: null }, deviceLock: LOCK })));
    render(<DesktopRoot />);
    expect(await screen.findByTestId("device-lock")).toBeTruthy();
    expect(screen.getByTestId("device-lock-org").textContent).toBe("Demo Org");
    expect(screen.getByTestId("device-lock-message").textContent).toBe("Back in an hour");
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("the lock comes before the boot status (agent link down) and before a signed-in desktop", async () => {
    act(() => __setShellStateForTests(shellState({ link: "connecting", deviceLock: LOCK })));
    const first = render(<DesktopRoot />);
    expect(await screen.findByTestId("device-lock")).toBeTruthy();
    first.unmount();

    act(() => __setShellStateForTests(shellState({ deviceLock: LOCK })));
    render(<DesktopRoot />);
    expect(await screen.findByTestId("device-lock")).toBeTruthy();
    expect(screen.queryByTestId("desktop")).toBeNull();
  });

  it("the lock view goes away when the snapshot no longer has a lock", async () => {
    act(() => __setShellStateForTests(shellState({ session: { status: "signedOut", last: null }, deviceLock: LOCK })));
    render(<DesktopRoot />);
    expect(await screen.findByTestId("device-lock")).toBeTruthy();
    act(() => __setShellStateForTests(shellState({ session: { status: "signedOut", last: null } })));
    await waitFor(() => expect(screen.queryByTestId("device-lock")).toBeNull());
  });

  it("an agent that speaks protocol 1.2 (no lock, no broadcasts) gets no lock view and no errors", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const state = shellState({ capabilities: ["session", "apps", "adminExit", "state", "health"] });
    // A 1.2 agent never sets these fields.
    delete (state as { deviceLock?: DeviceLockDto }).deviceLock;
    state.broadcasts = [];
    act(() => __setShellStateForTests(state));
    render(<DesktopRoot />);
    expect(await screen.findByTestId("desktop")).toBeTruthy();
    expect(screen.queryByTestId("device-lock")).toBeNull();
    expect(screen.queryByTestId("broadcast-banner")).toBeNull();
    expect(screen.queryByTestId("broadcast-fullscreen")).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("an unacknowledged full-screen notice covers the desktop until OK", async () => {
    act(() =>
      __setShellStateForTests(
        shellState({ broadcasts: [broadcast({ id: "big", style: "fullscreen", ackRequired: true })] }),
      ),
    );
    render(<DesktopRoot />);
    expect(await screen.findByTestId("broadcast-fullscreen")).toBeTruthy();
    expect(screen.queryByTestId("desktop")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(mockedCall).toHaveBeenCalledWith("broadcast_ack", { id: "big" }));
    act(() =>
      __setShellStateForTests(
        shellState({ broadcasts: [broadcast({ id: "big", style: "fullscreen", ackRequired: true, acknowledged: true })] }),
      ),
    );
    expect(await screen.findByTestId("desktop")).toBeTruthy();
  });
});

describe("CoverRoot", () => {
  it("shows the lock, and the lock wins over a full-screen notice", () => {
    act(() =>
      __setShellStateForTests(
        shellState({ deviceLock: LOCK, broadcasts: [broadcast({ style: "fullscreen", ackRequired: true })] }),
      ),
    );
    render(<CoverRoot />);
    expect(screen.getByTestId("device-lock")).toBeTruthy();
    expect(screen.queryByTestId("broadcast-fullscreen")).toBeNull();
  });

  it("shows the full-screen notice when there is no lock, and a plain surface when nothing is wanted", () => {
    act(() =>
      __setShellStateForTests(shellState({ broadcasts: [broadcast({ style: "fullscreen", ackRequired: true })] })),
    );
    const first = render(<CoverRoot />);
    expect(screen.getByTestId("broadcast-fullscreen")).toBeTruthy();
    first.unmount();

    act(() => __setShellStateForTests(shellState()));
    render(<CoverRoot />);
    expect(screen.getByTestId("cover-empty")).toBeTruthy();
  });
});
