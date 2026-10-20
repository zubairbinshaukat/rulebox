import { describe, expect, it } from "vitest";

import { canDropOn, dropDirOf } from "./dragLogic";
import { gridColumnsFor } from "./layout";
import { itemId } from "./utils";

describe("where a drag may land", () => {
  it("allows a different folder", () => {
    expect(canDropOn(["a.txt"], "Documents")).toBe(true);
    expect(canDropOn(["Documents/a.txt"], "")).toBe(true);
    expect(canDropOn(["Documents"], "Pictures")).toBe(true);
  });

  it("refuses the folder it is already in", () => {
    expect(canDropOn(["a.txt"], "")).toBe(false);
    expect(canDropOn(["Documents/a.txt"], "Documents")).toBe(false);
  });

  it("refuses a folder onto itself or inside itself", () => {
    expect(canDropOn(["Documents"], "Documents")).toBe(false);
    expect(canDropOn(["Documents"], "Documents/Taxes")).toBe(false);
    // A look-alike name is a different folder.
    expect(canDropOn(["Doc"], "Documents")).toBe(true);
  });

  it("allows the drop when at least one item can move", () => {
    expect(canDropOn(["Documents/a.txt", "b.txt"], "Documents")).toBe(true);
    expect(canDropOn(["Documents/a.txt", "Documents/b.txt"], "Documents")).toBe(false);
  });
});

describe("finding the drop folder under the pointer", () => {
  it("reads data-drop-dir from the element or an ancestor, and the root is an empty string", () => {
    document.body.innerHTML = `
      <div data-drop-dir="Pictures"><span id="inner">x</span></div>
      <button id="root" data-drop-dir="">All files</button>
      <p id="plain">no target</p>`;
    expect(dropDirOf(document.getElementById("inner"))).toBe("Pictures");
    expect(dropDirOf(document.getElementById("root"))).toBe("");
    expect(dropDirOf(document.getElementById("plain"))).toBeNull();
    expect(dropDirOf(null)).toBeNull();
  });
});

describe("element ids", () => {
  it("never contain a space, so aria-activedescendant works", () => {
    for (const path of ["My Docs/a b.txt", "é/ü.txt", "a/b/c"]) {
      expect(itemId(path)).toMatch(/^fx-[0-9a-f]+$/);
    }
    expect(itemId("a")).not.toBe(itemId("b"));
    expect(itemId("a/b")).toBe(itemId("a/b"));
  });
});

describe("grid columns", () => {
  it("fits as many 124 px cards as the width allows, at least one", () => {
    expect(gridColumnsFor(100)).toBe(1);
    expect(gridColumnsFor(0)).toBe(1);
    // 16 + 16 padding; 4 cards = 4*124 + 3*12 = 532.
    expect(gridColumnsFor(532 + 32)).toBe(4);
    expect(gridColumnsFor(532 + 32 - 1)).toBe(3);
  });
});
