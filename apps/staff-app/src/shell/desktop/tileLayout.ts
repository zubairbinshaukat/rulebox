export type TileTier = "lg" | "md" | "sm";

export interface TileSolve {
  cols: number;
  tile: { w: number; h: number };
  tier: TileTier;
  scroll: boolean;
}

const ASPECT = 1.2;
const MAX_W = 300;
const GAP_DEFAULT = 18;

/**
 * Pick columns and tile size for `count` apps in a work area.
 * Aspect 1.2 (h = w / 1.2); max width 300; min 128 (104 when area.h < 360);
 * tier lg ≥ 230, md ≥ 160, else sm.
 */
export function solveTiles(
  area: { w: number; h: number },
  count: number,
  gap = GAP_DEFAULT,
): TileSolve {
  const minW = area.h < 360 ? 104 : 128;
  if (count <= 0 || area.w <= 0 || area.h <= 0) {
    return {
      cols: 1,
      tile: { w: Math.min(MAX_W, Math.max(minW, area.w)), h: Math.min(MAX_W, Math.max(minW, area.w)) / ASPECT },
      tier: tierOf(Math.min(MAX_W, Math.max(minW, area.w))),
      scroll: false,
    };
  }

  let best: TileSolve | null = null;

  // Prefer more columns while tiles stay ≥ minW; never exceed MAX_W.
  const maxCols = Math.max(1, Math.floor((area.w + gap) / (minW + gap)));
  for (let cols = maxCols; cols >= 1; cols--) {
    const tileW = Math.min(MAX_W, (area.w - gap * (cols - 1)) / cols);
    if (tileW < minW - 0.5) continue;
    const tileH = tileW / ASPECT;
    const rows = Math.ceil(count / cols);
    const totalH = rows * tileH + gap * Math.max(0, rows - 1);
    const scroll = totalH > area.h + 0.5;
    const candidate: TileSolve = {
      cols,
      tile: { w: tileW, h: tileH },
      tier: tierOf(tileW),
      scroll,
    };
    if (!best) {
      best = candidate;
      continue;
    }
    // Prefer layouts that fit without scroll; then larger tiles; then more cols.
    const better =
      (!scroll && best.scroll) ||
      (scroll === best.scroll && tileW > best.tile.w + 0.5) ||
      (scroll === best.scroll && Math.abs(tileW - best.tile.w) <= 0.5 && cols > best.cols);
    if (better) best = candidate;
  }

  return (
    best ?? {
      cols: 1,
      tile: { w: minW, h: minW / ASPECT },
      tier: tierOf(minW),
      scroll: true,
    }
  );
}

function tierOf(w: number): TileTier {
  if (w >= 230) return "lg";
  if (w >= 160) return "md";
  return "sm";
}
