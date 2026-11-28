import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { GithubReleasesResult } from "./api";
import { CLIENT_CACHE_MS, REFRESH_LOCK_MS, resetGithubReleasesClient, useGithubReleasesRunner } from "./githubRunner";

// The client side of `useGithubReleases` (settings plan 5.3): once on open, memory cache of 5 minutes, Refresh locked for 30 s,
// late answers dropped. The runner is shared by the live and the demo hook; `call` is the only network, here a mock.

const OK: GithubReleasesResult = { status: "ok", repoUrl: "https://github.com/x/y", checkedAt: 1, stale: false, releases: [] };
const BUSY: GithubReleasesResult = { status: "unavailable", reason: "rate_limited", retryAt: 5 };

/** A call the test resolves by hand. */
function deferred() {
  const calls: { refresh: boolean; resolve: (r: GithubReleasesResult) => void; reject: (e: unknown) => void }[] = [];
  const call = vi.fn(
    (refresh: boolean) =>
      new Promise<GithubReleasesResult>((resolve, reject) => {
        calls.push({ refresh, resolve, reject });
      }),
  );
  return { call, calls };
}

const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));

beforeEach(() => {
  vi.useFakeTimers();
  resetGithubReleasesClient();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useGithubReleasesRunner", () => {
  it("not enabled (admins, viewers): idle, no call, even after time passes", async () => {
    const { call } = deferred();
    const { result } = renderHook(() => useGithubReleasesRunner(false, "k", call));
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    expect(result.current.state).toEqual({ status: "idle" });
    expect(call).not.toHaveBeenCalled();
  });

  it("enabled: loading, one call without refresh, then ready; it never polls", async () => {
    const d = deferred();
    const { result } = renderHook(() => useGithubReleasesRunner(true, "k", d.call));
    expect(result.current.state).toEqual({ status: "loading" });
    expect(d.call).toHaveBeenCalledTimes(1);
    expect(d.calls[0]!.refresh).toBe(false);
    await act(async () => d.calls[0]!.resolve(OK));
    expect(result.current.state).toEqual({ status: "ready", data: OK });
    expect(result.current.refreshing).toBe(false);
    await act(async () => void (await vi.advanceTimersByTimeAsync(60 * 60_000)));
    expect(d.call).toHaveBeenCalledTimes(1);
  });

  it("turning enabled on later (the role arrives) makes the call then", async () => {
    const d = deferred();
    const { result, rerender } = renderHook(({ on }) => useGithubReleasesRunner(on, "k", d.call), { initialProps: { on: false } });
    expect(d.call).not.toHaveBeenCalled();
    rerender({ on: true });
    expect(d.call).toHaveBeenCalledTimes(1);
    await act(async () => d.calls[0]!.resolve(OK));
    expect(result.current.state.status).toBe("ready");
  });

  it("an ok answer is reused for 5 minutes, also by a screen that mounts later; after that it calls again", async () => {
    const d = deferred();
    const first = renderHook(() => useGithubReleasesRunner(true, "k", d.call));
    await act(async () => d.calls[0]!.resolve(OK));
    first.unmount();

    vi.advanceTimersByTime(CLIENT_CACHE_MS - 1);
    const again = renderHook(() => useGithubReleasesRunner(true, "k", d.call));
    expect(again.result.current.state).toEqual({ status: "ready", data: OK }); // from the first render
    await flush();
    expect(d.call).toHaveBeenCalledTimes(1);
    again.unmount();

    vi.advanceTimersByTime(2);
    const late = renderHook(() => useGithubReleasesRunner(true, "k", d.call));
    expect(late.result.current.state).toEqual({ status: "loading" });
    expect(d.call).toHaveBeenCalledTimes(2);
    expect(d.calls[1]!.refresh).toBe(false);
  });

  it("another key is another cache; an unavailable or failed answer is never cached", async () => {
    const d = deferred();
    const a = renderHook(() => useGithubReleasesRunner(true, "a", d.call));
    await act(async () => d.calls[0]!.resolve(BUSY));
    expect(a.result.current.state).toEqual({ status: "ready", data: BUSY });
    a.unmount();
    const b = renderHook(() => useGithubReleasesRunner(true, "a", d.call));
    expect(d.call).toHaveBeenCalledTimes(2); // BUSY was not kept
    await act(async () => d.calls[1]!.resolve(OK));
    b.unmount();
    renderHook(() => useGithubReleasesRunner(true, "other", d.call));
    expect(d.call).toHaveBeenCalledTimes(3);
  });

  it("a call that throws is an error state (the screen shows Try again); refresh then calls again", async () => {
    const d = deferred();
    const { result } = renderHook(() => useGithubReleasesRunner(true, "k", d.call));
    const boom = new Error("nope");
    await act(async () => d.calls[0]!.reject(boom));
    expect(result.current.state).toEqual({ status: "error", error: boom });
    expect(result.current.refreshing).toBe(false);
    vi.advanceTimersByTime(REFRESH_LOCK_MS);
    act(() => result.current.refresh());
    expect(d.calls[1]!.refresh).toBe(true);
  });

  it("refresh: calls with refresh true, keeps the old list while it runs, locks itself for 30 s", async () => {
    const d = deferred();
    const { result } = renderHook(() => useGithubReleasesRunner(true, "k", d.call));
    expect(result.current.canRefresh).toBe(false); // the first call just happened
    await act(async () => d.calls[0]!.resolve(OK));
    await act(async () => void (await vi.advanceTimersByTimeAsync(REFRESH_LOCK_MS)));
    expect(result.current.canRefresh).toBe(true);

    act(() => result.current.refresh());
    expect(d.calls[1]!.refresh).toBe(true);
    expect(result.current.refreshing).toBe(true);
    expect(result.current.state).toEqual({ status: "ready", data: OK }); // the old list stays
    expect(result.current.canRefresh).toBe(false);

    const next: GithubReleasesResult = { ...OK, checkedAt: 2 };
    await act(async () => d.calls[1]!.resolve(next));
    expect(result.current.state).toEqual({ status: "ready", data: next });
    expect(result.current.refreshing).toBe(false);

    // Locked: nothing happens until 30 s have passed.
    act(() => result.current.refresh());
    expect(d.call).toHaveBeenCalledTimes(2);
    await act(async () => void (await vi.advanceTimersByTimeAsync(REFRESH_LOCK_MS - 1)));
    expect(result.current.canRefresh).toBe(false);
    await act(async () => void (await vi.advanceTimersByTimeAsync(1)));
    expect(result.current.canRefresh).toBe(true);
    act(() => result.current.refresh());
    expect(d.call).toHaveBeenCalledTimes(3);
  });

  it("the lock outlives the screen: coming back inside 30 s does not allow a refresh yet", async () => {
    const d = deferred();
    const first = renderHook(() => useGithubReleasesRunner(true, "k", d.call));
    await act(async () => d.calls[0]!.resolve(OK));
    first.unmount();
    vi.advanceTimersByTime(10_000);
    const again = renderHook(() => useGithubReleasesRunner(true, "k", d.call));
    expect(again.result.current.canRefresh).toBe(false);
    act(() => again.result.current.refresh());
    expect(d.call).toHaveBeenCalledTimes(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(20_000)));
    expect(again.result.current.canRefresh).toBe(true);
  });

  it("an answer that arrives after the screen is gone is dropped (no state change), but the next screen can use it", async () => {
    const d = deferred();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const gone = renderHook(() => useGithubReleasesRunner(true, "k", d.call));
    gone.unmount();
    await act(async () => d.calls[0]!.resolve(OK));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
    const back = renderHook(() => useGithubReleasesRunner(true, "k", d.call));
    expect(back.result.current.state).toEqual({ status: "ready", data: OK });
    expect(d.call).toHaveBeenCalledTimes(1);
  });

  it("two screens opening together share one call", async () => {
    const d = deferred();
    const a = renderHook(() => useGithubReleasesRunner(true, "k", d.call));
    const b = renderHook(() => useGithubReleasesRunner(true, "k", d.call));
    expect(d.call).toHaveBeenCalledTimes(1);
    await act(async () => d.calls[0]!.resolve(OK));
    expect(a.result.current.state.status).toBe("ready");
    expect(b.result.current.state.status).toBe("ready");
  });
});
