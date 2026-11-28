import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "@rulebox/ui";
import { useAppInstallSummary, useRetryApp } from "../../../data";
import { useAppInstalls } from "../../../data/apps";
import { INSTALL_STATES, type AppDetail, type AppInstallRow, type InstallCounts, type InstallState } from "../../../data/types";
import { Card } from "../../../components/Card";
import type { Column } from "../../../components/DataTable";
import { EmptyState } from "../../../components/EmptyState";
import { InstallStatePill } from "../../../components/InstallState";
import { QueryRegion } from "../../../components/Region";
import { RelativeTime } from "../../../components/RelativeTime";
import { RoleGate } from "../../../components/RoleGate";
import { ServerTable } from "../../../components/ServerTable";
import { SkeletonRows } from "../../../components/Skeleton";
import { messageFor } from "../../../lib/errors";
import { formatCount } from "../../../lib/format";
import { installDetail } from "../../../lib/install";
import { useListPaging, useListView, type ListConfig } from "../../../lib/listView";
import { appEditStrings as s } from "../../../lib/screenStrings/appEdit";
import { devicesStrings } from "../../../lib/screenStrings/devices";
import { installStrings } from "../../../lib/screenStrings/install";
import { installStateStrings } from "../../../lib/screenStrings/installState";
import { strings } from "../../../lib/strings";
import { useToast } from "../../../lib/toast";

/**
 * "Installs": the counts per state (`apps:installSummary`) and the PCs in the chosen state (`apps:installs`). Both queries start only
 * when this tab is open, so a page that is looked at on its Details tab reads none of it.
 */
export default function InstallsTab({ d }: { d: AppDetail }) {
  const summary = useAppInstallSummary(d._id);
  return (
    <QueryRegion state={summary} skeleton={<Card title={s.installStatus} body="none"><SkeletonRows rows={3} columns={3} /></Card>}>
      {(counts) => <InstallCard d={d} counts={counts} />}
    </QueryRegion>
  );
}

function InstallCard({ d, counts }: { d: AppDetail; counts: InstallCounts }) {
  const present = INSTALL_STATES.filter((st) => (counts[st] ?? 0) > 0);
  // `chosen` is only ever a click. Until then the first state with PCs is shown (`anchor`), and it stays on screen when another state
  // fills later: the view only moves when the user clicks, or when the state on screen has no PCs left.
  const [chosen, setState] = useState<InstallState | null>(null);
  const [anchor, setAnchor] = useState<InstallState | null>(null);
  const clicked = chosen !== null && present.includes(chosen) ? chosen : null;
  const picked = clicked ?? (anchor !== null && present.includes(anchor) ? anchor : (present[0] ?? null));
  if (clicked === null && anchor !== picked) setAnchor(picked);
  const state = picked ?? "installed";
  const retry = useRetryApp();
  const toast = useToast();
  const [retrying, setRetrying] = useState(false);
  if (present.length === 0) return <Card title={s.installStatus}><EmptyState compact title={s.installStatusNone} /></Card>;
  return (
    <div className="dash-split dash-split--aside-first apps-installs">
      <aside className="dash-split__aside">
        <Card
          title={s.installState}
          actions={
            (counts.failed ?? 0) > 0 ? (
              <RoleGate minRole="admin">
                <Button
                  variant="ghost"
                  className="dash-btn--sm"
                  disabled={retrying}
                  aria-busy={retrying}
                  onClick={() => {
                    setRetrying(true);
                    retry({ appId: d._id }).then(
                      () => {
                        setRetrying(false);
                        toast(installStrings.retried);
                      },
                      (e) => {
                        setRetrying(false);
                        toast(messageFor(e), "danger");
                      },
                    );
                  }}
                >
                  {installStrings.retry}
                </Button>
              </RoleGate>
            ) : undefined
          }
        >
          <div className="apps-states" role="group" aria-label={s.installState}>
            {present.map((st) => (
              <button key={st} type="button" className="dash-state-btn" aria-pressed={state === st} onClick={() => setState(st)}>
                {installStateStrings[st]}
                <span className="dash-state-btn__count">{formatCount(counts[st] ?? 0, 1000)}</span>
              </button>
            ))}
          </div>
          {counts.capped ? <p className="dash-list__meta">{s.installCapped}</p> : null}
        </Card>
      </aside>
      <div className="dash-split__main">
        <Card title={s.installStatus} body="none" className="dash-card--tight">
          <InstallList appId={d._id} state={state} />
        </Card>
      </div>
    </div>
  );
}

/** `apps:installs` sorts by time ("updated") only. Local state: the page also holds other lists. */
const INSTALLS_LIST: ListConfig = { sorts: ["updated"], defaultSort: { key: "updated", dir: "desc" }, storage: "local" };

function InstallList({ appId, state }: { appId: string; state: InstallState }) {
  const view = useListView(INSTALLS_LIST);
  // Another app or install state is another list: start over on its first page.
  const paging = useListPaging(view, { total: null, scope: `${appId}:${state}` });
  const rows = useAppInstalls(appId, state, paging.query);
  const cols = useMemo<Column<AppInstallRow>[]>(
    () => [
      {
        key: "device",
        header: devicesStrings.colName,
        primary: true,
        cell: (r) => (
          <Link className="dash-link dash-link--plain dash-truncate" to={`/devices/${r.deviceId}`}>
            {r.deviceName}
          </Link>
        ),
      },
      { key: "state", header: s.installState, cell: (r) => <InstallStatePill state={r.state} /> },
      {
        key: "version",
        header: s.installedVersion,
        isEmpty: (r) => r.installedVersion === undefined,
        cell: (r) => (r.installedVersion !== undefined ? <span className="dash-mono">{r.installedVersion}</span> : <span className="dash-muted">—</span>),
      },
      {
        key: "detail",
        header: strings.common.details,
        isEmpty: (r) => r.state !== "failed",
        cell: (r) =>
          r.state === "failed" ? (
            <span className="dash-muted" style={{ fontSize: 13 }}>
              {installDetail(r.detail)}
              {r.exitCode !== undefined ? ` · ${installStrings.exitCode(r.exitCode)}` : ""}
            </span>
          ) : (
            <span className="dash-muted">—</span>
          ),
      },
      { key: "updated", header: s.colUpdated, sortable: true, sortDefaultDir: "desc", cell: (r) => <RelativeTime ms={r.updatedAt} /> },
    ],
    [],
  );
  const navigate = useNavigate();
  return (
    <ServerTable<AppInstallRow>
      caption={s.installStatus}
      columns={cols}
      getKey={(r) => r._id}
      paging={paging}
      list={rows}
      total={null}
      skeletonRows={4}
      onRowClick={(r) => navigate(`/devices/${r.deviceId}`)}
      empty={<EmptyState compact title={s.installStatusNone} />}
    />
  );
}
