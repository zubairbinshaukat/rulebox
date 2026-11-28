/** The lockdown warnings of the overview (Phase 5 Step 19, plan 4.20). Kept out of `strings.ts` so only the overview loads them. */
const names = (list: string[], more: boolean) => `${list.join(", ")}${more ? " and more" : ""}`;

export const overviewLockdownStrings = {
  auditTitle: (groups: string[], more: boolean) => `Trial run for more than 14 days: ${names(groups, more)}`,
  auditDetail: "Nothing is blocked yet. Review the programs, then switch to Block.",
  auditAction: "Open lockdown",
  haltedTitle: (groups: string[], more: boolean) => `Rollout paused: ${names(groups, more)}`,
  haltedDetail: "Nothing moves on to the next ring until you resume it.",
  haltedAction: "Open rollout",
  notAppliedTitle: (pcs: string[], more: boolean) => `Lockdown not applied on: ${names(pcs, more)}`,
  notAppliedDetail: "The PC refused the policy or went back to its last working one. Open the PC to see why.",
  notAppliedAction: "Open PC",
};
