import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { call } from "../../lib/tauri";
import { COVER_BEAT_MS, useFullscreenCover } from "./useFullscreenCover";

vi.mock("../../lib/tauri", () => ({ call: vi.fn(async () => undefined), isTauri: () => true }));

function Player() {
  const ref = useRef<HTMLVideoElement>(null);
  useFullscreenCover(ref);
  return <video ref={ref} data-testid="video" />;
}

let fullscreenElement: Element | null = null;

function setFullscreen(element: Element | null) {
  fullscreenElement = element;
  document.dispatchEvent(new Event("fullscreenchange"));
}

function sent(): boolean[] {
  return vi.mocked(call).mock.calls.map((c) => (c[1] as { on: boolean }).on);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(call).mockClear();
  fullscreenElement = null;
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
});

afterEach(() => {
  vi.useRealTimers();
  delete (document as unknown as Record<string, unknown>).fullscreenElement;
});

describe("a fullscreen video covers the taskbar", () => {
  it("asks once on entering fullscreen, repeats while it lasts and says off on leaving", () => {
    const { getByTestId } = render(<Player />);
    expect(sent()).toEqual([]);

    setFullscreen(getByTestId("video"));
    expect(sent()).toEqual([true]);

    vi.advanceTimersByTime(COVER_BEAT_MS * 3);
    expect(sent()).toEqual([true, true, true, true]);

    setFullscreen(null);
    expect(sent().at(-1)).toBe(false);
    const count = sent().length;
    vi.advanceTimersByTime(COVER_BEAT_MS * 5);
    expect(sent()).toHaveLength(count);
  });

  it("ignores another element going fullscreen", () => {
    render(<Player />);
    setFullscreen(document.body);
    expect(sent()).toEqual([]);
  });

  it("gives the taskbar back when the player goes away while fullscreen", () => {
    const { getByTestId, unmount } = render(<Player />);
    setFullscreen(getByTestId("video"));
    unmount();
    expect(sent().at(-1)).toBe(false);
  });

  it("gives the taskbar back when the page is hidden or unloaded", () => {
    const { getByTestId } = render(<Player />);
    setFullscreen(getByTestId("video"));
    window.dispatchEvent(new Event("pagehide"));
    expect(sent().at(-1)).toBe(false);
  });

  it("says nothing when it was never fullscreen", () => {
    const { unmount } = render(<Player />);
    unmount();
    expect(sent()).toEqual([]);
  });
});
