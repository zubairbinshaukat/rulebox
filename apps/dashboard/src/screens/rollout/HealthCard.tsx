import { useRolloutHealth } from "../../data";
import type { RolloutHealth } from "../../data/types";
import { Card } from "../../components/Card";
import { InlineNotice } from "../../components/Notice";
import { QueryRegion } from "../../components/Region";
import { SkeletonBlock } from "../../components/Skeleton";
import { formatCount } from "../../lib/format";
import { rolloutStrings as s } from "./strings";

/** The ring size the server reads at most (`RING_COUNT_CAP`): "larger than N" in the capped note. */
export const RING_NUMBERS_CAP = 200;

/**
 * How the stage in flight is going (plan 4.14): applied / failed / partly applied / waiting for the stage's ring and version. Its own
 * query, `rollouts:health`: it moves with every PC's report, so it is only subscribed while a stage is in flight and never
 * rides along with the quiet `groupView`.
 */
export function HealthCard({ groupId }: { groupId: string }) {
  const health = useRolloutHealth(groupId);
  return (
    <Card title={s.healthTitle}>
      <QueryRegion state={health} skeleton={<SkeletonBlock lines={2} />}>
        {(h) => <HealthBody h={h} />}
      </QueryRegion>
    </Card>
  );
}

/** The card when rings are on but nothing is in flight: no query at all. */
export function IdleHealthCard() {
  return (
    <Card title={s.healthTitle}>
      <p className="dash-muted">{s.healthNone}</p>
    </Card>
  );
}

function HealthBody({ h }: { h: RolloutHealth }) {
  if (h.stage === null) return <p className="dash-muted">{s.healthNone}</p>;
  const items: [string, number, "ok" | "bad" | "wait" | "neutral"][] = [
    [s.applied, h.applied, "ok"],
    [s.failed, h.failed, h.failed > 0 ? "bad" : "neutral"],
    [s.partial, h.partial, h.partial > 0 ? "wait" : "neutral"],
    [s.waiting, h.waiting, h.waiting > 0 ? "wait" : "neutral"],
  ];
  return (
    <div className="dash-form">
      <p>
        <strong>{s.healthFor(s.rings[h.stage.ring], h.stage.version)}</strong>
        <span className="dash-muted"> · {s.ringSize(h.ringSize)}</span>
      </p>
      <dl className="dash-net__counts">
        {items.map(([label, count, tone]) => (
          <div key={label} className={`dash-net__count dash-net__count--${tone}`}>
            <dt>{label}</dt>
            <dd>{formatCount(count)}</dd>
          </div>
        ))}
      </dl>
      {h.ringCapped ? <p className="dash-muted">{s.ringCapped(RING_NUMBERS_CAP)}</p> : null}
      {h.reportsCapped ? <p className="dash-muted">{s.reportsCapped}</p> : null}
      {h.pilotRolledBack ? <InlineNotice tone="danger" title={s.pilotRolledBack} /> : null}
      {h.stage.ring === "pilot" && h.applied === 0 ? <InlineNotice tone="warning" title={s.noPilotApplied} /> : null}
    </div>
  );
}
