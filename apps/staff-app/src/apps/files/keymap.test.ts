import { describe, expect, it } from "vitest";
import {
  resolveKeyAction,
  TypeAheadBuffer,
  type KeyData,
} from "./keymap";

function makeKey(key: string, mods: Partial<KeyData> = {}): KeyData {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  };
}

describe("keymap table and action resolution", () => {
  it("maps navigation arrows with and without shift", () => {
    expect(resolveKeyAction(makeKey("ArrowUp"))).toEqual({
      type: "nav-arrow",
      direction: "up",
      extend: false,
    });
    expect(resolveKeyAction(makeKey("ArrowDown", { shiftKey: true }))).toEqual({
      type: "nav-arrow",
      direction: "down",
      extend: true,
    });
    expect(resolveKeyAction(makeKey("ArrowLeft"))).toEqual({
      type: "nav-arrow",
      direction: "left",
      extend: false,
    });
    expect(resolveKeyAction(makeKey("ArrowRight", { shiftKey: true }))).toEqual({
      type: "nav-arrow",
      direction: "right",
      extend: true,
    });
  });

  it("maps Home, End, PageUp, PageDown", () => {
    expect(resolveKeyAction(makeKey("Home"))).toEqual({ type: "nav-home", extend: false });
    expect(resolveKeyAction(makeKey("End", { shiftKey: true }))).toEqual({ type: "nav-end", extend: true });
    expect(resolveKeyAction(makeKey("PageUp"))).toEqual({ type: "nav-page-up", extend: false });
    expect(resolveKeyAction(makeKey("PageDown", { shiftKey: true }))).toEqual({ type: "nav-page-down", extend: true });
  });

  it("maps Ctrl+A to select-all", () => {
    expect(resolveKeyAction(makeKey("a", { ctrlKey: true }))).toEqual({ type: "select-all" });
    expect(resolveKeyAction(makeKey("A", { metaKey: true }))).toEqual({ type: "select-all" });
  });

  it("maps Enter to open", () => {
    expect(resolveKeyAction(makeKey("Enter"))).toEqual({ type: "open" });
  });

  it("maps F2 to rename", () => {
    expect(resolveKeyAction(makeKey("F2"))).toEqual({ type: "rename" });
  });

  it("maps Delete to trash and Shift+Delete to permanent delete", () => {
    expect(resolveKeyAction(makeKey("Delete"))).toEqual({ type: "delete", permanent: false });
    expect(resolveKeyAction(makeKey("Delete", { shiftKey: true }))).toEqual({
      type: "delete",
      permanent: true,
    });
  });

  it("maps clipboard keys Ctrl+C, Ctrl+X, Ctrl+V", () => {
    expect(resolveKeyAction(makeKey("c", { ctrlKey: true }))).toEqual({ type: "copy" });
    expect(resolveKeyAction(makeKey("x", { ctrlKey: true }))).toEqual({ type: "cut" });
    expect(resolveKeyAction(makeKey("v", { ctrlKey: true }))).toEqual({ type: "paste" });
  });

  it("maps parent navigation: Backspace and Alt+ArrowUp", () => {
    expect(resolveKeyAction(makeKey("Backspace"))).toEqual({ type: "parent" });
    expect(resolveKeyAction(makeKey("ArrowUp", { altKey: true }))).toEqual({ type: "parent" });
  });

  it("maps history navigation: Alt+ArrowLeft and Alt+ArrowRight", () => {
    expect(resolveKeyAction(makeKey("ArrowLeft", { altKey: true }))).toEqual({ type: "history-back" });
    expect(resolveKeyAction(makeKey("ArrowRight", { altKey: true }))).toEqual({ type: "history-forward" });
  });

  it("maps F5 to refresh and Ctrl+F to search", () => {
    expect(resolveKeyAction(makeKey("F5"))).toEqual({ type: "refresh" });
    expect(resolveKeyAction(makeKey("f", { ctrlKey: true }))).toEqual({ type: "search" });
  });

  it("maps Ctrl+Shift+N to new-folder", () => {
    expect(resolveKeyAction(makeKey("N", { ctrlKey: true, shiftKey: true }))).toEqual({
      type: "new-folder",
    });
  });

  it("maps Shift+F10 and ContextMenu to context-menu", () => {
    expect(resolveKeyAction(makeKey("F10", { shiftKey: true }))).toEqual({ type: "context-menu" });
    expect(resolveKeyAction(makeKey("ContextMenu"))).toEqual({ type: "context-menu" });
  });

  it("maps single characters to type-ahead", () => {
    expect(resolveKeyAction(makeKey("d"))).toEqual({ type: "type-ahead", char: "d" });
  });

  it("respects editing context", () => {
    expect(resolveKeyAction(makeKey("Escape"), { isEditing: true })).toEqual({ type: "cancel" });
    // Enter in the rename field is the field's own submit: it must not open the file.`n    expect(resolveKeyAction(makeKey("Enter"), { isEditing: true })).toBeNull();
    expect(resolveKeyAction(makeKey("ArrowUp"), { isEditing: true })).toBeNull();
  });
});

describe("TypeAheadBuffer (500 ms buffer)", () => {
  const items = [
    { name: "Documents", path: "Documents" },
    { name: "Downloads", path: "Downloads" },
    { name: "Music", path: "Music" },
    { name: "Photos", path: "Photos" },
    { name: "report.pdf", path: "report.pdf" },
  ];

  it("matches item by single character", () => {
    const tab = new TypeAheadBuffer(500);
    const path = tab.push("m", items, 1000);
    expect(path).toBe("Music");
    expect(tab.getBuffer()).toBe("m");
  });

  it("accumulates typed characters within 500 ms", () => {
    const tab = new TypeAheadBuffer(500);
    tab.push("d", items, 1000);
    const path2 = tab.push("o", items, 1200);
    expect(path2).toBe("Documents");
    expect(tab.getBuffer()).toBe("do");

    const path3 = tab.push("w", items, 1400);
    expect(path3).toBe("Downloads");
    expect(tab.getBuffer()).toBe("dow");
  });

  it("resets buffer after 500 ms pause", () => {
    const tab = new TypeAheadBuffer(500);
    tab.push("d", items, 1000);
    expect(tab.getBuffer()).toBe("d");

    // After 600ms, new character starts fresh
    const path = tab.push("p", items, 1600);
    expect(path).toBe("Photos");
    expect(tab.getBuffer()).toBe("p");
  });

  it("returns null when no match found", () => {
    const tab = new TypeAheadBuffer(500);
    const path = tab.push("z", items, 1000);
    expect(path).toBeNull();
  });
});
