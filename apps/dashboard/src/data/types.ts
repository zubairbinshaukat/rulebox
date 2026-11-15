/**
 * Every type the dashboard's data hooks return or accept. Field names mirror
 * plan Section 4.2 (tables) and the return shapes of the Convex functions in
 * Section 4.13 / Steps 3–17, so swapping a hook body for `useQuery(api.x.y)`
 * is mechanical (see `src/data/README.md`).
 *
 * Ids are plain strings here. With the real backend they become
 * `Id<"devices">` etc. from `convex/_generated/dataModel`.
 */

export type Id = string;

// ---------------------------------------------------------------- errors

/** Plan Step 2 `lib/errors.ts` — the exact union the server throws. */
export const ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  "not_found",
  "invalid_argument",
  "stale_edit",
  "conflict",
  "last_owner",
  "rate_limited",
  "not_ready",
  "invite_invalid",
  "account_disabled",
  "winget_unsupported",
  "winget_unreachable",
  "webmeta_failed",
  "device_rejected",
  "too_large",
  "has_dependents",
  // Plan 4.6 (more than one organization); thrown by the member wrappers / joins.
  "org_required",
  "already_member",
  // Step-up authentication (plan 4.16); mirrors convex/lib/errors.ts.
  "step_up_required",
  "step_up_setup_required",
  "step_up_invalid",
  "step_up_locked",
  "step_up_last_factor",
  // Plans and limits (plan Step 5/6); `detail` names the limit or "suspended".
  "plan_limit",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorData {
  code: ErrorCode;
  field?: string;
  retryAfterMs?: number;
  detail?: string;
}

// ---------------------------------------------------------------- hook states

/** One query per screen. `loading` = Convex `useQuery` returned `undefined`. */
export type QueryState<T> =
  | { status: "loading" }
  | { status: "error"; error: unknown; retry: () => void }
  | { status: "ready"; data: T };

// ---------------------------------------------------------------- accounts

export type Role = "owner" | "admin" | "viewer";
export type MemberStatus = "active" | "disabled";

/** `account:me` */
export interface Me {
  email: string;
  role: Role;
  status: MemberStatus;
  orgId: Id;
  orgName: string;
  /**
   * Phase 4b: every member must set an action PIN. `set` false: the dashboard shows PIN setup
   * (every member write answers `step_up_setup_required` until then). Lockout counts and
   * "reset by email" are in `stepUp:status.pin`, not here.
   */
  pin: { required: boolean; set: boolean };
  serverApiVersion: number;
}
export interface NoAccess {
  noAccess: true;
  serverApiVersion: number;
}
/** `undefined` while loading, `null` when signed out. */
export type MeResult = Me | NoAccess | null;

/** `members:page` row */
export interface MemberRow {
  _id: Id;
  email: string;
  role: Role;
  status: MemberStatus;
  createdAt: number;
  isYou: boolean;
  revision: number;
}
/** `members:invitesPage` row (pending invites and reset codes only). */
export interface InviteRow {
  _id: Id;
  email: string;
  role: Role;
  kind: "join" | "passwordReset";
  expiresAt: number;
  createdAt: number;
}

// ---------------------------------------------------------------- step-up (plan 4.16)

/** `stepUp:status` passkey row: never a credential id, public key or hash. */
export interface PasskeyRow {
  _id: Id;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** Backed up / synced across devices (counter-less passkeys). */
  synced: boolean;
  /** Suspended after a signature counter went backwards (possible copy). */
  suspended: boolean;
}

/**
 * `stepUp:status.pin` (the lock screen\x27s source). `lockedUntil` is server time; the PIN is locked
 * while it is in the future: `lockKind` "lockout" is the long lockout (24 h, 72 h, 7 days),
 * "backoff" a short wait after a few wrong tries. `attemptsBeforeLockout` counts down from 10.
 * (The server still sends the Phase 4 `actionPin` object too; the dashboard ignores it.)
 */
export interface PinStatus {
  set: boolean;
  lockedUntil: number | null;
  lockKind: "backoff" | "lockout" | null;
  failedSinceUnlock: number;
  attemptsBeforeLockout: number;
  recoveryCodesLeft: number;
  /** The forgot-PIN email is configured on this deployment. */
  resetByEmail: boolean;
}

/**
 * `stepUp:status.pin`, the lock screen's source. `lockedUntil` is server time: the PIN is locked
 * while it is in the future. `lockKind` "lockout" is the long lockout (24 h, 72 h, 7 days),
 * "backoff" a short wait after a few wrong tries. `attemptsBeforeLockout` counts down from 10.
 * (The server still sends the Phase 4 `actionPin` object too; the dashboard ignores it.)
 */
export interface PinStatus {
  set: boolean;
  lockedUntil: number | null;
  lockKind: "backoff" | "lockout" | null;
  failedSinceUnlock: number;
  attemptsBeforeLockout: number;
  recoveryCodesLeft: number;
  /** The forgot-PIN email is configured on this deployment. */
  resetByEmail: boolean;
}

/** `stepUp:status`. Every timestamp is server time. */
export interface StepUpStatus {
  pin: PinStatus;
  passkeys: PasskeyRow[];
  /** False when the deployment has no WebAuthn configuration (the PIN keeps working). */
  passkeysAvailable: boolean;
  session: { verifiedAt: number | null; lastActiveAt: number | null; method: "actionPin" | "passkey" | null };
  /** With no factor yet: until when this session may set the first one (fresh sign-in). */
  bootstrapUntil: number | null;
  policy: { idleMs: number; keepAliveMs: number; freshMs: number; maxAgeMs: number };
}

/** `stepUp:verifyActionPin` / `passkeys:finishVerification` */
export interface StepUpVerified {
  verifiedAt: number;
  freshUntil: number;
  serverNow: number;
}

/** `passkeys:begin*`: the WebAuthn options as JSON (for @simplewebauthn/browser). */
export interface PasskeyOptions {
  optionsJson: string;
  expiresAt: number;
}

// ---------------------------------------------------------------- organization

export interface OrgSettings {
  offlineDays: number;
  defaultQuotaGb: number;
  power: { sleep: boolean; restart: boolean; shutDown: boolean };
  adminExit: { enabled: boolean; hotkey: string };
}

/** `settings:get` — never the PIN hash. `setAt`: when the current exit PIN was set (server time). */
export interface SettingsScreen {
  name: string;
  revision: number;
  settings: OrgSettings;
  exitPin: { set: boolean; setAt?: number };
}

/** `settings:update` */
export interface SettingsSaved {
  revision: number;
  /** Top-level names that changed ("name", "offlineDays", "power", "adminExit", …); empty = nothing written. */
  changed: string[];
}

// ---------------------------------------------------------------- plans (plan 4.2.1)

export type PlanName = "free" | "team" | "custom";
export type PlanStatus = "active" | "suspended" | "pendingDeletion";

/** `planLimits` of convex/lib/validators.ts. "No limit" is a very large number (`UNLIMITED`). */
export interface PlanLimits {
  maxDevices: number;
  maxEmployees: number;
  maxApps: number;
  maxGroups: number;
  maxMembers: number;
  auditRetentionDays: number;
  storageQuotaBytes: number;
  maxUploadBytes: number;
  watchMode: boolean;
  maxEnrollmentCodesActive: number;
}

/** The `plan_limit` detail names (`LimitKind` of convex/lib/plans.ts). */
export type LimitKind = "devices" | "employees" | "apps" | "groups" | "members" | "enrollmentCodes";

/** `settings:plan` */
export interface PlanScreen {
  plan: PlanName;
  status: PlanStatus;
  suspendedReason?: string;
  limits: PlanLimits;
  usage: Record<LimitKind, number>;
  pingIntervalMs: number;
}

export type PolicyKeyStatus = "active" | "next" | "retired";
export interface PolicyKeyRow {
  keyId: string;
  /** SHA-256 fingerprint shown in groups for comparison with the CLI. */
  fingerprint: string;
  status: PolicyKeyStatus;
  createdAt: number;
}
/** `keys:status` (+ `keys:trustProgress`) */
export interface KeysScreen {
  envKeyPresent: boolean;
  envNextKeyPresent: boolean;
  /**
   * Whether the publisher can sign: "ok" when the deployment's key is this
   * organization's active key, "missing" without a key, "mismatch" when the
   * deployment holds another key.
   */
  signing: "ok" | "missing" | "mismatch";
  /** When a publish last failed for want of a key (null when it works). */
  publishFailedAt: number | null;
  /**
   * A removal of a disabled employee is waiting to be signed (no usable key yet): their offline
   * sign-in lasts on the group's PCs until the key is back (`keys:status`).
   */
  rosterPending: boolean;
  keys: PolicyKeyRow[];
  /** Devices that trust the `next` key, of all devices (null without a next key). */
  trust: { trusting: number; total: number } | null;
}

// ---------------------------------------------------------------- groups

/**
 * `groups:list` row. The server sends `{ count, more }` per count
 * (`.take(501)`); the seam turns it into one number capped at 501, shown as
 * "500+" (`formatCount(n, 500)`).
 */
export interface GroupRow {
  _id: Id;
  name: string;
  description?: string;
  revision: number;
  deviceCount: number;
  employeeCount: number;
  createdAt?: number;
}

/** A count read with `.take(cap + 1)` (`groups:list` / `groups:get`). */
export interface CappedCount {
  count: number;
  more: boolean;
}

/** `GROUP_COUNT_CAP` of convex/lib/limits.ts. */
export const GROUP_COUNT_CAP = 500;

/** `{ count, more }` → one number; above the cap it is cap + 1 ("500+"). */
export function cappedNumber(c: CappedCount): number {
  return c.more ? GROUP_COUNT_CAP + 1 : c.count;
}

export type Audience = "everyone" | "selected";

export interface AssignmentRow {
  _id: Id;
  appId: Id;
  appName: string;
  appKind: AppKind;
  hue?: number;
  audience: Audience;
  pinnedTaskbar: boolean;
  pinnedDesktop: boolean;
}

/**
 * `groups:get`: the group, its counts (capped like `GroupRow`) and its
 * assigned apps (`.take(150)`); an assignment row's `_id` is its
 * `appAssignments` id (what edit and unassign take). Enrollment
 * codes are not counted here: `groups:remove` names them in `has_dependents`.
 */
export interface GroupDetail {
  _id: Id;
  name: string;
  description?: string;
  revision: number;
  assignments: AssignmentRow[];
  deviceCount: number;
  employeeCount: number;
}

export interface GroupOption {
  _id: Id;
  name: string;
}

// ---------------------------------------------------------------- devices

export type KioskPhase = "notApplied" | "applying" | "applied" | "failed" | "unknown";
export type ShellHealth = "notRunning" | "starting" | "healthy" | "unhealthy" | "failed" | "unknown";

/** The agent's compatibility report (apps/agent/src/compat.rs `CompatReport`). */
export interface CompatReport {
  os: {
    build: number;
    ubr: number;
    displayVersion: string;
    editionId: string;
    productType: number;
    arch: string;
    sMode: boolean;
    domainJoined: boolean;
    entraJoined: boolean;
    ramMb: number;
    systemDiskFreeGb: number;
  };
  blockers: string[];
  warnings: string[];
  liteMode: boolean;
}

/** `deviceReports` row (the 12 Phase 2 status fields + Phase 4 additions). */
export interface DeviceReport {
  agentVersion?: string;
  os?: string;
  osBuild?: string;
  osEdition?: string;
  ramMb?: number;
  diskFreeGb?: number;
  lockdownLevel?: string;
  kioskPhase?: KioskPhase;
  kioskError?: string;
  appliedVersion?: number;
  shellHealth?: ShellHealth;
  compat?: CompatReport;
  trustedKeyIds?: string[];
  restartPending?: boolean;
  outOfSupport: boolean;
  updatedAt: number;
}

/**
 * Online or offline as `devicePresence` stores it (plan 4.9, written only on a
 * transition). `since` = start of the current state; null for a PC not seen
 * since Step 7.
 */
export interface DevicePresence {
  online: boolean;
  since: number | null;
}

/**
 * What the PC's published head says about the plan: "overLimit" = the PC is over the plan's device
 * limit and keeps its last policy; "suspended" = the organization is suspended. "ok" and null show nothing.
 */
export type DevicePlanState = "ok" | "overLimit" | "suspended";

/** `fleet:list` row: `devices` + `deviceSummary` + `devicePresence`. Never `deviceLiveness` (rule 4). */
export interface DeviceRow {
  _id: Id;
  name: string;
  groupId?: Id;
  groupName?: string;
  revoked: boolean;
  kioskEnabled: boolean;
  enrolledAt: number;
  presence: DevicePresence;
  /** The summary (list columns only); null until the PC's first report. */
  report: Pick<
    DeviceReport,
    "agentVersion" | "osBuild" | "osEdition" | "kioskPhase" | "kioskError" | "appliedVersion" | "outOfSupport"
  > | null;
  latestVersion?: number;
  /** From the head (`fleet:list`); null before the first publish. Only "overLimit" and "suspended" are shown. */
  planState?: DevicePlanState | null;
}

/** `fleet:liveness`: the one liveness row of the watched device (plan 4.9). */
export interface DeviceLiveness {
  /** Minute bucket of the last contact; null for a PC never seen. */
  lastContactAt: number | null;
  online: boolean;
  fastUntil: number | null;
}

/** `fleet:checkResult` (admin): which of the asked PCs called in since. */
export interface CheckResult {
  requestedAt: number;
  items: { deviceId: Id; answered: boolean }[];
}

export interface DocVersion {
  version: number;
  createdAt: number;
  reason: string;
}

/** `fleet:get` */
export interface DeviceDetail {
  _id: Id;
  name: string;
  revision: number;
  revoked: boolean;
  kioskEnabled: boolean;
  enrolledAt: number;
  group: GroupOption | null;
  presence: DevicePresence;
  report: DeviceReport | null;
  versions: DocVersion[];
  flags: { noGroup: boolean; revoked: boolean; rotateCredential: boolean };
  /** Phase 5 Step 15: the PC's device lock (plan 4.17), or null. */
  lock: DeviceLock | null;
  /** Group picker options (`groups.by_org` `.take(500)`). */
  groups: GroupOption[];
}

/** `deviceLocks` of one PC: the text the lock view shows on every monitor. */
export interface DeviceLock {
  lockId: string;
  message: string;
  contact?: string;
  lockedAt: number;
}

/** Plain-text limits of the lock and broadcast forms (`convex/lib/limits.ts`; the agent has the same numbers). */
export const LOCK_MESSAGE_MAX = 300;
export const LOCK_CONTACT_MAX = 100;
export const BROADCAST_TITLE_MAX = 80;
export const BROADCAST_BODY_MAX = 500;
export const BROADCAST_ACTIVE_MAX = 20;
export type BroadcastStyle = "banner" | "fullscreen";

/** One row of `broadcasts:list`. `status` is worked out by the screen from `cancelledAt` and `expiresAt` (the query reads no clock). */
export interface BroadcastRow {
  _id: Id;
  /** `name` is null when the group or PC no longer exists. */
  target: { kind: "group" | "device"; id: Id; name: string | null };
  style: BroadcastStyle;
  title: string;
  body: string;
  expiresAt: number | null;
  ackRequired: boolean;
  createdAt: number;
  cancelledAt: number | null;
  /** PCs it was aimed at when sent (a group's count is capped at 500) and the PCs that acknowledged it. */
  targetCount: number;
  ackCount: number;
}

/** `broadcasts:send`. `expiresAt` in ms, optional. */
export interface BroadcastInput {
  target: { kind: "group" | "device"; id: Id };
  style: BroadcastStyle;
  title: string;
  body: string;
  expiresAt?: number;
  ackRequired: boolean;
}

/** `fleet:list({ groupId: "none" })` lists the devices that have no group. */
export const NO_GROUP_FILTER = "none";

// ---------------------------------------------------------------- installs

export type InstallState =
  | "pending"
  | "downloading"
  | "installing"
  | "installed"
  | "failed"
  | "removing"
  | "removed"
  | "unsupported";

export const INSTALL_STATES: readonly InstallState[] = [
  "installed",
  "failed",
  "pending",
  "downloading",
  "installing",
  "removing",
  "removed",
  "unsupported",
];

/** `fleet:installs` row */
export interface DeviceInstallRow {
  _id: Id;
  appId: Id;
  appName: string;
  state: InstallState;
  attempts: number;
  exitCode?: number;
  detail?: string;
  updatedAt: number;
  /**
   * False when the app is archived or has no install source (the server would refuse
   * `apps:retry`). Not sent yet: absent means unknown, and Retry then stays available.
   */
  retryable?: boolean;
}

/** `apps:installs` row */
export interface AppInstallRow {
  _id: Id;
  deviceId: Id;
  deviceName: string;
  state: InstallState;
  attempts: number;
  exitCode?: number;
  detail?: string;
  updatedAt: number;
}

// ---------------------------------------------------------------- employees

/** `employees:list` / `employees:search` row */
export interface EmployeeRow {
  _id: Id;
  name: string;
  username: string;
  quotaGb?: number;
  disabled: boolean;
  groups: GroupOption[];
  /** True when the employee is in more groups than listed. */
  moreGroups: boolean;
}

export interface EmployeeLockout {
  failures: number;
  lockedUntil: number;
}

/** `employees:get` */
export interface EmployeeDetail {
  _id: Id;
  name: string;
  username: string;
  quotaGb?: number;
  disabled: boolean;
  revision: number;
  passwordSet: boolean;
  passwordSetAt?: number;
  createdAt: number;
  groupIds: Id[];
  appIds: Id[];
  lockout: EmployeeLockout | null;
  /** Pickers: groups (`.take(500)`) and apps (`.take(500)`). */
  groupOptions: GroupOption[];
  appOptions: AppOption[];
  defaultQuotaGb: number;
}

export interface EmployeeInput {
  name: string;
  username: string;
  quotaGb?: number;
  groupIds: Id[];
  appIds: Id[];
  password?: string;
}

// ---------------------------------------------------------------- apps

export type AppKind = "web" | "desktop";
export type DesktopSource = "winget" | "msi" | "exe" | "portable" | "preinstalled";
export type InstallKind = "msi" | "exe" | "portable";

export interface WebPermissions {
  camera: boolean;
  microphone: boolean;
  screenShare: boolean;
  clipboardRead: boolean;
  notifications: boolean;
  downloads: boolean;
  printing: boolean;
  geolocation: boolean;
}

export const DEFAULT_WEB_PERMISSIONS: WebPermissions = {
  camera: false,
  microphone: false,
  screenShare: false,
  clipboardRead: false,
  notifications: true,
  downloads: true,
  printing: false,
  geolocation: false,
};

/**
 * What a NEW web app starts with (PRD 24.1; the server's `NEW_WEB_APP_PERMISSIONS`): printing is allowed here, and
 * the Staff App still needs a printer on the PC. Shown as "Default" next to each toggle.
 */
export const NEW_WEB_APP_PERMISSIONS: WebPermissions = { ...DEFAULT_WEB_PERMISSIONS, printing: true };

/** The eight permissions in the order the editor shows them. */
export const WEB_PERMISSION_KEYS: readonly (keyof WebPermissions)[] = [
  "camera",
  "microphone",
  "screenShare",
  "clipboardRead",
  "notifications",
  "downloads",
  "printing",
  "geolocation",
];

/** "Blocked in the last 30 days" for one permission (`apps:get` `denials30d`): a count, never a page or an employee. */
export interface PermissionDenialCount {
  kind: string;
  count: number;
}

export interface WebSpec {
  url: string;
  allowedDomains: string[];
  permissions: WebPermissions;
}

export interface InstallSpec {
  kind: InstallKind;
  url: string;
  sha256: string;
  sizeBytes: number;
  silentArgs: string[];
  productCode?: string;
  successExitCodes: number[];
  removeWhenUnassigned: boolean;
}

export interface DesktopSpec {
  source: DesktopSource;
  exe: string;
  args: string[];
  fileArgTemplate: string[];
  install?: InstallSpec;
  wingetId?: string;
  wingetVersion?: string;
  resetFolders: string[];
}

/** `apps:installSummary`: PCs per install state, each capped at 1001 ("1000+"); a state without PCs is absent. */
export type InstallCounts = Partial<Record<InstallState, number>> & {
  /** Some state had more rows than the server read, so a count may be low: the screen says "at least". */
  capped?: boolean;
};

export interface InstallSummary {
  installed: number;
  failed: number;
  /** pending + downloading + installing + removing */
  inProgress: number;
}

/** `apps:list` row */
export interface AppRow {
  _id: Id;
  name: string;
  description?: string;
  kind: AppKind;
  source?: DesktopSource;
  hue?: number;
  iconUrl?: string;
  archived: boolean;
  /** When the app was added. `apps:list` does not return it yet (backend gap: the "Added" column shows a dash until it does). */
  createdAt?: number;
  /** `apps:list` reads at most 10 assignments per app: `groupCount` is capped ("10+" with `groupCountMore`). */
  groupCount: number;
  groupCountMore: boolean;
  summary: InstallSummary | null;
}

export interface AppOption {
  _id: Id;
  name: string;
  kind: AppKind;
  canOpenFiles: boolean;
}

/** `apps:get` */
export interface AppDetail {
  _id: Id;
  name: string;
  description?: string;
  kind: AppKind;
  hue?: number;
  iconUrl?: string;
  web?: WebSpec;
  desktop?: DesktopSpec;
  archived: boolean;
  revision: number;
  createdAt: number;
  assignments: (AssignmentRow & { groupId: Id; groupName: string })[];
  fileTypes: string[];
  directEmployeeCount: number;
  groupOptions: GroupOption[];
  /** Blocked permission requests of the last 30 days, per kind, most first (websites only). */
  denials30d: PermissionDenialCount[];
}

export interface WebAppInput {
  name: string;
  description?: string;
  hue?: number;
  url: string;
  allowedDomains: string[];
}

export interface DesktopAppInput {
  name: string;
  description?: string;
  hue?: number;
  desktop: DesktopSpec;
}

/** `apps:fetchWebMeta` */
export interface WebMeta {
  name?: string;
  hue?: number;
  iconPreviewUrl?: string;
}

/** `apps:resolveWinget` */
export interface WingetResolved {
  packageId: string;
  version: string;
  install: InstallSpec;
  defaultInstallLocation?: string;
  publisher?: string;
  name?: string;
}

// ---------------------------------------------------------------- file types

/** `fileHandlers:page` row. The program picker of the add dialog is `apps:options` (`useAppOptions`). */
export interface FileTypeRow {
  _id: Id;
  extension: string;
  appId: Id;
  appName: string;
}

// ---------------------------------------------------------------- networks (Phase 5 Step 13)

/** `wifiProfiles.security` (802.1X / EAP is not part of Phase 5). */
export type WifiSecurity = "open" | "wpa2Personal" | "wpa3Personal" | "wpa2Wpa3Personal";

/**
 * One Wi-Fi profile as `networks:list` and `networks:wifiDetail` return it. There is NO passphrase here, ever:
 * `hasPassphrase` and `passphraseSetAt` are all the dashboard learns about it.
 */
export interface WifiRow {
  _id: Id;
  name: string;
  ssid: string;
  hidden: boolean;
  security: WifiSecurity;
  autoConnect: boolean;
  hasPassphrase: boolean;
  passphraseSetAt: number | null;
  revision: number;
  /** All assigned groups; `groups` carries only the first few (the list screen shows a handful of chips). */
  groupCount: number;
  groups: GroupOption[];
}

/** `printers.kind` (plan 4.15): IPP URL, raw TCP, LPR, or a shared queue on a server. */
export type PrinterKind = "ipp" | "raw" | "lpr" | "share";

/** One printer as `networks:list` and `networks:printerDetail` return it. */
export interface PrinterRow {
  _id: Id;
  name: string;
  kind: PrinterKind;
  address: string;
  /** Raw TCP only; empty = 9100. */
  port: number | null;
  /** LPR only. */
  queue: string | null;
  driver: string;
  revision: number;
  /** All assigned groups; `groups` carries only the first few. */
  groupCount: number;
  /** The groups this printer is the default of (a number: the screen only says "default for N"). */
  defaultGroupCount: number;
  groups: GroupOption[];
}

/** `networks:list`: Wi-Fi profiles, printers and the driver names the picker offers (the inbox class drivers plus the ones the organization approved). */
export interface NetworksScreen {
  wifi: WifiRow[];
  printers: PrinterRow[];
  /** (Step 14b) The drivers Rulebox delivers to PCs. */
  drivers: DriverRow[];
  /** The names the printer picker offers: the inbox class drivers, the names an admin added and the names delivered drivers provide. */
  approvedDrivers: string[];
  /** (Step 14b) Only the names an admin added (`orgSettings.phase5Settings.approvedPrinterDrivers`): what the Approved printer drivers card edits. */
  addedDrivers: string[];
}

/** `drivers.kind` (Step 14b): a zip with an INF, or a vendor's silent installer. */
export type DriverKind = "inf" | "exe" | "msi";
export type DriverClass = "printer" | "scanner" | "other";

/** One driver as `networks:list` and `drivers:detail` return it. */
export interface DriverRow {
  _id: Id;
  name: string;
  kind: DriverKind;
  deviceClass: DriverClass;
  /** 0 = unknown. */
  sizeBytes: number;
  revision: number;
  /** The printer driver names this package makes available to the printer form. */
  provides: string[];
  /** All assigned groups; `groups` carries only the first few. */
  groupCount: number;
  groups: GroupOption[];
}

/** How the PCs of the assigned groups report one driver, counted on demand (detail screen only). */
export interface DriverCounts {
  installed: number;
  failed: number;
  pending: number;
  removed: number;
  unsupported: number;
  /** Installed, and the installer asked for a restart (3010 / 1641) that has not happened yet. */
  restartNeeded: number;
  sampled: number;
  capped: boolean;
}

/** `drivers:detail`. */
export interface DriverDetail extends DriverRow {
  url: string;
  sha256: string;
  /** Zip drivers: the INF inside the archive. */
  inf: string | null;
  silentArgs: string[];
  successExitCodes: number[];
  groupIds: Id[];
  counts: DriverCounts;
}

/** `drivers:save`: no `id` creates; `id` + `expectedRevision` updates. */
export interface DriverInput {
  id?: Id;
  expectedRevision?: number;
  name: string;
  kind: DriverKind;
  deviceClass: DriverClass;
  url: string;
  sha256: string;
  sizeBytes: number;
  inf?: string;
  silentArgs: string[];
  successExitCodes: number[];
  provides: string[];
  groupIds: Id[];
}

/**
 * How the PCs of the assigned groups report one profile (`networks:wifiDetail`, on demand, detail screen only):
 * counted over at most `sampled` devices, `capped` when there were more.
 */
export interface WifiApplyCounts {
  applied: number;
  failed: number;
  waiting: number;
  unsupported: number;
  sampled: number;
  capped: boolean;
}

export interface WifiDetail extends WifiRow {
  groupIds: Id[];
  counts: WifiApplyCounts;
}

/** `networks:printerDetail`: the row, the group ids and the apply counts (same shape as a Wi-Fi profile's). */
export interface PrinterDetail extends PrinterRow {
  groupIds: Id[];
  defaultForGroupIds: Id[];
  counts: WifiApplyCounts;
}

/** `networks:savePrinter`: no `id` creates; `id` + `expectedRevision` updates. */
export interface PrinterInput {
  id?: Id;
  expectedRevision?: number;
  name: string;
  kind: PrinterKind;
  address: string;
  port?: number;
  queue?: string;
  driver: string;
  groupIds: Id[];
  defaultForGroupIds: Id[];
}

/** `networks:saveWifi`: no `id` creates; `id` + `expectedRevision` updates. Never carries a passphrase. */
export interface WifiInput {
  id?: Id;
  expectedRevision?: number;
  name: string;
  ssid: string;
  hidden: boolean;
  security: WifiSecurity;
  autoConnect: boolean;
  groupIds: Id[];
}

// ---------------------------------------------------------------- enrollment

export type EnrollmentCodeState = "active" | "usedUp" | "expired" | "revoked";

/** `enrollmentCodes:list` row — never the hash or the code. */
export interface EnrollmentCodeRow {
  _id: Id;
  label?: string;
  groupId?: Id;
  groupName?: string;
  usesLeft: number;
  usesTotal: number;
  expiresAt: number;
  createdAt: number;
  state: EnrollmentCodeState;
  createdByEmail?: string;
}

export interface EnrollmentInput {
  groupId: Id;
  uses: number;
  ttlMinutes: number;
  label?: string;
}

// ---------------------------------------------------------------- audit

export type AuditActorType = "member" | "device" | "system";

/** `audit:list` / `audit:forTarget` row */
export interface AuditEntry {
  _id: Id;
  at: number;
  actorType: AuditActorType;
  actorId?: string;
  actorLabel: string;
  action: string;
  targetType?: string;
  targetId?: string;
  targetLabel?: string;
  summary: string;
}

// ---------------------------------------------------------------- overview

export interface FailedInstallRow {
  _id: Id;
  deviceId: Id;
  deviceName: string;
  appId: Id;
  appName: string;
  detail?: string;
  updatedAt: number;
}

/** `overview:get`: the counters row (`orgStats`), never a list. */
export interface OverviewCounts {
  deviceCount: number;
  employeeCount: number;
  appCount: number;
  groupCount: number;
  noGroupDeviceCount: number;
  outOfSupportCount: number;
  failedInstallCount: number;
}

/** The state of the organization's signing keys ("none" = no active key, "rotating" = a next key is prepared). */
export type OverviewSigning = "none" | "active" | "rotating";

/** `overview:get` (no arguments): one small query that never re-runs on a ping. */
export interface OverviewScreen {
  counts: OverviewCounts;
  /** The sum of the `orgPresence` shards: PCs online now. */
  onlineCount: number;
  plan: { name: PlanName; status: PlanStatus; limits: PlanLimits };
  signing: OverviewSigning;
  publishFailedAt: number | null;
  /** A revocation / roster update is waiting to be signed (`rosterPending` rows exist). */
  rosterPending: boolean;
  recentAudit: AuditEntry[];
}

// ---------------------------------------------------------------- rollout rings (Phase 5 Step 16, plan 4.14)

export type Ring = "pilot" | "early" | "everyone";
export const RINGS: readonly Ring[] = ["pilot", "early", "everyone"];
export type RolloutPhase = "idle" | "rolling" | "halted";

/** Limits of the auto-promotion settings (`convex/lib/limits.ts`): whole numbers. */
export const MIN_BAKE_HOURS = 1;
export const MAX_BAKE_HOURS = 168;
export const MIN_FAILURE_PCT = 1;
export const MAX_FAILURE_PCT = 100;
/** How many PCs `rollouts:groupView` lists, and how many a ring change may take at once. */
export const MAX_RING_LIST = 100;

/** The group's rollout row. `revision` is what every rollout mutation sends back as `expectedRevision`. */
export interface RolloutRow {
  enabled: boolean;
  /** The configuration version each ring follows. */
  pointers: { pilot: number; early: number; everyone: number };
  autoPromote: { enabled: boolean; bakeHours: number; maxFailurePct: number };
  autoRollback: boolean;
  state: RolloutPhase;
  /** `failure_rate`, `pilot_rolled_back`, `rolled_back`; unknown codes are shown generically. */
  haltReason: string | null;
  stageStartedAt: number | null;
  revision: number;
}

/** `rollouts:groupView`: small and quiet; the numbers that move with every report are in `RolloutHealth`. */
export interface RolloutView {
  groupName: string;
  /** null = the group has no configuration version yet. */
  rollout: RolloutRow | null;
  /** The versions a rollback can go to, newest first. */
  versions: { version: number; reason: string; createdAt: number }[];
  /** The stage in flight (null when rings are off or every ring follows one version). */
  stage: { ring: "pilot" | "early"; version: number } | null;
  devices: { _id: Id; name: string; ring: Ring }[];
  devicesTruncated: boolean;
}

/** `rollouts:health`: the stage in flight. All zeros and `stage: null` when nothing is rolling out. */
export interface RolloutHealth {
  stage: { ring: "pilot" | "early"; version: number } | null;
  ringSize: number;
  ringCapped: boolean;
  applied: number;
  failed: number;
  partial: number;
  waiting: number;
  pilotRolledBack: boolean;
  reportsCapped: boolean;
}
