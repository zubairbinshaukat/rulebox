// Bounds of the vendor feed resolver (plan Phase 6, 4.5). Kept beside the resolver so that a change to the shared
// `lib/limits.ts` is not needed; every number here is a hard stop, not a hint.

/** `latest.json`: the whole body, read while it arrives (4.5 step 2). */
export const FEED_JSON_MAX_BYTES = 64 * 1024;
/** `latest.json`: one overall deadline for the request (4.5: 10 s). */
export const FEED_JSON_TIMEOUT_MS = 10_000;
/**
 * The installer, streamed and hashed, never stored (4.5: 512 MiB). UNVERIFIED on the dev deployment (the default action
 * runtime has 10 minutes and 64 MiB; the body is never held, only hashed chunk by chunk): measure with a 100 MiB file.
 */
export const FEED_INSTALLER_MAX_BYTES = 512 * 1024 * 1024;
/** The installer download's overall deadline: under the 10 minute action limit, so the action ends with a result of its own. */
export const FEED_DOWNLOAD_TIMEOUT_MS = 8 * 60_000;
/** Redirects followed (each one must pass the same https / public-host test). */
export const FEED_MAX_REDIRECTS = 3;
/** The longest `etag` kept (a longer one is not stored: the next check then simply downloads `latest.json` again). */
export const FEED_MAX_ETAG = 200;
/** A feed's `signature` field: a minisign file as base64 is about 400 characters. */
export const FEED_MAX_SIGNATURE_CHARS = 2048;

/** `feeds:tick`: feeds claimed per run (4.5 step 1). The rest wait for the next hour. */
export const FEED_TICK_BATCH = 10;
/** The normal gap between two checks of one feed, and the jitter added to it (0 up to this many ms). */
export const FEED_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
export const FEED_JITTER_MS = 60 * 60_000;
/** Unreachable feeds are asked again after 1 h, then 4 h, then every 24 h (4.5 step 3). */
export const FEED_BACKOFF_MS = [60 * 60_000, 4 * 60 * 60_000, 24 * 60 * 60_000] as const;
/** After this many consecutive failures the app page shows a warning (the dashboard reads `failures`). */
export const FEED_WARN_FAILURES = 7;
/** A paused feed is "due" ten years from now: the tick's index range never reaches it. */
export const FEED_PAUSED_FOR_MS = 10 * 365 * 24 * 60 * 60_000;
