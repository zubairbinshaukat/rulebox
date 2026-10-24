import { describe, expect, it } from "vitest";

import {
  canGoBack,
  canGoForward,
  currentOf,
  goBack,
  goForward,
  joinPath,
  newHistory,
  nextIndex,
  parentOf,
  pushHistory,
  uniqueName,
  type NavContext,
} from "./navigation";

const list = (over: Partial<NavContext> = {}): NavContext => ({
  count: 10,
  index: 4,
  view: "list",
  columns: 1,
  pageSize: 3,
  ...over,
});
const grid = (over: Partial<NavContext> = {}): NavContext => ({
  count: 10,
  index: 4,
  view: "grid",
  columns: 4,
  pageSize: 8,
  ...over,
});

describe("keyboard navigation in the list", () => {
  it("moves one row with Up and Down and stops at the ends", () => {
    expect(nextIndex("down", list())).toBe(5);
    expect(nextIndex("up", list())).toBe(3);
    expect(nextIndex("up", list({ index: 0 }))).toBe(0);
    expect(nextIndex("down", list({ index: 9 }))).toBe(9);
  });

  it("ignores Left and Right", () => {
    expect(nextIndex("left", list())).toBe(4);
    expect(nextIndex("right", list())).toBe(4);
  });

  it("jumps with Home, End, Page Up and Page Down", () => {
    expect(nextIndex("home", list())).toBe(0);
    expect(nextIndex("end", list())).toBe(9);
    expect(nextIndex("pageDown", list())).toBe(7);
    expect(nextIndex("pageUp", list())).toBe(1);
    expect(nextIndex("pageDown", list({ index: 8 }))).toBe(9);
    expect(nextIndex("pageUp", list({ index: 1 }))).toBe(0);
  });

  it("lands on the first item when nothing is focused, and nowhere when empty", () => {
    expect(nextIndex("down", list({ index: -1 }))).toBe(0);
    expect(nextIndex("up", list({ index: -1 }))).toBe(0);
    expect(nextIndex("pageDown", list({ index: -1 }))).toBe(0);
    expect(nextIndex("end", list({ index: -1 }))).toBe(9);
    expect(nextIndex("down", list({ count: 0, index: -1 }))).toBe(-1);
    expect(nextIndex("home", list({ count: 0, index: -1 }))).toBe(-1);
  });
});

describe("keyboard navigation in the grid", () => {
  it("moves one item with Left and Right, one row with Up and Down", () => {
    expect(nextIndex("right", grid())).toBe(5);
    expect(nextIndex("left", grid())).toBe(3);
    expect(nextIndex("down", grid())).toBe(8);
    expect(nextIndex("up", grid())).toBe(0);
  });

  it("stays inside the grid at the edges", () => {
    expect(nextIndex("left", grid({ index: 0 }))).toBe(0);
    expect(nextIndex("right", grid({ index: 9 }))).toBe(9);
    expect(nextIndex("up", grid({ index: 2 }))).toBe(0);
  });

  it("goes to the last item when the row below is a short one", () => {
    // 10 items, 4 columns: rows are 0-3, 4-7, 8-9. From index 7 (row 1) down is 11: short row, so 9.
    expect(nextIndex("down", grid({ index: 7 }))).toBe(9);
    // Already in the last row: stays.
    expect(nextIndex("down", grid({ index: 8 }))).toBe(8);
  });

  it("pages by the number of items a page holds", () => {
    expect(nextIndex("pageDown", grid({ index: 0 }))).toBe(8);
    expect(nextIndex("pageUp", grid({ index: 9 }))).toBe(1);
  });
});

describe("folder history", () => {
  it("goes back and forward and drops the forward part when visiting somewhere new", () => {
    let h = newHistory("");
    h = pushHistory(h, "Documents");
    h = pushHistory(h, "Documents/Taxes");
    expect(currentOf(h)).toBe("Documents/Taxes");
    expect(canGoBack(h)).toBe(true);
    expect(canGoForward(h)).toBe(false);

    h = goBack(h);
    expect(currentOf(h)).toBe("Documents");
    expect(canGoForward(h)).toBe(true);
    h = goForward(h);
    expect(currentOf(h)).toBe("Documents/Taxes");

    h = goBack(goBack(h));
    expect(currentOf(h)).toBe("");
    expect(goBack(h)).toBe(h);
    h = pushHistory(h, "Pictures");
    expect(h.stack).toEqual(["", "Pictures"]);
    expect(canGoForward(h)).toBe(false);
  });

  it("does not record the same place twice in a row", () => {
    const h = newHistory("a");
    expect(pushHistory(h, "a")).toBe(h);
  });
});

describe("paths and names", () => {
  it("finds the parent folder", () => {
    expect(parentOf("a/b/c")).toBe("a/b");
    expect(parentOf("a")).toBe("");
    expect(parentOf("")).toBe("");
  });

  it("joins a folder and a name", () => {
    expect(joinPath("", "x.txt")).toBe("x.txt");
    expect(joinPath("a/b", "x.txt")).toBe("a/b/x.txt");
  });

  it("numbers a taken folder name the way Windows does", () => {
    expect(uniqueName("New folder", [])).toBe("New folder");
    expect(uniqueName("New folder", ["New folder"])).toBe("New folder (2)");
    expect(uniqueName("New folder", ["new FOLDER", "New folder (2)"])).toBe("New folder (3)");
  });
});

describe("responsive layout", () => {
  it("keeps the name readable and drops Type, then Size, then the date", async () => {
    const { toolbarModeFor, visibleColumns } = await import("./layout");
    expect([...visibleColumns(900)].sort()).toEqual(["modified", "name", "size", "type"]);
    expect(visibleColumns(420).has("type")).toBe(false);
    expect(visibleColumns(420).has("modified")).toBe(true);
    expect([...visibleColumns(250)]).toEqual(["name"]);
    expect(toolbarModeFor(1000)).toBe("wide");
    expect(toolbarModeFor(600)).toBe("stacked");
    expect(toolbarModeFor(400)).toBe("narrow");
  });
});
