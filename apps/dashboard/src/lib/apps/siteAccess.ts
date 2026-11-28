/**
 * Which addresses a website app may open, as the dashboard's site-access picker explains it (add-app plan section 6).
 * Pure. The decision (`decide`/`allows`) MIRRORS the Staff App's `webapp/allow.rs` (https only, no login in the address,
 * port equality, an IP matches only an identical IP, a host matches an entry when it is equal to it or ends with
 * `"." + entry`), so the preview shows what the PC will really do. The PC stays the authority.
 *
 * The data model does not change: `allowedDomains` is a list of entries, the address's own host excluded (the server
 * prepends it). Every entry already includes all its subdomains, so the picker writes PLAIN entries only (`example.com`,
 * never `*.example.com`, decision D12). An existing `*.x` entry is read as `x` here (the built-in window may treat the
 * literal `*.x` as a host that matches nothing: follow-up D28).
 */
import { isPublicSuffix, publicSuffixOf } from "./publicSuffixes";
import * as v from "../validate";

/** `MAX_ALLOWED_DOMAINS` of the server: extra entries per website. */
export const MAX_EXTRA_SITES = 20;
/** Most levels the picker shows. */
export const MAX_LEVELS = 4;
/** Most rows `samples()` returns. */
export const MAX_SAMPLES = 7;

export interface ParsedAddress {
  /** Lower-case ASCII (punycode) host without a trailing dot. An IPv6 literal keeps its brackets. */
  host: string;
  /** An explicit port, or `null` for the default (443). */
  port: number | null;
  /** The path (always starts with `/`), without the query. */
  path: string;
  isIp: boolean;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function cleanHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

function isIpHost(host: string): boolean {
  return IPV4.test(host) || host.startsWith("[");
}

/** The address of a website app: an `https://` URL without a login. `null` when it is empty, malformed or not https. */
export function parseAddress(url: string): ParsedAddress | null {
  const text = url.trim();
  if (text === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return null;
  const host = cleanHost(parsed.hostname);
  if (host === "") return null;
  return { host, port: parsed.port === "" ? null : Number(parsed.port), path: parsed.pathname || "/", isIp: isIpHost(host) };
}

/** The part of the host above the public suffix plus one label (`shop.example.co.uk` -> `example.co.uk`). `null` for an IP, a single label or a suffix. */
export function registrableDomain(host: string): string | null {
  const h = cleanHost(host);
  if (h === "" || isIpHost(h)) return null;
  const suffix = publicSuffixOf(h);
  if (h === suffix) return null;
  const rest = h.slice(0, h.length - suffix.length - 1).split(".");
  return `${rest[rest.length - 1]}.${suffix}`;
}

/**
 * The levels the picker offers for a host: the host first, then each parent down to the registrable domain (never a
 * suffix). At most four: when the chain is longer the middle is dropped. An IP, a single label or a suffix gives one.
 */
export function levels(host: string): string[] {
  const h = cleanHost(host);
  const registrable = registrableDomain(h);
  if (registrable === null) return [h];
  const chain: string[] = [];
  let current = h;
  for (;;) {
    chain.push(current);
    if (current === registrable) break;
    current = current.slice(current.indexOf(".") + 1);
  }
  return chain.length > MAX_LEVELS ? [chain[0]!, ...chain.slice(-(MAX_LEVELS - 1))] : chain;
}

/** An entry as the picker compares it: lower-case, a leading `*.` read as the plain domain. */
function plain(entry: string): string {
  const t = entry.trim().toLowerCase();
  return t.startsWith("*.") ? t.slice(2) : t;
}

/** The broadest level of `host` that is in `entries`, else the host itself (the entries never contain the host). */
export function selectedLevel(host: string, entries: readonly string[]): string {
  const all = levels(host);
  const have = new Set(entries.map(plain));
  for (let i = all.length - 1; i > 0; i--) {
    if (have.has(all[i]!)) return all[i]!;
  }
  return all[0]!;
}

/**
 * The entries after choosing `level` for `host`: every entry equal to a level of this host is removed (a saved `*.x` too)
 * and `level` is added first, unless it is the host (the server prepends the host itself). Other entries keep their order.
 */
export function withLevel(host: string, entries: readonly string[], level: string): string[] {
  const own = new Set(levels(host));
  const rest = entries.filter((e) => !own.has(plain(e)));
  return level === cleanHost(host) ? rest : [level, ...rest];
}

export type EntryProblem = "empty" | "port" | "local" | "ip_private" | "suffix" | "format";
export type EntryResult = { ok: true; entry: string } | { ok: false; reason: EntryProblem };

/**
 * What a typed or pasted "other site" becomes: `https://Login.Example.com/x`, `login.example.com`, `*.example.com` and
 * Unicode names all give a lower-case ASCII host. Refused with a reason: a port, a local-network name or private address,
 * a whole public suffix (`co.uk`, `github.io`), anything that is not a host name.
 */
export function normalizeEntry(text: string): EntryResult {
  let t = text.trim();
  if (t === "") return { ok: false, reason: "empty" };
  if (t.startsWith("*.")) t = t.slice(2);
  let parsed: URL;
  try {
    parsed = new URL(t.includes("://") ? t : `https://${t}`);
  } catch {
    return { ok: false, reason: "format" };
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "format" };
  }
  const host = cleanHost(parsed.hostname);
  if (host === "" || host.startsWith("[")) return { ok: false, reason: "format" };
  if (parsed.port !== "") return { ok: false, reason: "port" };
  // The same rules as the website address: local names, private and wildcard-DNS addresses.
  if (v.webUrl(`https://${host}/`) !== null) return { ok: false, reason: isIpHost(host) ? "ip_private" : "local" };
  if (!isIpHost(host)) {
    if (isPublicSuffix(host)) return { ok: false, reason: "suffix" };
    if (v.domain(host) !== null) return { ok: false, reason: "format" };
  }
  return { ok: true, entry: host };
}

interface Entry {
  host: string;
  port: number | null;
  isIp: boolean;
}

/** `allow.rs` `parse_entry`: `host`, `host:port` or a full https address; a bad entry is ignored (it cannot widen anything). */
function parseEntry(text: string): Entry | null {
  const t = plain(text);
  if (t === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(t.includes("://") ? t : `https://${t}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = cleanHost(parsed.hostname);
  if (host === "") return null;
  return { host, port: parsed.port === "" ? null : Number(parsed.port), isIp: isIpHost(host) };
}

export type DecisionReason = "own_host" | "entry" | "not_https" | "login" | "port" | "not_listed" | "bad_address";
export interface Decision {
  open: boolean;
  reason: DecisionReason;
}

/** The entries of the PC's allow-list: the app's own address first, then the extras. `null` when the address is not usable. */
function allowList(address: string, entries: readonly string[]): Entry[] | null {
  const own = parseAddress(address);
  if (own === null) return null;
  const list: Entry[] = [{ host: own.host, port: own.port, isIp: own.isIp }];
  for (const text of entries) {
    const e = parseEntry(text);
    if (e !== null) list.push(e);
  }
  return list;
}

/**
 * May a window of the app with this `address` and these extra `entries` show `url`? (`allow.rs` `allows_url`.) The reason
 * says why, for the preview rows.
 */
export function decide(address: string, url: string, entries: readonly string[]): Decision {
  const list = allowList(address, entries);
  if (list === null) return { open: false, reason: "bad_address" };
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { open: false, reason: "bad_address" };
  }
  if (target.protocol !== "https:") return { open: false, reason: "not_https" };
  if (target.username !== "" || target.password !== "") return { open: false, reason: "login" };
  const host = cleanHost(target.hostname);
  if (host === "") return { open: false, reason: "bad_address" };
  const port = target.port === "" ? null : Number(target.port);
  const ip = isIpHost(host);
  const hostMatches = (e: Entry): boolean => (ip || e.isIp ? ip && e.isIp && e.host === host : host === e.host || host.endsWith(`.${e.host}`));
  let portOnly = false;
  for (let i = 0; i < list.length; i++) {
    const e = list[i]!;
    if (!hostMatches(e)) continue;
    if (e.port === port) return { open: true, reason: i === 0 && host === e.host ? "own_host" : "entry" };
    portOnly = true;
  }
  return { open: false, reason: portOnly ? "port" : "not_listed" };
}

/** `decide(...).open`. */
export function allows(address: string, url: string, entries: readonly string[]): boolean {
  return decide(address, url, entries).open;
}

/** True when `entry` would be allowed without being in the list (the chosen level or the host already covers it): the picker shows it muted. */
export function alreadyIncluded(address: string, entries: readonly string[], entry: string): boolean {
  const e = plain(entry);
  const others = entries.filter((x) => plain(x) !== e);
  return decide(address, `https://${e}/`, others).open;
}

export type SampleKind = "start" | "page" | "sub" | "sibling" | "parent" | "extra" | "other" | "http";
export interface Sample {
  /** The address shown, e.g. `https://login.shop.example.com/`. */
  address: string;
  open: boolean;
  kind: SampleKind;
  reason: DecisionReason;
}

/**
 * At most `MAX_SAMPLES` example addresses for the "What employees can open" preview, each with the answer of `decide`:
 * the start page, another page, a sub-address, a sibling and the bare registrable domain (when the host is deeper), up to
 * three other sites from the list, another website and the `http://` form. When there are more, the page, the bare domain
 * and the last extras are dropped first. Empty when the address is not usable.
 */
export function samples(url: string, entries: readonly string[]): Sample[] {
  const own = parseAddress(url);
  if (own === null) return [];
  const origin = (host: string): string => `https://${host}${own.port !== null ? `:${own.port}` : ""}`;
  const candidates: { address: string; kind: SampleKind; priority: number }[] = [];
  const add = (address: string, kind: SampleKind, priority: number): void => {
    if (!candidates.some((c) => c.address === address)) candidates.push({ address, kind, priority });
  };
  add(`${origin(own.host)}${own.path}`, "start", 0);
  add(`${origin(own.host)}${own.path === "/any-page" ? "/other-page" : "/any-page"}`, "page", 5);
  if (!own.isIp) {
    add(`${origin(`login.${own.host}`)}/`, "sub", 2);
    const registrable = registrableDomain(own.host);
    if (registrable !== null) {
      const first = own.host.split(".")[0];
      const sibling = ["mail", "shop", "www"].find((label) => label !== first);
      if (own.host !== registrable) {
        if (sibling !== undefined) add(`${origin(`${sibling}.${registrable}`)}/`, "sibling", 3);
        add(`${origin(registrable)}/`, "parent", 6);
      }
    }
  }
  let extras = 0;
  for (const text of entries) {
    const e = parseEntry(text);
    if (e === null || extras >= 3) continue;
    const address = `https://${e.host}${e.port !== null ? `:${e.port}` : ""}/`;
    // An entry the app's own host already covers says nothing new.
    if (decide(url, address, []).open) continue;
    if (candidates.some((c) => c.address === address)) continue;
    extras += 1;
    add(address, "extra", 4);
  }
  add(own.host === "www.wikipedia.org" || own.host.endsWith(".wikipedia.org") ? "https://www.google.com/" : "https://www.wikipedia.org/", "other", 1);
  add(`http://${own.host}${own.port !== null ? `:${own.port}` : ""}${own.path}`, "http", 1);
  const keep = candidates
    .map((c, order) => ({ ...c, order }))
    .sort((a, b) => a.priority - b.priority || a.order - b.order)
    .slice(0, MAX_SAMPLES)
    .sort((a, b) => a.order - b.order);
  return keep.map((c) => {
    const d = decide(url, c.address, entries);
    return { address: c.address, open: d.open, kind: c.kind, reason: d.reason };
  });
}
