import { useId, useMemo } from "react";
import { Select } from "@rulebox/ui";
import { sortOptions } from "../lib/cardLayout";
import { strings } from "../lib/strings";
import type { Column, SortState } from "./DataTable";

export interface CardsSortSelectProps {
  columns: Column<never>[];
  sort?: SortState;
  onSortChange?: (next: SortState) => void;
  defaultSort?: SortState & { label: string };
  /** The control is disabled and says this instead (a search orders by relevance). */
  sortNote?: string;
}

/**
 * The cards view's sort control: a custom `Select` with plain labels ("Enrolled: newest first"). A module
 * of its own (loaded with the cards code) because the table has sortable headers and never needs it.
 */
export function CardsSortSelect({ columns, sort, onSortChange, defaultSort, sortNote }: CardsSortSelectProps) {
  const id = useId();
  const options = useMemo(() => sortOptions(columns, defaultSort), [columns, defaultSort]);
  return (
    <Select
      id={id}
      compact
      aria-label={strings.table.sortSelect}
      options={sortNote !== undefined ? [] : options}
      value={sortNote !== undefined || !sort ? "" : `${sort.key}:${sort.dir}`}
      placeholder={sortNote ?? strings.table.sortSelect}
      disabled={sortNote !== undefined}
      onChange={(v) => {
        const [key, dir] = v.split(":");
        if (key && (dir === "asc" || dir === "desc")) onSortChange?.({ key, dir });
      }}
    />
  );
}
