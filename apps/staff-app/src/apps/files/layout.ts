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
