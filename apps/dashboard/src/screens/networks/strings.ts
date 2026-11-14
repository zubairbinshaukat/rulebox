/**
 * Networks (Phase 5 Step 13): Wi-Fi profiles. A lazily loaded part of the dashboard's sentences (only the Networks
 * and Wi-Fi screens import it). Plain words: the people using this run a shop, not a data centre.
 */
import type { PassphraseProblem, SsidProblem } from "../../lib/wifiRules";
import { MAX_SSID_BYTES, MAX_WIFI_PROFILES } from "../../lib/wifiRules";
import { formatNumber, plural } from "../../lib/format";
import type { WifiSecurity } from "../../data/types";

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

  /** `too_large` (detail "groups") and the plan limit of the Wi-Fi calls, as sentences; null = the usual one. */
  describeError: (code: string, detail: string | undefined, limit = 0): string | null => {
    if (code === "too_large" && detail === "groups") {
      return `One save can touch at most ${formatNumber(limit)} ${plural(limit, { one: "group", other: "groups" })}: the groups the network is in now plus the ones you pick. A network in more groups than that can't be changed or removed here yet.`;
    }
    if (code === "too_large" && detail === "wifi") return `You can have at most ${formatNumber(MAX_WIFI_PROFILES)} Wi-Fi networks. Remove one first.`;
    if (code === "not_ready" && detail === "sealing_key") {
      return "The organization's encryption key isn't set up yet, so a password can't be stored. An Owner can finish the key setup in Settings, Signing.";
    }
    return null;
  },
};
