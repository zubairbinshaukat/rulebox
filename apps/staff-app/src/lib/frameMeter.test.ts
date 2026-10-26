import { describe, expect, it } from "vitest";

import { frameMeterEnabled, startFrameMeter, summarize } from "./frameMeter";

describe("summarize", () => {
  it("reports the average, the worst gap and the frames over 32 ms", () => {
    const report = summarize("open:full", [16, 17, 16, 40, 16]);
    expect(report).toEqual({ name: "open:full", frames: 5, avgMs: 21, worstMs: 40, over32ms: 1 });
  });

  it("reports zeros for a span with no frames", () => {
    expect(summarize("splash:full", [])).toEqual({
      name: "splash:full",
      frames: 0,
      avgMs: 0,
      worstMs: 0,
      over32ms: 0,
    });
  });
});

describe("startFrameMeter", () => {
  it("does nothing outside a debug build", () => {
    expect(frameMeterEnabled()).toBe(false);
    expect(startFrameMeter("x")()).toBeNull();
  });
});
