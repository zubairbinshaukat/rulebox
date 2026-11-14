import type { CatalogApp, CatalogWebPermissions } from "@rulebox/types";
import { sha256HexSync } from "./crypto";
import { programDenied } from "./denyList";
import type { GroupConfigContent } from "./groupConfig";
import { MAX_ACTIVE_BROADCASTS, MAX_DEVICE_PRINTERS, MAX_DEVICE_WIFI, MAX_GROUP_EXCEPTIONS } from "./limits";
import type { RingValue, SealedBoxValue } from "./lockdownValidators";
import type { OrgSettings } from "./validators";

// The signed desired-state document, version 2 (plan 4.4 as amended by A5,
// A6, A13; Step 8 item 2). PURE: the builder is a function of its input
// object, so it is tested without a database and the committed vector
// (`crates/rulebox-policy/tests/vectors/signed-v2.json`) pins its bytes.
//
// Byte stability rules (4.4 rule 1): every object is built in the exact key
// order below at every level; arrays are sorted (`apps` and `catalog` by id
// with "files" first, `employeeIds` by id); map-like objects (`fileHandlers`)
// get their keys inserted in sorted order; absent optional values are `null`
// (never a missing key); numbers are integers. `JSON.stringify` then gives
// the same bytes for the same input, whatever order the input arrays had.
// Sorting uses plain code-unit comparison (`<`), never `localeCompare`.
//
// Nothing here is canonicalized after the fact: the agent verifies the exact
// bytes it receives (plan 4.5).

export const PAYLOAD_FORMAT = "rulebox.desired/2";
/** Upper bound of a payload in UTF-8 bytes (4.4 rule 6). */
export const MAX_PAYLOAD_BYTES = 524_288;
/** Id of the built-in Files app (4.4 rule 4). */
export const FILES_APP_ID = "files";

// ---------------------------------------------------------------- catalogue entry (plan 4.8)

// `CatalogApp` as the agent reads it: the ts-rs export of Rust
// `rulebox_policy::catalog` (Step 10). The type checks the fields; the
// serialized key order is the order of the object literals below, which
// follows the Rust struct (the committed vector pins the bytes).
type WebPermissions = CatalogWebPermissions;

// ---------------------------------------------------------------- builder input

/** One app as the builder needs it (a subset of the `apps` row). */
export type BuildApp = {
  _id: string;
  name: string;
  description?: string;
  kind: "web" | "desktop";
  hue?: number;
  archived: boolean;
  revision: number;
  web?: { url: string; allowedDomains: string[]; permissions: WebPermissions };
  desktop?: {
    exe: string;
    args: string[];
    fileArgTemplate: string[];
    install?: {
      kind: "msi" | "exe" | "portable";
      url: string;
      sha256: string;
      sizeBytes: number;
      silentArgs: string[];
      productCode?: string;
      successExitCodes: number[];
      removeWhenUnassigned: boolean;
    };
    resetFolders: string[];
  };
  /** Resolved icon (`ctx.storage.getUrl`), Step 10. */
  icon?: { url: string; sha256: string };
};

/**
 * The Phase 5 inputs of one device's document (plan 4.3). Absent (`undefined`) = the
 * document is the Phase 4 document, byte for byte: a group that never had a Phase 5
 * configuration, on a device with no lock, no broadcast and no USB window, gets none of the
 * new keys.
 */
export type Phase5Input = {
  /** The group configuration version this device's ring points to (4.14), or null when the group has none. */
  config: { groupId: string; version: number; ring: RingValue; content: GroupConfigContent } | null;
  /** This device's sealed Wi-Fi passphrases by profile id (`deviceSealedSecrets`, only current ones). */
  sealed: Record<string, SealedBoxValue>;
  /** Live (not ring-gated): `deviceLocks` of this device. */
  deviceLock: { lockId: string; message: string; contact: string | null; lockedAtMs: number } | null;
  /** Live: the "Allow USB for this PC" window; ignored when it is not in the future of `nowMs`. */
  usbTempAllowUntilMs: number | null;
  /** Live: the newest active broadcasts for this device (at most MAX_ACTIVE_BROADCASTS, expired ones already dropped). */
  broadcasts: DocBroadcast[];
  /** The publisher's clock for this run (decides `usbTempAllow`). */
  nowMs: number;
};

export type DocBroadcast = {
  id: string;
  style: "banner" | "fullscreen";
  title: string;
  body: string;
  expiresAtMs: number | null;
  ackRequired: boolean;
  issuedAtMs: number;
};

export type BuildInput = {
  /** Phase 5 sections (4.3). Optional so every Phase 4 caller and vector stays as it was. */
  phase5?: Phase5Input;
  org: { _id: string; name: string };
  settings: OrgSettings;
  /** Argon2id PHC of the device exit PIN, or null when none is set. */
  pinHash: string | null;
  /** The device's group, or null (no group: nobody can sign in, empty catalogue but Files). */
  group: { _id: string } | null;
  /** The group's app assignments (`appAssignments.by_group`). */
  assignments: { appId: string; audience: "everyone" | "selected"; pinnedTaskbar: boolean; pinnedDesktop: boolean }[];
  /** Every app any assignment or direct grant names (others are ignored). */
  apps: BuildApp[];
  /** Members of the group (`groupMembers.by_group` joined with `employees`). */
  employees: { _id: string; disabled: boolean }[];
  /** Direct grants of the group's employees (`employeeApps`). */
  employeeApps: { employeeId: string; appId: string }[];
  /** The organization's file-type rules (`fileHandlers.by_org_ext`). */
  fileHandlers: { extension: string; appId: string }[];
  device: { _id: string; kioskEnabled: boolean };
  /** Reserved (A13): a signed tenant move. Never set in Phase 4. */
  relocate?: { url: string; deviceId: string; notBefore: number };
};

export type DesiredDocV2 = Record<string, unknown> & { version: number };

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sortedUnique(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort(byText);
}

function filesEntry(): CatalogApp {
  return {
    id: FILES_APP_ID,
    name: "Files",
    description: null,
    kind: "builtin",
    builtin: { tool: "files" },
    web: null,
    desktop: null,
    pinnedTaskbar: true,
    pinnedDesktop: false,
    hue: null,
    icon: null,
    audience: "everyone",
    employeeIds: [],
    revision: 0,
  };
}

function permissionsOf(p: WebPermissions): WebPermissions {
  return {
    camera: p.camera,
    microphone: p.microphone,
    screenShare: p.screenShare,
    clipboardRead: p.clipboardRead,
    notifications: p.notifications,
    downloads: p.downloads,
    printing: p.printing,
    geolocation: p.geolocation,
  };
}

function catalogEntry(
  app: BuildApp,
  opts: { audience: "everyone" | "selected"; pinnedTaskbar: boolean; pinnedDesktop: boolean; employeeIds: string[] },
): CatalogApp {
  const d = app.desktop;
  const install = d?.install;
  return {
    id: app._id,
    name: app.name,
    description: app.description ?? null,
    kind: app.kind,
    builtin: null,
    web:
      app.kind === "web" && app.web !== undefined
        ? { url: app.web.url, allowedDomains: [...app.web.allowedDomains], permissions: permissionsOf(app.web.permissions) }
        : null,
    desktop:
      app.kind === "desktop" && d !== undefined
        ? {
            exe: d.exe,
            args: [...d.args],
            fileArgTemplate: [...d.fileArgTemplate],
            install:
              install === undefined
                ? null
                : {
                    kind: install.kind,
                    url: install.url,
                    sha256: install.sha256,
                    sizeBytes: install.sizeBytes,
                    silentArgs: [...install.silentArgs],
                    productCode: install.productCode ?? null,
                    successExitCodes: [...install.successExitCodes],
                    removeWhenUnassigned: install.removeWhenUnassigned,
                  },
            resetFolders: [...d.resetFolders],
          }
        : null,
    pinnedTaskbar: opts.pinnedTaskbar,
    pinnedDesktop: opts.pinnedDesktop,
    hue: app.hue ?? null,
    icon: app.icon !== undefined ? { url: app.icon.url, sha256: app.icon.sha256 } : null,
    audience: opts.audience,
    employeeIds: sortedUnique(opts.employeeIds),
    revision: app.revision,
  };
}

/**
 * The device's catalogue (plan 4.8 "What a device's catalogue contains"):
 * Files first, then every non-archived app the group assigns (with that
 * assignment's audience and pins; `employeeIds` = group employees with a
 * direct grant), then non-archived WEB apps granted directly to an employee of
 * the group that the group does not assign (audience "selected", no pins).
 * Desktop apps granted only directly are left out (they would need an install
 * the group did not ask for). Disabled employees count for nothing.
 *
 * A desktop app whose program is on the program deny list
 * (`lib/denyList.ts`, PRD 7.3) is left out too, and with it every file-type
 * rule that names it: `apps` refuses such programs since Step 10, but a row
 * saved before the list existed (or before a name was added to it) must not
 * reach a device.
 */
export function buildCatalog(input: BuildInput): CatalogApp[] {
  if (input.group === null) return [filesEntry()];
  const usable = (a: BuildApp): boolean =>
    !a.archived && !(a.kind === "desktop" && a.desktop !== undefined && programDenied(a.desktop.exe));
  const apps = new Map(input.apps.filter(usable).map((a) => [a._id, a]));
  const active = new Set(input.employees.filter((e) => !e.disabled).map((e) => e._id));
  const grants = new Map<string, string[]>();
  for (const g of input.employeeApps) {
    if (!active.has(g.employeeId)) continue;
    const list = grants.get(g.appId) ?? [];
    list.push(g.employeeId);
    grants.set(g.appId, list);
  }
  const out = new Map<string, CatalogApp>();
  for (const a of input.assignments) {
    const app = apps.get(a.appId);
    if (app === undefined || out.has(app._id)) continue;
    out.set(
      app._id,
      catalogEntry(app, {
        audience: a.audience,
        pinnedTaskbar: a.pinnedTaskbar,
        pinnedDesktop: a.pinnedDesktop,
        employeeIds: grants.get(app._id) ?? [],
      }),
    );
  }
  for (const [appId, employeeIds] of grants) {
    const app = apps.get(appId);
    if (app === undefined || out.has(appId) || app.kind !== "web") continue;
    out.set(appId, catalogEntry(app, { audience: "selected", pinnedTaskbar: false, pinnedDesktop: false, employeeIds }));
  }
  const rest = [...out.values()].sort((x, y) => byText(x.id, y.id));
  return [filesEntry(), ...rest];
}

/**
 * The document of one device (plan 4.4, amended). Key order is the order of
 * the Phase 2 `DesiredState`, then the Phase 2 agent-only keys, then the
 * Phase 4 keys. `version` is the caller's (the publisher sets it).
 */
export function buildDeviceDoc(input: BuildInput, version = 0): DesiredDocV2 {
  const catalog = buildCatalog(input);
  const appIds = catalog.map((c) => c.id);
  const inCatalog = new Set(appIds);

  const handlers = input.fileHandlers
    .filter((h) => inCatalog.has(h.appId))
    .map((h) => ({ extension: h.extension.toLowerCase(), appId: h.appId }))
    .sort((a, b) => byText(a.extension, b.extension));
  const fileHandlers: Record<string, string> = {};
  for (const h of handlers) if (!(h.extension in fileHandlers)) fileHandlers[h.extension] = h.appId;

  const s = input.settings;
  const doc: DesiredDocV2 = {
    // --- rulebox_policy::DesiredState (also sent to the Staff App: NEVER a secret here)
    kioskEnabled: input.device.kioskEnabled,
    apps: appIds,
    allowedSites: [],
    fileHandlers,
    storage: { defaultQuotaGb: s.defaultQuotaGb },
    branding: { name: input.org.name, logo: null },
    version,
  };
  // --- agent-only keys of Phase 2 (agent_policy.rs). 4.4 rule 2: omitted when
  // enabled without a PIN (the agent then reports the exit off, as today).
  if (!s.adminExit.enabled) {
    doc.adminExit = { enabled: false, hotkey: s.adminExit.hotkey };
  } else if (input.pinHash !== null) {
    doc.adminExit = { enabled: true, hotkey: s.adminExit.hotkey, pinHash: input.pinHash };
  }
  doc.power = { sleep: s.power.sleep, restart: s.power.restart, shutDown: s.power.shutDown };
  doc.orgName = input.org.name;
  // --- agent-only keys of Phase 4. `employees` left the document (A6): who
  // may sign in comes from the signed roster of `rosterGroupId`.
  doc.catalog = catalog;
  doc.rosterGroupId = input.group?._id ?? null;
  doc.offlineDays = s.offlineDays;
  if (input.relocate !== undefined) {
    doc.relocate = { url: input.relocate.url, deviceId: input.relocate.deviceId, notBefore: input.relocate.notBefore };
  }
  if (input.phase5 !== undefined) addPhase5Keys(doc, input.phase5);
  return doc;
}

/** Limits of plan 4.3 rule 4 that the builder must not exceed (the agent refuses the whole document above them). */
const MAX_LOCK_MESSAGE = 300;
const MAX_LOCK_CONTACT = 100;

/**
 * The agent-only keys of Phase 5 after `offlineDays`, in the order of plan 4.3:
 * `lockdown`, `wifi`, `wifiManagedOnly`, `printers` (ring-gated, only with a group
 * configuration), then the live `deviceLock`, `usbTempAllow`, `broadcasts`, then `config`.
 * Shapes and key order are those of `crates/rulebox-policy/tests/vectors/lockdown.json`.
 * Throws (the publisher records `policy.publishFailed`) when a limit would be exceeded.
 */
function addPhase5Keys(doc: DesiredDocV2, p: Phase5Input): void {
  const c = p.config;
  if (c !== null) {
    if (c.content.lockdown.exceptions.length > MAX_GROUP_EXCEPTIONS) throw new Error("too many exceptions");
    if (c.content.wifi.length > MAX_DEVICE_WIFI || c.content.printers.length > MAX_DEVICE_PRINTERS) throw new Error("too many items");
    doc.lockdown = c.content.lockdown;
    doc.wifi = c.content.wifi.map((w) => ({
      id: w.id,
      ssid: w.ssid,
      hidden: w.hidden,
      security: w.security,
      autoConnect: w.autoConnect,
      revision: w.revision,
      sealed: sealedOf(p.sealed[w.id]),
    }));
    doc.wifiManagedOnly = c.content.wifiManagedOnly;
    doc.printers = c.content.printers.map((x) => ({
      id: x.id,
      name: x.name,
      kind: x.kind,
      address: x.address,
      port: x.port,
      queue: x.queue,
      driver: x.driver,
      isDefault: x.isDefault,
      revision: x.revision,
    }));
  }
  if (p.deviceLock !== null && (p.deviceLock.message.length > MAX_LOCK_MESSAGE || (p.deviceLock.contact?.length ?? 0) > MAX_LOCK_CONTACT)) {
    throw new Error("lock text too long");
  }
  doc.deviceLock =
    p.deviceLock === null
      ? null
      : { lockId: p.deviceLock.lockId, message: p.deviceLock.message, contact: p.deviceLock.contact, lockedAtMs: p.deviceLock.lockedAtMs };
  doc.usbTempAllow = p.usbTempAllowUntilMs !== null && p.usbTempAllowUntilMs > p.nowMs ? { untilMs: p.usbTempAllowUntilMs } : null;
  if (p.broadcasts.length > MAX_ACTIVE_BROADCASTS) throw new Error("too many broadcasts");
  doc.broadcasts = [...p.broadcasts]
    .sort((a, b) => byText(a.id, b.id))
    .map((b) => ({
      id: b.id,
      style: b.style,
      title: b.title,
      body: b.body,
      expiresAtMs: b.expiresAtMs,
      ackRequired: b.ackRequired,
      issuedAtMs: b.issuedAtMs,
    }));
  if (c !== null) doc.config = { groupId: c.groupId, version: c.version, ring: c.ring };
}

/** A sealed box in the key order of the Rust struct, or null (no box yet: the agent reports `waiting_for_key`). */
function sealedOf(b: SealedBoxValue | undefined): SealedBoxValue | null {
  return b === undefined ? null : { v: b.v, keyId: b.keyId, epk: b.epk, nonce: b.nonce, ct: b.ct };
}

/** 4.4 rule 5: SHA-256 hex of the document with `version` 0 (the same content gives the same hash). */
export function contentHashOf(doc: DesiredDocV2): string {
  return sha256HexSync(JSON.stringify({ ...doc, version: 0 }));
}

/** The exact string that is signed and sent (plan 4.4). */
export function buildPayload(p: {
  keyId: string;
  orgId: string;
  deviceId: string;
  version: number;
  issuedAtMs: number;
  doc: DesiredDocV2;
}): string {
  if (p.doc.version !== p.version) throw new Error("buildPayload: doc.version must equal version");
  return JSON.stringify({
    format: PAYLOAD_FORMAT,
    keyId: p.keyId,
    orgId: p.orgId,
    deviceId: p.deviceId,
    version: p.version,
    issuedAtMs: p.issuedAtMs,
    doc: p.doc,
  });
}

/** UTF-8 length of `text` (the payload cap is in bytes). */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}
