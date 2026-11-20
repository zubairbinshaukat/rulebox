/**
 * Demo twin of `convex/feeds.ts` (Phase 6 Step 12): Approve, Dismiss, Check now and Pause of a Managed program's vendor feed, the
 * `feedStatus` of the app page and the `updateFlag` of the Apps list. Same rules as the server (roles, `expectedRevision`, the
 * refusals, one "Check now" per five minutes per app). The demo has no network: a check "finds" the next patch version of the
 * program, once, so every path (published, waiting for approval, nothing new) can be tried.
 */
import { useCallback } from "react";
import type { DbApp, DbFeed } from "../fixtures/seed";
import type { AppUpdateFlag, FeedCheckResult, FeedStatus } from "../types";
import { numbersAbove } from "../../lib/apps/updateRules";
import { checkRevision, fail, runMutation } from "./store";

const HOUR = 60 * 60 * 1000;
/** Plan 4.5 item 4: Check now is limited to one per five minutes per app. */
const CHECK_NOW_GAP_MS = 5 * 60_000;
/** Plan 4.5 item 3: after this many failed checks in a row the app page shows a warning. */
const WARN_FAILURES = 7;

/** The feed settings of a Managed program, or undefined (the server's `feedConfigOf`). */
function feedConfigOf(a: DbApp) {
  return a.kind === "desktop" && a.desktop?.update?.mode === "managed" ? a.desktop.update.feed : undefined;
}

/** The row a feed that has just been created would have: working, checked a few hours ago, at the program's own version. */
function freshFeed(a: DbApp): DbFeed {
  return { status: "ok", failures: 0, lastCheckedAt: Date.now() - 3 * HOUR, ...(a.desktop?.version ? { seenVersion: a.desktop.version } : {}) };
}

/** The mark the Apps list shows (the server's `updateFlagOf`). */
function flagOf(f: DbFeed): AppUpdateFlag | undefined {
  if (f.pending) return "available";
  if (f.status === "bad_signature" || f.status === "bad_feed" || f.status === "too_large") return "feed_error";
  if (f.status === "unreachable" && f.failures >= WARN_FAILURES) return "feed_error";
  return undefined;
}

/** `apps:list` `updateFlag` for a demo app (nothing for an app without a feed). */
export function demoUpdateFlag(a: DbApp): AppUpdateFlag | undefined {
  return feedConfigOf(a) === undefined ? undefined : flagOf(a.feed ?? freshFeed(a));
}

/** `apps:get` `feedStatus` for a demo app (absent for an app without a feed). */
export function demoFeedStatus(a: DbApp): FeedStatus | undefined {
  if (feedConfigOf(a) === undefined) return undefined;
  const f = a.feed ?? freshFeed(a);
  return {
    status: f.status,
    failures: f.failures,
    ...(f.lastCheckedAt !== undefined ? { lastCheckedAt: f.lastCheckedAt } : {}),
    ...(f.seenVersion !== undefined ? { seenVersion: f.seenVersion } : {}),
    ...(f.pending ? { pending: { ...f.pending } } : {}),
  };
}

/** Changed feed settings start a clean row (the server's `syncFeedRow`): call it with the settings before and after an edit. */
export function resetDemoFeedOnEdit(a: DbApp, before: DbApp["desktop"]): void {
  const was = before?.update?.mode === "managed" ? before.update.feed : undefined;
  const now = feedConfigOf(a);
  if (JSON.stringify(was ?? null) !== JSON.stringify(now ?? null)) delete a.feed;
}

/** The program a feed action is about: Managed with a feed, in the demo organization. `invalid_argument` (field `appId`) otherwise. */
function target(apps: DbApp[], appId: string, expectedRevision?: number): { app: DbApp; feed: DbFeed } {
  const app = apps.find((x) => x._id === appId);
  if (!app) fail("not_found");
  if (expectedRevision !== undefined) checkRevision(app, expectedRevision);
  if (feedConfigOf(app) === undefined) fail("invalid_argument", { field: "appId" });
  return { app, feed: (app.feed ??= freshFeed(app)) };
}

/** The next patch version: "2.0.0" -> "2.0.1", "2.4" -> "2.4.1". */
function nextPatch(version: string): string {
  const nums = (version.split("-")[0] ?? "").split(".").map((x) => Number(x));
  while (nums.length < 3) nums.push(0);
  nums[2] = (nums[2] ?? 0) + 1;
  return nums.join(".");
}

/** What the server's `publishRelease` does: the new installer goes in, the old one becomes `previous`, a new revision. */
function publish(a: DbApp, version: string): void {
  const d = a.desktop;
  if (!d || !d.install) fail("invalid_argument", { field: "pending" });
  const url = d.install.url.includes(d.version ?? "\u0000") ? d.install.url.replace(d.version!, version) : `${d.install.url}?v=${version}`;
  let sha = "";
  for (let i = 0; i < 64; i++) sha += "0123456789abcdef"[(i * 5 + version.length + version.charCodeAt(i % version.length)) % 16];
  const previous = { version: d.version ?? "", url: d.install.url, sha256: d.install.sha256, sizeBytes: d.install.sizeBytes };
  const next = { ...d, version, install: { ...d.install, url, sha256: sha } };
  if (d.version !== undefined) next.previous = previous;
  a.desktop = next;
  a.revision++;
}

export function useDemoApproveFeedUpdate() {
  return useCallback(
    ({ appId, expectedRevision }: { appId: string; expectedRevision: number }) =>
      runMutation("admin", ({ db, audit }) => {
        const { app, feed } = target(db.apps, appId, expectedRevision);
        const current = app.desktop?.version;
        if (!feed.pending || !current || !numbersAbove(feed.pending.version, current)) fail("invalid_argument", { field: "pending" });
        const version = feed.pending.version;
        publish(app, version);
        delete feed.pending;
        audit({ action: "app.updated", targetType: "app", targetId: app._id, targetLabel: app.name, summary: `Approved the update of ${app.name} from ${current} to ${version}` });
        return { revision: app.revision };
      }),
    [],
  );
}

export function useDemoDismissFeedUpdate() {
  return useCallback(
    ({ appId, expectedRevision }: { appId: string; expectedRevision: number }) =>
      runMutation("admin", ({ db, audit }) => {
        const { app, feed } = target(db.apps, appId, expectedRevision);
        if (!feed.pending) fail("invalid_argument", { field: "pending" });
        const version = feed.pending.version;
        delete feed.pending;
        audit({ action: "app.updated", targetType: "app", targetId: app._id, targetLabel: app.name, summary: `Dismissed the update of ${app.name} to ${version}` });
        return { revision: app.revision };
      }),
    [],
  );
}

export function useDemoSetFeedPaused() {
  return useCallback(
    ({ appId, paused }: { appId: string; paused: boolean }) =>
      runMutation("admin", ({ db, audit }) => {
        const { app, feed } = target(db.apps, appId);
        if ((feed.status === "paused") === paused) return;
        feed.status = paused ? "paused" : "ok";
        if (!paused) feed.failures = 0;
        audit({ action: "app.updated", targetType: "app", targetId: app._id, targetLabel: app.name, summary: `${paused ? "Paused" : "Resumed"} the update checks of ${app.name}` });
      }),
    [],
  );
}

export function useDemoCheckFeedNow() {
  return useCallback(
    ({ appId }: { appId: string }) =>
      runMutation("admin", ({ db, audit, now }): FeedCheckResult => {
        const { app, feed } = target(db.apps, appId);
        if (feed.status === "paused") fail("conflict", { detail: "paused" });
        if (feed.lastCheckNowAt !== undefined && now - feed.lastCheckNowAt < CHECK_NOW_GAP_MS) fail("rate_limited", { retryAfterMs: CHECK_NOW_GAP_MS - (now - feed.lastCheckNowAt) });
        feed.lastCheckNowAt = now;
        feed.lastCheckedAt = now;
        feed.failures = 0;
        feed.status = "ok";
        const current = app.desktop?.version;
        // Something already found (offered or published) is not found again; a program without an ordered version has nothing to compare.
        if (!current || feed.found || feed.pending || (feed.seenVersion !== undefined && numbersAbove(feed.seenVersion, current))) return { result: "unchanged", status: "ok" };
        const version = nextPatch(current);
        feed.seenVersion = version;
        feed.found = true;
        if (app.desktop?.update?.autoPublish === false) {
          feed.pending = { version, foundAt: now };
          return { result: "pending", status: "ok", version };
        }
        publish(app, version);
        audit({ action: "app.updated", targetType: "app", targetId: app._id, targetLabel: app.name, summary: `Updated ${app.name} from ${current} to ${version} (vendor feed)` });
        return { result: "published", status: "ok", version };
      }),
    [],
  );
}
