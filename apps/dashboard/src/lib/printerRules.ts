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
/** One save touches at most this many groups, like Wi-Fi (`MAX_NETWORK_SNAPSHOT_GROUPS` on the server). */
export const MAX_PRINTER_GROUPS_PER_SAVE = 10;
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

/** The driver names the picker offers: the inbox list, then the names the organization approved (no duplicates). */
export function driverChoices(approved: readonly string[]): string[] {
  const out = [...INBOX_DRIVERS];
  for (const name of approved) if (!out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
  return out;
}
