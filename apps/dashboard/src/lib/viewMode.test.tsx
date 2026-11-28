import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { resolveView, setViewMode, storedView, useViewMode, VIEW_KEY } from "./viewMode";

const attr = () => document.documentElement.getAttribute("data-view");

/** A controllable `matchMedia`: `(max-width: 599px)` matches while `phone` is true. */
function stubWidth(phone: boolean) {
  const listeners = new Set<() => void>();
  let isPhone = phone;
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      get matches() {
        return query === "(max-width: 599px)" ? isPhone : false;
      },
      media: query,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    })),
  );
  return {
    resize(next: boolean) {
      isPhone = next;
      listeners.forEach((l) => l());
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-view");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("view mode", () => {
  it("is the table by default without matchMedia, and cards on a phone when nothing is stored", () => {
    expect(resolveView()).toBe("table");
    const { result, unmount } = renderHook(() => useViewMode());
    expect(result.current[0]).toBe("table");
    expect(attr()).toBe("table");
    unmount();
    stubWidth(true);
    expect(renderHook(() => useViewMode()).result.current[0]).toBe("cards");
    expect(attr()).toBe("cards");
  });

  it("a stored choice wins at every width", () => {
    stubWidth(true);
    localStorage.setItem(VIEW_KEY, "table");
    expect(renderHook(() => useViewMode()).result.current[0]).toBe("table");
    stubWidth(false);
    localStorage.setItem(VIEW_KEY, "cards");
    expect(renderHook(() => useViewMode()).result.current[0]).toBe("cards");
  });

  it("follows a width change until a choice is stored", () => {
    const media = stubWidth(false);
    const { result } = renderHook(() => useViewMode());
    expect(result.current[0]).toBe("table");
    act(() => media.resize(true));
    expect(result.current[0]).toBe("cards");
    expect(attr()).toBe("cards");
    act(() => media.resize(false));
    expect(result.current[0]).toBe("table");
    // The person picks: the width no longer matters.
    act(() => result.current[1]("cards"));
    act(() => media.resize(false));
    expect(result.current[0]).toBe("cards");
    expect(storedView()).toBe("cards");
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
    expect(storedView()).toBeNull();
    expect(resolveView()).toBe("table");
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

  it("printing always prints the table, then the view comes back", () => {
    localStorage.setItem(VIEW_KEY, "cards");
    const { result } = renderHook(() => useViewMode());
    expect(result.current[0]).toBe("cards");
    act(() => {
      window.dispatchEvent(new Event("beforeprint"));
    });
    expect(result.current[0]).toBe("table");
    expect(attr()).toBe("table");
    act(() => {
      window.dispatchEvent(new Event("afterprint"));
    });
    expect(result.current[0]).toBe("cards");
    expect(attr()).toBe("cards");
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
      // Forget the in-tab choice the blocked storage kept.
      setViewMode("table");
      localStorage.clear();
    }
  });
});
