import { describe, expect, it } from "vitest";
import {
  INITIAL_SELECTION,
  selectionReducer,
  type SelectionState,
} from "./useSelection";

describe("selectionReducer (15 cases)", () => {
  const allItems = ["file1.txt", "file2.pdf", "file3.png", "file4.docx", "file5.csv"];

  it("case 1: initial state is empty", () => {
    expect(INITIAL_SELECTION).toEqual({
      selected: [],
      focused: null,
      anchor: null,
    });
  });

  it("case 2: SELECT_SINGLE clears previous selection and sets focus and anchor", () => {
    const prev: SelectionState = {
      selected: ["file1.txt", "file2.pdf"],
      focused: "file2.pdf",
      anchor: "file1.txt",
    };
    const next = selectionReducer(prev, { type: "SELECT_SINGLE", path: "file3.png" });
    expect(next.selected).toEqual(["file3.png"]);
    expect(next.focused).toBe("file3.png");
    expect(next.anchor).toBe("file3.png");
  });

  it("case 3: TOGGLE unselected item adds it to selection and updates focus and anchor", () => {
    const prev: SelectionState = {
      selected: ["file1.txt"],
      focused: "file1.txt",
      anchor: "file1.txt",
    };
    const next = selectionReducer(prev, { type: "TOGGLE", path: "file3.png" });
    expect(next.selected).toEqual(["file1.txt", "file3.png"]);
    expect(next.focused).toBe("file3.png");
    expect(next.anchor).toBe("file3.png");
  });

  it("case 4: TOGGLE selected item removes it from selection while preserving other items", () => {
    const prev: SelectionState = {
      selected: ["file1.txt", "file3.png"],
      focused: "file3.png",
      anchor: "file3.png",
    };
    const next = selectionReducer(prev, { type: "TOGGLE", path: "file1.txt" });
    expect(next.selected).toEqual(["file3.png"]);
    expect(next.focused).toBe("file1.txt");
  });

  it("case 5: TOGGLE single remaining item empties selection", () => {
    const prev: SelectionState = {
      selected: ["file1.txt"],
      focused: "file1.txt",
      anchor: "file1.txt",
    };
    const next = selectionReducer(prev, { type: "TOGGLE", path: "file1.txt" });
    expect(next.selected).toEqual([]);
    expect(next.focused).toBe("file1.txt");
  });

  it("case 6: SELECT_RANGE forward from anchor selects all items between anchor and target", () => {
    const prev: SelectionState = {
      selected: ["file2.pdf"],
      focused: "file2.pdf",
      anchor: "file2.pdf",
    };
    const next = selectionReducer(prev, {
      type: "SELECT_RANGE",
      targetPath: "file4.docx",
      allPaths: allItems,
    });
    expect(next.selected).toEqual(["file2.pdf", "file3.png", "file4.docx"]);
    expect(next.focused).toBe("file4.docx");
    expect(next.anchor).toBe("file2.pdf");
  });

  it("case 7: SELECT_RANGE backward from anchor selects all items backwards", () => {
    const prev: SelectionState = {
      selected: ["file4.docx"],
      focused: "file4.docx",
      anchor: "file4.docx",
    };
    const next = selectionReducer(prev, {
      type: "SELECT_RANGE",
      targetPath: "file2.pdf",
      allPaths: allItems,
    });
    expect(next.selected).toEqual(["file2.pdf", "file3.png", "file4.docx"]);
    expect(next.focused).toBe("file2.pdf");
    expect(next.anchor).toBe("file4.docx");
  });

  it("case 8: SELECT_RANGE with null anchor defaults to target", () => {
    const prev: SelectionState = {
      selected: [],
      focused: null,
      anchor: null,
    };
    const next = selectionReducer(prev, {
      type: "SELECT_RANGE",
      targetPath: "file3.png",
      allPaths: allItems,
    });
    expect(next.selected).toEqual(["file3.png"]);
    expect(next.focused).toBe("file3.png");
    expect(next.anchor).toBe("file3.png");
  });

  it("case 9: SELECT_RANGE when target is not in allPaths returns unchanged state", () => {
    const prev: SelectionState = {
      selected: ["file1.txt"],
      focused: "file1.txt",
      anchor: "file1.txt",
    };
    const next = selectionReducer(prev, {
      type: "SELECT_RANGE",
      targetPath: "nonexistent.txt",
      allPaths: allItems,
    });
    expect(next).toEqual(prev);
  });

  it("case 10: SELECT_ALL selects all items in list", () => {
    const prev: SelectionState = {
      selected: ["file1.txt"],
      focused: "file1.txt",
      anchor: "file1.txt",
    };
    const next = selectionReducer(prev, {
      type: "SELECT_ALL",
      allPaths: allItems,
    });
    expect(next.selected).toEqual(allItems);
    expect(next.focused).toBe("file1.txt");
    expect(next.anchor).toBe("file1.txt");
  });

  it("case 11: CLEAR resets selection, focus and anchor", () => {
    const prev: SelectionState = {
      selected: ["file1.txt", "file2.pdf"],
      focused: "file2.pdf",
      anchor: "file1.txt",
    };
    const next = selectionReducer(prev, { type: "CLEAR" });
    expect(next.selected).toEqual([]);
    expect(next.focused).toBeNull();
    expect(next.anchor).toBeNull();
  });

  it("case 12: MOVE_FOCUS selects new item and moves focus and anchor", () => {
    const prev: SelectionState = {
      selected: ["file1.txt"],
      focused: "file1.txt",
      anchor: "file1.txt",
    };
    const next = selectionReducer(prev, { type: "MOVE_FOCUS", path: "file2.pdf" });
    expect(next.selected).toEqual(["file2.pdf"]);
    expect(next.focused).toBe("file2.pdf");
    expect(next.anchor).toBe("file2.pdf");
  });

  it("case 13: EXTEND_FOCUS expands range without changing anchor", () => {
    const prev: SelectionState = {
      selected: ["file2.pdf"],
      focused: "file2.pdf",
      anchor: "file2.pdf",
    };
    const next = selectionReducer(prev, {
      type: "EXTEND_FOCUS",
      path: "file3.png",
      allPaths: allItems,
    });
    expect(next.selected).toEqual(["file2.pdf", "file3.png"]);
    expect(next.focused).toBe("file3.png");
    expect(next.anchor).toBe("file2.pdf");
  });

  it("case 14: RIGHT_CLICK on already selected item preserves multi-selection and sets focus", () => {
    const prev: SelectionState = {
      selected: ["file1.txt", "file2.pdf", "file3.png"],
      focused: "file1.txt",
      anchor: "file1.txt",
    };
    const next = selectionReducer(prev, { type: "RIGHT_CLICK", path: "file2.pdf" });
    expect(next.selected).toEqual(["file1.txt", "file2.pdf", "file3.png"]);
    expect(next.focused).toBe("file2.pdf");
  });

  it("case 15: PRUNE removes deleted items from selection, focused and anchor", () => {
    const prev: SelectionState = {
      selected: ["file1.txt", "deleted.txt", "file3.png"],
      focused: "deleted.txt",
      anchor: "deleted.txt",
    };
    const next = selectionReducer(prev, {
      type: "PRUNE",
      allPaths: ["file1.txt", "file3.png"],
    });
    expect(next.selected).toEqual(["file1.txt", "file3.png"]);
    expect(next.focused).toBeNull();
    expect(next.anchor).toBeNull();
  });
});
