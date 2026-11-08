import { describe, expect, it, vi } from "vitest";
import { resolveConvexUrl, validConvexUrl } from "./convexUrl";

const json = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response);

describe("validConvexUrl", () => {
  it.each([
    ["https://happy-animal-123.convex.cloud", "https://happy-animal-123.convex.cloud"],
    ["https://x.convex.cloud/some/path?a=1", "https://x.convex.cloud"],
    ["http://localhost:3210", "http://localhost:3210"],
    ["http://127.0.0.1:3210", "http://127.0.0.1:3210"],
  ])("accepts %s", (input, out) => expect(validConvexUrl(input)).toBe(out));

  it.each(["http://evil.example", "javascript:alert(1)", "ftp://x.test", "not a url", "", 42, null, undefined])(
    "refuses %s",
    (input) => expect(validConvexUrl(input)).toBeNull(),
  );
});

describe("resolveConvexUrl", () => {
  it("prefers /config.json, fetched uncached", async () => {
    const f = json({ convexUrl: "https://prod.convex.cloud" });
    await expect(resolveConvexUrl("https://build.convex.cloud", f)).resolves.toBe("https://prod.convex.cloud");
    expect(f).toHaveBeenCalledWith("/config.json", expect.objectContaining({ cache: "no-store" }));
  });

  it("falls back to the build setting on a 404, a network error, a page instead of JSON, or a bad URL", async () => {
    const fallback = "https://build.convex.cloud";
    await expect(resolveConvexUrl(fallback, json({}, false))).resolves.toBe(fallback);
    await expect(resolveConvexUrl(fallback, vi.fn().mockRejectedValue(new TypeError("offline")))).resolves.toBe(fallback);
    const html = vi.fn(async () => ({ ok: true, json: async () => Promise.reject(new SyntaxError("<!doctype")) }) as unknown as Response);
    await expect(resolveConvexUrl(fallback, html)).resolves.toBe(fallback);
    await expect(resolveConvexUrl(fallback, json({ convexUrl: "http://evil.example" }))).resolves.toBe(fallback);
    await expect(resolveConvexUrl(fallback, json(null))).resolves.toBe(fallback);
  });

  it("returns undefined when there is neither", async () => {
    await expect(resolveConvexUrl(undefined, json({}, false))).resolves.toBeUndefined();
  });
});
