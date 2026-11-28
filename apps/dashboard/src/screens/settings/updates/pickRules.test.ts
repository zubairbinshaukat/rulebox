import { describe, expect, it } from "vitest";
import type { GithubRelease } from "../../../data/release/api";
import type { ReleaseValue } from "../releaseRules";
import { defaultPick, fieldsOfGithub, isOnNewest, newestStable, relationToCurrent, valueOfGithub, warningsOf } from "./pickRules";

const url = (v: string, name = `Rulebox-${v}-x64.msi`) => `https://github.com/zubairbinshaukat/rulebox/releases/download/v${v}/${name}`;

function gh(version: string, over: Partial<GithubRelease> = {}, sha = "a"): GithubRelease {
  return {
    tag: `v${version}`,
    title: `Rulebox ${version}`,
    version,
    prerelease: false,
    publishedAt: 1_800_000_000_000,
    pageUrl: `https://github.com/zubairbinshaukat/rulebox/releases/tag/v${version}`,
    notes: "",
    notesTruncated: false,
    signed: true,
    msi: { name: `Rulebox-${version}-x64.msi`, url: url(version), sizeBytes: 38_000_000, sha256: sha.repeat(64) },
    problem: null,
    ...over,
  };
}

const bad = (version: string): GithubRelease => gh(version, { msi: null, problem: "no_checksums" });
const current = (version: string, sha = "a"): ReleaseValue => ({ version, url: url(version), sha256: sha.repeat(64), sizeBytes: 38_000_000 });

describe("fieldsOfGithub / valueOfGithub", () => {
  it("fills the four fields from the MSI: size as typed text", () => {
    expect(fieldsOfGithub(gh("0.3.0"))).toEqual({ version: "0.3.0", url: url("0.3.0"), sha256: "a".repeat(64), size: "38000000" });
    expect(valueOfGithub(gh("0.3.0"))).toEqual({ version: "0.3.0", url: url("0.3.0"), sha256: "a".repeat(64), sizeBytes: 38_000_000 });
  });

  it("is null for a release that cannot be used (a problem, or no installer)", () => {
    expect(fieldsOfGithub(bad("0.2.0"))).toBeNull();
    expect(valueOfGithub(bad("0.2.0"))).toBeNull();
    expect(valueOfGithub(gh("0.2.0", { problem: "invalid" }))).toBeNull();
  });
});

describe("relationToCurrent", () => {
  const cand = (v: string, sha = "a") => valueOfGithub(gh(v, {}, sha))!;

  it("nothing set yet: none", () => {
    expect(relationToCurrent(cand("0.3.0"), null)).toBe("none");
  });

  it("the same installer is the current one, whatever its size text says", () => {
    expect(relationToCurrent(cand("0.3.0"), current("0.3.0"))).toBe("current");
    expect(relationToCurrent(cand("0.3.0"), { ...current("0.3.0"), sizeBytes: 1 })).toBe("current");
  });

  it("same address, another hash: the tag was re-run and the installer replaced", () => {
    expect(relationToCurrent(cand("0.3.0", "b"), current("0.3.0"))).toBe("changed");
  });

  it("a lower version is older; a higher one is newer; compared by their numbers", () => {
    expect(relationToCurrent(cand("0.2.1"), current("0.3.0"))).toBe("older");
    expect(relationToCurrent(cand("0.10.0"), current("0.9.0"))).toBe("newer");
    expect(relationToCurrent(cand("1.0.0"), current("0.9.9"))).toBe("newer");
    expect(relationToCurrent(cand("0.3.0"), current("0.2.9"))).toBe("newer");
  });

  it("the same version at another address (a pre-release and its final, or an own build): the PCs that run it keep their copy", () => {
    const rc = valueOfGithub(gh("0.3.0", { tag: "v0.3.0-rc1", msi: { name: "Rulebox-0.3.0-x64.msi", url: url("0.3.0", "rc.msi"), sizeBytes: 5, sha256: "c".repeat(64) } }))!;
    expect(relationToCurrent(rc, current("0.3.0"))).toBe("sameVersionOtherBuild");
    // A typed version with a pre-release ending has the same numbers as the release.
    expect(relationToCurrent(cand("0.3.0"), { ...current("0.3.0-rc.1"), url: "https://dl.example.com/own.msi" })).toBe("sameVersionOtherBuild");
  });
});

describe("warningsOf", () => {
  it("lists what the owner is told, the relation first, then pre-release, then unsigned", () => {
    expect(warningsOf(gh("0.3.0"), current("0.2.0"))).toEqual([]);
    expect(warningsOf(gh("0.2.0"), current("0.3.0"))).toEqual(["older"]);
    expect(warningsOf(gh("0.3.0", {}, "b"), current("0.3.0"))).toEqual(["changed"]);
    expect(warningsOf(gh("0.3.0", { prerelease: true, signed: false }), null)).toEqual(["prerelease", "unsigned"]);
    expect(warningsOf(gh("0.2.0", { prerelease: true, signed: false }), current("0.3.0"))).toEqual(["older", "prerelease", "unsigned"]);
    expect(warningsOf(gh("0.3.0", { signed: false }), current("0.3.0"))).toEqual(["unsigned"]); // the current one again: no relation warning
  });

  it("an unusable release has none (it cannot be picked)", () => {
    expect(warningsOf(bad("0.2.0"), current("0.3.0"))).toEqual([]);
  });
});

describe("defaultPick / newestStable / isOnNewest", () => {
  const list = [gh("0.4.0", { prerelease: true }), bad("0.3.5"), gh("0.3.0", {}, "3"), gh("0.2.1", {}, "2")];

  it("preselects the newest usable stable release when it is newer than the current target", () => {
    expect(newestStable(list)!.tag).toBe("v0.3.0"); // the pre-release and the unusable one are skipped
    expect(defaultPick(list, current("0.2.1", "2"))!.tag).toBe("v0.3.0");
    expect(defaultPick(list, null)!.tag).toBe("v0.3.0");
  });

  it("nothing when the PCs are already on it, or on something newer", () => {
    expect(defaultPick(list, current("0.3.0", "3"))).toBeNull();
    expect(isOnNewest(list, current("0.3.0", "3"))).toBe(true);
    expect(defaultPick(list, current("0.9.0"))).toBeNull();
    expect(isOnNewest(list, current("0.9.0"))).toBe(false);
    expect(isOnNewest(list, null)).toBe(false);
  });

  it("a replaced installer (same address, new hash) is preselected again", () => {
    expect(defaultPick(list, current("0.3.0", "9"))!.tag).toBe("v0.3.0");
    expect(isOnNewest(list, current("0.3.0", "9"))).toBe(false);
  });

  it("nothing to pick when no release is usable or stable", () => {
    expect(defaultPick([], null)).toBeNull();
    expect(defaultPick([bad("0.3.0"), gh("0.4.0", { prerelease: true })], null)).toBeNull();
    expect(newestStable([bad("0.3.0")])).toBeNull();
  });
});
