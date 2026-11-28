import type { ReactNode } from "react";
import type { ServerList } from "../data/serverList";
import type { ListPaging } from "../lib/listView";
import { strings } from "../lib/strings";
import { DataTable, type Column, type SortState, type TableState } from "./DataTable";
import { EmptyState } from "./EmptyState";
import { Pager } from "./Pager";
import { SearchInput } from "./SearchInput";

export interface ServerTableProps<T> {
  caption: string;
  columns: Column<T>[];
  getKey: (row: T) => string;
  /** From `useListPaging`: the list state (URL or local) and the cursor pager. */
  paging: ListPaging;
  /** One page from the list hook (`ServerList`). */
  list: ServerList<T>;
  /** The table's total, `null` when it has none: the pager then shows Previous / Next and "Page N" only. */
  total: number | null;
  /** A search box that runs on Enter. Leave out for tables the server cannot search (audit, enrollment codes). */
  search?: { label: string; placeholder?: string };
  /** The server orders a search by relevance, so the sort headers are inactive while a search is applied. */
  sortByRelevanceWhenSearching?: boolean;
  /** Filters next to the search box (the archived tab, a state select). */
  filters?: ReactNode;
  /** Shown when the table has no row at all (no search applied). */
  empty: ReactNode;
  onRowClick?: (row: T) => void;
  isDim?: (row: T) => boolean;
  /** The record's name, for the names of its action buttons (needed with `rowActions` columns). */
  rowLabel?: (row: T) => string;
  /** List-wide actions at the right of the toolbar ("Check now"). */
  toolbarEnd?: ReactNode;
  /** A server order that has no column ("Newest added"): the cards' sort control lists it too. */
  defaultSort?: SortState & { label: string };
  /** The table draws its own card (page-level lists); leave off inside a `Card`. */
  framed?: boolean;
  /** The Table | Cards switch above the table. Default: on when `framed`. */
  viewSwitch?: boolean;
  /** `false` keeps a table in every view. */
  stack?: boolean;
  skeletonRows?: number;
}

/**
 * Wires a server-driven list (`useListPaging` + a list hook) to the generic
 * `DataTable`, the `Pager` and the Enter-to-search box, so every screen does it
 * the same way: sort headers report to the URL, the last page is read in the
 * opposite order (rows come back reversed here), Previous / Next without a
 * total, loading / empty / error states.
 */
export function ServerTable<T>({
  caption,
  columns,
  getKey,
  paging,
  list,
  total,
  search,
  sortByRelevanceWhenSearching = false,
  filters,
  empty,
  onRowClick,
  isDim,
  rowLabel,
  toolbarEnd,
  defaultSort,
  framed = false,
  viewSwitch,
  stack,
  skeletonRows,
}: ServerTableProps<T>) {
  const { view, pager, req } = paging;
  const ready = list.status === "ready" ? list : null;
  const rows: T[] = ready ? (req.reverse ? [...ready.items].reverse() : ready.items) : [];
  const searching = view.search !== "";
  const relevance = sortByRelevanceWhenSearching && searching;
  const none = ready !== null && rows.length === 0;
  // The server filters after paging: a page can be short or empty while more rows exist.
  const reallyEmpty = none && pager.page === 1 && ready.isDone;
  const state: TableState = list.status === "loading" ? "loading" : list.status === "error" ? "error" : reallyEmpty ? "empty" : "ready";

  const toolbar =
    search || filters ? (
      <>
        {search ? <SearchInput label={search.label} placeholder={search.placeholder} value={view.search} onSearch={view.setSearch} /> : null}
        {filters}
        {relevance ? <span className="dash-muted dash-dt__note">{strings.table.byRelevance}</span> : null}
      </>
    ) : undefined;

  return (
    <DataTable
      caption={caption}
      columns={columns}
      rows={rows}
      getKey={getKey}
      isDim={isDim}
      rowLabel={rowLabel}
      stack={stack}
      sort={relevance ? undefined : view.sort}
      onSortChange={relevance ? undefined : view.setSort}
      defaultSort={defaultSort}
      sortNote={relevance ? strings.table.bestMatches : undefined}
      pageKey={pager.page}
      onRowClick={onRowClick}
      state={state}
      skeletonRows={skeletonRows}
      empty={searching ? <EmptyState compact title={strings.table.noResults(view.search)} /> : empty}
      error={list.status === "error" ? list.error : undefined}
      onRetry={list.status === "error" ? list.retry : undefined}
      busy={ready?.busy ?? false}
      toolbar={toolbar}
      toolbarEnd={toolbarEnd}
      framed={framed}
      viewSwitch={viewSwitch}
      footer={
        ready ? (
          <>
            {none ? <p className="dash-muted dash-dt__note">{strings.table.emptyPage}</p> : null}
            <Pager
              page={pager.page}
              pageSize={view.size}
              total={total}
              hasNext={!ready.isDone}
              reachablePages={pager.reachablePages(!ready.isDone)}
              onPage={(n) => pager.go(n, ready.continueCursor)}
              onPageSize={view.setSize}
              loading={ready.busy}
            />
          </>
        ) : undefined
      }
    />
  );
}
