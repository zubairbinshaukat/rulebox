import type { PillTone } from "@rulebox/ui";
import { Pill } from "@rulebox/ui";
import { useDeviceNetwork } from "../../data/devices";
import type { DevicePage, NetworkItemState } from "../../data/types";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { QueryRegion } from "../../components/Region";
import { SkeletonBlock } from "../../components/Skeleton";
import { networkStrings as s } from "./networkStrings";

const TONES: Record<NetworkItemState, PillTone> = { working: "success", failed: "danger", waiting: "neutral", notSupported: "warning" };

interface Item {
  id: string;
  name: string;
  state: NetworkItemState;
  badge?: string;
}

function ItemList({ title, items, empty }: { title: string; items: Item[]; empty: string }) {
  return (
    <Card title={title}>
      {items.length === 0 ? (
        <EmptyState compact title={empty} />
      ) : (
        <ul className="dev-items" aria-label={title}>
          {items.map((i) => (
            <li key={i.id} className="dev-items__row">
              <span className="dev-items__name">
                {i.name}
                {i.badge ? <span className="dev-items__badge">{i.badge}</span> : null}
              </span>
              <Pill tone={TONES[i.state]} dot>
                {s.state[i.state]}
              </Pill>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * STUB (UI pass step 10 replaces it): the Wi-Fi networks, printers and drivers of this PC's group with their state on this PC
 * (`fleet:network`, subscribed only while this tab is open). Names and states only; the detail codes and the "Add one" links
 * are the real tab's job.
 */
export default function NetworkTab({ d }: { d: Pick<DevicePage, "_id"> }) {
  const net = useDeviceNetwork(d._id);
  return (
    <QueryRegion
      state={net}
      skeleton={
        <div className="dash-grid dash-grid--3">
          <Card>
            <SkeletonBlock lines={4} />
          </Card>
          <Card>
            <SkeletonBlock lines={4} />
          </Card>
          <Card>
            <SkeletonBlock lines={4} />
          </Card>
        </div>
      }
    >
      {(n) =>
        n.groupId === null ? (
          <EmptyState title={s.noGroup} />
        ) : (
          <div className="dash-grid dash-grid--3">
            <ItemList title={s.wifi} empty={s.noneWifi} items={n.wifi.map((w) => ({ id: w._id, name: w.name, state: w.state }))} />
            <ItemList
              title={s.printers}
              empty={s.nonePrinters}
              items={n.printers.map((p) => ({ id: p._id, name: p.name, state: p.state, badge: p.isDefault ? s.defaultPrinter : undefined }))}
            />
            <ItemList title={s.drivers} empty={s.noneDrivers} items={n.drivers.map((x) => ({ id: x._id, name: x.name, state: s.driverState(x.state) }))} />
          </div>
        )
      }
    </QueryRegion>
  );
}
