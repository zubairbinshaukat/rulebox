import type { DriverDetail, PrinterDetail, PrinterKind, WifiDetail } from "../../data/types";

/**
 * The host of a printer for a card ("Network printer · 10.0.0.20"): the host of an IPP address, the server of a shared name, else the
 * address itself. Never the port, the queue or the path (those are on the detail page).
 */
export function printerHost(kind: PrinterKind, address: string): string {
  if (kind === "ipp") {
    const m = /^(?:ipp|https):\/\/(\[[^\]]+\]|[^/:?#]+)/i.exec(address);
    return m?.[1] ?? address;
  }
  if (kind === "share") {
    const m = /^\\\\([^\\]+)/.exec(address);
    return m?.[1] ?? address;
  }
  return address;
}

/**
 * What the ONE address field of the printer form shows for a printer that is already saved, in a shape `parsePrinterAddress` reads back
 * to the same printer: a raw printer as `host:port` (9100 when none), an LPR printer as `lpr://host/queue`.
 */
export function printerAddressText(p: { kind: PrinterKind; address: string; port: number | null; queue: string | null }): string {
  const host = p.address.includes(":") && !p.address.startsWith("[") && p.kind !== "ipp" && p.kind !== "share" ? `[${p.address}]` : p.address;
  if (p.kind === "raw") return `${host}:${p.port ?? 9100}`;
  if (p.kind === "lpr") return `lpr://${host}/${p.queue ?? ""}`;
  return p.address;
}

/** The blank form of `/networks/printers/new` (nothing is subscribed): the usual modern printer, with the class driver Windows ships. */
export const BLANK_PRINTER: PrinterDetail = {
  _id: "new",
  name: "",
  kind: "ipp",
  address: "",
  port: null,
  queue: null,
  driver: "Microsoft IPP Class Driver",
  revision: 0,
  groupCount: 0,
  defaultGroupCount: 0,
  groups: [],
  groupIds: [],
  defaultForGroupIds: [],
  counts: { applied: 0, failed: 0, waiting: 0, unsupported: 0, sampled: 0, capped: false },
};

/** The blank form of `/networks/wifi/new` (nothing is subscribed): a secured network, as recommended. */
export const BLANK_WIFI: WifiDetail = {
  _id: "new",
  name: "",
  ssid: "",
  hidden: false,
  security: "wpa2Wpa3Personal",
  autoConnect: true,
  hasPassphrase: false,
  passphraseSetAt: null,
  revision: 0,
  groupCount: 0,
  groups: [],
  groupIds: [],
  counts: { applied: 0, failed: 0, waiting: 0, unsupported: 0, sampled: 0, capped: false },
};

/** True when `after` is the same set of groups as `before`. */
export function sameGroups(before: readonly string[], after: readonly string[]): boolean {
  return before.length === after.length && after.every((g) => before.includes(g));
}

/** The blank form of `/networks/drivers/new` (nothing is subscribed): a driver package for a printer. */
export const BLANK_DRIVER: DriverDetail = {
  _id: "new",
  name: "",
  kind: "inf",
  deviceClass: "printer",
  sizeBytes: 0,
  revision: 0,
  provides: [],
  groupCount: 0,
  groups: [],
  url: "",
  sha256: "",
  inf: null,
  silentArgs: [],
  successExitCodes: [],
  groupIds: [],
  counts: { installed: 0, failed: 0, pending: 0, removed: 0, unsupported: 0, restartNeeded: 0, sampled: 0, capped: false },
};