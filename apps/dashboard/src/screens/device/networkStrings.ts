import type { InstallState, NetworkItemState } from "../../data/types";
import { installStrings } from "../../lib/screenStrings/install";

/**
 * The words of the Network tab (UI pass 2026-11, `docs/plans/ui-pass/device-detail.md` section 7): the Wi-Fi networks, printers and
 * drivers of this PC's group and how each one went on THIS PC. `detail` is a fixed agent code, never shown raw: each code has a
 * sentence here, an unknown one gets the generic sentence of its kind and the code itself goes under "Technical details".
 */
export const networkStrings = {
  title: "Network and printers",
  lead: "What this PC's group gives it, and how each one went on this PC.",
  wifi: "Wi-Fi networks",
  printers: "Printers",
  drivers: "Drivers",
  setUpOn: "Set up for this PC's group on the Networks page.",
  defaultPrinter: "Default",
  noGroup: "Put this PC in a group to give it Wi-Fi networks and printers.",
  noGroupAction: "Choose a group",
  notReported: "This PC has not sent this yet.",
  lastReport: "This PC last reported",
  none: { wifi: "No Wi-Fi networks for this group", printers: "No printers for this group", drivers: "No drivers for this group" },
  addOne: "Add one",
  openNetworks: "Open Networks",
  waitingLine: "Waiting for this PC to report it.",
  failedGeneric: { wifi: "The PC could not set this network up.", printers: "The PC could not set this printer up.", drivers: "The driver could not be installed." },
  unsupportedGeneric: "This PC cannot use it.",
  state: {
    working: "Working",
    failed: "Failed",
    waiting: "Waiting",
    notSupported: "Not supported",
  } satisfies Record<NetworkItemState, string>,
  summary: {
    allWorking: "All working",
    failed: (count: number) => `${count} failed`,
    waiting: (count: number) => `${count} waiting`,
    notSupported: (count: number) => `${count} not supported`,
  },
  techCode: "Reason code",
  driverState: (state: InstallState): NetworkItemState =>
    state === "installed" ? "working" : state === "failed" ? "failed" : state === "unsupported" ? "notSupported" : "waiting",
  /** A Wi-Fi network's result codes (`apps/agent/src/network/wifi.rs`). */
  wifiDetails: {
    connect_failed: "The network was added to this PC, but it could not connect. Check the password and the signal.",
    passphrase_invalid: "The password does not fit this kind of network.",
    profile_rejected: "Windows did not accept this network's settings.",
    ssid_unsupported: "Windows cannot use this network name.",
    wlan_unreadable: "Rulebox could not read this PC's Wi-Fi.",
    waiting_for_key: "Waiting for the PC to finish setting itself up.",
    seal_key_unreadable: "The PC could not read the saved password. Save the network again.",
    seal_unopenable: "The PC could not read the saved password. Save the network again.",
    restore_failed: "Rulebox could not put this PC's earlier Wi-Fi settings back. Check the Wi-Fi of this PC.",
    filters_not_restored: "Rulebox could not put this PC's earlier Wi-Fi settings back. Check the Wi-Fi of this PC.",
    not_enrolled: "This PC is not fully set up yet.",
    bad_profile_id: "This network has a name this PC cannot use.",
    section_unknown_value: "Rulebox on this PC is too old for this setting. Update it.",
  } as Record<string, string>,
  /** Where the driver's words differ from the app installs' (plain language for a driver the administrator added). */
  driverDetails: {
    hash_mismatch: "The downloaded driver was not the file you added, so it was not installed.",
    download_failed: "The driver could not be downloaded.",
    exit_code: "The driver installer reported an error.",
  } as Record<string, string>,
  /** A printer's result codes (`apps/agent/src/network/printers.rs`). */
  printerDetails: {
    address_invalid: "The printer's address is not valid.",
    driver_missing: "The printer's driver is not on this PC yet.",
    name_invalid: "Windows did not accept the printer's name.",
    name_taken: "A printer with this name already exists on the PC.",
    port_exists: "The printer's connection on this PC is already in use.",
    port_failed: "The PC could not open the printer's connection.",
    port_invalid: "The printer's connection settings are not valid.",
    port_missing: "The printer's connection is missing on this PC.",
    queue_invalid: "Windows could not set this printer up.",
    queue_required: "Windows could not set this printer up.",
    printer_failed: "Windows could not set this printer up.",
    printers_unreadable: "Rulebox could not read this PC's printers.",
    share_failed: "The PC could not connect to the shared printer.",
    default_not_set: "The printer was added, but it could not be made the default.",
    security_unsupported: "This PC cannot use this printer's security settings.",
    bad_printer_id: "This printer has a name this PC cannot use.",
    not_enrolled: "This PC is not fully set up yet.",
    section_unknown_value: "Rulebox on this PC is too old for this setting. Update it.",
    protected_print_on: installStrings.details.protected_print_on!,
  } as Record<string, string>,
};

export type NetworkKind = "wifi" | "printers" | "drivers";

/** The sentence for one item's detail code, by kind. Drivers share the install results' sentences. */
export function networkDetailText(kind: NetworkKind, detail: string | null, state: NetworkItemState): string | null {
  const s = networkStrings;
  if (detail !== null) {
    const known = kind === "wifi" ? s.wifiDetails[detail] : kind === "printers" ? s.printerDetails[detail] : (s.driverDetails[detail] ?? installStrings.details[detail]);
    if (known) return known;
  }
  if (state === "failed") return s.failedGeneric[kind];
  if (state === "notSupported") return s.unsupportedGeneric;
  return null;
}
