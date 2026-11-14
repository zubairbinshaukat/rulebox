import type { DriverDetail, PrinterDetail, WifiDetail } from "../../data/types";

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

/**
 * The groups one save touches: the groups the network is in now plus the ones picked (the server makes a new configuration
 * for each of them in the same call, and refuses more than `MAX_WIFI_GROUPS_PER_SAVE`; a save that changes nothing touches none).
 */
export function touchedGroups(before: readonly string[], after: readonly string[]): number {
  return new Set([...before, ...after]).size;
}

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