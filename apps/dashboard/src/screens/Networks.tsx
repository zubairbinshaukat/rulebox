import { Link } from "react-router";
import IconWifi from "~icons/solar/wi-fi-router-minimalistic-linear";
import IconAdd from "~icons/solar/add-circle-linear";
import IconPrinter from "~icons/solar/printer-linear";
import { useNetworks } from "../data";
import IconDriver from "~icons/solar/server-square-linear";
import type { DriverRow, PrinterRow, WifiRow } from "../data/types";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { QueryRegion } from "../components/Region";
import { RoleGate } from "../components/RoleGate";
import { SkeletonBlock } from "../components/Skeleton";
import { formatDate } from "../lib/format";
import { useCan } from "../lib/member";
import { ApprovedDrivers } from "./networks/ApprovedDrivers";
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
        <GroupChips groups={w.groups} groupCount={w.groupCount} />
      </div>
      {canEdit ? (
        <Link className="rb-btn rb-btn--ghost dash-btn--sm" to={`/networks/wifi/${w._id}`} aria-label={`${s.edit} ${w.name}`}>
          {s.edit}
        </Link>
      ) : null}
    </li>
  );
}

function GroupChips({ groups, groupCount }: { groups: { _id: string; name: string }[]; groupCount: number }) {
  const shown = groups.slice(0, CHIPS);
  return (
    <span className="dash-net__chips">
      {groupCount === 0 ? (
        <span className="dash-list__meta">{s.noGroups}</span>
      ) : (
        <>
          {shown.map((g) => (
            <Link key={g._id} to={`/groups/${g._id}`} className="dash-chip dash-link--plain">
              {g.name}
            </Link>
          ))}
          {groupCount > shown.length ? <span className="dash-list__meta">{s.moreGroups(groupCount - shown.length)}</span> : null}
        </>
      )}
    </span>
  );
}

function PrinterItem({ p, canEdit }: { p: PrinterRow; canEdit: boolean }) {
  return (
    <li className="dash-list__item dash-net__item">
      <span className="dash-list__icon dash-list__icon--accent" aria-hidden="true">
        <IconPrinter />
      </span>
      <div className="dash-list__body">
        <Link className="dash-link dash-list__title dash-wrap" to={`/networks/printers/${p._id}`}>
          {p.name}
        </Link>
        <span className="dash-list__meta">
          {s.kindShort[p.kind]} · <span className="dash-mono dash-wrap">{p.address}</span>
          {p.kind === "raw" && p.port !== null ? <span className="dash-mono">{`:${p.port}`}</span> : null}
          {p.kind === "lpr" && p.queue !== null ? <span className="dash-mono">{` / ${p.queue}`}</span> : null}
        </span>
        <span className="dash-list__meta">
          {s.driverLabel}: {p.driver}
          {p.defaultGroupCount > 0 ? (
            <>
              {" "}
              <span className="dash-chip">{s.defaultBadge(p.defaultGroupCount)}</span>
            </>
          ) : null}
        </span>
        <GroupChips groups={p.groups} groupCount={p.groupCount} />
      </div>
      {canEdit ? (
        <Link className="rb-btn rb-btn--ghost dash-btn--sm" to={`/networks/printers/${p._id}`} aria-label={`${s.edit} ${p.name}`}>
          {s.edit}
        </Link>
      ) : null}
    </li>
  );
}

function DriverItem({ d, canEdit }: { d: DriverRow; canEdit: boolean }) {
  return (
    <li className="dash-list__item dash-net__item">
      <span className="dash-list__icon dash-list__icon--accent" aria-hidden="true">
        <IconDriver />
      </span>
      <div className="dash-list__body">
        <Link className="dash-link dash-list__title dash-wrap" to={`/networks/drivers/${d._id}`}>
          {d.name}
        </Link>
        <span className="dash-list__meta">
          <span className="dash-chip">{s.driverKindShort[d.kind]}</span> <span className="dash-chip">{s.driverClassShort[d.deviceClass]}</span>
        </span>
        {d.provides.length > 0 ? <span className="dash-list__meta dash-wrap">{s.driverProvidesLine(d.provides.join(", "))}</span> : null}
        <GroupChips groups={d.groups} groupCount={d.groupCount} />
      </div>
      {canEdit ? (
        <Link className="rb-btn rb-btn--ghost dash-btn--sm" to={`/networks/drivers/${d._id}`} aria-label={`${s.edit} ${d.name}`}>
          {s.edit}
        </Link>
      ) : null}
    </li>
  );
}

/**
 * `networks:list`: one subscription for the whole screen, Wi-Fi, printers and drivers (each section is its own Card). No passphrase and no
 * per-device counts here: those would re-run the list on every device report (the counts are on the detail pages).
 */
export default function Networks() {
  const state = useNetworks();
  const canAct = useCan("admin");
  const addWifi = (
    <RoleGate minRole="admin">
      <Link className="rb-btn rb-btn--primary" to="/networks/wifi/new">
        <IconAdd aria-hidden="true" />
        {s.newWifi}
      </Link>
    </RoleGate>
  );
  const addPrinter = (
    <RoleGate minRole="admin">
      <Link className="rb-btn rb-btn--primary" to="/networks/printers/new">
        <IconAdd aria-hidden="true" />
        {s.newPrinter}
      </Link>
    </RoleGate>
  );
  const addDriver = (
    <RoleGate minRole="admin">
      <Link className="rb-btn rb-btn--primary" to="/networks/drivers/new">
        <IconAdd aria-hidden="true" />
        {s.newDriver}
      </Link>
    </RoleGate>
  );
  const add = (
    <>
      {addWifi}
      {addPrinter}
      {addDriver}
    </>
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
          <div className="dash-stack">
            <Card title={s.wifiSection} body="flush">
              {data.wifi.length === 0 ? (
                <EmptyState icon={<IconWifi />} title={s.emptyTitle} body={s.emptyBody} action={addWifi} />
              ) : (
                <ul className="dash-list" aria-label={s.wifiSection}>
                  {data.wifi.map((w) => (
                    <WifiItem key={w._id} w={w} canEdit={canAct} />
                  ))}
                </ul>
              )}
            </Card>
            <Card title={s.printersSection} sub={s.printersLead} body="flush">
              {data.printers.length === 0 ? (
                <EmptyState icon={<IconPrinter />} title={s.emptyPrintersTitle} body={s.emptyPrintersBody} action={addPrinter} />
              ) : (
                <ul className="dash-list" aria-label={s.printersSection}>
                  {data.printers.map((p) => (
                    <PrinterItem key={p._id} p={p} canEdit={canAct} />
                  ))}
                </ul>
              )}
            </Card>
            <Card title={s.driversSection} sub={s.driversLead} body="flush">
              {data.drivers.length === 0 ? (
                <EmptyState icon={<IconDriver />} title={s.emptyDriversTitle} body={s.emptyDriversBody} action={addDriver} />
              ) : (
                <ul className="dash-list" aria-label={s.driversSection}>
                  {data.drivers.map((d) => (
                    <DriverItem key={d._id} d={d} canEdit={canAct} />
                  ))}
                </ul>
              )}
            </Card>
            <ApprovedDrivers added={data.addedDrivers} drivers={data.drivers} />
          </div>
        )}
      </QueryRegion>
    </div>
  );
}
