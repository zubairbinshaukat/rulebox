// Version ordering (plan Phase 6, 4.4.1). The TypeScript twin of
// `crates/rulebox-policy/src/version.rs`: both read the same vector file,
// `crates/rulebox-policy/tests/vectors/version.json`, so they cannot drift.
// PURE: no I/O, no Convex imports (the feed resolver, the app validators and the
// tests all use it).
//
// A version is ORDERED when it is 1 to 4 dotted numeric parts (compared as numbers,
// a missing part is 0, so `1.2` equals `1.2.0`), optionally followed by `-` and a
// semver pre-release (`1.2.3-beta.1`). A pre-release sorts before the same version
// without one. Anything else (a leading `v`, a `+build` suffix, words, an empty
// text, more than 40 characters) is NOT ordered: fine as display text for a Pinned
// app, refused for Vendor `minVersion` and for Managed apps (`version_not_ordered`).
//
// Pre-release precedence is semver 2.0.0 section 11: identifiers split at `.`;
// numeric ones compare as numbers and sort before alphanumeric ones; alphanumeric
// ones compare by ASCII order; a shorter list sorts before a longer one that starts
// with it. Numbers are never converted to integers (no overflow, no BigInt): digits
// compare by length once leading zeros are removed, then text by text.

/** Longest version text (`MAX_VERSION_CHARS` in `rulebox-policy`, plan 4.3). */
export const MAX_VERSION_CHARS = 40;

const ORDERED = /^([0-9]+(?:\.[0-9]+){0,3})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const DIGITS = /^[0-9]+$/;

export interface ParsedVersion {
  /** Four numbers as digit text without leading zeros ("0" for zero). */
  readonly parts: readonly [string, string, string, string];
  /** Pre-release identifiers; empty for a release. */
  readonly pre: readonly string[];
}

function trimZeros(digits: string): string {
  const trimmed = digits.replace(/^0+/, "");
  return trimmed === "" ? "0" : trimmed;
}

/** Numbers as text: the longer one is larger, equal lengths compare by text. */
function compareDigits(a: string, b: string): -1 | 0 | 1 {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Parses an ordered version, or `null` when the text is not ordered. */
export function parseVersion(text: string): ParsedVersion | null {
  if (text.length === 0 || text.length > MAX_VERSION_CHARS) return null;
  const match = ORDERED.exec(text);
  if (match === null) return null;
  const numbers = (match[1] ?? "").split(".").map(trimZeros);
  const part = (at: number): string => numbers[at] ?? "0";
  const pre = match[2] === undefined ? [] : match[2].split(".");
  return { parts: [part(0), part(1), part(2), part(3)], pre };
}

function comparePre(a: readonly string[], b: readonly string[]): -1 | 0 | 1 {
  const shared = Math.min(a.length, b.length);
  for (let at = 0; at < shared; at++) {
    const x = a[at] ?? "";
    const y = b[at] ?? "";
    const xNumeric = DIGITS.test(x);
    const yNumeric = DIGITS.test(y);
    let order: -1 | 0 | 1;
    if (xNumeric && yNumeric) order = compareDigits(trimZeros(x), trimZeros(y));
    else if (xNumeric) order = -1;
    else if (yNumeric) order = 1;
    else order = x === y ? 0 : x < y ? -1 : 1;
    if (order !== 0) return order;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/** Compares two parsed versions. */
export function compareParsed(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  for (let at = 0; at < 4; at++) {
    const order = compareDigits(a.parts[at] ?? "0", b.parts[at] ?? "0");
    if (order !== 0) return order;
  }
  const aRelease = a.pre.length === 0;
  const bRelease = b.pre.length === 0;
  if (aRelease && bRelease) return 0;
  if (aRelease) return 1;
  if (bRelease) return -1;
  return comparePre(a.pre, b.pre);
}

/** Whether `text` has an order (see the header). */
export function isOrdered(text: string): boolean {
  return parseVersion(text) !== null;
}

/** Compares two version texts; `null` when either is not ordered. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return null;
  return compareParsed(left, right);
}
