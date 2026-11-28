import { useMemo } from "react";
import { Link, useNavigate } from "react-router";
import IconAdd from "~icons/solar/add-square-linear";
import IconMonitor from "~icons/solar/monitor-linear";
import { useDevicesScreen } from "../../data/devices";
import type { DeviceRow } from "../../data/types";
import type { Column } from "../../components/DataTable";
import { DeviceOnline, KioskCell, PlanStateBadge, PolicyCell } from "../../components/DeviceCells";
import { EmptyState } from "../../components/EmptyState";
import { RelativeTime } from "../../components/RelativeTime";
import { RoleGate } from "../../components/RoleGate";
import { ServerTable } from "../../components/ServerTable";
import { useListPaging, useListView, type ListConfig } from "../../lib/listView";
import { useNow } from "../../lib/useNow";
import { groupPage as t } from "./strings";

/**
 * `fleet:list({ groupId })`: newest first by default, the name the other index-backed order. The list's state lives in this tab
 * (`local`), so the page's address stays short and the People tab has its own.
 */
const LIST: ListConfig = { sorts: ["created", "name"], defaultSort: { key: "created", dir: "desc" }, storage: "local" };

/** The PCs tab: the group's PCs as a table or as cards, searchable, one page at a time. Loads (and subscribes) only while it is open. */
export default function PcsTab({ groupId }: { groupId: string }) {
  const navigate = useNavigate();
  const now = useNow(30_000);
  // `fleet:count` has no counter for one group, so the pager shows Previous / Next and "Page N" only.
  const paging = useListPaging(useListView(LIST), { total: null, scope: groupId });
  const devices = useDevicesScreen({ ...paging.query, groupId });
  const addUrl = `/enrollment?group=${encodeURIComponent(groupId)}`;

  const cols = useMemo<Column<DeviceRow>[]>(
    () => [
      {
        key: "name",
        header: t.pcs.colName,
        primary: true,
        sortable: true,
        cell: (d) => (
          <Link className="dash-link dash-link--plain dash-truncate" to={`/devices/${d._id}`} title={d.name}>
            {d.name}
          </Link>
        ),
      },
      { key: "status", header: t.pcs.colStatus, nowrap: true, card: "status", isEmpty: (d) => d.revoked, cell: (d) => <DeviceOnline presence={d.presence} now={now} /> },
      { key: "kiosk", header: t.pcs.colKiosk, nowrap: true, card: "status", cell: (d) => <KioskCell row={d} /> },
      { key: "created", header: t.pcs.colAdded, type: "date", sortable: true, sortDefaultDir: "desc", card: "fact", cell: (d) => <RelativeTime ms={d.enrolledAt} /> },
      {
        key: "policy",
        header: t.pcs.colSettings,
        nowrap: true,
        card: "fact",
        cell: (d) => (
          <span className="dash-cell-stack">
            <PolicyCell applied={d.report?.appliedVersion} latest={d.latestVersion} />
            <PlanStateBadge planState={d.planState} />
          </span>
        ),
      },
    ],
    [now],
  );

  const add = (
    <RoleGate minRole="admin">
      <Link to={addUrl} className="rb-btn rb-btn--ghost">
        <IconAdd aria-hidden="true" />
        {t.pcs.add}
      </Link>
    </RoleGate>
  );

  return (
    <ServerTable
      framed
      caption={t.pcs.caption}
      columns={cols}
      getKey={(d) => d._id}
      rowLabel={(d) => d.name}
      paging={paging}
      list={devices}
      total={null}
      search={{ label: t.pcs.searchLabel, placeholder: t.pcs.searchPlaceholder }}
      sortByRelevanceWhenSearching
      toolbarEnd={add}
      isDim={(d) => d.revoked}
      onRowClick={(d) => navigate(`/devices/${d._id}`)}
      empty={<EmptyState icon={<IconMonitor />} title={t.pcs.noneTitle} body={t.pcs.noneBody} />}
      skeletonRows={4}
    />
  );
}
