import { v } from "convex/values";
import { env } from "./_generated/server";
import { writeAudit } from "./lib/audit";
import { checkRevision, nextRevision } from "./lib/authz";
import { fail } from "./lib/errors";
import { memberAction, memberMutation, memberQuery } from "./lib/functions";
import { listGithubReleases, releasesRepo, type GithubReleasesResult } from "./lib/githubReleases";
import { requestPublish } from "./lib/publish";
import { MAX_RELEASE_BYTES, normalizeRelease } from "./lib/releaseRules";
import { ruleboxRelease, type RuleboxReleaseValue } from "./lib/validators";

// Rulebox's own update (Phase 6 Step 20, plan 4.17; PRD 23.2, 23.9). The owner names the Rulebox build the organization's PCs
// update to; the publisher puts it into every signed device document as the agent-only key `ruleboxRelease`. The agent
// (`apps/agent/src/selfupdate.rs`) downloads the MSI, checks its SHA-256, and starts the upgrade when no employee is signed
// in. Nothing in this file talks to a device: the signed document is the only way the release reaches one.

// The release rules (`normalizeRelease`, `MAX_RELEASE_BYTES`) live in `lib/releaseRules.ts` (the GitHub picker uses them too).
export { MAX_RELEASE_BYTES, normalizeRelease };

/**
 * The release the organization's PCs update to (viewer), with the organization's revision to send back to `set`. `release` is
 * `null` when none is set (the agents update nothing). One query for the Settings → Updates card: the organization row only
 * (the member wrapper's reads included, 2 documents), no index, never a list. It re-runs only when the organization row changes.
 */
export const get = memberQuery("viewer")({
  args: {},
  returns: v.object({ revision: v.number(), release: v.union(ruleboxRelease, v.null()) }),
  handler: async (ctx) => {
    const org = await ctx.db.get(ctx.orgId);
    if (org === null) fail("not_found");
    return { revision: org.revision ?? 0, release: org.phase6Settings?.ruleboxRelease ?? null };
  },
});

function same(a: RuleboxReleaseValue | undefined, b: RuleboxReleaseValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.version === b.version && a.url === b.url && a.sha256 === b.sha256 && a.sizeBytes === b.sizeBytes;
}

/**
 * Set, change or clear (`null`) the Rulebox build this organization's PCs update to (owner, major: a fresh step-up, because
 * every PC installs this MSI as SYSTEM). `stale_edit` when someone saved the organization in between (the organization's own
 * revision, like `settings:update`). The value is checked here and again by every agent. Nothing changed = no write, no audit,
 * no publish. Otherwise: the organization row, one audit entry `org.ruleboxReleaseChanged`, one publish of every PC (the key
 * is the same everywhere). The version is not compared with the PCs' versions: each agent updates only to a **higher** one,
 * never down, and never retries a release that failed. 2 reads, 3 writes.
 */
export const set = memberMutation("owner", { major: "ruleboxRelease:set" })({
  args: { expectedRevision: v.number(), release: v.union(ruleboxRelease, v.null()) },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(ctx.orgId);
    if (org === null) fail("not_found");
    checkRevision(org, args.expectedRevision);
    const release = args.release === null ? undefined : normalizeRelease(args.release);
    const before = org.phase6Settings?.ruleboxRelease;
    if (same(before, release)) return { revision: org.revision ?? 0 };
    const revision = nextRevision(org);
    // An absent release is an absent key, never `undefined` inside the object.
    const phase6Settings = { ...org.phase6Settings };
    if (release === undefined) delete phase6Settings.ruleboxRelease;
    else phase6Settings.ruleboxRelease = release;
    await ctx.db.patch(org._id, { phase6Settings, revision });
    await requestPublish(ctx, ctx.orgId, { allDevices: true });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "org.ruleboxReleaseChanged",
      targetType: "organization",
      targetId: org._id,
      targetLabel: org.name,
      summary:
        release === undefined
          ? "Cleared the Rulebox release: PCs no longer update Rulebox"
          : `Set the Rulebox release to version ${release.version}${before === undefined ? "" : ` (was ${before.version})`}`,
    });
    return { revision };
  },
});

// ---------------------------------------------------------------- the releases on GitHub (UI pass, Settings -> Updates)

const releaseProblem = v.union(
  v.literal("no_msi"),
  v.literal("two_msis"),
  v.literal("version_mismatch"),
  v.literal("no_checksums"),
  v.literal("checksums_unreadable"),
  v.literal("not_in_checksums"),
  v.literal("hash_mismatch"),
  v.literal("too_large"),
  v.literal("invalid"),
);

const githubRelease = v.object({
  tag: v.string(),
  title: v.string(),
  version: v.string(),
  prerelease: v.boolean(),
  publishedAt: v.number(),
  pageUrl: v.string(),
  notes: v.string(),
  notesTruncated: v.boolean(),
  signed: v.boolean(),
  msi: v.union(v.object({ name: v.string(), url: v.string(), sizeBytes: v.number(), sha256: v.string() }), v.null()),
  problem: v.union(v.null(), releaseProblem),
});

export const githubReleasesResult = v.union(
  v.object({ status: v.literal("ok"), repoUrl: v.string(), checkedAt: v.number(), stale: v.boolean(), releases: v.array(githubRelease) }),
  v.object({
    status: v.literal("unavailable"),
    reason: v.union(v.literal("rate_limited"), v.literal("unreachable"), v.literal("not_found")),
    retryAt: v.optional(v.number()),
  }),
);

/**
 * The newest releases of the Rulebox repository on GitHub, ready to fill the Updates form (owner, an unlocked session; it only reads
 * public data, so it is not a major action: saving stays `ruleboxRelease:set`). Each release comes with the installer's address, size
 * and SHA-256 (from the release's `SHA256SUMS`), or the reason it cannot be used. Never throws for GitHub's sake: the answer says
 * `unavailable` (`rate_limited` with `retryAt`, `unreachable`, `not_found`) or `ok` with `stale: true` when an older list is all there
 * is. Caching is in memory (no database reads or writes beyond the member check): see `lib/githubReleases.ts`. The repository is
 * `zubairbinshaukat/rulebox` unless the deployment sets `RULEBOX_RELEASES_REPO` (`owner/name`); `GITHUB_TOKEN` (optional) raises the limit.
 */
export const githubReleases = memberAction("owner")({
  args: { refresh: v.optional(v.boolean()) },
  returns: githubReleasesResult,
  handler: async (_ctx, args): Promise<GithubReleasesResult> =>
    listGithubReleases({ repo: releasesRepo(env.RULEBOX_RELEASES_REPO), token: env.GITHUB_TOKEN, refresh: args.refresh === true }),
});
