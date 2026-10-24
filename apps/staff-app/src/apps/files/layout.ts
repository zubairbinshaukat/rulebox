/** Sizes shared by the list, the grid and the keyboard paging. */
export const LIST_ROW_HEIGHT = 40;
export const GRID_ITEM_MIN_WIDTH = 124;
export const GRID_ROW_HEIGHT = 136;
export const GRID_GAP = 12;
export const GRID_SIDE_PADDING = 16;

/** How many grid columns fit in `width` pixels. */
export function gridColumnsFor(width: number): number {
  const usable = width - GRID_SIDE_PADDING * 2;
  return Math.max(1, Math.floor((usable + GRID_GAP) / (GRID_ITEM_MIN_WIDTH + GRID_GAP)));
}

/** One row with everything, two rows (search leads the second), or two compact rows. */
export type ToolbarMode = "wide" | "stacked" | "narrow";

/** Pure: the toolbar layout for the width beside the sidebar. */
export function toolbarModeFor(width: number): ToolbarMode {
  if (width >= 860) return "wide";
  if (width >= 540) return "stacked";
  return "narrow";
}

export type Column = "name" | "type" | "size" | "modified";

/** The fixed list columns' widths; the name takes the rest. */
export const COLUMN_WIDTH: Record<Exclude<Column, "name">, number> = { type: 96, size: 88, modified: 168 };

/**
 * Pure: which list columns fit in a list `width` pixels wide. The name keeps
 * at least 180 px; Type goes first, then Size, then the date.
 */
export function visibleColumns(width: number): Set<Column> {
  const room = width - 32 - 180;
  const shown = new Set<Column>(["name"]);
  let used = 0;
  for (const column of ["modified", "size", "type"] as const) {
    used += COLUMN_WIDTH[column];
    if (used <= room) shown.add(column);
  }
  return shown;
}
