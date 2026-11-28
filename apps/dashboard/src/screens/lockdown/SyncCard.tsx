import { useState } from "react";
import { Link } from "react-router";
import { InfoTip } from "@rulebox/ui";
import IconCheck from "~icons/solar/check-circle-linear";
import IconWarn from "~icons/solar/danger-triangle-linear";
import IconWait from "~icons/solar/clock-circle-linear";
import IconNext from "~icons/solar/alt-arrow-right-linear";
import type { Id, LockdownSync, QueryState } from "../../data/types";
import { RegionError } from "../../components/Region";
import { SkeletonBlock } from "../../components/Skeleton";
import { LkSection } from "./Section";
import { lockdownStrings as s } from "./strings";

/**
 * "Your PCs": how many PCs of the group have the newest settings (`lockdown:groupSync`, a query of its own so a PC's report never
 * re-runs the form). After a save it reads "Sending: 0 of 8 PCs have it" and counts up while the PCs report, then "All 8 PCs are up to
 * date." The bar animates with `transform: scaleX` only. On a phone the details fold away; problems and warnings never do.
 */
export function SyncCard({ groupId, sync, sending, className }: { groupId: Id; sync: QueryState<LockdownSync>; sending: boolean; className?: string }) {
  return (
    <LkSection title={s.syncTitle} className={["lk-sync", className ?? ""].filter(Boolean).join(" ")}>
      {sync.status === "loading" ? <SkeletonBlock lines={2} /> : null}
      {sync.status === "error" ? <RegionError error={sync.error} onRetry={sync.retry} /> : null}
      {sync.status === "ready" ? <SyncBody groupId={groupId} d={sync.data} sending={sending} /> : null}
    </LkSection>
  );
}

function SyncBody({ groupId, d, sending }: { groupId: Id; d: LockdownSync; sending: boolean }) {
  const [expanded, setExpanded] = useState(false);

  if (d.total === 0) {
    return (
      <div className="lk-sync__body">
        <p className="lk-sync__headline">{s.noPcs}</p>
        <Link className="rb-btn rb-btn--ghost dash-btn--sm lk-sync__link" to="/enrollment">
          {s.noPcsAction}
        </Link>
      </div>
    );
  }
  if (d.newestVersion === null) {
    return (
      <div className="lk-sync__body">
        <p className="lk-sync__headline">{s.notSent}</p>
      </div>
    );
  }

  const waiting = Math.max(0, d.total - d.upToDate - d.problems);
  const done = d.upToDate === d.total && !d.totalMore;
  const busy = sending && !done && d.upToDate + d.problems < d.total;
  const headline = done ? s.allUpToDate(d.total) : busy ? s.sending(d.upToDate, d.total) : s.upToDate(d.upToDate, d.total, d.totalMore);
  const fill = d.total === 0 ? 0 : d.upToDate / d.total;
  const halted = d.ringsOn && d.rolloutState === "halted";
  const hasMore = waiting > 0 || d.ringsOn;

  return (
    <div className="lk-sync__body" data-open={expanded || undefined}>
      <p className="lk-sync__headline" data-done={done || undefined} aria-live="polite">
        {done ? <IconCheck aria-hidden="true" /> : null}
        <span>{headline}</span>
      </p>
      <div className="lk-meter" role="progressbar" aria-label={s.syncBar} aria-valuemin={0} aria-valuemax={d.total} aria-valuenow={d.upToDate} aria-valuetext={headline} data-done={done || undefined}>
        <span className="lk-meter__fill" style={{ transform: `scaleX(${fill})` }} />
      </div>

      {d.problems > 0 ? (
        <div className="lk-note" data-tone="danger">
          <IconWarn aria-hidden="true" />
          <span>
            {s.problems(d.problems)}{" "}
            {d.problemPcs.map((pc, i) => (
              <span key={pc.deviceId}>
                {i > 0 ? ", " : null}
                <Link to={`/devices/${pc.deviceId}`}>{pc.name}</Link>
              </span>
            ))}
            {d.problems > d.problemPcs.length ? "…" : null}
          </span>
          <InfoTip label={`About ${s.problems(d.problems)}`}>{s.problemsInfo}</InfoTip>
        </div>
      ) : null}
      {d.adminTilesPending > 0 ? (
        <p className="lk-note" data-tone="warning">
          <IconWarn aria-hidden="true" />
          <span>{s.adminTilesPending(d.adminTilesPending)}</span>
        </p>
      ) : null}
      {d.reduced > 0 ? (
        <p className="lk-note" data-tone="neutral">
          <IconWarn aria-hidden="true" />
          <span>{s.reduced(d.reduced)}</span>
        </p>
      ) : null}

      {hasMore ? (
        <div className="lk-sync__more">
          {waiting > 0 ? (
            <p className="lk-note" data-tone="neutral">
              <IconWait aria-hidden="true" />
              <span>{s.waiting(waiting)}</span>
              <InfoTip label={`About ${s.waiting(waiting)}`}>{s.waitingInfo}</InfoTip>
            </p>
          ) : null}
          {d.ringsOn ? (
            <p className="lk-note" data-tone={halted ? "warning" : "neutral"}>
              {halted ? <IconWarn aria-hidden="true" /> : <IconNext aria-hidden="true" />}
              <span>
                {halted ? s.ringsHalted : s.ringsOn} <Link to={`/groups/${groupId}/rollout`}>{s.ringsAction}</Link>
              </span>
            </p>
          ) : null}
        </div>
      ) : null}
      {hasMore ? (
        <button type="button" className="lk-sync__toggle" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
          {expanded ? s.syncHide : s.syncDetails}
        </button>
      ) : null}
    </div>
  );
}
