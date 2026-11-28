import type { ReactNode } from "react";
import type { SelectOption } from "@rulebox/ui";
import type { CardRole, Column, ColumnType, SortState } from "../components/DataTable";
import { strings } from "./strings";

/** At most this many facts per card; further `fact` columns are shown as details. */
export const MAX_FACTS = 4;

/** The subtitle line under the card title: the title column's `cardSub`, or a `card: "subtitle"` column. */
export interface CardSubtitle<T> {
  key: string;
  render: (row: T) => ReactNode;
  isEmpty?: (row: T) => boolean;
}

export interface CardLayout<T> {
  title: Column<T>;
  subtitle?: CardSubtitle<T>;
  status: Column<T>[];
  facts: Column<T>[];
  details: Column<T>[];
  actions?: Column<T>;
}

/** What a column is in a card when it does not say: the name is the title, the buttons are the actions, the rest are facts. */
export function cardRole<T>(c: Column<T>): CardRole {
  return c.card ?? (c.primary ? "title" : c.actions ? "actions" : "fact");
}

/**
 * The column's table type. `null` for a column that declares nothing and is not short: it keeps the
 * old "wraps like normal text" behaviour until its screen declares a `type` (the spec's default is `short`).
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

const warned = new WeakSet<object>();

/**
 * Sorts the columns into the slots of a card (see `lists-and-cards.md` 3a). Pure: call it once per
 * `columns` array (memoized in `CardGrid`), never per row. A list without a title column cannot be
 * shown as cards: that is a bug in the screen, so it throws in development.
 */
export function cardLayout<T>(columns: readonly Column<T>[]): CardLayout<T> {
  let title: Column<T> | undefined;
  let subtitle: CardSubtitle<T> | undefined;
  let actions: Column<T> | undefined;
  const status: Column<T>[] = [];
  const facts: Column<T>[] = [];
  const details: Column<T>[] = [];
  const order = new Map<Column<T>, number>();

  columns.forEach((c, i) => {
    order.set(c, i);
    const role = cardRole(c);
    switch (role) {
      case "hidden":
        break;
      case "title":
        if (title) facts.push(c);
        else title = c;
        break;
      case "subtitle":
        if (subtitle) details.push(c);
        else subtitle = { key: c.key, render: c.cardCell ?? c.cell, isEmpty: c.isEmpty };
        break;
      case "status":
        status.push(c);
        break;
      case "fact":
        facts.push(c);
        break;
      case "detail":
        details.push(c);
        break;
      case "actions":
        if (!actions) actions = c;
        break;
    }
  });

  if (!title) {
    // A column that wants to be a title but is not first one cannot happen above; this is "no title at all".
    if (import.meta.env.DEV) throw new Error("A list shown as cards needs one column with `primary: true` or `card: \"title\"`.");
    title = columns.find((c) => c.table !== false && !c.actions) ?? columns[0]!;
  }
  if (title.cardSub && !subtitle) subtitle = { key: `${title.key}:sub`, render: title.cardSub };

  let shown = facts;
  if (facts.length > MAX_FACTS) {
    shown = facts.slice(0, MAX_FACTS);
    details.push(...facts.slice(MAX_FACTS));
    details.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    if (import.meta.env.DEV && import.meta.env.MODE !== "test" && !warned.has(columns)) {
      warned.add(columns);
      console.warn(`A card shows at most ${MAX_FACTS} facts; "${facts.slice(MAX_FACTS).map((c) => c.key).join('", "')}" became details.`);
    }
  }

  return { title, subtitle, status, facts: shown, details, actions };
}

type SortKind = "name" | "date" | "num";

/** What kind of values a sortable column has, for the words of its two directions. */
function sortKind<T>(c: Column<T>): SortKind {
  const type = columnType(c);
  if (type === "date") return "date";
  if (type === "num") return "num";
  // A list that has not declared its types yet: a column that sorts "newest first" first is a date.
  if (type === null || type === "short") return c.sortDefaultDir === "desc" ? "date" : "name";
  return "name";
}

/**
 * The options of the sort `Select` in cards view, in plain words ("Enrolled: newest first").
 * One pair per sortable column, the column's first-click direction first. `defaultSort` (a server
 * order that has no column, like "Newest added") always comes first so the Select can show the
 * current order.
 */
export function sortOptions<T>(columns: readonly Column<T>[], defaultSort?: SortState & { label: string }): SelectOption[] {
  const out: SelectOption[] = [];
  if (defaultSort) out.push({ value: `${defaultSort.key}:${defaultSort.dir}`, label: defaultSort.label });
  for (const c of columns) {
    if (!c.sortable || c.actions) continue;
    const kind = sortKind(c);
    const first = c.sortDefaultDir ?? (kind === "num" ? "desc" : "asc");
    const dirs = first === "asc" ? (["asc", "desc"] as const) : (["desc", "asc"] as const);
    const label = typeof c.cardLabel === "string" ? c.cardLabel : c.header;
    for (const dir of dirs) {
      const value = `${c.key}:${dir}`;
      if (out.some((o) => o.value === value)) continue;
      out.push({ value, label: strings.table.sortOption(label, strings.table.sortDir[kind][dir]) });
    }
  }
  return out;
}
