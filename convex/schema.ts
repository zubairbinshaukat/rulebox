import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const branding = v.object({
  name: v.string(),
  logoUrl: v.optional(v.string()),
});

export default defineSchema({
  organizations: defineTable({
    name: v.string(),
    branding: v.optional(branding),
  }),

  groups: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
  }).index("by_org", ["orgId"]),

  devices: defineTable({
    orgId: v.id("organizations"),
    groupId: v.optional(v.id("groups")),
    name: v.string(),
    status: v.string(), // e.g. "online" | "offline" | "pending"
    lastSeen: v.optional(v.number()),
    os: v.optional(v.string()),
    ramMb: v.optional(v.number()),
    diskFreeGb: v.optional(v.number()),
    lockdownLevel: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_group", ["groupId"]),

  employees: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    username: v.string(),
    groupIds: v.array(v.id("groups")),
    quotaGb: v.optional(v.number()),
    disabled: v.boolean(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_username", ["orgId", "username"]),

  apps: defineTable({
    orgId: v.id("organizations"),
    type: v.union(
      v.literal("winget"),
      v.literal("web"),
      v.literal("msi"),
      v.literal("portable"),
    ),
    name: v.string(),
    iconUrl: v.optional(v.string()),
    config: v.any(), // shape per app type is defined in a later phase
  }).index("by_org", ["orgId"]),

  desiredStates: defineTable({
    orgId: v.id("organizations"),
    // Group or device id. A plain string so one table can hold both scopes.
    scope: v.string(),
    version: v.number(),
    doc: v.any(), // DesiredState (see packages/types)
  })
    .index("by_org", ["orgId"])
    .index("by_scope_version", ["scope", "version"]),

  enrollmentTokens: defineTable({
    orgId: v.id("organizations"),
    tokenHash: v.string(),
    expiresAt: v.number(),
    usesLeft: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_token_hash", ["tokenHash"]),

  auditLog: defineTable({
    orgId: v.id("organizations"),
    actor: v.string(),
    action: v.string(),
    target: v.optional(v.string()),
    at: v.number(),
  }).index("by_org_at", ["orgId", "at"]),
});