import { act, fireEvent, render, screen } from "@testing-library/react";
import type { NoticeItem, NoticeTone, ShellState } from "@rulebox/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setShellStateForTests, EMPTY_SHELL_STATE } from "../../lib/store";
import { ToastHost } from "./ToastHost";

// jsdom runs no animation clock: a card "finishes" its exit at once.
const gsapMock = vi.hoisted(() => ({
  fromTo: vi.fn((el: unknown, from: unknown, to: unknown) => {
    void [el, from, to];
    return { kill: () => undefined };
  }),
  to: vi.fn((el: unknown, vars: { onComplete?: () => void }) => {
    void el;
    vars.onComplete?.();
    return { kill: () => undefined };
  }),
}));
vi.mock("gsap", () => ({ default: gsapMock }));

const signedIn: ShellState["session"] = {
  status: "signedIn",
  locked: false,
  employee: { id: "emp_maya", username: "maya", name: "Maya Chen", role: null, quotaBytes: 0 },
  filesRoot: "C:\\x",
  offline: false,
} as unknown as ShellState["session"];

let nextId = 1;
function notice(title: string, tone: NoticeTone = "neutral", detail: string | null = null): NoticeItem {
  return { id: nextId++, tone, title, detail, atMs: Date.now(), unread: true };
}

/** What the store holds now (it keeps the whole list, not just the newest). */
let shown: NoticeItem[] = [];

function show(notices: NoticeItem[], opts: { session?: ShellState["session"]; lite?: boolean } = {}) {
  shown = notices;
  act(() =>
    __setShellStateForTests({
      ...EMPTY_SHELL_STATE,
      session: opts.session ?? signedIn,
      display: { lite: opts.lite ?? false, theme: "light", reducedMotion: false },
      notices,
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  nextId = 1;
  gsapMock.fromTo.mockClear();
  gsapMock.to.mockClear();
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  }
});

afterEach(() => {
  act(() => __setShellStateForTests(EMPTY_SHELL_STATE));
  vi.useRealTimers();
});

const cards = () => document.querySelectorAll(".rb-toast__card");
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("toasts", () => {
  it("draws nothing until a notice arrives", () => {
    render(<ToastHost onLayout={() => undefined} />);
    expect(cards()).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
  });

  it("shows a new notice as a card, polite for news and an alert for a problem", () => {
    render(<ToastHost onLayout={() => undefined} />);
    show([notice("Saved a.txt", "success", "Batwa")]);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Saved a.txt");
    expect(status.textContent).toContain("Batwa");

    show([
      ...shown,
      notice("Files ending in .exe aren't allowed on this PC.", "warning"),
      notice("The download did not finish.", "danger"),
    ]);
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    // A problem is not told by colour alone.
    expect(screen.getAllByRole("alert")[0]?.textContent).toContain("Warning:");
    expect(screen.getAllByRole("alert")[1]?.textContent).toContain("Error:");
  });

  it("stays quiet on the sign-in and lock screens", () => {
    render(<ToastHost onLayout={() => undefined} />);
    show([notice("hi")], { session: { status: "signedOut", last: null } });
    expect(cards()).toHaveLength(0);
    show([...shown, notice("hi again")], { session: { ...signedIn, locked: true } as ShellState["session"] });
    expect(cards()).toHaveLength(0);
  });

  it("does not replay history: a notice from long ago is not a toast", () => {
    render(<ToastHost onLayout={() => undefined} />);
    show([{ ...notice("old news"), atMs: Date.now() - 60_000 }]);
    expect(cards()).toHaveLength(0);
  });

  it("shows at most three at once, newest at the bottom", () => {
    render(<ToastHost onLayout={() => undefined} />);
    show([notice("one"), notice("two"), notice("three"), notice("four")]);
    const titles = Array.from(cards()).map((card) => card.querySelector(".rb-toast__title")?.textContent);
    expect(titles).toEqual(["two", "three", "four"]);
  });

  it("goes away by itself after about six seconds", () => {
    render(<ToastHost onLayout={() => undefined} />);
    show([notice("Saved a.txt", "success")]);
    advance(5500);
    expect(cards()).toHaveLength(1);
    advance(1000);
    expect(cards()).toHaveLength(0);
  });

  it("waits while the pointer is on the cards, then counts the full time again", () => {
    render(<ToastHost onLayout={() => undefined} />);
    show([notice("Saved a.txt", "success")]);
    const region = screen.getByRole("region", { name: "Notifications" });
    advance(3000);
    fireEvent.pointerEnter(region);
    advance(30_000);
    expect(cards()).toHaveLength(1);
    fireEvent.pointerLeave(region);
    advance(2500);
    expect(cards()).toHaveLength(1);
    advance(1000);
    expect(cards()).toHaveLength(0);
  });

  it("waits while the keyboard focus is on a card's button", () => {
    render(<ToastHost onLayout={() => undefined} />);
    show([notice("Saved a.txt", "success")]);
    const close = screen.getByRole("button", { name: "Dismiss Saved a.txt" });
    fireEvent.focus(close);
    advance(20_000);
    expect(cards()).toHaveLength(1);
  });

  it("closes on a click, on the close button and on Esc (newest first)", () => {
    render(<ToastHost onLayout={() => undefined} />);
    show([notice("one"), notice("two"), notice("three")]);

    fireEvent.click(screen.getByText("one"));
    expect(Array.from(cards()).map((c) => c.textContent)).not.toContain("one");
    expect(cards()).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss two" }));
    expect(cards()).toHaveLength(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(cards()).toHaveLength(0);
  });

  it("tells the taskbar when the cards change, so the window clip follows", () => {
    const onLayout = vi.fn();
    render(<ToastHost onLayout={onLayout} />);
    const before = onLayout.mock.calls.length;
    show([notice("one")]);
    expect(onLayout.mock.calls.length).toBeGreaterThan(before);
    const afterOne = onLayout.mock.calls.length;
    advance(7000);
    expect(onLayout.mock.calls.length).toBeGreaterThan(afterOne);
  });

  it("slides in with a fade in full motion, and only fades in Lite mode", () => {
    render(<ToastHost onLayout={() => undefined} />);
    show([notice("one")]);
    const fullFrom = gsapMock.fromTo.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(fullFrom).toMatchObject({ x: 56, autoAlpha: 0 });
    // Nothing but transform and opacity.
    expect(Object.keys(fullFrom).sort()).toEqual(["autoAlpha", "x"]);

    gsapMock.fromTo.mockClear();
    show([...shown, notice("two")], { lite: true });
    const liteFrom = gsapMock.fromTo.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(liteFrom).toEqual({ autoAlpha: 0 });
  });
});
