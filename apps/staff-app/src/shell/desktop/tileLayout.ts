export type TileTier = "lg" | "md" | "sm";

/** How the desktop's app tiles are laid out: a grid per page, paged when they do not all fit. */
export interface PageLayout {
  cols: number;
  rows: number;
  /** Tiles on one page (cols × rows). */
  perPage: number;
  pages: number;
  tile: { w: number; h: number };
  tier: TileTier;
  /** True when there is more than one page: arrows and dots are shown. */
  paged: boolean;
}

/** Gap between tiles, in CSS pixels. */
export const TILE_GAP = 18;
/** Room kept on each side for the page arrows when paged. */
export const PAGE_GUTTER = 56;
/** Room kept under the grid for the page dots and caption when paged. */
export const PAGER_HEIGHT = 64;

/** Width over height of a tile. */
const ASPECT = 1.1;
const MAX_W = 236;
/** The smallest tile used to keep every app on one page. */
const MIN_W = 176;
/** The smallest tile on pages: once paging, tiles stay closer to the design's size. */
const PAGED_MIN_W = 190;
/** The smallest tile still worth showing when the area is tiny. */
const FLOOR_W = 132;

interface Fit {
  cols: number;
  rows: number;
  w: number;
}

/** The widest tile for a grid of `cols` × `rows` in the area (capped at MAX_W). */
function widthFor(width: number, height: number, cols: number, rows: number): number {
  const byWidth = (width - TILE_GAP * (cols - 1)) / cols;
  const byHeight = ((height - TILE_GAP * (rows - 1)) / rows) * ASPECT;
  return Math.min(MAX_W, byWidth, byHeight);
}

/** Every grid whose tiles are at least `minW` wide. */
function grids(width: number, height: number, minW: number): Fit[] {
  const maxCols = Math.max(1, Math.floor((width + TILE_GAP) / (minW + TILE_GAP)));
  const maxRows = Math.max(1, Math.floor((height + TILE_GAP) / (minW / ASPECT + TILE_GAP)));
  const out: Fit[] = [];
  for (let cols = 1; cols <= maxCols; cols++) {
    for (let rows = 1; rows <= maxRows; rows++) {
      const w = widthFor(width, height, cols, rows);
      if (w >= minW) out.push({ cols, rows, w });
    }
  }
  return out;
}

/** The largest tile that shows all `count` apps at once (fewest empty places on a tie). */
function onePage(width: number, height: number, count: number): Fit | null {
  let best: Fit | null = null;
  for (const fit of grids(width, height, MIN_W)) {
    if (fit.cols * fit.rows < count || fit.cols > count) continue;
    const better =
      !best ||
      fit.w > best.w + 0.5 ||
      (Math.abs(fit.w - best.w) <= 0.5 && fit.cols * fit.rows < best.cols * best.rows);
    if (better) best = fit;
  }
  return best;
}

/** The page grid: most tiles per page at PAGED_MIN_W or more, larger tiles on a tie. */
function pageGrid(width: number, height: number): Fit {
  let best: Fit | null = null;
  for (const fit of grids(width, height, PAGED_MIN_W)) {
    const better =
      !best ||
      fit.cols * fit.rows > best.cols * best.rows ||
      (fit.cols * fit.rows === best.cols * best.rows && fit.w > best.w + 0.5);
    if (better) best = fit;
  }
  // A tiny area: one tile, as large as it can be, but never below the floor.
  return best ?? { cols: 1, rows: 1, w: Math.max(FLOOR_W, widthFor(width, height, 1, 1)) };
}

function tierOf(w: number): TileTier {
  if (w >= 210) return "lg";
  if (w >= 168) return "md";
  return "sm";
}

/**
 * Pure: the layout for `count` apps in an area of `area.w` × `area.h` CSS
 * pixels. Everything on one page when it fits with tiles of at least MIN_W;
 * otherwise the arrows and the dots take their room first and the apps are
 * split into pages of the fullest grid that is left.
 */
export function solvePages(area: { w: number; h: number }, count: number): PageLayout {
  const one = onePage(area.w, area.h, Math.max(1, count));
  const fit = one ?? pageGrid(area.w - 2 * PAGE_GUTTER, area.h - PAGER_HEIGHT);
  const perPage = fit.cols * fit.rows;
  const pages = one ? 1 : Math.max(1, Math.ceil(count / perPage));
  return {
    cols: fit.cols,
    rows: fit.rows,
    perPage,
    pages,
    tile: { w: Math.floor(fit.w), h: Math.floor(fit.w / ASPECT) },
    tier: tierOf(fit.w),
    paged: pages > 1,
  };
}

/** Pure: the slice of `items` on `page` (clamped into range). */
export function pageSlice<T>(items: readonly T[], page: number, perPage: number): T[] {
  const last = Math.max(0, Math.ceil(items.length / Math.max(1, perPage)) - 1);
  const at = Math.min(Math.max(0, page), last);
  return items.slice(at * perPage, at * perPage + perPage);
}

/**
 * Pure: where arrow-key focus goes from tile `index` (over all pages) in a
 * grid of `cols`. Left and right run on through the pages; up and down move
 * a row and stop at the ends.
 */
export function moveFocus(
  index: number,
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End",
  cols: number,
  count: number,
): number {
  if (count <= 0) return 0;
  const clamp = (n: number) => Math.min(Math.max(0, n), count - 1);
  switch (key) {
    case "ArrowLeft":
      return clamp(index - 1);
    case "ArrowRight":
      return clamp(index + 1);
    case "ArrowUp":
      return index - cols >= 0 ? index - cols : index;
    case "ArrowDown":
      return index + cols < count ? index + cols : index;
    case "Home":
      return 0;
    case "End":
      return count - 1;
  }
}
