import { memo, useCallback, useEffect, useId, useRef, type MouseEvent, type ReactNode } from "react";
import { NativeSelect } from "@rulebox/ui";
import IconSort from "~icons/solar/sort-vertical-linear";
import IconAsc from "~icons/solar/arrow-up-linear";
import IconDesc from "~icons/solar/arrow-down-linear";
import { type SortDir } from "../lib/cursorPager";
import { strings } from "../lib/strings";
import { useViewMode } from "../lib/viewMode";
import { EmptyState } from "./EmptyState";
import { RegionError } from "./Region";
import { SkeletonRows } from "./Skeleton";
import { ViewSwitch } from "./ViewSwitch";

export type { SortDir };

export interface SortState {
  key: string;
  dir: SortDir;
}

/** `ready` is the default; `empty` shows `empty` instead of the table. */
export type TableState = "loading" | "error" | "empty" | "ready";

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** The row's name cell: shown as the card title on phones. */
  primary?: boolean;
  /** Right-aligned action buttons; no label on phones. */
  actions?: boolean;
  numeric?: boolean;
  /**
   * The cell never wraps. Set it on every short value: dates and "4 minutes ago", states and badges,
   * counts like "0 of 1 used", versions. `numeric` and `actions` columns are nowrap without it.
   */
  nowrap?: boolean;
  /**
   * Long free text: the cell is cut with an ellipsis after this many characters (`true` = 32), never wraps,
   * and the full text shows on hover (it always stays in the page for screen readers and find-in-page).
   */
  truncate?: boolean | number;
  className?: string;
  /** Hide the cell on phones when it has nothing to show. */
  isEmpty?: (row: T) => boolean;
  /** The header becomes a sort button. `key` is what `onSortChange` reports, so it must be a server sort key. */
  sortable?: boolean;
  /** The direction a first click sorts by (dates and counts usually want "desc"). Default "asc". */
  sortDefaultDir?: SortDir;
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

  /** The current sort. Sorting is the server's job: the table only draws the headers and reports clicks. */
  sort?: SortState;
  onSortChange?: (next: SortState) => void;

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

  /** Above the table, left of the view switch: the search box and filters. */
  toolbar?: ReactNode;
  /** Under the table, inside the card (the `Pager`). Shown while `state` is "ready". */
  footer?: ReactNode;
  /** The table draws its own card. Leave off while the screen still wraps it in a `Card`. */
  framed?: boolean;
  /** The Table | Cards switch in the toolbar. Default: on when `framed`. */
  viewSwitch?: boolean;
  /** Scrolls rows inside the table with the header stuck on top (e.g. "70vh"). Without it the page scrolls. */
  maxHeight?: number | string;
}

/**
 * The one table for every list (Phase 4b). A semantic `<table>`: `<th scope="col">`,
 * a caption for screen readers, sortable headers (`aria-sort`), an optional
 * clickable row, loading / empty / error states, a toolbar and a footer slot
 * (the `Pager`). Table view scrolls sideways in a labelled region at every width;
 * the cards view (`<html data-view="cards">`, see `lib/viewMode.ts`) turns each
 * row into a card whatever the width.
 */
export function DataTable<T>({
  caption,
  columns,
  rows,
  getKey,
  isDim,
  stack = true,
  sort,
  onSortChange,
  onRowClick,
  state = "ready",
  skeletonRows = 8,
  empty,
  error,
  onRetry,
  busy = false,
  toolbar,
  footer,
  framed = false,
  viewSwitch,
  maxHeight,
}: DataTableProps<T>) {
  const [view] = useViewMode();
  const asCards = stack && view === "cards";
  const sortId = useId();

  // The rows are memoized: give them one handler that never changes and reads the latest callback.
  const click = useRef(onRowClick);
  useEffect(() => {
    click.current = onRowClick;
  });
  const activate = useCallback((row: unknown) => (click.current as ((r: unknown) => void) | undefined)?.(row), []);

  // Every column except the name can only get as narrow as its content: the name column then takes the rest of the width.
  const fit = !asCards && columns.every((c) => c.primary || isShort(c));
  const sortable = onSortChange ? columns.filter((c) => c.sortable && !c.actions) : [];
  const showSwitch = stack && (viewSwitch ?? framed);
  const showToolbar = toolbar != null || showSwitch;

  const nextSort = (c: Column<T>): SortState =>
    sort?.key === c.key ? { key: c.key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key: c.key, dir: c.sortDefaultDir ?? "asc" };

  let body: ReactNode;
  if (state === "loading") {
    body = <SkeletonRows rows={skeletonRows} columns={Math.min(Math.max(columns.length - 1, 1), 5)} />;
  } else if (state === "error") {
    body = <RegionError error={error} onRetry={onRetry} />;
  } else if (state === "empty") {
    body = empty ?? <EmptyState title={strings.table.emptyTitle} />;
  } else {
    body = (
      <div
        className={["dash-table-wrap", maxHeight !== undefined ? "dash-table-wrap--scroll" : ""].filter(Boolean).join(" ")}
        style={maxHeight !== undefined ? { maxHeight } : undefined}
        tabIndex={asCards ? undefined : 0}
        role={asCards ? undefined : "region"}
        aria-label={asCards ? undefined : caption}
        aria-busy={busy || undefined}
        data-busy={busy || undefined}
      >
        <table className={["rb-table", stack ? "dash-table--stack" : "", fit ? "dash-table--fit" : ""].filter(Boolean).join(" ")}>
          <caption className="dash-sr">{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => {
                const canSort = Boolean(onSortChange && c.sortable && !c.actions);
                const active = canSort && sort?.key === c.key ? sort.dir : null;
                const Icon = active === "asc" ? IconAsc : active === "desc" ? IconDesc : IconSort;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    className={c.numeric ? "rb-num" : undefined}
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
              <Row key={getKey(row)} row={row} columns={columns as Column<unknown>[]} dim={isDim?.(row) ?? false} onActivate={onRowClick ? activate : undefined} cards={asCards} />
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="dash-dt" data-framed={framed || undefined}>
      {showToolbar ? (
        <div className="dash-dt__toolbar">
          {toolbar != null ? <div className="dash-dt__tools">{toolbar}</div> : <span className="dash-dt__tools" />}
          {sortable.length > 0 ? (
            <div className="dash-dt__sortsel">
              <label htmlFor={sortId} className="dash-sr">
                {strings.table.sortSelect}
              </label>
              <NativeSelect
                id={sortId}
                compact
                value={sort ? `${sort.key}:${sort.dir}` : ""}
                onChange={(e) => {
                  const [key, dir] = e.target.value.split(":");
                  if (key && (dir === "asc" || dir === "desc")) onSortChange?.({ key, dir });
                }}
              >
                {sort ? null : <option value="">{strings.table.sortSelect}</option>}
                {sortable.flatMap((c) =>
                  (["asc", "desc"] as const).map((dir) => (
                    <option key={`${c.key}:${dir}`} value={`${c.key}:${dir}`}>
                      {strings.table.sortOption(c.header, dir)}
                    </option>
                  )),
                )}
              </NativeSelect>
            </div>
          ) : null}
          {showSwitch ? <ViewSwitch /> : null}
        </div>
      ) : null}
      <div className={framed ? "dash-card dash-dt__surface" : "dash-dt__surface"}>
        {body}
        {state === "ready" && footer ? <div className="dash-dt__footer">{footer}</div> : null}
      </div>
    </div>
  );
}

/** Elements inside a row that own their click: the row's click must not fire for them. */
const OWN_CLICK =
  'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="dialog"], [role="alertdialog"], .rb-dialog-backdrop, [contenteditable="true"], [data-no-row-click]';

function ignoreRowClick(e: MouseEvent<HTMLElement>): boolean {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return true;
  // A dialog opened from a cell is portalled to <body>: React still bubbles its clicks here, but it is not in the row.
  if (!e.currentTarget.contains(e.target as Node)) return true;
  const hit = (e.target as Element).closest(OWN_CLICK);
  if (hit && e.currentTarget.contains(hit)) return true;
  // The person is selecting text in the row: not a click on the row.
  const selection = window.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && selection.toString().length > 0);
}

/** A column whose cell never wraps and so cannot be squeezed below its content. */
function isShort(c: Column<never>): boolean {
  return Boolean(c.nowrap || c.numeric || c.actions || c.truncate);
}

const TRUNCATE_CH = 32;

/** Long text in a cell: cut after `max` characters. The title (the full text) is set when the text is really cut. */
function Truncated({ max, children }: { max: number; children: ReactNode }) {
  return (
    <span
      className="dash-cell-trunc"
      style={{ maxWidth: `${max}ch` }}
      title={typeof children === "string" ? children : undefined}
      onMouseEnter={(e) => {
        const el = e.currentTarget;
        if (typeof children === "string") return;
        if (el.scrollWidth > el.clientWidth) el.title = el.textContent ?? "";
        else el.removeAttribute("title");
      }}
    >
      {children}
    </span>
  );
}

const Row = memo(function Row({
  row,
  columns,
  dim,
  onActivate,
  cards,
}: {
  row: unknown;
  columns: Column<unknown>[];
  dim: boolean;
  onActivate?: (row: unknown) => void;
  /** Cards view: cells stack, so the one-line rules of the table view stay off. */
  cards: boolean;
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
        const cls = [
          c.primary ? "dash-cell--name" : "",
          c.actions ? "dash-cell--actions" : "",
          c.numeric ? "rb-num" : "",
          !cards && isShort(c) ? "dash-cell--nowrap" : "",
          c.className ?? "",
        ]
          .filter(Boolean)
          .join(" ");
        const content = c.cell(row);
        const max = c.truncate === true ? TRUNCATE_CH : c.truncate || 0;
        return (
          <td
            key={c.key}
            className={cls || undefined}
            data-label={c.header}
            data-primary={c.primary || undefined}
            data-empty={c.isEmpty?.(row) || undefined}
          >
            {max > 0 ? <Truncated max={max}>{content}</Truncated> : content}
          </td>
        );
      })}
    </tr>
  );
});
