import type { QueryState } from "../types";

/** The Rulebox build the organization's PCs update to (`organizations.phase6Settings.ruleboxRelease`). */
export interface ReleaseInfo {
  version: string;
  /** `https://`, no credentials. */
  url: string;
  /** 64 lower-case hexadecimal digits. */
  sha256: string;
  sizeBytes: number;
}

/** `ruleboxRelease:get`: `release` is null while none is set (the PCs update nothing). `revision` goes back to `set`. */
export interface ReleaseScreen {
  revision: number;
  release: ReleaseInfo | null;
}

// ---------------------------------------------------------------- the releases on GitHub (UI pass, settings plan 5.2)

/** Why a GitHub release cannot be picked (`convex/lib/githubReleases.ts` `ReleaseProblem`). */
export type GithubReleaseProblem =
  | "no_msi"
  | "two_msis"
  | "version_mismatch"
  | "no_checksums"
  | "checksums_unreadable"
  | "not_in_checksums"
  | "hash_mismatch"
  | "too_large"
  | "invalid";

/** One release of the Rulebox repository, as `ruleboxRelease:githubReleases` answers it. */
export interface GithubRelease {
  /** `v0.3.0-rc1`. */
  tag: string;
  /** The release name, or `Rulebox <tag without v>`; at most 120 characters. */
  title: string;
  /** `X.Y.Z`: what the agent reports after installing the MSI. */
  version: string;
  prerelease: boolean;
  /** Milliseconds. */
  publishedAt: number;
  /** `https://github.com/<repo>/releases/...`: a link to open in a new tab. */
  pageUrl: string;
  /** Plain-text source of the notes, at most 4,000 characters (`updates/releaseNotes.ts` turns it into blocks). */
  notes: string;
  notesTruncated: boolean;
  /** The MSI is code-signed (its name has no `-unsigned`). */
  signed: boolean;
  /** `null` exactly when `problem` is not null. */
  msi: { name: string; url: string; sizeBytes: number; sha256: string } | null;
  problem: GithubReleaseProblem | null;
}

/** `ruleboxRelease:githubReleases`: never throws for GitHub's sake (only authorization errors throw). */
export type GithubReleasesResult =
  | { status: "ok"; repoUrl: string; checkedAt: number; stale: boolean; releases: GithubRelease[] }
  | { status: "unavailable"; reason: "rate_limited" | "unreachable" | "not_found"; retryAt?: number };

export type GithubReleasesState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: GithubReleasesResult }
  | { status: "error"; error: unknown };

export interface GithubReleasesHandle {
  /** `idle` while `enabled` is false (admins and viewers never call). */
  state: GithubReleasesState;
  /** A refresh is running: the previous list stays in `state`. */
  refreshing: boolean;
  /** False for 30 s after a call (the server asks GitHub at most every 30 s anyway). */
  canRefresh: boolean;
  /** Calls with `refresh: true`; does nothing while `canRefresh` is false. */
  refresh: () => void;
}

/**
 * Rulebox's own update (Phase 6 Step 20). A seam of its own, like `../enrollment`: only the (lazy) Settings → Updates tab
 * imports `data/release`, so the first load does not carry it.
 */
export interface ReleaseApi {
  /** `ruleboxRelease:get` (viewer): one small query, the organization row. */
  useRelease: () => QueryState<ReleaseScreen>;
  /**
   * `ruleboxRelease:set` (Owner, major: fresh step-up): sets, changes or clears (`null`) the release. `stale_edit` when someone saved
   * the organization in between; `invalid_argument` with field `release.version` / `release.url` / `release.sha256` /
   * `release.sizeBytes`. Resolves to the revision to send next.
   */
  useSetRelease: () => (args: { expectedRevision: number; release: ReleaseInfo | null }) => Promise<{ revision: number }>;
  /**
   * `ruleboxRelease:githubReleases` (Owner, an unlocked session; an ACTION, so not reactive): the newest releases of the Rulebox
   * repository with the installer address, size and hash filled in, or the reason one cannot be used. Calls once when `enabled`
   * turns true (pass `useCan("owner")`; the server refuses anyone else), never polls and never on focus. The last `ok` answer is kept
   * in memory for 5 minutes, so leaving the section and coming back does not call again (nothing in storage: a stale hash never
   * survives a reload). `refresh()` calls with `refresh: true` and keeps the old list on screen while it runs. A late answer after
   * unmount is dropped. A locked session opens the unlock dialog and retries once. The browser never calls GitHub.
   */
  useGithubReleases: (enabled: boolean) => GithubReleasesHandle;
}
