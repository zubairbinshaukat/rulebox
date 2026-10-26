import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEntry, Employee, NoticeItem, ShellState, TaskItem } from "@rulebox/types";

import { __setShellStateForTests, EMPTY_SHELL_STATE } from "../lib/store";
import { call } from "../lib/tauri";
import { expectNoAxeViolations } from "../test/axe";
import { Desktop } from "./desktop/Desktop";
import { AccountMenu } from "./popup/AccountMenu";
import { PopupRoot } from "./popup/PopupRoot";
import { QuickSettings } from "./popup/QuickSettings";
import { StartMenu } from "./popup/StartMenu";
import { Switcher } from "./popup/Switcher";
import { LockScreen } from "./signin/LockScreen";
import { SignIn } from "./signin/SignIn";
import { StatusScreen } from "./boot/StatusScreen";
import { SystemArea } from "./taskbar/SystemArea";
import { Taskbar } from "./taskbar/Taskbar";

// ---- The backend is a stub: every command answers "nothing" unless a test says otherwise ----

vi.mock("../lib/tauri", () => ({
  call: vi.fn(async () => undefined),
  isTauri: () => true,
  anchorOf: () => null,
}));
vi.mock("../lib/events", () => ({ useTauriEvent: () => undefined }));
vi.mock("../lib/files", () => ({ openFile: vi.fn(async () => undefined) }));

// The popup window listens for show/hide events from the backend.
const popupEvents = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    popupEvents.set(name, handler);
    return () => popupEvents.delete(name);
  }),
}));

const mockedCall = vi.mocked(call);

beforeAll(() => {
  // jsdom has neither; the screens that measure themselves need something to observe with.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // jsdom has no layout: give the app grid a desktop-sized area to lay its tiles out in.
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

afterAll(() => {
  // Back to jsdom's own (zero) sizes, and no stub left for other files in this worker.
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
  vi.unstubAllGlobals();
});

// ---- Sample data -------------------------------------------------------------------------

const maya: Employee = { id: "e1", username: "maya", name: "Maya Chen", role: "Front desk", quotaBytes: 1000 };

function app(id: string, name: string, over: Partial<AppEntry> = {}): AppEntry {
  return {
    id,
    name,
    description: `${name} description`,
    kind: { type: "web", url: "https://example.test", allowedDomains: [], permissions: {} as never },
    iconKey: null,
    iconUrl: null,
    hue: null,
    pinnedTaskbar: false,
    pinnedDesktop: true,
    badge: null,
    ...over,
  };
}

function task(id: string, title: string, over: Partial<TaskItem> = {}): TaskItem {
  return {
    id,
    appId: null,
    title,
    iconKey: "k",
    active: false,
    minimized: false,
    flashing: false,
    hung: false,
    own: true,
    recency: 1,
    ...over,
  };
}

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
    session: { status: "signedIn", employee: maya, locked: false, offline: false },
    apps: { status: "ready", items: [app("mail", "Mail"), app("chat", "Team chat"), app("sheet", "Orders")] },
    system: {
      volume: { level: 0.4, muted: false },
      battery: { percent: 80, charging: false, minutesLeft: null },
      network: "internet",
      canPowerOff: true,
      canSleep: true,
      brightness: 60,
    },
    capabilities: ["session", "apps", "adminExit", "state", "health"],
    ...over,
  };
}

function setShell(state: ShellState) {
  act(() => __setShellStateForTests(state));
}

beforeEach(() => {
  mockedCall.mockReset();
  mockedCall.mockImplementation(async (cmd: string) => (cmd === "fs_files" || cmd === "fs_recent" ? [] : undefined));
  popupEvents.clear();
  document.title = "";
  setShell(shellState());
});

afterEach(() => {
  setShell(EMPTY_SHELL_STATE);
});

// ---- Sign-in and lock --------------------------------------------------------------------

describe("sign-in screen", () => {
  it("is a titled screen with a heading, labelled fields and no axe violations", async () => {
    const { container } = render(<SignIn shell={shellState({ session: { status: "signedOut", last: null } })} last={null} onSuccess={() => undefined} />);
    expect(document.title).toBe("Sign in - Rulebox");
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
    expect(screen.getByLabelText("Username")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    await expectNoAxeViolations(container);
  });

  it("names the returning employee as the heading and hides the duplicate avatar", async () => {
    const { container } = render(<SignIn shell={shellState()} last={{ username: "maya", name: "Maya Chen" }} onSuccess={() => undefined} />);
    expect(screen.getByRole("heading", { level: 1, name: "Maya Chen" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Maya Chen" })).toBeNull();
    expect(screen.getByRole("button", { name: /Not Maya\? Switch user/ })).toBeTruthy();
    await expectNoAxeViolations(container);
  });

  it("announces a wrong password and puts the focus back on the password field", async () => {
    const user = userEvent.setup();
    mockedCall.mockImplementation(async () => "wrongCredentials");
    render(<SignIn shell={shellState()} last={{ username: "maya", name: "Maya Chen" }} onSuccess={() => undefined} />);
    const password = screen.getByLabelText("Password");
    await user.type(password, "nope{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("That username or password is not right.");
    // The fields were disabled while the answer was awaited, which drops the focus.
    await waitFor(() => expect(document.activeElement).toBe(password));
  });

  it("reads a lockout as whole minutes, not as a countdown that changes every second", async () => {
    const user = userEvent.setup();
    mockedCall.mockImplementation(async () => ({ lockedOut: { retryAfterMs: 125_000 } }));
    render(<SignIn shell={shellState()} last={{ username: "maya", name: "Maya Chen" }} onSuccess={() => undefined} />);
    await user.type(screen.getByLabelText("Password"), "nope{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Too many tries\. Try again in 2:0\dabout 3 minutes\./);
    const hidden = alert.querySelector('[aria-hidden="true"]');
    expect(hidden?.textContent).toMatch(/^2:0\d$/);
    expect(alert.querySelector(".rb-sr-only")?.textContent).toBe("about 3 minutes");
  });
});

describe("lock screen", () => {
  it("is labelled, titled, and puts the focus back after a wrong password", async () => {
    const user = userEvent.setup();
    mockedCall.mockImplementation(async () => "wrongCredentials");
    const { container } = render(<LockScreen shell={shellState()} employee={maya} />);
    expect(document.title).toBe("Locked - Rulebox");
    expect(screen.getByRole("heading", { level: 1, name: "Maya Chen" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unlock" })).toBeTruthy();
    await expectNoAxeViolations(container);

    const password = screen.getByLabelText("Password");
    expect(document.activeElement).toBe(password);
    await user.type(password, "nope{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe("That password is not right.");
    await waitFor(() => expect(document.activeElement).toBe(password));
  });
});

describe("boot status screen", () => {
  it("says where the PC is in a status message", async () => {
    const { container } = render(<StatusScreen kind="applying" />);
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Getting this PC ready…");
    await expectNoAxeViolations(container);
  });
});

// ---- Desktop -----------------------------------------------------------------------------

describe("desktop", () => {
  it("is a main landmark with one heading, a list of apps and a labelled My files panel", async () => {
    const shell = shellState();
    const { container } = render(<Desktop shell={shell} employee={maya} />);
    expect(document.title).toBe("Rulebox desktop");
    expect(screen.getByRole("main", { name: "Desktop" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const list = screen.getByRole("list", { name: "Apps" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    const panel = screen.getByRole("complementary", { name: "My files" });
    const filters = within(panel).getByRole("group", { name: "Show" });
    expect(within(filters).getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(filters).getByRole("button", { name: "Docs" }).getAttribute("aria-pressed")).toBe("false");
    await expectNoAxeViolations(container);
  });

  it("is one tab stop for the tiles, and the arrow keys move between them", async () => {
    const user = userEvent.setup();
    render(<Desktop shell={shellState()} employee={maya} />);
    const tiles = within(screen.getByRole("list", { name: "Apps" })).getAllByRole("button");
    expect(tiles.map((tile) => tile.tabIndex)).toEqual([0, -1, -1]);

    await user.tab();
    expect(document.activeElement).toBe(tiles[0]);
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tiles[1]);
    // The tab stop followed the focus.
    expect(tiles.map((tile) => tile.tabIndex)).toEqual([-1, 0, -1]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(tiles[2]);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(tiles[0]);
    await user.keyboard("{Enter}");
    expect(mockedCall).toHaveBeenCalledWith("launch_app", { id: "mail" });
  });

  it("names a running app and its new count in words", () => {
    const shell = shellState({
      apps: { status: "ready", items: [app("mail", "Mail", { badge: 4 })] },
      tasks: [task("w1", "Inbox", { appId: "mail" })],
    });
    render(<Desktop shell={shell} employee={maya} />);
    const tile = within(screen.getByRole("list", { name: "Apps" })).getByRole("button");
    expect(tile.textContent).toContain("Mail, open");
    expect(tile.textContent).toContain(", 4 new");
  });

  it("announces a failed catalogue as an alert with a way to retry", () => {
    const shell = shellState({ apps: { status: "error", items: [] } });
    render(<Desktop shell={shell} employee={maya} />);
    const alert = screen.getByRole("alert");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

// ---- Taskbar -----------------------------------------------------------------------------

describe("taskbar", () => {
  function withTasks() {
    setShell(
      shellState({
        apps: {
          status: "ready",
          items: [app("mail", "Mail", { pinnedTaskbar: true }), app("chat", "Team chat", { pinnedTaskbar: true })],
        },
        tasks: [
          task("w1", "Inbox", { appId: "mail", active: true }),
          task("w2", "Notes", { minimized: true }),
        ],
        notices: [{ id: 1, tone: "neutral", title: "Hi", detail: null, atMs: 1, unread: true } satisfies NoticeItem],
      }),
    );
  }

  it("is a labelled toolbar of named buttons, with the active window pressed", async () => {
    withTasks();
    const { container } = render(<Taskbar />);
    expect(document.title).toBe("Rulebox taskbar");
    const bar = screen.getByRole("toolbar", { name: "Taskbar" });
    const names = within(bar).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "Start",
      "Mail — Inbox, open",
      "Team chat",
      "Notes, minimized",
      "Notices, 1 new",
      "Quick settings: connected, volume 40%, battery 80%",
      "Account, Maya Chen",
    ]);
    expect(within(bar).getByRole("button", { name: /^Mail/ }).getAttribute("aria-pressed")).toBe("true");
    expect(within(bar).getByRole("button", { name: /^Team chat/ }).getAttribute("aria-pressed")).toBe("false");
    // Nothing on the taskbar is only an icon: the avatar's initials are hidden, the name is on the button.
    expect(screen.queryByRole("img", { name: "Maya Chen" })).toBeNull();
    await expectNoAxeViolations(container);
  });

  it("walks the buttons with the arrow keys", async () => {
    withTasks();
    const user = userEvent.setup();
    render(<Taskbar />);
    const buttons = within(screen.getByRole("toolbar")).getAllByRole("button");
    buttons[0]!.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(buttons[1]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(buttons[0]);
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it("opens a popup from the keyboard, and says so", async () => {
    withTasks();
    const user = userEvent.setup();
    render(<Taskbar />);
    const start = screen.getByRole("button", { name: "Start" });
    expect(start.getAttribute("aria-haspopup")).toBe("dialog");
    start.focus();
    await user.keyboard("{Enter}");
    expect(mockedCall).toHaveBeenCalledWith("popup_open", { kind: "start", anchor: null });
  });

  it("describes the status chip in words (network, sound, battery, charging)", () => {
    setShell(
      shellState({
        system: {
          volume: { level: 0.4, muted: true },
          battery: { percent: 15, charging: true, minutesLeft: null },
          network: "none",
          canPowerOff: false,
          canSleep: false,
          brightness: null,
        },
      }),
    );
    render(<SystemArea />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      "Quick settings: offline, sound muted, battery 15%, charging",
    );
  });
});

// ---- Popups ------------------------------------------------------------------------------

async function showPopup(kind: string) {
  render(<PopupRoot />);
  await waitFor(() => expect(popupEvents.has("popup://show")).toBe(true));
  act(() => popupEvents.get("popup://show")!({ payload: { kind } }));
  // The popup moves the focus on the next frame.
  await act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
  });
}

describe("popup window", () => {
  it("opens the log-out question as an alert dialog with Cancel focused, and traps Tab", async () => {
    const user = userEvent.setup();
    mockedCall.mockImplementation(async (cmd: string) => (cmd === "closing_apps" ? ["Notes", "Mail"] : undefined));
    await showPopup("confirm");
    const dialog = screen.getByRole("alertdialog", { name: "Log out" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(await screen.findByText("Notes")).toBeTruthy();
    expect(document.title).toBe("Log out - Rulebox");

    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const logOut = within(dialog).getByRole("button", { name: "Log out" });
    expect(document.activeElement).toBe(cancel);
    await user.tab();
    expect(document.activeElement).toBe(logOut);
    await user.tab(); // out of the last control: round to the first, not out of the popup
    expect(document.activeElement).toBe(cancel);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(logOut);

    await user.keyboard("{Escape}");
    expect(mockedCall).toHaveBeenCalledWith("popup_close", {});
    await expectNoAxeViolations();
  });

  it("opens the account menu as a dialog with the first action focused", async () => {
    await showPopup("account");
    const dialog = screen.getByRole("dialog", { name: "Account" });
    expect(within(dialog).getByRole("heading", { level: 2, name: "Maya Chen" })).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Lock" }));
    await expectNoAxeViolations();
  });

  it("shows nothing (and no empty dialog) while no popup is showing", () => {
    render(<PopupRoot />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("hides the dialog again when the backend hides the popup", async () => {
    await showPopup("account");
    act(() => popupEvents.get("popup://hide")!({ payload: null }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("start menu", () => {
  function setup() {
    setShell(
      shellState({
        apps: { status: "ready", items: [app("mail", "Mail"), app("chat", "Team chat"), app("sheet", "Orders"), app("cal", "Calendar")] },
      }),
    );
    mockedCall.mockImplementation(async (cmd: string) => (cmd === "fs_recent" ? [] : undefined));
    return render(<StartMenu />);
  }

  it("is a search combobox that controls a listbox, with no axe violations", async () => {
    const { container } = setup();
    const search = screen.getByRole("combobox", { name: "Search apps" });
    const list = screen.getByRole("listbox", { name: "Apps" });
    expect(search.getAttribute("aria-controls")).toBe(list.id);
    expect(document.activeElement).toBe(search);
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(4);
    // The results are not extra tab stops: the focus stays in the search box.
    expect(options.every((option) => option.tabIndex === -1)).toBe(true);
    expect(search.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    await expectNoAxeViolations(container);
  });

  it("moves the highlight with the arrow keys (two columns) and opens it with Enter", async () => {
    const user = userEvent.setup();
    setup();
    const search = screen.getByRole("combobox");
    const options = screen.getAllByRole("option");
    await user.keyboard("{ArrowRight}");
    expect(search.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    await user.keyboard("{ArrowDown}");
    expect(search.getAttribute("aria-activedescendant")).toBe(options[3]!.id);
    await user.keyboard("{ArrowUp}");
    expect(search.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    await user.keyboard("{Home}");
    expect(search.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    await user.keyboard("{End}");
    expect(search.getAttribute("aria-activedescendant")).toBe(options[3]!.id);
    await user.keyboard("{Enter}");
    expect(mockedCall).toHaveBeenCalledWith("launch_app", { id: "cal" });
  });

  it("leaves Left and Right to the text cursor once something is typed, and says how many apps match", async () => {
    const user = userEvent.setup();
    setup();
    await user.keyboard("ca");
    const search = screen.getByRole("combobox") as HTMLInputElement;
    const first = screen.getAllByRole("option")[0]!;
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(search.selectionStart).toBe(0);
    expect(search.getAttribute("aria-activedescendant")).toBe(first.id);
    expect(screen.getAllByRole("status").some((s) => /apps? found/.test(s.textContent ?? ""))).toBe(true);
  });

  it("asks for the second click on Restart in words, and drops the question when the focus leaves", async () => {
    const user = userEvent.setup();
    setup();
    const restart = screen.getByRole("button", { name: "Restart" });
    await user.click(restart);
    expect(screen.getByRole("button", { name: "Click again to restart" })).toBeTruthy();
    expect(screen.getAllByRole("status").some((s) => s.textContent === "Click again to restart")).toBe(true);
    await user.tab();
    expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy();
    expect(mockedCall).not.toHaveBeenCalledWith("power_restart", {});
  });
});

describe("quick settings", () => {
  it("has named controls, states that are not colour alone, and notices with their tone in words", async () => {
    const user = userEvent.setup();
    setShell(
      shellState({
        notices: [
          { id: 1, tone: "danger", title: "Could not save", detail: "Disk full", atMs: 1, unread: false },
          { id: 2, tone: "neutral", title: "Welcome", detail: null, atMs: 2, unread: false },
        ],
      }),
    );
    const { container } = render(<QuickSettings />);
    expect(screen.getByRole("slider", { name: "Volume" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Brightness" })).toBeTruthy();
    // One name, with the state as `pressed` (the name does not flip between Mute and Unmute).
    const mute = screen.getByRole("button", { name: "Mute" });
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    const theme = screen.getByRole("group", { name: "Theme" });
    expect(within(theme).getByRole("button", { name: "Light" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("heading", { level: 2, name: "Notices" })).toBeTruthy();
    expect(screen.getByText("Could not save").parentElement?.textContent).toContain("Error: Could not save");
    expect(screen.getByRole("button", { name: "Dismiss Could not save" })).toBeTruthy();
    await expectNoAxeViolations(container);

    await user.click(within(theme).getByRole("button", { name: "Dark" }));
    expect(mockedCall).toHaveBeenCalledWith("set_theme", { theme: "dark" });
  });
});

describe("app switcher", () => {
  it("is a listbox that holds the focus, with the highlighted window as the active descendant", async () => {
    setShell(
      shellState({
        apps: { status: "ready", items: [app("mail", "Mail"), app("chat", "Team chat")] },
        tasks: [
          task("w1", "Inbox", { appId: "mail", active: true, recency: 3 }),
          task("w2", "Room 4", { appId: "chat", recency: 2 }),
          task("w3", "Notes", { minimized: true, recency: 1 }),
        ],
      }),
    );
    const user = userEvent.setup();
    const { container } = render(<Switcher />);
    const list = screen.getByRole("listbox", { name: "Open windows" });
    expect(document.activeElement).toBe(list);
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(3);
    // Like Alt+Tab, it starts on the window used before this one.
    expect(list.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");
    expect(options[2]!.textContent).toContain("Minimized");
    await expectNoAxeViolations(container);

    await user.keyboard("{Tab}");
    expect(list.getAttribute("aria-activedescendant")).toBe(options[2]!.id);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(list.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    await user.keyboard("{Enter}");
    expect(mockedCall).toHaveBeenCalledWith("task_click", { id: "w2" });
    expect(mockedCall).toHaveBeenCalledWith("popup_close", {});
  });

  it("says so when no window is open", () => {
    setShell(shellState({ tasks: [] }));
    render(<Switcher />);
    expect(screen.getByRole("status").textContent).toContain("No windows are open");
  });
});

describe("keyboard events do not leak", () => {
  it("Escape in a popup only closes the popup", async () => {
    await showPopup("account");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(mockedCall).toHaveBeenCalledWith("popup_close", {});
    // Nothing else (no sign-out, no lock) was asked for.
    expect(mockedCall).not.toHaveBeenCalledWith("lock", {});
    expect(mockedCall).not.toHaveBeenCalledWith("sign_out", {});
  });
});

// Keep the account menu's own file covered when it is shown without the popup frame.
describe("account menu without a signed-in employee", () => {
  it("says so", () => {
    setShell(shellState({ session: { status: "signedOut", last: null } }));
    render(<AccountMenu />);
    expect(screen.getByText("Nobody is signed in.")).toBeTruthy();
  });
});
