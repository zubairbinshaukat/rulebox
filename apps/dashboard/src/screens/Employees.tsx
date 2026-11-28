import { useMemo } from "react";
import { Link, useNavigate } from "react-router";
import { Pill, NativeSelect } from "@rulebox/ui";
import IconUsers from "~icons/solar/users-group-rounded-linear";
import IconUserPlus from "~icons/solar/user-plus-rounded-linear";
import { useGroupsScreen } from "../data";
import { useEmployeesCount, useEmployeesScreen } from "../data/employees";
import type { EmployeeRow } from "../data/types";
import { type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { RoleGate } from "../components/RoleGate";
import { ServerTable } from "../components/ServerTable";
import { StatusDot } from "../components/StatusDot";
import { formatGb } from "../lib/format";
import { useListPaging, useListView, type ListConfig, type ListPaging } from "../lib/listView";
import { devicesStrings } from "../lib/screenStrings/devices";
import { employeesStrings } from "../lib/screenStrings/employees";

const s = employeesStrings;

/**
 * `employees:list`: newest first by default (no column of its own: the row has no date), `name` and `username`
 * are the other index-backed orders. With a group filter the server only knows "added to the group", i.e. the default.
 */
const LIST: ListConfig = { sorts: ["created", "name", "username"], defaultSort: { key: "created", dir: "desc" }, filters: ["group"] };

function quotaLabel(quotaGb: number | undefined): string {
  if (quotaGb === undefined) return s.defaultQuota;
  if (quotaGb === 0) return s.unlimited;
  return formatGb(quotaGb);
}

/**
 * The paging the table sees. A group's members have one order (the default), so no header is a sort button
 * there. Without a group, the default order has no column: a third click on a header goes back to it.
 */
function tableView(paging: ListPaging, grouped: boolean): ListPaging {
  const { view } = paging;
  if (grouped) return { ...paging, view: { ...view, sort: LIST.defaultSort, setSort: () => undefined } };
  return {
    ...paging,
    view: {
      ...view,
      setSort: (next) => {
        const back = view.sort.key === next.key && view.sort.key !== LIST.defaultSort.key && next.dir === "asc";
        view.setSort(back ? LIST.defaultSort : next);
      },
    },
  };
}

/** `employees:list` (one page); the search is `employees:list`'s own, paginated like any list. */
export default function Employees() {
  const navigate = useNavigate();
  const groups = useGroupsScreen();
  // The count needs the applied search and group; the pager needs the count.
  const view = useListView(LIST);
  const groupId = view.filters.group ?? "";
  const total = useEmployeesCount({ groupId: groupId || undefined, search: view.search });
  const paging = useListPaging(view, { total });
  // A group's members have one order (the default), whatever a stale URL says.
  const employees = useEmployeesScreen({ ...paging.query, sort: groupId ? LIST.defaultSort : paging.query.sort, groupId: groupId || undefined });

  const cols = useMemo<Column<EmployeeRow>[]>(
    () => [
      {
        key: "name",
        header: s.colName,
        primary: true,
        sortable: !groupId,
        cell: (e) => (
          <Link className="dash-link dash-link--plain dash-truncate" to={`/employees/${e._id}`} title={e.name}>
            {e.name}
          </Link>
        ),
      },
      { key: "username", header: s.colUsername, truncate: 28, sortable: !groupId, cell: (e) => <span className="dash-mono dash-truncate" title={e.username}>{e.username}</span> },
      {
        key: "groups",
        header: s.colGroups,
        isEmpty: (e) => e.groups.length === 0,
        cell: (e) =>
          e.groups.length === 0 ? (
            <span className="dash-muted">—</span>
          ) : (
            <span className="dash-pills">
              {e.groups.map((g) => (
                <Pill key={g._id} title={g.name}>
                  <span className="dash-truncate" style={{ maxWidth: 160 }}>
                    {g.name}
                  </span>
                </Pill>
              ))}
              {e.moreGroups ? <Pill>+ {s.moreGroups}</Pill> : null}
            </span>
          ),
      },
      { key: "quota", header: s.colQuota, nowrap: true, cell: (e) => quotaLabel(e.quotaGb) },
      {
        key: "status",
        header: s.colStatus,
        nowrap: true,
        cell: (e) => (e.disabled ? <StatusDot tone="neutral" label={s.disabled} /> : <StatusDot tone="success" label={s.active} />),
      },
    ],
    [groupId],
  );

  const add = (
    <RoleGate minRole="admin">
      <Link to="/employees/new" className="rb-btn rb-btn--primary">
        <IconUserPlus aria-hidden="true" />
        {s.add}
      </Link>
    </RoleGate>
  );

  const filters = (
    <>
      <label className="dash-sr" htmlFor="employee-group-filter">
        {devicesStrings.groupFilter}
      </label>
      <NativeSelect id="employee-group-filter" compact value={groupId} onChange={(e) => paging.view.setFilter("group", e.target.value || null)}>
        <option value="">{devicesStrings.allGroups}</option>
        {groups.status === "ready" ? groups.data.map((g) => <option key={g._id} value={g._id}>{g.name}</option>) : null}
      </NativeSelect>
    </>
  );

  return (
    <div className="dash-page">
      <PageHeader title={s.title} lead={s.lead} actions={add} />
      <ServerTable
        framed
        caption={s.title}
        columns={cols}
        getKey={(e) => e._id}
        paging={tableView(paging, Boolean(groupId))}
        list={employees}
        total={total ?? null}
        search={{ label: s.searchLabel, placeholder: s.searchPlaceholder }}
        sortByRelevanceWhenSearching
        filters={filters}
        isDim={(e) => e.disabled}
        onRowClick={(e) => navigate(`/employees/${e._id}`)}
        empty={
          groupId ? (
            <EmptyState icon={<IconUsers />} title={s.noMatchTitle} body={s.noMatchBody} />
          ) : (
            <EmptyState icon={<IconUsers />} title={s.emptyTitle} body={s.emptyBody} action={add} />
          )
        }
      />
    </div>
  );
}
