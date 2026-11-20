import { httpsUrlProblem } from "../appRules";
import { FEED_MAX_SIGNATURE_CHARS } from "./limits";
import { isOrdered, MAX_VERSION_CHARS } from "./version";

// Tauri's `latest.json` (plan Phase 6, 4.5 step 2). PURE: text in, a validated release or a reason out. The whole file is
// checked before any field is used; nothing in it is trusted until the installer's signature has been verified.

export type TauriRelease = {
  /** The version without a leading `v`; always an ORDERED version (`lib/feed/version.ts`). */
  version: string;
  /** The platform entry's `url`: https, as the vendor wrote it. */
  url: string;
  /** The platform entry's `signature`: base64 of the minisign `.sig` file. */
  signature: string;
};

export type ParsedFeed = { ok: true; release: TauriRelease } | { ok: false; reason: "not_json" | "shape" | "version" | "platform_missing" | "platform_invalid" };

/** The installer kinds of `apps.desktop.install.kind`. */
type InstallKind = "msi" | "exe" | "portable" | undefined;

/**
 * The `platforms` keys to try, in order (plan: `windows-x86_64-nsis`, then `windows-x86_64`; the admin's `target` replaces
 * `windows-x86_64`). A target that already names an installer type is the only one. An MSI program tries `-msi` first, so
 * that a vendor who ships both does not hand an NSIS installer to an `msiexec` install.
 */
export function platformKeys(target: string, kind: InstallKind): string[] {
  if (/-(nsis|msi|wix)$/.test(target)) return [target];
  return [`${target}-${kind === "msi" ? "msi" : "nsis"}`, target];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseLatestJson(text: string, target: string, kind: InstallKind): ParsedFeed {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (!isObject(json) || typeof json.version !== "string" || !isObject(json.platforms)) return { ok: false, reason: "shape" };
  // Tauri accepts a leading "v" ("v1.2.3"); the stored version never has one.
  const version = json.version.trim().replace(/^v/, "");
  if (version.length > MAX_VERSION_CHARS || !isOrdered(version)) return { ok: false, reason: "version" };
  for (const key of platformKeys(target, kind)) {
    if (!Object.prototype.hasOwnProperty.call(json.platforms, key)) continue;
    const entry = json.platforms[key];
    if (!isObject(entry) || typeof entry.url !== "string" || typeof entry.signature !== "string") return { ok: false, reason: "platform_invalid" };
    const url = entry.url.trim();
    const signature = entry.signature.trim();
    if (httpsUrlProblem(url) || signature === "" || signature.length > FEED_MAX_SIGNATURE_CHARS) return { ok: false, reason: "platform_invalid" };
    return { ok: true, release: { version, url, signature } };
  }
  return { ok: false, reason: "platform_missing" };
}
