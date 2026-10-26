import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ShellState } from "@rulebox/types";

import {
  __applySnapshotForTests,
  __setShellStateForTests,
  EMPTY_SHELL_STATE,
  getShellState,
  useShell,
} from "./store";

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

  it("keeps the object of every slice a snapshot did not change", () => {
    __setShellStateForTests(base());
    __applySnapshotForTests(base({ link: "linked" }));
    const first = getShellState();

    // The same content in new objects, as a fresh event payload would be.
    __applySnapshotForTests(JSON.parse(JSON.stringify({ ...first, link: "disconnected" })) as ShellState);
    const second = getShellState();
    expect(second.link).toBe("disconnected");
    expect(second.apps).toBe(first.apps);
    expect(second.system).toBe(first.system);
  });

  it("tells nobody when a snapshot is identical to the last one", () => {
    __setShellStateForTests(base());
    __applySnapshotForTests(base({ link: "linked" }));
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useShell((s) => s);
    });
    const afterMount = renders;
    act(() => {
      __applySnapshotForTests(JSON.parse(JSON.stringify(getShellState())) as ShellState);
    });
    expect(renders).toBe(afterMount);
  });
});
