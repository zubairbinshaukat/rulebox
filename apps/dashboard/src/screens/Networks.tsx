import { Link } from "react-router";
import IconWifi from "~icons/solar/wi-fi-router-minimalistic-linear";
import IconAdd from "~icons/solar/add-circle-linear";
import { useNetworks } from "../data";
import type { WifiRow } from "../data/types";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { QueryRegion } from "../components/Region";
import { RoleGate } from "../components/RoleGate";
import { SkeletonBlock } from "../components/Skeleton";
import { formatDate } from "../lib/format";
import { useCan } from "../lib/member";
import { networksStrings as s } from "./networks/strings";

/** Group chips shown per row; the rest is "+N more" (the detail page lists them all). */
const CHIPS = 4;

function PassphraseStatus({ w }: { w: WifiRow }) {
  if (w.security === "open") return <span className="dash-muted">{s.passphraseNotNeeded}</span>;
  if (w.hasPassphrase && w.passphraseSetAt !== null) return <span>{s.setOn(formatDate(w.passphraseSetAt))}</span>;
  if (w.hasPassphrase) return <span>{s.passphraseSet}</span>;
  return <span className="dash-net__warn">{s.passphraseNone}</span>;
}

function WifiItem({ w, canEdit }: { w: WifiRow; canEdit: boolean }) {
  const shown = w.groups.slice(0, CHIPS);
  return (
    <li className="dash-list__item dash-net__item">
      <span className="dash-list__icon dash-list__icon--accent" aria-hidden="true">
        <IconWifi />
      </span>
      <div className="dash-list__body">
        <Link className="dash-link dash-list__title dash-wrap" to={`/networks/wifi/${w._id}`}>
          {w.name}
        </Link>
        <span className="dash-list__meta">
          <span className="dash-mono dash-wrap">{w.ssid}</span> · {s.securityShort[w.security]}
          {w.hidden ? (
            <>
              {" "}
              <span className="dash-chip">{s.hidden}</span>
            </>
          ) : null}
        </span>
        <span className="dash-list__meta">
          <PassphraseStatus w={w} />
        </span>
        <span className="dash-net__chips">
          {w.groupCount === 0 ? (
            <span className="dash-list__meta">{s.noGroups}</span>
          ) : (
            <>
              {shown.map((g) => (
                <Link key={g._id} to={`/groups/${g._id}`} className="dash-chip dash-link--plain">
                  {g.name}
                </Link>
              ))}
              {w.groupCount > shown.length ? <span className="dash-list__meta">{s.moreGroups(w.groupCount - shown.length)}</span> : null}
            </>
          )}
        </span>
      </div>
      {canEdit ? (
        <Link className="rb-btn rb-btn--ghost dash-btn--sm" to={`/networks/wifi/${w._id}`} aria-label={`${s.edit} ${w.name}`}>
          {s.edit}
        </Link>
      ) : null}
    </li>
  );
}

/**
 * `networks:list`: one subscription for the whole screen. Wi-Fi only for now (printers join in Step 14); each section is its own
 * Card so a Printers card can follow. No passphrase and no per-device counts here: those would re-run the list on every
 * device report (the counts are on the detail page).
 */
export default function Networks() {
  const state = useNetworks();
  const canAct = useCan("admin");
  const add = (
    <RoleGate minRole="admin">
      <Link className="rb-btn rb-btn--primary" to="/networks/wifi/new">
        <IconAdd aria-hidden="true" />
        {s.newWifi}
      </Link>
    </RoleGate>
  );
  return (
    <div className="dash-page">
      <PageHeader title={s.title} lead={s.lead} actions={add} />
      {!canAct ? <InlineNotice tone="neutral" title={s.readOnly} /> : null}
      <QueryRegion
        state={state}
        skeleton={
          <div className="dash-card dash-card--pad" aria-label={s.loadingList}>
            <SkeletonBlock lines={4} />
          </div>
        }
      >
        {(data) => (
          <Card title={s.wifiSection} body="flush">
            {data.wifi.length === 0 ? (
              <EmptyState icon={<IconWifi />} title={s.emptyTitle} body={s.emptyBody} action={add} />
            ) : (
              <ul className="dash-list" aria-label={s.wifiSection}>
                {data.wifi.map((w) => (
                  <WifiItem key={w._id} w={w} canEdit={canAct} />
                ))}
              </ul>
            )}
          </Card>
        )}
      </QueryRegion>
    </div>
  );
}
