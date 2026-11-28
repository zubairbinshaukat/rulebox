import { httpsUrlProblem } from "./appRules";
import { fail } from "./errors";
import { isOrdered } from "./feed/version";
import type { RuleboxReleaseValue } from "./validators";

// The rules of the Rulebox release (`ruleboxRelease:set`, plan 4.17), in a module of their own so that both `ruleboxRelease.ts` (the
// mutation) and `lib/githubReleases.ts` (the GitHub picker, which must never offer a release `set` would refuse) use the same
// code. `ruleboxRelease.ts` re-exports both names.

/** The largest MSI an agent downloads (`MAX_RELEASE_BYTES` in `selfupdate.rs`). */
export const MAX_RELEASE_BYTES = 1024 * 1024 * 1024;
/** `RuleboxRelease.version` is checked by `rulebox_policy::version`: at most 40 characters, `[0-9A-Za-z.+-]`. */
const MAX_RELEASE_VERSION_CHARS = 40;
const SHA256 = /^[0-9a-fA-F]{64}$/;

/**
 * PURE. The release as the agent will accept it (`RuleboxRelease::check_limits`, a second check of the same rules): an ordered
 * version of at most 40 characters, an `https://` URL without credentials, a SHA-256 (stored in lower case) and a size from 1 byte to
 * 1 GiB. `invalid_argument` names the field. The version is trimmed; nothing else is changed.
 */
export function normalizeRelease(input: RuleboxReleaseValue): RuleboxReleaseValue {
  const version = input.version.trim();
  if (version.length === 0 || version.length > MAX_RELEASE_VERSION_CHARS || !isOrdered(version)) {
    fail("invalid_argument", { field: "release.version" });
  }
  if (httpsUrlProblem(input.url)) fail("invalid_argument", { field: "release.url" });
  if (!SHA256.test(input.sha256)) fail("invalid_argument", { field: "release.sha256" });
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_RELEASE_BYTES) {
    fail("invalid_argument", { field: "release.sizeBytes" });
  }
  return { version, url: input.url, sha256: input.sha256.toLowerCase(), sizeBytes: input.sizeBytes };
}
