import type { Infer } from "convex/values";
import { fail } from "./errors";
import { domainProblem, webUrlProblem } from "./hostRules";
import { compareVersions, isOrdered, MAX_VERSION_CHARS } from "./feed/version";
import {
  MAX_ALLOWED_DOMAINS,
  MAX_APP_ARG_LENGTH,
  MAX_APP_DESCRIPTION,
  MAX_APP_NAME,
  MAX_APP_URL,
  MAX_BROWSER_SITES,
  MAX_FEED_PUBKEY,
  MAX_FEED_TARGET,
  MAX_INSTALLER_BYTES,
  MAX_PUBLISHER_PRODUCT,
  MAX_PUBLISHER_SUBJECT,
  MAX_SUCCESS_EXIT_CODES,
} from "./limits";
import { APP_ID_PLACEHOLDER, argsProblem, exePathProblem, fileArgProblem, resetFoldersProblem } from "./pathRules";
import { NEW_WEB_APP_PERMISSIONS, type browserChoice, type desktopSpec, type installSpec, type webSpec } from "./validators";

// Validation and normalization of what an admin submits for an app (plan Step
// 10 item 3). PURE apart from `fail`, which throws a `ConvexError`. Every
// function returns the normalized value to store, so what the document later
// carries is exactly what was checked.

type DesktopSpec = Infer<typeof desktopSpec>;
type InstallSpec = Infer<typeof installSpec>;
type BrowserChoice = Infer<typeof browserChoice>;
type WebSpec = Infer<typeof webSpec>;

// C0 controls, DEL and the bidi direction marks / overrides / isolates (they reorder or hide text).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

export function normalizeAppName(name: string): string {
  const t = name.trim();
  if (t.length < 1 || t.length > MAX_APP_NAME || CONTROL.test(t)) fail("invalid_argument", { field: "name" });
  return t;
}

/** undefined / "" -> no description. */
export function normalizeAppDescription(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const t = text.trim();
  if (t.length > MAX_APP_DESCRIPTION || CONTROL.test(t)) fail("invalid_argument", { field: "description" });
  return t === "" ? undefined : t;
}

export function normalizeHue(hue: number | undefined): number | undefined {
  if (hue === undefined) return undefined;
  if (!Number.isInteger(hue) || hue < 0 || hue > 359) fail("invalid_argument", { field: "hue" });
  return hue;
}

/**
 * A web app's address and allowed domains. The URL's own host is always
 * allowed and listed first; the rest keep the admin's order, de-duplicated.
 * `permissions` is what a new app starts with (`NEW_WEB_APP_PERMISSIONS`); `apps:update` passes the app's
 * own, and `apps:setPermissions` is the only way to change them.
 * `browser` (Phase 6 Step 16, plan 4.9.1) is checked for its SHAPE here (`normalizeBrowser`); that a `chrome` choice names a real,
 * non-archived Chrome program of the organization needs the database and is checked by `apps.ts`.
 */
export function normalizeWeb(
  url: string,
  allowedDomains: string[],
  permissions = NEW_WEB_APP_PERMISSIONS,
  browser?: BrowserChoice,
): WebSpec {
  const trimmed = url.trim();
  if (webUrlProblem(trimmed) !== null || trimmed.length > MAX_APP_URL) fail("invalid_argument", { field: "url" });
  const host = new URL(trimmed).hostname.toLowerCase();
  const extra = allowedDomains.map((d) => d.trim());
  if (extra.length > MAX_ALLOWED_DOMAINS || extra.some(domainProblem)) fail("invalid_argument", { field: "allowedDomains" });
  const choice = normalizeBrowser(browser);
  // At most 20 entries of the admin's own; the URL's host comes on top of them.
  return { url: trimmed, allowedDomains: [...new Set([host, ...extra])], permissions: { ...permissions }, ...(choice !== undefined ? { browser: choice } : {}) };
}

/**
 * `web.browser` as it is stored (plan 4.9.1): the built-in window is "no field at all", so a document that never had a browser
 * choice keeps its bytes and a save that picks Built-in again changes nothing else. Edge carries no id; Chrome needs the id of
 * the Chrome program (`browser_app_required` when it is missing; whether it exists is `apps.ts`'s check).
 */
export function normalizeBrowser(b: BrowserChoice | undefined): BrowserChoice | undefined {
  if (b === undefined) return undefined;
  const appId = b.appId?.trim() ?? "";
  switch (b.kind) {
    case "builtin":
    case "edge":
      if (appId !== "") fail("invalid_argument", { field: "browser" });
      return b.kind === "edge" ? { kind: "edge" } : undefined;
    case "chrome":
      if (appId === "") fail("invalid_argument", { field: "browser", detail: "browser_app_required" });
      return { kind: "chrome", appId };
  }
}

/**
 * The allowed sites of a Chrome or Edge program (plan 4.9.7, the "Browser rules" card): at most MAX_BROWSER_SITES domains
 * (`example.com`, `*.example.com`), de-duplicated, in the admin's order. Only a program the server recognises as a browser
 * (`browserAppOf`) may have any (`not_a_browser_app`); an empty list is "no list".
 */
export function normalizeBrowserSites(sites: string[] | undefined, exe: string): string[] | undefined {
  if (sites === undefined) return undefined;
  const list = [...new Set(sites.map((s) => s.trim()).filter((s) => s !== ""))];
  if (list.length === 0) return undefined;
  if (browserAppOf(exe) === null) fail("invalid_argument", { field: "browserSites", detail: "not_a_browser_app" });
  if (list.length > MAX_BROWSER_SITES || list.some(domainProblem)) fail("invalid_argument", { field: "browserSites" });
  return list;
}

/** `https://` with a host and no credentials (installers may live on a LAN server: no private-host rule). */
export function httpsUrlProblem(value: string): boolean {
  if (value.length === 0 || value.length > MAX_APP_URL) return true;
  try {
    const url = new URL(value);
    return url.protocol !== "https:" || url.hostname === "" || url.username !== "" || url.password !== "";
  } catch {
    return true;
  }
}

const WINGET_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9._-]*)+$/;
const WINGET_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const PRODUCT_CODE = /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/;
const SHA256 = /^[0-9a-fA-F]{64}$/;

/** A winget package id (`Publisher.Package`, case-sensitive in the repository). It becomes part of a URL path: no slash can pass. */
export function wingetIdProblem(id: string): boolean {
  return id.length > 128 || !WINGET_ID.test(id);
}

export function wingetVersionProblem(version: string): boolean {
  return !WINGET_VERSION.test(version);
}

/** Normalized install spec for `kind`; `fail`s with `invalid_argument` and the field name. */
export function normalizeInstall(i: InstallSpec, expectedKinds: readonly InstallSpec["kind"][]): InstallSpec {
  if (!expectedKinds.includes(i.kind)) fail("invalid_argument", { field: "install.kind" });
  if (httpsUrlProblem(i.url)) fail("invalid_argument", { field: "install.url" });
  if (!SHA256.test(i.sha256)) fail("invalid_argument", { field: "install.sha256" });
  if (!Number.isInteger(i.sizeBytes) || i.sizeBytes < 0 || i.sizeBytes > MAX_INSTALLER_BYTES) {
    fail("invalid_argument", { field: "install.sizeBytes" });
  }
  // msi gets "/qn /norestart" from the agent; only exe installers carry switches.
  const silentArgs = i.kind === "exe" ? i.silentArgs.map((a) => a.trim()).filter((a) => a !== "") : [];
  if (i.kind === "exe" && silentArgs.length === 0) fail("invalid_argument", { field: "install.silentArgs" });
  if (argsProblem(silentArgs) !== null) fail("invalid_argument", { field: "install.silentArgs" });
  let productCode: string | undefined;
  if (i.kind === "msi" && i.productCode !== undefined && i.productCode.trim() !== "") {
    if (!PRODUCT_CODE.test(i.productCode.trim())) fail("invalid_argument", { field: "install.productCode" });
    productCode = i.productCode.trim().toUpperCase();
  }
  const codes = i.successExitCodes;
  if (codes.length > MAX_SUCCESS_EXIT_CODES || codes.some((c) => !Number.isInteger(c) || c < -2_147_483_648 || c > 2_147_483_647)) {
    fail("invalid_argument", { field: "install.successExitCodes" });
  }
  const successExitCodes = [0, ...[...new Set(codes)].filter((c) => c !== 0).sort((a, b) => a - b)];
  return {
    kind: i.kind,
    url: i.url.trim(),
    sha256: i.sha256.toLowerCase(),
    sizeBytes: i.sizeBytes,
    silentArgs,
    ...(productCode !== undefined ? { productCode } : {}),
    successExitCodes,
    // An exe installer cannot be uninstalled in Phase 4 (4.8): the flag is meaningless there.
    removeWhenUnassigned: i.kind === "exe" ? false : i.removeWhenUnassigned,
  };
}

// ---------------------------------------------------------------- versions and update modes (Phase 6 Step 10, plan 4.4)

/**
 * The refusals of plan 4.4, as the `detail` of an `invalid_argument` (the `field` names where the admin fixes it). The
 * dashboard maps each to one sentence (`messageForCode`).
 */
export const UPDATE_REFUSALS = ["vendor_mode_needs_publisher", "publisher_too_broad", "min_above_bootstrap", "version_not_ordered"] as const;
export type UpdateRefusal = (typeof UPDATE_REFUSALS)[number];

function refuse(field: string, detail: UpdateRefusal): never {
  fail("invalid_argument", { field, detail });
}

/** A version as text: 1 to 40 characters of `[0-9A-Za-z.+-]` (plan 4.3), the same rule as `check_version_text` in Rust. */
const VERSION_TEXT = /^[0-9A-Za-z.+-]+$/;

function versionText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const t = value.trim();
  if (t === "") return undefined;
  if (t.length > MAX_VERSION_CHARS || !VERSION_TEXT.test(t)) fail("invalid_argument", { field });
  return t;
}

function shortText(value: string | undefined, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  const t = value.trim();
  if (t === "") return undefined;
  if (t.length > max || CONTROL.test(t)) fail("invalid_argument", { field });
  return t;
}

/**
 * Chrome or Edge added as a normal program (plan 4.9.7, `browser_app`): by the file name of the exe, any folder, any case.
 * Their own updater ignores update policies on a workgroup PC, so such an app can only be Vendor mode.
 */
export function browserAppOf(exe: string): "chrome" | "edge" | null {
  const name = exe.split(/[\\/]/).pop()?.trim().toLowerCase();
  if (name === "chrome.exe") return "chrome";
  if (name === "msedge.exe") return "edge";
  return null;
}

/** The publisher rule a browser app gets when the admin gave none: the vendor's subject and the product, so it is never "everything Microsoft signed". */
const BROWSER_PUBLISHERS = {
  chrome: { publisher: "Google LLC", publisherProduct: "Google Chrome" },
  edge: { publisher: "Microsoft Corporation", publisherProduct: "Microsoft Edge" },
} as const;

/** Windows' own signers: a publisher rule for one of them without a product would allow most of Windows (plan 4.4.3). */
const BROAD_PUBLISHERS: ReadonlySet<string> = new Set(["microsoft windows", "microsoft corporation", "microsoft windows publisher"]);

/** The subject as typed ("Microsoft Corporation"), or as a distinguished name (`CN=Microsoft Corporation, O=...`): any of its names is broad. */
export function publisherTooBroad(subject: string): boolean {
  const names = [subject, ...[...subject.matchAll(/(?:^|,)\s*(?:CN|O)=("?)([^",]+)\1/gi)].map((m) => m[2] ?? "")];
  return names.some((n) => BROAD_PUBLISHERS.has(n.trim().toLowerCase()));
}

type UpdateSpecIn = NonNullable<DesktopSpec["update"]>;
type FeedIn = NonNullable<UpdateSpecIn["feed"]>;

/** The vendor feed of a Managed app (plan 4.5): an https address, the vendor's public key and the platform key in `latest.json`. */
function normalizeFeed(f: FeedIn): FeedIn {
  const url = f.url.trim();
  if (httpsUrlProblem(url)) fail("invalid_argument", { field: "update.feed.url" });
  // Pasted keys are often wrapped over several lines.
  const pubkey = f.pubkey.replace(/\s+/g, "");
  if (pubkey.length < 16 || pubkey.length > MAX_FEED_PUBKEY || !/^[A-Za-z0-9+/=]+$/.test(pubkey)) fail("invalid_argument", { field: "update.feed.pubkey" });
  const target = f.target.trim();
  if (target.length < 3 || target.length > MAX_FEED_TARGET || !/^[a-z0-9_-]+$/.test(target)) fail("invalid_argument", { field: "update.feed.target" });
  return { kind: "tauri", url, pubkey, target };
}

/**
 * `desktop.version` and `desktop.update` as they are stored (plan 4.4). Pinned is "no update block". Vendor needs a
 * publisher (not Windows' own signers without a product) and, for `minVersion`, an ordered version that the bootstrap
 * delivers. Managed needs an ordered version and an installer; its feed is optional (without one the admin publishes
 * versions by hand and still gets apply windows and Roll back). A Chrome or Edge program is forced to Vendor.
 */
function normalizeVersioning(d: DesktopSpec, exe: string): Pick<DesktopSpec, "version" | "update"> {
  const version = versionText(d.version, "version");
  const u = d.update;
  const browser = browserAppOf(exe);
  const mode = browser !== null ? "vendor" : (u?.mode ?? "pinned");
  const out = (update: DesktopSpec["update"]) => ({ ...(version !== undefined ? { version } : {}), ...(update !== undefined ? { update } : {}) });
  switch (mode) {
    case "pinned":
      // Version is display text for a Pinned app: any text of the allowed characters.
      return out(undefined);
    case "vendor": {
      const defaults = browser !== null ? BROWSER_PUBLISHERS[browser] : undefined;
      const publisher = shortText(u?.publisher, "update.publisher", MAX_PUBLISHER_SUBJECT) ?? defaults?.publisher;
      if (publisher === undefined) refuse("update.publisher", "vendor_mode_needs_publisher");
      const product = shortText(u?.publisherProduct, "update.publisherProduct", MAX_PUBLISHER_PRODUCT) ?? (u?.publisher === undefined ? defaults?.publisherProduct : undefined);
      if (product === undefined && publisherTooBroad(publisher)) refuse("update.publisher", "publisher_too_broad");
      const minVersion = versionText(u?.minVersion, "update.minVersion");
      if (minVersion !== undefined) {
        if (!isOrdered(minVersion)) refuse("update.minVersion", "version_not_ordered");
        // "At least this version" is compared with what the bootstrap delivers, so that has to be an ordered version too.
        if (version === undefined || !isOrdered(version)) refuse("version", "version_not_ordered");
        if (d.install === undefined) fail("invalid_argument", { field: "update.minVersion" });
        if (compareVersions(minVersion, version) === 1) refuse("update.minVersion", "min_above_bootstrap");
      }
      return out({ mode: "vendor", publisher, ...(product !== undefined ? { publisherProduct: product } : {}), ...(minVersion !== undefined ? { minVersion } : {}) });
    }
    case "managed": {
      if (d.install === undefined) fail("invalid_argument", { field: "update.mode" });
      if (version === undefined || !isOrdered(version)) refuse("version", "version_not_ordered");
      return out({
        mode: "managed",
        ...(u?.feed !== undefined ? { feed: normalizeFeed(u.feed) } : {}),
        ...(u?.autoPublish !== undefined ? { autoPublish: u.autoPublish } : {}),
        ...(u?.applyWhen !== undefined ? { applyWhen: u.applyWhen } : {}),
        ...(u?.rollbackOnFail !== undefined ? { rollbackOnFail: u.rollbackOnFail } : {}),
      });
    }
  }
}

/**
 * Whether two installers are not the same file (what makes a new version in Managed mode): the address or the SHA-256. The
 * size is not compared: it is a hint (0 = unknown) that the dashboard form does not know, so a plain save would otherwise
 * count as a new version.
 */
function installerChanged(a: InstallSpec, b: InstallSpec): boolean {
  return a.url !== b.url || a.sha256 !== b.sha256;
}

/**
 * The `previous` installer to store (plan 4.4.4, Step 10 item 2). `previous` is the SERVER's field: whatever the form
 * sent is ignored. In Managed mode, when the installer's coordinates change, the old ones (with their version) become
 * `previous`; otherwise the stored one stays. Another mode has none. An old version without text cannot be rolled back to.
 */
export function previousFor(old: DesktopSpec | undefined, next: DesktopSpec): DesktopSpec["previous"] {
  if (next.update?.mode !== "managed") return undefined;
  const before = old?.install;
  if (before !== undefined && next.install !== undefined && installerChanged(before, next.install)) {
    // A version that is not ordered (display text of a Pinned app) cannot be the target of "Roll back".
    if (old?.version === undefined || !isOrdered(old.version)) return undefined;
    return { version: old.version, url: before.url, sha256: before.sha256, sizeBytes: before.sizeBytes };
  }
  return old?.previous;
}

/**
 * Validate and normalize a desktop app. `appId` is the stored app's id, or
 * undefined at create time (a portable app then uses the `{AppId}` placeholder
 * in its path, replaced after the insert by `withAppId`). `previous` in the input
 * is ignored (`previousFor`).
 */
export function normalizeDesktop(d: DesktopSpec, appId?: string): DesktopSpec {
  const portable = d.source === "portable";
  // The form writes `{AppId}` for a portable app; an existing app already has its id.
  const exe = (appId !== undefined ? d.exe.replace(APP_ID_PLACEHOLDER, appId) : d.exe).trim();
  if (exePathProblem(exe, { portable, appId }) !== null) fail("invalid_argument", { field: "exe" });

  const args = d.args.map((a) => a.trim());
  if (argsProblem(args) !== null || args.some((a) => a.length > MAX_APP_ARG_LENGTH)) fail("invalid_argument", { field: "args" });
  const fileArgTemplate = d.fileArgTemplate.map((a) => a.trim());
  if (fileArgProblem(fileArgTemplate) !== null) fail("invalid_argument", { field: "fileArgTemplate" });
  const resetFolders = [...new Set(d.resetFolders.map((f) => f.trim()))];
  if (resetFoldersProblem(resetFolders) !== null) fail("invalid_argument", { field: "resetFolders" });

  const browserSites = normalizeBrowserSites(d.browserSites, exe);
  const base = { exe, args, fileArgTemplate, resetFolders, ...(browserSites !== undefined ? { browserSites } : {}) };
  switch (d.source) {
    case "preinstalled":
      if (d.install !== undefined || d.wingetId !== undefined || d.wingetVersion !== undefined) fail("invalid_argument", { field: "source" });
      return { source: "preinstalled", ...base, ...normalizeVersioning(d, exe) };
    case "winget": {
      if (d.wingetId === undefined || wingetIdProblem(d.wingetId)) fail("invalid_argument", { field: "wingetId" });
      if (d.wingetVersion !== undefined && wingetVersionProblem(d.wingetVersion)) fail("invalid_argument", { field: "wingetVersion" });
      if (d.install === undefined) fail("invalid_argument", { field: "install" });
      return {
        source: "winget",
        ...base,
        install: normalizeInstall(d.install, ["msi", "exe"]),
        wingetId: d.wingetId,
        ...(d.wingetVersion !== undefined ? { wingetVersion: d.wingetVersion } : {}),
        ...normalizeVersioning(d, exe),
      };
    }
    case "msi":
    case "exe":
    case "portable": {
      if (d.install === undefined) fail("invalid_argument", { field: "install" });
      if (d.wingetId !== undefined || d.wingetVersion !== undefined) fail("invalid_argument", { field: "source" });
      return { source: d.source, ...base, install: normalizeInstall(d.install, [d.source]), ...normalizeVersioning(d, exe) };
    }
  }
}

/** A stored portable app's path once its id is known (`{RuleboxApps}\{AppId}\x.exe` -> `{RuleboxApps}\<id>\x.exe`). */
export function withAppId(d: DesktopSpec, appId: string): DesktopSpec {
  return d.exe.includes(APP_ID_PLACEHOLDER) ? { ...d, exe: d.exe.replace(APP_ID_PLACEHOLDER, appId) } : d;
}
