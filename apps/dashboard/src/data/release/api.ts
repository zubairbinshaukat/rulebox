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
}
