import { useState } from "react";
import { Button } from "@rulebox/ui";
import IconBanner from "~icons/solar/window-frame-linear";
import IconFullscreen from "~icons/solar/maximize-square-2-linear";
import IconGroup from "~icons/solar/users-group-rounded-linear";
import IconPc from "~icons/solar/monitor-linear";
import IconCalm from "~icons/solar/bell-linear";
import { useLiveBroadcasts } from "../../data";
import type { BroadcastRow } from "../../data/types";
import { Skeleton } from "../../components/Skeleton";
import { ackRatio } from "../../lib/noticeRules";
import { strings } from "../../lib/strings";
import { endsLabel, stillLive } from "./model";
import { broadcastStrings as s } from "./strings";

/** Cards shown before "Show all" on a tablet or wider (a phone scrolls the whole row sideways). */
const FIRST = 6;

/** One message on the PCs now: its style, who gets it, until when, and how many PCs saw it. */
function LiveCard({ b, now, onCancel }: { b: BroadcastRow; now: number; onCancel?: (b: BroadcastRow) => void }) {
  const until = b.expiresAt === null ? s.liveNoEnd : s.liveUntil(endsLabel(b.expiresAt, now));
  const r = ackRatio(b);
  const reach = b.ackRequired ? s.liveSeen(r.acked, r.of) : s.liveReach(b.targetCount);
  const TargetIcon = b.target.kind === "group" ? IconGroup : IconPc;
  const StyleIcon = b.style === "banner" ? IconBanner : IconFullscreen;
  return (
    <li className="bc-live__card dash-enter" data-style={b.style}>
      <span className="bc-live__icon" aria-hidden="true">
        <StyleIcon />
      </span>
      <div className="bc-live__main">
        <strong className="bc-live__title" title={b.title}>
          {b.title}
        </strong>
        <span className="bc-live__to">
          <TargetIcon aria-hidden="true" />
          <span>{b.target.name ?? s.gone}</span>
        </span>
        <span className="bc-live__foot">
          <span className="bc-live__meta">
            {until} · {reach}
          </span>
          {onCancel ? (
            <Button variant="ghost" className="dash-btn--sm bc-live__cancel" aria-label={`${s.liveCancel}: ${b.title}`} onClick={() => onCancel(b)}>
              {s.liveCancel}
            </Button>
          ) : null}
        </span>
        {b.ackRequired ? (
          <span className="bc-live__bar" aria-hidden="true">
            <i style={{ transform: `scaleX(${r.of === 0 ? 0 : Math.min(1, r.acked / r.of)})` }} />
          </span>
        ) : null}
      </div>
    </li>
  );
}

/**
 * "On your PCs now" (UI pass `other-pages.md` 5.2): the messages that are showing right now, from `broadcasts:live` (one small
 * subscription, at most 42 rows). The server returns the ones that ended a moment ago too, so the screen drops them with its own clock.
 * A phone scrolls the cards sideways; a tablet and up shows a grid of the first few with "Show all". `onCancel` is given to admins only.
 * `hideIfNone`: show nothing at all when there is nothing live (the list below is empty too, so its own empty state speaks).
 */
export function LiveNow({ now, onCancel, hideIfNone = false }: { now: number; onCancel?: (b: BroadcastRow) => void; hideIfNone?: boolean }) {
  const live = useLiveBroadcasts();
  const [all, setAll] = useState(false);
  const rows = live.status === "ready" ? stillLive(live.data, now) : [];
  if (hideIfNone && live.status === "ready" && rows.length === 0) return null;
  const count = live.status === "ready" ? rows.length : 0;

  return (
    <section className="bc-live dash-card" aria-labelledby="bc-live-title">
      <header className="bc-live__head">
        <span className="bc-live__dot" data-on={count > 0 || undefined} aria-hidden="true" />
        <h2 id="bc-live-title" className="bc-live__heading">
          {s.liveTitle}
        </h2>
        {count > 0 ? <span className="bc-live__count">{count}</span> : null}
      </header>
      {live.status === "loading" ? (
        <div className="bc-live__skel" role="status" aria-label={strings.app.loading}>
          <Skeleton height={64} radius={14} />
          <Skeleton height={64} radius={14} />
        </div>
      ) : live.status === "error" ? (
        <p className="bc-live__empty" role="alert">
          <span>{s.liveFailed}</span>
          <Button variant="ghost" className="dash-btn--sm" onClick={live.retry}>
            {s.liveRetry}
          </Button>
        </p>
      ) : rows.length === 0 ? (
        <p className="bc-live__empty">
          <IconCalm aria-hidden="true" />
          <span>{s.liveEmpty}</span>
        </p>
      ) : (
        <>
          <ul className="bc-live__list" data-collapsed={!all && rows.length > FIRST ? "true" : undefined}>
            {rows.map((b) => (
              <LiveCard key={b._id} b={b} now={now} onCancel={onCancel} />
            ))}
          </ul>
          {rows.length > FIRST ? (
            <Button variant="ghost" className="dash-btn--sm bc-live__more" aria-expanded={all} onClick={() => setAll((v) => !v)}>
              {all ? s.liveShowFewer : s.liveShowAll(rows.length)}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
