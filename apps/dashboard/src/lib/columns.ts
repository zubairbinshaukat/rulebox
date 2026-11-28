import type { Column, ColumnType } from "../components/DataTable";

/**
 * The column's table type: the declared `type`, else `name` for the primary column, `actions`, `num` for a numeric one, and `short`
 * (never wraps) for everything else. A column with free text (a reason, a summary) must declare `type: "text"`.
 * Kept apart from `cardLayout.ts` so the table path does not load the cards code.
 */
export function columnType<T>(c: Column<T>): ColumnType {
  if (c.type) return c.type;
  if (c.primary) return "name";
  if (c.actions) return "actions";
  if (c.numeric) return "num";
  return "short";
}

/** The columns the table draws: every one except the card-only ones (`table: false`). */
export function tableColumns<T>(columns: readonly Column<T>[]): Column<T>[] {
  return columns.filter((c) => c.table !== false);
}
