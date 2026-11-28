/**
 * Live Rulebox-release hooks (Phase 6 Step 20, `convex/ruleboxRelease.ts`). `set` is an Owner major action:
 * `useMapped` opens the step-up dialog when the server asks, then retries once.
 */
import { useAction, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { useMapped, useMemberQuery } from "../live/convex";
import type { ReleaseApi } from "./api";
import { useGithubReleasesRunner } from "./githubRunner";

export const liveReleaseApi: ReleaseApi = {
  useRelease() {
    return useMemberQuery(api.ruleboxRelease.get, {});
  },
  useSetRelease() {
    return useMapped(useMutation(api.ruleboxRelease.set));
  },
  /** `ruleboxRelease:githubReleases` (an action, Owner, unlocked session): on open and on Refresh; the client cache is in `githubRunner.ts`. */
  useGithubReleases(enabled) {
    const call = useMapped(useAction(api.ruleboxRelease.githubReleases));
    return useGithubReleasesRunner(enabled, "live", (refresh) => call(refresh ? { refresh: true } : {}));
  },
};

/** Resolved through the `@rulebox/release-impl` alias in live builds. */
export const releaseApi = liveReleaseApi;
