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
    // Device authentication (Phase 2): SHA-256 hex of the device secret.
    secretHash: v.string(),
    revoked: v.boolean(),
    enrolledAt: v.number(),
    enrollmentTokenId: v.id("enrollmentTokens"),
    hardwareIdHash: v.optional(v.string()),
    // Reported by the agent. Written only when something changed (rule 5).
    agentVersion: v.optional(v.string()),
    os: v.optional(v.string()),
    osBuild: v.optional(v.string()),
    osEdition: v.optional(v.string()),
    ramMb: v.optional(v.number()),
    diskFreeGb: v.optional(v.number()),
    lockdownLevel: v.optional(v.string()),
    kioskPhase: v.optional(v.string()),
    kioskError: v.optional(v.string()),
    appliedVersion: v.optional(v.number()),
    shellHealth: v.optional(v.string()),
    compat: v.optional(v.any()), // CompatReport, shape owned by the agent
    // `status` and `lastSeen` live in `deviceStatus` (PRD 11.1 rule 4).
  })
    .index("by_org", ["orgId"])
    .index("by_group", ["groupId"])
    .index("by_secret_hash", ["secretHash"]),

  // The only fast-changing device data. Kept out of `devices` so that lists
  // subscribed to `devices` do not re-run on every heartbeat.
  deviceStatus: defineTable({
    deviceId: v.id("devices"),
    lastSeenAt: v.number(),
  }).index("by_device", ["deviceId"]),

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
    // DesiredState (see packages/types) plus the agent-only top-level keys
    // `adminExit`, `power` and `orgName` (Phase 2 plan 5.10). Kept as `any`
    // so those keys are accepted without a strict validator.
    doc: v.any(),
  })
    .index("by_org", ["orgId"])
    .index("by_scope_version", ["scope", "version"]),

  enrollmentTokens: defineTable({
    orgId: v.id("organizations"),
    tokenHash: v.string(),
    expiresAt: v.number(),
    usesLeft: v.number(),
    revoked: v.optional(v.boolean()),
    groupId: v.optional(v.id("groups")),
    createdAt: v.number(),
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