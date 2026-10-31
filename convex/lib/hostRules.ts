// Which web addresses the dashboard may store and the server may fetch (plan
// Step 10 item 3 and 5). PURE. The dashboard mirrors the checks in
// `lib/validate.ts` (`webUrl`, `domain`); the server is authoritative.
//
// Two different questions:
// - `webUrlProblem`: may this be a web app's address? (https, a real host name
//   or a public IPv4 address, no credentials)
// - `isForbiddenHost`: may the SERVER fetch it (web metadata)? Same host rules.
//   A host NAME that resolves to a private address cannot be seen from here
//   (Convex gives actions no DNS), so the fetch also refuses every redirect
//   that leaves https or lands on a forbidden host, and runs in Convex's
//   cloud, which has no route to a private network.

/** Dotted-quad octets, or null when `host` is not an IPv4 literal. WHATWG `URL` has already normalized `0x7f.1`, `2130706433` etc. */
function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return null;
  const o = [m[1]!, m[2]!, m[3]!, m[4]!].map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** Loopback, private, link-local, shared (CGNAT), documentation, multicast and reserved IPv4 ranges. */
function privateV4(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast (deprecated, reserved)
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** Names that are local by convention. */
function localName(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localdomain") ||
    host.endsWith(".home.arpa")
  );
}

/**
 * Well-known wildcard-DNS services: `10.0.0.1.nip.io` resolves to 10.0.0.1, so
 * a name under one of them can point at a private address. A name with a
 * different suffix can still do so (see the note on `isForbiddenHost`).
 */
const WILDCARD_DNS_SUFFIXES = ["nip.io", "sslip.io", "xip.io", "traefik.me", "localtest.me", "lvh.me", "vcap.me", "lacolhost.com"] as const;

function wildcardDnsName(host: string): boolean {
  return WILDCARD_DNS_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`)) || /(^|\.)localhost\.[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host);
}

/**
 * True for a host the server must never fetch and no web app may use: an IP
 * literal in a private, loopback, link-local, shared, multicast or reserved
 * range (any IPv6 literal is refused outright), `localhost` (also as the first
 * label of a longer name, `localhost.example`) and the local name suffixes,
 * well-known wildcard-DNS services, and names without a dot.
 *
 * LIMIT: this works on the NAME only. Convex gives an action no DNS API, so a
 * public-looking name that an attacker's DNS points at a private address
 * (including a rebinding answer that changes between our check and the
 * connection) cannot be detected here. In Convex's cloud that is harmless (no
 * route into a private network); if the backend is ever SELF-HOSTED, outbound
 * requests from actions MUST go through an egress proxy or firewall that blocks
 * private ranges, because no code in this file can close that gap.
 */
export function isForbiddenHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "" || host.startsWith("[")) return true;
  const o = ipv4Octets(host);
  if (o !== null) return privateV4(o);
  if (localName(host) || wildcardDnsName(host)) return true;
  return !host.includes(".");
}

/**
 * Null when `value` may be a web app's address, else a short fixed reason:
 * "format" (not a URL, too long, not https, credentials in it) or "host"
 * (localhost, a local name or a private address).
 */
export function webUrlProblem(value: string): "format" | "host" | null {
  const text = value.trim();
  if (text === "" || text.length > 2_048) return "format";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "format";
  }
  if (url.protocol !== "https:" || url.hostname === "") return "format";
  if (url.username !== "" || url.password !== "") return "format";
  return isForbiddenHost(url.hostname) ? "host" : null;
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** `example.com` or `*.example.com`: lower-case, no scheme, no path, one leading wildcard at most, at least two labels. */
export function domainProblem(value: string): boolean {
  const host = value.startsWith("*.") ? value.slice(2) : value;
  const parts = host.split(".");
  return value !== value.toLowerCase() || parts.length < 2 || !parts.every((p) => LABEL.test(p)) || host.length > 253;
}
