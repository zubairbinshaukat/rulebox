import { lazy, Suspense, useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import { Link } from "react-router";
import { Button, InfoTip, Pill } from "@rulebox/ui";
import IconDisplay from "~icons/solar/monitor-smartphone-linear";
import IconRocket from "~icons/solar/rocket-2-linear";
import IconShield from "~icons/solar/shield-check-linear";
import type { DisplayChoice, GroupDetail } from "../../data/types";
import { Card } from "../../components/Card";
import { useCan } from "../../lib/member";
import { groupPage as t } from "./strings";

// The dialog loads when it is opened: it is the only place that needs the three drop-downs.
const GroupDisplayDialog = lazy(() => import("../display/GroupDisplayCard").then((m) => ({ default: m.GroupDisplayDialog })));

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const displayName = (m: DisplayChoice | undefined) => (m === "lite" ? t.setup.lite : m === "standard" ? t.setup.standard : t.setup.automatic);

/**
 * "How this group is set up": one row per thing that is decided elsewhere (Protection, Staged rollout, Display and memory), each
 * with its state in one word, a (i) that explains it and the way to change it. On a tablet the three rows sit side by side; in a
 * side column or on a phone they are a list.
 */
export function SetupCard({ g }: { g: GroupDetail }) {
  const admin = useCan("admin");
  const [display, setDisplay] = useState(false);

  // An older server sends neither field: the row says nothing rather than something wrong.
  const protection: ReactNode =
    g.lockdownAuditSince === undefined ? (
      <span className="dash-muted">{t.tile.unknown}</span>
    ) : g.lockdownAuditSince === null ? (
      t.tile.setUp
    ) : (
      <Pill tone="warning">{t.tile.trialRun}</Pill>
    );
  const rollout: ReactNode =
    g.rollout === undefined ? (
      <span className="dash-muted">{t.tile.unknown}</span>
    ) : g.rollout?.state === "halted" ? (
      <Pill tone="danger">{t.setup.paused}</Pill>
    ) : g.rollout?.enabled ? (
      <Pill tone="success">{t.setup.on}</Pill>
    ) : (
      t.setup.off
    );

  return (
    <Card title={t.setup.title} body="none" className="grp-setup">
      <ul className="grp-setup__list">
        <Row
          icon={IconShield}
          label={t.setup.protection}
          info={t.setup.protectionInfo}
          value={protection}
          action={
            <Link className="rb-btn rb-btn--ghost dash-btn--sm" to={`/groups/${g._id}/lockdown`} aria-label={t.setup.openLabel(t.setup.protection)}>
              {t.setup.open}
            </Link>
          }
        />
        <Row
          icon={IconRocket}
          label={t.setup.rollout}
          info={t.setup.rolloutInfo}
          value={rollout}
          action={
            <Link className="rb-btn rb-btn--ghost dash-btn--sm" to={`/groups/${g._id}/rollout`} aria-label={t.setup.openLabel(t.setup.rollout)}>
              {t.setup.open}
            </Link>
          }
        />
        <Row
          icon={IconDisplay}
          label={t.setup.display}
          info={t.setup.displayInfo}
          value={displayName(g.displayMode)}
          action={
            admin ? (
              <Button variant="ghost" className="dash-btn--sm" onClick={() => setDisplay(true)} aria-label={t.setup.changeLabel(t.setup.display)}>
                {t.setup.change}
              </Button>
            ) : null
          }
        />
      </ul>
      <Suspense fallback={null}>{display ? <GroupDisplayDialog g={g} onClose={() => setDisplay(false)} /> : null}</Suspense>
    </Card>
  );
}

function Row({ icon: Glyph, label, info, value, action }: { icon: Icon; label: string; info: string; value: ReactNode; action: ReactNode }) {
  return (
    <li className="grp-setup__row">
      <span className="grp-setup__icon" aria-hidden="true">
        <Glyph />
      </span>
      <div className="grp-setup__text">
        <span className="grp-setup__label">
          {label}
          <InfoTip label={`About ${label}`}>{info}</InfoTip>
        </span>
        <span className="grp-setup__value">{value}</span>
      </div>
      {action ? <div className="grp-setup__action">{action}</div> : null}
    </li>
  );
}
