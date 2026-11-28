/** The Wi-Fi form's sentences (new and edit). Only the Wi-Fi screen imports this file. */
import type { WifiSecurity } from "../../data/types";
import { formatNumber } from "../../lib/format";
import type { PassphraseProblem, SsidProblem } from "../../lib/wifiRules";
import { MAX_SSID_BYTES } from "../../lib/wifiRules";

export const wifiStrings = {
  newTitle: "New Wi-Fi network",
  title: "Wi-Fi network",
  loading: "Loading network",
  ssid: "Wi-Fi name",
  ssidInfo: "Exactly as phones show it, capital letters included.",
  ssidBytes: (used: number) => `${formatNumber(used)} of ${formatNumber(MAX_SSID_BYTES)} bytes`,
  ssidBytesOver: (used: number) => `${formatNumber(used)} of ${formatNumber(MAX_SSID_BYTES)} bytes: too long`,
  ssidProblems: {
    empty: "Enter the Wi-Fi name.",
    tooLong: `A Wi-Fi name is at most ${MAX_SSID_BYTES} bytes. Letters with accents and non-Latin letters take 2 to 4 bytes each.`,
    control: "Remove line breaks and special control characters.",
  } satisfies Record<SsidProblem, string>,
  ssidServerRefused: `The Wi-Fi name isn't valid: use 1 to ${MAX_SSID_BYTES} bytes without control characters.`,

  password: "Wi-Fi password",
  passwordInfo: "Stored encrypted. Each PC gets it in a form only that PC can read. Nobody can read it back.",
  passwordHint8: "8 to 63 characters, or 64 hexadecimal digits.",
  passwordSetOn: (when: string) => `Set on ${when}`,
  passwordIsSet: "Set",
  passwordMissing: "No password yet. PCs wait for it before they join.",
  change: "Change",
  keepEmpty: "Leave empty to keep the current password.",
  openNetwork: "This network has no password",
  openDeletes: "The saved password will be deleted.",
  openInfo: "Anyone in range can join and the traffic is not encrypted. Use it only for a network you trust some other way.",
  passphraseProblems: {
    empty: "Enter the password.",
    length: "Use 8 to 63 characters, or exactly 64 hexadecimal digits.",
    chars: "Use plain letters, digits, spaces and the usual punctuation: no accents or special characters.",
  } satisfies Record<PassphraseProblem, string>,
  passphraseServerRefused: "The password isn't valid: use 8 to 63 plain characters, or 64 hexadecimal digits.",

  nameInRulebox: "Name in Rulebox",
  nameInfo: "Only for you, to tell networks apart. Employees never see it. It follows the Wi-Fi name until you change it.",
  nameFollows: "Same as the Wi-Fi name",
  securityType: "Security type",
  securityInfo: "WPA2/WPA3 works with almost every router and adapter. Pick WPA3 only if your router is set to WPA3 only.",
  securityNames: {
    wpa2Wpa3Personal: "WPA2/WPA3 (recommended)",
    wpa2Personal: "WPA2",
    wpa3Personal: "WPA3 only",
    open: "Open",
  } satisfies Record<WifiSecurity, string>,
  securityHint: {
    wpa2Wpa3Personal: "Works almost everywhere",
    wpa2Personal: "For older routers",
    wpa3Personal: "Newest, some adapters refuse it",
    open: "",
  } satisfies Record<WifiSecurity, string>,
  hiddenLabel: "Hidden network",
  hiddenInfo: "The router does not announce its name, so the PCs look for it by name instead.",
  autoConnect: "Join automatically",
  autoConnectInfo: "Off: the PC knows the network but someone has to pick it.",

  create: "Add network",
  saved: "Network saved.",
  created: (name: string) => `${name} added.`,
  savedNoPassword: "Network saved. The password wasn't saved: try again.",
  deleted: (name: string) => `${name} removed.`,

  // ---- the aside of a new network (and its (i) on a phone)
  howTitle: "How it works",
  how1: "PCs join before anyone signs in.",
  how2: "The password is encrypted. Nobody can read it back.",
  how3: "Changes reach the PCs within a minute.",

  // ---- delete
  deleteTitle: (name: string) => `Remove ${name}?`,
  deleteBody:
    "The network is taken away from every group. The PCs that have it remove it, and they won't join it by themselves any more. This can't be undone.",
  remove: "Remove network",

  // ---- apply counts (detail screen only)
  applied: "Joined or ready",
  waiting: "Waiting for the password",
  failed: "Failed",
  unsupported: "No Wi-Fi adapter",

  // ---- read only
  readName: "Name",
  readSecurity: "Security",
  readPassword: "Password",
  readHidden: "Hidden network",
};
