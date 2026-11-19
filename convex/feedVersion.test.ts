import { describe, expect, test } from "vitest";
import { compareVersions, isOrdered, MAX_VERSION_CHARS, parseVersion } from "./lib/feed/version";
import vectorsRaw from "../crates/rulebox-policy/tests/vectors/version.json?raw";

// Version ordering (plan Phase 6, 4.4.1). The same vector file is read by
// `crates/rulebox-policy/src/version.rs`, so the two implementations agree.

interface Vectors {
  cmp: [string, string, -1 | 0 | 1][];
  notOrdered: string[];
  ordered: string[];
}
const vectors = JSON.parse(vectorsRaw) as Vectors;

describe("version ordering (shared vectors)", () => {
  test("the vector file is not trivially small", () => {
    expect(vectors.cmp.length).toBeGreaterThanOrEqual(40);
    expect(vectors.notOrdered.length).toBeGreaterThanOrEqual(20);
  });

  test("cmp, in both directions", () => {
    for (const [a, b, want] of vectors.cmp) {
      expect(compareVersions(a, b), `${a} vs ${b}`).toBe(want);
      expect(compareVersions(b, a), `${b} vs ${a}`).toBe(want === 0 ? 0 : -want);
    }
  });

  test("not ordered", () => {
    for (const text of vectors.notOrdered) {
      expect(isOrdered(text), JSON.stringify(text)).toBe(false);
      expect(compareVersions(text, "1.0"), JSON.stringify(text)).toBeNull();
      expect(compareVersions("1.0", text), JSON.stringify(text)).toBeNull();
    }
  });

  test("ordered", () => {
    for (const text of vectors.ordered) expect(isOrdered(text), text).toBe(true);
  });
});

describe("version ordering (edges)", () => {
  test("the longest text is forty characters", () => {
    expect(MAX_VERSION_CHARS).toBe(40);
    const forty = `1.0.0-${"a".repeat(34)}`;
    expect(forty).toHaveLength(40);
    expect(isOrdered(forty)).toBe(true);
    expect(isOrdered(`${forty}a`)).toBe(false);
    // Five parts, 40 characters.
    expect(isOrdered(`${"1.".repeat(10)}${"2".repeat(20)}`)).toBe(false);
  });

  test("huge numbers do not overflow", () => {
    expect(compareVersions("99999999999999999999999999999999.0", "1.0")).toBe(1);
    expect(compareVersions("00000000000000000000001.0", "1")).toBe(0);
  });

  test("a trailing newline is not a version", () => {
    expect(isOrdered("1.2.3\n")).toBe(false);
    expect(isOrdered("1.2.3-a\n")).toBe(false);
  });

  test("parts are padded to four", () => {
    expect(parseVersion("1.2")?.parts).toEqual(["1", "2", "0", "0"]);
    expect(parseVersion("1.02.0.10")?.parts).toEqual(["1", "2", "0", "10"]);
    expect(parseVersion("1.0-rc.1")?.pre).toEqual(["rc", "1"]);
    expect(parseVersion("1.0")?.pre).toEqual([]);
  });

  test("sorting a list gives the semver order", () => {
    const shuffled = ["1.0.0", "1.0.0-rc.1", "1.0.0-alpha", "1.0.0-beta.11", "1.0.0-beta.2", "0.9.9", "1.0.0-alpha.1"];
    const sorted = [...shuffled].sort((a, b) => compareVersions(a, b) ?? 0);
    expect(sorted).toEqual([
      "0.9.9",
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ]);
  });
});
