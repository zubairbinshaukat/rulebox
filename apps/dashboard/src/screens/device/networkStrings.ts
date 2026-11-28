import type { InstallState, NetworkItemState } from "../../data/types";

/**
 * The words of the Network tab. A placeholder list for now (UI pass step 10 builds the real tab on `fleet:network`): it names each
 * item and its state and says nothing about the detail codes yet (`detail` is a fixed agent code, never shown raw).
 */
export const networkStrings = {
  title: "Network and printers",
  wifi: "Wi-Fi networks",
  printers: "Printers",
  drivers: "Drivers",
  defaultPrinter: "Default",
  noneWifi: "No Wi-Fi networks for this group.",
  nonePrinters: "No printers for this group.",
  noneDrivers: "No drivers for this group.",
  noGroup: "Put this PC in a group to give it Wi-Fi networks and printers.",
  notReported: "This PC has not sent this yet.",
  setUpOn: "Set up for this PC's group on the Networks page.",
  state: {
    working: "Working",
    failed: "Failed",
    waiting: "Waiting",
    notSupported: "Not supported",
  } satisfies Record<NetworkItemState, string>,
  driverState: (state: InstallState): NetworkItemState =>
    state === "installed" ? "working" : state === "failed" ? "failed" : state === "unsupported" ? "notSupported" : "waiting",
};
