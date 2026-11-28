import { n } from "../../lib/strings";

/**
 * The words of the device page shell, the Overview and the Apps and Activity tabs (UI pass 2026-11,
 * `docs/plans/ui-pass/device-detail.md` section 7). The "Needs attention" sentences are in `problemStrings.ts`; the other tabs
 * keep their words in their own files so builders working on them in parallel do not collide.
 */
export const deviceText = {
  back: "All devices",
  /** The page title while the page itself could not load. */
  devicesTitle: "Devices",
  tabsLabel: "Sections of this PC",
  tabs: {
    overview: "Overview",
    apps: "Apps",
    protection: "Protection",
    network: "Network",
    activity: "Activity",
    settings: "Settings",
  },
  /** Shown above the Network tab's content (the tab itself is short for a phone). */
  networkTitle: "Network and printers",

  // ---- header
  rename: "Rename this PC",
  sendMessage: "Send a message",
  lockPc: "Lock this PC",
  unlockPc: "Unlock",
  locked: "Locked",
  noGroup: "No group",
  groupLabel: "Group",
  rulebox: (version: string) => `Rulebox ${version}`,
  metaLabel: "About this PC",
  online: "Online",
  onlineAgo: (rel: string) => `Online · ${rel}`,
  justNow: "just now",
  offline: "Offline",
  offlineSince: (rel: string) => `Offline · since ${rel}`,
  offlineLastSeen: (rel: string) => `Offline · last seen ${rel}`,
  notConnected: "Not connected yet",
  onlineInfoLabel: "About online status",
  onlineInfo: "Online means the PC is talking to Rulebox now.",
  disconnected: "Disconnected",
  kioskOn: "Kiosk on",
  kioskOff: "Kiosk off",
  kioskStarting: "Kiosk starting",
  kioskProblem: "Kiosk problem",
  kioskWaiting: "Kiosk not applied yet",

  // ---- lock dialog
  lockDialogTitle: "Lock this PC",
  lockedDialogTitle: "This PC is locked",
  close: "Close",

  // ---- Overview tiles
  tilesLabel: "State of this PC",
  tile: {
    settings: "Settings",
    protection: "Protection",
    apps: "Apps",
    disk: "Free disk",
    memory: "Memory",
    upToDate: "Up to date",
    updating: "Updating",
    notSent: "Not sent yet",
    working: "Working",
    partly: "Partly working",
    notApplied: "Not applied",
    notReported: "Not reported yet",
    noFailures: "No failures",
    failed: (count: number, more: boolean) => `${more ? `${count}+` : count} failed`,
    lite: "Lite mode",
    lowDisk: "Running low",
    needsNewerRulebox: "Needs a newer Rulebox",
    arrivesSoon: "Arrives within a minute",
    arrivesLater: "Arrives when the PC is back",
    none: "—",
    lastKnown: (rel: string) => `Last known, ${rel}`,
    open: (label: string) => `Open ${label}`,
    infoSettings: "Whether this PC runs the latest settings of its group. It updates within a minute when online.",
    infoProtection: "How much of the group's lockdown this PC applies. Details on the Protection tab.",
    infoDisk: "Below 2 GB, app installs and updates can fail.",
  },

  // ---- Needs attention
  attention: "Needs attention",
  allClear: "Nothing needs your attention",
  allClearNoReport: "This PC has not sent a report yet.",
  goodToKnow: (count: number) => `Also good to know (${count})`,
  disconnectedNote: "A disconnected PC keeps its last settings.",
  running: "Working…",

  // ---- About
  about: "About this PC",
  windows: "Windows",
  memory: "Memory",
  lite: "Lite mode",
  liteInfo: "On PCs with 4 GB or less, Rulebox keeps fewer windows open to stay fast.",
  diskFree: "Free disk",
  browsers: "Browsers",
  companyDomain: "Joined to a company domain",
  yes: "Yes",
  enrolled: "Enrolled",
  lastReport: "Last report",
  noReport: "This PC has not sent this yet.",
  browserEdge: "Edge",
  browserChrome: "Chrome",
  browsersNone: "None found",

  // ---- Technical details
  tech: "Technical details",
  techLead: "For support. You don't need these to use Rulebox.",
  techCopy: "Copy",
  techCopied: "Copied",
  techManual: "Select the text and press Ctrl+C to copy.",
  techAll: "Technical details of this PC",
  techId: "Device ID",
  techBuild: "Windows build",
  techEdition: "Windows edition",
  techArch: "Architecture",
  techSMode: "S mode",
  techWebview: "WebView2 version",
  techWebviewMissing: "Not installed",
  techAgent: "Rulebox version",
  techKeys: "Signing keys it trusts",
  techKeysNone: "None",
  techKioskPhase: "Kiosk state",
  techStaffApp: "Staff App",
  techLastContact: "Last contact",
  techKeysCount: (count: number) => n(count, "key", "keys"),

  // ---- Apps tab
  appsTitle: "Apps on this PC",
  appsNone: "No apps are assigned to this PC's group.",
  appsNoneGroup: "Choose apps for the group and they appear here.",
  appsOpenGroup: "Open the group",
  colUpdated: "Updated",

  // ---- Activity tab
  historyTitle: "History",
  versionsTitle: "Settings versions",
  versionsLead: "Each change to this PC's settings makes a new version.",
  versionsShow: "Show recent versions",
  versionsNone: "No settings have been sent to this PC yet.",
  versionCol: "Version",
  versionReason: "What changed",
  versionDate: "Published",
  versionApplied: "On this PC",
  versionAppliedNow: "Running",
  versionsFailed: "The versions could not be loaded.",

  // ---- loading
  loadingTitle: "Loading this PC",
} as const;
