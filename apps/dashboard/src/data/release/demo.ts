/**
 * Demo twin of `convex/ruleboxRelease.ts` (`VITE_DEMO=1`): the same rules (Owner only, a fresh step-up, the revision check, the field
 * refusals, unchanged = no write and no audit entry).
 */
import { useCallback } from "react";
import { currentMember, checkRevision, fail, runMutation, useDemoQuery } from "../demo/store";
import { releaseSizeProblem, releaseUrlProblem, sha256Problem, versionProblem } from "../../screens/settings/releaseRules";
import type { ReleaseApi, ReleaseInfo } from "./api";

const same = (a: ReleaseInfo | undefined, b: ReleaseInfo | undefined) =>
  a === undefined || b === undefined ? a === b : a.version === b.version && a.url === b.url && a.sha256 === b.sha256 && a.sizeBytes === b.sizeBytes;

export const demoReleaseApi: ReleaseApi = {
  useRelease() {
    return useDemoQuery("ruleboxRelease:get", (db) => {
      const me = currentMember();
      if (!me) fail("unauthenticated");
      if (me.status === "disabled") fail("forbidden");
      return { revision: db.org.revision, release: db.org.ruleboxRelease ? { ...db.org.ruleboxRelease } : null };
    });
  },
  useSetRelease() {
    return useCallback(async ({ expectedRevision, release }) => {
      const check = () => {
        if (release === null) return undefined;
        const version = release.version.trim();
        if (versionProblem(version) !== null) fail("invalid_argument", { field: "release.version" });
        if (releaseUrlProblem(release.url) !== null || release.url !== release.url.trim()) fail("invalid_argument", { field: "release.url" });
        if (sha256Problem(release.sha256) !== null || release.sha256 !== release.sha256.trim()) fail("invalid_argument", { field: "release.sha256" });
        if (releaseSizeProblem(String(release.sizeBytes)) !== null) fail("invalid_argument", { field: "release.sizeBytes" });
        return { version, url: release.url, sha256: release.sha256.toLowerCase(), sizeBytes: release.sizeBytes };
      };
      // A fresh step-up is needed for every real change (the server: `major: "ruleboxRelease:set"`).
      return runMutation(
        "owner",
        ({ db, audit }) => {
          checkRevision(db.org, expectedRevision);
          const next = check();
          const before = db.org.ruleboxRelease;
          if (same(before, next)) return { revision: db.org.revision };
          db.org.revision++;
          db.org.ruleboxRelease = next;
          audit({
            action: "org.ruleboxReleaseChanged",
            targetType: "organization",
            targetId: db.org._id,
            targetLabel: db.org.name,
            summary:
              next === undefined
                ? "Cleared the Rulebox release: PCs no longer update Rulebox"
                : `Set the Rulebox release to version ${next.version}${before === undefined ? "" : ` (was ${before.version})`}`,
          });
          return { revision: db.org.revision };
        },
        "fresh",
      );
    }, []);
  },
};

/** Resolved through the `@rulebox/release-impl` alias in demo builds. */
export const releaseApi = demoReleaseApi;
