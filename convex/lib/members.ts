import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fail } from "./errors";
import { MAX_MEMBERS } from "./limits";
import type { Role } from "./validators";

/**
 * The only insert into `members` (plan 4.6 "Duplicate membership"). Reads
 * `by_org_user` in the same mutation first; mutations are serializable, so
 * two racing joins cannot both pass. A second membership for the same
 * (org, user) answers `already_member`.
 */
export async function insertMembership(
  ctx: Pick<MutationCtx, "db">,
  m: { orgId: Id<"organizations">; userId: Id<"users">; email: string; role: Role },
): Promise<Id<"members">> {
  const existing = await ctx.db
    .query("members")
    .withIndex("by_org_user", (q) => q.eq("orgId", m.orgId).eq("userId", m.userId))
    .first();
  if (existing !== null) fail("already_member");
  return await ctx.db.insert("members", {
    orgId: m.orgId,
    userId: m.userId,
    email: m.email,
    role: m.role,
    status: "active",
    createdAt: Date.now(),
    revision: 0,
  });
}

/** Active Owners of one organization (counted per organization, plan 4.6). */
export async function activeOwners(
  ctx: Pick<MutationCtx, "db">,
  orgId: Id<"organizations">,
): Promise<Doc<"members">[]> {
  const owners = await ctx.db
    .query("members")
    .withIndex("by_org_role", (q) => q.eq("orgId", orgId).eq("role", "owner"))
    .take(MAX_MEMBERS);
  return owners.filter((o) => o.status === "active");
}

/** `last_owner` when `member` is the organization's only active Owner. */
export async function assertNotLastOwner(
  ctx: Pick<MutationCtx, "db">,
  member: Doc<"members">,
): Promise<void> {
  if (member.role !== "owner" || member.status !== "active") return;
  const owners = await activeOwners(ctx, member.orgId);
  if (owners.length <= 1) fail("last_owner");
}
