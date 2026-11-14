import type { WifiDetail } from "../../data/types";

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
