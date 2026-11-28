import { memo, Suspense, useCallback, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import IconSort from "~icons/solar/sort-vertical-linear";
import IconAsc from "~icons/solar/arrow-up-linear";
import IconDesc from "~icons/solar/arrow-down-linear";
import { columnType, tableColumns } from "../lib/columns";
import { type SortDir } from "../lib/cursorPager";
import { ignoreRowClick } from "../lib/rowClick";
import { strings } from "../lib/strings";
import { useViewMode, type ViewMode } from "../lib/viewMode";
import { EmptyState } from "./EmptyState";
import { RegionError } from "./Region";
import { RowActions } from "./RowActions";
import { SkeletonRows } from "./Skeleton";
import { CardGridLazy, CardsSortSelectLazy, SkeletonCardsLazy } from "./cardsLazy";
import { TruncateLazy as Truncate } from "./TruncateLazy";
import { ViewSwitch } from "./ViewSwitch";

export type { SortDir };

export interface SortState {
  key: string;
  dir: SortDir;
}

/** `ready` is the default; `empty` shows `empty` instead of the table. */
export type TableState = "loading" | "error" | "empty" | "ready";

/**
 * What a column holds. It sets the table's width and wrapping rules (`dash-col--<type>`):
 * `name` the record's name (one line, cut at `maxWidth`, default 280 px); `text` free text (two lines, then cut, 360 px);
 * `short` state words, roles, "0 of 1 used" (never wraps); `date` a `RelativeTime` (never wraps); `num` counts
 * (end-aligned); `badge` pills (wrap between pills only, 280 px); `mono` builds, versions, usernames (one line, 200 px);
 * `actions` buttons (end-aligned, never wraps).
 */
export type ColumnType = "name" | "text" | "short" | "date" | "num" | "badge" | "mono" | "actions";

/** Where a column goes on a card. The default: `primary` is the title, `actions` the footer, everything else a fact. */
export type CardRole = "title" | "subtitle" | "status" | "fact" | "detail" | "actions" | "hidden";

export interface RowAction {
  /** "Revoke". The accessible name adds the record: "Revoke: VM run A3". */
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Why it is disabled (shown as a tooltip, or next to the item in the menu). */
  hint?: string;
  /** Stays a button when there are more than two actions; the others move into "More actions". */
  primary?: boolean;
}

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** The record's name: the title of its card and the table's flexible column. */
  primary?: boolean;
  /** Buttons: right-aligned, no header text. */
  actions?: boolean;
  /** Same as `type: "num"`. */
  numeric?: boolean;
  /**
   * The cell never wraps (dates and "4 minutes ago", states, badges, counts like "0 of 1 used", versions).
   * Implied by `type` short, date, num, badge, mono and actions.
   */
  nowrap?: boolean;
  /**
   * Deprecated, use `type` + `maxWidth` and `<Truncate>`. Cuts the cell with an ellipsis after this many
   * characters (`true` = 32); the full text shows in the shared tooltip.
   */
  truncate?: boolean | number;
  className?: string;
  /** The value is empty: a fact shows "—", other card slots are left out, a table cell stays blank. */
  isEmpty?: (row: T) => boolean;
  /** The header becomes a sort button. `key` is what `onSortChange` reports, so it must be a server sort key. */
  sortable?: boolean;
  /** The direction a first click sorts by (dates and counts usually want "desc"). Default "asc". */
  sortDefaultDir?: SortDir;

  /** Table width and wrapping class (see `ColumnType`). Default: from `primary` / `actions` / `numeric`, else `short` (never wraps): free text must say `text`. */
  type?: ColumnType;
  /** Width cap in px for `name`, `text`, `mono` and `badge` cells; longer content is cut (default per type). */
  maxWidth?: number;
  /** `false`: a card-only column (the table does not draw it). */
  table?: boolean;
  /** Where the column goes on a card. */
  card?: CardRole;
  /** What the card shows when it differs from the table cell (a shorter or simpler version). */
  cardCell?: (row: T) => ReactNode;
  /** The title column only: the subtitle line under the title. */
  cardSub?: (row: T) => ReactNode;
  /** The label above a fact or before a detail (default: `header`); `false` shows the value alone. */
  cardLabel?: string | false;
  /** A fact that spans the whole facts row and may wrap to 2 lines. */
  cardWide?: boolean;
  /** An `actions` column declared as data: the table cell and the card footer draw the same buttons (more than two: "More actions"). */
  rowActions?: (row: T) => RowAction[];
}

export interface DataTableProps<T> {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  getKey: (row: T) => string;
  /** Greyed rows (disabled employees, revoked devices). */
  isDim?: (row: T) => boolean;
  /** `false` keeps a table in every view (it makes no sense as cards); otherwise the global Table | Cards choice applies. */
  stack?: boolean;
  /** Forces one view and hides the Table | Cards switch (a list in a narrow side column is always cards). */
  view?: ViewMode;
  /** The record's name, for the names of its buttons ("Revoke: VM run A3"). Needed with `rowActions`. */
  rowLabel?: (row: T) => string;

  /** The current sort. Sorting is the server's job: the table only draws the headers and reports clicks. */
  sort?: SortState;
  onSortChange?: (next: SortState) => void;
  /** A server order that has no column ("Newest added"): the cards' sort control always lists it, so it can show the current order. */
  defaultSort?: SortState & { label: string };
  /** The sort control is disabled and says this instead (a search orders by relevance). */
  sortNote?: string;

  /**
   * Makes the whole row clickable. Keep a real `<Link>` in the name cell: keyboard,
   * ctrl-click and middle-click use it. Clicks on links, buttons, fields and anything
   * marked `data-no-row-click` inside the row never reach this handler. May be an
   * inline function (the rows are memoized on a stable wrapper).
   */
  onRowClick?: (row: T) => void;

  /** Default "ready". Drives the skeleton, the empty state and the error notice. */
  state?: TableState;
  skeletonRows?: number;
  /** Shown instead of the table when `state` is "empty": an `EmptyState`. */
  empty?: ReactNode;
  /** With `state="error"`: the error (as `RegionError` shows it) and the retry. */
  error?: unknown;
  onRetry?: () => void;
  /** The next page is loading: the old rows stay, dimmed, and the table is announced as busy. */
  busy?: boolean;

  /** Above the list, left: the search box and filters. */
  toolbar?: ReactNode;
  /** Above the list, right, before the sort and the view switch: list-wide actions ("Check now"). */
  toolbarEnd?: ReactNode;
  /** Under the table, inside the card (the `Pager`). Shown while `state` is "ready". */
  footer?: ReactNode;
  /** The table draws its own card. Leave off while the screen still wraps it in a `Card`. */
  framed?: boolean;
  /** The Table | Cards switch in the toolbar. Default: on when `framed`. */
  viewSwitch?: boolean;
  /** Scrolls rows inside the table with the header stuck on top (e.g. "70vh"). Without it the page scrolls. */
  maxHeight?: number | string;
  /** Changes with the page (the pager's page number): the list scrolls back into view when it does. */
  pageKey?: string | number;
}

/**
 * The one list for every screen (Phase 4b, UI pass). The table view is a semantic `<table>`:
 * `<th scope="col">`, a caption for screen readers, sortable headers (`aria-sort`), an optional
 * clickable row, loading / empty / error states, a toolbar and a footer slot (the `Pager`);
 * it scrolls sideways inside a labelled region and never makes the page wider.
 * The cards view (global choice, see `lib/viewMode.ts`) draws a `CardGrid` from the same columns
 * (roles in `lib/cardLayout.ts`), with a sort select in the toolbar instead of the headers.
 */
export function DataTable<T>({
  caption,
  columns,
  rows,
  getKey,
  isDim,
  stack = true,
  view: forcedView,
  rowLabel,
  sort,
  onSortChange,
  defaultSort,
  sortNote,
  onRowClick,
  state = "ready",
  skeletonRows = 8,
  empty,
  error,
  onRetry,
  busy = false,
  toolbar,
  toolbarEnd,
  footer,
  framed = false,
  viewSwitch,
  maxHeight,
  pageKey,
}: DataTableProps<T>) {
  const [chosen] = useViewMode();
  const view = forcedView ?? chosen;
  const asCards = stack && view === "cards";
  const surfaceRef = useRef<HTMLDivElement>(null);

  // The rows are memoized: give them one handler that never changes and reads the latest callback.
  const click = useRef(onRowClick);
  useEffect(() => {
    click.current = onRowClick;
  });
  const activate = useCallback((row: unknown) => (click.current as ((r: unknown) => void) | undefined)?.(row), []);

  useScrollToList(surfaceRef, pageKey);

  const shown = useMemo(() => tableColumns(columns), [columns]);
  // Every column except the name can only get as narrow as its content: the name column then takes the rest of the width.
  const fit = !asCards && shown.every((c) => c.primary || isShort(c));
  const showSwitch = stack && forcedView === undefined && (viewSwitch ?? framed);
  const sortsHere = columns.some((c) => c.sortable && !c.actions);
  const showSort = asCards && (sortNote !== undefined || (onSortChange !== undefined && (sortsHere || defaultSort !== undefined)));
  const showToolbar = toolbar != null || toolbarEnd != null || showSwitch || showSort;
  // Cards sit on the page itself; the card is only for the states that have no cards (empty, error).
  const bare = asCards && (state === "ready" || state === "loading");

  const nextSort = (c: Column<T>): SortState =>
    sort?.key === c.key ? { key: c.key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key: c.key, dir: c.sortDefaultDir ?? "asc" };

  let body: ReactNode;
  if (state === "loading") {
    body = asCards ? (
      <Suspense fallback={<CardsPending />}>
        <SkeletonCardsLazy count={skeletonRows} flat={!framed} />
      </Suspense>
    ) : (
      <SkeletonRows rows={skeletonRows} columns={Math.min(Math.max(shown.length - 1, 1), 5)} />
    );
  } else if (state === "error") {
    body = <RegionError error={error} onRetry={onRetry} />;
  } else if (state === "empty") {
    body = empty ?? <EmptyState title={strings.table.emptyTitle} />;
  } else if (asCards) {
    // The cards code loads only now, when a list is really shown as cards (cardsLazy.ts).
    body = (
      <Suspense fallback={<CardsPending />}>
        <CardGridLazy
          caption={caption}
          columns={columns as Column<unknown>[]}
          rows={rows}
          getKey={getKey as (row: unknown) => string}
          isDim={isDim as ((row: unknown) => boolean) | undefined}
          onActivate={onRowClick ? (activate as (row: unknown) => void) : undefined}
          rowLabel={rowLabel as ((row: unknown) => string) | undefined}
          busy={busy}
          flat={!framed}
        />
      </Suspense>
    );
  } else {
    body = (
      <div
        className={["dash-table-wrap", maxHeight !== undefined ? "dash-table-wrap--scroll" : ""].filter(Boolean).join(" ")}
        style={maxHeight !== undefined ? { maxHeight } : undefined}
        tabIndex={0}
        role="region"
        aria-label={caption}
        aria-busy={busy || undefined}
        data-busy={busy || undefined}
      >
        <table className={["rb-table", stack ? "dash-table--cardable" : "", fit ? "dash-table--fit" : ""].filter(Boolean).join(" ")}>
          <caption className="dash-sr">{caption}</caption>
          <thead>
            <tr>
              {shown.map((c) => {
                const canSort = Boolean(onSortChange && c.sortable && !c.actions);
                const active = canSort && sort?.key === c.key ? sort.dir : null;
                const Icon = active === "asc" ? IconAsc : active === "desc" ? IconDesc : IconSort;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    className={cellClass(c, true) || undefined}
                    aria-sort={canSort ? (active === "asc" ? "ascending" : active === "desc" ? "descending" : "none") : undefined}
                  >
                    {c.actions ? (
                      <span className="dash-sr">{c.header}</span>
                    ) : canSort ? (
                      <button type="button" className="dash-th-btn" data-active={active ? "true" : undefined} onClick={() => onSortChange?.(nextSort(c))}>
                        <span>{c.header}</span>
                        <Icon className="dash-th-btn__icon" aria-hidden="true" />
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Row key={getKey(row)} row={row} columns={shown as Column<unknown>[]} dim={isDim?.(row) ?? false} onActivate={onRowClick ? activate : undefined} rowLabel={rowLabel as ((r: unknown) => string) | undefined} />
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="dash-dt" data-framed={framed || undefined} data-mode={asCards ? "cards" : "table"}>
      {showToolbar ? (
        <div className="dash-dt__toolbar">
          {toolbar != null ? <div className="dash-dt__tools">{toolbar}</div> : null}
          {toolbarEnd != null || showSort || showSwitch ? (
            <div className="dash-dt__end">
              {toolbarEnd != null ? <div className="dash-dt__listactions">{toolbarEnd}</div> : null}
              {showSort ? (
                <div className="dash-dt__sortsel">
                  <Suspense fallback={null}>
                    <CardsSortSelectLazy columns={columns as Column<never>[]} sort={sort} onSortChange={onSortChange} defaultSort={defaultSort} sortNote={sortNote} />
                  </Suspense>
                </div>
              ) : null}
              {showSwitch ? <ViewSwitch /> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div ref={surfaceRef} tabIndex={-1} className={framed && !bare ? "dash-card dash-dt__surface" : "dash-dt__surface"} data-bare={bare || undefined}>
        {body}
        {state === "ready" && footer ? <div className="dash-dt__footer">{footer}</div> : null}
      </div>
    </div>
  );
}

/** The place of the cards while their code loads (a moment, the first time): no layout jump. */
function CardsPending() {
  return <div className="dash-cards-pending" role="status" aria-label={strings.app.loading} />;
}

/** A column whose cell never wraps and so cannot be squeezed below its content. */
function isShort(c: Column<never>): boolean {
  const type = columnType(c);
  return type !== "name" && type !== "text";
}

const MAX_BY_TYPE: Partial<Record<ColumnType, number>> = { name: 280, text: 360, mono: 200, badge: 280 };
const TRUNCATE_CH = 32;

/** Classes of a `th` or `td`: the type, the no-wrap rule, the name cell and the end-aligned number. */
function cellClass(c: Column<never>, header = false): string {
  const type = columnType(c);
  return [
    `dash-col--${type}`,
    c.primary ? "dash-cell--name" : "",
    c.actions ? "dash-cell--actions" : "",
    c.numeric || type === "num" ? "rb-num" : "",
    !header && isShort(c) ? "dash-cell--nowrap" : "",
    !header ? (c.className ?? "") : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The cell's content in its width box: strings get the shared tooltip; richer cells bring their own `Truncate`. */
function cellContent(c: Column<unknown>, row: unknown): ReactNode {
  const content = c.cell(row);
  if (c.truncate) {
    const max = c.truncate === true ? TRUNCATE_CH : c.truncate;
    return <Truncate maxWidth={`${max}ch`}>{content}</Truncate>;
  }
  const type = columnType(c);
  const cap = c.maxWidth ?? (type ? MAX_BY_TYPE[type] : undefined);
  if (cap === undefined || (type !== "name" && type !== "text" && type !== "mono" && type !== "badge")) return content;
  if (type !== "badge" && (typeof content === "string" || typeof content === "number")) {
    return (
      <Truncate full={String(content)} lines={type === "text" ? 2 : 1} maxWidth={cap}>
        {content}
      </Truncate>
    );
  }
  return (
    <div className={`dash-cell-box dash-cell-box--${type}`} style={{ maxWidth: cap }}>
      {content}
    </div>
  );
}

const Row = memo(function Row({
  row,
  columns,
  dim,
  onActivate,
  rowLabel,
}: {
  row: unknown;
  columns: Column<unknown>[];
  dim: boolean;
  onActivate?: (row: unknown) => void;
  rowLabel?: (row: unknown) => string;
}) {
  return (
    <tr
      data-dim={dim || undefined}
      data-clickable={onActivate ? true : undefined}
      onClick={
        onActivate
          ? (e) => {
              if (!ignoreRowClick(e)) onActivate(row);
            }
          : undefined
      }
    >
      {columns.map((c) => {
        let content: ReactNode;
        if (c.rowActions) {
          const list = c.rowActions(row);
          content = list.length > 0 ? <RowActions actions={list} rowName={rowLabel?.(row) ?? ""} /> : null;
        } else {
          content = cellContent(c, row);
        }
        return (
          <td key={c.key} className={cellClass(c) || undefined} data-empty={c.isEmpty?.(row) || undefined}>
            {content}
          </td>
        );
      })}
    </tr>
  );
});

/**
 * After the page changes, a list whose top is above the viewport scrolls back into view and takes the
 * focus (without scrolling again), so keyboard and screen-reader users start at the new page. A list
 * whose top is already visible leaves the focus on the pager button, so paging on with the keyboard works.
 */
function useScrollToList(ref: RefObject<HTMLDivElement | null>, pageKey: string | number | undefined) {
  const previous = useRef(pageKey);
  useEffect(() => {
    if (previous.current === pageKey) return;
    previous.current = pageKey;
    const el = ref.current;
    if (!el || el.getBoundingClientRect().top >= 0) return;
    const calm =
      document.documentElement.getAttribute("data-lite") === "true" || (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    el.scrollIntoView({ block: "start", behavior: calm ? "auto" : "smooth" });
    el.focus({ preventScroll: true });
  }, [pageKey, ref]);
}
