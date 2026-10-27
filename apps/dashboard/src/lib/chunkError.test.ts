import { describe, expect, it } from "vitest";
import { isChunkLoadError, RELOAD_WINDOW_MS, shouldAutoReload } from "./chunkError";

describe("isChunkLoadError", () => {
  it("recognizes each browser's failed dynamic import", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://x/assets/Devices-abc.js",
      "error loading dynamically imported module: https://x/assets/Devices-abc.js",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/Layout-abc.css",
    ]) {
      expect(isChunkLoadError(new TypeError(message))).toBe(true);
    }
    expect(isChunkLoadError(Object.assign(new Error("x"), { name: "ChunkLoadError" }))).toBe(true);
  });

  it("leaves every other error to the normal boundaries", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError({ code: "forbidden" })).toBe(false);
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe("shouldAutoReload", () => {
  const now = 1_000_000;
  it("reloads once while online", () => {
    expect(shouldAutoReload(now, null, true)).toBe(true);
    expect(shouldAutoReload(now, now - 1000, true)).toBe(false);
    expect(shouldAutoReload(now, now - RELOAD_WINDOW_MS, true)).toBe(true);
  });
  it("never reloads offline (the browser would show its own error page)", () => {
    expect(shouldAutoReload(now, null, false)).toBe(false);
  });
  it("is not stuck by a clock that went backwards", () => {
    expect(shouldAutoReload(now, now + 5000, true)).toBe(true);
  });
});
