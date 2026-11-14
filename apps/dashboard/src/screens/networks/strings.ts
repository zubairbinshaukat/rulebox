/**
 * Networks (Phase 5 Steps 13 and 14): Wi-Fi profiles and printers. A lazily loaded part of the dashboard's sentences (only the Networks
 * and Wi-Fi screens import it). Plain words: the people using this run a shop, not a data centre.
 */
import type { PassphraseProblem, SsidProblem } from "../../lib/wifiRules";
import { MAX_SSID_BYTES, MAX_WIFI_PROFILES } from "../../lib/wifiRules";
import type { AddressProblem, NameProblem, PortProblem, QueueProblem } from "../../lib/printerRules";
import { MAX_LPR_QUEUE, MAX_PRINTERS, MAX_PRINTER_NAME, MAX_TCP_HOST } from "../../lib/printerRules";
import { formatNumber, plural } from "../../lib/format";
import type { PrinterKind, WifiSecurity } from "../../data/types";

export const networksStrings = {
  title: "Networks",
  lead: "Wi-Fi networks your PCs join on their own, before anyone signs in.",
  wifiSection: "Wi-Fi",
  newWifi: "New Wi-Fi network",
  edit: "Edit",
  colName: "Name",
  colNetwork: "Network",
  colGroups: "Groups",
  colPassphrase: "Password",
  hidden: "Hidden",
  noGroups: "Not assigned to a group yet",
  moreGroups: (count: number) => `+${formatNumber(count)} more`,
  passphraseSet: "Password set",
  passphraseNone: "No password set",
  passphraseNotNeeded: "Open network, no password",
  setOn: (when: string) => `Password set ${when}`,
  emptyTitle: "No Wi-Fi networks yet",
  emptyBody: "Add one and give it to a group. Its PCs then join it by themselves, and nobody has to type the password.",
  readOnly: "You can view the networks. Changes need an Admin or Owner.",
  loadingList: "Loading networks",

  // ---- the form
  back: "All networks",
  newTitle: "New Wi-Fi network",
  name: "Name",
  nameHint: "Only for you, to tell networks apart. Employees never see it.",
  ssid: "Network name (SSID)",
  ssidHint: "Exactly as the router shows it, capital letters included.",
  ssidBytes: (used: number) => `${formatNumber(used)} of ${formatNumber(MAX_SSID_BYTES)} bytes`,
  ssidBytesOver: (used: number) => `${formatNumber(used)} of ${formatNumber(MAX_SSID_BYTES)} bytes: too long`,
  ssidProblems: {
    empty: "Enter the network name.",
    tooLong: `A network name is at most ${MAX_SSID_BYTES} bytes. Letters with accents and non-Latin letters take 2 to 4 bytes each.`,
    control: "Remove line breaks and special control characters.",
  } satisfies Record<SsidProblem, string>,
  nameProblem: (max: number) => `Use 1 to ${formatNumber(max)} characters without line breaks.`,
  ssidServerRefused: `The network name isn't valid: use 1 to ${MAX_SSID_BYTES} bytes without control characters.`,
  security: "Security",
  securityNames: {
    wpa2Wpa3Personal: "WPA2/WPA3 (transition mode), recommended",
    wpa2Personal: "WPA2 Personal",
    wpa3Personal: "WPA3 Personal",
    open: "Open (no password)",
  } satisfies Record<WifiSecurity, string>,
  securityShort: {
    wpa2Wpa3Personal: "WPA2/WPA3",
    wpa2Personal: "WPA2",
    wpa3Personal: "WPA3",
    open: "Open",
  } satisfies Record<WifiSecurity, string>,
  securityHelp: {
    wpa2Wpa3Personal: "WPA2/WPA3 (transition mode) is the recommended choice; older adapters may refuse WPA3 only.",
    wpa2Personal: "Works on almost every adapter and router.",
    wpa3Personal: "Newer and stronger, but older adapters may refuse it. A PC that can't use it reports that it failed.",
    open: "Anyone in range can join and the traffic is not encrypted. Use it only for a network you trust some other way.",
  } satisfies Record<WifiSecurity, string>,
  hiddenLabel: "Hidden network",
  hiddenHint: "The router does not announce its name. The PCs look for it by name instead.",
  autoConnect: "Join automatically",
  autoConnectHint: "Off: the PC knows the network but someone has to pick it.",
  groups: "Groups",
  groupsHint: "The PCs in these groups get this network. Changes reach them with the group's next configuration.",
  groupsServerRefused: "One of the groups no longer exists. Reload the page.",
  noGroupsExist: "There are no groups yet. Create a group first.",
  groupsOver: (limit: number) =>
    `One save can touch at most ${formatNumber(limit)} ${plural(limit, { one: "group", other: "groups" })}: the groups the network is in now plus the ones you pick. Pick fewer.`,
  groupsTouched: (count: number, limit: number) => `${formatNumber(count)} of ${formatNumber(limit)} groups touched by this save`,
  noPassphraseInForm: "The password is set separately, in the Password card.",
  create: "Add network",
  saved: "Network saved.",
  created: (name: string) => `${name} added. Now set its password.`,
  createdOpen: (name: string) => `${name} added.`,
  deleted: (name: string) => `${name} removed.`,
  unsaved: "You have unsaved changes.",

  // ---- the password card and dialog
  passphraseCard: "Password",
  passphraseCardSub: "Stored encrypted. Rulebox can't show it again; it can only be replaced.",
  passphraseSetOn: (when: string) => `Set on ${when}.`,
  passphraseNotSet: "Not set yet. PCs wait for it and join the network once it is set.",
  passphraseOpen: "An open network has no password.",
  setPassphrase: "Set password",
  replacePassphrase: "Replace password",
  passphraseTitleSet: "Set the Wi-Fi password",
  passphraseTitleReplace: "Replace the Wi-Fi password",
  passphraseLead: "Type the network's password. It is encrypted before it is stored and sent to each PC only in a form that PC alone can read.",
  passphraseField: "Wi-Fi password",
  passphraseHint: "8 to 63 characters, or exactly 64 hexadecimal digits.",
  passphraseProblems: {
    empty: "Enter the password.",
    length: "Use 8 to 63 characters, or exactly 64 hexadecimal digits.",
    chars: "Use plain letters, digits, spaces and the usual punctuation: no accents or special characters.",
  } satisfies Record<PassphraseProblem, string>,
  passphraseSaved: "Password saved. It reaches the PCs with the group's next configuration.",
  passphraseServerRefused: "The password isn't valid: use 8 to 63 plain characters, or 64 hexadecimal digits.",

  // ---- delete
  deleteTitle: (name: string) => `Remove ${name}?`,
  deleteBody:
    "The network is taken away from every group. The PCs that have it remove it, and they won't join it by themselves any more. This can't be undone.",
  remove: "Remove network",

  // ---- apply counts (detail screen only)
  countsTitle: "On the PCs",
  countsSub: "How the PCs of the assigned groups report this network. Counted when you open this page.",
  countsNone: "No PC has reported this network yet.",
  countsNew: "Counts appear once the network is saved and given to a group.",
  applied: "Joined or ready",
  waiting: "Waiting for the password",
  failed: "Failed",
  unsupported: "No Wi-Fi adapter",
  countsCapped: (sampled: number) => `Based on the first ${formatNumber(sampled)} PCs of each group.`,
  countsSampled: (sampled: number) => `${formatNumber(sampled)} ${plural(sampled, { one: "PC", other: "PCs" })} counted.`,

  // ---- printers (Step 14)
  printersSection: "Printers",
  newPrinter: "New printer",
  printersLead: "Printers your PCs set up on their own. Only the drivers already on the PC are used: Rulebox never installs a driver.",
  emptyPrintersTitle: "No printers yet",
  emptyPrintersBody: "Add a printer and give it to a group. Its PCs then set it up by themselves, and the printer shows up in every program's Print window.",
  kindNames: {
    ipp: "Network printer (IPP)",
    raw: "Raw TCP/IP (port 9100)",
    lpr: "LPR queue",
    share: "Shared by a server",
  } satisfies Record<PrinterKind, string>,
  kindShort: { ipp: "IPP", raw: "Raw TCP", lpr: "LPR", share: "Shared" } satisfies Record<PrinterKind, string>,
  kindHelp: {
    ipp: "The usual choice for a modern network printer. Works with the IPP class driver that comes with Windows.",
    raw: "Sends the print job straight to the printer's TCP port. Needs a driver that is already on the PC.",
    lpr: "For older printers and print servers that use the LPR protocol. Needs a queue name.",
    share: "A printer that a Windows server shares as \\\\server\\name. The PCs connect to it; Rulebox never takes a driver from the server.",
  } satisfies Record<PrinterKind, string>,
  defaultBadge: (count: number) => `Default in ${formatNumber(count)} ${plural(count, { one: "group", other: "groups" })}`,
  kindLabel: "How the printer is reached",
  printerCountsNone: "No PC has reported this printer yet.",
  driverLabel: "Driver",
  addressLabel: {
    ipp: "Printer address (URL)",
    raw: "Printer address",
    lpr: "Printer address",
    share: "Shared name",
  } satisfies Record<PrinterKind, string>,
  addressHint: {
    ipp: "For example ipp://10.0.0.20/ipp/print or https://printer.example/ipp/print. No user name or password in the address.",
    raw: `An IP address or a name, for example 10.0.0.20. At most ${MAX_TCP_HOST} characters.`,
    lpr: `An IP address or a name, for example 10.0.0.20. At most ${MAX_TCP_HOST} characters.`,
    share: "Written like \\\\print-server\\Front-desk.",
  } satisfies Record<PrinterKind, string>,
  addressProblems: {
    empty: "Enter the printer's address.",
    length: `That address is too long (raw and LPR printers: at most ${MAX_TCP_HOST} characters).`,
    scheme: "Start the address with ipp:// or https://.",
    credentials: "Remove the user name and password from the address.",
    host: "Use an IP address or a name made of letters, digits and hyphens. Leave the port out here.",
    port: "The port in the address must be a number from 1 to 65535.",
    path: "Add the path after the host, usually /ipp/print.",
    share: "Write the shared name as \\\\server\\name.",
    characters: "Remove spaces, commas and special characters that a printer address cannot have.",
  } satisfies Record<AddressProblem, string>,
  port: "Port",
  portHint: "Leave empty for 9100, the port almost every printer listens on.",
  portProblems: { range: "Use a whole number from 1 to 65535, or leave it empty." } satisfies Record<PortProblem, string>,
  queue: "Queue name",
  queueHint: `The queue the printer's LPR service expects, at most ${MAX_LPR_QUEUE} characters.`,
  queueProblems: {
    required: "Enter the queue name.",
    length: `A queue name is at most ${MAX_LPR_QUEUE} characters.`,
    characters: "A queue name has no spaces or control characters.",
  } satisfies Record<QueueProblem, string>,
  printerNameHint: "Shown in the Print window on the PCs as the name followed by (Rulebox).",
  printerNameProblems: {
    empty: "Enter a name.",
    length: `Use at most ${MAX_PRINTER_NAME} characters.`,
    characters: "Leave out backslashes, commas, slashes and line breaks.",
  } satisfies Record<NameProblem, string>,
  driverHint: "The driver must already be on the PC: Rulebox never installs one and never takes one from a print server. A PC without it reports 'driver missing'.",
  driverNotListed: "Not on the approved list any more",
  printerGroupsHint: "The PCs in these groups get this printer. Changes reach them with the group's next configuration.",
  defaultsLegend: "Default printer",
  defaultsHint: "Tick the groups where this printer is the one that prints first. A group has one default printer.",
  defaultIn: (group: string) => `Default in ${group}`,
  noDefaultGroups: "Pick at least one group above to choose where it is the default.",
  createPrinter: "Add printer",
  printerSaved: "Printer saved.",
  printerCreated: (name: string) => `${name} added.`,
  printerDeleted: (name: string) => `${name} removed.`,
  printerDeleteTitle: (name: string) => `Remove ${name}?`,
  printerDeleteBody: "The printer is taken away from every group. The PCs remove the printer they set up for it. This can't be undone.",
  removePrinter: "Remove printer",
  printerCountsSub: "How the PCs of the assigned groups report this printer. Counted when you open this page.",
  printerApplied: "Set up",
  printerFailed: "Failed",
  printerLoading: "Loading printers",
  printerTitle: "Printer",
  printerNewTitle: "New printer",
  nameTaken: "Another printer already has this name.",
  defaultTaken: "Another printer is already the default for one of these groups. Turn that one off first.",
  driverRefused: "That driver is not on the approved list.",

  /** `too_large` (detail "groups" / "printers") and the plan limit of the Wi-Fi and printer calls, as sentences; null = the usual one. */
  describeError: (code: string, detail: string | undefined, limit = 0): string | null => {
    if (code === "too_large" && detail === "printers") return `You can have at most ${formatNumber(MAX_PRINTERS)} printers. Remove one first.`;
    if (code === "too_large" && detail === "groups") {
      return `One save can touch at most ${formatNumber(limit)} ${plural(limit, { one: "group", other: "groups" })}: the groups it is in now plus the ones you pick. Something in more groups than that can't be changed or removed here yet.`;
    }
    if (code === "too_large" && detail === "wifi") return `You can have at most ${formatNumber(MAX_WIFI_PROFILES)} Wi-Fi networks. Remove one first.`;
    if (code === "not_ready" && detail === "sealing_key") {
      return "The organization's encryption key isn't set up yet, so a password can't be stored. An Owner can finish the key setup in Settings, Signing.";
    }
    return null;
  },
};
