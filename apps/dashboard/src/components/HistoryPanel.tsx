import { useHistory } from "../data";
import type { Id } from "../data/types";
import { strings } from "../lib/strings";
import { AuditTimelineItem } from "./AuditItem";
import { Card } from "./Card";
import { EmptyState } from "./EmptyState";
import { LoadMore } from "./LoadMore";
import { PagedRegion } from "./Region";
import { SkeletonRows } from "./Skeleton";

/** The audit history of one device, employee, app or group (`audit:forTarget`, paginated). */
export function HistoryPanel({ targetId, title = strings.device.history }: { targetId: Id; title?: string }) {
  const history = useHistory(targetId);
  return (
    <Card title={title} body="flush">
      <PagedRegion state={history} skeleton={<SkeletonRows rows={3} columns={2} />}>
        {(h) =>
          h.items.length === 0 ? (
            <EmptyState compact title={strings.audit.historyNone} />
          ) : (
            <>
              <ul className="dash-timeline">
                {h.items.map((e) => (
                  <AuditTimelineItem key={e._id} entry={e} showTarget={false} />
                ))}
              </ul>
              <LoadMore shown={h.items.length} canLoadMore={h.canLoadMore} isLoadingMore={h.isLoadingMore} loadMore={h.loadMore} />
            </>
          )
        }
      </PagedRegion>
    </Card>
  );
}
