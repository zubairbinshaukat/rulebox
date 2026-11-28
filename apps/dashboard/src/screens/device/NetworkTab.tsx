import type { ComponentType, SVGProps } from "react";
import { Link } from "react-router";
import { InfoTip, Pill, type PillTone } from "@rulebox/ui";
import IconDriver from "~icons/solar/cpu-linear";
import IconPrinter from "~icons/solar/printer-linear";
import IconWifi from "~icons/solar/wi-fi-linear";
import { useDeviceNetwork } from "../../data/devices";
import type { DeviceNetwork, DevicePage, NetworkItemState } from "../../data/types";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { InlineNotice } from "../../components/Notice";
import { QueryRegion } from "../../components/Region";
import { RelativeTime } from "../../components/RelativeTime";
import { SkeletonBlock } from "../../components/Skeleton";
import { useCan } from "../../lib/member";
import { TechnicalDetails } from "./TechnicalDetails";
import { networkDetailText, networkStrings as s, type NetworkKind } from "./networkStrings";

const TONES: Record<NetworkItemState, PillTone> = { working: "success", failed: "danger", waiting: "neutral", notSupported: "warning" };
const ICONS: Record<NetworkKind, ComponentType<SVGProps<SVGSVGElement>>> = { wifi: IconWifi, printers: IconPrinter, drivers: IconDriver };
const NEW_PAGE: Record<NetworkKind, string> = { wifi: "/networks/wifi/new", printers: "/networks/printers/new", drivers: "/networks/drivers/new" };

interface Item {
  id: string;
  name: string;
  state: NetworkItemState;
  detail: string | null;
  badge?: string;
}

/** The card's one-word summary: the worst thing first. */
function summaryOf(items: Item[]): { tone: PillTone; text: string } | null {
  if (items.length === 0) return null;
  const count = (state: NetworkItemState) => items.filter((i) => i.state === state).length;
  if (count("failed") > 0) return { tone: "danger", text: s.summary.failed(count("failed")) };
  if (count("notSupported") > 0) return { tone: "warning", text: s.summary.notSupported(count("notSupported")) };
  if (count("waiting") > 0) return { tone: "neutral", text: s.summary.waiting(count("waiting")) };
  return { tone: "success", text: s.summary.allWorking };
}

function ItemCard({ kind, title, items, admin }: { kind: NetworkKind; title: string; items: Item[]; admin: boolean }) {
  const summary = summaryOf(items);
  const Glyph = ICONS[kind];
  return (
    <Card
      title={title}
      className={`net-card net-card--${kind}`}
      actions={
        <>
          {summary ? <Pill tone={summary.tone}>{summary.text}</Pill> : null}
          <InfoTip label={`About ${title}`}>{s.setUpOn}</InfoTip>
        </>
      }
    >
      {items.length === 0 ? (
        <EmptyState
          compact
          icon={<Glyph />}
          title={s.none[kind]}
          action={
            admin ? (
              <Link className="rb-btn rb-btn--ghost" to={NEW_PAGE[kind]}>
                {s.addOne}
              </Link>
            ) : undefined
          }
        />
      ) : (
        <ul className="net-items" aria-label={title}>
          {items.map((i) => {
            const text = i.state === "waiting" ? s.waitingLine : networkDetailText(kind, i.detail, i.state);
            return (
              <li key={i.id} className="net-item" data-state={i.state}>
                <span className="net-item__icon" aria-hidden="true">
                  <Glyph />
                </span>
                <div className="net-item__text">
                  <span className="net-item__name">
                    {i.name}
                    {i.badge ? <span className="net-item__badge">{i.badge}</span> : null}
                  </span>
                  {text ? <span className="net-item__detail">{text}</span> : null}
                  {i.detail !== null && (i.state === "failed" || i.state === "notSupported") ? (
                    <TechnicalDetails className="net-item__tech" items={[{ label: s.techCode, value: i.detail }]} />
                  ) : null}
                </div>
                <Pill tone={TONES[i.state]} dot>
                  {s.state[i.state]}
                </Pill>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function Skeleton() {
  return (
    <div className="net-grid">
      {[0, 1, 2].map((i) => (
        <Card key={i}>
          <SkeletonBlock lines={4} />
        </Card>
      ))}
    </div>
  );
}

/**
 * The Network tab (UI pass step 10): the Wi-Fi networks, printers and drivers of this PC's group with their state on this PC
 * (`fleet:network`, subscribed only while this tab is open). A failure says why in words; the agent's code is under "Technical
 * details". Two columns on a laptop (Drivers spans the second row), three on a wide screen, one on a phone.
 */
export default function NetworkTab({ d }: { d: Pick<DevicePage, "_id"> }) {
  const net = useDeviceNetwork(d._id);
  const admin = useCan("admin");
  return (
    <QueryRegion state={net} skeleton={<Skeleton />}>
      {(n) => <Loaded n={n} admin={admin} />}
    </QueryRegion>
  );
}

function Loaded({ n, admin }: { n: DeviceNetwork; admin: boolean }) {
  if (n.groupId === null) {
    return <EmptyState title={s.noGroup} />;
  }
  const wifi: Item[] = n.wifi.map((w) => ({ id: w._id, name: w.name, state: w.state, detail: w.detail }));
  const printers: Item[] = n.printers.map((p) => ({ id: p._id, name: p.name, state: p.state, detail: p.detail, badge: p.isDefault ? s.defaultPrinter : undefined }));
  const drivers: Item[] = n.drivers.map((x) => ({ id: x._id, name: x.name, state: s.driverState(x.state), detail: x.detail }));
  const any = wifi.length + printers.length + drivers.length > 0;
  return (
    <div className="net">
      <div className="net-head">
        <p className="net-head__lead">
          {s.lead}{" "}
          {n.reportedAt === null ? null : (
            <span className="net-head__when">
              {s.lastReport} <RelativeTime ms={n.reportedAt} />.
            </span>
          )}
        </p>
        {admin ? (
          <Link className="rb-btn rb-btn--ghost" to="/networks">
            {s.openNetworks}
          </Link>
        ) : null}
      </div>
      {any && n.reportedAt === null ? <InlineNotice tone="neutral" title={s.notReported} /> : null}
      <div className="net-grid">
        <ItemCard kind="wifi" title={s.wifi} items={wifi} admin={admin} />
        <ItemCard kind="printers" title={s.printers} items={printers} admin={admin} />
        <ItemCard kind="drivers" title={s.drivers} items={drivers} admin={admin} />
      </div>
    </div>
  );
}
