/**
 * The sentences of the Overview (UI pass, plan other-pages 2.3): short, plain, no vendor names. They live next to the screen
 * (not in `lib/strings.ts`) so the sign-in page, which loads that file, does not download them.
 */
import { formatCount } from "../../lib/format";
import { n } from "../../lib/strings";

export const overviewText = {
  greeting: (part: "morning" | "afternoon" | "evening") => (part === "morning" ? "Good morning" : part === "afternoon" ? "Good afternoon" : "Good evening"),

  // The one line under the greeting.
  statusCalm: (pcs: number) => (pcs === 1 ? "Everything is fine on your PC." : `Everything is fine on your ${formatCount(pcs)} PCs.`),
  statusWelcome: "Welcome. Add your first PC to get started.",
  statusAttention: (count: number) => `${n(count, "thing needs", "things need")} you.`,
  addFirstPc: "Add a PC",

  // The four tiles.
  tilesLabel: "Totals",
  pcs: "PCs",
  pcsOnline: (online: number) => `${formatCount(online)} online`,
  employees: "Employees",
  apps: "Apps",
  inGroups: (groups: number) => `in ${n(groups, "group", "groups")}`,
  failedTile: "Failed installs",
  failedTileSub: "See the list",
  failedTileNone: "None",

  // Needs attention.
  attention: "Needs attention",
  attentionLabel: "Things that need you",
  attentionNone: "Nothing needs you right now.",
  openSettings: "Open Settings",
  noKeyTitle: "PCs can't be added yet",
  noKeyDetail: "An owner needs to set up the signing key.",
  rotatingTitle: "A key change is in progress",
  rotatingDetail: "Finish it once every PC has the new key.",
  publishFailedTitle: "Changes are not reaching your PCs",
  publishFailedDetail: "Open Settings and press Publish again.",
  rosterPendingTitle: "A disabled employee can still sign in on some PCs",
  rosterPendingDetail: "Open Settings and press Publish again.",
  suspendedTitle: "This organization is suspended",
  suspendedDetail: "You can't add PCs, employees or apps until it is active again.",
  limitTitle: (what: string) => `You can't add more ${what}`,
  limitDetail: "Remove one, or ask for a higher limit, before adding more.",
  overLimitTitle: (what: string) => `You have more ${what} than your plan allows`,
  overLimitDetail: "Remove some, or ask for a higher limit.",
  limitKinds: { devices: "PCs", employees: "employees", apps: "apps", groups: "groups" },
  noGroupTitle: (count: number) => `${n(count, "PC", "PCs")} not in a group`,
  noGroupDetail: "Nobody can sign in on them until they are in one.",
  noGroupAction: "Show PCs",
  outOfSupportTitle: (count: number) => `${n(count, "PC needs", "PCs need")} a Windows update`,
  outOfSupportDetail: "Their Windows no longer gets security fixes.",
  outOfSupportAction: "Show PCs",
  /** Owners only. */
  largeFleetTitle: "More than 300 PCs",
  largeFleetDetail: "Ask your Rulebox provider whether your plan covers this many.",

  // Failed installs.
  failedInstalls: "Failed installs",
  failedInstallsNone: "No failed installs.",
  seeAll: (count: number) => `See all (${formatCount(count, 999)})`,
  on: "on",
  colApp: "App",
  colDevice: "PC",
  colUpdated: "Updated",

  // Recent activity.
  recentActivity: "Recent activity",
  recentActivityNone: "Nothing has happened yet.",

  // The buttons at the top.
  addMenu: "Add",
  addPc: "Add a PC",
  addEmployee: "Add employee",
  addApp: "Add app",
};
