import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx, type DatabaseReader, type MutationCtx } from "./_generated/server";
import { publishApp, snapshotAppGroups } from "./lib/appPublish";
import { normalizeDesktop, previousFor } from "./lib/appRules";
import { SYSTEM_ACTOR, writeAudit, type AuditActor } from "./lib/audit";
import { checkRevision, getInOrg, nextRevision } from "./lib/authz";
import { fail } from "./lib/errors";
import { checkFeed, type FeedOutcome } from "./lib/feed/resolve";
import {
  FEED_BACKOFF_MS,
  FEED_CHECK_INTERVAL_MS,
  FEED_JITTER_MS,
  FEED_PAUSED_FOR_MS,
  FEED_TICK_BATCH,
  FEED_WARN_FAILURES,
} from "./lib/feed/limits";
import { compareVersions } from "./lib/feed/version";
import { internalMutation, internalQuery, memberAction, memberMutation } from "./lib/functions";
import { consumeOrFail } from "./lib/rateLimits";
import { appFeedStatus } from "./lib/validators";

// The server-side feed resolver (plan Phase 6, 4.5; Step 12). Rulebox-managed apps (4.4.4) with a vendor feed are checked
// once a day by ONE hourly cron: `feeds:tick` claims the feeds that are due (reads nothing when none is), `feeds:check`
// (an action) reads `latest.json`, downloads and verifies the installer it names, and `feeds:recordResult` stores what was
// found and, with `autoPublish`, publishes the new version through the same path as an admin edit (`publishRelease`).
// No device takes part, no query reads the feed, the downloaded installer is never stored (only its SHA-256 and size).

type AppDesktop = NonNullable<Doc<"apps">["desktop"]>;
type Release = { version: string; url: string; sha256: string; sizeBytes: number };

// ---------------------------------------------------------------- shapes

const failureStatus = v.union(v.literal("unreachable"), v.literal("bad_signature"), v.literal("bad_feed"), v.literal("too_large"));

/** What `checkFeed` found (`lib/feed/resolve.ts`). */
const outcomeValue = v.union(
  v.object({ kind: v.literal("not_modified") }),
  v.object({ kind: v.literal("current"), version: v.string(), etag: v.optional(v.string()) }),
  v.object({ kind: v.literal("downgrade"), version: v.string(), etag: v.optional(v.string()) }),
  v.object({ kind: v.literal("new"), version: v.string(), url: v.string(), sha256: v.string(), sizeBytes: v.number(), etag: v.optional(v.string()) }),
  v.object({ kind: v.literal("failed"), status: failureStatus, etag: v.optional(v.string()) }),
);

const checkResult = v.object({
  result: v.union(v.literal("skipped"), v.literal("unchanged"), v.literal("published"), v.literal("pending"), v.literal("failed")),
  /** The feed's status after the check (absent when the check was skipped). */
  status: v.optional(appFeedStatus),
  /** The version found, when there is a new one (published or offered). */
  version: v.optional(v.string()),
});
type CheckResult = Infer<typeof checkResult>;

// ---------------------------------------------------------------- rows

async function feedRowOf(ctx: { db: DatabaseReader }, appId: Id<"apps">): Promise<Doc<"appFeeds"> | null> {
  return await ctx.db
    .query("appFeeds")
    .withIndex("by_app", (q) => q.eq("appId", appId))
    .first();
}

/** The feed settings of a Managed program, or undefined. */
function feedConfigOf(app: Doc<"apps">) {
  return app.kind === "desktop" && app.desktop?.update?.mode === "managed" ? app.desktop.update.feed : undefined;
}

/**
 * The mark the Apps list shows for a feed (plan 4.16, `apps.updateFlag`): a version waiting for approval wins over a problem;
 * a problem is a refused signature, an unreadable feed or an installer over the cap, or an unreachable feed that failed
 * `FEED_WARN_FAILURES` checks in a row (plan 4.5 item 3). A paused feed, a calm `downgrade` and a working feed have none.
 */
export function updateFlagOf(row: Pick<Doc<"appFeeds">, "status" | "failures" | "pending">): Doc<"apps">["updateFlag"] {
  if (row.pending !== undefined) return "available";
  if (row.status === "bad_signature" || row.status === "bad_feed" || row.status === "too_large") return "feed_error";
  if (row.status === "unreachable" && row.failures >= FEED_WARN_FAILURES) return "feed_error";
  return undefined;
}

/** Writes the app's `updateFlag` only when it differs (no revision bump: it is not an edit of the app). */
async function syncUpdateFlag(ctx: Pick<MutationCtx, "db">, app: Doc<"apps">, row: Pick<Doc<"appFeeds">, "status" | "failures" | "pending">): Promise<void> {
  const flag = updateFlagOf(row);
  if (app.updateFlag !== flag) await ctx.db.patch(app._id, { updateFlag: flag });
}

/**
 * `patch` with only the fields that differ from the stored row (write only on change). `undefined` removes a field. Keeps the
 * app's `updateFlag` in step with the new row state (a second write only when the flag changes).
 */
async function patchChanged(ctx: Pick<MutationCtx, "db">, app: Doc<"apps">, row: Doc<"appFeeds">, fields: Partial<Record<keyof Doc<"appFeeds">, unknown>>): Promise<boolean> {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const old = (row as Record<string, unknown>)[key];
    const same = key === "pending" ? JSON.stringify(old ?? null) === JSON.stringify(value ?? null) : old === value;
    if (!same) changed[key] = value;
  }
  if (Object.keys(changed).length === 0) {
    await syncUpdateFlag(ctx, app, row);
    return false;
  }
  await ctx.db.patch(row._id, changed);
  await syncUpdateFlag(ctx, app, { ...row, ...changed });
  return true;
}

// ---------------------------------------------------------------- publishing a version

/**
 * Put `release` into the app's installer, in the caller's transaction (the same steps as `apps:update`: validation,
 * `previous` kept by `previousFor`, a new revision, a configuration version for the groups that assign the app, a
 * republish). Returns the new revision, or null when the stored spec no longer validates with the new coordinates (nothing
 * is written then). An MSI product code belongs to ONE version: it is dropped, the agent finds the product by its files.
 */
async function publishRelease(
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  app: Doc<"apps">,
  release: Release,
  by: { actor: AuditActor; memberId?: Id<"members">; summary: string },
): Promise<number | null> {
  const d: AppDesktop | undefined = app.desktop;
  if (app.kind !== "desktop" || d === undefined || d.install === undefined || d.update?.mode !== "managed") return null;
  const install = { ...d.install, url: release.url, sha256: release.sha256, sizeBytes: release.sizeBytes };
  delete install.productCode;
  let normalized: AppDesktop;
  try {
    normalized = normalizeDesktop({ ...d, version: release.version, install }, app._id);
  } catch {
    return null;
  }
  const previous = previousFor(d, normalized);
  const desktop = previous !== undefined ? { ...normalized, previous } : normalized;
  const revision = nextRevision(app);
  await ctx.db.patch(app._id, { desktop, revision });
  await writeAudit(ctx, {
    orgId: app.orgId,
    actor: by.actor,
    action: "app.updated",
    targetType: "app",
    targetId: app._id,
    targetLabel: app.name,
    summary: by.summary,
  });
  await snapshotAppGroups(ctx, [app._id], `App ${app.name}`, by.memberId);
  await publishApp(ctx, app.orgId, app._id);
  return revision;
}

// ---------------------------------------------------------------- the tick (the one cron)

/**
 * Hourly (`crons.ts`). Claims the feeds that are due: `nextCheckAt` moves a day (plus 0-60 minutes of jitter) ahead and
 * `lastCheckedAt` is set BEFORE the check is scheduled, so a second tick, or a check that fails half way, cannot start the
 * same check again. At most FEED_TICK_BATCH per run; the rest wait for the next hour. Nothing due = one empty range read.
 * A paused feed that is somehow due is pushed out again and not checked.
 */
export const tick = internalMutation({
  args: { now: v.optional(v.number()) },
  returns: v.object({ claimed: v.number() }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const due = await ctx.db
      .query("appFeeds")
      .withIndex("by_next_check", (q) => q.lte("nextCheckAt", now))
      .take(FEED_TICK_BATCH);
    let claimed = 0;
    for (const row of due) {
      if (row.status === "paused") {
        await ctx.db.patch(row._id, { nextCheckAt: now + FEED_PAUSED_FOR_MS });
        continue;
      }
      await ctx.db.patch(row._id, { nextCheckAt: now + FEED_CHECK_INTERVAL_MS + Math.floor(Math.random() * FEED_JITTER_MS), lastCheckedAt: now });
      await ctx.scheduler.runAfter(0, internal.feeds.check, { feedId: row._id });
      claimed++;
    }
    return { claimed };
  },
});

// ---------------------------------------------------------------- one check

/** What the action needs: the feed's settings and state, and the app's version. Null = nothing to check (gone, not Managed any more, paused). */
export const loadForCheck = internalQuery({
  args: { feedId: v.id("appFeeds") },
  returns: v.union(
    v.null(),
    v.object({
      revision: v.number(),
      etag: v.optional(v.string()),
      seenVersion: v.optional(v.string()),
      feed: v.object({ url: v.string(), pubkey: v.string(), target: v.string() }),
      installKind: v.optional(v.union(v.literal("msi"), v.literal("exe"), v.literal("portable"))),
      appVersion: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.feedId);
    if (row === null || row.status === "paused") return null;
    const app = await ctx.db.get(row.appId);
    if (app === null || app.archived) return null;
    const feed = feedConfigOf(app);
    if (feed === undefined) return null;
    return {
      revision: row.revision,
      ...(row.etag !== undefined ? { etag: row.etag } : {}),
      ...(row.seenVersion !== undefined ? { seenVersion: row.seenVersion } : {}),
      feed: { url: feed.url, pubkey: feed.pubkey, target: feed.target },
      ...(app.desktop?.install !== undefined ? { installKind: app.desktop.install.kind } : {}),
      ...(app.desktop?.version !== undefined ? { appVersion: app.desktop.version } : {}),
    };
  },
});

/**
 * Stores what a check found. `feedRevision` is the revision the check started with: when an admin changed the feed settings
 * meanwhile (`apps.ts` bumps it), the result belongs to the old settings and is dropped. Writes only what differs: the
 * claim of the tick already moved `nextCheckAt`, so "nothing new" writes nothing; a failure counts (`failures`) and
 * `unreachable` backs off (1 h, 4 h, then 24 h). A bad signature is audited once, when it first appears.
 */
export const recordResult = internalMutation({
  args: { feedId: v.id("appFeeds"), feedRevision: v.number(), outcome: outcomeValue, touch: v.optional(v.boolean()) },
  returns: checkResult,
  handler: async (ctx, args): Promise<CheckResult> => {
    const row = await ctx.db.get(args.feedId);
    if (row === null || row.revision !== args.feedRevision || row.status === "paused") return { result: "skipped" };
    const app = await ctx.db.get(row.appId);
    if (app === null || feedConfigOf(app) === undefined) return { result: "skipped" };
    const o: FeedOutcome = args.outcome;
    const now = Date.now();
    const touch = args.touch === true ? { lastCheckedAt: now } : {};
    const appVersion = app.desktop?.version;

    // Fields every "the feed answered" outcome sets.
    const answered = { status: "ok" as const, failures: 0 };

    switch (o.kind) {
      case "not_modified": {
        // The same file as last time: only a check that failed to reach the feed gets back to "ok".
        await patchChanged(ctx, app, row, { ...(row.status === "unreachable" ? answered : {}), ...touch });
        return { result: "unchanged", status: row.status === "unreachable" ? "ok" : row.status };
      }
      case "downgrade": {
        await patchChanged(ctx, app, row, { status: "downgrade", failures: 0, etag: o.etag, ...touch });
        return { result: "unchanged", status: "downgrade" };
      }
      case "current": {
        const higher = row.seenVersion === undefined || compareVersions(o.version, row.seenVersion) === 1;
        // An offer that the app has caught up with (an admin published it by hand) is no offer any more.
        const stale = row.pending !== undefined && (appVersion === undefined || compareVersions(row.pending.version, appVersion) !== 1);
        await patchChanged(ctx, app, row, {
          ...answered,
          etag: o.etag,
          ...(higher ? { seenVersion: o.version } : {}),
          ...(stale ? { pending: undefined } : {}),
          ...touch,
        });
        return { result: "unchanged", status: "ok" };
      }
      case "failed": {
        // `failures` counts consecutive checks that ended the same way (a different failure starts again at 1), so the
        // backoff of an unreachable feed is not shortened or lengthened by an earlier, different problem.
        const failures = row.status === o.status ? row.failures + 1 : 1;
        // A network error keeps the stored etag (the file may be unchanged); every other failure is about this release and keeps its own.
        const etag = o.status === "unreachable" ? row.etag : o.etag;
        const backoff = o.status === "unreachable" ? { nextCheckAt: now + FEED_BACKOFF_MS[Math.min(failures, FEED_BACKOFF_MS.length) - 1]! } : {};
        await patchChanged(ctx, app, row, { status: o.status, failures, etag, ...backoff, ...touch });
        if (o.status === "bad_signature" && row.status !== "bad_signature") {
          await writeAudit(ctx, {
            orgId: app.orgId,
            actor: SYSTEM_ACTOR,
            action: "app.feedRejected",
            targetType: "app",
            targetId: app._id,
            targetLabel: app.name,
            summary: `Refused an update of ${app.name}: its signature did not match the vendor key`,
          });
        }
        return { result: "failed", status: o.status };
      }
      case "new": {
        // Someone may have published (or rolled back) while the installer was downloading: only a version above the app's counts.
        if (appVersion === undefined || compareVersions(o.version, appVersion) !== 1) {
          await patchChanged(ctx, app, row, { ...answered, etag: o.etag, ...touch });
          return { result: "unchanged", status: "ok" };
        }
        const release: Release = { version: o.version, url: o.url, sha256: o.sha256, sizeBytes: o.sizeBytes };
        if (app.desktop?.update?.autoPublish !== false) {
          const revision = await publishRelease(ctx, app, release, {
            actor: SYSTEM_ACTOR,
            summary: `Updated ${app.name} from ${appVersion} to ${o.version} (vendor feed)`,
          });
          if (revision === null) {
            // The app's own settings refuse the new installer: nothing changed, shown as a bad feed, the etag not kept so a fix is seen.
            await patchChanged(ctx, app, row, { status: "bad_feed", failures: row.failures + 1, etag: undefined, ...touch });
            return { result: "failed", status: "bad_feed" };
          }
          await patchChanged(ctx, app, row, { ...answered, etag: o.etag, seenVersion: o.version, pending: undefined, ...touch });
          return { result: "published", status: "ok", version: o.version };
        }
        await patchChanged(ctx, app, row, {
          ...answered,
          etag: o.etag,
          seenVersion: o.version,
          pending: { ...release, foundAt: now },
          ...touch,
        });
        return { result: "pending", status: "ok", version: o.version };
      }
    }
  },
});

/** Load, check, record. Shared by the action the scheduler runs and by "Check now". The only `fetch` of this file is inside `checkFeed`. */
async function runCheck(ctx: Pick<ActionCtx, "runQuery" | "runMutation">, feedId: Id<"appFeeds">, touch: boolean): Promise<CheckResult> {
  const loaded = await ctx.runQuery(internal.feeds.loadForCheck, { feedId });
  if (loaded === null) return { result: "skipped" };
  const outcome = await checkFeed({
    feed: loaded.feed,
    ...(loaded.installKind !== undefined ? { installKind: loaded.installKind } : {}),
    ...(loaded.appVersion !== undefined ? { appVersion: loaded.appVersion } : {}),
    ...(loaded.seenVersion !== undefined ? { seenVersion: loaded.seenVersion } : {}),
    ...(loaded.etag !== undefined ? { etag: loaded.etag } : {}),
  });
  return await ctx.runMutation(internal.feeds.recordResult, { feedId, feedRevision: loaded.revision, outcome, ...(touch ? { touch: true } : {}) });
}

/** Scheduled by `feeds:tick` (one per claimed feed). */
export const check = internalAction({
  args: { feedId: v.id("appFeeds") },
  returns: checkResult,
  handler: async (ctx, args): Promise<CheckResult> => await runCheck(ctx, args.feedId, false),
});

// ---------------------------------------------------------------- admin

/** The feed of an app of the caller's organization (for "Check now"): `not_found` for another organization's app, `invalid_argument` when there is no feed. */
export const feedForApp = internalQuery({
  args: { orgId: v.id("organizations"), appId: v.string() },
  returns: v.object({ feedId: v.id("appFeeds"), paused: v.boolean() }),
  handler: async (ctx, args) => {
    const app = await getInOrg(ctx, "apps", args.appId, args.orgId);
    if (feedConfigOf(app) === undefined) fail("invalid_argument", { field: "appId" });
    const row = await feedRowOf(ctx, app._id);
    if (row === null) fail("invalid_argument", { field: "appId" });
    return { feedId: row._id, paused: row.status === "paused" };
  },
});

/**
 * "Check now" (admin): the same check as the daily one, at once. One per five minutes per app (`rate_limited`).
 * `invalid_argument` (field "appId") for an app without a feed, `conflict` (detail "paused") while the feed is paused.
 * Answers what the check did; the app page shows the details through `apps:get`.
 */
export const checkNow = memberAction("admin")({
  args: { appId: v.string() },
  returns: checkResult,
  handler: async (ctx, args): Promise<CheckResult> => {
    const target = await ctx.runQuery(internal.feeds.feedForApp, { orgId: ctx.orgId, appId: args.appId });
    if (target.paused) fail("conflict", { detail: "paused" });
    await consumeOrFail(ctx, "feedCheckNow", target.feedId);
    return await runCheck(ctx, target.feedId, true);
  },
});

/** The Managed app with a feed and its row, for the three admin mutations below. `invalid_argument` (field "appId") for anything else. */
async function feedTarget(ctx: { db: DatabaseReader }, appId: string, orgId: Id<"organizations">, expectedRevision: number | undefined) {
  const app = await getInOrg(ctx, "apps", appId, orgId);
  if (expectedRevision !== undefined) checkRevision(app, expectedRevision);
  if (feedConfigOf(app) === undefined) fail("invalid_argument", { field: "appId" });
  const row = await feedRowOf(ctx, app._id);
  if (row === null) fail("invalid_argument", { field: "appId" });
  return { app, row };
}

/**
 * Approve the offered version (admin; only with `autoPublish` off): published exactly like an admin edit, under a new
 * revision. `stale_edit` when someone saved in between (two admins approving at once: the second one gets it).
 * `invalid_argument` field "pending" when nothing is offered, or the offer is not above the app's version any more.
 */
export const approve = memberMutation("admin")({
  args: { appId: v.string(), expectedRevision: v.number() },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const { app, row } = await feedTarget(ctx, args.appId, ctx.orgId, args.expectedRevision);
    const pending = row.pending;
    if (pending === undefined) fail("invalid_argument", { field: "pending" });
    const current = app.desktop?.version;
    if (current === undefined || compareVersions(pending.version, current) !== 1) fail("invalid_argument", { field: "pending" });
    const revision = await publishRelease(
      ctx,
      app,
      { version: pending.version, url: pending.url, sha256: pending.sha256, sizeBytes: pending.sizeBytes },
      { actor: ctx.actor, memberId: ctx.member._id, summary: `Approved the update of ${app.name} from ${current} to ${pending.version}` },
    );
    if (revision === null) fail("invalid_argument", { field: "pending" });
    await ctx.db.patch(row._id, { pending: undefined });
    await syncUpdateFlag(ctx, app, { status: row.status, failures: row.failures, pending: undefined });
    return { revision };
  },
});

/** Dismiss the offered version (admin): it is not offered again (`seenVersion` stays); a newer one is. */
export const dismiss = memberMutation("admin")({
  args: { appId: v.string(), expectedRevision: v.number() },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const { app, row } = await feedTarget(ctx, args.appId, ctx.orgId, args.expectedRevision);
    if (row.pending === undefined) fail("invalid_argument", { field: "pending" });
    const version = row.pending.version;
    await ctx.db.patch(row._id, { pending: undefined });
    await syncUpdateFlag(ctx, app, { status: row.status, failures: row.failures, pending: undefined });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "app.updated",
      targetType: "app",
      targetId: app._id,
      targetLabel: app.name,
      summary: `Dismissed the update of ${app.name} to ${version}`,
    });
    return { revision: app.revision };
  },
});

/**
 * Pause or resume the checks of one app's feed (admin; plan 4.5 item 6). Paused: `status` "paused" and the next check ten
 * years away, so the tick's range never reaches it. Resumed: due at once (the next tick). The app itself does not change.
 * The same state again = no write.
 */
export const setPaused = memberMutation("admin")({
  args: { appId: v.string(), paused: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { app, row } = await feedTarget(ctx, args.appId, ctx.orgId, undefined);
    if ((row.status === "paused") === args.paused) return null;
    await ctx.db.patch(
      row._id,
      args.paused ? { status: "paused", nextCheckAt: Date.now() + FEED_PAUSED_FOR_MS } : { status: "ok", failures: 0, nextCheckAt: Date.now() },
    );
    await syncUpdateFlag(ctx, app, { status: args.paused ? "paused" : "ok", failures: args.paused ? row.failures : 0, pending: row.pending });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "app.updated",
      targetType: "app",
      targetId: app._id,
      targetLabel: app.name,
      summary: `${args.paused ? "Paused" : "Resumed"} the update checks of ${app.name}`,
    });
    return null;
  },
});
