import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLogoSequence } from "./useLogoSequence";

describe("useLogoSequence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires done from the timer when the LogoMotion callback never comes", () => {
    const { result } = renderHook(() => useLogoSequence("splash", "full"));
    expect(result.current.done).toBe(false);
    act(() => {
      vi.advanceTimersByTime(3_500);
    });
    expect(result.current.done).toBe(true);
    expect(result.current.covered).toBe(true);
  });

  it("splash skip marks done immediately", () => {
    const { result } = renderHook(() => useLogoSequence("splash", "full"));
    act(() => {
      result.current.skip();
    });
    expect(result.current.done).toBe(true);
  });

  it("fade level uses 400 ms timers", () => {
    const { result } = renderHook(() => useLogoSequence("open", "fade"));
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(result.current.done).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.done).toBe(true);
  });

  it("open covered timer is 1.6 s in full motion", () => {
    const { result } = renderHook(() => useLogoSequence("open", "full"));
    act(() => {
      vi.advanceTimersByTime(1_600);
    });
    expect(result.current.covered).toBe(true);
    expect(result.current.done).toBe(false);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.done).toBe(true);
  });
});
