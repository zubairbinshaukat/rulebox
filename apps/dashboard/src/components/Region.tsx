import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@rulebox/ui";
import IconDanger from "~icons/solar/danger-circle-linear";
import { messageFor, errorCodeOf, toAppError } from "../lib/errors";
import { reportUnauthenticated } from "../lib/session";
import { strings } from "../lib/strings";
import { NOT_DEPLOYED } from "../data/api";
import type { PagedState, QueryState } from "../data/types";
import { EmptyState } from "./EmptyState";

/** The "this part didn't load" panel with Try again. */
export function RegionError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const code = errorCodeOf(error);
  // A live hook whose backend step has not landed: not an error, just not here yet.
  if (code === "not_ready" && toAppError(error)?.detail === NOT_DEPLOYED) {
    return <EmptyState compact title={strings.app.comingLater} />;
  }
  const detail = code ? messageFor(error) : strings.common.regionFailedDetail;
  return (
    <div className="dash-region-error" role="alert">
      <span className="dash-region-error__icon" aria-hidden="true">
        <IconDanger />
      </span>
      <div className="dash-region-error__text">
        <p className="dash-region-error__title">{strings.common.regionFailed}</p>
        <p className="dash-region-error__detail">{detail}</p>
      </div>
      {onRetry && code !== "not_found" ? (
        <Button variant="ghost" className="dash-btn--sm" onClick={onRetry}>
          {strings.common.tryAgain}
        </Button>
      ) : null}
    </div>
  );
}

interface BoundaryProps {
  children: ReactNode;
  /** Changing this resets the boundary (for example the route). */
  resetKey?: unknown;
}
interface BoundaryState {
  error: unknown;
  key: unknown;
}

/**
 * Per-region error boundary (Section 4.13). With Convex, `useQuery` throws
 * query errors during render; this catches them for one region only, so the
 * rest of the screen keeps working.
 */
export class RegionBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    if (props.resetKey !== state.key) return { error: null, key: props.resetKey };
    return null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // A paginated query throws its errors here (usePaginatedQuery): a lost session still signs out.
    if (toAppError(error)?.code === "unauthenticated") reportUnauthenticated();
    console.error("Rulebox dashboard region error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return <RegionError error={this.state.error} onRetry={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}

/** Renders loading / error / ready for one query state. */
export function QueryRegion<T>({
  state,
  skeleton,
  children,
}: {
  state: QueryState<T>;
  skeleton: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (state.status === "loading") return <>{skeleton}</>;
  if (state.status === "error") return <RegionError error={state.error} onRetry={state.retry} />;
  return <RegionBoundary>{children(state.data)}</RegionBoundary>;
}

/** Same for a paginated list. */
export function PagedRegion<T>({
  state,
  skeleton,
  children,
}: {
  state: PagedState<T>;
  skeleton: ReactNode;
  children: (ready: Extract<PagedState<T>, { status: "ready" }>) => ReactNode;
}) {
  if (state.status === "loading") return <>{skeleton}</>;
  if (state.status === "error") return <RegionError error={state.error} onRetry={state.retry} />;
  return <RegionBoundary>{children(state)}</RegionBoundary>;
}
