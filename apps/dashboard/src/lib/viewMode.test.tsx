import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { savedView, setViewMode, useViewMode, VIEW_KEY } from "./viewMode";

const attr = () => document.documentElement.getAttribute("data-view");

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-view");
});

describe("view mode", () => {
  it("is the table by default, at every width", () => {
    expect(savedView()).toBe("table");
    const { result } = renderHook(() => useViewMode());
    expect(result.current[0]).toBe("table");
    expect(attr()).toBe("table");
  });

  it("remembers the choice in localStorage and puts it on <html data-view>", () => {
    const { result } = renderHook(() => useViewMode());
    act(() => result.current[1]("cards"));
    expect(result.current[0]).toBe("cards");
    expect(localStorage.getItem(VIEW_KEY)).toBe("cards");
    expect(attr()).toBe("cards");
    act(() => result.current[1]("table"));
    expect(localStorage.getItem(VIEW_KEY)).toBe("table");
    expect(attr()).toBe("table");
  });

  it("reads the saved choice on the next visit, and ignores junk", () => {
    localStorage.setItem(VIEW_KEY, "cards");
    expect(renderHook(() => useViewMode()).result.current[0]).toBe("cards");
    localStorage.setItem(VIEW_KEY, "grid");
    document.documentElement.removeAttribute("data-view"); // what boot.js would have set from junk: the table
    expect(savedView()).toBe("table");
  });

  it("every user of the hook updates together", () => {
    const a = renderHook(() => useViewMode());
    const b = renderHook(() => useViewMode());
    act(() => a.result.current[1]("cards"));
    expect(b.result.current[0]).toBe("cards");
  });

  it("follows another tab through the storage event", () => {
    const { result } = renderHook(() => useViewMode());
    act(() => {
      localStorage.setItem(VIEW_KEY, "cards");
      window.dispatchEvent(new StorageEvent("storage", { key: VIEW_KEY, newValue: "cards" }));
    });
    expect(result.current[0]).toBe("cards");
    expect(attr()).toBe("cards");
    // Another key does nothing.
    act(() => {
      localStorage.setItem(VIEW_KEY, "table");
      window.dispatchEvent(new StorageEvent("storage", { key: "rulebox.theme" }));
    });
    expect(result.current[0]).toBe("cards");
  });

  it("still switches (until reload) when storage is blocked", () => {
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      const { result } = renderHook(() => useViewMode());
      act(() => setViewMode("cards"));
      expect(result.current[0]).toBe("cards");
      expect(attr()).toBe("cards");
    } finally {
      set.mockRestore();
      get.mockRestore();
    }
  });
});
