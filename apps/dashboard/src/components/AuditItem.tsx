import { Link } from "react-router";
import IconUser from "~icons/solar/user-rounded-linear";
import IconMonitor from "~icons/solar/monitor-linear";
import IconBolt from "~icons/solar/bolt-linear";
import type { AuditEntry } from "../data/types";
import { actionLabel } from "../lib/audit";
import { RelativeTime } from "./RelativeTime";

const TARGET_ROUTES: Record<string, string> = {
  device: "/devices/",
  employee: "/employees/",
  app: "/apps/",
  group: "/groups/",
};


/** Link to the audit row's target, or plain text when it has no page (or was deleted). */
export function TargetLink({ entry }: { entry: AuditEntry }) {
  if (!entry.targetLabel) return null;
  const base = entry.targetType ? TARGET_ROUTES[entry.targetType] : undefined;
  if (entry.targetType === "enrollmentCode") {
    return (
      <Link className="dash-link" to="/enrollment">
        {entry.targetLabel}
      </Link>
    );
  }
  if (!base || !entry.targetId) return <span>{entry.targetLabel}</span>;
  return (
    <Link className="dash-link" to={base + entry.targetId}>
      {entry.targetLabel}
    </Link>
  );
}

export function ActorLabel({ entry }: { entry: AuditEntry }) {
  if (entry.actorType === "device" && entry.actorId) {
    return (
      <Link className="dash-link" to={`/devices/${entry.actorId}`}>
        {entry.actorLabel}
      </Link>
    );
  }
  return <span className="dash-wrap">{entry.actorLabel}</span>;
}

const ICON = { member: IconUser, device: IconMonitor, system: IconBolt } as const;

/** One audit row as a timeline item (overview, history panels). */
export function AuditTimelineItem({ entry, showTarget = true }: { entry: AuditEntry; showTarget?: boolean }) {
  const Icon = ICON[entry.actorType];
  return (
    <li className="dash-timeline__item">
      <span className={`dash-timeline__icon dash-timeline__icon--${entry.actorType}`} aria-hidden="true">
        <Icon />
      </span>
      <div className="dash-timeline__body">
        <p className="dash-timeline__title">
          {actionLabel(entry.action)}
          {showTarget && entry.targetLabel ? (
            <>
              {" · "}
              <TargetLink entry={entry} />
            </>
          ) : null}
        </p>
        {entry.summary ? <p className="dash-timeline__summary">{entry.summary}</p> : null}
        <p className="dash-timeline__meta">
          <ActorLabel entry={entry} /> · <RelativeTime ms={entry.at} />
        </p>
      </div>
    </li>
  );
}
