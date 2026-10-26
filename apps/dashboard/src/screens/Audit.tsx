import { useMemo } from "react";
import { Button } from "@rulebox/ui";
import IconHistory from "~icons/solar/history-linear";
import IconPrinter from "~icons/solar/printer-minimalistic-linear";
import { useAuditScreen } from "../data";
import type { AuditEntry } from "../data/types";
import { ActorLabel, TargetLink } from "../components/AuditItem";
import { actionLabel } from "../lib/audit";
import { Card } from "../components/Card";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { LoadMore } from "../components/LoadMore";
import { PageHeader } from "../components/PageHeader";
import { PagedRegion } from "../components/Region";
import { RelativeTime } from "../components/RelativeTime";
import { SkeletonRows } from "../components/Skeleton";
import { formatDateTime, timeZoneName } from "../lib/format";
import { strings } from "../lib/strings";

const s = strings.audit;

/** `audit:list`: newest first, "Load more", actor and target links, relative + absolute time. */
export default function Audit() {
  const audit = useAuditScreen();
  const cols = useMemo<Column<AuditEntry>[]>(
    () => [
      {
        key: "time",
        header: s.colTime,
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
      <Card body="none">
        <PagedRegion state={audit} skeleton={<SkeletonRows rows={10} columns={4} />}>
          {(p) =>
            p.items.length === 0 ? (
              <EmptyState icon={<IconHistory />} title={s.emptyTitle} body={s.emptyBody} />
            ) : (
              <>
                <DataTable caption={s.title} columns={cols} rows={p.items} getKey={(e) => e._id} />
                <LoadMore shown={p.items.length} canLoadMore={p.canLoadMore} isLoadingMore={p.isLoadingMore} loadMore={p.loadMore} />
              </>
            )
          }
        </PagedRegion>
      </Card>
    </div>
  );
}
