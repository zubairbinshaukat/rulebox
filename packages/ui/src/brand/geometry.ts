/*
 * Rulebox logo geometry (viewBox 0 0 120 120): a rounded box holding a 7x9
 * grid. Allowed tiles form the letter R, blocked tiles shrink to dots, and
 * the leg of the R carries the brand green.
 *
 * Single source of truth: used by <LogoMark> and by scripts/build-brand.mjs,
 * which generates every static file in assets/brand/. Keep this file free of
 * imports so Node can load it directly.
 */

export const LOGO_VIEWBOX = 120;

/** Brand green ("Signal green"). Mirrors --rb-brand in tokens.css. */
export const LOGO_BRAND = "#12b76a";

/** Outline box. */
export const LOGO_BOX = { x: 9, y: 9, size: 102, rx: 28, stroke: 6 };

/** Filled tile behind the app icon variant. */
export const LOGO_TILE_BG = { size: 120, rx: 30 };

const PATTERN = [
  "######.",
  "#######",
  "##...##",
  "##...##",
  "#######",
  "######.",
  "##.##..",
  "##..##.",
  "##...##",
];
const CELL = 7;
const PITCH = 8.6;
const X0 = 30.7;
const Y0 = 22.1;
const CELL_RX = 2;
/** Blocked tiles are drawn at 40% size and 45% opacity. */
const OFF_SCALE = 0.4;
export const LOGO_OFF_OPACITY = 0.45;

/** Raw grid, for <LogoMotion>, which scales full-size tiles instead of insetting them. */
export const LOGO_GRID = { cell: CELL, pitch: PITCH, x0: X0, y0: Y0, rx: CELL_RX, offScale: OFF_SCALE };

export interface LogoCell {
  row: number;
  col: number;
  x: number;
  y: number;
  size: number;
  rx: number;
  /** Part of the R. */
  on: boolean;
  /** Part of the R's leg (brand color). */
  leg: boolean;
}

const round = (n: number) => Math.round(n * 100) / 100;

export const LOGO_CELLS: LogoCell[] = PATTERN.flatMap((line, row) =>
  [...line].map((ch, col) => {
    const on = ch === "#";
    const size = on ? CELL : CELL * OFF_SCALE;
    const inset = (CELL - size) / 2;
    return {
      row,
      col,
      x: round(X0 + col * PITCH + inset),
      y: round(Y0 + row * PITCH + inset),
      size: round(size),
      rx: round(on ? CELL_RX : CELL_RX * OFF_SCALE),
      on,
      leg: on && row >= 6 && col >= 3,
    };
  }),
);
