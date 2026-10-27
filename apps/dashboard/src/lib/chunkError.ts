/**
 * Failed lazy chunk loads (flaky network, or a new deploy that removed the old
 * hashed files). Pure helpers, used by `app/ChunkErrorBoundary.tsx`.
 */

/** Messages browsers and Vite use when a dynamic import or its preloads fail. */
const PATTERNS = [
  /Failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // Safari
  /Unable to preload CSS/i, // Vite's preload helper
  /Loading (CSS )?chunk [\w-]+ failed/i,
];

/** True for an error thrown because a code chunk could not be downloaded. */
export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: unknown; message?: unknown };
  if (e.name === "ChunkLoadError") return true;
  const message = typeof e.message === "string" ? e.message : "";
  return PATTERNS.some((p) => p.test(message));
}

/** Session-storage key holding the time of the last automatic reload. */
export const RELOAD_KEY = "rulebox.chunkReloadAt";
/** At most one automatic reload in this window, so a broken deploy cannot loop. */
export const RELOAD_WINDOW_MS = 60_000;

/**
 * Whether to reload the page by itself after a chunk error: only while the
 * browser thinks it is online (offline, a reload shows the browser's own
 * error page instead of ours) and only once per `RELOAD_WINDOW_MS`.
 */
export function shouldAutoReload(now: number, lastReloadAt: number | null, online: boolean): boolean {
  if (!online) return false;
  return lastReloadAt === null || !(now - lastReloadAt < RELOAD_WINDOW_MS && now >= lastReloadAt);
}
