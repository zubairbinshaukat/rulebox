/**
 * Networks: the page's sentences and the ones every form shares (groups, counts, errors). The Wi-Fi, printer and driver forms have a file
 * each (`wifiStrings.ts`, `printerStrings.ts`, `driverStrings.ts`), so a screen only loads the words it shows. Plain words: the people using
 * this run a shop, not a data centre; the longer explanations are (i) tips.
 */
import type { DriverClass, PrinterKind, WifiSecurity } from "../../data/types";
import { formatNumber, plural } from "../../lib/format";
import { MAX_PRINTERS } from "../../lib/printerRules";
import { MAX_WIFI_PROFILES } from "../../lib/wifiRules";
import type { AddedProblem } from "../../lib/driverRules";
import { MAX_ADDED_NAME, MAX_ADDED_NAMES, MAX_DRIVERS } from "../../lib/driverRules";

export const networksStrings = {
  // ---- the page
  title: "Networks",
  lead: "Wi-Fi, printers and drivers your PCs set up by themselves.",
  addWifi: "Add Wi-Fi network",
  add: "Add",
  addWifiShort: "Add a Wi-Fi network",
  addPrinterShort: "Add a printer",
  addDriverShort: "Add a driver",
  readOnly: "You can view the networks. Changes need an Admin or Owner.",
  loadingList: "Loading networks",
  wifiSection: "Wi-Fi",
  printersSection: "Printers",
  driversSection: "Drivers",
  wifiInfo: "PCs join these networks on their own, before anyone signs in.",
  printersInfo: "PCs add these printers by themselves. They appear in every Print window.",
  driversInfo: "Most setups don't need this. Use it when a printer or scanner needs its maker's driver.",
  aboutSection: (name: string) => `About ${name}`,
  count: (n: number) => formatNumber(n),

  // ---- cards
  passwordSet: "Password set",
  needsPassword: "Needs password",
  openNetwork: "Open",
  defaultPill: "Default",
  hidden: "Hidden",
  notOnPcs: "Not on any PCs yet",
  moreChip: (count: number) => `+${formatNumber(count)}`,
  securityShort: { wpa2Wpa3Personal: "WPA2/WPA3", wpa2Personal: "WPA2", wpa3Personal: "WPA3", open: "Open" } satisfies Record<WifiSecurity, string>,
  printerKindCard: { ipp: "Network printer", raw: "Network printer", lpr: "Network printer", share: "Shared printer" } satisfies Record<PrinterKind, string>,
  driverClassCard: { printer: "Printer driver", scanner: "Scanner driver", other: "Device driver" } satisfies Record<DriverClass, string>,
  emptyWifi: "No Wi-Fi networks yet.",
  emptyPrinters: "No printers yet.",
  emptyDrivers: "No drivers.",
  emptyDriversSub: "Most setups don't need one.",

  // ---- shared by the three forms
  back: "All networks",
  unsaved: "You have unsaved changes.",
  advanced: "Advanced",
  whichPcs: "Which PCs get it?",
  whichPcsInfo: "The PCs in these groups get it with their next settings update, usually within a minute.",
  groupsServerRefused: "One of the groups no longer exists. Reload the page.",
  noGroupsExist: "There are no groups yet. Create a group first.",
  groupsOver: (limit: number) => `Pick at most ${formatNumber(limit)} ${plural(limit, { one: "group", other: "groups" })}.`,
  groupsRead: "Groups",
  moreGroups: (count: number) => `+${formatNumber(count)} more`,
  noGroups: "Not on any PCs yet",
  nameProblem: (max: number) => `Use 1 to ${formatNumber(max)} characters without line breaks.`,

  // ---- apply counts (detail screens only)
  countsTitle: "On the PCs",
  countsSub: "How the PCs of the assigned groups report it. Counted when you open this page.",
  countsNone: "No PC has reported it yet.",
  countsCapped: (sampled: number) => `Based on the first ${formatNumber(sampled)} PCs of each group.`,
  countsSampled: (sampled: number) => `${formatNumber(sampled)} ${plural(sampled, { one: "PC", other: "PCs" })} counted.`,

  // ---- Printer driver names (inside the Drivers section's Advanced)
  approvedTitle: "Printer driver names",
  approvedLead: "The printer form offers these. The Windows drivers are always there. Add the name of any other driver that is already on your PCs.",
  approvedBuiltIn: "Built into Windows",
  approvedAdded: "Names you added",
  approvedNone: "You have not added any names.",
  approvedField: "Add a driver name",
  approvedFieldHint: `Exactly as Windows shows it. At most ${MAX_ADDED_NAMES} names, ${MAX_ADDED_NAME} characters each.`,
  approvedAdd: "Add name",
  approvedRemove: (name: string) => `Remove ${name}`,
  approvedSave: "Save names",
  approvedSaved: "Approved drivers saved.",
  approvedProblems: {
    empty: "Enter a name.",
    length: `A name is at most ${MAX_ADDED_NAME} characters.`,
    characters: "Remove line breaks and special control characters.",
    count: `At most ${MAX_ADDED_NAMES} names.`,
  } satisfies Record<AddedProblem, string>,
  approvedDuplicate: "That name is already in the list.",
  approvedBuiltInName: "That is a built-in Windows driver and is always approved.",
  approvedLimit: `You can add at most ${MAX_ADDED_NAMES} names.`,
  driverDeliveredLine: (names: string) => `Delivered by Rulebox: ${names}`,

  /** `too_large` (detail "printers" / "drivers" / "names" / "wifi") and a few other codes of the Wi-Fi, printer and driver calls, as sentences; null = the usual one. */
  describeError: (code: string, detail: string | undefined): string | null => {
    if (code === "too_large" && detail === "printers") return `You can have at most ${formatNumber(MAX_PRINTERS)} printers. Remove one first.`;
    if (code === "too_large" && detail === "drivers") return `You can have at most ${formatNumber(MAX_DRIVERS)} drivers. Remove one first.`;
    if (code === "too_large" && detail === "names") return `You can add at most ${formatNumber(MAX_ADDED_NAMES)} driver names.`;
    if (code === "too_large" && detail === "wifi") return `You can have at most ${formatNumber(MAX_WIFI_PROFILES)} Wi-Fi networks. Remove one first.`;
    if (code === "not_ready" && detail === "sealing_key") {
      return "The organization's encryption key isn't set up yet, so a password can't be stored. An Owner can finish the key setup in Settings, Signing.";
    }
    return null;
  },
};
