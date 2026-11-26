// The Rulebox release the owner publishes (Phase 6 Step 20, `convex/ruleboxRelease.ts` `normalizeRelease`): the inline checks of the
// Settings → Updates form. Mirrors the server and the agent (`RuleboxRelease::check_limits`); the server decides. Pure: no sentences
// (the screen maps a problem to its text). Not part of `validate.ts` (the first load carries it): only the Updates tab and the demo use it.
import { sha256Problem } from "../../lib/driverRules";
import { isOrderedVersion } from "../../lib/apps/updateRules";

export { sha256Problem };

/** The largest MSI an agent downloads (`MAX_RELEASE_BYTES` in `convex/ruleboxRelease.ts` and `selfupdate.rs`). */
export const MAX_RELEASE_BYTES = 1024 * 1024 * 1024;
export const MAX_RELEASE_VERSION = 40;
/** `MAX_APP_URL` on the server. */
export const MAX_RELEASE_URL = 2048;

export type VersionProblem = "empty" | "length" | "not_ordered";

/** An ordered version (`0.1.1`, `1.2.3-rc.1`) of at most 40 characters. */
export function versionProblem(raw: string): VersionProblem | null {
  const t = raw.trim();
  if (t === "") return "empty";
  if (t.length > MAX_RELEASE_VERSION) return "length";
  return isOrderedVersion(t) ? null : "not_ordered";
}

export type UrlProblem = "empty" | "length" | "https";

/** `https://` with a host and no user name or password (`httpsUrlProblem` on the server). */
export function releaseUrlProblem(raw: string): UrlProblem | null {
  const t = raw.trim();
  if (t === "") return "empty";
  if (t.length > MAX_RELEASE_URL) return "length";
  try {
    const url = new URL(t);
    return url.protocol !== "https:" || url.hostname === "" || url.username !== "" || url.password !== "" ? "https" : null;
  } catch {
    return "https";
  }
}

export type SizeProblem = "empty" | "number" | "range";

/** A whole number of bytes from 1 to 1 GiB. */
export function releaseSizeProblem(raw: string): SizeProblem | null {
  const t = raw.trim();
  if (t === "") return "empty";
  if (!/^\d{1,12}$/.test(t)) return "number";
  const n = Number(t);
  return n < 1 || n > MAX_RELEASE_BYTES ? "range" : null;
}

// A `type`, not an interface: `useForm` wants an index-signature-compatible shape.
export type ReleaseFields = {
  version: string;
  url: string;
  sha256: string;
  /** Bytes, as typed. */
  size: string;
};

export interface ReleaseValue {
  version: string;
  url: string;
  sha256: string;
  sizeBytes: number;
}

export const emptyFields: ReleaseFields = { version: "", url: "", sha256: "", size: "" };

export function fieldsOf(release: ReleaseValue | null): ReleaseFields {
  return release === null
    ? emptyFields
    : { version: release.version, url: release.url, sha256: release.sha256, size: String(release.sizeBytes) };
}

/** What `ruleboxRelease:set` stores: trimmed, the hash in lower case. Call only when every field passed its check. */
export function releaseOf(f: ReleaseFields): ReleaseValue {
  return { version: f.version.trim(), url: f.url.trim(), sha256: f.sha256.trim().toLowerCase(), sizeBytes: Number(f.size.trim()) };
}

export function sameRelease(a: ReleaseValue | null, b: ReleaseValue | null): boolean {
  if (a === null || b === null) return a === b;
  return a.version === b.version && a.url === b.url && a.sha256 === b.sha256 && a.sizeBytes === b.sizeBytes;
}
