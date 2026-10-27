import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  appKind,
  audience,
  auditActorType,
  desktopSpec,
  installState,
  inviteKind,
  memberStatus,
  orgSettings,
  planLimits,
  planName,
  planStatus,
  policyKeyStatus,
  reportedStatusFields,
  role,
  webSpec,
  wingetResolved,
} from "./lib/validators";

// Schema v2 (plan Phase 4, Section 4.2). Size legend: "grows" tables are never
// `.collect()`ed; "tiny" tables are read through an index with a named
// `.take(LIMIT)` from lib/limits.ts. Every index here is listed in plan 4.3.
//
// Widen-then-narrow (plan Section 11): fields that Phase 2 rows in the dev
// deployment lack are `v.optional`, and the Phase 2 desired-state fields stay
// until the publisher replaces them (Step 8).

export default defineSchema({
  ...authTables,

  // tiny
  organizations: defineTable({
    name: v.string(),
    settings: v.optional(orgSettings), // missing = DEFAULT_ORG_SETTINGS
    revision: v.optional(v.number()), // missing = 0
    createdAt: v.optional(v.number()),
    // When the device exit PIN was set (missing = no PIN). Lets `settings:get`
    // answer "PIN set" without reading `orgSecrets` (plan 4.7: one reader).
    exitPinSetAt: v.optional(v.number()),
    // DEPRECATED (Step 3): moved to `orgPlans.limits.maxDevices` by
    // `maintenance:migratePlans` (Step 5), which also removes it. Narrowed away
    // once the migration ran on every deployment. Nothing reads it.
    maxDevices: v.optional(v.number()),
  }),

  // tiny (1 per org). Written by settings:setExitPin / clearExitPin; read only
  // by the publisher (Step 8, plan 4.7). No query reads it.
  orgSecrets: defineTable({
    orgId: v.id("organizations"),
    exitPinHash: v.optional(v.string()), // Argon2id PHC
  }).index("by_org", ["orgId"]),

  // tiny (1 per org). Counters changed in the SAME mutation as the counted rows
  // (plan 4.2.1, A7); missing = 0 until `maintenance:migratePlans` recounts.
  // Mutations are serializable: a check-then-increment here cannot race.
  orgStats: defineTable({
    orgId: v.id("organizations"),
    deviceCount: v.number(), // non-revoked devices
    employeeCount: v.optional(v.number()),
    activeEmployeeCount: v.optional(v.number()),
    appCount: v.optional(v.number()),
    groupCount: v.optional(v.number()),
    memberCount: v.optional(v.number()), // active members
    noGroupDeviceCount: v.optional(v.number()),
    outOfSupportCount: v.optional(v.number()),
    failedInstallCount: v.optional(v.number()),
    activeEnrollmentCodes: v.optional(v.number()),
    publishFailedAt: v.optional(v.number()),
    lastActivityDay: v.optional(v.string()),
    // DEPRECATED (Phase 2 heartbeat interval): replaced by platformSettings /
    // orgPlans.pingIntervalMs; removed by `maintenance:migratePlans`.
    pingIntervalMs: v.optional(v.number()),
  }).index("by_org", ["orgId"]),

  // tiny (1 per org). The tenant's plan, limits and per-tenant ping interval
  // (plan 4.2.1, A1). Written only by the operator (plans.ts internal
  // functions; later the platform API) and by org creation.
  orgPlans: defineTable({
    orgId: v.id("organizations"),
    plan: planName,
    status: planStatus,
    limits: planLimits,
    pingIntervalMs: v.optional(v.number()), // per-tenant override; missing = global
    degradeLevel: v.number(),
    suspendedReason: v.optional(v.string()),
    revision: v.number(),
    updatedBy: v.string(), // "system" | "operator:<id>" | "cli"
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_status", ["status"]),

  // tiny (1 row, key "global"). Global ping interval and the limits copied
  // into a new organization's `orgPlans` row (plan 4.2.1, owner Q2/Q3).
  platformSettings: defineTable({
    key: v.literal("global"),
    pingIntervalMs: v.number(),
    planDefaults: v.object({ free: planLimits, team: planLimits, custom: planLimits }),
    revision: v.number(),
  }).index("by_key", ["key"]),

  // tiny
  members: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    email: v.string(), // lower-case
    role,
    status: memberStatus,
    createdAt: v.number(),
    revision: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_org_user", ["orgId", "userId"])
    .index("by_org_email", ["orgId", "email"])
    .index("by_org_role", ["orgId", "role"]),

  // tiny. Only the SHA-256 of the code is stored (plan 4.7).
  invites: defineTable({
    orgId: v.id("organizations"),
    email: v.string(), // lower-case
    role,
    kind: inviteKind,
    tokenHash: v.string(), // SHA-256 hex
    expiresAt: v.number(),
    createdBy: v.optional(v.id("members")),
    usedAt: v.optional(v.number()),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_email", ["email"])
    .index("by_org", ["orgId"])
    // maintenance: invites expired more than INVITE_RETENTION_MS ago (A10)
    .index("by_expires_at", ["expiresAt"]),

  // tiny (1 per user: the authenticator belongs to the person).
  // Written only by mfa:confirmSetup / mfa:verify / mfa:useRecoveryCode and
  // the reset functions; never returned by a query (plan 4.7).
  memberSecrets: defineTable({
    userId: v.id("users"),
    totpSecret: v.optional(v.string()), // base32
    totpPending: v.optional(v.string()),
    totpEnabledAt: v.optional(v.number()),
    recoveryHashes: v.array(v.string()), // SHA-256 hex
    lastTotpStep: v.number(),
    totpFailures: v.number(),
    totpLockedUntil: v.number(),
  }).index("by_user", ["userId"]),

  // small (1 per signed-in session that passed TOTP)
  mfaSessions: defineTable({
    sessionId: v.id("authSessions"),
    userId: v.id("users"),
    verifiedAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_user", ["userId"]),

  // ---- Step-up authentication (plan 4.16, Step 5a). Belongs to the USER
  // (like MFA), never to an organization. Never returned by a query except
  // the fields `stepUp:status` names.

  // tiny (1 per user). The ACTION PIN: confirms major dashboard actions. Not
  // the device exit PIN (`orgSecrets.exitPinHash`).
  stepUpFactors: defineTable({
    userId: v.id("users"),
    actionPinHash: v.optional(v.string()), // Argon2id PHC
    actionPinSetAt: v.optional(v.number()),
    pinFailures: v.number(), // consecutive, drives the backoff
    pinFailuresTotal: v.number(), // since the last success; PIN_HARD_LIMIT disables
    pinLockedUntil: v.number(),
    pinDisabledAt: v.optional(v.number()),
    webauthnUserId: v.optional(v.string()), // base64url, 16 random bytes; WebAuthn user.id
  }).index("by_user", ["userId"]),

  // tiny (<= MAX_PASSKEYS per user). Public keys only; nothing here is secret,
  // but only `id`, `name`, dates and flags ever leave the server.
  passkeys: defineTable({
    userId: v.id("users"),
    credentialId: v.string(), // base64url
    credentialPublicKey: v.string(), // base64url of the COSE key
    counter: v.number(),
    transports: v.array(v.string()),
    name: v.string(),
    aaguid: v.string(),
    deviceType: v.union(v.literal("singleDevice"), v.literal("multiDevice")),
    backedUp: v.boolean(),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    disabledAt: v.optional(v.number()), // cloned authenticator suspected
  })
    .index("by_user", ["userId"])
    .index("by_credential_id", ["credentialId"]),

  // small (1 per signed-in session that verified). Written on verification and
  // at most once per STEP_UP_ACTIVITY_QUANTUM_MS of activity.
  stepUpSessions: defineTable({
    sessionId: v.id("authSessions"),
    userId: v.id("users"),
    verifiedAt: v.number(),
    lastActiveAt: v.number(),
    method: v.union(v.literal("actionPin"), v.literal("passkey")),
    passkeyId: v.optional(v.id("passkeys")),
  })
    .index("by_session", ["sessionId"])
    .index("by_user", ["userId"]),

  // small (<= 2 per session: one per purpose). SHA-256 of the challenge only.
  stepUpChallenges: defineTable({
    userId: v.id("users"),
    sessionId: v.id("authSessions"),
    purpose: v.union(v.literal("register"), v.literal("verify")),
    challengeHash: v.string(),
    expiresAt: v.number(),
  })
    .index("by_challenge_hash", ["challengeHash"])
    .index("by_session_purpose", ["sessionId", "purpose"])
    .index("by_user", ["userId"])
    .index("by_expires_at", ["expiresAt"]),

  // tiny
  groups: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    revision: v.optional(v.number()),
    createdAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_name", ["orgId", "name"]),

  // grows
  devices: defineTable({
    orgId: v.id("organizations"),
    groupId: v.optional(v.id("groups")),
    name: v.string(),
    // Device authentication: SHA-256 hex of the device secret (plan 4.7).
    secretHash: v.string(),
    previousSecretHash: v.optional(v.string()),
    rotateCredential: v.optional(v.boolean()),
    revoked: v.boolean(),
    enrolledAt: v.number(),
    enrollmentTokenId: v.id("enrollmentTokens"),
    hardwareIdHash: v.optional(v.string()),
    kioskEnabled: v.optional(v.boolean()), // missing = true
    revision: v.optional(v.number()),
    // removed in Step 7 (moved to deviceReports)
    ...reportedStatusFields,
  })
    .index("by_org", ["orgId"])
    .index("by_group", ["groupId"])
    .index("by_secret_hash", ["secretHash"])
    .index("by_previous_secret_hash", ["previousSecretHash"])
    .searchIndex("search_name", { searchField: "name", filterFields: ["orgId"] }),

  // grows (1 per device). Written by the heartbeat from Step 7.
  deviceReports: defineTable({
    deviceId: v.id("devices"),
    orgId: v.id("organizations"),
    ...reportedStatusFields,
    trustedKeyIds: v.optional(v.array(v.string())),
    restartPending: v.optional(v.boolean()),
    outOfSupport: v.boolean(),
    updatedAt: v.number(),
  }).index("by_device", ["deviceId"]),

  // grows (1 per device), fast-changing (PRD 11.1 rule 4)
  deviceStatus: defineTable({
    deviceId: v.id("devices"),
    orgId: v.optional(v.id("organizations")), // backfilled by the next heartbeat
    lastSeenAt: v.number(),
  })
    .index("by_device", ["deviceId"])
    .index("by_org_last_seen", ["orgId", "lastSeenAt"]),

  // grows
  employees: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    username: v.string(), // normalized: trim + lower-case
    searchText: v.string(),
    quotaGb: v.optional(v.number()),
    disabled: v.boolean(),
    credentialRevision: v.number(),
    passwordSetAt: v.optional(v.number()),
    revision: v.number(),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_username", ["orgId", "username"])
    .searchIndex("search_text", { searchField: "searchText", filterFields: ["orgId"] }),

  // grows (1 per employee); read only by deviceApi:verifyEmployee
  employeeSecrets: defineTable({
    employeeId: v.id("employees"),
    passwordHash: v.string(), // PHC
  }).index("by_employee", ["employeeId"]),

  // grows, fast-changing
  employeeLockouts: defineTable({
    employeeId: v.id("employees"),
    orgId: v.id("organizations"),
    failures: v.number(),
    lastFailureAt: v.number(),
    lockedUntil: v.number(),
  }).index("by_employee", ["employeeId"]),

  // grows
  groupMembers: defineTable({
    orgId: v.id("organizations"),
    groupId: v.id("groups"),
    employeeId: v.id("employees"),
  })
    .index("by_group", ["groupId"])
    .index("by_employee", ["employeeId"])
    .index("by_group_employee", ["groupId", "employeeId"]),

  // grows (slowly)
  apps: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    kind: appKind,
    hue: v.optional(v.number()),
    web: v.optional(webSpec),
    desktop: v.optional(desktopSpec),
    icon: v.optional(
      v.object({ storageId: v.id("_storage"), sha256: v.string(), sizeBytes: v.number() }),
    ),
    archived: v.boolean(),
    revision: v.number(),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_archived", ["orgId", "archived"]),

  // grows
  appAssignments: defineTable({
    orgId: v.id("organizations"),
    groupId: v.id("groups"),
    appId: v.id("apps"),
    audience,
    pinnedTaskbar: v.boolean(),
    pinnedDesktop: v.boolean(),
  })
    .index("by_group", ["groupId"])
    .index("by_app", ["appId"])
    .index("by_group_app", ["groupId", "appId"]),

  // grows
  employeeApps: defineTable({
    orgId: v.id("organizations"),
    employeeId: v.id("employees"),
    appId: v.id("apps"),
  })
    .index("by_employee", ["employeeId"])
    .index("by_app", ["appId"])
    .index("by_employee_app", ["employeeId", "appId"]),

  // tiny (<= 200 per org)
  fileHandlers: defineTable({
    orgId: v.id("organizations"),
    extension: v.string(), // lower-case, with dot
    appId: v.id("apps"),
  })
    .index("by_org_ext", ["orgId", "extension"])
    .index("by_app", ["appId"]),

  // grows
  enrollmentTokens: defineTable({
    orgId: v.id("organizations"),
    tokenHash: v.string(),
    expiresAt: v.number(),
    usesLeft: v.number(),
    revoked: v.optional(v.boolean()),
    groupId: v.optional(v.id("groups")),
    createdAt: v.number(),
    label: v.optional(v.string()),
    createdBy: v.optional(v.id("members")),
    // Uses the code was created with (Step 6; the dashboard shows "used of
    // total"). Set only by `enrollmentCodes:create`: a row WITH it is counted
    // in `orgStats.activeEnrollmentCodes`; Phase 2 / dev rows without it are not.
    usesTotal: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_token_hash", ["tokenHash"])
    .index("by_org_created", ["orgId", "createdAt"])
    // groups:delete: unexpired codes that still enroll into a group (Step 5;
    // added to plan 4.3, `has_dependents` without a scan of the org's codes).
    .index("by_group_expires", ["groupId", "expiresAt"]),

  // grows (pruned to 5 per device from Step 8).
  // Widened for the Phase 2 rows still in the dev deployment: `scope` + `doc`
  // are the Phase 2 shape (read by devices:desiredState until Step 8); the
  // Phase 4 fields become required once the publisher writes every row.
  desiredStates: defineTable({
    orgId: v.id("organizations"),
    // Phase 4 (required from Step 8)
    deviceId: v.optional(v.id("devices")),
    version: v.number(),
    payload: v.optional(v.string()),
    signature: v.optional(v.string()), // base64
    keyId: v.optional(v.string()),
    contentHash: v.optional(v.string()),
    createdAt: v.optional(v.number()),
    reason: v.optional(v.string()),
    // Phase 2 (removed in Step 8)
    scope: v.optional(v.string()),
    doc: v.optional(v.any()),
  })
    .index("by_device_version", ["deviceId", "version"])
    // removed in Step 8
    .index("by_scope_version", ["scope", "version"]),

  // tiny (1 per org)
  publishQueue: defineTable({
    orgId: v.id("organizations"),
    allDevices: v.boolean(),
    groupIds: v.array(v.id("groups")),
    deviceIds: v.array(v.id("devices")),
    scheduled: v.optional(v.id("_scheduled_functions")),
    requestedAt: v.number(),
  }).index("by_org", ["orgId"]),

  // tiny (per org)
  policyKeys: defineTable({
    orgId: v.id("organizations"),
    keyId: v.string(), // 16 hex
    publicKey: v.string(), // base64, 32 bytes
    status: policyKeyStatus,
    endorsement: v.optional(v.object({ byKeyId: v.string(), signature: v.string() })),
    createdAt: v.number(),
  })
    .index("by_org_key_id", ["orgId", "keyId"])
    .index("by_org_status", ["orgId", "status"]),

  // grows (devices x apps)
  installResults: defineTable({
    orgId: v.id("organizations"),
    deviceId: v.id("devices"),
    appId: v.id("apps"),
    state: installState,
    appRevision: v.number(),
    attempts: v.number(),
    exitCode: v.optional(v.number()),
    detail: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_device", ["deviceId"])
    .index("by_device_app", ["deviceId", "appId"])
    .index("by_app_state", ["appId", "state"])
    .index("by_org_state", ["orgId", "state"]),

  // tiny
  wingetCache: defineTable({
    packageId: v.string(),
    version: v.string(),
    resolved: wingetResolved,
    fetchedAt: v.number(),
  }).index("by_package_version", ["packageId", "version"]),

  // grows. Append-only; written only by lib/audit.ts writeAudit (plan 4.11).
  auditLog: defineTable({
    orgId: v.id("organizations"),
    at: v.number(),
    actorType: auditActorType,
    actorId: v.optional(v.string()),
    actorLabel: v.string(),
    action: v.string(),
    targetType: v.optional(v.string()),
    targetId: v.optional(v.string()),
    targetLabel: v.optional(v.string()),
    summary: v.string(), // <= 300 chars
    eventKey: v.optional(v.string()),
  })
    .index("by_org_at", ["orgId", "at"])
    .index("by_event_key", ["eventKey"])
    .index("by_org_target", ["orgId", "targetId", "at"])
    .index("by_at", ["at"]),
});
