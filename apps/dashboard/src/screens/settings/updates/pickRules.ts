// Picking a GitHub release for the Rulebox update (Settings -> Updates, plan `docs/plans/ui-pass/settings.md` 5.4-5.6). Pure: no
// sentences (the screen maps a warning to its text), no data hooks. The server already checked every release it marks usable
// (`convex/lib/githubReleases.ts`); this decides what the form is filled with and what the owner is told before saving.
import { numbersAbove } from "../../../lib/apps/updateRules";
import type { GithubRelease } from "../../../data/release/api";
import { sameRelease, type ReleaseFields, type ReleaseValue } from "../releaseRules";

/** The release as `ruleboxRelease:set` takes it, or null when the release has no usable installer (`problem` is set). */
export function valueOfGithub(release: GithubRelease): ReleaseValue | null {
  const msi = release.msi;
  if (release.problem !== null || msi === null) return null;
  return { version: release.version, url: msi.url, sha256: msi.sha256, sizeBytes: msi.sizeBytes };
}

/** What picking a release writes into the form (the four Advanced fields), or null for a release that cannot be used. */
export function fieldsOfGithub(release: GithubRelease): ReleaseFields | null {
  const v = valueOfGithub(release);
  return v === null ? null : { version: v.version, url: v.url, sha256: v.sha256, size: String(v.sizeBytes) };
}

/**
 * How a candidate relates to the release the PCs are set to now.
 * - `none`: nothing is set yet.
 * - `current`: the same installer (same address and hash): nothing to do.
 * - `changed`: the same address with another hash: the tag was re-run and the installer was replaced on GitHub.
 * - `older`: a lower version than the current target (PCs that already have a newer one keep it).
 * - `sameVersionOtherBuild`: the same version, another installer (PCs that already run it keep their copy).
 * - `newer`: a higher version.
 * Versions compare by their numbers (a `-rc` ending is ignored: the agent reports only `X.Y.Z`).
 */
export type Relation = "none" | "current" | "changed" | "older" | "sameVersionOtherBuild" | "newer";

export function relationToCurrent(candidate: ReleaseValue, current: ReleaseValue | null): Relation {
  if (current === null) return "none";
  if (sameRelease(candidate, current) || (candidate.url === current.url && candidate.sha256 === current.sha256)) return "current";
  if (candidate.url === current.url) return "changed";
  if (numbersAbove(current.version, candidate.version)) return "older";
  if (numbersAbove(candidate.version, current.version)) return "newer";
  return "sameVersionOtherBuild";
}

/** What the owner is told about a release before saving it (inline, never only in a tooltip). */
export type PickWarning = "older" | "sameVersionOtherBuild" | "changed" | "prerelease" | "unsigned";

/** The warnings of a usable release, the most important first. Empty for an unusable one (it cannot be picked). */
export function warningsOf(release: GithubRelease, current: ReleaseValue | null): PickWarning[] {
  const value = valueOfGithub(release);
  if (value === null) return [];
  const out: PickWarning[] = [];
  const relation = relationToCurrent(value, current);
  if (relation === "changed" || relation === "older" || relation === "sameVersionOtherBuild") out.push(relation);
  if (release.prerelease) out.push("prerelease");
  if (!release.signed) out.push("unsigned");
  return out;
}

/** The newest release that can be picked and is not a pre-release (the list is newest first), or null. */
export function newestStable(releases: readonly GithubRelease[]): GithubRelease | null {
  return releases.find((r) => r.problem === null && r.msi !== null && !r.prerelease) ?? null;
}

/**
 * The release to preselect: the newest stable one when it is newer than the current target (or the same address with a replaced
 * installer). Null when nothing is usable, or when the PCs are already set to the newest one (the screen then says so).
 */
export function defaultPick(releases: readonly GithubRelease[], current: ReleaseValue | null): GithubRelease | null {
  const newest = newestStable(releases);
  const value = newest === null ? null : valueOfGithub(newest);
  if (newest === null || value === null) return null;
  const relation = relationToCurrent(value, current);
  return relation === "none" || relation === "newer" || relation === "changed" ? newest : null;
}

/** The PCs are already set to the newest stable release. */
export function isOnNewest(releases: readonly GithubRelease[], current: ReleaseValue | null): boolean {
  const newest = newestStable(releases);
  const value = newest === null ? null : valueOfGithub(newest);
  return value !== null && current !== null && relationToCurrent(value, current) === "current";
}
