import { describe, expect, it } from "vitest";

import { moveFocus, pageSlice, PAGE_GUTTER, solvePages, TILE_GAP } from "./tileLayout";

// The tile area on common screens: the desktop minus padding, header, taskbar
// and (from 1000 px) the My files panel.
const AREAS = [
  { name: "1024×768", w: 1024 - 72 - 324, h: 768 - 230 },
  { name: "1366×768", w: 1366 - 72 - 324, h: 768 - 230 },
  { name: "1920×1080", w: 1920 - 72 - 324, h: 1080 - 230 },
] as const;

function width(cols: number, tileW: number) {
  return cols * tileW + (cols - 1) * TILE_GAP;
}

describe("solvePages", () => {
  for (const area of AREAS) {
    for (const count of [0, 1, 4, 8, 12, 30]) {
      it(`${area.name} / ${count} apps fits the area`, () => {
        const layout = solvePages(area, count);
        const room = layout.paged ? area.w - 2 * PAGE_GUTTER : area.w;
        expect(width(layout.cols, layout.tile.w)).toBeLessThanOrEqual(room + 0.5);
        expect(layout.rows * layout.tile.h + (layout.rows - 1) * TILE_GAP).toBeLessThanOrEqual(area.h + 0.5);
        expect(layout.tile.w).toBeLessThanOrEqual(236);
        expect(layout.pages * layout.perPage).toBeGreaterThanOrEqual(count);
        expect(layout.paged).toBe(layout.pages > 1);
      });
    }
  }

  it("keeps everything on one page while it fits", () => {
    const layout = solvePages({ w: 1000, h: 520 }, 6);
    expect(layout.pages).toBe(1);
    expect(layout.paged).toBe(false);
  });

  it("pages when the apps do not fit, leaving room for arrows and dots", () => {
    const layout = solvePages({ w: 970, h: 538 }, 30);
    expect(layout.paged).toBe(true);
    expect(layout.pages).toBe(Math.ceil(30 / layout.perPage));
    expect(width(layout.cols, layout.tile.w)).toBeLessThanOrEqual(970 - 2 * PAGE_GUTTER);
  });

  it("still shows one tile in a tiny area", () => {
    const layout = solvePages({ w: 100, h: 90 }, 3);
    expect(layout.perPage).toBeGreaterThanOrEqual(1);
    expect(layout.tier).toBe("sm");
  });
});

describe("pageSlice", () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  it("returns the page and clamps out-of-range pages", () => {
    expect(pageSlice(items, 0, 4)).toEqual([0, 1, 2, 3]);
    expect(pageSlice(items, 2, 4)).toEqual([8, 9]);
    expect(pageSlice(items, 9, 4)).toEqual([8, 9]);
    expect(pageSlice(items, -1, 4)).toEqual([0, 1, 2, 3]);
  });
});

describe("moveFocus", () => {
  it("moves through the grid and across pages", () => {
    expect(moveFocus(3, "ArrowRight", 4, 10)).toBe(4);
    expect(moveFocus(9, "ArrowRight", 4, 10)).toBe(9);
    expect(moveFocus(0, "ArrowLeft", 4, 10)).toBe(0);
    expect(moveFocus(1, "ArrowDown", 4, 10)).toBe(5);
    expect(moveFocus(7, "ArrowDown", 4, 10)).toBe(7);
    expect(moveFocus(5, "ArrowUp", 4, 10)).toBe(1);
    expect(moveFocus(5, "End", 4, 10)).toBe(9);
    expect(moveFocus(5, "Home", 4, 10)).toBe(0);
  });
});
