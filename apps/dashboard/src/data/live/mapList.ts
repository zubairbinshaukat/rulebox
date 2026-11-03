import { useMemo } from "react";
import type { ServerList } from "../serverList";

/**
 * A list page with its rows mapped (`deviceRowOf`, capped group counts). The mapped rows are kept
 * while the server's page is the same object, so a screen sees stable rows between renders.
 */
export function useMappedList<A, B>(list: ServerList<A>, map: (row: A) => B): ServerList<B> {
  const items = list.status === "ready" ? list.items : undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `map` is a module function or a fresh closure with no inputs of its own.
  const mapped = useMemo(() => items?.map(map), [items]);
  return useMemo((): ServerList<B> => {
    if (list.status !== "ready") return list;
    return { ...list, items: mapped ?? [] };
  }, [list, mapped]);
}
