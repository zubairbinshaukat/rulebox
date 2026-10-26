import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Pill, Select } from "@rulebox/ui";
import IconUsers from "~icons/solar/users-group-rounded-linear";
import IconUserPlus from "~icons/solar/user-plus-rounded-linear";
import { useEmployeesScreen, useGroupsScreen } from "../data";
import type { EmployeeRow } from "../data/types";
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
import { StatusDot } from "../components/StatusDot";
import { formatGb } from "../lib/format";
import { strings } from "../lib/strings";
import { useDebounced } from "../lib/useDebounced";

const s = strings.employees;

function quotaLabel(quotaGb: number | undefined): string {
  if (quotaGb === undefined) return s.defaultQuota;
  if (quotaGb === 0) return s.unlimited;
  return formatGb(quotaGb);
}

/** `employees:list` (paginated) or `employees:search` while the search box has text. */
export default function Employees() {
  const [params, setParams] = useSearchParams();
  const groupId = params.get("group") ?? "";
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search.trim(), 250);
  const groups = useGroupsScreen();
  const employees = useEmployeesScreen({ groupId: groupId || undefined, search: debounced || undefined });

  const cols = useMemo<Column<EmployeeRow>[]>(
    () => [
      {
        key: "name",
        header: s.colName,
        primary: true,
        cell: (e) => (
          <Link className="dash-link dash-link--plain dash-truncate" to={`/employees/${e._id}`} title={e.name}>
            {e.name}
          </Link>
        ),
      },
      { key: "username", header: s.colUsername, cell: (e) => <span className="dash-mono dash-truncate" title={e.username}>{e.username}</span> },
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
      { key: "quota", header: s.colQuota, cell: (e) => quotaLabel(e.quotaGb) },
      {
        key: "status",
        header: s.colStatus,
        cell: (e) => (e.disabled ? <StatusDot tone="neutral" label={s.disabled} /> : <StatusDot tone="success" label={s.active} />),
      },
    ],
    [],
  );

  const add = (
    <RoleGate minRole="admin">
      <Link to="/employees/new" className="rb-btn rb-btn--primary">
        <IconUserPlus aria-hidden="true" />
        {s.add}
      </Link>
    </RoleGate>
  );

  return (
    <div className="dash-page">
      <PageHeader title={s.title} lead={s.lead} actions={add} />
      <div className="dash-filters">
        <SearchInput value={search} onChange={setSearch} label={s.searchLabel} placeholder={s.searchPlaceholder} />
        <label className="dash-sr" htmlFor="employee-group-filter">
          {strings.devices.groupFilter}
        </label>
        <Select
          id="employee-group-filter"
          compact
          value={groupId}
          onChange={(e) => {
            const next = new URLSearchParams(params);
            if (e.target.value) next.set("group", e.target.value);
            else next.delete("group");
            setParams(next, { replace: true });
          }}
        >
          <option value="">{strings.devices.allGroups}</option>
          {groups.status === "ready" ? groups.data.map((g) => <option key={g._id} value={g._id}>{g.name}</option>) : null}
        </Select>
      </div>
      <Card body="none">
        <PagedRegion state={employees} skeleton={<SkeletonRows rows={8} columns={4} />}>
          {(p) =>
            p.items.length === 0 ? (
              debounced || groupId ? (
                <EmptyState icon={<IconUsers />} title={s.noMatchTitle} body={s.noMatchBody} />
              ) : (
                <EmptyState icon={<IconUsers />} title={s.emptyTitle} body={s.emptyBody} action={add} />
              )
            ) : (
              <>
                {"searchCapped" in employees && employees.searchCapped ? (
                  <div style={{ padding: 12 }}>
                    <InlineNotice tone="neutral" title={strings.devices.searchCap} />
                  </div>
                ) : null}
                <DataTable caption={s.title} columns={cols} rows={p.items} getKey={(e) => e._id} isDim={(e) => e.disabled} />
                <LoadMore shown={p.items.length} canLoadMore={p.canLoadMore} isLoadingMore={p.isLoadingMore} loadMore={p.loadMore} />
              </>
            )
          }
        </PagedRegion>
      </Card>
    </div>
  );
}
