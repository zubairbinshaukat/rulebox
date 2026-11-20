import { fetchableUrl } from "../safeFetch";
import { FEED_MAX_ETAG, FEED_MAX_REDIRECTS } from "./limits";

// The feed resolver's network reads (plan Phase 6, 4.5): `latest.json` (small, collected) and the installer (large,
// streamed into a hash and never kept). Same rules as `lib/safeFetch.ts`: https only, public hosts, every redirect
// re-checked (we follow them ourselves) and refused when it leaves https, a size cap enforced while the body arrives,
// one overall deadline that also covers reading the body. `fetch` is injectable (tests stub it: no test uses the network).

type FetchLike = typeof fetch;

export type FeedFetchFailure = "blocked" | "redirects" | "redirect_followed" | "status" | "too_large" | "network";

export type FeedFetched =
  | { ok: true; notModified: false; size: number; etag?: string }
  | { ok: true; notModified: true }
  | { ok: false; reason: FeedFetchFailure; status?: number };

export type FeedFetchOptions = {
  maxBytes: number;
  timeoutMs: number;
  fetch?: FetchLike;
  /** `If-None-Match` value (the `latest.json` request only). */
  ifNoneMatch?: string;
  accept?: string;
  /** Called with every chunk, in order, as it arrives. The caller decides what to keep. */
  onChunk: (chunk: Uint8Array) => void;
};

/** True when the runtime followed a redirect on its own although we asked for `manual` (the body came from an unchecked address). */
function followedRedirect(res: Response, requested: URL): boolean {
  if (res.redirected || res.type === "opaqueredirect") return true;
  const at = requested.href.indexOf("#");
  const wanted = at === -1 ? requested.href : requested.href.slice(0, at);
  return res.url !== "" && res.url !== wanted;
}

function etagOf(res: Response): string | undefined {
  const tag = res.headers.get("etag")?.trim();
  // Printable ASCII only, bounded: it is sent back as a header and stored.
  if (tag === undefined || tag === "" || tag.length > FEED_MAX_ETAG || !/^[\x20-\x7e]+$/.test(tag)) return undefined;
  return tag;
}

/**
 * GET `start` and hand the body to `onChunk`. `304` (only when `ifNoneMatch` was sent) answers `notModified`. A declared
 * length above the cap is refused before any byte is read; a body that grows past it is cut off (`too_large`).
 */
export async function fetchFeedResource(start: string, opts: FeedFetchOptions): Promise<FeedFetched> {
  const f = opts.fetch ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
  try {
    let url: URL;
    try {
      url = new URL(start);
    } catch {
      return { ok: false, reason: "blocked" };
    }
    for (let hop = 0; hop <= FEED_MAX_REDIRECTS; hop++) {
      if (!fetchableUrl(url)) return { ok: false, reason: "blocked" };
      const headers: Record<string, string> = { accept: opts.accept ?? "*/*" };
      if (opts.ifNoneMatch !== undefined) headers["if-none-match"] = opts.ifNoneMatch;
      const res = await f(url.href, { method: "GET", redirect: "manual", signal: ctl.signal, headers });
      if (followedRedirect(res, url)) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, reason: "redirect_followed" };
      }
      if (res.status === 304 && opts.ifNoneMatch !== undefined) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: true, notModified: true };
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (location === null) return { ok: false, reason: "status", status: res.status };
        try {
          url = new URL(location, url);
        } catch {
          return { ok: false, reason: "blocked" };
        }
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, reason: "status", status: res.status };
      }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      let size = 0;
      if (res.body === null) {
        const all = new Uint8Array(await res.arrayBuffer());
        if (all.length > opts.maxBytes) return { ok: false, reason: "too_large" };
        size = all.length;
        opts.onChunk(all);
      } else {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > opts.maxBytes) {
            await reader.cancel().catch(() => undefined);
            return { ok: false, reason: "too_large" };
          }
          opts.onChunk(value);
        }
      }
      const etag = etagOf(res);
      return { ok: true, notModified: false, size, ...(etag !== undefined ? { etag } : {}) };
    }
    return { ok: false, reason: "redirects" };
  } catch {
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timer);
  }
}
