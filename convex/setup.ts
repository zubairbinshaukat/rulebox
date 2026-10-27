import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, type MutationCtx } from "./_generated/server";
import { SYSTEM_ACTOR, writeAudit } from "./lib/audit";
import { codeHash, INVITE_CODE_LENGTH, normalizeEmail, randomCrockford } from "./lib/crypto";
import { fail } from "./lib/errors";
import { OWNER_INVITE_TTL_MS } from "./lib/limits";
import { ensureOrgRows } from "./lib/orgRows";
import { DEFAULT_ORG_SETTINGS } from "./lib/validators";

// Owner bootstrap (plan Step 3.2). Command line only:
//   npx convex run setup:createOwnerInvite '{"orgName":"Acme","email":"owner@acme.test"}'
// The code is printed once by the CLI and stored only as its SHA-256.

export const createOwnerInvite = internalAction({
  args: {
    orgName: v.string(),
    email: v.string(),
    allowAdditionalOrg: v.optional(v.boolean()),
    // Adopt an existing organization that has no members yet (for example one
    // made by the Phase 2 `dev:seedOrg`) instead of creating a new one.
    existingOrgId: v.optional(v.id("organizations")),
  },
  returns: v.object({ orgId: v.id("organizations"), inviteCode: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args): Promise<{ orgId: Id<"organizations">; inviteCode: string; expiresAt: number }> => {
    const email = normalizeEmail(args.email);
    if (email === null) fail("invalid_argument", { field: "email" });
    const orgName = args.orgName.trim();
    if (orgName.length < 1 || orgName.length > 100) fail("invalid_argument", { field: "orgName" });
    const inviteCode = randomCrockford(ctx, INVITE_CODE_LENGTH);
    const stored: { orgId: Id<"organizations">; expiresAt: number } = await ctx.runMutation(
      internal.setup.storeOwnerInvite,
      {
        orgName,
        email,
        allowAdditionalOrg: args.allowAdditionalOrg === true,
        existingOrgId: args.existingOrgId,
        tokenHash: codeHash(inviteCode),
      },
    );
    return { orgId: stored.orgId, inviteCode, expiresAt: stored.expiresAt };
  },
});

/**
 * Make sure an organization has a "Default" group and its one-per-org rows
 * (plan, counters, secrets; Step 5). The Default group is marked `isDefault`
 * and does NOT count toward `maxGroups` (owner decision 2026-10-27: a free
 * tenant gets 3 usable groups besides it); the recount skips it.
 */
async function prepareOrg(ctx: Pick<MutationCtx, "db">, orgId: Id<"organizations">): Promise<void> {
  const now = Date.now();
  const existing = await ctx.db
    .query("groups")
    .withIndex("by_org_name", (q) => q.eq("orgId", orgId).eq("name", "Default"))
    .first();
  if (existing === null) {
    await ctx.db.insert("groups", { orgId, name: "Default", revision: 0, createdAt: now, isDefault: true });
  }
  const org = await ctx.db.get(orgId);
  if (org === null) fail("not_found");
  await ensureOrgRows(ctx, org, { updatedBy: "system", now });
}

export const storeOwnerInvite = internalMutation({
  args: {
    orgName: v.string(),
    email: v.string(),
    allowAdditionalOrg: v.boolean(),
    existingOrgId: v.optional(v.id("organizations")),
    tokenHash: v.string(),
  },
  returns: v.object({ orgId: v.id("organizations"), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    let orgId: Id<"organizations">;
    if (args.existingOrgId !== undefined) {
      const org = await ctx.db.get(args.existingOrgId);
      if (org === null) fail("not_found");
      const anyMember = await ctx.db
        .query("members")
        .withIndex("by_org_user", (q) => q.eq("orgId", org._id))
        .first();
      if (anyMember !== null) fail("conflict", { detail: "organization already has members" });
      orgId = org._id;
      await ctx.db.patch(orgId, {
        name: args.orgName,
        settings: org.settings ?? DEFAULT_ORG_SETTINGS,
        revision: org.revision ?? 0,
        createdAt: org.createdAt ?? org._creationTime,
      });
    } else {
      // One organization per deployment (D1) unless asked. Reads one row.
      const first = await ctx.db.query("organizations").first();
      if (first !== null && !args.allowAdditionalOrg) {
        fail("conflict", { detail: "an organization already exists" });
      }
      orgId = await ctx.db.insert("organizations", {
        name: args.orgName,
        settings: DEFAULT_ORG_SETTINGS,
        revision: 0,
        createdAt: now,
      });
    }
    await prepareOrg(ctx, orgId);
    const expiresAt = now + OWNER_INVITE_TTL_MS;
    const inviteId = await ctx.db.insert("invites", {
      orgId,
      email: args.email,
      role: "owner",
      kind: "join",
      tokenHash: args.tokenHash,
      expiresAt,
    });
    await writeAudit(ctx, {
      orgId,
      actor: SYSTEM_ACTOR,
      action: "member.invited",
      targetType: "invite",
      targetId: inviteId,
      targetLabel: args.email,
      summary: `Owner invite created from the command line for ${args.email}`,
    });
    return { orgId, expiresAt };
  },
});
