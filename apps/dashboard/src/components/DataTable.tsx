import { memo, type ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** The row's name cell: shown as the card title on phones. */
  primary?: boolean;
  /** Right-aligned action buttons; no label on phones. */
  actions?: boolean;
  numeric?: boolean;
  className?: string;
  /** Hide the cell on phones when it has nothing to show. */
  isEmpty?: (row: T) => boolean;
}

export interface DataTableProps<T> {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  getKey: (row: T) => string;
  /** Greyed rows (disabled employees, revoked devices). */
  isDim?: (row: T) => boolean;
  /** Phones: rows become cards (default). `false` keeps a scrollable table. */
  stack?: boolean;
}

/**
 * A semantic table (Step 4): `<th scope="col">`, a caption for screen
 * readers, the header sticks inside its card. Rows are never clickable as a
 * whole; the name cell holds the link. On phones each row turns into a small
 * card so nothing scrolls sideways.
 */
export function DataTable<T>({ caption, columns, rows, getKey, isDim, stack = true }: DataTableProps<T>) {
  return (
    <div className="dash-table-wrap" tabIndex={stack ? undefined : 0} role={stack ? undefined : "region"} aria-label={stack ? undefined : caption}>
      <table className={["rb-table", stack ? "dash-table--stack" : ""].filter(Boolean).join(" ")}>
        <caption className="dash-sr">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.numeric ? "rb-num" : undefined}>
                {c.actions ? <span className="dash-sr">{c.header}</span> : c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Row key={getKey(row)} row={row} columns={columns as Column<unknown>[]} dim={isDim?.(row) ?? false} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const Row = memo(function Row({ row, columns, dim }: { row: unknown; columns: Column<unknown>[]; dim: boolean }) {
  return (
    <tr data-dim={dim || undefined}>
      {columns.map((c) => {
        const cls = [
          c.primary ? "dash-cell--name" : "",
          c.actions ? "dash-cell--actions" : "",
          c.numeric ? "rb-num" : "",
          c.className ?? "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <td
            key={c.key}
            className={cls || undefined}
            data-label={c.header}
            data-primary={c.primary || undefined}
            data-empty={c.isEmpty?.(row) || undefined}
          >
            {c.cell(row)}
          </td>
        );
      })}
    </tr>
  );
});
