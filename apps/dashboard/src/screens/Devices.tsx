import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Pill, Select } from "@rulebox/ui";
import IconMonitor from "~icons/solar/monitor-linear";
import IconAdd from "~icons/solar/add-square-linear";
import { useDevicesScreen, useGroupsScreen, useLiveStatus } from "../data";
import type { DeviceRow, LiveStatus } from "../data/types";
import { Card } from "../components/Card";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { LoadMore } from "../components/LoadMore";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { PagedRegion } from "../components/Region";
import { RoleGate } from "../components/RoleGate";
import { SearchInput } from "../components/SearchInput";
import { SkeletonRows } from "../components/Skeleton";
import { DeviceOnline, KioskCell, PolicyCell } from "../components/DeviceCells";
import { strings } from "../lib/strings";
import { useDebounced } from "../lib/useDebounced";
import { useNow } from "../lib/useNow";

const s = strings.devices;

function columns(live: Map<string, number>, pingIntervalMs: number | undefined, now: number): Column<DeviceRow>[] {
  return [
    {
      key: "name",
      header: s.colName,
      primary: true,
      cell: (d) => (
        <span className="dash-cell-stack">
          <Link className="dash-link dash-link--plain dash-truncate" to={`/devices/${d._id}`} title={d.name}>
            {d.name}
          </Link>
          {d.groupName ? (
            <span className="dash-cell-sub" title={d.groupName}>
              {d.groupName}
            </span>
          ) : (
            <span>
              <Pill tone="warning">{s.noGroup}</Pill>
            </span>
          )}
        </span>
      ),
    },
    {
      key: "status",
      header: s.colStatus,
      cell: (d) => <DeviceOnline lastSeenAt={live.get(d._id)} pingIntervalMs={pingIntervalMs} now={now} />,
    },
    {
      key: "windows",
      header: s.colWindows,
      isEmpty: (d) => !d.report?.osBuild,
      cell: (d) =>
        d.report?.osBuild ? (
          <span className="dash-cell-stack">
            <span className="dash-row" style={{ gap: 6, flexWrap: "nowrap" }}>
              <span className="dash-mono">{d.report.osBuild}</span>
              {d.report.outOfSupport ? <Pill tone="danger">{s.outOfSupport}</Pill> : null}
            </span>
            <span className="dash-cell-sub">
              {s.colAgent} <span className="dash-mono">{d.report.agentVersion ?? "—"}</span>
            </span>
          </span>
        ) : (
          <span className="dash-muted">—</span>
        ),
    },
    { key: "kiosk", header: s.colKiosk, cell: (d) => <KioskCell row={d} /> },
    {
      key: "policy",
      header: s.colPolicy,
      cell: (d) => <PolicyCell applied={d.report?.appliedVersion} latest={d.latestVersion} />,
    },
  ];
}
/** `fleet:list` (+ `fleet:liveStatus` for the loaded ids, `fleet:search` while searching). */
export default function Devices() {
  const [params, setParams] = useSearchParams();
  const groupId = params.get("group") ?? "";
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search.trim(), 250);
  const groups = useGroupsScreen();
  const devices = useDevicesScreen({ groupId: groupId || undefined, search: debounced || undefined });
  const ids = useMemo(() => (devices.status === "ready" ? devices.items.map((d) => d._id).slice(0, 100) : []), [devices]);
  const liveStatus: LiveStatus | undefined = useLiveStatus(ids);
  const now = useNow(30_000);
  const live = useMemo(() => new Map(liveStatus?.items.map((i) => [i.deviceId, i.lastSeenAt]) ?? []), [liveStatus]);
  const cols = useMemo(() => columns(live, liveStatus?.pingIntervalMs, now), [live, liveStatus?.pingIntervalMs, now]);
  const filtered = Boolean(groupId || debounced);

  return (
    <div className="dash-page">
      <PageHeader
        title={s.title}
        lead={s.lead}
        actions={
          <RoleGate minRole="admin">
            <Link to="/enrollment" className="rb-btn rb-btn--primary">
              <IconAdd aria-hidden="true" />
              {s.addPc}
            </Link>
          </RoleGate>
        }
      />
      <div className="dash-filters">
        <SearchInput value={search} onChange={setSearch} label={s.searchLabel} placeholder={s.searchPlaceholder} />
        <label className="dash-sr" htmlFor="device-group-filter">
          {s.groupFilter}
        </label>
        <Select
          id="device-group-filter"
          compact
          value={groupId}
          onChange={(e) => {
            const next = new URLSearchParams(params);
            if (e.target.value) next.set("group", e.target.value);
            else next.delete("group");
            setParams(next, { replace: true });
          }}
        >
          <option value="">{s.allGroups}</option>
          <option value="none">{s.noGroup}</option>
          {groups.status === "ready" ? groups.data.map((g) => <option key={g._id} value={g._id}>{g.name}</option>) : null}
        </Select>
      </div>
      <Card body="none">
        <PagedRegion state={devices} skeleton={<SkeletonRows rows={8} columns={5} />}>
          {(d) =>
            d.items.length === 0 ? (
              filtered ? (
                <EmptyState icon={<IconMonitor />} title={s.noMatchTitle} body={s.noMatchBody} />
              ) : (
                <EmptyState
                  icon={<IconMonitor />}
                  title={s.emptyTitle}
                  body={s.emptyBody}
                  action={
                    <RoleGate minRole="admin">
                      <Link to="/enrollment" className="rb-btn rb-btn--primary">
                        {s.emptyAction}
                      </Link>
                    </RoleGate>
                  }
                />
              )
            ) : (
              <>
                {"searchCapped" in devices && devices.searchCapped ? (
                  <div style={{ padding: 12 }}>
                    <InlineNotice tone="neutral" title={s.searchCap} />
                  </div>
                ) : null}
                <DataTable caption={s.title} columns={cols} rows={d.items} getKey={(r) => r._id} isDim={(r) => r.revoked} />
                <LoadMore shown={d.items.length} canLoadMore={d.canLoadMore} isLoadingMore={d.isLoadingMore} loadMore={d.loadMore} />
              </>
            )
          }
        </PagedRegion>
      </Card>
    </div>
  );
}
