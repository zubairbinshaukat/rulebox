import { describe, expect, it } from "vitest";
import raw from "../../../agent/tests/vectors/install-details.json?raw";
import { installDetail } from "./install";
import { installStrings } from "./screenStrings/install";

const shared = JSON.parse(raw) as { details: string[] };

describe("install failure details (apps/agent/tests/vectors/install-details.json)", () => {
  it("the shared list is not empty", () => {
    expect(shared.details.length).toBeGreaterThan(0);
  });

  it("every detail the agent can send has its own text, not the fallback", () => {
    for (const detail of shared.details) {
      const text = installDetail(detail);
      expect(text, detail).not.toBe(installStrings.detailFallback);
      expect(text.trim().length, detail).toBeGreaterThan(0);
    }
  });

  it("has no text for a detail that is not in the shared list", () => {
    expect(Object.keys(installStrings.details).sort()).toEqual([...shared.details].sort());
  });

  it("falls back for a missing or unknown detail", () => {
    expect(installDetail(undefined)).toBe(installStrings.detailFallback);
    expect(installDetail("nonsense")).toBe(installStrings.detailFallback);
  });

  it("the timeout text names no fixed number of minutes (the limit is per app)", () => {
    expect(installDetail("timeout")).not.toMatch(/\d/);
  });
});
