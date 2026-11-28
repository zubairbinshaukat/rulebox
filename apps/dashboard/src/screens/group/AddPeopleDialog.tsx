import { useState } from "react";
import { Button, Pill } from "@rulebox/ui";
import { useAddGroupEmployee } from "../../data";
import { useEmployeePicker } from "../../data/employees";
import type { EmployeeRow } from "../../data/types";
import { DataTable, type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { Modal } from "../../components/Modal";
import { InlineNotice } from "../../components/Notice";
import { SearchInput } from "../../components/SearchInput";
import { messageFor } from "../../lib/errors";
import { devicesStrings } from "../../lib/screenStrings/devices";
import { employeesStrings } from "../../lib/screenStrings/employees";
import { strings } from "../../lib/strings";
import { useToast } from "../../lib/toast";
import { groupPage as t } from "./strings";

/** The people picker: `employees:search` (the best matches, a bounded read), run on Enter. Nothing is read until something is searched for. */
export default function AddPeopleDialog({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const [search, setSearch] = useState("");
  const results = useEmployeePicker(search);
  const add = useAddGroupEmployee();
  const toast = useToast();
  const [added, setAdded] = useState<Set<string>>(new Set());
  const cols: Column<EmployeeRow>[] = [
    {
      key: "name",
      header: t.people.colName,
      primary: true,
      cell: (e) => (
        <span className="dash-cell-stack">
          <span className="dash-truncate" title={e.name}>
            {e.name}
          </span>
          <span className="dash-cell-sub dash-mono">{e.username}</span>
        </span>
      ),
    },
    {
      key: "act",
      header: strings.common.actions,
      actions: true,
      cell: (e) =>
        added.has(e._id) || e.groups.some((g) => g._id === groupId) ? (
          <Pill tone="success">{strings.common.done}</Pill>
        ) : (
          <Button
            variant="ghost"
            className="dash-btn--sm"
            aria-label={`${strings.common.add}: ${e.name}`}
            onClick={() =>
              add({ groupId, employeeId: e._id }).then(
                () => setAdded((set) => new Set(set).add(e._id)),
                (err) => toast(messageFor(err), "danger"),
              )
            }
          >
            {strings.common.add}
          </Button>
        ),
    },
  ];
  const rows = results.status === "ready" ? results.data.rows : [];
  return (
    <Modal open title={t.people.addTitle} onClose={onClose} wide actions={<Button onClick={onClose}>{strings.common.done}</Button>}>
      <div className="dash-form">
        <SearchInput value={search} onSearch={setSearch} label={t.people.addSearch} placeholder={employeesStrings.searchPlaceholder} />
        {search === "" ? null : (
          <>
            {results.status === "ready" && results.data.capped ? <InlineNotice tone="neutral" title={devicesStrings.searchCap} /> : null}
            <DataTable
              caption={t.people.addTitle}
              columns={cols}
              rows={rows}
              getKey={(e) => e._id}
              stack={false}
              state={results.status === "loading" ? "loading" : results.status === "error" ? "error" : rows.length === 0 ? "empty" : "ready"}
              error={results.status === "error" ? results.error : undefined}
              onRetry={results.status === "error" ? results.retry : undefined}
              empty={<EmptyState compact title={employeesStrings.noMatchTitle} />}
              skeletonRows={3}
            />
          </>
        )}
      </div>
    </Modal>
  );
}
