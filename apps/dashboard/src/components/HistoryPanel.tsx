import { useMemo } from "react";
import { useHistory } from "../data/audit";
import type { AuditEntry, Id } from "../data/types";
import { actionLabel } from "../lib/audit";
import { plainSummary } from "../lib/auditText";
import { useListPaging, useListView, type ListConfig } from "../lib/listView";
import { auditStrings } from "../lib/screenStrings/audit";
import { deviceStrings } from "../lib/screenStrings/device";
import { ActorLabel } from "./AuditItem";
import { Card } from "./Card";
import type { Column } from "./DataTable";
import { EmptyState } from "./EmptyState";
import { RelativeTime } from "./RelativeTime";
import { ServerTable } from "./ServerTable";

/** `audit:forTarget` sorts by time ("at") only. The panel keeps its page, size and direction in component state (a detail page has other lists). */
const LIST: ListConfig = { sorts: ["at"], defaultSort: { key: "at", dir: "desc" }, storage: "local" };

/** The audit history of one device, employee, app or group (`audit:forTarget`), one page at a time. No total. */
export function HistoryPanel({ targetId, title = deviceStrings.history }: { targetId: Id; title?: string }) {
  const view = useListView(LIST);
  // Another target is another list: start over on its first page.
  const paging = useListPaging(view, { total: null, scope: targetId });
  const history = useHistory(targetId, paging.query);

  const cols = useMemo<Column<AuditEntry>[]>(
    () => [
      {
        key: "what",
        header: auditStrings.colAction,
        primary: true,
        type: "name",
        cell: (e) => (
          <span className="dash-cell-stack">
            <strong style={{ fontWeight: 600 }}>{actionLabel(e.action)}</strong>
            {e.summary ? <span className="dash-wrap dash-cell-sub" style={{ whiteSpace: "normal" }}>{plainSummary(e)}</span> : null}
            <span className="dash-cell-sub">
              <ActorLabel entry={e} />
            </span>
          </span>
        ),
      },
      { key: "at", header: auditStrings.colTime, type: "date", sortable: true, sortDefaultDir: "desc", cell: (e) => <RelativeTime ms={e.at} /> },
    ],
    [],
  );

  return (
    <Card title={title} body="none" className="dash-card--tight">
      <ServerTable<AuditEntry>
        caption={title}
        columns={cols}
        getKey={(e) => e._id}
        paging={paging}
        list={history}
        total={null}
        skeletonRows={3}
        // A two-column list in a side card: always a table, no Table | Cards switch and no card sort control (also not on an empty list).
        stack={false}
        empty={<EmptyState compact title={auditStrings.historyNone} />}
      />
    </Card>
  );
}
