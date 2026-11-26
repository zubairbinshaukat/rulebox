import { describe, expect, it } from "vitest";
import {
  MAX_RELEASE_BYTES,
  fieldsOf,
  releaseOf,
  releaseSizeProblem,
  releaseUrlProblem,
  sameRelease,
  sha256Problem,
  versionProblem,
} from "./releaseRules";

const SHA = "a".repeat(64);
const RELEASE = { version: "0.1.1", url: "https://dl.example.com/Rulebox-0.1.1-x64.msi", sha256: SHA, sizeBytes: 31_000_000 };

describe("release rules (mirror convex/ruleboxRelease.ts normalizeRelease)", () => {
  it("version: an ordered version of at most 40 characters", () => {
    for (const ok of ["0.1.1", " 1.2 ", "1.2.3.4", "0.2.0-rc.1"]) expect(versionProblem(ok), ok).toBeNull();
    expect(versionProblem("")).toBe("empty");
    expect(versionProblem("   ")).toBe("empty");
    expect(versionProblem(`1.${"1".repeat(40)}`)).toBe("length");
    for (const bad of ["banana", "v1.2", "1..2", "0.1.1 beta", "1.2.3.4.5", "1.2+build"]) expect(versionProblem(bad), bad).toBe("not_ordered");
  });

  it("address: https with a host and no credentials", () => {
    expect(releaseUrlProblem(RELEASE.url)).toBeNull();
    expect(releaseUrlProblem("  https://dl.example.com/a.msi  ")).toBeNull();
    expect(releaseUrlProblem("")).toBe("empty");
    for (const bad of ["http://dl.example.com/a.msi", "ftp://x.test/a.msi", "https://user:pw@x.test/a.msi", "https://user@x.test/a.msi", "not a url", "//x.test/a.msi"]) {
      expect(releaseUrlProblem(bad), bad).toBe("https");
    }
    expect(releaseUrlProblem(`https://x.test/${"a".repeat(2048)}`)).toBe("length");
  });

  it("SHA-256: 64 hexadecimal digits, any case", () => {
    expect(sha256Problem(SHA)).toBeNull();
    expect(sha256Problem(SHA.toUpperCase())).toBeNull();
    expect(sha256Problem(` ${SHA} `)).toBeNull();
    expect(sha256Problem("")).toBe("empty");
    for (const bad of ["abc", "g".repeat(64), "a".repeat(63), "a".repeat(65)]) expect(sha256Problem(bad), bad).toBe("format");
  });

  it("size: a whole number of bytes from 1 to 1 GiB", () => {
    for (const ok of ["1", "31000000", String(MAX_RELEASE_BYTES)]) expect(releaseSizeProblem(ok), ok).toBeNull();
    expect(releaseSizeProblem("")).toBe("empty");
    for (const bad of ["1.5", "-1", "12 MB", "1e6", "0x10"]) expect(releaseSizeProblem(bad), bad).toBe("number");
    for (const bad of ["0", String(MAX_RELEASE_BYTES + 1), "9999999999"]) expect(releaseSizeProblem(bad), bad).toBe("range");
  });

  it("what is sent is trimmed with the hash in lower case; the form round-trips a saved release", () => {
    expect(releaseOf({ version: " 0.1.1 ", url: ` ${RELEASE.url} `, sha256: SHA.toUpperCase(), size: " 31000000 " })).toEqual(RELEASE);
    expect(releaseOf(fieldsOf(RELEASE))).toEqual(RELEASE);
    expect(fieldsOf(null)).toEqual({ version: "", url: "", sha256: "", size: "" });
    expect(sameRelease(RELEASE, { ...RELEASE })).toBe(true);
    expect(sameRelease(RELEASE, { ...RELEASE, sizeBytes: 1 })).toBe(false);
    expect(sameRelease(null, null)).toBe(true);
    expect(sameRelease(RELEASE, null)).toBe(false);
  });
});
