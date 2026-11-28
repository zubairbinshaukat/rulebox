import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button, Pill, NativeSelect } from "@rulebox/ui";
import IconMonitor from "~icons/solar/monitor-linear";
import IconAdd from "~icons/solar/add-square-linear";
import IconRefresh from "~icons/solar/refresh-linear";
import { useCheckNow, useCheckResult, useGroupsScreen } from "../data";
import { useDevicesCount, useDevicesScreen } from "../data/devices";
import { NO_GROUP_FILTER, type DeviceRow, type GroupRow, type QueryState } from "../data/types";
import { Card } from "../components/Card";
import { type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { RelativeTime } from "../components/RelativeTime";
import { RoleGate } from "../components/RoleGate";
import { ServerTable } from "../components/ServerTable";
import { SkeletonRows } from "../components/Skeleton";
import { DeviceOnline, KioskCell, PlanStateBadge, PolicyCell } from "../components/DeviceCells";
import { messageFor } from "../lib/errors";
import { useListPaging, useListView, type ListConfig } from "../lib/listView";
import { useCan } from "../lib/member";
import { devicesStrings } from "../lib/screenStrings/devices";
import { useToast } from "../lib/toast";
import { useNow } from "../lib/useNow";

const s = devicesStrings;

/** `MAX_CHECK_DEVICES` of convex/lib/limits.ts, and how long the result stays subscribed. */
const MAX_CHECK_DEVICES = 50;
const CHECK_WATCH_MS = 60_000;
/** `fleet:list`: newest first by default; the name is the other index-backed order. A search is ordered by relevance. */
const LIST: ListConfig = { sorts: ["created", "name"], defaultSort: { key: "created", dir: "desc" }, filters: ["group"] };

function columns(now: number): Column<DeviceRow>[] {
  return [
    {
      key: "name",
      header: s.colName,
      primary: true,
      sortable: true,
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
      nowrap: true,
      cell: (d) => <DeviceOnline presence={d.presence} now={now} />,
    },
    {
      key: "windows",
      header: s.colWindows,
      nowrap: true,
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
    { key: "kiosk", header: s.colKiosk, nowrap: true, cell: (d) => <KioskCell row={d} /> },
    { key: "created", header: s.colEnrolled, nowrap: true, sortable: true, sortDefaultDir: "desc", cell: (d) => <RelativeTime ms={d.enrolledAt} /> },
    {
      key: "policy",
      header: s.colPolicy,
      nowrap: true,
      cell: (d) => (
        <span className="dash-cell-stack">
          <PolicyCell applied={d.report?.appliedVersion} latest={d.latestVersion} />
          <PlanStateBadge planState={d.planState} />
        </span>
      ),
    },
  ];
}
/** Asks the visible PCs (the first 50, and the label says so) to call in; `fleet:checkNow` allows one request a minute per organization. */
function CheckNowButton({ ids, onStarted }: { ids: string[]; onStarted: (checkId: string) => void }) {
  const checkNow = useCheckNow();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="ghost"
      disabled={pending || ids.length === 0}
      aria-busy={pending}
      onClick={() => {
        setPending(true);
        checkNow({ deviceIds: ids.slice(0, MAX_CHECK_DEVICES) }).then(
          ({ checkId }) => {
            setPending(false);
            onStarted(checkId);
          },
          (e) => {
            setPending(false);
            toast(messageFor(e), "danger");
          },
        );
      }}
    >
      <IconRefresh aria-hidden="true" />
      {ids.length > MAX_CHECK_DEVICES ? s.checkNowFirst(MAX_CHECK_DEVICES) : s.checkNow}
    </Button>
  );
}

/** Subscribes to `fleet:checkResult` for 60 s, then lets go (plan 4.9). */
function CheckResultNotice({ checkId, onEnd }: { checkId: string; onEnd: () => void }) {
  const result = useCheckResult(checkId);
  useEffect(() => {
    const t = setTimeout(onEnd, CHECK_WATCH_MS);
    return () => clearTimeout(t);
  }, [onEnd]);
  if (result.status === "error") return <InlineNotice tone="danger" title={messageFor(result.error)} />;
  if (result.status === "loading") return <InlineNotice tone="neutral" title={s.checking} />;
  const answered = result.data.items.filter((i) => i.answered).length;
  const total = result.data.items.length;
  return <InlineNotice tone={answered === total ? "success" : "neutral"} title={s.checkResult(answered, total)} />;
}

/** `fleet:list` (one page; sort, search and group filter are its arguments); admins can "Check now" the visible PCs. */
export default function Devices() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("group") ?? "";
  const groups = useGroupsScreen();
  // `fleet:list` throws not_found for an id that is not a group of this organization (an old link, a deleted group):
  // such a value is dropped from the query and from the URL. Until the groups are known, a requested filter waits.
  const known =
    requested === NO_GROUP_FILTER || (groups.status === "ready" ? groups.data.some((g) => g._id === requested) : groups.status === "error");
  const stale = requested !== "" && groups.status === "ready" && !known;
  const groupId = known ? requested : "";
  useEffect(() => {
    if (!stale) return;
    const next = new URLSearchParams(params);
    next.delete("group");
    setParams(next, { replace: true });
  }, [stale, params, setParams]);

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
      {requested && requested !== NO_GROUP_FILTER && groups.status === "loading" ? (
        <Card body="none">
          <SkeletonRows rows={8} columns={5} />
        </Card>
      ) : (
        <DeviceList groupId={groupId} groups={groups} />
      )}
    </div>
  );
}

function DeviceList({ groupId, groups }: { groupId: string; groups: QueryState<GroupRow[]> }) {
  const navigate = useNavigate();
  // The count needs the applied search; the pager needs the count.
  const view = useListView(LIST);
  const total = useDevicesCount({ groupId: groupId || undefined, search: view.search });
  const paging = useListPaging(view, { total });
  const devices = useDevicesScreen({ ...paging.query, groupId: groupId || undefined });
  const now = useNow(30_000);
  const cols = useMemo(() => columns(now), [now]);
  const [checkId, setCheckId] = useState<string | null>(null);
  const endCheck = useCallback(() => setCheckId(null), []);
  const canCheck = useCan("admin");
  const rows = devices.status === "ready" ? devices.items : [];

  const filters = (
    <>
      <label className="dash-sr" htmlFor="device-group-filter">
        {s.groupFilter}
      </label>
      <NativeSelect id="device-group-filter" compact value={groupId} onChange={(e) => paging.view.setFilter("group", e.target.value || null)}>
        <option value="">{s.allGroups}</option>
        <option value={NO_GROUP_FILTER}>{s.noGroupFilter}</option>
        {groups.status === "ready" ? groups.data.map((g) => <option key={g._id} value={g._id}>{g.name}</option>) : null}
      </NativeSelect>
    </>
  );

  return (
    <>
      {canCheck && devices.status === "ready" && rows.length > 0 ? (
        <div className="dash-row" style={{ justifyContent: "flex-end" }}>
          <CheckNowButton ids={rows.filter((d) => !d.revoked).map((d) => d._id)} onStarted={setCheckId} />
        </div>
      ) : null}
      {checkId ? <CheckResultNotice key={checkId} checkId={checkId} onEnd={endCheck} /> : null}
      <ServerTable
        framed
        caption={s.title}
        columns={cols}
        getKey={(d) => d._id}
        paging={paging}
        list={devices}
        total={total ?? null}
        search={{ label: s.searchLabel, placeholder: s.searchPlaceholder }}
        sortByRelevanceWhenSearching
        filters={filters}
        isDim={(d) => d.revoked}
        onRowClick={(d) => navigate(`/devices/${d._id}`)}
        empty={
          groupId ? (
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
        }
      />
    </>
  );
}
