import { useMemo } from "react";
import { Button } from "@rulebox/ui";
import IconHistory from "~icons/solar/history-linear";
import IconPrinter from "~icons/solar/printer-minimalistic-linear";
import { useAuditScreen } from "../data/audit";
import type { AuditEntry } from "../data/types";
import { ActorLabel, TargetLink } from "../components/AuditItem";
import { actionLabel } from "../lib/audit";
import type { Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { RelativeTime } from "../components/RelativeTime";
import { ServerTable } from "../components/ServerTable";
import { formatDateTime, timeZoneName } from "../lib/format";
import { useListPaging, useListView, type ListConfig } from "../lib/listView";
import { strings } from "../lib/strings";
import { auditStrings } from "../lib/screenStrings/audit";

const s = auditStrings;

/** `audit:list` sorts by time ("at") only, newest first. No search and no total. */
const LIST: ListConfig = { sorts: ["at"], defaultSort: { key: "at", dir: "desc" } };

/**
 * `audit:list`, one page at a time (page, page size and the sort direction live in the URL): actor and target
 * links, relative + absolute time. No total, so the pager shows Previous / Next and "Page N".
 */
export default function Audit() {
  const view = useListView(LIST);
  const paging = useListPaging(view, { total: null });
  const audit = useAuditScreen(paging.query);
  const cols = useMemo<Column<AuditEntry>[]>(
    () => [
      {
        key: "at",
        header: s.colTime,
        sortable: true,
        sortDefaultDir: "desc",
        cell: (e) => (
          <span className="dash-cell-stack" style={{ minWidth: 130 }}>
            <RelativeTime ms={e.at} />
            <span className="dash-cell-sub">{formatDateTime(e.at)}</span>
          </span>
        ),
      },
      { key: "action", header: s.colAction, primary: true, cell: (e) => <strong style={{ fontWeight: 600 }}>{actionLabel(e.action)}</strong> },
      {
        key: "actor",
        header: s.colActor,
        cell: (e) => (
          <span className="dash-cell-stack" style={{ maxWidth: 260 }}>
            <span className="dash-truncate" title={e.actorLabel}>
              <ActorLabel entry={e} />
            </span>
            <span className="dash-cell-sub">{s.actorTypes[e.actorType]}</span>
          </span>
        ),
      },
      { key: "target", header: s.colTarget, isEmpty: (e) => !e.targetLabel, cell: (e) => (e.targetLabel ? <span className="dash-truncate" style={{ maxWidth: 240 }}><TargetLink entry={e} /></span> : <span className="dash-muted">—</span>) },
      { key: "summary", header: s.colSummary, isEmpty: (e) => !e.summary, cell: (e) => <span className="dash-wrap" style={{ display: "block", maxWidth: 360, fontSize: 13.5 }}>{e.summary}</span> },
    ],
    [],
  );
  return (
    <div className="dash-page">
      <PageHeader
        title={s.title}
        lead={`${s.lead} ${strings.common.timeZone(timeZoneName())}`}
        actions={
          <Button variant="ghost" onClick={() => window.print()}>
            <IconPrinter aria-hidden="true" />
            {s.print}
          </Button>
        }
      />
      <ServerTable<AuditEntry>
        framed
        caption={s.title}
        columns={cols}
        getKey={(e) => e._id}
        paging={paging}
        list={audit}
        total={null}
        skeletonRows={10}
        empty={<EmptyState icon={<IconHistory />} title={s.emptyTitle} body={s.emptyBody} />}
      />
    </div>
  );
}
