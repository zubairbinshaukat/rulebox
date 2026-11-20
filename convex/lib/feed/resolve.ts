import { sha256 } from "@noble/hashes/sha2.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { fetchFeedResource, type FeedFetchFailure } from "./fetch";
import { FEED_DOWNLOAD_TIMEOUT_MS, FEED_INSTALLER_MAX_BYTES, FEED_JSON_MAX_BYTES, FEED_JSON_TIMEOUT_MS } from "./limits";
import { verifyPrehashed } from "./minisign";
import { parseLatestJson } from "./tauri";
import { compareVersions } from "./version";

// One check of a vendor feed (plan Phase 6, 4.5 step 2), without any database: the action loads the row, calls this, and
// stores the outcome. Nothing the feed says is believed until the installer it names has been downloaded, hashed and its
// minisign signature has been verified with the public key the admin typed.

export type FeedFailure = "unreachable" | "bad_signature" | "bad_feed" | "too_large";

/** What a check found. `etag` is present only when the next check may send it back (never after `unreachable`). */
export type FeedOutcome =
  | { kind: "not_modified" }
  /** The feed's version is the app's, or one already seen (published, offered, dismissed or rolled back from). */
  | { kind: "current"; version: string; etag?: string }
  /** The feed lists a LOWER version than the app's: ignored and shown (4.4.4). */
  | { kind: "downgrade"; version: string; etag?: string }
  | { kind: "new"; version: string; url: string; sha256: string; sizeBytes: number; etag?: string }
  | { kind: "failed"; status: FeedFailure; etag?: string };

export type FeedCheckInput = {
  feed: { url: string; pubkey: string; target: string };
  installKind?: "msi" | "exe" | "portable";
  /** The version the app delivers now. Must be ordered (a Managed app always has one). */
  appVersion?: string;
  /** The highest feed version already processed (published, offered or dismissed). */
  seenVersion?: string;
  etag?: string;
};

export type FeedCheckOptions = { fetch?: typeof fetch; jsonTimeoutMs?: number; downloadTimeoutMs?: number; maxInstallerBytes?: number };

/** `latest.json` problems and a refused address are the feed's fault; a network error or an HTTP error may pass. */
function failureOf(reason: FeedFetchFailure, tooLarge: FeedFailure): FeedFailure {
  switch (reason) {
    case "network":
    case "status":
      return "unreachable";
    case "too_large":
      return tooLarge;
    default:
      return "bad_feed";
  }
}

export async function checkFeed(input: FeedCheckInput, opts: FeedCheckOptions = {}): Promise<FeedOutcome> {
  // 1. latest.json
  const parts: Uint8Array[] = [];
  const json = await fetchFeedResource(input.feed.url, {
    maxBytes: FEED_JSON_MAX_BYTES,
    timeoutMs: opts.jsonTimeoutMs ?? FEED_JSON_TIMEOUT_MS,
    accept: "application/json",
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    ...(input.etag !== undefined ? { ifNoneMatch: input.etag } : {}),
    onChunk: (c) => parts.push(c.slice()),
  });
  if (!json.ok) return { kind: "failed", status: failureOf(json.reason, "bad_feed") };
  if (json.notModified) return { kind: "not_modified" };
  const etag = json.etag;
  const failed = (status: FeedFailure, keepEtag = true): FeedOutcome => ({ kind: "failed", status, ...(keepEtag && etag !== undefined ? { etag } : {}) });

  let text: string;
  try {
    const all = new Uint8Array(json.size);
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    text = new TextDecoder("utf-8", { fatal: true }).decode(all);
  } catch {
    return failed("bad_feed");
  }
  const parsed = parseLatestJson(text, input.feed.target, input.installKind);
  if (!parsed.ok) return failed("bad_feed");
  const { version, url, signature } = parsed.release;

  // 2. Is it worth a download? Only a version higher than the app's AND than anything already seen.
  const against = input.appVersion === undefined ? null : compareVersions(version, input.appVersion);
  // Our own state is the problem (no ordered version on the app): never remember the etag, so a fix is seen at the next check.
  if (against === null) return failed("bad_feed", false);
  if (against === -1) return { kind: "downgrade", version, ...(etag !== undefined ? { etag } : {}) };
  const seen = input.seenVersion === undefined ? 1 : compareVersions(version, input.seenVersion);
  if (against === 0 || seen === null || seen !== 1) return { kind: "current", version, ...(etag !== undefined ? { etag } : {}) };

  // 3. The installer: streamed, SHA-256 and BLAKE2b-512 in the same pass, not kept.
  const max = opts.maxInstallerBytes ?? FEED_INSTALLER_MAX_BYTES;
  const sha = sha256.create();
  const b2 = blake2b.create({ dkLen: 64 });
  const file = await fetchFeedResource(url, {
    maxBytes: max,
    timeoutMs: opts.downloadTimeoutMs ?? FEED_DOWNLOAD_TIMEOUT_MS,
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    onChunk: (c) => {
      sha.update(c);
      b2.update(c);
    },
  });
  if (!file.ok) {
    const status = failureOf(file.reason, "too_large");
    // Over the cap is a property of this release (the same one next time): remember the feed's etag. A network error is not.
    return failed(status, status !== "unreachable");
  }
  if (file.notModified || file.size === 0) return failed("bad_feed");

  // 4. The signature, with the vendor's key. Nothing is published on a mismatch.
  if (!verifyPrehashed(input.feed.pubkey, signature, b2.digest())) return failed("bad_signature");
  return { kind: "new", version, url, sha256: bytesToHex(sha.digest()), sizeBytes: file.size, ...(etag !== undefined ? { etag } : {}) };
}
