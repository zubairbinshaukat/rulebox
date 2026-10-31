import type { Infer } from "convex/values";
import { fail } from "./errors";
import { domainProblem, webUrlProblem } from "./hostRules";
import {
  MAX_ALLOWED_DOMAINS,
  MAX_APP_ARG_LENGTH,
  MAX_APP_DESCRIPTION,
  MAX_APP_NAME,
  MAX_APP_URL,
  MAX_INSTALLER_BYTES,
  MAX_SUCCESS_EXIT_CODES,
} from "./limits";
import { APP_ID_PLACEHOLDER, argsProblem, exePathProblem, fileArgProblem, resetFoldersProblem } from "./pathRules";
import { DEFAULT_WEB_PERMISSIONS, type desktopSpec, type installSpec } from "./validators";

// Validation and normalization of what an admin submits for an app (plan Step
// 10 item 3). PURE apart from `fail`, which throws a `ConvexError`. Every
// function returns the normalized value to store, so what the document later
// carries is exactly what was checked.

type DesktopSpec = Infer<typeof desktopSpec>;
type InstallSpec = Infer<typeof installSpec>;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

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
 * Permissions are not editable in Phase 4 (`DEFAULT_WEB_PERMISSIONS`).
 */
export function normalizeWeb(
  url: string,
  allowedDomains: string[],
  permissions = DEFAULT_WEB_PERMISSIONS,
): { url: string; allowedDomains: string[]; permissions: typeof DEFAULT_WEB_PERMISSIONS } {
  const trimmed = url.trim();
  if (webUrlProblem(trimmed) !== null || trimmed.length > MAX_APP_URL) fail("invalid_argument", { field: "url" });
  const host = new URL(trimmed).hostname.toLowerCase();
  const extra = allowedDomains.map((d) => d.trim());
  if (extra.length > MAX_ALLOWED_DOMAINS || extra.some(domainProblem)) fail("invalid_argument", { field: "allowedDomains" });
  // At most 20 entries of the admin's own; the URL's host comes on top of them.
  return { url: trimmed, allowedDomains: [...new Set([host, ...extra])], permissions: { ...permissions } };
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

/**
 * Validate and normalize a desktop app. `appId` is the stored app's id, or
 * undefined at create time (a portable app then uses the `{AppId}` placeholder
 * in its path, replaced after the insert by `withAppId`).
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

  const base = { exe, args, fileArgTemplate, resetFolders };
  switch (d.source) {
    case "preinstalled":
      if (d.install !== undefined || d.wingetId !== undefined || d.wingetVersion !== undefined) fail("invalid_argument", { field: "source" });
      return { source: "preinstalled", ...base };
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
      };
    }
    case "msi":
    case "exe":
    case "portable": {
      if (d.install === undefined) fail("invalid_argument", { field: "install" });
      if (d.wingetId !== undefined || d.wingetVersion !== undefined) fail("invalid_argument", { field: "source" });
      return { source: d.source, ...base, install: normalizeInstall(d.install, [d.source]) };
    }
  }
}

/** A stored portable app's path once its id is known (`{RuleboxApps}\{AppId}\x.exe` -> `{RuleboxApps}\<id>\x.exe`). */
export function withAppId(d: DesktopSpec, appId: string): DesktopSpec {
  return d.exe.includes(APP_ID_PLACEHOLDER) ? { ...d, exe: d.exe.replace(APP_ID_PLACEHOLDER, appId) } : d;
}
