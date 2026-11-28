import { formatCount } from "../../lib/format";
import { n } from "../../lib/strings";

/**
 * The words of the group page (UI pass 2026-11, `docs/plans/ui-pass/other-pages.md` section 1.5): the header, the tabs, the
 * Overview, the PCs and People tabs. Plain words; the explanations are (i) tips. The words of the assign / edit dialogs stay in
 * `lib/screenStrings/group.ts` and `groups/strings.ts` (another step redesigns those dialogs).
 */
export const groupPage = {
  back: "All groups",
  /** The page title while the page itself could not load. */
  groupsTitle: "Groups",
  loadingTitle: "Loading this group",
  tabsLabel: "Sections of this group",
  tabs: { overview: "Overview", pcs: "PCs", people: "People", activity: "Activity" },

  // ---- header
  assignApp: "Assign app",
  protection: "Protection",
  more: "More",
  stagedRollout: "Staged rollout",
  sendMessage: "Send a message",
  rename: "Rename",
  renameTitle: "Rename this group",
  deleteGroup: "Delete group",
  /** The sticky bar at the bottom of a phone. */
  quickBar: "Quick action",

  // ---- tiles
  tilesLabel: "This group at a glance",
  tile: {
    pcs: "PCs",
    people: "People",
    apps: "Apps",
    protection: "Protection",
    trialRun: "Trial run",
    setUp: "Set up",
    unknown: "—",
    days: (days: number) => `for ${n(days, "day", "days")}`,
    /** A count the server caps: "500+". */
    count: (count: number) => formatCount(count, 500),
    open: (label: string) => `Open ${label}`,
  },

  // ---- Needs attention
  attention: "Needs attention",
  allClear: "Nothing needs your attention",
  problem: {
    haltedTitle: "The staged rollout is paused",
    haltedBody: "Rulebox stopped sending the latest change on. Open the rollout to see what happened.",
    openRollout: "Open rollout",
    trialTitle: "Program blocking is still a trial run",
    trialBody: (days: number) => `Programs that are not allowed are only reported, not blocked. This has lasted ${n(days, "day", "days")}.`,
    openProtection: "Open protection",
    archivedTitle: (app: string) => `${app} is archived. PCs no longer get it.`,
    archivedBody: "Unassign it, or restore the app on its own page.",
    unassign: "Unassign",
    rollingTitle: "A change is reaching the first PCs",
    rollingBody: "Rulebox sends a change to a few PCs first, then to the rest.",
  },

  // ---- Get this group ready
  ready: {
    title: "Get this group ready",
    progress: (done: number) => `${done} of 3 done`,
    stepsLabel: "Steps to get this group ready",
    done: "Done",
    apps: { title: "Assign apps", body: "Choose the apps these PCs get.", action: "Assign app" },
    people: { title: "Add people", body: "Choose who uses these PCs.", action: "Add people" },
    pcs: { title: "Add PCs", body: "Connect a PC and put it in this group.", action: "Add a PC" },
  },

  // ---- Apps
  apps: "Apps",
  appsCount: (count: number) => n(count, "app", "apps"),
  appsNone: "No apps yet",
  colApp: "App",
  colWho: "Who gets it",
  colPins: "Shown on",
  everyone: "Everyone",
  chosen: "Chosen people",
  archived: "Archived",
  edit: "Edit",

  // ---- How this group is set up
  setup: {
    title: "How this group is set up",
    protection: "Protection",
    protectionInfo: "Which programs may run on the PCs of this group. In a trial run nothing is blocked yet.",
    rollout: "Staged rollout",
    rolloutInfo: "Send changes to a few PCs first, then to the rest.",
    display: "Display and memory",
    displayInfo: "PCs with 4 GB of memory or less use a lighter look by themselves.",
    on: "On",
    off: "Off",
    paused: "Paused",
    automatic: "Automatic",
    standard: "Standard",
    lite: "Lite",
    open: "Open",
    change: "Change",
    openLabel: (what: string) => `Open ${what}`,
    changeLabel: (what: string) => `Change ${what}`,
  },

  // ---- PCs tab
  pcs: {
    caption: "PCs in this group",
    searchLabel: "Search PCs in this group",
    searchPlaceholder: "Search by name",
    colName: "Name",
    colStatus: "Status",
    colKiosk: "Kiosk",
    colAdded: "Added",
    colSettings: "Settings",
    noneTitle: "No PCs in this group yet",
    noneBody: "Connect a PC and choose this group for it.",
    add: "Add a PC",
    sortNewest: "Newest added",
    searchCap: "Showing the first 50 matches. Type more of the name to narrow it down.",
  },

  // ---- People tab
  people: {
    caption: "People in this group",
    searchLabel: "Search people in this group",
    searchPlaceholder: "Search by name or username",
    colName: "Name",
    colStatus: "Status",
    active: "Active",
    disabled: "Disabled",
    noneTitle: "No people in this group yet",
    noneBody: "Add the people who will sign in on these PCs.",
    add: "Add people",
    addTitle: "Add people to this group",
    addSearch: "Search people",
    remove: "Remove",
    removed: (name: string) => `${name} removed from the group.`,
    sortNewest: "Newest added",
  },

  // ---- Activity tab
  historyTitle: "History",

  // ---- dialogs
  saved: "Group saved.",
  deleteTitle: "Delete this group?",
  deleted: (name: string) => `Group “${name}” deleted.`,
  displaySaved: "Display settings saved.",
} as const;
