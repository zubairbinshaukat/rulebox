import { useMemo } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "@rulebox/ui";
import IconCheck from "~icons/solar/check-circle-linear";
import { useFailedInstallsPage } from "../../data";
import type { FailedInstallRow } from "../../data/types";
import { type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { Modal } from "../../components/Modal";
import { RelativeTime } from "../../components/RelativeTime";
import { ServerTable } from "../../components/ServerTable";
import { installDetail } from "../../lib/install";
import { useListPaging, useListView, type ListConfig } from "../../lib/listView";
import { strings } from "../../lib/strings";
import { overviewText as s } from "./text";

/** `overview:failedInstallsPage`: newest update first; "updated" is the only order the server knows. */
const FAILED_LIST: ListConfig = { sorts: ["updated"], defaultSort: { key: "updated", dir: "desc" }, storage: "local" };

/**
 * "See all": every failed install, one page at a time (10, 25 or 50), sortable by time. A chunk of its own: the Overview shows only
 * the newest five and loads this (and the table, pager and search box it needs) when someone asks for the rest. It subscribes to its
 * own page; the card on the Overview pauses its list while this is open, so only one list is read at a time.
 */
export default function FailedInstallsDialog({ count, onClose }: { count: number; onClose: () => void }) {
  const navigate = useNavigate();
  const paging = useListPaging(useListView(FAILED_LIST), { total: count });
  const failed = useFailedInstallsPage({ ...paging.query, enabled: count > 0 });
  const cols = useMemo<Column<FailedInstallRow>[]>(
    () => [
      {
        key: "app",
        header: s.colApp,
        primary: true,
        cell: (f) => (
          <span className="dash-cell-stack">
            <Link className="dash-link dash-link--plain dash-truncate" to={`/apps/${f.appId}`} title={f.appName}>
              {f.appName}
            </Link>
            <span className="dash-cell-sub" title={installDetail(f.detail)}>
              {installDetail(f.detail)}
            </span>
          </span>
        ),
      },
      {
        key: "device",
        header: s.colDevice,
        cell: (f) => (
          <Link className="dash-link dash-truncate" to={`/devices/${f.deviceId}`} title={f.deviceName}>
            {f.deviceName}
          </Link>
        ),
      },
      { key: "updated", header: s.colUpdated, sortable: true, sortDefaultDir: "desc", cell: (f) => <RelativeTime ms={f.updatedAt} /> },
    ],
    [],
  );
  return (
    <Modal open wide title={s.failedInstalls} onClose={onClose} actions={<Button onClick={onClose}>{strings.common.close}</Button>}>
      <ServerTable
        caption={s.failedInstalls}
        columns={cols}
        getKey={(f) => f._id}
        paging={paging}
        list={failed}
        total={count}
        onRowClick={(f) => {
          onClose();
          navigate(`/devices/${f.deviceId}`);
        }}
        empty={<EmptyState compact icon={<IconCheck />} title={s.failedInstallsNone} />}
        skeletonRows={3}
      />
    </Modal>
  );
}
