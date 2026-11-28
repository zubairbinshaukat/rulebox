import { InfoTip } from "@rulebox/ui";
import { useRolloutHealth } from "../../data";
import type { RolloutHealth } from "../../data/types";
import { InlineNotice } from "../../components/Notice";
import { QueryRegion } from "../../components/Region";
import { SkeletonBlock } from "../../components/Skeleton";
import { formatCount } from "../../lib/format";
import { rolloutStrings as s } from "./strings";

/** The stage size the server reads at most (`RING_COUNT_CAP`): "more than N" in the capped note. */
export const STAGE_NUMBERS_CAP = 200;

/**
 * How the PCs of the stage in flight are doing, inside that stage's card: a bar in four parts and the four counts. Its own query,
 * `rollouts:health`: it moves with every PC's report, so it is only subscribed while a stage is in flight (this component only
 * mounts for that stage) and never rides along with the quiet `groupView`.
 */
export function StageHealth({ groupId }: { groupId: string }) {
  const health = useRolloutHealth(groupId);
  return (
    <QueryRegion state={health} skeleton={<SkeletonBlock lines={2} />}>
      {(h) => <HealthBody h={h} />}
    </QueryRegion>
  );
}

type Tone = "ok" | "partial" | "bad" | "wait";

function HealthBody({ h }: { h: RolloutHealth }) {
  if (h.stage === null) return null;
  const parts: { key: Tone; label: string; count: number }[] = [
    { key: "ok", label: s.done, count: h.applied },
    { key: "partial", label: s.partial, count: h.partial },
    { key: "bad", label: s.failed, count: h.failed },
    { key: "wait", label: s.waiting, count: h.waiting },
  ];
  return (
    <div className="ro-health">
      {h.ringSize === 0 ? (
        <p className="ro-health__line">{s.stageEmpty}</p>
      ) : (
        <>
          <div className="ro-bar" role="img" aria-label={`${s.healthLabel}: ${s.progressLabel(h.applied, h.ringSize)}`}>
            {parts
              .filter((p) => p.count > 0)
              .map((p) => (
                <span key={p.key} className="ro-bar__seg" data-tone={p.key} style={{ flexGrow: p.count }} />
              ))}
          </div>
          <p className="ro-health__line">
            <strong>{s.progressLabel(h.applied, h.ringSize)}</strong>
            {h.ringCapped ? (
              <InfoTip label={s.cappedInfoLabel}>{s.cappedInfo(STAGE_NUMBERS_CAP)}</InfoTip>
            ) : null}
          </p>
          <ul className="ro-counts" aria-label={s.healthLabel}>
            {parts.map((p) => (
              <li key={p.key} className="ro-counts__item" data-tone={p.key} data-zero={p.count === 0 || undefined}>
                <span className="ro-counts__dot" aria-hidden="true" />
                <span className="ro-counts__n">{formatCount(p.count)}</span>
                <span className="ro-counts__label">{p.label}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {h.reportsCapped ? <p className="ro-note">{s.reportsCapped}</p> : null}
      {h.pilotRolledBack ? <InlineNotice tone="danger" title={s.firstWentBack} /> : null}
      {h.stage.ring === "pilot" && h.applied === 0 && !h.pilotRolledBack ? <InlineNotice tone="warning" title={s.noFirstDone} /> : null}
    </div>
  );
}
