/**
 * Small adapters from the Convex React hooks to the dashboard's data seam
 * (`QueryState`, plain async functions throwing `AppError`). Used only by
 * `live/hooks.ts`.
 */
import { useConvexAuth, useQueries, type RequestForQueries } from "convex/react";
import {
  getFunctionName,
  makeFunctionReference,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import { convexToJson, jsonToConvex, type JSONValue, type Value } from "convex/values";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toAppError } from "../../lib/errors";
import { reportUnauthenticated } from "../../lib/session";
import { withStepUp } from "../../lib/stepUpRetry";
import type { QueryState } from "../types";

/**
 * Maps a thrown Convex error to the dashboard's `AppError` (codes kept in sync
 * with `convex/lib/errors.ts` by `convex/errors.test.ts`). An error without a
 * known code is passed on unchanged: the UI shows only the generic sentence
 * for it (`messageFor`), never its message. `unauthenticated` also tells the
 * session guard that the session is gone.
 */
export function mapError(e: unknown): unknown {
  const app = toAppError(e);
  if (app?.code === "unauthenticated") reportUnauthenticated();
  return app ?? e;
}

/**
 * Wraps a mutation / action so its errors go through `mapError`, and a
 * `step_up_required` opens the confirm dialog and retries once
 * (`lib/stepUpRetry.ts`). Stable while `fn` is.
 */
export function useMapped<A, R>(fn: (args: A) => Promise<R>): (args: A) => Promise<R> {
  return useCallback(
    (args: A) =>
      withStepUp(async () => {
        try {
          return await fn(args);
        } catch (e) {
          throw mapError(e);
        }
      }),
    [fn],
  );
}

/**
 * A member-only query as a `QueryState`. Skipped until Convex Auth has a
 * confirmed session (no `unauthenticated` noise while signed out). Errors do
 * not throw during render (`useQueries` returns them), so a screen can show
 * its own "Try again"; `retry` drops the subscription for one tick and
 * subscribes again.
 */
export function useMemberQuery<Q extends FunctionReference<"query">>(
  query: Q,
  args: FunctionArgs<Q>,
): QueryState<FunctionReturnType<Q>> {
  const { isAuthenticated } = useConvexAuth();
  const [paused, setPaused] = useState(false);
  const argsKey = JSON.stringify(convexToJson(args));
  // `api.x.y` is a new Proxy on every access: key on the function's name (as
  // Convex's own `useQuery` does), or every render would re-subscribe.
  const name = getFunctionName(query);
  const requests = useMemo((): RequestForQueries => {
    if (!isAuthenticated || paused) return {};
    return {
      q: {
        query: makeFunctionReference<"query">(name),
        args: jsonToConvex(JSON.parse(argsKey) as JSONValue) as Record<string, Value>,
      },
    };
  }, [isAuthenticated, paused, name, argsKey]);
  const result: unknown = useQueries(requests).q;

  useEffect(() => {
    if (!paused) return;
    const t = setTimeout(() => setPaused(false), 0);
    return () => clearTimeout(t);
  }, [paused]);

  const failed = result instanceof Error;
  const unauthenticated = failed && toAppError(result)?.code === "unauthenticated";
  useEffect(() => {
    if (unauthenticated) reportUnauthenticated();
  }, [unauthenticated]);

  const retry = useCallback(() => setPaused(true), []);
  if (result === undefined) return { status: "loading" };
  if (failed) return { status: "error", error: toAppError(result) ?? result, retry };
  return { status: "ready", data: result as FunctionReturnType<Q> };
}

/**
 * A query result reshaped for the screen (for example capped counts). The
 * mapped data is kept while the server's result is the same object, so
 * screens see a stable value between renders, like `useQuery`'s.
 */
export function useMappedState<T, U>(state: QueryState<T>, map: (data: T) => U): QueryState<U> {
  const data = state.status === "ready" ? state.data : undefined;
  // `map` is a fresh closure each render; the result depends only on `data`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mapped = useMemo(() => (data === undefined ? undefined : map(data)), [data]);
  if (state.status !== "ready") return state;
  return { status: "ready", data: mapped as U };
}
