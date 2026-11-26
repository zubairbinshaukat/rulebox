import { v } from "convex/values";
import { writeAudit } from "./lib/audit";
import { checkRevision, nextRevision } from "./lib/authz";
import { fail } from "./lib/errors";
import { isOrdered } from "./lib/feed/version";
import { memberMutation, memberQuery } from "./lib/functions";
import { requestPublish } from "./lib/publish";
import { httpsUrlProblem } from "./lib/appRules";
import { ruleboxRelease, type RuleboxReleaseValue } from "./lib/validators";

// Rulebox's own update (Phase 6 Step 20, plan 4.17; PRD 23.2, 23.9). The owner names the Rulebox build the organization's PCs
// update to; the publisher puts it into every signed device document as the agent-only key `ruleboxRelease`. The agent
// (`apps/agent/src/selfupdate.rs`) downloads the MSI, checks its SHA-256, and starts the upgrade when no employee is signed
// in. Nothing in this file talks to a device: the signed document is the only way the release reaches one.

/** The largest MSI an agent downloads (`MAX_RELEASE_BYTES` in `selfupdate.rs`). */
export const MAX_RELEASE_BYTES = 1024 * 1024 * 1024;
/** `RuleboxRelease.version` is checked by `rulebox_policy::version`: at most 40 characters, `[0-9A-Za-z.+-]`. */
const MAX_RELEASE_VERSION_CHARS = 40;
const SHA256 = /^[0-9a-fA-F]{64}$/;

/**
 * PURE. The release as the agent will accept it (`RuleboxRelease::check_limits`, a second check of the same rules): an ordered
 * version of at most 40 characters, an `https://` URL without credentials, a SHA-256 (stored in lower case) and a size from 1 byte to
 * 1 GiB. `invalid_argument` names the field. The version is trimmed; nothing else is changed.
 */
export function normalizeRelease(input: RuleboxReleaseValue): RuleboxReleaseValue {
  const version = input.version.trim();
  if (version.length === 0 || version.length > MAX_RELEASE_VERSION_CHARS || !isOrdered(version)) {
    fail("invalid_argument", { field: "release.version" });
  }
  if (httpsUrlProblem(input.url)) fail("invalid_argument", { field: "release.url" });
  if (!SHA256.test(input.sha256)) fail("invalid_argument", { field: "release.sha256" });
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_RELEASE_BYTES) {
    fail("invalid_argument", { field: "release.sizeBytes" });
  }
  return { version, url: input.url, sha256: input.sha256.toLowerCase(), sizeBytes: input.sizeBytes };
}

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
