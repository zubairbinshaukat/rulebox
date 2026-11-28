/**
 * The printer rules the server enforces (`networks:savePrinter`, `convex/lib/printerAddress.ts`; plan 4.15), mirrored here for
 * inline messages and for the demo backend. Pure: no sentences (the screen maps a problem to its text), so the demo layer can
 * import it without pulling a screen's strings along. Keep the vectors of `printerRules.test.ts` in step with the server's
 * `convex/printerAddress.test.ts`.
 */
import type { PrinterKind } from "../data/types";

export const PRINTER_KINDS: readonly PrinterKind[] = ["ipp", "raw", "lpr", "share"];
/** Printers per organization (`MAX_ORG_PRINTERS` on the server). */
export const MAX_PRINTERS = 100;
/** The display name; the queue on the PC is `<name> (Rulebox)`. */
export const MAX_PRINTER_NAME = 60;
export const MAX_PRINTER_ADDRESS = 255;
/** Windows' Standard TCP/IP port keeps the host in 48 characters and the LPR queue in 32 (raw and LPR printers only). */
export const MAX_TCP_HOST = 48;
export const MAX_LPR_QUEUE = 32;
export const MAX_PRINTER_DRIVER = 100;
/** A printer or a driver can be in at most this many groups, like a Wi-Fi network (`MAX_NETWORK_GROUPS` on the server). */
export const MAX_PRINTER_GROUPS = 100;
/** The class drivers Windows ships; the default list of the picker (`INBOX_PRINTER_DRIVERS` on the server). */
export const INBOX_DRIVERS: readonly string[] = [
  "Microsoft IPP Class Driver",
  "Microsoft PCL6 Class Driver",
  "Microsoft PS Class Driver",
  "Generic / Text Only",
];

function hasControl(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) return true;
  }
  return false;
}

const hasControlOrSpace = (text: string): boolean => /\s/.test(text) || hasControl(text);

export type NameProblem = "empty" | "length" | "characters";

/** The display name: 1 to 60 characters, no control characters and no `\`, `,` or `/` (Windows queue-name rules). */
export function printerNameProblem(name: string): NameProblem | null {
  const n = name.trim();
  if (n.length === 0) return "empty";
  if (n.length > MAX_PRINTER_NAME) return "length";
  if (hasControl(n) || /[\\,/]/.test(n)) return "characters";
  return null;
}

function isIpv4(text: string): boolean {
  const parts = text.split(".");
  return parts.length === 4 && parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

function isIpv6(text: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(text) || !text.includes(":")) return false;
  const halves = text.split("::");
  if (halves.length > 2) return false;
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

/** An IP literal or a DNS name of at most 253 characters (no port, no brackets). */
export function isHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (isIpv4(host) || isIpv6(host)) return true;
  const labels = host.split(".");
  if (!labels.every((l) => /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l))) return false;
  return !/^\d+$/.test(labels[labels.length - 1] ?? "");
}

export type AddressProblem = "empty" | "length" | "scheme" | "credentials" | "host" | "port" | "path" | "share" | "characters";

function ippProblem(address: string): AddressProblem | null {
  const m = /^(ipp|https):\/\/([^/?#]*)(\/[^?#]*)?$/i.exec(address);
  if (m === null) return "scheme";
  const authority = m[2] ?? "";
  if (authority.includes("@")) return "credentials";
  let host = authority;
  let port: string | undefined;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end < 0) return "host";
    host = authority.slice(1, end);
    const rest = authority.slice(end + 1);
    if (rest !== "") {
      if (!rest.startsWith(":")) return "host";
      port = rest.slice(1);
    }
    if (!isIpv6(host)) return "host";
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon >= 0) {
      host = authority.slice(0, colon);
      port = authority.slice(colon + 1);
    }
    if (!isHost(host) || host.includes(":")) return "host";
  }
  if (port !== undefined && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return "port";
  const path = m[3];
  if (path === undefined || path === "/") return "path";
  return hasControlOrSpace(path) ? "characters" : null;
}

function shareProblem(address: string): AddressProblem | null {
  const m = /^\\\\([^\\]+)\\([^\\]+)$/.exec(address);
  if (m === null) return "share";
  if (!isHost(m[1] ?? "")) return "host";
  const queue = m[2] ?? "";
  if (queue.trim() === "" || [...queue].some((ch) => ch === "," || ch === "/" || (ch.codePointAt(0) ?? 0) < 0x20 || ch === "\u007f")) return "characters";
  return null;
}

/** What is wrong with the address of a printer of this kind, or `null`. Leading and trailing spaces are ignored. */
export function addressProblem(kind: PrinterKind, rawAddress: string): AddressProblem | null {
  const address = rawAddress.trim();
  if (address === "") return "empty";
  if (address.length > MAX_PRINTER_ADDRESS) return "length";
  if (kind === "ipp") return ippProblem(address);
  if (kind === "share") return shareProblem(address);
  if (!isHost(address)) return "host";
  return address.length > MAX_TCP_HOST ? "length" : null;
}

export type PortProblem = "range";

/** Raw only: a whole number from 1 to 65535. An empty field means the default (9100) and is fine. */
export function portProblem(text: string): PortProblem | null {
  const t = text.trim();
  if (t === "") return null;
  return /^\d{1,5}$/.test(t) && Number(t) >= 1 && Number(t) <= 65535 ? null : "range";
}

export type QueueProblem = "required" | "length" | "characters";

/** LPR only: the queue name the printer's LPD expects. */
export function queueProblem(text: string): QueueProblem | null {
  const t = text.trim();
  if (t === "") return "required";
  if (t.length > MAX_LPR_QUEUE) return "length";
  return hasControlOrSpace(t) ? "characters" : null;
}

// ---------------------------------------------------------------- one address field (UI pass, enrollment plan 4.4)

/** What one typed address means: the kind, the address in the shape the server stores, and the port / queue it implies. */
export interface ParsedPrinterAddress {
  kind: PrinterKind;
  address: string;
  /** Raw printers only; absent = 9100. */
  port?: number;
  /** LPR printers only. */
  queue?: string;
}

/** The default IPP path most printers answer on. */
const IPP_DEFAULT_PATH = "/ipp/print";
/** IPP's own port: `host:631` means IPP, any other port after a bare host means a raw (JetDirect) socket. */
const IPP_PORT = 631;

function ippHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** `host`, `[v6]` or `host:port` (digits only, 1-65535). Null when it is none of them. */
function splitHostPort(text: string): { host: string; port?: number } | null {
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end < 0) return null;
    const host = text.slice(1, end);
    const rest = text.slice(end + 1);
    if (!isIpv6(host)) return null;
    if (rest === "") return { host };
    return /^:\d{1,5}$/.test(rest) && portProblem(rest.slice(1)) === null ? { host, port: Number(rest.slice(1)) } : null;
  }
  if (isHost(text)) return { host: text };
  const colon = text.lastIndexOf(":");
  if (colon <= 0) return null;
  const host = text.slice(0, colon);
  const port = text.slice(colon + 1);
  if (host.includes(":") || !isHost(host) || !/^\d{1,5}$/.test(port) || portProblem(port) !== null) return null;
  return { host, port: Number(port) };
}

/**
 * Reads what an admin typed into the ONE address field and says which kind of printer it is (null = nothing the server would accept
 * as a printer; the form then asks again in plain words). Only the shape is judged: the result still goes through `addressProblem`
 * (a raw host longer than 48 characters, for instance, is parsed as raw and refused there). Spaces around the text are ignored.
 *
 * - `\\server\printer` -> a shared printer.
 * - `ipp://h[:p]/path`, `https://h[:p]/path` -> IPP as typed (no path typed: `/ipp/print`); `ipps://` is the same as `https://`;
 *   `http://h:631/path` -> `ipp://h:631/path` (a plain http address without a port is port 80: `ipp://h:80/path`).
 * - `lpr://h/queue` (or `lpd://`) -> LPR with its queue.
 * - `h:631` -> IPP on that port; `h:<any other port>` -> raw on that port; `[v6]:port` the same.
 * - `h/path` (no scheme) -> IPP; a bare host or IP (IPv6 too) -> IPP with the usual path `/ipp/print`.
 */
export function parsePrinterAddress(text: string): ParsedPrinterAddress | null {
  const t = text.trim();
  if (t === "" || t.length > MAX_PRINTER_ADDRESS) return null;

  if (t.startsWith("\\\\")) return addressProblem("share", t) === null ? { kind: "share", address: t } : null;

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(t);
  if (scheme !== null) {
    const name = (scheme[1] ?? "").toLowerCase();
    const rest = scheme[2] ?? "";
    if (name === "ipp" || name === "https" || name === "ipps" || name === "http") {
      const slash = rest.search(/[/?#]/);
      const authority = slash < 0 ? rest : rest.slice(0, slash);
      const typedTail = slash < 0 ? "" : rest.slice(slash);
      // No path typed: the one printers answer on.
      const tail = typedTail === "" || typedTail === "/" ? IPP_DEFAULT_PATH : typedTail;
      const hp = splitHostPort(authority);
      if (hp === null) return null;
      let address: string;
      if (name === "http") address = `ipp://${ippHost(hp.host)}:${hp.port ?? 80}${tail}`;
      else address = `${name === "ipps" ? "https" : name}://${authority}${tail}`;
      return addressProblem("ipp", address) === null ? { kind: "ipp", address } : null;
    }
    if (name === "lpr" || name === "lpd") {
      const slash = rest.indexOf("/");
      if (slash < 0) return null;
      const host = rest.slice(0, slash);
      const queue = rest.slice(slash + 1);
      if (!isHost(host.startsWith("[") ? host.slice(1, -1) : host) || queueProblem(queue) !== null) return null;
      return { kind: "lpr", address: host.startsWith("[") ? host.slice(1, -1) : host, queue: queue.trim() };
    }
    return null;
  }

  // No scheme: `host/path` is an IPP address without the scheme.
  const slash = t.indexOf("/");
  if (slash > 0) {
    const hp = splitHostPort(t.slice(0, slash));
    if (hp === null) return null;
    const address = `ipp://${ippHost(hp.host)}${hp.port === undefined ? "" : `:${hp.port}`}${t.slice(slash)}`;
    return addressProblem("ipp", address) === null ? { kind: "ipp", address } : null;
  }

  const hp = splitHostPort(t);
  if (hp === null) return null;
  if (hp.port === undefined) return { kind: "ipp", address: `ipp://${ippHost(hp.host)}${IPP_DEFAULT_PATH}` };
  if (hp.port === IPP_PORT) return { kind: "ipp", address: `ipp://${ippHost(hp.host)}:${IPP_PORT}${IPP_DEFAULT_PATH}` };
  return { kind: "raw", address: hp.host, port: hp.port };
}

/**
 * The driver "Automatic" stands for: Windows' IPP class driver for IPP printers, the PCL6 class driver for raw, LPR and shared ones
 * (both ship with Windows, so nothing has to be delivered). Always a name of `INBOX_DRIVERS`.
 */
export function defaultDriverFor(kind: PrinterKind): string {
  return kind === "ipp" ? "Microsoft IPP Class Driver" : "Microsoft PCL6 Class Driver";
}

/** The driver names the picker offers: the inbox list, then the names the organization approved (no duplicates). */
export function driverChoices(approved: readonly string[]): string[] {
  const out = [...INBOX_DRIVERS];
  for (const name of approved) if (!out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
  return out;
}
