import { describe, expect, it } from "vitest";

import { solveTiles } from "./tileLayout";

const AREAS = [
  { name: "1366×768", w: 1366 - 80, h: 768 - 160 },
  { name: "1920×1080", w: 1920 - 80, h: 1080 - 160 },
] as const;

const COUNTS = [0, 1, 3, 7, 8, 16, 24] as const;

describe("solveTiles", () => {
  for (const area of AREAS) {
    for (const count of COUNTS) {
      it(`${area.name} / ${count} apps`, () => {
        const solved = solveTiles({ w: area.w, h: area.h }, count);
        expect(solved.cols).toBeGreaterThanOrEqual(1);
        expect(solved.tile.w).toBeLessThanOrEqual(300 + 0.01);
        const minW = area.h < 360 ? 104 : 128;
        if (count > 0) {
          expect(solved.tile.w).toBeGreaterThanOrEqual(minW - 0.5);
        }
        expect(solved.tile.h).toBeCloseTo(solved.tile.w / 1.2, 5);
        if (solved.tile.w >= 230) expect(solved.tier).toBe("lg");
        else if (solved.tile.w >= 160) expect(solved.tier).toBe("md");
        else expect(solved.tier).toBe("sm");
        const rows = count === 0 ? 0 : Math.ceil(count / solved.cols);
        const totalH =
          rows === 0 ? 0 : rows * solved.tile.h + 18 * Math.max(0, rows - 1);
        expect(solved.scroll).toBe(totalH > area.h + 0.5);
      });
    }
  }
});
