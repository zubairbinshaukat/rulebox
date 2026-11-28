import { useMemo, useRef } from "react";
import IconApps from "~icons/solar/box-linear";
import IconPcs from "~icons/solar/monitor-linear";
import IconPeople from "~icons/solar/users-group-rounded-linear";
import IconShield from "~icons/solar/shield-check-linear";
import type { AssignmentRow, GroupDetail } from "../../data/types";
import { AttentionList } from "../../components/AttentionList";
import { StatTile, StatTiles } from "../../components/StatTile";
import { AppsCard } from "./AppsCard";
import { ReadyCard } from "./Checklist";
import { SetupCard } from "./SetupCard";
import { attentionItems, groupChecklist, problemBadge, TRIAL_WARN_DAYS, type GroupProblem } from "./problems";
import { groupPage as t } from "./strings";

export interface OverviewProps {
  g: GroupDetail;
  problems: GroupProblem[];
  now: number;
  /** Open another tab of the page. */
  onTab: (tab: "pcs" | "people") => void;
  onAssign: () => void;
  onAddPeople: () => void;
  onEditApp: (a: AssignmentRow) => void;
  onUnassign: (a: AssignmentRow) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The Overview (plan 1.4): four numbers, what needs attention (or, for a group that is not ready yet, the three steps to get it
 * ready), the apps and how the group is set up. Laptop and up: attention and apps on the left (2/3), the setup on the right; a
 * phone stacks them with the setup last.
 */
export default function OverviewTab({ g, problems, now, onTab, onAssign, onAddPeople, onEditApp, onUnassign }: OverviewProps) {
  const checklist = useMemo(() => groupChecklist(g), [g]);
  const items = useMemo(() => attentionItems(problems, { checklist: checklist.show, onUnassign }), [problems, checklist.show, onUnassign]);
  const badge = problemBadge(problems);
  const apps = useRef<HTMLDivElement>(null);

  const showApps = () => {
    const el = apps.current;
    if (!el) return;
    const calm = document.documentElement.dataset.lite === "true" || (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    el.scrollIntoView?.({ block: "start", behavior: calm ? "auto" : "smooth" });
    el.focus({ preventScroll: true });
  };

  const trial = typeof g.lockdownAuditSince === "number" ? g.lockdownAuditSince : null;
  const trialDays = trial === null ? 0 : Math.floor((now - trial) / DAY_MS);

  return (
    <div className="grp-ov">
      <StatTiles label={t.tilesLabel}>
        <StatTile index={0} label={t.tile.pcs} value={t.tile.count(g.deviceCount)} icon={<IconPcs />} onClick={() => onTab("pcs")} />
        <StatTile index={1} label={t.tile.people} value={t.tile.count(g.employeeCount)} icon={<IconPeople />} onClick={() => onTab("people")} />
        <StatTile index={2} label={t.tile.apps} value={g.assignments.length} icon={<IconApps />} onClick={showApps} />
        <ProtectionTile g={g} trialDays={trialDays} />
      </StatTiles>

      <div className="dash-split grp-ov__split">
        <div className="dash-split__main">
          {items.length > 0 || !checklist.show ? (
            <section className="grp-ov__section" aria-labelledby="grp-attention">
              <h2 id="grp-attention" className="dash-section-title">
                {t.attention}
                {badge.count > 0 ? (
                  <span className="grp-badge" data-tone={badge.danger ? "danger" : "warning"}>
                    {badge.count}
                  </span>
                ) : null}
              </h2>
              <AttentionList items={items} emptyText={t.allClear} />
            </section>
          ) : null}
          {checklist.show ? <ReadyCard groupId={g._id} state={checklist} onAssign={onAssign} onAddPeople={onAddPeople} /> : null}
          <AppsCard cardRef={apps} assignments={g.assignments} onEdit={onEditApp} onUnassign={onUnassign} />
        </div>
        <aside className="dash-split__aside" aria-label={t.setup.title}>
          <SetupCard g={g} />
        </aside>
      </div>
    </div>
  );
}

/** Protection: "Trial run" (amber after two weeks) or "Set up"; it opens the group's protection page. */
function ProtectionTile({ g, trialDays }: { g: GroupDetail; trialDays: number }) {
  const to = `/groups/${g._id}/lockdown`;
  if (typeof g.lockdownAuditSince === "number") {
    const long = trialDays > TRIAL_WARN_DAYS;
    return (
      <StatTile
        index={3}
        label={t.tile.protection}
        value={t.tile.trialRun}
        sub={trialDays >= 1 ? t.tile.days(trialDays) : undefined}
        tone={long ? "warning" : undefined}
        icon={<IconShield />}
        to={to}
      />
    );
  }
  return <StatTile index={3} label={t.tile.protection} value={g.lockdownAuditSince === null ? t.tile.setUp : t.tile.unknown} icon={<IconShield />} to={to} />;
}
