import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { BroadcastRow, QueryState } from "../../data/types";

// "On your PCs now" (UI pass, other-pages.md 5.2) against a mocked `useLiveBroadcasts`: the screen's own clock hides what ended, Cancel is
// given to admins only, an empty strip says so in one line.
const hook = vi.hoisted(() => ({ state: { status: "loading" } as unknown as QueryState<BroadcastRow[]>, retry: vi.fn() }));

vi.mock("../../data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../data")>()),
  useLiveBroadcasts: () => hook.state,
}));

import { LiveNow } from "./LiveNow";
import { broadcastStrings as s } from "./strings";
import { endsLabel, LIVE_MAX, stillLive } from "./model";

const HOUR = 3_600_000;
const NOW = new Date(2026, 10, 28, 12, 0, 0).getTime();
const row = (over: Partial<BroadcastRow> = {}): BroadcastRow => ({
  _id: "b1",
  target: { kind: "group", id: "g1", name: "Front desk" },
  style: "banner",
  title: "Till update tonight",
  body: "The tills restart at 18:30.",
  expiresAt: NOW + 5 * HOUR,
  ackRequired: false,
  createdAt: NOW - HOUR,
  cancelledAt: null,
  targetCount: 4,
  ackCount: 0,
  ...over,
});
const ready = (rows: BroadcastRow[]) => {
  hook.state = { status: "ready", data: rows };
};

beforeEach(() => {
  hook.state = { status: "loading" } as unknown as QueryState<BroadcastRow[]>;
  hook.retry.mockReset();
});
afterEach(cleanup);

describe("stillLive and endsLabel", () => {
  it("drops what ended by the screen's clock and anything cancelled, keeps the server's order, caps at 20", () => {
    const rows = [row({ _id: "a" }), row({ _id: "b", expiresAt: NOW - 1 }), row({ _id: "c", expiresAt: null }), row({ _id: "d", cancelledAt: NOW - 5 }), row({ _id: "e", expiresAt: NOW })];
    expect(stillLive(rows, NOW).map((b) => b._id)).toEqual(["a", "c"]);
    const many = Array.from({ length: 30 }, (_, i) => row({ _id: `m${i}`, expiresAt: null }));
    expect(stillLive(many, NOW)).toHaveLength(LIVE_MAX);
  });

  it("says a time today, a weekday and time this week, and a date later", () => {
    expect(endsLabel(NOW + 5 * HOUR, NOW)).toMatch(/^\d{1,2}[:.]\d{2}/);
    const tomorrow = endsLabel(NOW + 26 * HOUR, NOW);
    const nextMonth = endsLabel(NOW + 40 * 24 * HOUR, NOW);
    expect(tomorrow).not.toBe(endsLabel(NOW + 5 * HOUR, NOW));
    expect(nextMonth.length).toBeGreaterThan(tomorrow.length - 4);
  });
});

describe("On your PCs now", () => {
  it("says in one calm line that nothing is showing", () => {
    ready([]);
    render(<LiveNow now={NOW} />);
    expect(screen.getByText(s.liveTitle)).toBeTruthy();
    expect(screen.getByText(s.liveEmpty)).toBeTruthy();
  });

  it("shows nothing at all when told to hide an empty strip", () => {
    ready([]);
    const { container } = render(<LiveNow now={NOW} hideIfNone />);
    expect(container.firstChild).toBeNull();
  });

  it("hides the messages that ended by the clock and shows the rest with who, until when and how many saw it", () => {
    ready([
      row({ _id: "a", title: "Privacy rules", ackRequired: true, ackCount: 14, targetCount: 20, style: "fullscreen", expiresAt: null }),
      row({ _id: "b", title: "Ended a minute ago", expiresAt: NOW - 60_000 }),
      row({ _id: "c", title: "Fire drill", target: { kind: "device", id: "d1", name: "Desk 1" }, targetCount: 1 }),
    ]);
    render(<LiveNow now={NOW} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(screen.queryByText("Ended a minute ago")).toBeNull();
    expect(within(items[0]!).getByText("Privacy rules")).toBeTruthy();
    expect(within(items[0]!).getByText(new RegExp(`${s.liveNoEnd} · ${s.liveSeen(14, 20)}`))).toBeTruthy();
    expect(within(items[1]!).getByText("Desk 1")).toBeTruthy();
    expect(within(items[1]!).getByText(new RegExp(s.liveReach(1)))).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("gives Cancel to admins only, one per message, naming the message", () => {
    ready([row({ _id: "a", title: "One" }), row({ _id: "b", title: "Two" })]);
    const onCancel = vi.fn();
    const { unmount } = render(<LiveNow now={NOW} onCancel={onCancel} />);
    expect(screen.getAllByRole("button", { name: /^Cancel:/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: `${s.liveCancel}: Two` }));
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ _id: "b" }));
    unmount();
    render(<LiveNow now={NOW} />);
    expect(screen.queryByRole("button", { name: /^Cancel:/ })).toBeNull();
  });

  it("starts with six cards and offers Show all for the rest", () => {
    ready(Array.from({ length: 9 }, (_, i) => row({ _id: `m${i}`, title: `Message ${i}` })));
    render(<LiveNow now={NOW} />);
    const more = screen.getByRole("button", { name: s.liveShowAll(9) });
    expect(screen.getByRole("list").getAttribute("data-collapsed")).toBe("true");
    fireEvent.click(more);
    expect(screen.getByRole("list").getAttribute("data-collapsed")).toBeNull();
    expect(screen.getByRole("button", { name: s.liveShowFewer }).getAttribute("aria-expanded")).toBe("true");
  });

  it("says in a line that it could not load, with Try again", () => {
    hook.state = { status: "error", error: new Error("x"), retry: hook.retry };
    render(<LiveNow now={NOW} />);
    expect(screen.getByText(s.liveFailed)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: s.liveRetry }));
    expect(hook.retry).toHaveBeenCalledTimes(1);
  });
});
