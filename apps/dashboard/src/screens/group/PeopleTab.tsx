import { lazy, Suspense, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "@rulebox/ui";
import IconAdd from "~icons/solar/user-plus-rounded-linear";
import IconPeople from "~icons/solar/users-group-rounded-linear";
import { useRemoveGroupEmployee } from "../../data";
import { useEmployeesScreen } from "../../data/employees";
import type { EmployeeRow } from "../../data/types";
import type { Column, RowAction } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { RoleGate } from "../../components/RoleGate";
import { ServerTable } from "../../components/ServerTable";
import { StatusDot } from "../../components/StatusDot";
import { messageFor } from "../../lib/errors";
import { useListPaging, useListView, type ListConfig } from "../../lib/listView";
import { useCan } from "../../lib/member";
import { useToast } from "../../lib/toast";
import { groupPage as t } from "./strings";

// The picker loads when it is opened.
const AddPeopleDialog = lazy(() => import("./AddPeopleDialog"));

/** A group's members come in one order (the server's: as they were added, newest first); a search orders by relevance. */
const LIST: ListConfig = { sorts: ["created"], defaultSort: { key: "created", dir: "desc" }, storage: "local" };

/**
 * The People tab: who is in the group, as a table or as cards, searchable, one page at a time (`employees:list({ groupId })`).
 * Admins remove a person from here and add people with the search-first dialog. Loads only while the tab is open.
 * `startAdding` opens the dialog at once (the "Add people" step of the checklist).
 */
export default function PeopleTab({ groupId, startAdding = false }: { groupId: string; startAdding?: boolean }) {
  const navigate = useNavigate();
  const paging = useListPaging(useListView(LIST), { total: null, scope: groupId });
  const people = useEmployeesScreen({ ...paging.query, groupId });
  const admin = useCan("admin");
  const remove = useRemoveGroupEmployee();
  const toast = useToast();
  const [adding, setAdding] = useState(startAdding);

  const cols = useMemo<Column<EmployeeRow>[]>(() => {
    const actionsOf = (e: EmployeeRow): RowAction[] =>
      admin
        ? [
            {
              label: t.people.remove,
              onSelect: () => {
                remove({ groupId, employeeId: e._id }).then(
                  () => toast(t.people.removed(e.name)),
                  (err) => toast(messageFor(err), "danger"),
                );
              },
            },
          ]
        : [];
    return [
      {
        key: "name",
        header: t.people.colName,
        primary: true,
        cell: (e) => (
          <span className="dash-cell-stack">
            <Link className="dash-link dash-link--plain dash-truncate" to={`/employees/${e._id}`} title={e.name}>
              {e.name}
            </Link>
            <span className="dash-cell-sub dash-mono dash-truncate" title={e.username}>
              {e.username}
            </span>
          </span>
        ),
        cardCell: (e) => (
          <Link className="dash-link dash-link--plain" to={`/employees/${e._id}`}>
            {e.name}
          </Link>
        ),
        cardSub: (e) => <span className="dash-mono">{e.username}</span>,
      },
      {
        key: "status",
        header: t.people.colStatus,
        nowrap: true,
        card: "status",
        cell: (e) => (e.disabled ? <StatusDot tone="neutral" label={t.people.disabled} /> : <StatusDot tone="success" label={t.people.active} />),
      },
      { key: "act", header: t.people.remove, actions: true, rowActions: actionsOf, isEmpty: (e) => actionsOf(e).length === 0, cell: () => null },
    ];
  }, [admin, remove, groupId, toast]);

  const add = (
    <RoleGate minRole="admin">
      <Button variant="ghost" onClick={() => setAdding(true)}>
        <IconAdd aria-hidden="true" />
        {t.people.add}
      </Button>
    </RoleGate>
  );

  return (
    <>
      <ServerTable
        framed
        caption={t.people.caption}
        columns={cols}
        getKey={(e) => e._id}
        rowLabel={(e) => e.name}
        paging={paging}
        list={people}
        total={null}
        search={{ label: t.people.searchLabel, placeholder: t.people.searchPlaceholder }}
        sortByRelevanceWhenSearching
        toolbarEnd={add}
        isDim={(e) => e.disabled}
        onRowClick={(e) => navigate(`/employees/${e._id}`)}
        empty={<EmptyState icon={<IconPeople />} title={t.people.noneTitle} body={t.people.noneBody} />}
        skeletonRows={4}
      />
      <Suspense fallback={null}>{adding ? <AddPeopleDialog groupId={groupId} onClose={() => setAdding(false)} /> : null}</Suspense>
    </>
  );
}
