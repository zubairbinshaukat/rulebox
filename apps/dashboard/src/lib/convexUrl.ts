/**
 * Where the Convex backend is (Phase 4 Step 20, amendment A18): the deployment puts
 * `{ "convexUrl": "https://..." }` next to the page as `/config.json`, so one build can serve
 * any backend. The build-time `VITE_CONVEX_URL` is the fallback (local development, and a
 * deployment that has no config file). Live builds only: the demo build never calls this.
 */

const TIMEOUT_MS = 3000;

/** `https:` anywhere; plain `http:` only for this computer (development). Anything else is ignored. */
export function validConvexUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    return url.protocol === "https:" || (url.protocol === "http:" && local) ? url.origin : null;
  } catch {
    return null;
  }
}

/** The URL from `/config.json`, else `fallback`. A missing, slow, malformed or invalid file is ignored. */
export async function resolveConvexUrl(fallback: string | undefined, fetchFn: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const res = await fetchFn("/config.json", { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) {
      const url = validConvexUrl(((await res.json()) as { convexUrl?: unknown } | null)?.convexUrl);
      if (url) return url;
    }
  } catch {
    // No file (a 404, or the page itself answered), no network in time, not JSON: use the build setting.
  }
  return fallback;
}
