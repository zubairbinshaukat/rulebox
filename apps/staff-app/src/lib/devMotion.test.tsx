import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const emitted: { name: string; payload: unknown }[] = [];
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async (name: string, payload: unknown) => {
    emitted.push({ name, payload });
  }),
  listen: vi.fn(async () => () => undefined),
}));
vi.mock("./tauri", () => ({ call: vi.fn(), isTauri: () => true }));

import {
  DEV_TOOLS_BUILD,
  isFullMotionForced,
  setFullMotionForced,
  startDevMotion,
  useForcedFullMotion,
} from "./devMotion";
import { useMotionLevel } from "./motion";
import { EMPTY_SHELL_STATE, __setShellStateForTests } from "./store";

function Level() {
  return <span data-testid="level">{useMotionLevel()}</span>;
}

function Flag() {
  return <span data-testid="flag">{String(useForcedFullMotion())}</span>;
}

beforeEach(() => {
  // jsdom has no matchMedia; the OS says "reduce motion" so the test also proves the switch beats it.
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  emitted.length = 0;
  window.localStorage.clear();
  __setShellStateForTests({ ...EMPTY_SHELL_STATE, display: { ...EMPTY_SHELL_STATE.display, lite: true } });
});

afterEach(() => {
  act(() => setFullMotionForced(false));
  vi.unstubAllGlobals();
});

describe("Force full motion (debug builds only)", () => {
  it("is a debug-build feature: the compile-time flag is on under test (vite DEV)", () => {
    expect(DEV_TOOLS_BUILD).toBe(true);
  });

  it("is off by default, and Lite means the fade level", () => {
    startDevMotion();
    const { getByTestId } = render(<Level />);
    expect(isFullMotionForced()).toBe(false);
    expect(getByTestId("level").textContent).toBe("fade");
    expect(document.documentElement.hasAttribute("data-force-motion")).toBe(false);
  });

  it("ignores Lite while on, marks the page for the reduced-motion CSS, and tells the other windows", () => {
    const { getByTestId } = render(
      <>
        <Level />
        <Flag />
      </>,
    );
    act(() => setFullMotionForced(true));
    expect(getByTestId("level").textContent).toBe("full");
    expect(getByTestId("flag").textContent).toBe("true");
    expect(document.documentElement.getAttribute("data-force-motion")).toBe("true");
    expect(window.localStorage.getItem("rulebox.dev.forceFullMotion")).toBe("1");
    expect(emitted.at(-1)).toEqual({ name: "dev://force-full-motion", payload: true });

    act(() => setFullMotionForced(false));
    expect(getByTestId("level").textContent).toBe("fade");
    expect(document.documentElement.hasAttribute("data-force-motion")).toBe(false);
    expect(window.localStorage.getItem("rulebox.dev.forceFullMotion")).toBeNull();
  });
});
