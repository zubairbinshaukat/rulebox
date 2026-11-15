import type { ComponentType, SVGProps } from "react";
import { Link } from "react-router";
import IconWarn from "~icons/solar/danger-triangle-linear";
import IconShield from "~icons/solar/shield-warning-linear";
import type { LockdownWarnings } from "../../data/types";
import { overviewLockdownStrings as s } from "./strings";

interface Item {
  key: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  tone: "warning" | "danger";
  title: string;
  detail: string;
  to: string;
  label: string;
}

/**
 * The lockdown lines of the overview's attention list (Phase 5 Step 19, plan 4.20): PCs that did not apply the lockdown policy,
 * paused rollouts, groups whose program rules have been in audit mode for more than 14 days. At most three names each (the query
 * reads a few rows, never a device list). A chunk of its own, loaded only when there is something to show, so an organization
 * with nothing to warn about downloads none of it.
 */
export default function LockdownAttention({ w }: { w: LockdownWarnings }) {
  const items: Item[] = [];
  if (w.notApplied.length > 0) {
    items.push({ key: "refused", icon: IconShield, tone: "danger", title: s.notAppliedTitle(w.notApplied.map((d) => d.name), w.notAppliedMore), detail: s.notAppliedDetail, to: `/devices/${w.notApplied[0]!.deviceId}`, label: s.notAppliedAction });
  }
  if (w.halted.length > 0) {
    items.push({ key: "halted", icon: IconWarn, tone: "warning", title: s.haltedTitle(w.halted.map((g) => g.name), w.haltedMore), detail: s.haltedDetail, to: `/groups/${w.halted[0]!.groupId}/rollout`, label: s.haltedAction });
  }
  if (w.auditOverdue.length > 0) {
    items.push({ key: "audit", icon: IconShield, tone: "warning", title: s.auditTitle(w.auditOverdue.map((g) => g.name), w.auditOverdueMore), detail: s.auditDetail, to: `/groups/${w.auditOverdue[0]!.groupId}/lockdown`, label: s.auditAction });
  }
  return (
    <>
      {items.map((a) => (
        <li key={a.key} className="dash-list__item">
          <span className={`dash-list__icon dash-list__icon--${a.tone}`} aria-hidden="true">
            <a.icon />
          </span>
          <div className="dash-list__body">
            <p className="dash-list__title">{a.title}</p>
            <p className="dash-list__meta">{a.detail}</p>
          </div>
          <Link to={a.to} className="rb-btn rb-btn--ghost dash-btn--sm">
            {a.label}
          </Link>
        </li>
      ))}
    </>
  );
}
