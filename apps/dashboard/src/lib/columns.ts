import type { Column, ColumnType } from "../components/DataTable";

/**
 * The column's table type. `null` for a column that declares nothing and is not short: it keeps the
 * old "wraps like normal text" behaviour until its screen declares a `type` (the spec's default is `short`).
 * Kept apart from `cardLayout.ts` so the table path does not load the cards code.
 */
export function columnType<T>(c: Column<T>): ColumnType | null {
  if (c.type) return c.type;
  if (c.primary) return "name";
  if (c.actions) return "actions";
  if (c.numeric) return "num";
  if (c.nowrap || c.truncate) return "short";
  return null;
}

/** The columns the table draws: every one except the card-only ones (`table: false`). */
export function tableColumns<T>(columns: readonly Column<T>[]): Column<T>[] {
  return columns.filter((c) => c.table !== false);
}
