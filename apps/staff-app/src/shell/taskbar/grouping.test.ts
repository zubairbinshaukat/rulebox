import { describe, expect, it } from "vitest";
import type { AppEntry, TaskItem } from "@rulebox/types";

import { clickTarget, groupTaskbar, iconUrl, labelOf, stateOf } from "./grouping";

function app(id: string, pinnedTaskbar: boolean, name = id): AppEntry {
  return {
    id,
    name,
    description: null,
    kind: { type: "desktop" },
    iconKey: null,
    hue: null,
    pinnedTaskbar,
    pinnedDesktop: false,
    badge: null,
  };
}

function task(id: string, appId: string | null, extra: Partial<TaskItem> = {}): TaskItem {
  return {
    id,
    appId,
    title: `window ${id}`,
    iconKey: `hwnd:${id}:0`,
    active: false,
    minimized: false,
    flashing: false,
    hung: false,
    own: false,
    ...extra,
  };
}

describe("groupTaskbar", () => {
  it("lists pinned apps first, in catalogue order, even with no windows", () => {
    const buttons = groupTaskbar([app("b", true), app("a", false), app("c", true)], []);
    expect(buttons.map((b) => b.key)).toEqual(["app:b", "app:c"]);
    expect(buttons.every((b) => b.kind === "pinned" && b.tasks.length === 0)).toBe(true);
  });

  it("folds every window of a pinned app into its button", () => {
    const buttons = groupTaskbar(
      [app("notes", true)],
      [task("1", "notes"), task("2", "notes"), task("3", null)],
    );
    expect(buttons.map((b) => b.key)).toEqual(["app:notes", "win:3"]);
    const pinned = buttons[0];
    expect(pinned?.kind === "pinned" && pinned.tasks.map((t) => t.id)).toEqual(["1", "2"]);
  });

  it("gives an unpinned app's windows one button each, in window order", () => {
    const buttons = groupTaskbar(
      [app("calc", false)],
      [task("7", "calc"), task("5", "calc"), task("6", null)],
    );
    expect(buttons.map((b) => b.key)).toEqual(["win:7", "win:5", "win:6"]);
  });

  it("does not drop a window whose app id is not in the catalogue", () => {
    const buttons = groupTaskbar([], [task("9", "gone")]);
    expect(buttons.map((b) => b.key)).toEqual(["win:9"]);
  });
});

describe("stateOf", () => {
  it("is closed with no windows", () => {
    expect(stateOf([])).toEqual({
      open: false,
      active: false,
      minimized: false,
      flashing: false,
      hung: false,
      count: 0,
    });
  });

  it("is active when any window is, minimized only when all are", () => {
    const state = stateOf([
      task("1", "a", { minimized: true }),
      task("2", "a", { active: true }),
    ]);
    expect(state.active).toBe(true);
    expect(state.minimized).toBe(false);
    expect(state.count).toBe(2);
    expect(stateOf([task("1", "a", { minimized: true })]).minimized).toBe(true);
  });

  it("carries flashing and hung from any window", () => {
    const state = stateOf([task("1", "a"), task("2", "a", { flashing: true, hung: true })]);
    expect(state.flashing).toBe(true);
    expect(state.hung).toBe(true);
  });
});

describe("labelOf", () => {
  it("is just the name with no windows", () => {
    expect(labelOf("Notepad", [])).toBe("Notepad");
  });

  it("adds the title of a single window, unless it repeats the name", () => {
    expect(labelOf("Notepad", [task("1", "n", { title: "todo.txt" })])).toBe(
      "Notepad — todo.txt",
    );
    expect(labelOf("Calculator", [task("1", "c", { title: "Calculator" })])).toBe("Calculator");
  });

  it("counts several windows", () => {
    expect(labelOf("Notepad", [task("1", "n"), task("2", "n")])).toBe("Notepad (2 windows)");
  });

  it("says when an app is not responding", () => {
    expect(labelOf("Notepad", [task("1", "n", { title: "Notepad", hung: true })])).toBe(
      "Notepad — Not responding",
    );
  });
});

describe("iconUrl", () => {
  it("points at the icon protocol", () => {
    expect(iconUrl("hwnd:42:1")).toBe("http://rbicon.localhost/hwnd:42:1?s=48");
    expect(iconUrl("hwnd:42:1", 64)).toBe("http://rbicon.localhost/hwnd:42:1?s=64");
  });
});

describe("clickTarget", () => {
  it("is null for an app with no window (launch it)", () => {
    expect(clickTarget([])).toBeNull();
  });

  it("is the only window", () => {
    const only = task("1", "a");
    expect(clickTarget([only])).toBe(only);
  });

  it("moves on to the window after the active one, wrapping", () => {
    const windows = [task("1", "a"), task("2", "a", { active: true }), task("3", "a")];
    expect(clickTarget(windows)?.id).toBe("3");
    const last = [task("1", "a"), task("2", "a"), task("3", "a", { active: true })];
    expect(clickTarget(last)?.id).toBe("1");
  });

  it("starts at the first window when none is active", () => {
    expect(clickTarget([task("1", "a"), task("2", "a")])?.id).toBe("1");
  });
});
