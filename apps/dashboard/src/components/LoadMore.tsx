import { Button } from "@rulebox/ui";
import { strings } from "../lib/strings";

export interface LoadMoreProps {
  shown: number;
  canLoadMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
}

/**
 * "Load more" adds the next 50 rows; the button disappears once the server
 * says the list is exhausted. The count line is a polite live region so
 * screen readers hear that more rows arrived.
 */
export function LoadMore({ shown, canLoadMore, isLoadingMore, loadMore }: LoadMoreProps) {
  if (!canLoadMore && shown <= 50) return null;
  return (
    <div className="dash-loadmore">
      {canLoadMore ? (
        <Button variant="ghost" onClick={loadMore} disabled={isLoadingMore} aria-busy={isLoadingMore}>
          {isLoadingMore ? strings.common.loadingMore : strings.common.loadMore}
        </Button>
      ) : null}
      <p className="dash-loadmore__status" role="status" aria-live="polite">
        {canLoadMore ? strings.common.showingOf(shown, true) : strings.common.endOfList}
      </p>
    </div>
  );
}
