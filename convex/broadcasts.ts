import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { DatabaseReader } from "./_generated/server";
import { writeAudit } from "./lib/audit";
import { getInOrg } from "./lib/authz";
import { fail } from "./lib/errors";
import { credOf } from "./lib/fleet";
import { memberMutation, memberQuery } from "./lib/functions";
import { checkPageSize, pickSort, sortArg } from "./lib/listing";
import {
  GROUP_COUNT_CAP,
  MAX_BROADCAST_BODY,
  MAX_BROADCAST_LIFETIME_MS,
  MAX_BROADCAST_PAGE,
  MAX_BROADCAST_TITLE,
  MAX_ORG_ACTIVE_BROADCASTS,
} from "./lib/limits";
import { broadcastStyle } from "./lib/lockdownValidators";
import { requestPublish } from "./lib/publish";
import { cleanNoticeText } from "./lib/noticeText";

// Broadcast messages (Phase 5 Step 15, plan 4.17; PRD 24.4). A message goes to one group or one PC, is shown as a banner or
// a full-screen notice, and may ask for an acknowledgement. It reaches the agent through the signed document (the
// publisher carries the <= 5 newest live broadcasts per PC, expired and cancelled ones dropped: `publish.ts`); the agent
// reports acknowledgements with `deviceApi:reportAcks`, never the employee's identity.
//
// I/O: the list is paginated (`broadcasts.by_org_created`, newest first; a page reads <= 50 rows plus the names of the
// groups and PCs they point to, from a per-query cache). The "<= 20 active per organization" rule reads two bounded
// ranges of `broadcasts.by_org_open` (never cancelled, no expiry / expiry in the future), <= 21 rows each. The ack
// counters live on the broadcast row itself (`ackCount`, `targetCount`), so no acknowledgement row is ever read here.

const target = v.object({ kind: v.union(v.literal("group"), v.literal("device")), id: v.string() });

const broadcastRow = v.object({
  _id: v.id("broadcasts"),
  target: v.object({
    kind: v.union(v.literal("group"), v.literal("device")),
    id: v.string(),
    /** The group's or PC's name now; null when it no longer exists. */
    name: v.union(v.string(), v.null()),
  }),
  style: broadcastStyle,
  title: v.string(),
  body: v.string(),
  expiresAt: v.union(v.number(), v.null()),
  ackRequired: v.boolean(),
  createdAt: v.number(),
  cancelledAt: v.union(v.number(), v.null()),
  /** PCs it was aimed at when it was sent (a group's count is capped at GROUP_COUNT_CAP), and PCs that acknowledged it. */
  targetCount: v.number(),
  ackCount: v.number(),
});

/**
 * The organization's broadcasts, newest first (viewer; paginated; the only sort key is "sent", either direction). Status is the caller's to work out from `cancelledAt`
 * and `expiresAt` (no clock is read here, so the query is not re-run for it).
 */
export const list = memberQuery("viewer")({
  args: { paginationOpts: paginationOptsValidator, sort: sortArg },
  returns: paginationResultValidator(broadcastRow),
  handler: async (ctx, args) => {
    checkPageSize(args.paginationOpts.numItems, MAX_BROADCAST_PAGE);
    const sort = pickSort("broadcasts", args.sort);
    const result = await ctx.db
      .query("broadcasts")
      .withIndex("by_org_created", (q) => q.eq("orgId", ctx.orgId))
      .order(sort.dir)
      .paginate(args.paginationOpts);
    return { ...result, page: await rowsOf(ctx, result.page) };
  },
});

/** The shown fields of broadcast rows plus the current name of each target (a per-call cache: one get per distinct group / PC). */
async function rowsOf(ctx: { db: DatabaseReader }, docs: Doc<"broadcasts">[]) {
  const names = new Map<string, string | null>();
  const nameOf = async (kind: "group" | "device", id: string): Promise<string | null> => {
    const key = `${kind}:${id}`;
    const hit = names.get(key);
    if (hit !== undefined) return hit;
    let name: string | null;
    if (kind === "group") {
      const gid = ctx.db.normalizeId("groups", id);
      const g = gid === null ? null : await ctx.db.get(gid);
      name = g === null ? null : g.name;
    } else {
      const did = ctx.db.normalizeId("devices", id);
      const d = did === null ? null : await ctx.db.get(did);
      name = d === null ? null : d.name;
    }
    names.set(key, name);
    return name;
  };
  const page = [];
  for (const b of docs) {
    page.push({
      _id: b._id,
      target: { kind: b.target.kind, id: b.target.id, name: await nameOf(b.target.kind, b.target.id) },
      style: b.style,
      title: b.title,
      body: b.body,
      expiresAt: b.expiresAt ?? null,
      ackRequired: b.ackRequired,
      createdAt: b.createdAt,
      cancelledAt: b.cancelledAt ?? null,
      targetCount: b.targetCount ?? 0,
      ackCount: b.ackCount ?? 0,
    });
  }
  return page;
}

/**
 * The messages that may still be showing on the PCs, for the "On your PCs now" strip (viewer; UI pass other-pages plan 5.2).
 * Two bounded ranges of `broadcasts.by_org_open`: never cancelled with no expiry (<= LIVE_RANGE rows) and never cancelled with
 * an expiry, LARGEST expiry first (<= LIVE_RANGE rows; every live timed message is among them because the organization has at most
 * MAX_ORG_ACTIVE_BROADCASTS = 20 live ones and the live ones expire last). No clock is read here, so the query is not re-run by time:
 * the caller drops the rows whose `expiresAt` has passed with its own clock. Newest sent first, <= 2 x LIVE_RANGE rows.
 */
const LIVE_RANGE = MAX_ORG_ACTIVE_BROADCASTS + 1;
export const live = memberQuery("viewer")({
  args: {},
  returns: v.array(broadcastRow),
  handler: async (ctx) => {
    const forever = await ctx.db
      .query("broadcasts")
      .withIndex("by_org_open", (q) => q.eq("orgId", ctx.orgId).eq("cancelledAt", undefined).eq("expiresAt", undefined))
      .take(LIVE_RANGE);
    const timed = await ctx.db
      .query("broadcasts")
      .withIndex("by_org_open", (q) => q.eq("orgId", ctx.orgId).eq("cancelledAt", undefined).gt("expiresAt", 0))
      .order("desc")
      .take(LIVE_RANGE);
    const rows = await rowsOf(ctx, [...forever, ...timed]);
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  },
});

/** Broadcasts that are live now (not cancelled, not expired) in the organization: two bounded index ranges, at most `limit + 1` each. */
async function liveCount(ctx: { db: DatabaseReader }, orgId: Id<"organizations">, now: number, limit: number): Promise<number> {
  const forever = await ctx.db
    .query("broadcasts")
    .withIndex("by_org_open", (q) => q.eq("orgId", orgId).eq("cancelledAt", undefined).eq("expiresAt", undefined))
    .take(limit + 1);
  if (forever.length > limit) return forever.length;
  const timed = await ctx.db
    .query("broadcasts")
    .withIndex("by_org_open", (q) => q.eq("orgId", orgId).eq("cancelledAt", undefined).gt("expiresAt", now))
    .take(limit + 1);
  return forever.length + timed.length;
}

/**
 * Send a message to a group or one PC (admin). `title` 1-80 and `body` 1-500 characters of plain text (the Staff App never
 * renders HTML); `expiresAt` (optional) must be in the future and at most a year ahead; at most
 * MAX_ORG_ACTIVE_BROADCASTS live broadcasts per organization (`too_large`, detail "active"). A revoked PC cannot be a
 * target. Audits `broadcast.sent` and publishes the target's PCs.
 */
export const send = memberMutation("admin")({
  args: {
    target,
    style: broadcastStyle,
    title: v.string(),
    body: v.string(),
    expiresAt: v.optional(v.number()),
    ackRequired: v.boolean(),
  },
  returns: v.object({ id: v.id("broadcasts"), targetCount: v.number() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const title = cleanNoticeText(args.title, MAX_BROADCAST_TITLE, "title", { multiline: false });
    const body = cleanNoticeText(args.body, MAX_BROADCAST_BODY, "body", { multiline: true });
    if (args.expiresAt !== undefined) {
      if (!Number.isFinite(args.expiresAt) || args.expiresAt <= now || args.expiresAt > now + MAX_BROADCAST_LIFETIME_MS) {
        fail("invalid_argument", { field: "expiresAt" });
      }
    }
    let targetId: string;
    let targetName: string;
    let targetCount: number;
    if (args.target.kind === "group") {
      const group = await getInOrg(ctx, "groups", args.target.id, ctx.orgId);
      targetId = group._id;
      targetName = group.name;
      const devices = await ctx.db
        .query("devices")
        .withIndex("by_group", (q) => q.eq("groupId", group._id))
        .take(GROUP_COUNT_CAP + 1);
      targetCount = Math.min(devices.filter((d) => d.revoked !== true).length, GROUP_COUNT_CAP);
    } else {
      const device = await getInOrg(ctx, "devices", args.target.id, ctx.orgId);
      if ((await credOf(ctx, device)).state === "revoked") fail("conflict", { detail: "device revoked" });
      targetId = device._id;
      targetName = device.name;
      targetCount = 1;
    }
    if ((await liveCount(ctx, ctx.orgId, now, MAX_ORG_ACTIVE_BROADCASTS)) >= MAX_ORG_ACTIVE_BROADCASTS) fail("too_large", { detail: "active" });

    const id = await ctx.db.insert("broadcasts", {
      orgId: ctx.orgId,
      target: { kind: args.target.kind, id: targetId },
      style: args.style,
      title,
      body,
      expiresAt: args.expiresAt,
      ackRequired: args.ackRequired,
      createdBy: ctx.member._id,
      createdAt: now,
      targetCount,
      ackCount: 0,
    });
    await requestPublish(ctx, ctx.orgId, args.target.kind === "group" ? { groupIds: [targetId as Id<"groups">] } : { deviceIds: [targetId as Id<"devices">] });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "broadcast.sent",
      targetType: "broadcast",
      targetId: id,
      targetLabel: title,
      summary: `Sent the message "${title}" to ${args.target.kind === "group" ? "the group" : "the PC"} ${targetName}`,
    });
    return { id, targetCount };
  },
});

/** Cancel a broadcast (admin): the PCs drop it at the next document. Already cancelled = no write. Audits `broadcast.cancelled`. */
export const cancel = memberMutation("admin")({
  args: { id: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const b = await getInOrg(ctx, "broadcasts", args.id, ctx.orgId);
    if (b.cancelledAt !== undefined) return null;
    await ctx.db.patch(b._id, { cancelledAt: Date.now() });
    // A deleted group has no PCs to publish for.
    if (b.target.kind === "group") {
      const gid = ctx.db.normalizeId("groups", b.target.id);
      if (gid !== null && (await ctx.db.get(gid)) !== null) await requestPublish(ctx, ctx.orgId, { groupIds: [gid] });
    } else {
      const did = ctx.db.normalizeId("devices", b.target.id);
      if (did !== null) await requestPublish(ctx, ctx.orgId, { deviceIds: [did] });
    }
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "broadcast.cancelled",
      targetType: "broadcast",
      targetId: b._id,
      targetLabel: b.title,
      summary: `Cancelled the message "${b.title}"`,
    });
    return null;
  },
});
