import { fail } from "./errors";
import { MAX_LPR_QUEUE, MAX_PRINTER_ADDRESS, MAX_TCP_PORT_HOST } from "./limits";

// Printer address rules (Phase 5 Step 14, plan 4.15). PURE. The agent checks the same rules again
// (`apps/agent/src/network/printers.rs`, `plan_of`), because a signed document is still data.
//
//   ipp    `ipp://host[:port]/path` or `https://host[:port]/path`; the port is part of the URL, `port` and `queue` stay empty
//   raw    a host (IP literal or DNS name); `port` 1-65535 or empty (= 9100); `queue` empty
//   lpr    a host; `queue` required; `port` empty (LPR is always 515)
//   share  `\\server\queue`; `port` and `queue` empty
//
// Host: an IP literal (IPv4, or IPv6 in brackets inside a URL) or a DNS name of at most 253 characters made of labels of
// 1-63 letters, digits and hyphens. No credentials in a URL. Raw and LPR hosts are at most 48 characters (the Standard
// TCP/IP port's own field).

export type PrinterKindName = "ipp" | "raw" | "lpr" | "share";
export type PrinterTarget = { address: string; port: number | null; queue: string | null };

const bad = (field: "address" | "port" | "queue", detail: string): never => fail("invalid_argument", { field, detail });

function hasControlOrSpace(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) return true;
  }
  return false;
}

export function isIpv4(text: string): boolean {
  const parts = text.split(".");
  return parts.length === 4 && parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

export function isIpv6(text: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(text) || !text.includes(":")) return false;
  const halves = text.split("::");
  if (halves.length > 2) return false;
  // 16-bit words in one side of the address; a trailing IPv4 part counts as two and is only legal at the very end.
  const words = (part: string, ipv4Allowed: boolean): number | null => {
    if (part === "") return 0;
    const groups = part.split(":");
    let n = 0;
    for (const [i, g] of groups.entries()) {
      if (g.includes(".")) {
        if (!ipv4Allowed || i !== groups.length - 1 || !isIpv4(g)) return null;
        n += 2;
      } else if (/^[0-9a-fA-F]{1,4}$/.test(g)) {
        n += 1;
      } else {
        return null;
      }
    }
    return n;
  };
  if (halves.length === 1) return words(text, true) === 8;
  const head = words(halves[0] ?? "", false);
  const tail = words(halves[1] ?? "", true);
  return head !== null && tail !== null && head + tail <= 7;
}

/** An IP literal or a DNS name (no port, no brackets). */
export function isHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (isIpv4(host) || isIpv6(host)) return true;
  const labels = host.split(".");
  if (!labels.every((l) => /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l))) return false;
  // `999.1.1.1` is not a name: a last label of digits only must have been an IPv4 address.
  return !/^\d+$/.test(labels[labels.length - 1] ?? "");
}

function checkPortNumber(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) return bad("port", "range");
  return value;
}

function checkIpp(address: string): string {
  const m = /^(ipp|https):\/\/([^/?#]*)(\/[^?#]*)?$/i.exec(address);
  if (m === null) return bad("address", "scheme");
  const scheme = (m[1] ?? "").toLowerCase();
  const authority = m[2] ?? "";
  if (authority.includes("@")) return bad("address", "credentials");
  let host = authority;
  let port: string | undefined;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end < 0) return bad("address", "host");
    host = authority.slice(1, end);
    const rest = authority.slice(end + 1);
    if (rest !== "") {
      if (!rest.startsWith(":")) return bad("address", "host");
      port = rest.slice(1);
    }
    if (!isIpv6(host)) return bad("address", "host");
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon >= 0) {
      host = authority.slice(0, colon);
      port = authority.slice(colon + 1);
    }
    if (!isHost(host) || host.includes(":")) return bad("address", "host");
  }
  if (port !== undefined) {
    if (!/^\d{1,5}$/.test(port)) return bad("address", "port");
    if (Number(port) < 1 || Number(port) > 65535) return bad("address", "port");
  }
  const path = m[3];
  if (path === undefined || path === "/") return bad("address", "path");
  if (hasControlOrSpace(path)) return bad("address", "characters");
  return `${scheme}://${authority}${path}`;
}

function checkShare(address: string): string {
  const m = /^\\\\([^\\]+)\\([^\\]+)$/.exec(address);
  if (m === null) return bad("address", "share");
  const server = m[1] ?? "";
  const queue = m[2] ?? "";
  if (!isHost(server)) return bad("address", "host");
  if (queue.trim() === "" || [...queue].some((ch) => ch === "," || ch === "/" || (ch.codePointAt(0) ?? 0) < 0x20 || ch === "\u007f")) {
    return bad("address", "characters");
  }
  return address;
}

/**
 * The checked address, port and queue of a printer, or `invalid_argument` with `field` (address | port | queue) and a
 * `detail` code (scheme, credentials, host, port, path, share, characters, length, range, required, not_used).
 */
export function checkPrinterTarget(kind: PrinterKindName, rawAddress: string, rawPort: number | undefined, rawQueue: string | undefined): PrinterTarget {
  const address = rawAddress.trim();
  if (address === "") return bad("address", "empty");
  if (address.length > MAX_PRINTER_ADDRESS) return bad("address", "length");
  const queue = rawQueue === undefined || rawQueue.trim() === "" ? null : rawQueue.trim();
  const port = rawPort === undefined ? null : rawPort;
  switch (kind) {
    case "ipp":
      if (port !== null) return bad("port", "not_used");
      if (queue !== null) return bad("queue", "not_used");
      return { address: checkIpp(address), port: null, queue: null };
    case "share":
      if (port !== null) return bad("port", "not_used");
      if (queue !== null) return bad("queue", "not_used");
      return { address: checkShare(address), port: null, queue: null };
    case "raw":
      if (queue !== null) return bad("queue", "not_used");
      if (!isHost(address)) return bad("address", "host");
      if (address.length > MAX_TCP_PORT_HOST) return bad("address", "length");
      return { address, port: port === null ? null : checkPortNumber(port), queue: null };
    case "lpr": {
      if (port !== null) return bad("port", "not_used");
      if (!isHost(address)) return bad("address", "host");
      if (address.length > MAX_TCP_PORT_HOST) return bad("address", "length");
      if (queue === null) return bad("queue", "required");
      if (queue.length > MAX_LPR_QUEUE) return bad("queue", "length");
      if (hasControlOrSpace(queue)) return bad("queue", "characters");
      return { address, port: null, queue };
    }
  }
}
