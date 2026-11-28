import { formatNumber } from "../format";
import { n } from "../strings";

export const devicesStrings = {
  title: "Devices",
  lead: "Every PC enrolled in your organization.",
  searchLabel: "Search devices by name",
  searchPlaceholder: "Search by name",
  groupFilter: "Group",
  allGroups: "All groups",
  noGroup: "No group",
  /** The group filter's entry for PCs without a group (`fleet:list` with groupId "none"). */
  noGroupFilter: "No group",
  planOverLimit: "Over plan limit",
  planOverLimitHint: "This PC is over your plan's device limit, so it keeps its last policy. Remove a PC or ask for a higher limit.",
  planSuspended: "Suspended",
  planSuspendedHint: "This organization is suspended, so this PC keeps its last policy.",
  addPc: "Add a PC",
  colName: "Name",
  colEnrolled: "Enrolled",
  colGroup: "Group",
  colStatus: "Status",
  colAgent: "Agent",
  colWindows: "Windows",
  colKiosk: "Kiosk",
  colPolicy: "Policy",
  colAlerts: "Needs a look",
  emptyTitle: "No devices yet",
  emptyBody: "Create an enrollment code to add the first PC.",
  emptyAction: "Create enrollment code",
  noMatchTitle: "No devices match",
  noMatchBody: "Try another name or clear the filter.",
  searchCap: "Showing the first 50 matches. Type more of the name to narrow it down.",
  checkNow: "Check now",
  checkNowFirst: (max: number) => `Check first ${max}`,
  checking: "Asking the PCs to call in…",
  checkResult: (answered: number, total: number) =>
    answered === total ? `All ${total} PCs answered.` : `${answered} of ${total} PCs answered so far. The others did not answer yet.`,
  outOfSupport: "Out of support",
  revoked: "Revoked",
  kioskOff: "Kiosk off",
  policyUpToDate: "Up to date",
  policyWaiting: "Update waiting",
  /** The tooltip of "Update waiting": the numbers are for support, so they are not on the card. */
  policyWaitingHint: (applied: number | undefined, latest: number) =>
    applied === undefined
      ? `This PC has not applied any settings yet. The newest are version ${formatNumber(latest)}.`
      : `This PC has version ${formatNumber(applied)}. The newest is version ${formatNumber(latest)}.`,
  /** The technical line at the bottom of a PC's card. */
  windowsDetail: (build: string, agent: string | undefined) => (agent ? `Windows build ${build} · Agent ${agent}` : `Windows build ${build}`),
  groupSearch: "Search groups",
  groupNoMatch: "No group with that name",  count: (count: number) => n(count, "device", "devices"),
} as const;
