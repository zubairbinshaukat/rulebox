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
  "mfa_required",
  "not_found",
  "invalid_argument",
  "stale_edit",
  "conflict",
  "last_owner",
  "rate_limited",
  "not_ready",
  "invite_invalid",
  "account_disabled",
  "mfa_invalid_code",
  "mfa_locked",
  "mfa_already_enabled",
  "winget_unsupported",
  "winget_unreachable",
  "webmeta_failed",
  "device_rejected",
  "too_large",
  "has_dependents",
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

/** `usePaginatedQuery` mirror. `canLoadMore` false = Convex status `Exhausted`. */
export type PagedState<T> =
  | { status: "loading" }
  | { status: "error"; error: unknown; retry: () => void }
  | {
      status: "ready";
      items: T[];
      canLoadMore: boolean;
      isLoadingMore: boolean;
      loadMore: () => void;
    };

export const PAGE_SIZE = 50;

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
  mfa: { enrolled: boolean; required: boolean; verified: boolean };
  serverApiVersion: number;
}
export interface NoAccess {
  noAccess: true;
  serverApiVersion: number;
}
/** `undefined` while loading, `null` when signed out. */
export type MeResult = Me | NoAccess | null;

/** `mfa:status` */
export interface MfaStatus {
  enrolled: boolean;
  required: boolean;
  verified: boolean;
  lockedUntil: number | null;
  recoveryCodesLeft: number;
}

/** `mfa:beginSetup` */
export interface MfaSetup {
  secret: string;
  uri: string;
}

/** `members:list` row */
export interface MemberRow {
  _id: Id;
  email: string;
  role: Role;
  status: MemberStatus;
  createdAt: number;
  mfaEnrolled: boolean;
  isYou: boolean;
  revision: number;
}
export interface InviteRow {
  _id: Id;
  email: string;
  role: Role;
  kind: "join" | "passwordReset";
  expiresAt: number;
  usedAt?: number;
}
export interface MembersScreen {
  members: MemberRow[];
  invites: InviteRow[];
}

// ---------------------------------------------------------------- organization

export interface OrgSettings {
  offlineDays: number;
  defaultQuotaGb: number;
  power: { sleep: boolean; restart: boolean; shutDown: boolean };
  adminExit: { enabled: boolean; hotkey: string };
}

/** `settings:get` — never the PIN hash. */
export interface SettingsScreen {
  name: string;
  revision: number;
  settings: OrgSettings;
  exitPin: { set: boolean };
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
  keys: PolicyKeyRow[];
  /** Devices that trust the `next` key, of all devices (null without a next key). */
  trust: { trusting: number; total: number } | null;
}

// ---------------------------------------------------------------- groups

/** `groups:list` row. Counts are capped at 501 by the server ("500+"). */
export interface GroupRow {
  _id: Id;
  name: string;
  description?: string;
  deviceCount: number;
  employeeCount: number;
  createdAt?: number;
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

/** `groups:get` */
export interface GroupDetail {
  _id: Id;
  name: string;
  description?: string;
  revision: number;
  assignments: AssignmentRow[];
  deviceCount: number;
  employeeCount: number;
  enrollmentCodeCount: number;
  /** App picker for "Assign app" (`apps.by_org_archived` `.take(500)`). */
  appOptions: AppOption[];
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

/** `fleet:list` / `fleet:search` row. Not `deviceStatus` (rule 4). */
export interface DeviceRow {
  _id: Id;
  name: string;
  groupId?: Id;
  groupName?: string;
  revoked: boolean;
  kioskEnabled: boolean;
  enrolledAt: number;
  report: Pick<
    DeviceReport,
    "agentVersion" | "osBuild" | "osEdition" | "kioskPhase" | "kioskError" | "appliedVersion" | "outOfSupport"
  > | null;
  latestVersion?: number;
}

/** `fleet:liveStatus` */
export interface LiveStatus {
  pingIntervalMs: number;
  items: { deviceId: Id; lastSeenAt: number }[];
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
  report: DeviceReport | null;
  versions: DocVersion[];
  flags: { noGroup: boolean; revoked: boolean; rotateCredential: boolean };
  /** Group picker options (`groups.by_org` `.take(500)`). */
  groups: GroupOption[];
}

export type DeviceFilter = { groupId?: Id; search?: string };

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
  groupCount: number;
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
  /** `apps:installSummary`: counts per state, each capped at 1001 ("1000+"). */
  installCounts: Partial<Record<InstallState, number>>;
  groupOptions: GroupOption[];
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

/** `fileHandlers:list` */
export interface FileTypesScreen {
  rows: { _id: Id; extension: string; appId: Id; appName: string }[];
  appOptions: AppOption[];
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

/** `overview:get({ nowMs })` */
export interface OverviewScreen {
  deviceCount: number;
  pingIntervalMs: number;
  /** `.take(1001)` → show "1000+" above 1000. */
  seenRecently: number;
  /** `.take(101)` → "100+". */
  devicesWithoutGroup: number;
  groupCount: number;
  employeeCount: number;
  appCount: number;
  failedInstalls: FailedInstallRow[];
  recentAudit: AuditEntry[];
  signing: { state: "none" | "active" | "rotating"; keyId?: string };
  publishFailedAt?: number;
}
