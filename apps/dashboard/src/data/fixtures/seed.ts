/**
 * Deterministic demo data. The same seed always builds the same organization,
 * with the edge cases the screens must handle: very long names, empty groups,
 * a group with 500+ devices (capped counts), 1000+ install results for one
 * app, revoked / out-of-support / never-reported devices, failed installs,
 * expired / used-up / revoked enrollment codes, disabled and locked-out
 * employees, and enough rows that every list paginates.
 *
 * Times are relative to `now` so "last seen 2 minutes ago" stays true.
 */
import type {
  AppKind,
  AuditActorType,
  CompatReport,
  DesktopSpec,
  InstallState,
  KioskPhase,
  OrgSettings,
  PolicyKeyStatus,
  Role,
  ShellHealth,
  WebSpec,
} from "../types";
import { DEFAULT_WEB_PERMISSIONS } from "../types";

export const DEMO_PASSWORD = "rulebox-demo-1";
export const DEMO_TOTP = "123456";
/** The demo Owner's action PIN (step-up, plan 4.16); other demo members start without one. */
export const DEMO_ACTION_PIN = "482915";
export const DEMO_INVITE_CODE = "JOIN-DEMO-2026";
export const DEMO_RESET_CODE = "RESET-DEMO-2026";
export const DEMO_OWNER_EMAIL = "owner@demo.rulebox.test";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------- row types (server tables)

export interface DbMember {
  _id: string;
  email: string;
  role: Role;
  status: "active" | "disabled";
  createdAt: number;
  revision: number;
  password: string;
  mfa: { enrolled: boolean; recoveryCodes: string[] };
}
export interface DbInvite {
  _id: string;
  email: string;
  role: Role;
  kind: "join" | "passwordReset";
  code: string;
  expiresAt: number;
  usedAt?: number;
}
export interface DbGroup {
  _id: string;
  name: string;
  description?: string;
  revision: number;
  createdAt: number;
}
export interface DbDevice {
  _id: string;
  name: string;
  groupId?: string;
  revoked: boolean;
  kioskEnabled: boolean;
  enrolledAt: number;
  revision: number;
  rotateCredential: boolean;
}
export interface DbReport {
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
export interface DbEmployee {
  _id: string;
  name: string;
  username: string;
  quotaGb?: number;
  disabled: boolean;
  revision: number;
  passwordSetAt?: number;
  createdAt: number;
}
export interface DbApp {
  _id: string;
  name: string;
  description?: string;
  kind: AppKind;
  hue?: number;
  web?: WebSpec;
  desktop?: DesktopSpec;
  archived: boolean;
  revision: number;
  createdAt: number;
}
export interface DbAssignment {
  _id: string;
  groupId: string;
  appId: string;
  audience: "everyone" | "selected";
  pinnedTaskbar: boolean;
  pinnedDesktop: boolean;
}
export interface DbInstall {
  _id: string;
  deviceId: string;
  appId: string;
  state: InstallState;
  attempts: number;
  exitCode?: number;
  detail?: string;
  updatedAt: number;
}
export interface DbToken {
  _id: string;
  label?: string;
  groupId?: string;
  usesLeft: number;
  usesTotal: number;
  expiresAt: number;
  revoked: boolean;
  createdAt: number;
  createdBy?: string;
}
export interface DbAudit {
  _id: string;
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
export interface DbKey {
  keyId: string;
  fingerprint: string;
  status: PolicyKeyStatus;
  createdAt: number;
}

export interface DemoDb {
  org: { _id: string; name: string; revision: number; settings: OrgSettings; exitPinSet: boolean };
  pingIntervalMs: number;
  members: DbMember[];
  invites: DbInvite[];
  groups: DbGroup[];
  devices: DbDevice[];
  reports: Map<string, DbReport>;
  lastSeen: Map<string, number>;
  /** Devices the heartbeat simulation keeps fresh. */
  onlineIds: Set<string>;
  versions: Map<string, { version: number; createdAt: number; reason: string }[]>;
  employees: DbEmployee[];
  lockouts: Map<string, { failures: number; lockedUntil: number }>;
  groupMembers: { groupId: string; employeeId: string }[];
  apps: DbApp[];
  assignments: DbAssignment[];
  employeeApps: { employeeId: string; appId: string }[];
  fileHandlers: { _id: string; extension: string; appId: string }[];
  tokens: DbToken[];
  installs: DbInstall[];
  audit: DbAudit[];
  keys: DbKey[];
  env: { key: boolean; next: boolean };
  nextId: number;
}

// ---------------------------------------------------------------- helpers

function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pingIntervalFor(deviceCount: number): number {
  if (deviceCount <= 25) return 5 * MIN;
  if (deviceCount <= 100) return 15 * MIN;
  if (deviceCount <= 300) return 30 * MIN;
  return 60 * MIN;
}

const FIRST = [
  "Ayesha", "Bilal", "Carmen", "Daniel", "Elif", "Farhan", "Grace", "Hamza", "Ines", "Jonas",
  "Kiran", "Leila", "Mateo", "Noor", "Oskar", "Priya", "Quinn", "Rosa", "Sami", "Tariq",
  "Uma", "Vera", "Wei", "Ximena", "Yusuf", "Zara", "Amir", "Beatriz", "Chen", "Dalia",
];
const LAST = [
  "Ahmed", "Bauer", "Costa", "Diallo", "Evans", "Fischer", "García", "Haddad", "Ito", "Jensen",
  "Khan", "Lopez", "Malik", "Nakamura", "Okafor", "Petrov", "Qureshi", "Rossi", "Silva", "Tanaka",
];

function hex(rand: () => number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += Math.floor(rand() * 16).toString(16);
  return s;
}

function compat(build: number, edition: string, ramMb: number, diskGb: number, opts: Partial<CompatReport> = {}): CompatReport {
  return {
    os: {
      build,
      ubr: 4351,
      displayVersion: build >= 26100 ? "24H2" : build >= 22631 ? "23H2" : "22H2",
      editionId: edition,
      productType: 1,
      arch: "x64",
      sMode: false,
      domainJoined: false,
      entraJoined: false,
      ramMb,
      systemDiskFreeGb: diskGb,
    },
    blockers: [],
    warnings: diskGb < 2 ? ["low_disk"] : [],
    liteMode: ramMb <= 4352,
    ...opts,
  };
}

// ---------------------------------------------------------------- seed

export function seed(now: number = Date.now()): DemoDb {
  const rand = prng(20261027);
  let nextId = 1;
  const id = (prefix: string) => `${prefix}_${(nextId++).toString(36).padStart(4, "0")}`;
  const pick = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;

  // ---- members
  const owner: DbMember = {
    _id: id("mem"),
    email: DEMO_OWNER_EMAIL,
    role: "owner",
    status: "active",
    createdAt: now - 120 * DAY,
    revision: 0,
    password: DEMO_PASSWORD,
    mfa: { enrolled: true, recoveryCodes: ["7KQ2-M9XD", "4HTR-2WPZ", "Q8VN-3JCE"] },
  };
  const members: DbMember[] = [
    owner,
    {
      _id: id("mem"),
      email: "sam.okafor@demo.rulebox.test",
      role: "admin",
      status: "active",
      createdAt: now - 90 * DAY,
      revision: 0,
      password: DEMO_PASSWORD,
      mfa: { enrolled: true, recoveryCodes: [] },
    },
    {
      _id: id("mem"),
      email: "auditor.with.a.really.long.mailbox.name@regional-compliance-office.demo.rulebox.test",
      role: "viewer",
      status: "active",
      createdAt: now - 30 * DAY,
      revision: 0,
      password: DEMO_PASSWORD,
      mfa: { enrolled: false, recoveryCodes: [] },
    },
    {
      _id: id("mem"),
      email: "former.manager@demo.rulebox.test",
      role: "admin",
      status: "disabled",
      createdAt: now - 200 * DAY,
      revision: 2,
      password: DEMO_PASSWORD,
      mfa: { enrolled: true, recoveryCodes: [] },
    },
  ];
  const invites: DbInvite[] = [
    {
      _id: id("inv"),
      email: "new.admin@demo.rulebox.test",
      role: "admin",
      kind: "join",
      code: DEMO_INVITE_CODE,
      expiresAt: now + 5 * DAY,
    },
    {
      _id: id("inv"),
      email: "sam.okafor@demo.rulebox.test",
      role: "admin",
      kind: "passwordReset",
      code: DEMO_RESET_CODE,
      expiresAt: now + 20 * HOUR,
    },
  ];

  // ---- groups
  const mkGroup = (name: string, description: string | undefined, ageDays: number): DbGroup => ({
    _id: id("grp"),
    name,
    description,
    revision: 0,
    createdAt: now - ageDays * DAY,
  });
  const gFront = mkGroup("Front desk", "Customer-facing PCs at every branch.", 110);
  const gCounter = mkGroup("Pharmacy counter", "Dispensing and label printing.", 100);
  const gOffice = mkGroup("Back office", undefined, 95);
  const gNight = mkGroup(
    "Warehouse & Receiving — Night Shift Team B (temp)",
    "Temporary group for the night receiving crew while the warehouse is being rebuilt. Remove after the move.",
    40,
  );
  const gTraining = mkGroup("Training room", "Spare PCs for onboarding.", 12);
  const groups = [gFront, gCounter, gOffice, gNight, gTraining];

  // ---- apps
  const web = (url: string, extra: string[] = []): WebSpec => ({
    url,
    allowedDomains: [new URL(url).hostname, ...extra],
    permissions: { ...DEFAULT_WEB_PERMISSIONS },
  });
  const mkApp = (a: Omit<DbApp, "_id" | "revision" | "createdAt" | "archived"> & { archived?: boolean; age?: number }): DbApp => ({
    _id: id("app"),
    revision: 1,
    createdAt: now - (a.age ?? 60) * DAY,
    archived: a.archived ?? false,
    name: a.name,
    description: a.description,
    kind: a.kind,
    hue: a.hue,
    web: a.web,
    desktop: a.desktop,
  });
  const aPos = mkApp({ name: "Point of Sale", description: "Tills and receipts", kind: "web", hue: 175, web: web("https://pos.example.com", ["*.pos-cdn.example.com"]), age: 100 });
  const aStock = mkApp({ name: "Stock & orders", kind: "web", hue: 40, web: web("https://stock.example.com"), age: 90 });
  const aMail = mkApp({ name: "Webmail", description: "Team email", kind: "web", hue: 220, web: web("https://mail.example.org"), age: 80 });
  const aClock = mkApp({ name: "Time clock", kind: "web", hue: 300, web: web("https://timeclock.example.net"), age: 70 });
  const aRef = mkApp({ name: "Drug reference", description: "Interactions and dosages", kind: "web", hue: 150, web: web("https://reference.example.com"), age: 50 });
  const aVlc = mkApp({
    name: "VLC media player",
    kind: "desktop",
    hue: 30,
    desktop: {
      source: "winget",
      wingetId: "VideoLAN.VLC",
      wingetVersion: "3.0.21",
      exe: "{ProgramFiles}\\VideoLAN\\VLC\\vlc.exe",
      args: [],
      fileArgTemplate: ["{file}"],
      resetFolders: ["{RoamingAppData}\\vlc"],
      install: {
        kind: "exe",
        url: "https://get.videolan.org/vlc/3.0.21/win64/vlc-3.0.21-win64.exe",
        sha256: hex(rand, 64),
        sizeBytes: 44_000_000,
        silentArgs: ["/S"],
        successExitCodes: [0],
        removeWhenUnassigned: false,
      },
    },
    age: 45,
  });
  const a7z = mkApp({
    name: "7-Zip",
    description: "Open .zip and .7z archives",
    kind: "desktop",
    hue: 100,
    desktop: {
      source: "winget",
      wingetId: "7zip.7zip",
      wingetVersion: "24.08",
      exe: "{ProgramFiles}\\7-Zip\\7zFM.exe",
      args: [],
      fileArgTemplate: ["{file}"],
      resetFolders: [],
      install: {
        kind: "msi",
        url: "https://www.7-zip.org/a/7z2408-x64.msi",
        sha256: hex(rand, 64),
        sizeBytes: 1_900_000,
        silentArgs: [],
        productCode: "{23170F69-40C1-2702-2408-000001000000}",
        successExitCodes: [0],
        removeWhenUnassigned: true,
      },
    },
    age: 44,
  });
  const aPdf = mkApp({
    name: "PDF Reader",
    kind: "desktop",
    hue: 10,
    desktop: {
      source: "exe",
      exe: "{ProgramFiles}\\PDF Reader\\reader.exe",
      args: ["--kiosk"],
      fileArgTemplate: ["--open", "{file}"],
      resetFolders: ["{LocalAppData}\\PDF Reader\\Cache"],
      install: {
        kind: "exe",
        url: "https://downloads.example.com/pdf-reader/setup-5.2.exe",
        sha256: hex(rand, 64),
        sizeBytes: 120_000_000,
        silentArgs: ["/VERYSILENT", "/NORESTART"],
        successExitCodes: [0],
        removeWhenUnassigned: false,
      },
    },
    age: 40,
  });
  const aLabel = mkApp({
    name: "Prescription Label Printing Utility — Deluxe Edition 2026",
    description: "Prints dispensing labels on the counter's thermal printer. Requires the USB printer to be connected before start.",
    kind: "desktop",
    hue: 260,
    desktop: {
      source: "portable",
      exe: "{RuleboxApps}\\{AppId}\\labels.exe",
      args: [],
      fileArgTemplate: [],
      resetFolders: [],
      install: {
        kind: "portable",
        url: "https://downloads.example.com/labels/labels-2026.1.exe",
        sha256: hex(rand, 64),
        sizeBytes: 8_400_000,
        silentArgs: [],
        successExitCodes: [0],
        removeWhenUnassigned: true,
      },
    },
    age: 20,
  });
  const aNotepad = mkApp({
    name: "Notepad",
    kind: "desktop",
    hue: 200,
    desktop: {
      source: "preinstalled",
      exe: "{SystemRoot}\\System32\\notepad.exe",
      args: [],
      fileArgTemplate: ["{file}"],
      resetFolders: [],
    },
    age: 100,
  });
  const aOld = mkApp({ name: "Old scheduler", kind: "web", hue: 60, web: web("https://old-scheduler.example.com"), archived: true, age: 150 });
  const apps = [aPos, aStock, aMail, aClock, aRef, aVlc, a7z, aPdf, aLabel, aNotepad, aOld];

  const assign = (g: DbGroup, a: DbApp, o: Partial<DbAssignment> = {}): DbAssignment => ({
    _id: id("asg"),
    groupId: g._id,
    appId: a._id,
    audience: "everyone",
    pinnedTaskbar: false,
    pinnedDesktop: true,
    ...o,
  });
  const assignments: DbAssignment[] = [
    assign(gFront, aPos, { pinnedTaskbar: true }),
    assign(gFront, aMail),
    assign(gFront, a7z),
    assign(gFront, aPdf),
    assign(gCounter, aPos, { pinnedTaskbar: true }),
    assign(gCounter, aRef, { pinnedTaskbar: true }),
    assign(gCounter, aLabel, { audience: "selected" }),
    assign(gCounter, aPdf),
    assign(gOffice, aStock, { pinnedTaskbar: true }),
    assign(gOffice, aMail),
    assign(gOffice, aClock),
    assign(gOffice, aVlc, { pinnedDesktop: false }),
    assign(gOffice, aNotepad),
    assign(gNight, aStock),
    assign(gNight, aClock, { pinnedTaskbar: true }),
  ];

  const fileHandlers = [
    { _id: id("fh"), extension: ".pdf", appId: aPdf._id },
    { _id: id("fh"), extension: ".zip", appId: a7z._id },
    { _id: id("fh"), extension: ".7z", appId: a7z._id },
    { _id: id("fh"), extension: ".mp4", appId: aVlc._id },
    { _id: id("fh"), extension: ".mp3", appId: aVlc._id },
    { _id: id("fh"), extension: ".txt", appId: aNotepad._id },
  ];

  // ---- devices
  const devices: DbDevice[] = [];
  const reports = new Map<string, DbReport>();
  const lastSeen = new Map<string, number>();
  const onlineIds = new Set<string>();
  const versions = new Map<string, { version: number; createdAt: number; reason: string }[]>();
  const keyId = "a3f19c07d2e8b456";

  const addDevice = (
    name: string,
    group: DbGroup | undefined,
    o: {
      online?: boolean;
      lastSeenAgo?: number;
      build?: number;
      edition?: string;
      outOfSupport?: boolean;
      revoked?: boolean;
      kioskEnabled?: boolean;
      kioskPhase?: KioskPhase;
      kioskError?: string;
      shellHealth?: ShellHealth;
      noReport?: boolean;
      lag?: number;
      ramMb?: number;
      diskFreeGb?: number;
      restartPending?: boolean;
      rotate?: boolean;
      ageDays?: number;
    } = {},
  ) => {
    const d: DbDevice = {
      _id: id("dev"),
      name,
      groupId: group?._id,
      revoked: o.revoked ?? false,
      kioskEnabled: o.kioskEnabled ?? true,
      enrolledAt: now - (o.ageDays ?? 30 + Math.floor(rand() * 60)) * DAY,
      revision: 0,
      rotateCredential: o.rotate ?? false,
    };
    devices.push(d);
    const latest = 4 + Math.floor(rand() * 20);
    const list = [];
    for (let v = latest; v > Math.max(0, latest - 5); v--) {
      list.push({
        version: v,
        createdAt: now - (latest - v) * 3 * DAY - Math.floor(rand() * DAY),
        reason: pick(["settings changed", "app assigned", "employee updated", "group changed", "key registered"]),
      });
    }
    versions.set(d._id, list);
    if (!o.noReport) {
      const build = o.build ?? pick([22631, 26100, 26100, 26200]);
      const edition = o.edition ?? pick(["Professional", "Enterprise", "Professional"]);
      const ramMb = o.ramMb ?? pick([4096, 8192, 8192, 16384]);
      const diskFreeGb = o.diskFreeGb ?? 20 + Math.floor(rand() * 180);
      reports.set(d._id, {
        agentVersion: pick(["0.4.0", "0.4.1", "0.4.1", "0.4.1"]),
        os: build >= 22000 ? "Windows 11" : "Windows 10",
        osBuild: `${build}.${4000 + Math.floor(rand() * 900)}`,
        osEdition: edition,
        ramMb,
        diskFreeGb,
        lockdownLevel: "standard",
        kioskPhase: o.kioskPhase ?? (o.kioskEnabled === false ? "notApplied" : "applied"),
        kioskError: o.kioskError,
        appliedVersion: latest - (o.lag ?? 0),
        shellHealth: o.shellHealth ?? "healthy",
        compat: compat(build, edition, ramMb, diskFreeGb),
        trustedKeyIds: [keyId],
        restartPending: o.restartPending,
        outOfSupport: o.outOfSupport ?? false,
        updatedAt: now - Math.floor(rand() * 6) * HOUR,
      });
      const ago = o.lastSeenAgo ?? (o.online === false ? 2 * DAY + Math.floor(rand() * 5 * DAY) : Math.floor(rand() * 20) * MIN);
      lastSeen.set(d._id, now - ago);
      if (o.online !== false && o.lastSeenAgo === undefined && !o.revoked) onlineIds.add(d._id);
    }
    return d;
  };

  // A handful of hand-made PCs first (they sort to the end: lists are newest first).
  const dCounter1 = addDevice("COUNTER-01", gCounter, { ageDays: 14 });
  addDevice("COUNTER-02", gCounter, { restartPending: true, ageDays: 13 });
  addDevice("COUNTER-03", gCounter, { online: false, ageDays: 12 });
  const dOffice1 = addDevice("OFFICE-MANAGER", gOffice, { kioskEnabled: false, ageDays: 11 });
  addDevice("OFFICE-ACCOUNTS", gOffice, { build: 19045, edition: "Professional", outOfSupport: true, ageDays: 10 });
  addDevice("OFFICE-SCANNER", gOffice, { build: 26100, edition: "Core", outOfSupport: true, kioskPhase: "failed", kioskError: "desired_state_untrusted", shellHealth: "unhealthy", ageDays: 9 });
  addDevice("WAREHOUSE-RECEIVING-DOCK-EAST-TERMINAL-02-LEGACY-HARDWARE-ON-LOAN-FROM-HEAD-OFFICE", gNight, { lag: 2, ageDays: 8 });
  addDevice("WAREHOUSE-01", gNight, { lag: 1, ramMb: 4096, diskFreeGb: 1, ageDays: 7 });
  addDevice("SPARE-LAPTOP-07", undefined, { ageDays: 6 });
  addDevice("NEW-PC-UNBOXED", undefined, { noReport: true, ageDays: 1 });
  addDevice("STOLEN-TABLET", gFront, { revoked: true, online: false, ageDays: 4 });
  addDevice("LOANER-03", undefined, { online: false, kioskPhase: "applying", ageDays: 3, rotate: true });

  // 512 front desk PCs: the "500+" cap and the 1000+ install rows.
  const frontIds: string[] = [];
  for (let i = 1; i <= 512; i++) {
    const offline = i % 17 === 0;
    const d = addDevice(`FD-${String(i).padStart(3, "0")}`, gFront, {
      online: !offline,
      lag: i % 41 === 0 ? 1 : 0,
      ageDays: 400 - Math.floor(i / 4),
    });
    frontIds.push(d._id);
  }

  // ---- installs
  const installs: DbInstall[] = [];
  const devicesOf = (g: DbGroup) => devices.filter((d) => d.groupId === g._id && !d.revoked);
  const installFor = (a: DbApp, g: DbGroup) => {
    for (const d of devicesOf(g)) {
      if (!reports.has(d._id)) continue;
      const r = rand();
      let state: InstallState = "installed";
      let detail: string | undefined;
      let exitCode: number | undefined;
      let attempts = 1;
      if (r < 0.012) {
        state = "failed";
        detail = pick(["hash_mismatch", "low_disk", "timeout", "exe_missing_after_install"]);
        attempts = 5;
        exitCode = detail === "timeout" ? undefined : pick([1603, 2, 1]);
      } else if (r < 0.03) state = pick(["pending", "downloading", "installing"] as const);
      installs.push({
        _id: id("ins"),
        deviceId: d._id,
        appId: a._id,
        state,
        attempts,
        exitCode,
        detail,
        updatedAt: now - Math.floor(rand() * 10 * DAY),
      });
    }
  };
  installFor(a7z, gFront);
  installFor(aPdf, gFront);
  installFor(aPdf, gCounter);
  installFor(aLabel, gCounter);
  installFor(aVlc, gOffice);
  // A sure failure on a named PC for the screenshots.
  installs.push({
    _id: id("ins"),
    deviceId: dCounter1._id,
    appId: aVlc._id,
    state: "unsupported",
    attempts: 0,
    updatedAt: now - 3 * DAY,
  });
  installs.push({
    _id: id("ins"),
    deviceId: dOffice1._id,
    appId: aLabel._id,
    state: "failed",
    attempts: 5,
    exitCode: 1603,
    detail: "hash_mismatch",
    updatedAt: now - 2 * HOUR,
  });

  // ---- employees
  const employees: DbEmployee[] = [];
  const groupMembers: { groupId: string; employeeId: string }[] = [];
  const lockouts = new Map<string, { failures: number; lockedUntil: number }>();
  const usernames = new Set<string>();
  const addEmployee = (nameStr: string, o: Partial<DbEmployee> & { groups?: DbGroup[] } = {}) => {
    let base = nameStr
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, ".")
      .replace(/^\.|\.$/g, "")
      .slice(0, 40);
    let u = base;
    let k = 2;
    while (usernames.has(u)) u = `${base}${k++}`;
    usernames.add(u);
    base = u;
    const e: DbEmployee = {
      _id: id("emp"),
      name: nameStr,
      username: base,
      quotaGb: o.quotaGb,
      disabled: o.disabled ?? false,
      revision: 0,
      passwordSetAt: "passwordSetAt" in o ? o.passwordSetAt : now - Math.floor(rand() * 60) * DAY,
      createdAt: o.createdAt ?? now - Math.floor(rand() * 100) * DAY,
    };
    employees.push(e);
    for (const g of o.groups ?? []) groupMembers.push({ groupId: g._id, employeeId: e._id });
    return e;
  };
  for (let i = 0; i < 136; i++) {
    const nm = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
    const gs: DbGroup[] = [];
    const r = rand();
    if (r < 0.55) gs.push(gFront);
    else if (r < 0.75) gs.push(gCounter);
    else if (r < 0.9) gs.push(gOffice);
    else gs.push(gNight);
    if (rand() < 0.15) gs.push(gOffice === gs[0] ? gCounter : gOffice);
    addEmployee(nm, { groups: gs, quotaGb: rand() < 0.1 ? 25 : undefined, createdAt: now - (140 - i) * DAY });
  }
  const eLong = addEmployee("Maria-Fernanda Concepción de los Ángeles Villanueva-Rodríguez y Castellanos", {
    groups: [gFront, gCounter, gOffice, gNight],
    quotaGb: 0,
    createdAt: now - 3 * DAY,
  });
  const eLocked = addEmployee("Jonas Weber", { groups: [gCounter], createdAt: now - 2 * DAY });
  lockouts.set(eLocked._id, { failures: 10, lockedUntil: now + 11 * MIN });
  addEmployee("Former Seasonal Worker", { groups: [gFront], disabled: true, createdAt: now - DAY });
  addEmployee("Nobody Yet", { groups: [], passwordSetAt: undefined, createdAt: now - 2 * HOUR });

  const employeeApps = [
    { employeeId: eLong._id, appId: aRef._id },
    { employeeId: eLong._id, appId: aVlc._id },
    { employeeId: employees[3]!._id, appId: aClock._id },
  ];

  // ---- enrollment codes
  const tokens: DbToken[] = [
    { _id: id("tok"), label: "Branch 4 rollout", groupId: gFront._id, usesLeft: 7, usesTotal: 20, expiresAt: now + 2 * DAY, revoked: false, createdAt: now - 1 * DAY, createdBy: owner._id },
    { _id: id("tok"), label: "Night crew laptops (handed out at the gate by security — ask Tom)", groupId: gNight._id, usesLeft: 0, usesTotal: 3, expiresAt: now + 3 * DAY, revoked: false, createdAt: now - 3 * DAY, createdBy: members[1]!._id },
    { _id: id("tok"), groupId: gCounter._id, usesLeft: 1, usesTotal: 1, expiresAt: now - 2 * HOUR, revoked: false, createdAt: now - 10 * HOUR, createdBy: owner._id },
    { _id: id("tok"), label: "Lost — do not use", groupId: gOffice._id, usesLeft: 5, usesTotal: 5, expiresAt: now + 4 * DAY, revoked: true, createdAt: now - 4 * DAY, createdBy: owner._id },
    { _id: id("tok"), label: "Training room setup", groupId: gTraining._id, usesLeft: 10, usesTotal: 10, expiresAt: now + 40 * MIN, revoked: false, createdAt: now - 20 * MIN, createdBy: owner._id },
  ];

  // ---- audit (newest last here; queries sort)
  const audit: DbAudit[] = [];
  const log = (at: number, action: string, actor: DbMember | null, target?: { type: string; id: string; label: string }, summary = "") =>
    audit.push({
      _id: id("aud"),
      at,
      actorType: actor ? "member" : "system",
      actorId: actor?._id,
      actorLabel: actor?.email ?? "Rulebox",
      action,
      targetType: target?.type,
      targetId: target?.id,
      targetLabel: target?.label,
      summary,
    });
  const deviceLog = (at: number, action: string, d: DbDevice, summary: string) =>
    audit.push({
      _id: id("aud"),
      at,
      actorType: "device",
      actorId: d._id,
      actorLabel: d.name,
      action,
      targetType: "device",
      targetId: d._id,
      targetLabel: d.name,
      summary,
    });
  log(now - 119 * DAY, "policy.keyRegistered", owner, undefined, `Signing key ${keyId} registered.`);
  for (const g of groups) log(g.createdAt, "group.created", owner, { type: "group", id: g._id, label: g.name }, `Group “${g.name}” created.`);
  for (const a of apps) log(a.createdAt, "app.created", pick(members.slice(0, 2)), { type: "app", id: a._id, label: a.name }, `${a.kind === "web" ? "Website" : "Windows program"} “${a.name}” added.`);
  for (let i = 0; i < 140; i++) {
    const d = devices[(i * 13) % devices.length]!;
    const at = now - Math.floor(rand() * 30 * DAY);
    const r = rand();
    if (r < 0.3) deviceLog(at, "device.adminExitSuccess", d, "Admin exit used with the correct PIN.");
    else if (r < 0.4) deviceLog(at, "device.adminExitWrongPin", d, "Wrong exit PIN entered.");
    else if (r < 0.5) deviceLog(at, "device.employeeLockedOut", d, `Employee locked out after 5 wrong passwords.`);
    else if (r < 0.7) log(at, "device.renamed", members[1]!, { type: "device", id: d._id, label: d.name }, `Renamed to “${d.name}”.`);
    else if (r < 0.85) {
      const e = employees[(i * 5) % employees.length]!;
      log(at, "employee.updated", pick(members.slice(0, 2)), { type: "employee", id: e._id, label: e.name }, "Name, quota changed.");
    } else log(at, "org.settingsChanged", owner, undefined, "Changed: offlineDays, power.");
  }
  log(now - 26 * HOUR, "policy.publishFailed", null, { type: "device", id: devices[6]!._id, label: devices[6]!.name }, "The document was too large for this device.");
  log(now - 4 * HOUR, "enrollment.codeCreated", owner, { type: "enrollmentCode", id: tokens[0]!._id, label: "Branch 4 rollout" }, "Code for Front desk, 20 uses, 3 days.");
  log(now - 90 * MIN, "employee.lockedOut", null, { type: "employee", id: eLocked._id, label: eLocked.name }, "Locked for 15 minutes after 10 wrong passwords.");
  log(now - 5 * MIN, "device.kioskDisabled", owner, { type: "device", id: dOffice1._id, label: dOffice1.name }, "Kiosk turned off for maintenance.");

  const keys: DbKey[] = [
    {
      keyId,
      fingerprint: "SHA256:" + hex(rand, 43),
      status: "active",
      createdAt: now - 119 * DAY,
    },
  ];

  return {
    org: {
      _id: "org_0001",
      name: "Harbor & Pine Pharmacy",
      revision: 3,
      settings: {
        offlineDays: 3,
        defaultQuotaGb: 10,
        power: { sleep: true, restart: true, shutDown: false },
        adminExit: { enabled: true, hotkey: "Ctrl+Shift+F12" },
      },
      exitPinSet: true,
    },
    pingIntervalMs: pingIntervalFor(devices.filter((d) => !d.revoked).length),
    members,
    invites,
    groups,
    devices,
    reports,
    lastSeen,
    onlineIds,
    versions,
    employees,
    lockouts,
    groupMembers,
    apps,
    assignments,
    employeeApps,
    fileHandlers,
    tokens,
    installs,
    audit,
    keys,
    env: { key: true, next: false },
    nextId,
  };
}
