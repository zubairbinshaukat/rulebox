import type { ReactNode } from "react";
import { Link } from "react-router";
import { Pill } from "@rulebox/ui";
import IconWifi from "~icons/solar/wi-fi-router-minimalistic-linear";
import IconAdd from "~icons/solar/add-circle-linear";
import IconPrinter from "~icons/solar/printer-linear";
import IconDriver from "~icons/solar/server-square-linear";
import { useNetworks } from "../data";
import type { DriverRow, PrinterRow, WifiRow } from "../data/types";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { QueryRegion } from "../components/Region";
import { RoleGate } from "../components/RoleGate";
import { SkeletonBlock } from "../components/Skeleton";
import { useCan } from "../lib/member";
import { ApprovedDrivers } from "./networks/ApprovedDrivers";
import { printerHost } from "./networks/model";
import { EmptyRow, RecordCard, SectionCard } from "./networks/RecordCard";
import { networksStrings as s } from "./networks/strings";
import "./networks/networks.css";

function WifiCard({ w }: { w: WifiRow }) {
  const pill =
    w.security === "open" ? (
      <Pill>{s.openNetwork}</Pill>
    ) : w.hasPassphrase ? (
      <Pill tone="success" dot>
        {s.passwordSet}
      </Pill>
    ) : (
      <Pill tone="warning" dot>
        {s.needsPassword}
      </Pill>
    );
  // The Wi-Fi name only when it says more than the card's own title; the security type stays on the detail page.
  const parts: ReactNode[] = [];
  if (w.ssid !== w.name) parts.push(<span key="ssid" className="dash-mono net-rec__ssid">{w.ssid}</span>);
  if (w.hidden) parts.push(<span key="hidden">{s.hidden}</span>);
  return (
    <RecordCard
      to={`/networks/wifi/${w._id}`}
      icon={<IconWifi />}
      title={w.name}
      pill={pill}
      sub={parts.length > 0 ? joined(parts) : undefined}
      groups={w.groups}
      groupCount={w.groupCount}
    />
  );
}

function PrinterCard({ p }: { p: PrinterRow }) {
  return (
    <RecordCard
      to={`/networks/printers/${p._id}`}
      icon={<IconPrinter />}
      title={p.name}
      pill={p.defaultGroupCount > 0 ? <Pill tone="accent">{s.defaultPill}</Pill> : undefined}
      sub={
        <>
          {s.printerKindCard[p.kind]} · <span className="dash-mono net-rec__ssid">{printerHost(p.kind, p.address)}</span>
        </>
      }
      groups={p.groups}
      groupCount={p.groupCount}
    />
  );
}

function DriverCard({ d }: { d: DriverRow }) {
  return (
    <RecordCard
      to={`/networks/drivers/${d._id}`}
      icon={<IconDriver />}
      title={d.name}
      sub={s.driverClassCard[d.deviceClass]}
      groups={d.groups}
      groupCount={d.groupCount}
    />
  );
}

/** " · " between the parts of a card's muted line. */
function joined(parts: ReactNode[]): ReactNode {
  return parts.flatMap((p, i) => (i === 0 ? [p] : [<span key={`dot${i}`}> · </span>, p]));
}

/**
 * `networks:list`: one subscription for the whole screen, Wi-Fi, printers and drivers (each section is its own card). No passphrase and no
 * per-device counts here: those would re-run the list on every device report (the counts are on the detail pages).
 */
export default function Networks() {
  const state = useNetworks();
  const canAct = useCan("admin");
  const addLink = (to: string, label: string) => (
    <RoleGate minRole="admin">
      <Link className="rb-btn rb-btn--ghost dash-btn--sm" to={to} aria-label={label}>
        <IconAdd aria-hidden="true" />
        {s.add}
      </Link>
    </RoleGate>
  );
  return (
    <div className="dash-page net-page">
      <PageHeader
        title={s.title}
        lead={s.lead}
        actions={
          <RoleGate minRole="admin">
            <Link className="rb-btn rb-btn--primary" to="/networks/wifi/new">
              <IconAdd aria-hidden="true" />
              {s.addWifi}
            </Link>
          </RoleGate>
        }
      />
      {!canAct ? <InlineNotice tone="neutral" title={s.readOnly} /> : null}
      <QueryRegion
        state={state}
        skeleton={
          <div className="net-grid" aria-label={s.loadingList}>
            <div className="dash-card dash-card--pad net-grid__wifi">
              <SkeletonBlock lines={4} />
            </div>
            <div className="dash-card dash-card--pad net-grid__printers">
              <SkeletonBlock lines={3} />
            </div>
            <div className="dash-card dash-card--pad net-grid__drivers">
              <SkeletonBlock lines={2} />
            </div>
          </div>
        }
      >
        {(data) => (
          <div className="net-grid">
            <SectionCard
              className="net-grid__wifi"
              name={s.wifiSection}
              icon={<IconWifi />}
              count={data.wifi.length}
              info={s.wifiInfo}
              add={data.wifi.length > 0 ? addLink("/networks/wifi/new", s.addWifiShort) : undefined}
            >
              {data.wifi.length === 0 ? (
                <EmptyRow icon={<IconWifi />} text={s.emptyWifi} action={canAct ? addLink("/networks/wifi/new", s.addWifiShort) : undefined} />
              ) : (
                <ul className="net-list" aria-label={s.wifiSection}>
                  {data.wifi.map((w) => (
                    <WifiCard key={w._id} w={w} />
                  ))}
                </ul>
              )}
            </SectionCard>
            <SectionCard
              className="net-grid__printers"
              name={s.printersSection}
              icon={<IconPrinter />}
              count={data.printers.length}
              info={s.printersInfo}
              add={data.printers.length > 0 ? addLink("/networks/printers/new", s.addPrinterShort) : undefined}
            >
              {data.printers.length === 0 ? (
                <EmptyRow icon={<IconPrinter />} text={s.emptyPrinters} action={canAct ? addLink("/networks/printers/new", s.addPrinterShort) : undefined} />
              ) : (
                <ul className="net-list" aria-label={s.printersSection}>
                  {data.printers.map((p) => (
                    <PrinterCard key={p._id} p={p} />
                  ))}
                </ul>
              )}
            </SectionCard>
            <SectionCard
              className="net-grid__drivers net-sec--quiet"
              name={s.driversSection}
              icon={<IconDriver />}
              count={data.drivers.length}
              info={s.driversInfo}
              add={data.drivers.length > 0 ? addLink("/networks/drivers/new", s.addDriverShort) : undefined}
            >
              {data.drivers.length === 0 ? (
                <EmptyRow icon={<IconDriver />} text={s.emptyDrivers} sub={s.emptyDriversSub} action={canAct ? addLink("/networks/drivers/new", s.addDriverShort) : undefined} />
              ) : (
                <ul className="net-list" aria-label={s.driversSection}>
                  {data.drivers.map((d) => (
                    <DriverCard key={d._id} d={d} />
                  ))}
                </ul>
              )}
              <ApprovedDrivers added={data.addedDrivers} drivers={data.drivers} />
            </SectionCard>
          </div>
        )}
      </QueryRegion>
    </div>
  );
}
