import { certificateRange, detectInstaller, INSPECT_HEAD_BYTES, INSPECT_TAIL_BYTES, type InstallerInspection } from "./installerDetect";
import { WEBMETA_MAX_REDIRECTS } from "./limits";
import { fetchableUrl, readLimited } from "./safeFetch";

// "Detect" for an installer address (Phase 6 Step 13, plan 4.7, `apps:inspectInstaller`): up to THREE HTTP Range requests (the first
// 2 MiB, the certificate table, the last 64 KiB; 2.3 MiB at most), then the pure detector. Nothing is stored and the file is never
// downloaded whole. Same fetch rules as `lib/safeFetch.ts` (https only, public host, port 443, every redirect re-checked, the body
// capped while it is read, one overall deadline). `fetch` is injectable (tests stub it: no test uses the network).

type FetchLike = typeof fetch;

export const INSPECT_TIMEOUT_MS = 30_000;

export type InspectFailure =
  /** The address is not one the server may fetch (private host, redirect to http, ...). */
  | "blocked"
  /** The host answered the whole file instead of a range: the form stays manual. */
  | "unsupported"
  /** The address did not answer, or answered something that is not a file. */
  | "failed"
  /** The first bytes are not a Windows program or an MSI. */
  | "not_installer";

export type InspectOutcome = { ok: true; inspection: InstallerInspection; sizeBytes?: number } | { ok: false; reason: InspectFailure };

type RangeOutcome = { ok: true; bytes: Uint8Array; total?: number } | { ok: false; reason: "blocked" | "unsupported" | "failed" };

/** `bytes 0-99/1000` -> `{ from: 0, total: 1000 }` (`total` absent for `*`). */
function parseContentRange(value: string | null): { from: number; total?: number } | null {
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(value ?? "");
  if (m === null) return null;
  return { from: Number(m[1]), ...(m[3] === "*" ? {} : { total: Number(m[3]) }) };
}

/** True when the runtime followed a redirect on its own although we asked for `manual`: the body came from an address nobody checked. */
function followedRedirect(res: Response, requested: URL): boolean {
  if (res.redirected || res.type === "opaqueredirect") return true;
  const at = requested.href.indexOf("#");
  return res.url !== "" && res.url !== (at === -1 ? requested.href : requested.href.slice(0, at));
}

async function fetchRange(start: string, from: number, to: number, f: FetchLike, signal: AbortSignal): Promise<RangeOutcome> {
  const want = to - from + 1;
  let url: URL;
  try {
    url = new URL(start);
  } catch {
    return { ok: false, reason: "blocked" };
  }
  for (let hop = 0; hop <= WEBMETA_MAX_REDIRECTS; hop++) {
    if (!fetchableUrl(url)) return { ok: false, reason: "blocked" };
    const res = await f(url.href, { method: "GET", redirect: "manual", signal, headers: { accept: "*/*", "accept-encoding": "identity", range: `bytes=${from}-${to}` } });
    if (followedRedirect(res, url)) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "blocked" };
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (location === null) return { ok: false, reason: "failed" };
      try {
        url = new URL(location, url);
      } catch {
        return { ok: false, reason: "blocked" };
      }
      continue;
    }
    if (res.status === 206) {
      const range = parseContentRange(res.headers.get("content-range"));
      if (range === null || range.from !== from) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, reason: "failed" };
      }
      const bytes = await readLimited(res, want);
      // More than we asked for, or nothing at all: not a usable answer.
      if (bytes === null || bytes.length === 0) return { ok: false, reason: "failed" };
      return { ok: true, bytes, ...(range.total !== undefined ? { total: range.total } : {}) };
    }
    if (res.status === 200) {
      // The host ignores Range. A file that fits in the request is still a complete answer for the first request; anything larger is
      // not read (it could be gigabytes): the form stays manual.
      const declared = Number(res.headers.get("content-length"));
      if (from !== 0 || !Number.isFinite(declared) || declared <= 0 || declared > want) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, reason: "unsupported" };
      }
      const bytes = await readLimited(res, want);
      return bytes === null || bytes.length === 0 ? { ok: false, reason: "failed" } : { ok: true, bytes, total: bytes.length };
    }
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "failed" };
  }
  return { ok: false, reason: "failed" };
}

/**
 * Reads the head of the file at `url` (and its certificate table and tail when they lie beyond it) and detects what it is. Never
 * throws: a refusal is an `ok: false` with the reason. The certificate and the tail are best effort (display and fallback markers).
 */
export async function inspectInstallerUrl(url: string, opts: { fetch?: FetchLike; timeoutMs?: number } = {}): Promise<InspectOutcome> {
  const f = opts.fetch ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? INSPECT_TIMEOUT_MS);
  try {
    const first = await fetchRange(url, 0, INSPECT_HEAD_BYTES - 1, f, ctl.signal);
    if (!first.ok) return first;
    const head = first.bytes;
    const total = first.total;
    if (detectInstaller({ head }) === null) return { ok: false, reason: "not_installer" };

    let cert: Uint8Array | undefined;
    const range = certificateRange(head);
    if (range !== null && range.offset + range.size > head.length && total !== undefined && range.offset + range.size <= total) {
      const got = await fetchRange(url, range.offset, range.offset + range.size - 1, f, ctl.signal);
      if (got.ok && got.bytes.length === range.size) cert = got.bytes;
    }
    let tail: Uint8Array | undefined;
    if (total !== undefined && total > head.length) {
      const from = Math.max(head.length, total - INSPECT_TAIL_BYTES);
      const got = await fetchRange(url, from, total - 1, f, ctl.signal);
      if (got.ok) tail = got.bytes;
    }
    const inspection = detectInstaller({ head, ...(tail !== undefined ? { tail } : {}), ...(cert !== undefined ? { cert } : {}) });
    if (inspection === null) return { ok: false, reason: "not_installer" };
    return { ok: true, inspection, ...(total !== undefined ? { sizeBytes: total } : {}) };
  } catch {
    return { ok: false, reason: "failed" };
  } finally {
    clearTimeout(timer);
  }
}
