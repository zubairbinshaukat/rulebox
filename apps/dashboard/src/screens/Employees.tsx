import { useMemo } from "react";
import { Link, useNavigate } from "react-router";
import { Pill, SearchSelect } from "@rulebox/ui";
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
import { TruncateLazy as Truncate } from "../components/TruncateLazy";
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
const DEFAULT_SORT = { ...LIST.defaultSort, label: s.newestFirst };

/** A card shows the first groups only; the table shows every group the row carries. */
const CARD_GROUPS = 2;

function quotaLabel(quotaGb: number | undefined): string {
  if (quotaGb === undefined) return s.defaultQuota;
  if (quotaGb === 0) return s.unlimited;
  return formatGb(quotaGb);
}

function GroupPills({ e, limit }: { e: EmployeeRow; limit?: number }) {
  if (e.groups.length === 0) return <span className="dash-muted">—</span>;
  const shown = limit === undefined ? e.groups : e.groups.slice(0, limit);
  const rest = e.groups.slice(shown.length);
  const more = rest.length > 0 || e.moreGroups;
  return (
    <span className="dash-pills">
      {shown.map((g) => (
        <Pill key={g._id}>
          <Truncate full={g.name} maxWidth={160}>
            {g.name}
          </Truncate>
        </Pill>
      ))}
      {more ? <Pill title={rest.map((g) => g.name).join(", ") || undefined}>{s.moreGroupsN(rest.length, e.moreGroups)}</Pill> : null}
    </span>
  );
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

  // Name and username are the two orders the server has; the rest only reads. No row action: a person is opened to be changed.
  const cols = useMemo<Column<EmployeeRow>[]>(
    () => [
      {
        key: "name",
        header: s.colName,
        primary: true,
        type: "name",
        maxWidth: 260,
        sortable: !groupId,
        cell: (e) => (
          <Link className="dash-link dash-link--plain" to={`/employees/${e._id}`}>
            <Truncate full={e.name} maxWidth={260}>
              {e.name}
            </Truncate>
          </Link>
        ),
      },
      {
        key: "username",
        header: s.colUsername,
        type: "mono",
        card: "subtitle",
        sortable: !groupId,
        cell: (e) => (
          <Truncate full={e.username} maxWidth={200} className="dash-mono">
            {e.username}
          </Truncate>
        ),
        cardCell: (e) => <span className="dash-mono dash-truncate">{e.username}</span>,
      },
      {
        key: "groups",
        header: s.colGroups,
        type: "badge",
        maxWidth: 280,
        card: "fact",
        cardWide: true,
        isEmpty: (e) => e.groups.length === 0,
        cell: (e) => <GroupPills e={e} />,
        cardCell: (e) => <GroupPills e={e} limit={CARD_GROUPS} />,
      },
      { key: "quota", header: s.colQuota, type: "short", card: "fact", cell: (e) => quotaLabel(e.quotaGb) },
      {
        key: "status",
        header: s.colStatus,
        type: "short",
        card: "status",
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

  // Groups can be many: a searchable list, not a plain drop-down.
  const filters = (
    <>
      <label className="dash-sr" htmlFor="employee-group-filter">
        {devicesStrings.groupFilter}
      </label>
      <SearchSelect
        id="employee-group-filter"
        compact
        value={groupId}
        onChange={(next) => paging.view.setFilter("group", next || null)}
        options={[{ value: "", label: devicesStrings.allGroups }, ...(groups.status === "ready" ? groups.data.map((g) => ({ value: g._id, label: g.name })) : [])]}
        searchPlaceholder={s.groupSearch}
        emptyText={s.groupNoMatch}
      />
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
        defaultSort={DEFAULT_SORT}
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
