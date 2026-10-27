import { v, type Infer } from "convex/values";

// Shared validators (plan 4.2, 4.8, 4.10). The schema and the functions both
// import from here so a field cannot drift between a table and an argument.

export const role = v.union(v.literal("owner"), v.literal("admin"), v.literal("viewer"));
export type Role = Infer<typeof role>;

export const memberStatus = v.union(v.literal("active"), v.literal("disabled"));

export const inviteKind = v.union(v.literal("join"), v.literal("passwordReset"));

export const orgSettings = v.object({
  offlineDays: v.number(), // 0..30, default 3 (PRD 13.6 #6); 0 = no offline sign-in
  defaultQuotaGb: v.number(), // 0..2000, default 10; 0 = unlimited
  power: v.object({ sleep: v.boolean(), restart: v.boolean(), shutDown: v.boolean() }),
  adminExit: v.object({ enabled: v.boolean(), hotkey: v.string() }),
});
export type OrgSettings = Infer<typeof orgSettings>;

export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  offlineDays: 3,
  defaultQuotaGb: 10,
  power: { sleep: true, restart: true, shutDown: true },
  adminExit: { enabled: true, hotkey: "Ctrl+Shift+F12" },
};

// ---- Plans and limits (plan 4.2.1, A1; post-Phase-5 plan 3.1). Edited only by
// the operator (internal functions in plans.ts until the console exists).

export const planName = v.union(v.literal("free"), v.literal("team"), v.literal("custom"));
export type PlanName = Infer<typeof planName>;

export const planStatus = v.union(v.literal("active"), v.literal("suspended"), v.literal("pendingDeletion"));
export type PlanStatus = Infer<typeof planStatus>;

export const planLimits = v.object({
  maxDevices: v.number(),
  maxEmployees: v.number(),
  maxApps: v.number(),
  maxGroups: v.number(),
  maxMembers: v.number(),
  auditRetentionDays: v.number(),
  storageQuotaBytes: v.number(),
  maxUploadBytes: v.number(),
  watchMode: v.boolean(),
  maxEnrollmentCodesActive: v.number(),
});
export type PlanLimits = Infer<typeof planLimits>;

/** A partial `planLimits` for operator edits (only the given fields change). */
export const planLimitsPatch = v.object({
  maxDevices: v.optional(v.number()),
  maxEmployees: v.optional(v.number()),
  maxApps: v.optional(v.number()),
  maxGroups: v.optional(v.number()),
  maxMembers: v.optional(v.number()),
  auditRetentionDays: v.optional(v.number()),
  storageQuotaBytes: v.optional(v.number()),
  maxUploadBytes: v.optional(v.number()),
  watchMode: v.optional(v.boolean()),
  maxEnrollmentCodesActive: v.optional(v.number()),
});

export const webPermissions = v.object({
  camera: v.boolean(),
  microphone: v.boolean(),
  screenShare: v.boolean(),
  clipboardRead: v.boolean(),
  notifications: v.boolean(),
  downloads: v.boolean(),
  printing: v.boolean(),
  geolocation: v.boolean(),
});

/** PRD 24.1, same as rulebox_ipc `WebPermissions::default`. */
export const DEFAULT_WEB_PERMISSIONS: Infer<typeof webPermissions> = {
  camera: false,
  microphone: false,
  screenShare: false,
  clipboardRead: false,
  notifications: true,
  downloads: true,
  printing: false,
  geolocation: false,
};

export const webSpec = v.object({
  url: v.string(),
  allowedDomains: v.array(v.string()),
  permissions: webPermissions,
});

export const installSpec = v.object({
  kind: v.union(v.literal("msi"), v.literal("exe"), v.literal("portable")),
  url: v.string(), // https:// only
  sha256: v.string(), // 64 lower-case hex
  sizeBytes: v.number(), // 1 .. 4 GiB; 0 = unknown
  silentArgs: v.array(v.string()), // exe only
  productCode: v.optional(v.string()), // msi; "{GUID}" upper-case
  successExitCodes: v.array(v.number()),
  removeWhenUnassigned: v.boolean(),
});

export const desktopSpec = v.object({
  source: v.union(
    v.literal("winget"),
    v.literal("msi"),
    v.literal("exe"),
    v.literal("portable"),
    v.literal("preinstalled"),
  ),
  exe: v.string(),
  args: v.array(v.string()),
  fileArgTemplate: v.array(v.string()),
  install: v.optional(installSpec),
  wingetId: v.optional(v.string()),
  wingetVersion: v.optional(v.string()),
  resetFolders: v.array(v.string()),
});

export const appKind = v.union(v.literal("web"), v.literal("desktop"));
export const audience = v.union(v.literal("everyone"), v.literal("selected"));

export const installState = v.union(
  v.literal("pending"),
  v.literal("downloading"),
  v.literal("installing"),
  v.literal("installed"),
  v.literal("failed"),
  v.literal("removing"),
  v.literal("removed"),
  v.literal("unsupported"),
);

export const auditActorType = v.union(v.literal("member"), v.literal("device"), v.literal("system"));

export const policyKeyStatus = v.union(v.literal("active"), v.literal("next"), v.literal("retired"));

/** `wingetCache.resolved` (plan 4.8); filled in Step 10. */
export const wingetResolved = v.object({
  packageId: v.string(),
  version: v.string(),
  install: installSpec,
  defaultInstallLocation: v.optional(v.string()),
  publisher: v.optional(v.string()),
  name: v.optional(v.string()),
});

/** The 12 status fields the agent reports (Phase 2), as stored. */
export const reportedStatusFields = {
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
};
