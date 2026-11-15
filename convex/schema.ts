import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  appKind,
  audience,
  auditActorType,
  desktopSpec,
  diskBand,
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
import {
  applyState,
  atRestBox,
  blockedCounts,
  broadcastStyle,
  driverClass,
  driverKind,
  exceptionRule,
  findingLayer,
  findingStatus,
  layerStates,
  lockdownSettings,
  orgKeyPurpose,
  orgKeyStatus,
  permissionDenial,
  printerKind,
  ring,
  rolloutState,
  securityPosture,
  wifiSecurity,
} from "./lib/lockdownValidators";

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
    // Phase 5 (plan 4.2 "orgSettings" additions), kept OUT of `settings` so that
    // `settings:update` (which stores only the four Phase 4 sections) can never
    // drop them: the printer drivers the organization approved (<= 20; missing =
    // the inbox list of 4.15) and the lockdown defaults of a new group.
    phase5Settings: v.optional(
      v.object({
        approvedPrinterDrivers: v.optional(v.array(v.string())),
        newGroupDefaults: v.optional(lockdownSettings),
      }),
    ),
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
    // Revoked devices (Phase 4b): still listed by `fleet:list` until removed, so a
    // devices total = deviceCount + revokedDeviceCount (and the "No group" filter
    // adds revokedNoGroupDeviceCount). Bumped by the revoke (lib/fleet.ts) and
    // `fleet:remove`; recounted by `stats:reconcile`.
    revokedDeviceCount: v.optional(v.number()),
    revokedNoGroupDeviceCount: v.optional(v.number()),
    outOfSupportCount: v.optional(v.number()),
    failedInstallCount: v.optional(v.number()),
    activeEnrollmentCodes: v.optional(v.number()),
    publishFailedAt: v.optional(v.number()),
    lastActivityDay: v.optional(v.string()),
    // Payload bytes the publisher wrote on `publishBytesDay` (UTC "YYYY-MM-DD";
    // Step 8 item 14), added once per publish run.
    publishBytesToday: v.optional(v.number()),
    publishBytesDay: v.optional(v.string()),
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

  // tiny (one row per allow-listed name, lib/platformSecrets.ts). PLATFORM
  // settings the operator enters (Phase 4b Part C: the Resend key, its from
  // address, the dashboard origin), never a tenant's. AES-256-GCM with the
  // deployment's RULEBOX_PLATFORM_KEY; the name is the additional data.
  // Written only by platform:setSecret / clearSecret (internal); read only by
  // lib/platformSecrets.ts. No public function returns a field of it.
  platformSecrets: defineTable({
    name: v.string(),
    ciphertext: v.string(), // standard base64 (ciphertext + GCM tag)
    iv: v.string(), // standard base64, 12 bytes
    updatedAt: v.number(),
  }).index("by_name", ["name"]),

  // tiny (one row per flag; Phase 4b security review). Derived platform state
  // that hot queries may read instead of the secrets: "mail" = the Resend key,
  // from address and dashboard origin are stored, DECRYPT with this
  // deployment's master key and are valid. Recomputed only when a secret
  // changes (platform:storeSecret / setSecret / clearSecret / checkSecrets),
  // never on a read. `stamps`: the `updatedAt` of each secret it was computed
  // from (a late recompute over older rows is ignored).
  platformFlags: defineTable({
    name: v.string(),
    ready: v.boolean(),
    checkedAt: v.number(),
    stamps: v.array(v.union(v.number(), v.null())),
  }).index("by_name", ["name"]),

  // tiny (append-only). Platform-level events that belong to no organization
  // (auditLog requires one): which platform secret changed, never its value.
  platformAudit: defineTable({
    at: v.number(),
    action: v.union(v.literal("platform.secretSet"), v.literal("platform.secretCleared")),
    name: v.string(),
    actor: v.string(), // "cli" until the operator console exists
  }).index("by_at", ["at"]),

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

  // DEPRECATED (Phase 4b WP5b, TOTP removed; widen-then-narrow). Nothing reads
  // or writes `memberSecrets` or `mfaSessions` any more. They stay in the
  // schema only so a deploy does not fail on rows that dev data may still hold.
  // Their indexes are already gone. `maintenance:dropTotpTables` deletes every
  // row; after it has run on a deployment, delete both definitions below (the
  // narrow step, one more deploy).
  memberSecrets: defineTable({
    userId: v.id("users"),
    totpSecret: v.optional(v.string()), // base32
    totpPending: v.optional(v.string()),
    totpEnabledAt: v.optional(v.number()),
    recoveryHashes: v.array(v.string()), // SHA-256 hex
    lastTotpStep: v.number(),
    totpFailures: v.number(),
    totpLockedUntil: v.number(),
  }),

  mfaSessions: defineTable({
    sessionId: v.id("authSessions"),
    userId: v.id("users"),
    verifiedAt: v.number(),
  }),
  // ---- Step-up authentication (plan 4.16, Step 5a). Belongs to the USER
  // (like the account), never to an organization. Never returned by a query except
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
    // Legacy (before Phase 4b): the hard limit used to disable the PIN. Never
    // written any more; a row that still has it is treated as locked until
    // pinDisabledAt + PIN_LOCKOUT_MS. Narrowed away in WP5b.
    pinDisabledAt: v.optional(v.number()),
    webauthnUserId: v.optional(v.string()), // base64url, 16 random bytes; WebAuthn user.id
    // Recovery codes of the action PIN (Phase 4b): SHA-256 hex of each unused
    // code, written only by stepUp:generateRecoveryCodes and consumed by
    // stepUp:resetWithRecoveryCode. Kept when the PIN and passkeys are reset.
    recoveryHashes: v.optional(v.array(v.string())),
    recoveryCreatedAt: v.optional(v.number()),
  }).index("by_user", ["userId"]),

  // tiny (1 per user who ever typed a wrong PIN; Phase 4b security review).
  // The action PIN's attempt counters, OUT of `stepUpFactors` (data-access
  // rule 4: they change on every attempt; `account:me` reads `stepUpFactors`).
  // Written only by stepUp:beginPinAttempt / finishPinSuccess and deleted
  // whenever a new PIN is stored or the factors are reset. Read by
  // `stepUp:status` (the caller's own row). Supersedes the legacy counter
  // fields of `stepUpFactors` (seeded from them once; narrowed in WP5b).
  pinCounters: defineTable({
    userId: v.id("users"),
    failures: v.number(), // consecutive, drives the backoff
    streak: v.number(), // since the last success or lockout; PIN_HARD_LIMIT locks
    sinceUnlock: v.number(), // since the last success (shown to the person; warn email)
    lockedUntil: v.number(), // 0 = not locked
    lockout: v.boolean(), // `lockedUntil` is a lockout (else a short backoff)
    // Rolling PIN_WINDOW_MS window, NOT reset by a success (<= MAX_PIN_WINDOW_ENTRIES each).
    windowFailures: v.array(v.number()),
    windowLockouts: v.array(v.number()),
  }).index("by_user", ["userId"]),

  // tiny (forgot PIN by email, Phase 4b Part C). One row per emailed link:
  // SHA-256 of the 256-bit token only, single use, PIN_RESET_TTL_MS; pruned by
  // the daily job PIN_RESET_RETENTION_MS after creation. Never returned.
  pinResets: defineTable({
    userId: v.id("users"),
    tokenHash: v.string(), // SHA-256 hex
    createdAt: v.number(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_user_created", ["userId", "createdAt"]),

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
    // The group `setup` creates with the organization. It does NOT count toward
    // `orgStats.groupCount` / `maxGroups` (owner decision 2026-10-27: a free
    // tenant has 3 usable groups besides it).
    isDefault: v.optional(v.boolean()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_name", ["orgId", "name"]),

  // grows. Identity only (plan 4.2.1, A2). The credential and status fields
  // below are DEPRECATED (Step 7, widen-then-narrow): `maintenance:migrateDevices`
  // copies them into `deviceCredentials` / `deviceSummary` / `deviceReports`
  // without touching this row; `maintenance:narrowDevices` removes them once
  // every deployment ran the copy and its devices were checked. New devices
  // never get them. Only the pre-migration fallback of `lib/deviceAuth.ts`
  // and the migrations read them.
  devices: defineTable({
    orgId: v.id("organizations"),
    groupId: v.optional(v.id("groups")),
    name: v.string(),
    enrolledAt: v.number(),
    enrollmentTokenId: v.id("enrollmentTokens"),
    hardwareIdHash: v.optional(v.string()),
    kioskEnabled: v.optional(v.boolean()), // missing = true
    revision: v.optional(v.number()),
    // Phase 5 (plan 4.2; all widen-only). `ring`: rollout ring, missing =
    // "everyone". `sealPublicKey` / `sealKeyId`: the agent's X25519 sealing key
    // (4.18), registered once by `deviceApi:registerSealKey`. `usbTempAllowUntil`:
    // the live "Allow USB for this PC" window (4.3 `usbTempAllow`, <= 8 h, set by
    // a dashboard action in a later step; changes rarely, so it lives here and
    // costs the publisher no extra read).
    ring: v.optional(ring),
    sealPublicKey: v.optional(v.string()),
    sealKeyId: v.optional(v.string()),
    usbTempAllowUntil: v.optional(v.number()),
    // DEPRECATED (moved to deviceCredentials)
    secretHash: v.optional(v.string()),
    previousSecretHash: v.optional(v.string()),
    rotateCredential: v.optional(v.boolean()),
    revoked: v.optional(v.boolean()),
    // DEPRECATED (moved to deviceSummary / deviceReports)
    ...reportedStatusFields,
  })
    .index("by_org", ["orgId"])
    .index("by_group", ["groupId"])
    // `fleet:list({ groupId: "none" })`: the organization's devices without a group.
    .index("by_org_group", ["orgId", "groupId"])
    // Phase 4b list sorts (lib/listing.ts): devices by name, whole org or within a group / "No group".
    .index("by_org_name", ["orgId", "name"])
    .index("by_org_group_name", ["orgId", "groupId", "name"])
    // DEPRECATED: enrollment idempotency for devices enrolled before the
    // credentials split; removed with the narrow step.
    .index("by_secret_hash", ["secretHash"])
    .searchIndex("search_name", { searchField: "name", filterFields: ["orgId", "groupId"] }),

  // grows (1 per device). Read by EVERY device call, nothing else but the
  // fleet mutations that change it (plan 4.2.1, A2). Never returned.
  deviceCredentials: defineTable({
    deviceId: v.id("devices"),
    orgId: v.id("organizations"),
    secretHash: v.string(), // SHA-256 hex of the device secret
    previousSecretHash: v.optional(v.string()),
    rotate: v.optional(v.boolean()),
    state: v.union(v.literal("active"), v.literal("revoked"), v.literal("overLimit"), v.literal("suspended")),
  })
    .index("by_device", ["deviceId"])
    .index("by_secret_hash", ["secretHash"])
    .index("by_previous_secret_hash", ["previousSecretHash"]),

  // grows (1 per device), fast-changing, NEVER subscribed except the one row
  // of a watched device page (plan 4.2.1, A3). Written by a device call only
  // when the minute bucket changed or a transition happens.
  // `offlineAfter`: the minute bucket after which the sweep marks the device
  // offline = seenBucket + ceil((2.5 x the interval this device was told + 1
  // min) / 1 min). A per-row deadline instead of the plan's per-org grace map
  // (`by_online_seen`): the sweep reads only devices that really expired, even
  // when tenants have different intervals.
  deviceLiveness: defineTable({
    deviceId: v.id("devices"),
    orgId: v.id("organizations"),
    seenBucket: v.number(), // Unix ms / 60,000
    online: v.boolean(),
    offlineAfter: v.number(), // minute bucket
    pingIntervalMs: v.number(), // the effective interval of this device (settings)
    fastUntil: v.optional(v.number()), // watch mode: answer 60 s until then
    pendingCheck: v.optional(v.id("fleetChecks")), // "Check now" not answered yet
    answeredCheck: v.optional(v.id("fleetChecks")),
  })
    .index("by_device", ["deviceId"])
    .index("by_online_deadline", ["online", "offlineAfter"])
    // ping-interval propagation (plans:setOrgPingInterval / setGlobalPingInterval)
    .index("by_org", ["orgId"]),

  // grows (1 per device), written ONLY on an online/offline transition or
  // revoke (plan 4.2.1, A3). What lists show: "Online" / "Offline since 14:05".
  devicePresence: defineTable({
    deviceId: v.id("devices"),
    orgId: v.id("organizations"),
    online: v.boolean(),
    since: v.number(),
    revoked: v.optional(v.boolean()), // terminal: revoked devices are never online
  }).index("by_device", ["deviceId"]),

  // tiny (PRESENCE_SHARDS per org): online device counts, changed on transitions.
  orgPresence: defineTable({
    orgId: v.id("organizations"),
    shard: v.number(),
    online: v.number(),
  }).index("by_org_shard", ["orgId", "shard"]),

  // grows (1 per device): the list columns only (plan 4.2.1, A8), written only
  // when one of them changes. Disk space as a band.
  deviceSummary: defineTable({
    deviceId: v.id("devices"),
    orgId: v.id("organizations"),
    agentVersion: v.optional(v.string()),
    windowsBuild: v.optional(v.string()),
    kioskPhase: v.optional(v.string()),
    outOfSupport: v.boolean(),
    appliedVersion: v.optional(v.number()),
    diskBand: v.optional(diskBand),
    // Copied from the report (Step 17 follow-up): `keys:trustProgress` reads this
    // small row instead of `deviceReports` (compat up to 32 KB). Changes only
    // when the agent's trusted keys change (rotation).
    trustedKeyIds: v.optional(v.array(v.string())),
    updatedAt: v.number(),
  }).index("by_device", ["deviceId"]),

  // grows (1 per device): the detail page's report (plan 4.2.1, A8). Written
  // only when a field changes; `diskFreeGb` only when its band changes.
  deviceReports: defineTable({
    deviceId: v.id("devices"),
    orgId: v.id("organizations"),
    ...reportedStatusFields,
    trustedKeyIds: v.optional(v.array(v.string())),
    restartPending: v.optional(v.boolean()),
    // Phase 5 (4.16, 4.2): physical protection and the capabilities the agent
    // reports ("lockdown/1", ...). Written only when they change.
    security: v.optional(securityPosture),
    capabilities: v.optional(v.array(v.string())),
    updatedAt: v.number(),
  }).index("by_device", ["deviceId"]),

  // grows (pruned daily after a day). One "Check now" click (plan 4.9).
  fleetChecks: defineTable({
    orgId: v.id("organizations"),
    deviceIds: v.array(v.id("devices")), // <= MAX_CHECK_DEVICES
    requestedAt: v.number(),
    requestedBy: v.id("members"),
  }),

  // RETIRED (Step 7, A3): no longer written. Rows are deleted by
  // `maintenance:narrowDevices` after `migrateDevices` copied them into
  // `deviceLiveness` / `devicePresence`.
  deviceStatus: defineTable({
    deviceId: v.id("devices"),
    orgId: v.optional(v.id("organizations")),
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
    // Phase 4b list sort by name (lib/listing.ts).
    .index("by_org_name", ["orgId", "name"])
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
    // true = the employee is ENABLED and has at least one direct app grant
    // (kept by `lib/employeeSync.syncGrantFlags`). The publisher reads only these
    // rows (`by_group_grants`), so a group with no such members costs one read.
    // Only ever stale-TRUE (an app purge deletes grants without touching it),
    // which costs a wasted read; never stale-false.
    grantsActive: v.optional(v.boolean()),
  })
    .index("by_group", ["groupId"])
    .index("by_employee", ["employeeId"])
    .index("by_group_employee", ["groupId", "employeeId"])
    .index("by_group_grants", ["groupId", "grantsActive"]),

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
    .index("by_org_archived", ["orgId", "archived"])
    // Phase 4b list sort and search (lib/listing.ts).
    .index("by_org_archived_name", ["orgId", "archived", "name"])
    .searchIndex("search_name", { searchField: "name", filterFields: ["orgId", "archived"] }),

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
    // Phase 4b list sort by expiry (lib/listing.ts).
    .index("by_org_expires", ["orgId", "expiresAt"])
    // groups:delete: unexpired codes that still enroll into a group (Step 5;
    // added to plan 4.3, `has_dependents` without a scan of the org's codes).
    .index("by_group_expires", ["groupId", "expiresAt"]),

  // ---- Signed desired state, head/body split (plan 4.2.1 / 4.4, A5 + A13; Step 8).

  // grows (1 per device): the agent's ONE subscription (`devices:headState`).
  // Small and unsigned: it only tells the agent which signed body to fetch.
  // Written on a new version, a ping-interval / plan-state change and the
  // watch / check-now signals (`fastUntil`, `pingNonce`).
  desiredHeads: defineTable({
    deviceId: v.id("devices"),
    orgId: v.id("organizations"),
    version: v.number(),
    contentHash: v.string(), // SHA-256 hex of the document with version 0
    keyId: v.string(),
    bodyId: v.id("desiredBodies"),
    pingIntervalMs: v.number(),
    pingNonce: v.number(), // reserved (A13): the agent pings at once when it changes
    fastUntil: v.number(), // reserved (A13): the agent pings every 60 s until then (0 = off)
    rosterGroupId: v.optional(v.id("groups")),
    planState: v.union(v.literal("ok"), v.literal("overLimit"), v.literal("suspended")),
  }).index("by_device", ["deviceId"]),

  // grows (KEEP_VERSIONS per device). The signed payload; read only by
  // `devices:fetchDesired` (one-shot, never subscribed except by the Phase 2
  // alias) and the pruning. Rows never change.
  desiredBodies: defineTable({
    orgId: v.id("organizations"),
    deviceId: v.id("devices"),
    version: v.number(),
    payload: v.string(), // the exact signed UTF-8 string
    signature: v.string(), // standard base64 of 64 bytes
    keyId: v.string(),
    contentHash: v.string(),
    createdAt: v.number(),
  }).index("by_device_version", ["deviceId", "version"]),

  // grows (KEEP_VERSIONS per device, ~150 B): the device page's history.
  desiredVersions: defineTable({
    orgId: v.id("organizations"),
    deviceId: v.id("devices"),
    version: v.number(),
    reason: v.string(),
    createdAt: v.number(),
    bodyId: v.id("desiredBodies"),
  }).index("by_device_version", ["deviceId", "version"]),

  // tiny (1 per group): the roster log's position (A6). Step 11 writes it.
  groupRoster: defineTable({
    orgId: v.id("organizations"),
    groupId: v.id("groups"),
    epoch: v.number(),
    snapshotEpoch: v.number(),
    snapshotId: v.optional(v.id("rosterSnapshots")),
  }).index("by_group", ["groupId"]),

  // grows only while an organization has no usable signing key. A removal
  // ("employee E leaves group G's roster") that could not be signed when the
  // employee was disabled (revocation is never blocked, Step 11 review); the
  // resync appends the signed entry once a key is available and deletes the
  // row in the same transaction (`employees:resyncRoster`). `employeeId` is a
  // string: the employee may have been deleted since.
  rosterPending: defineTable({
    orgId: v.id("organizations"),
    groupId: v.id("groups"),
    employeeId: v.string(),
  })
    .index("by_org", ["orgId"])
    .index("by_group_employee", ["groupId", "employeeId"])
    .index("by_employee", ["employeeId"]),

  // grows (pruned at each snapshot). One signed roster change (lib/roster.ts).
  rosterEntries: defineTable({
    orgId: v.id("organizations"),
    groupId: v.id("groups"),
    epoch: v.number(),
    employeeId: v.string(), // an `employees` id (a string: removed employees stay referenced)
    credentialRevision: v.optional(v.number()), // missing = removed
    keyId: v.string(), // added to plan 4.2.1: which org key signed it (rotation)
    signature: v.string(),
  }).index("by_group_epoch", ["groupId", "epoch"]),

  // tiny (1 per group): the newest signed roster snapshot (added to plan
  // 4.2.1, which names `groupRoster.snapshotId` but no table for it).
  rosterSnapshots: defineTable({
    orgId: v.id("organizations"),
    groupId: v.id("groups"),
    epoch: v.number(),
    payload: v.string(),
    signature: v.string(),
    keyId: v.string(),
    createdAt: v.number(),
  }),

  // RETIRED (Step 8, A5): replaced by desiredHeads / desiredBodies /
  // desiredVersions. Phase 2 rows (unsigned) are NOT copied; they are read
  // only by the `devices:desiredState` fallback for a device the publisher
  // has not reached yet, by the first publish (so a new version is above the
  // one the device applied) (`dev.ts` was deleted in Step 20).
  // `maintenance:dropDesiredStates` deletes the rows; the table is removed
  // from the schema once it is empty on every deployment.
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
    // The publisher's position (Step 8): pagination cursor over the first
    // group in `groupIds`, or over all devices when `allDevices`. Reset by a
    // new request for the same target (its change may concern devices
    // already passed).
    cursor: v.optional(v.string()),
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
    // The PC's group (Step 17 review): written by every report, re-tagged by
    // `fleet:move`, cleared by a revoke. A row counts only while this group
    // still assigns the app and the app is not archived (lib/installs.ts).
    // Missing on rows written before the field existed (they count nowhere
    // until the PC reports again).
    groupId: v.optional(v.id("groups")),
  })
    // "Newest first" means newest `updatedAt` (Step 17 review), not creation.
    .index("by_device_updated", ["deviceId", "updatedAt"])
    .index("by_device_app", ["deviceId", "appId"])
    .index("by_app_state_updated", ["appId", "state", "updatedAt"])
    .index("by_org_state_updated", ["orgId", "state", "updatedAt"]),

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

  // ---------------------------------------------------------------- Phase 5 (plan 4.2)
  // Same legend as above. Every new table has `orgId` and every query filters on it
  // through an index. All timestamps are server Unix ms.

  // tiny (<= 6 per org). Per-organization keys wrapped by the deployment master key
  // (`RULEBOX_MASTER_KEY`, lib/keyring.ts is the only reader of `wrapped`). Never returned.
  orgKeys: defineTable({
    orgId: v.id("organizations"),
    purpose: orgKeyPurpose,
    keyId: v.string(), // 16 hex
    wrapped: v.string(), // base64 of nonce (24) || ciphertext, XChaCha20-Poly1305, AAD = orgId|purpose|keyId
    masterKeyId: v.string(), // 16 hex: which master key wrapped it
    status: orgKeyStatus,
    // Step 10 addition: "env" = wrapped from the deployment key by `keys:migrateFromEnv`
    // (the dashboard says so, plan 4.20); missing = generated by `keys:createOrgKeys`.
    origin: v.optional(v.literal("env")),
    createdAt: v.number(),
  })
    .index("by_org_purpose_status", ["orgId", "purpose", "status"])
    .index("by_master_key", ["masterKeyId"]),

  // tiny (1 per group)
  groupLockdown: defineTable({
    orgId: v.id("organizations"),
    groupId: v.id("groups"),
    settings: lockdownSettings,
    revision: v.number(),
  }).index("by_group", ["groupId"]),

  // grows slowly (<= 200 per group, MAX_GROUP_EXCEPTIONS). `groupId` missing = the whole organization.
  lockdownExceptions: defineTable({
    orgId: v.id("organizations"),
    groupId: v.optional(v.id("groups")),
    appId: v.optional(v.id("apps")),
    rule: exceptionRule,
    reason: v.string(), // <= 200
    findingId: v.optional(v.id("lockdownFindings")),
    createdBy: v.optional(v.id("members")),
    createdAt: v.number(),
  })
    .index("by_org_group", ["orgId", "groupId"])
    .index("by_finding", ["findingId"])
    .index("by_app", ["appId"]),

  // grows. One row per distinct program fingerprint of an organization (4.10).
  lockdownFindings: defineTable({
    orgId: v.id("organizations"),
    fingerprint: v.string(), // 64 hex
    layer: findingLayer,
    fileName: v.string(), // <= 100
    folderClass: v.string(),
    signer: v.optional(v.string()), // <= 200
    product: v.optional(v.string()), // <= 100
    sha256: v.optional(v.string()),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
    deviceCount: v.number(),
    sampleDeviceId: v.id("devices"),
    status: findingStatus,
    decidedBy: v.optional(v.id("members")),
    decidedAt: v.optional(v.number()),
  })
    .index("by_org_fingerprint", ["orgId", "fingerprint"])
    .index("by_org_status_seen", ["orgId", "status", "lastSeenAt"]),

  // grows. Which device saw which finding (never subscribed by a dashboard screen).
  lockdownFindingDevices: defineTable({
    orgId: v.id("organizations"),
    findingId: v.id("lockdownFindings"),
    deviceId: v.id("devices"),
    firstSeenAt: v.number(),
  })
    .index("by_finding_device", ["findingId", "deviceId"])
    .index("by_device", ["deviceId"]),

  // grows (1 per device). Upserted only when the agent's content hash differs.
  deviceApplyReports: defineTable({
    orgId: v.id("organizations"),
    deviceId: v.id("devices"),
    appliedVersion: v.number(),
    config: v.optional(v.object({ groupId: v.id("groups"), version: v.number(), ring })),
    state: applyState,
    refusal: v.optional(v.string()),
    layers: layerStates,
    wifi: v.array(v.object({ profileId: v.string(), revision: v.number(), state: v.string(), detail: v.optional(v.string()) })),
    printers: v.array(v.object({ printerId: v.string(), revision: v.number(), state: v.string(), detail: v.optional(v.string()) })),
    lkgVersion: v.optional(v.number()),
    capabilities: v.array(v.string()),
    // Step 10 addition: the agent's SHA-256 of the report (the "skip when unchanged" key).
    contentHash: v.string(),
    updatedAt: v.number(),
  })
    .index("by_device", ["deviceId"])
    .index("by_org_config", ["orgId", "config.groupId", "config.version"]),

  // grows (<= 1 per device per day, only non-zero days; 14-day retention)
  deviceSecurityDaily: defineTable({
    orgId: v.id("organizations"),
    deviceId: v.id("devices"),
    day: v.string(), // YYYY-MM-DD, server UTC
    blocked: blockedCounts,
    permissionDenials: v.array(permissionDenial), // <= 100
    drift: v.number(),
    tamper: v.number(),
  })
    .index("by_device_day", ["deviceId", "day"])
    .index("by_org_day", ["orgId", "day"]),

  // grows (1 per org per day; 90-day retention)
  orgSecurityDaily: defineTable({
    orgId: v.id("organizations"),
    day: v.string(),
    blocked: blockedCounts,
    permissionDenials: v.array(permissionDenial), // <= 500, summed
    devicesReporting: v.number(),
  }).index("by_org_day", ["orgId", "day"]),

  // tiny (<= 50 per org, MAX_WIFI_PROFILES). `passphrase` is never returned by any query.
  wifiProfiles: defineTable({
    orgId: v.id("organizations"),
    name: v.string(), // <= 60
    ssid: v.string(), // 1-32 bytes UTF-8
    hidden: v.boolean(),
    security: wifiSecurity,
    autoConnect: v.boolean(),
    passphrase: v.optional(atRestBox),
    // Step 13 (deviation from plan 4.18): the profile revision the at-rest box was encrypted under (its AAD). Any
    // edit of the profile bumps `revision`, but a mutation cannot re-encrypt, so the AAD keeps this value.
    // Missing = `revision`. `passphraseSetAt`: when the passphrase was set (the form shows "set on 12 Oct").
    passphraseRev: v.optional(v.number()),
    passphraseSetAt: v.optional(v.number()),
    groupIds: v.array(v.id("groups")), // <= 100
    revision: v.number(),
    createdAt: v.number(),
  }).index("by_org", ["orgId"]),

  // grows (devices x profiles). One box per device and profile; opened only by that agent.
  deviceSealedSecrets: defineTable({
    orgId: v.id("organizations"),
    deviceId: v.id("devices"),
    purpose: v.literal("wifi"),
    targetId: v.string(),
    targetRevision: v.number(),
    sealKeyId: v.string(),
    sealed: v.string(), // base64 of the JSON box (4.18)
    createdAt: v.number(),
  })
    .index("by_device_target", ["deviceId", "purpose", "targetId"])
    .index("by_target", ["purpose", "targetId"]),

  // tiny (<= 100 per org)
  printers: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    kind: printerKind,
    address: v.string(),
    port: v.optional(v.number()),
    queue: v.optional(v.string()),
    driver: v.string(),
    groupIds: v.array(v.id("groups")),
    defaultForGroupIds: v.array(v.id("groups")),
    revision: v.number(),
    createdAt: v.number(),
  }).index("by_org", ["orgId"]),

  // tiny (<= 50 per org, MAX_ORG_DRIVERS). Phase 5 Step 14b: a driver package pushed to groups (PRD 24.2). `inf` is the
  // path of the .inf inside the zip (kind "inf" only); `silentArgs` / `successExitCodes` belong to kind "exe" only;
  // `provides` are the printer driver names the package makes available (offered to the printer form).
  drivers: defineTable({
    orgId: v.id("organizations"),
    name: v.string(), // <= 60
    kind: driverKind,
    deviceClass: driverClass,
    url: v.string(),
    sha256: v.string(),
    sizeBytes: v.number(),
    inf: v.optional(v.string()),
    silentArgs: v.array(v.string()),
    successExitCodes: v.array(v.number()),
    provides: v.array(v.string()),
    groupIds: v.array(v.id("groups")),
    revision: v.number(),
    createdAt: v.number(),
  }).index("by_org", ["orgId"]),

  // grows (devices x drivers). The latest result of each driver on each PC; written only when a field differs.
  driverResults: defineTable({
    orgId: v.id("organizations"),
    deviceId: v.id("devices"),
    driverId: v.id("drivers"),
    state: installState,
    driverRevision: v.number(),
    attempts: v.number(),
    exitCode: v.optional(v.number()),
    detail: v.optional(v.string()),
    groupId: v.optional(v.id("groups")),
    updatedAt: v.number(),
  })
    .index("by_device_driver", ["deviceId", "driverId"])
    .index("by_driver_state_updated", ["driverId", "state", "updatedAt"]),

  // grows (pruned to 20 per group). The ring-gated inputs of one group at one version (4.14).
  groupConfigs: defineTable({
    orgId: v.id("organizations"),
    groupId: v.id("groups"),
    version: v.number(),
    config: v.string(), // JSON, <= 262,144 bytes
    contentHash: v.string(),
    createdBy: v.optional(v.id("members")),
    createdAt: v.number(),
    reason: v.string(), // <= 120
  }).index("by_group_version", ["groupId", "version"]),

  // tiny (1 per group)
  groupRollouts: defineTable({
    orgId: v.id("organizations"),
    groupId: v.id("groups"),
    enabled: v.boolean(),
    pointers: v.object({ pilot: v.number(), early: v.number(), everyone: v.number() }),
    autoPromote: v.object({ enabled: v.boolean(), bakeHours: v.number(), maxFailurePct: v.number() }),
    autoRollback: v.boolean(),
    state: rolloutState,
    haltReason: v.optional(v.string()),
    stageStartedAt: v.optional(v.number()),
    revision: v.number(),
  })
    .index("by_group", ["groupId"])
    .index("by_state_stage", ["state", "stageStartedAt"]),

  // grows (1 per locked device)
  deviceLocks: defineTable({
    orgId: v.id("organizations"),
    deviceId: v.id("devices"),
    lockId: v.string(),
    message: v.string(), // <= 300
    contact: v.optional(v.string()), // <= 100
    lockedAt: v.number(),
    lockedBy: v.optional(v.id("members")),
  })
    .index("by_device", ["deviceId"])
    .index("by_org", ["orgId"]),

  // grows
  broadcasts: defineTable({
    orgId: v.id("organizations"),
    target: v.object({ kind: v.union(v.literal("group"), v.literal("device")), id: v.string() }),
    style: broadcastStyle,
    title: v.string(), // <= 80
    body: v.string(), // <= 500
    expiresAt: v.optional(v.number()),
    ackRequired: v.boolean(),
    createdBy: v.optional(v.id("members")),
    createdAt: v.number(),
    cancelledAt: v.optional(v.number()),
    // Step 15: devices the broadcast was aimed at when it was sent (a device = 1; a group = its PCs, capped
    // at GROUP_COUNT_CAP), and the devices that acknowledged it so far (`deviceApi:reportAcks` adds one per new
    // ack row), so the list shows "14 of 20" without reading acknowledgement rows. Absent on older rows.
    targetCount: v.optional(v.number()),
    ackCount: v.optional(v.number()),
  })
    .index("by_org_created", ["orgId", "createdAt"])
    .index("by_target_created", ["target.kind", "target.id", "createdAt"])
    // Step 15: the "<= 20 active per organization" cap: never-cancelled rows by expiry (undefined = no expiry).
    .index("by_org_open", ["orgId", "cancelledAt", "expiresAt"]),

  // grows. One row per device per broadcast; never the employee's identity.
  broadcastAcks: defineTable({
    orgId: v.id("organizations"),
    broadcastId: v.id("broadcasts"),
    deviceId: v.id("devices"),
    at: v.number(),
  })
    .index("by_broadcast", ["broadcastId"])
    .index("by_broadcast_device", ["broadcastId", "deviceId"]),
});
