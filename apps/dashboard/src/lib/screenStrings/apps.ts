import { formatNumber } from "../format";
import { n } from "../strings";

export const appsStrings = {
  title: "Apps",
  lead: "Websites and Windows programs your employees may use.",
  add: "Add app",
  addWeb: "Website",
  addDesktop: "Windows program",
  showArchived: "Show archived",
  active: "Active",
  colName: "App",
  colKind: "Type",
  colGroups: "Groups",
  colInstalls: "Installs",
  colAdded: "Added",
  searchLabel: "Search apps",
  searchPlaceholder: "Search apps by name",
  web: "Website",
  desktop: "Windows program",
  archived: "Archived",
  emptyTitle: "No apps yet",
  emptyBody: "Add a website or a Windows program, then assign it to a group.",
  emptyArchivedTitle: "No archived apps",
  emptyArchivedBody: "Archived apps show up here.",
  /** `more`: the list read only the first `count` assignments ("10+ groups"). */
  groups: (count: number, more = false) => (more ? `${formatNumber(count)}+ groups` : n(count, "group", "groups")),
  installSummary: (installed: number, failed: number, inProgress: number) =>
    `${formatNumber(installed)} installed · ${formatNumber(failed)} failed · ${formatNumber(inProgress)} pending`,
  noInstalls: "Nothing to install",
  /** Phase 6 Step 12: the mark next to a program's name (`apps:list` `updateFlag`). */
  updateFlag: {
    available: "Update waiting",
    feed_error: "Feed problem",
  },
  updateFlagHint: {
    available: "A new version from the vendor's update feed is waiting for your approval.",
    feed_error: "The vendor's update feed has a problem. Open the app to see it.",
  },
  sources: {
    winget: "winget",
    msi: "MSI",
    exe: "EXE",
    portable: "Portable",
    preinstalled: "Already installed",
  },
} as const;
