import type { AttentionItem } from "../../components/AttentionList";
import type { LockdownWarnings } from "../../data/types";
import { overviewLockdownStrings as s } from "./strings";

/**
 * The lockdown lines of "Needs attention" (Phase 5 Step 19, plan 4.20): PCs that did not apply the lockdown policy, paused rollouts,
 * groups whose program rules have been in audit mode for more than 14 days. They are `AttentionItem`s, so they sort into the same
 * cards as the other warnings. At most three names each (the query reads a few rows, never a device list). A chunk of its own, loaded
 * only when there is something to show, so an organization with nothing to warn about downloads none of it.
 */
export function lockdownItems(w: LockdownWarnings): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (w.notApplied.length > 0) {
    items.push({
      key: "refused",
      tone: "danger",
      title: s.notAppliedTitle(w.notApplied.map((d) => d.name), w.notAppliedMore),
      body: s.notAppliedDetail,
      action: { to: `/devices/${w.notApplied[0]!.deviceId}`, label: s.notAppliedAction },
    });
  }
  if (w.halted.length > 0) {
    items.push({
      key: "halted",
      tone: "warning",
      title: s.haltedTitle(w.halted.map((g) => g.name), w.haltedMore),
      body: s.haltedDetail,
      action: { to: `/groups/${w.halted[0]!.groupId}/rollout`, label: s.haltedAction },
    });
  }
  if (w.auditOverdue.length > 0) {
    items.push({
      key: "audit",
      tone: "warning",
      title: s.auditTitle(w.auditOverdue.map((g) => g.name), w.auditOverdueMore),
      body: s.auditDetail,
      action: { to: `/groups/${w.auditOverdue[0]!.groupId}/lockdown`, label: s.auditAction },
    });
  }
  return items;
}
