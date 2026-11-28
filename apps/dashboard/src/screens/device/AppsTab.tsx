import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useRetryApp } from "../../data";
import { useDeviceInstalls } from "../../data/devices";
import type { DeviceInstallRow, DevicePage } from "../../data/types";
import { Card } from "../../components/Card";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import type { Column, RowAction } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { InstallStatePill } from "../../components/InstallState";
import { RelativeTime } from "../../components/RelativeTime";
import { ServerTable } from "../../components/ServerTable";
import { installDetail } from "../../lib/install";
import { useListPaging, useListView, type ListConfig } from "../../lib/listView";
import { useCan } from "../../lib/member";
import { appEditStrings } from "../../lib/screenStrings/appEdit";
import { appsStrings } from "../../lib/screenStrings/apps";
import { installStrings } from "../../lib/screenStrings/install";
import { strings } from "../../lib/strings";
import { useToast } from "../../lib/toast";
import { deviceText as t } from "./strings";

/** `fleet:installs`: newest update first, the only order the server knows; no total (one page at a time). */
const INSTALLS_LIST: ListConfig = { sorts: ["updated"], defaultSort: { key: "updated", dir: "desc" }, storage: "local" };

/**
 * The Apps tab: the install results of this PC (`fleet:installs`, one page at a time), with Retry for a failed one. It is its own chunk
 * and subscribes only while it is open.
 */
export default function AppsTab({ d }: { d: Pick<DevicePage, "_id" | "group"> }) {
  const navigate = useNavigate();
  const paging = useListPaging(useListView(INSTALLS_LIST), { total: null });
  const installs = useDeviceInstalls(d._id, paging.query);
  const retry = useRetryApp();
  const toast = useToast();
  const canAct = useCan("admin");
  const [confirming, setConfirming] = useState<DeviceInstallRow | null>(null);
  // Retry restarts the app for every PC (confirmed first); an app that cannot be retried keeps the button, disabled, with the reason.
  const actionsOf = (i: DeviceInstallRow): RowAction[] =>
    canAct && i.state === "failed"
      ? [{ label: installStrings.retry, onSelect: () => setConfirming(i), disabled: i.retryable === false, hint: i.retryable === false ? installStrings.retryUnavailable : undefined }]
      : [];
  const cols: Column<DeviceInstallRow>[] = [
    {
      key: "app",
      header: appsStrings.colName,
      primary: true,
      type: "name",
      cell: (i) => (
        <Link className="dash-link dash-link--plain dash-truncate" to={`/apps/${i.appId}`}>
          {i.appName}
        </Link>
      ),
    },
    { key: "state", header: appEditStrings.installState, type: "badge", card: "status", cell: (i) => <InstallStatePill state={i.state} /> },
    {
      key: "detail",
      header: strings.common.details,
      type: "text",
      card: "detail",
      cardLabel: false,
      isEmpty: (i) => i.state !== "failed",
      cell: (i) => (i.state === "failed" ? <span className="dash-muted" style={{ fontSize: 13 }}>{installDetail(i.detail)}</span> : null),
    },
    { key: "updated", header: t.colUpdated, type: "date", card: "fact", sortable: true, sortDefaultDir: "desc", cell: (i) => <RelativeTime ms={i.updatedAt} /> },
    { key: "act", header: strings.common.actions, actions: true, rowActions: actionsOf, isEmpty: (i) => actionsOf(i).length === 0, cell: () => null },
  ];  return (
    <Card title={t.appsTitle} body="none" className="dash-card--tight">
      {/* `apps:retry` restarts the app for every PC, so it is confirmed first. */}
      <ConfirmDialog
        open={confirming !== null}
        title={installStrings.retryConfirmTitle(confirming?.appName ?? "")}
        body={installStrings.retryConfirmBody(confirming?.appName ?? "")}
        confirmLabel={installStrings.retryConfirmAction}
        onConfirm={() => retry({ appId: confirming?.appId ?? "" })}
        onDone={() => toast(installStrings.retried)}
        onClose={() => setConfirming(null)}
      />
      <ServerTable
        caption={t.appsTitle}
        columns={cols}
        getKey={(i) => i._id}
        rowLabel={(i) => i.appName}
        paging={paging}
        list={installs}
        total={null}
        onRowClick={(i) => navigate(`/apps/${i.appId}`)}
        empty={
          <EmptyState
            compact
            title={t.appsNone}
            body={canAct && d.group ? t.appsNoneGroup : undefined}
            action={
              canAct && d.group ? (
                <Link className="rb-btn rb-btn--ghost" to={`/groups/${d.group._id}`}>
                  {t.appsOpenGroup}
                </Link>
              ) : undefined
            }
          />
        }
        skeletonRows={3}
      />
    </Card>
  );
}
