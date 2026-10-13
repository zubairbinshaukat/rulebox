import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ShellState } from "@rulebox/types";

import { __setShellStateForTests, EMPTY_SHELL_STATE, useShell } from "./store";

function base(overrides: Partial<ShellState> = {}): ShellState {
  return { ...EMPTY_SHELL_STATE, ...overrides };
}

describe("useShell", () => {
  it("re-renders only when the selected JSON changes", () => {
    __setShellStateForTests(
      base({
        link: "disconnected",
        display: { lite: false, theme: "auto", reducedMotion: false },
      }),
    );

    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useShell((s) => s.link);
    });

    expect(result.current).toBe("disconnected");
    const afterMount = renders;

    act(() => {
      __setShellStateForTests(
        base({
          link: "disconnected",
          display: { lite: true, theme: "dark", reducedMotion: true },
        }),
      );
    });
    // Selection (link) unchanged → no re-render from store notify that changes snapshot equality.
    // useSyncExternalStore still calls getSnapshot; React bails out if snapshot === previous.
    expect(result.current).toBe("disconnected");
    expect(renders).toBe(afterMount);

    act(() => {
      __setShellStateForTests(
        base({
          link: "linked",
          display: { lite: true, theme: "dark", reducedMotion: true },
        }),
      );
    });
    expect(result.current).toBe("linked");
    expect(renders).toBeGreaterThan(afterMount);
  });
});
