import type { NoticeItem, NoticeTone } from "@rulebox/types";
import { describe, expect, it } from "vitest";

import {
  addNotices,
  dismiss,
  FRESH_MS,
  freshNotices,
  MAX_VISIBLE,
  newestVisible,
  remove,
  tick,
  TOAST_MS,
  type ToastEntry,
} from "./toastQueue";

function notice(id: number, title = `Notice ${id}`, tone: NoticeTone = "neutral", detail: string | null = null): NoticeItem {
  return { id, tone, title, detail, atMs: 1000, unread: true };
}

const visible = (list: ToastEntry[]) => list.filter((entry) => !entry.leaving).map((entry) => entry.id);

describe("toast queue", () => {
  it("shows a new notice for about six seconds", () => {
    const list = addNotices([], [notice(1)]);
    expect(list).toHaveLength(1);
    expect(list[0]?.remainingMs).toBe(TOAST_MS);
    expect(TOAST_MS).toBe(6000);
  });

  it("keeps at most three cards: a fourth pushes the oldest out", () => {
    const list = addNotices([], [notice(1), notice(2), notice(3), notice(4)]);
    expect(MAX_VISIBLE).toBe(3);
    expect(visible(list)).toEqual([2, 3, 4]);
    // The oldest is leaving, not cut off, so it can fade.
    expect(list.find((entry) => entry.id === 1)?.leaving).toBe(true);
  });

  it("counts cards that are already leaving as gone", () => {
    let list = addNotices([], [notice(1), notice(2), notice(3)]);
    list = dismiss(list, 1);
    list = addNotices(list, [notice(4)]);
    expect(visible(list)).toEqual([2, 3, 4]);
  });

  it("does not stack a copy of a card that says the same, it restarts its timer", () => {
    let list = addNotices([], [notice(1, "Saved a.txt", "success", "Batwa")]);
    list = tick(list, 4000);
    list = addNotices(list, [notice(2, "Saved a.txt", "success", "Batwa")]);
    expect(list).toHaveLength(1);
    expect(list[0]?.remainingMs).toBe(TOAST_MS);
    // A different detail is a different message.
    list = addNotices(list, [notice(3, "Saved a.txt", "success", "Zubyr")]);
    expect(list).toHaveLength(2);
  });

  it("counts down and retires a card when its time is up", () => {
    let list = addNotices([], [notice(1)]);
    list = tick(list, 5900);
    expect(visible(list)).toEqual([1]);
    list = tick(list, 200);
    expect(visible(list)).toEqual([]);
    expect(list[0]?.leaving).toBe(true);
    expect(list[0]?.remainingMs).toBe(0);
  });

  it("does not spend time on a card that is already leaving", () => {
    const list = dismiss(addNotices([], [notice(1)]), 1);
    expect(tick(list, 1000)).toBe(list);
  });

  it("Esc closes the newest card", () => {
    let list = addNotices([], [notice(1), notice(2)]);
    expect(newestVisible(list)?.id).toBe(2);
    list = dismiss(list, 2);
    expect(newestVisible(list)?.id).toBe(1);
    list = dismiss(list, 1);
    expect(newestVisible(list)).toBeUndefined();
  });

  it("removes a card once it has faded", () => {
    const list = remove(addNotices([], [notice(1), notice(2)]), 1);
    expect(list.map((entry) => entry.id)).toEqual([2]);
  });

  it("only turns notices that are new and recent into cards", () => {
    const now = 100_000;
    const list = [
      { ...notice(1), atMs: now - 1000 },
      { ...notice(2), atMs: now - 500 },
      { ...notice(3), atMs: now - FRESH_MS - 1 },
    ];
    expect(freshNotices(list, 1, now).map((n) => n.id)).toEqual([2]);
    expect(freshNotices(list, 0, now).map((n) => n.id)).toEqual([1, 2]);
    expect(freshNotices(list, 3, now)).toEqual([]);
  });
});
