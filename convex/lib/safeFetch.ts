import { isForbiddenHost } from "./hostRules";
import { WEBMETA_MAX_REDIRECTS, WEBMETA_TIMEOUT_MS } from "./limits";

// The only places a Convex action reads a body from the network (web metadata
// and winget manifests). Both are admin-triggered and both fetch an address a
// person typed, so this is where SSRF is closed: https only, no private /
// loopback / link-local / reserved address and no local host name, every
// redirect re-checked (we follow them ourselves, `redirect: "manual"`), a body
// size cap that is enforced while reading, and one overall deadline.
//
// `fetch` is the global one unless the caller passes another (tests stub it:
// no test makes a real network call).

type FetchLike = typeof fetch;

export type FetchFailure = "blocked" | "redirects" | "redirect_followed" | "status" | "too_large" | "network";
export type Fetched =
  | { ok: true; url: URL; bytes: Uint8Array; contentType: string }
  | { ok: false; reason: FetchFailure; status?: number };

/**
 * The response body as bytes, or null when it is larger than `max`. The cap is
 * checked on the declared length first and then while reading, so a server
 * that lies about (or hides) the size cannot make the action buffer more than
 * `max` bytes.
 */
export async function readLimited(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (res.body === null) {
    const all = new Uint8Array(await res.arrayBuffer());
    return all.length > max ? null : all;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export type PublicFetchOptions = {
  maxBytes: number;
  /** The `Accept` header (default any). */
  accept?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Request headers per URL (so a token is sent only to the host that needs it, also after a redirect). */
  headers?: (url: URL) => Record<string, string>;
};

/**
 * True for a URL the server may fetch: https, no credentials, port 443 (the
 * URL parser drops an explicit `:443`, so "no port" is the only form left; any
 * other port could reach an internal admin service on a public host), a public host.
 */
export function fetchableUrl(url: URL): boolean {
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "" && !isForbiddenHost(url.hostname);
}

/** `href` without its fragment (a response URL never carries one). */
function withoutFragment(href: string): string {
  const at = href.indexOf("#");
  return at === -1 ? href : href.slice(0, at);
}

/**
 * True when the runtime followed a redirect on its own although we asked for
 * `redirect: "manual"` (or answered an opaque redirect): the body then came
 * from an address we never checked, so it must not be read.
 */
function followedRedirect(res: Response, requested: URL): boolean {
  if (res.redirected || res.type === "opaqueredirect") return true;
  return res.url !== "" && res.url !== withoutFragment(requested.href);
}

/** GET `start` over https, following up to `maxRedirects` redirects that each pass `fetchableUrl`. */
export async function fetchPublic(start: string, opts: PublicFetchOptions): Promise<Fetched> {
  const f = opts.fetch ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? WEBMETA_TIMEOUT_MS);
  try {
    let url: URL;
    try {
      url = new URL(start);
    } catch {
      return { ok: false, reason: "blocked" };
    }
    for (let hop = 0; hop <= (opts.maxRedirects ?? WEBMETA_MAX_REDIRECTS); hop++) {
      if (!fetchableUrl(url)) return { ok: false, reason: "blocked" };
      const res = await f(url.href, { method: "GET", redirect: "manual", signal: ctl.signal, headers: { accept: opts.accept ?? "*/*", ...opts.headers?.(url) } });
      // Whether the runtime honours `redirect: "manual"` is not something we can rely on: refuse any answer that did not come from the address we checked.
      if (followedRedirect(res, url)) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, reason: "redirect_followed" };
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (location === null) return { ok: false, reason: "status" };
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
      const bytes = await readLimited(res, opts.maxBytes);
      if (bytes === null) return { ok: false, reason: "too_large" };
      return { ok: true, url, bytes, contentType: res.headers.get("content-type") ?? "" };
    }
    return { ok: false, reason: "redirects" };
  } catch {
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timer);
  }
}
