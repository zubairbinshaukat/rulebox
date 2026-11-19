import { MAX_COMPAT_JSON_BYTES } from "./limits";

// The agent's compatibility report (apps/agent/src/compat.rs `CompatReport`; plan Phase 6
// 4.12). It is stored as `v.any()`: the agent owns the shape, so a newer agent's extra field
// never fails (and stalls) a whole status report. This checks only what the dashboard reads
// and what could grow or lie: the Phase 6 fields are bounded and typed, and anything that does
// not fit is dropped (never the whole report). The server never decides "OS out of support"
// from this: `lifecycle.ts` does that from the build and the edition.

const CODE = /^[a-z0-9_]{1,40}$/;
/** A WebView2 version as the agent sends it: digits and dots, at most 32 characters. */
const VERSION = /^[0-9][0-9.]{0,31}$/;
const MAX_CODES = 20;

const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);

function codes(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((x): x is string => typeof x === "string" && CODE.test(x)).slice(0, MAX_CODES);
}

function flags<K extends string>(raw: unknown, keys: readonly K[]): Record<K, boolean> | undefined {
  if (!isObject(raw)) return undefined;
  const out = {} as Record<K, boolean>;
  for (const k of keys) {
    if (typeof raw[k] !== "boolean") return undefined;
    out[k] = raw[k] as boolean;
  }
  return out;
}

export type CompatWebView2 = { present: boolean; version: string | null; source: "machine" | "user" | "none" };

export function cleanWebView2(raw: unknown): CompatWebView2 | undefined {
  if (!isObject(raw) || typeof raw.present !== "boolean") return undefined;
  const version = typeof raw.version === "string" && VERSION.test(raw.version) ? raw.version : null;
  const source = raw.source === "machine" || raw.source === "user" ? raw.source : "none";
  // "Present" without a usable version is not present.
  return { present: raw.present && version !== null, version, source: version === null ? "none" : source };
}

/**
 * The report as it is stored: objects only, the known Phase 6 fields checked and bounded (a bad
 * one is dropped), `blockers` and `warnings` reduced to short codes, the rest passed through.
 * `undefined` (stored as "no report") for anything that is not an object or whose JSON is over
 * `MAX_COMPAT_JSON_BYTES`.
 */
export function cleanCompat(raw: unknown): Record<string, unknown> | undefined {
  if (!isObject(raw)) return undefined;
  const out: Record<string, unknown> = { ...raw };
  for (const k of ["blockers", "warnings"] as const) {
    if (k in out) {
      const list = codes(out[k]);
      if (list === undefined) delete out[k];
      else out[k] = list;
    }
  }
  const set = (key: string, value: unknown) => {
    if (value === undefined) delete out[key];
    else out[key] = value;
  };
  if ("webview2" in out) set("webview2", cleanWebView2(out.webview2));
  if ("protection" in out) set("protection", out.protection === "full" || out.protection === "reduced" ? out.protection : undefined);
  if ("layers" in out) set("layers", flags(out.layers, ["appLocker", "appControl"] as const));
  if ("browsers" in out) set("browsers", flags(out.browsers, ["edge", "chrome"] as const));
  for (const k of ["protectedPrint", "lowRam", "liteMode"] as const) {
    if (k in out && typeof out[k] !== "boolean") delete out[k];
  }
  return JSON.stringify(out).length > MAX_COMPAT_JSON_BYTES ? undefined : out;
}
