import { MAX_RELEASE_BYTES, normalizeRelease } from "./releaseRules";
import { fetchPublic } from "./safeFetch";

// The Rulebox releases on GitHub, for the Settings -> Updates picker (UI pass, `docs/plans/ui-pass/settings.md` section 5). The
// browser never calls GitHub (offline-first, CSP `connect-src`): the owner's dashboard calls the action `ruleboxRelease:githubReleases`,
// which calls `listGithubReleases` here. Everything is public data. Nothing is stored in the database: the caches below are module
// state of the isolate (they may be lost at any time; a cold call simply goes upstream), so a call costs no document read or write.
//
// What comes back is advice for a form: the owner still saves it through `ruleboxRelease:set` (major action, normalized again), and
// every agent checks the SHA-256 of what it downloads. A release the picker offers is one `set` accepts (it runs `normalizeRelease`).
//
// Trust note: until the MSI is code-signed with a key the agent pins, the hash comes from the same place as the file (the release's
// `SHA256SUMS`): whoever can replace the MSI on the release can replace that file too. GitHub's own asset `digest`, when present, is
// cross-checked, which catches corruption, not a compromised release.

type FetchLike = typeof fetch;

/** Why a release cannot be picked (it is still listed, with a reason). */
export type ReleaseProblem =
  | "no_msi"
  | "two_msis"
  | "version_mismatch"
  | "no_checksums"
  | "checksums_unreadable"
  | "not_in_checksums"
  | "hash_mismatch"
  | "too_large"
  | "invalid";

export type GithubRelease = {
  /** `v0.3.0-rc1`. */
  tag: string;
  /** The release name, or `Rulebox <tag without v>`; at most 120 characters. */
  title: string;
  /** `X.Y.Z` of the tag = of the MSI name = what the agent reports after installing it. */
  version: string;
  prerelease: boolean;
  /** Milliseconds. */
  publishedAt: number;
  /** `https://github.com/<repo>/releases/...` */
  pageUrl: string;
  /** Plain-text source of the notes (HTML comments and `\r` removed), at most 4,000 characters. */
  notes: string;
  notesTruncated: boolean;
  /** The MSI name has no `-unsigned`. */
  signed: boolean;
  /** `null` exactly when `problem` is not null. */
  msi: { name: string; url: string; sizeBytes: number; sha256: string } | null;
  problem: ReleaseProblem | null;
};

export type GithubReleasesFailure = { reason: "rate_limited" | "unreachable" | "not_found"; retryAt?: number };

export type GithubReleasesResult =
  | { status: "ok"; repoUrl: string; checkedAt: number; stale: boolean; releases: GithubRelease[] }
  | ({ status: "unavailable" } & GithubReleasesFailure);

// ---------------------------------------------------------------- constants

export const DEFAULT_RELEASES_REPO = "zubairbinshaukat/rulebox";
const REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** How long a list answers without a network call. */
export const LIST_TTL_MS = 10 * 60_000;
/** A list that has a problem that may be temporary (a checksum file that could not be fetched) is trusted for this long only. */
export const TRANSIENT_TTL_MS = 60_000;
/** The least time between two calls to GitHub, even for `refresh: true`. */
export const MIN_GAP_MS = 30_000;
/** The longest a rate-limit answer can keep us from calling (a bogus reset header cannot park the feature). */
const BLOCK_MAX_MS = 60 * 60_000;
const LIST_MAX_BYTES = 2 * 1024 * 1024;
const LIST_TIMEOUT_MS = 8_000;
const SUMS_MAX_BYTES = 16 * 1024;
const SUMS_TIMEOUT_MS = 5_000;
export const MAX_RELEASES = 10;
export const SHA_CACHE_MAX = 50;
const MAX_ASSETS = 100;
export const NOTES_MAX_CHARS = 4_000;
const TITLE_MAX_CHARS = 120;
const USER_AGENT = "rulebox-dashboard";

const TAG_PATTERN = /^v(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?$/;
const MSI_PATTERN = /^Rulebox-(\d+\.\d+\.\d+)-x64(-unsigned)?\.msi$/;
const SUMS_LINE = /^([0-9a-f]{64}) [ *](.+)$/;
const SUMS_NAME = "SHA256SUMS";
const ETAG = /^(?:W\/)?"[\x21\x23-\x7e]*"$/;

/** The repository to read: `configured` (the `RULEBOX_RELEASES_REPO` env) when it is a plain `owner/name`, else the default. */
export function releasesRepo(configured: string | undefined): string {
  const t = configured?.trim();
  if (t === undefined || !REPO_PATTERN.test(t)) return DEFAULT_RELEASES_REPO;
  const name = t.slice(t.indexOf("/") + 1);
  return name === "." || name === ".." ? DEFAULT_RELEASES_REPO : t;
}

// ---------------------------------------------------------------- state

type Sums = { kind: "ok"; hashes: Map<string, string | null> } | { kind: "unreadable" };
type ListCache = { repo: string; etag: string | undefined; checkedAt: number; releases: GithubRelease[]; transient: boolean };

export type GithubReleasesState = {
  list: ListCache | null;
  /** `"<assetId>:<updated_at>"` of a `SHA256SUMS` asset -> what it said. Oldest dropped beyond `SHA_CACHE_MAX`. */
  sums: Map<string, Sums>;
  lastUpstreamAt: number | null;
  blockedUntil: number;
  lastFailure: GithubReleasesFailure | null;
  inflight: { repo: string; promise: Promise<GithubReleasesResult> } | null;
};

export function createGithubReleasesState(): GithubReleasesState {
  return { list: null, sums: new Map(), lastUpstreamAt: null, blockedUntil: 0, lastFailure: null, inflight: null };
}

/** The isolate's own state (the action's). */
const MODULE_STATE = createGithubReleasesState();

/** Tests only: forget everything the module remembers. */
export function resetGithubReleasesState(): void {
  Object.assign(MODULE_STATE, createGithubReleasesState());
}

export type ListOptions = {
  repo?: string;
  /** `GITHUB_TOKEN`: sent to `api.github.com` only. */
  token?: string;
  /** Ask GitHub again (still not more often than every `MIN_GAP_MS`). */
  refresh?: boolean;
  fetch?: FetchLike;
  now?: () => number;
  state?: GithubReleasesState;
};

// ---------------------------------------------------------------- small helpers

type Json = Record<string, unknown>;
const isRecord = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);

/** Case-insensitive prefix (GitHub answers the canonical spelling of the repository name). */
function startsWithCi(text: string, prefix: string): boolean {
  return text.length >= prefix.length && text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

/** `text` cut to `max` UTF-16 units without leaving half of a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = text.charCodeAt(max - 1);
  return text.slice(0, end >= 0xd800 && end <= 0xdbff ? max - 1 : max);
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** The notes as plain-text source: no `\r`, no HTML comments, no control characters, at most `NOTES_MAX_CHARS`. */
export function cleanNotes(body: unknown): { notes: string; truncated: boolean } {
  let t = (typeof body === "string" ? body : "").slice(0, 200_000);
  t = t.replace(/\r/g, "").replace(/<!--[\s\S]*?(?:-->|$)/g, "").replace(CONTROL, "").trim();
  return t.length > NOTES_MAX_CHARS ? { notes: cut(t, NOTES_MAX_CHARS).trimEnd(), truncated: true } : { notes: t, truncated: false };
}

function titleOf(name: unknown, tag: string): string {
  const t = (str(name) ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return t === "" ? `Rulebox ${tag.slice(1)}` : cut(t, TITLE_MAX_CHARS);
}

/**
 * PURE. The lines of a `SHA256SUMS` file: `<64 lower-case hex>`, a space, then a space (text) or `*` (binary), then the file name.
 * Anything else (blank lines, upper-case hex, other shapes) is ignored. A name listed twice with different hashes maps to `null`
 * (ambiguous: no hash is trusted).
 */
export function parseChecksums(text: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const raw of text.split("\n")) {
    const m = SUMS_LINE.exec(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    if (m === null) continue;
    const name = m[2]!;
    const hash = m[1]!;
    const before = out.get(name);
    out.set(name, before === undefined || before === hash ? hash : null);
  }
  return out;
}

// ---------------------------------------------------------------- one release

type Ctx = {
  repo: string;
  fetch: FetchLike | undefined;
  state: GithubReleasesState;
  /** Set when a problem may go away on its own (a checksum file that could not be fetched). */
  transient: { value: boolean };
};

function remember(state: GithubReleasesState, key: string, value: Sums): void {
  state.sums.delete(key);
  state.sums.set(key, value);
  while (state.sums.size > SHA_CACHE_MAX) {
    const oldest = state.sums.keys().next();
    if (oldest.done) break;
    state.sums.delete(oldest.value);
  }
}

function trustedAssetHost(hostname: string): boolean {
  return hostname === "github.com" || hostname.endsWith(".githubusercontent.com");
}

async function loadSums(c: Ctx, asset: Json, url: string): Promise<Sums> {
  const id = asset.id;
  const updated = str(asset.updated_at);
  const key = typeof id === "number" && updated !== undefined ? `${id}:${updated}` : undefined;
  if (key !== undefined) {
    const hit = c.state.sums.get(key);
    if (hit !== undefined) return hit;
  }
  const res = await fetchPublic(url, {
    fetch: c.fetch,
    maxBytes: SUMS_MAX_BYTES,
    accept: "text/plain,*/*;q=0.5",
    timeoutMs: SUMS_TIMEOUT_MS,
    maxRedirects: 3,
    headers: () => ({ "user-agent": USER_AGENT }), // no token: this is a public file download
  });
  if (!res.ok) {
    // A network failure or an error status may be temporary: not remembered. A body that is too large or a refused address will not change.
    if (res.reason === "network" || res.reason === "status") {
      c.transient.value = true;
      return { kind: "unreadable" };
    }
    if (key !== undefined) remember(c.state, key, { kind: "unreadable" });
    return { kind: "unreadable" };
  }
  let sums: Sums;
  try {
    if (!trustedAssetHost(res.url.hostname)) throw new Error("unexpected host");
    sums = { kind: "ok", hashes: parseChecksums(new TextDecoder("utf-8", { fatal: true }).decode(res.bytes)) };
  } catch {
    sums = { kind: "unreadable" };
  }
  if (key !== undefined) remember(c.state, key, sums);
  return sums;
}

/** One entry of the releases API as a `GithubRelease`, or `null` when it is not a Rulebox release (draft, other tag). */
async function describeRelease(raw: unknown, c: Ctx): Promise<GithubRelease | null> {
  if (!isRecord(raw) || raw.draft === true) return null;
  const tag = str(raw.tag_name);
  const tagMatch = tag === undefined ? null : TAG_PATTERN.exec(tag);
  if (tag === undefined || tagMatch === null) return null;
  const version = tagMatch[1]!;
  const published = Date.parse(str(raw.published_at) ?? str(raw.created_at) ?? "");
  const html = str(raw.html_url);
  const pageOk = html !== undefined && html.length <= 300 && !/\s/.test(html) && startsWithCi(html, `https://github.com/${c.repo}/releases/`);
  const { notes, truncated } = cleanNotes(raw.body);
  const base: GithubRelease = {
    tag,
    title: titleOf(raw.name, tag),
    version,
    prerelease: raw.prerelease === true,
    publishedAt: Number.isFinite(published) ? published : 0,
    pageUrl: pageOk ? html : `https://github.com/${c.repo}/releases/tag/${tag}`,
    notes,
    notesTruncated: truncated,
    signed: false,
    msi: null,
    problem: null,
  };
  const bad = (problem: ReleaseProblem, extra: Partial<GithubRelease> = {}): GithubRelease => ({ ...base, ...extra, problem });

  const assets = (Array.isArray(raw.assets) ? raw.assets : []).slice(0, MAX_ASSETS).filter(isRecord);
  const uploaded = (a: Json) => a.state === "uploaded";
  const msis = assets.filter((a) => uploaded(a) && MSI_PATTERN.test(str(a.name) ?? ""));
  if (msis.length === 0) return bad("no_msi");
  if (msis.length > 1) return bad("two_msis");
  const msi = msis[0]!;
  const msiName = str(msi.name)!;
  const msiMatch = MSI_PATTERN.exec(msiName)!;
  if (msiMatch[1] !== version) return bad("version_mismatch");
  const signed = msiMatch[2] === undefined;

  const downloadPrefix = `https://github.com/${c.repo}/releases/download/`;
  const msiUrl = str(msi.browser_download_url);
  if (msiUrl === undefined || msiUrl.length > 2048 || /\s/.test(msiUrl) || !startsWithCi(msiUrl, downloadPrefix) || !pageOk || !Number.isFinite(published)) {
    return bad("invalid", { signed });
  }
  const size = msi.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) return bad("invalid", { signed });
  if (size > MAX_RELEASE_BYTES) return bad("too_large", { signed });

  const sumsAsset = assets.find((a) => uploaded(a) && a.name === SUMS_NAME);
  if (sumsAsset === undefined) return bad("no_checksums", { signed });
  const sumsUrl = str(sumsAsset.browser_download_url);
  if (sumsUrl === undefined || sumsUrl.length > 2048 || !startsWithCi(sumsUrl, downloadPrefix)) return bad("invalid", { signed });
  const sums = await loadSums(c, sumsAsset, sumsUrl);
  if (sums.kind === "unreadable") return bad("checksums_unreadable", { signed });
  const sha256 = sums.hashes.get(msiName);
  if (sha256 === undefined) return bad("not_in_checksums", { signed });
  if (sha256 === null) return bad("checksums_unreadable", { signed });
  // GitHub's own digest of the asset, when it gives one: it must agree.
  const digest = /^sha256:([0-9A-Fa-f]{64})$/.exec(str(msi.digest) ?? "");
  if (digest !== null && digest[1]!.toLowerCase() !== sha256) return bad("hash_mismatch", { signed });

  // The picked release must never be refused by `ruleboxRelease:set`.
  try {
    normalizeRelease({ version, url: msiUrl, sha256, sizeBytes: size });
  } catch {
    return bad("invalid", { signed });
  }
  return { ...base, signed, msi: { name: msiName, url: msiUrl, sizeBytes: size, sha256 }, problem: null };
}

// ---------------------------------------------------------------- the list

type Outcome =
  | { kind: "ok"; releases: GithubRelease[]; etag: string | undefined; transient: boolean }
  | { kind: "not_modified" }
  | { kind: "fail"; failure: GithubReleasesFailure; status?: number };

/** When a 403 / 429 says the limit is used up: `retry-after` (secondary limit, seconds) or `x-ratelimit-reset` (epoch seconds). Else null. */
function rateLimit(headers: Headers | undefined, now: number): number | null {
  const retryAfter = headers?.get("retry-after");
  if (retryAfter !== null && retryAfter !== undefined && /^\d{1,7}$/.test(retryAfter.trim()) && Number(retryAfter) > 0) {
    return now + Math.min(Number(retryAfter) * 1000, BLOCK_MAX_MS);
  }
  const reset = headers?.get("x-ratelimit-reset");
  if (headers?.get("x-ratelimit-remaining") === "0" && reset !== null && reset !== undefined && /^\d{1,12}$/.test(reset.trim())) {
    const at = Number(reset) * 1000;
    return at > now ? Math.min(at, now + BLOCK_MAX_MS) : now + MIN_GAP_MS;
  }
  return null;
}

async function fetchList(c: Ctx, o: ListOptions, previous: ListCache | null, now: number): Promise<Outcome> {
  const unreachable: Outcome = { kind: "fail", failure: { reason: "unreachable" } };
  const token = o.token !== undefined && o.token !== "" ? o.token : undefined;
  const etag = previous?.etag;
  const res = await fetchPublic(`https://api.github.com/repos/${c.repo}/releases?per_page=${MAX_RELEASES}`, {
    fetch: o.fetch,
    maxBytes: LIST_MAX_BYTES,
    accept: "application/vnd.github+json",
    timeoutMs: LIST_TIMEOUT_MS,
    maxRedirects: 2,
    ifNoneMatch: etag,
    // The token goes to the API host only, never to a redirect target.
    headers: (u) => ({
      "x-github-api-version": "2022-11-28",
      "user-agent": USER_AGENT,
      ...(token !== undefined && u.hostname === "api.github.com" ? { authorization: `Bearer ${token}` } : {}),
    }),
  });
  if (!res.ok) {
    if (res.reason === "not_modified") return { kind: "not_modified" };
    if (res.reason !== "status") return { kind: "fail", failure: { reason: "unreachable" } };
    const status = res.status ?? 0;
    if (status === 404) return { kind: "fail", failure: { reason: "not_found" }, status };
    if (status === 403 || status === 429) {
      const retryAt = rateLimit(res.headers, now) ?? (status === 429 ? now + 60_000 : null);
      if (retryAt !== null) return { kind: "fail", failure: { reason: "rate_limited", retryAt }, status };
    }
    return { ...unreachable, status };
  }
  if (res.url.hostname !== "api.github.com") return unreachable;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(res.bytes));
  } catch {
    return unreachable;
  }
  if (!Array.isArray(body)) return unreachable;
  const ctx: Ctx = { ...c, transient: { value: false } };
  const described = await Promise.all(body.slice(0, MAX_RELEASES).map((r) => describeRelease(r, ctx)));
  const releases = described.filter((r): r is GithubRelease => r !== null).sort((a, b) => b.publishedAt - a.publishedAt);
  const raw = res.headers.get("etag");
  // A list with a temporary problem is not revalidated by a 304 later: the next refresh reads everything again.
  const keep = raw !== null && raw.length <= 200 && ETAG.test(raw) && !ctx.transient.value ? raw : undefined;
  return { kind: "ok", releases, etag: keep, transient: ctx.transient.value };
}

const okResult = (cache: ListCache, stale: boolean): GithubReleasesResult => ({
  status: "ok",
  repoUrl: `https://github.com/${cache.repo}`,
  checkedAt: cache.checkedAt,
  stale,
  releases: cache.releases,
});

/** What to answer when GitHub cannot be asked or did not answer: the cached list (stale) when there is one, else the failure. */
function fallback(cache: ListCache | null, failure: GithubReleasesFailure): GithubReleasesResult {
  return cache !== null ? okResult(cache, true) : { status: "unavailable", ...failure };
}

/**
 * The newest releases of `repo` (up to 10, newest first), each with what the form needs or the reason it cannot be used. Never
 * throws and never reads or writes the database. Caching: a list younger than `LIST_TTL_MS` answers without a network call; `refresh`
 * sends a conditional request (a 304 only refreshes `checkedAt`); at least `MIN_GAP_MS` between two calls to GitHub; after a
 * rate-limit answer nothing goes upstream until it ends. When GitHub fails and a list is cached, that list is answered with
 * `stale: true`.
 */
export async function listGithubReleases(o: ListOptions = {}): Promise<GithubReleasesResult> {
  const state = o.state ?? MODULE_STATE;
  const now = () => o.now?.() ?? Date.now();
  const repo = o.repo ?? DEFAULT_RELEASES_REPO;
  const t0 = now();
  const cache = state.list !== null && state.list.repo === repo ? state.list : null;
  const freshMs = cache?.transient === true ? TRANSIENT_TTL_MS : LIST_TTL_MS;

  if (cache !== null && o.refresh !== true && t0 - cache.checkedAt < freshMs) return okResult(cache, false);
  if (state.blockedUntil > t0) return fallback(cache, { reason: "rate_limited", retryAt: state.blockedUntil });
  if (state.lastUpstreamAt !== null && t0 - state.lastUpstreamAt < MIN_GAP_MS) {
    if (cache !== null) return okResult(cache, state.lastFailure !== null || t0 - cache.checkedAt >= freshMs);
    if (state.lastFailure !== null) return { status: "unavailable", ...state.lastFailure };
  }
  if (state.inflight !== null && state.inflight.repo === repo) return state.inflight.promise;

  const run = (async (): Promise<GithubReleasesResult> => {
    state.lastUpstreamAt = t0;
    let outcome: Outcome;
    try {
      outcome = await fetchList({ repo, fetch: o.fetch, state, transient: { value: false } }, o, cache, t0);
    } catch {
      outcome = { kind: "fail", failure: { reason: "unreachable" } };
    }
    const t1 = now();
    if (outcome.kind === "ok") {
      state.lastFailure = null;
      state.list = { repo, etag: outcome.etag, checkedAt: t1, releases: outcome.releases, transient: outcome.transient };
      return okResult(state.list, false);
    }
    if (outcome.kind === "not_modified" && cache !== null) {
      state.lastFailure = null;
      cache.checkedAt = t1;
      return okResult(cache, false);
    }
    const failure: GithubReleasesFailure = outcome.kind === "fail" ? outcome.failure : { reason: "unreachable" };
    state.lastFailure = failure;
    if (failure.reason === "rate_limited" && failure.retryAt !== undefined) state.blockedUntil = failure.retryAt;
    // Status and reason only: never headers, never the token.
    console.warn("githubReleases: GitHub did not give a list", { reason: failure.reason, status: outcome.kind === "fail" ? outcome.status : undefined });
    return fallback(cache, failure);
  })();
  state.inflight = { repo, promise: run };
  try {
    return await run;
  } finally {
    if (state.inflight?.promise === run) state.inflight = null;
  }
}
