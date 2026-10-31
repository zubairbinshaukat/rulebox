/**
 * The logo of an app icon, cut out and enlarged to fill a small icon box (no DOM, pure).
 *
 * Why: a catalogue icon is usually a small logo in the middle of a padded square (Zubyr's
 * black Z on cream, Batwa's wallet on lavender). Drawn with `object-fit: cover` the padding
 * stays, so on a 34 px taskbar button the logo is a small mark inside a big blank square.
 * The small icons (taskbar, Alt+Tab, Start menu, desktop tile) instead show this cut-out:
 *
 *  1. crop the original bitmap to the logo's bounding box (from `iconAnalysis`) plus a small
 *     safe margin, as a square so the aspect ratio is kept;
 *  2. resample that crop from the original pixels (area average, premultiplied), at most
 *     `MAX_CUTOUT_SIDE` px, so it is sharp at 2x the displayed size;
 *  3. key the flat background out again on the crop (soft alpha ramp) and lift the logo's
 *     real colours off it, so an anti-aliased rim carries no tint of the old background.
 *
 * The cut-out is drawn straight on the surface, with no box and never on the icon's old
 * background colour, so the logo itself reaches almost the box edges. A logo that would vanish
 * on the theme's surface (a black Z on dark) is recoloured, never boxed (`recolorFor`). Icons
 * that cannot be keyed keep `cover`.
 */

import { analyzePixels, BOUNDS_ALPHA, boundsOf, type IconAnalysis, type Pixels } from "./iconAnalysis";

/** Share of the output left clear on each side of the logo's longer side (3.5% => the logo spans 93%). */
export const LOGO_MARGIN = 0.035;
/** A logo this dark (mean relative luminance) vanishes on the dark theme's surface. */
export const DARK_LOGO_LUMA = 0.06;
/** A logo this light vanishes on the light theme's surface. */
export const LIGHT_LOGO_LUMA = 0.55;

/**
 * Which logos are recoloured on one theme so they read on its surface (`data-icon-recolor`; the
 * filter is the `--rb-logo-filter-*` token, `none` on the other theme): `dark-logo` (a black Z)
 * is drawn light on the dark theme, `light-logo` dark on the light theme. The filter acts on the
 * cut-out's colours only, its alpha is untouched, so there is no box and no halo. Most logos
 * need none.
 */
export function recolorFor(luma: number): "dark-logo" | "light-logo" | undefined {
  if (luma < DARK_LOGO_LUMA) return "dark-logo";
  if (luma > LIGHT_LOGO_LUMA) return "light-logo";
  return undefined;
}
/** The cut-out is at most this many px a side (the largest icon box is a desktop tile, about 72 px at 2x). */
export const MAX_CUTOUT_SIDE = 256;
export const MIN_CUTOUT_SIDE = 32;

export interface Cutout {
  /** Square side in px. */
  side: number;
  /** RGBA (not premultiplied), `side * side` pixels. */
  data: Uint8ClampedArray;
}

/** The square (in source pixels) that holds the logo's box and its margin, centred on the logo. */
export function cropSquare(
  analysis: Pick<IconAnalysis, "bounds">,
  source: { width: number; height: number },
  margin = LOGO_MARGIN,
): { x: number; y: number; side: number } | null {
  const b = analysis.bounds;
  if (!b) return null;
  const w = (b.right - b.left) * source.width;
  const h = (b.bottom - b.top) * source.height;
  const side = Math.max(w, h) / (1 - 2 * margin);
  if (!(side > 0)) return null;
  return {
    x: ((b.left + b.right) / 2) * source.width - side / 2,
    y: ((b.top + b.bottom) / 2) * source.height - side / 2,
    side,
  };
}

/**
 * Resample the square `(x, y, side)` of `src` to `out` x `out` px. Each output pixel is the
 * average of `k x k` bilinear samples (k covers the downscale), averaged weighted by alpha so a
 * clear pixel does not darken its neighbours. Outside the image the colour is `pad`.
 */
function resample(
  src: Pixels,
  square: { x: number; y: number; side: number },
  out: number,
  pad: readonly [number, number, number, number],
): Uint8ClampedArray {
  const { width, height, data } = src;
  const result = new Uint8ClampedArray(out * out * 4);
  const step = square.side / out;
  const k = Math.max(1, Math.ceil(step));
  const texel = (ix: number, iy: number, c: number) =>
    ix < 0 || iy < 0 || ix >= width || iy >= height ? (pad[c] ?? 0) : (data[(iy * width + ix) * 4 + c] ?? 0);
  for (let oy = 0; oy < out; oy += 1) {
    for (let ox = 0; ox < out; ox += 1) {
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      for (let sy = 0; sy < k; sy += 1) {
        for (let sx = 0; sx < k; sx += 1) {
          const u = square.x + (ox + (sx + 0.5) / k) * step - 0.5;
          const v = square.y + (oy + (sy + 0.5) / k) * step - 0.5;
          const ix = Math.floor(u);
          const iy = Math.floor(v);
          const fx = u - ix;
          const fy = v - iy;
          for (let n = 0; n < 4; n += 1) {
            const dx = n & 1;
            const dy = n >> 1;
            const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
            if (weight === 0) continue;
            const a = (texel(ix + dx, iy + dy, 3) / 255) * weight;
            pr += texel(ix + dx, iy + dy, 0) * a;
            pg += texel(ix + dx, iy + dy, 1) * a;
            pb += texel(ix + dx, iy + dy, 2) * a;
            pa += a;
          }
        }
      }
      const o = (oy * out + ox) * 4;
      if (pa > 0) {
        result[o] = pr / pa;
        result[o + 1] = pg / pa;
        result[o + 2] = pb / pa;
        result[o + 3] = (pa / (k * k)) * 255;
      }
    }
  }
  return result;
}

/** A rim pixel takes the logo's colour from the opaque pixel furthest from the background within this many px. */
const RIM_REACH = 3;
/** A logo colour closer than this to the background cannot be told from it (no matting then). */
const MIN_CONTRAST = 40;
/** A rim pixel further than this from the line background -> logo colour is not a blend of the two. */
const MAX_RESIDUAL = 40;

/**
 * Matte the anti-aliased rim of a keyed logo. The key (`analyzePixels`) leaves a rim pixel half
 * way between the background and the logo fully opaque, with its blended colour: invisible on a
 * plate of the background colour, a pale fringe on any other. For each rim pixel this finds the
 * logo's own colour from the opaque pixel furthest from the background nearby, then solves `pixel = a * logo + (1 - a) * background`
 * for the coverage `a`, and gives the pixel the logo's colour with that coverage. Rim pixels that
 * are not such a blend (two logo colours meeting) are left as they were.
 */
function matteRim(
  crop: Uint8ClampedArray,
  side: number,
  alpha: Uint8Array,
  bg: readonly number[],
): { alpha: Uint8Array; colour: Uint8ClampedArray } {
  const count = side * side;
  const rim = new Uint8Array(count);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const i = y * side + x;
      if ((alpha[i] ?? 0) === 0) continue;
      scan: for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= side || ny >= side) continue;
          if ((alpha[ny * side + nx] ?? 0) < 255) {
            rim[i] = 1;
            break scan;
          }
        }
      }
    }
  }
  // The logo's own colour at a rim pixel: the opaque pixel in reach that is furthest from the
  // background (a thin stroke has no pure interior, so "furthest" beats "nearest solid").
  const source = new Int32Array(count).fill(-1);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const i = y * side + x;
      if (!rim[i]) continue;
      let best = -1;
      let bestDistance = -1;
      for (let dy = -RIM_REACH; dy <= RIM_REACH; dy += 1) {
        for (let dx = -RIM_REACH; dx <= RIM_REACH; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= side || ny >= side) continue;
          const n = ny * side + nx;
          if (alpha[n] !== 255) continue;
          const distance =
            ((crop[n * 4] ?? 0) - (bg[0] ?? 0)) ** 2 +
            ((crop[n * 4 + 1] ?? 0) - (bg[1] ?? 0)) ** 2 +
            ((crop[n * 4 + 2] ?? 0) - (bg[2] ?? 0)) ** 2;
          if (distance > bestDistance) {
            bestDistance = distance;
            best = n;
          }
        }
      }
      source[i] = best;
    }
  }

  const outAlpha = Uint8Array.from(alpha);
  const colour = new Uint8ClampedArray(count * 3);
  for (let i = 0; i < count; i += 1) {
    const o = i * 4;
    const a = alpha[i] ?? 0;
    if (a === 0) continue;
    const from = source[i] ?? -1;
    if (rim[i] && from >= 0) {
      const f = [crop[from * 4] ?? 0, crop[from * 4 + 1] ?? 0, crop[from * 4 + 2] ?? 0];
      const delta = f.map((v, c) => v - (bg[c] ?? 0));
      const span = delta.reduce((sum, v) => sum + v * v, 0);
      if (span >= MIN_CONTRAST * MIN_CONTRAST) {
        const rel = [0, 1, 2].map((c) => (crop[o + c] ?? 0) - (bg[c] ?? 0));
        const cover = Math.min(1, Math.max(0, rel.reduce((sum, v, c) => sum + v * (delta[c] ?? 0), 0) / span));
        const residual = Math.sqrt(rel.reduce((sum, v, c) => sum + (v - cover * (delta[c] ?? 0)) ** 2, 0));
        if (residual <= MAX_RESIDUAL) {
          outAlpha[i] = Math.round(cover * 255);
          colour.set(f, i * 3);
          continue;
        }
      }
    }
    if (a < 255) {
      // Lift the logo off its background: pixel = alpha * logo + (1 - alpha) * background.
      const k = a / 255;
      for (let c = 0; c < 3; c += 1) colour[i * 3 + c] = ((crop[o + c] ?? 0) - (1 - k) * (bg[c] ?? 0)) / k;
    } else {
      colour.set([crop[o] ?? 0, crop[o + 1] ?? 0, crop[o + 2] ?? 0], i * 3);
    }
  }
  return { alpha: outAlpha, colour };
}

/**
 * Cut the logo out of `source` (the icon's original bitmap, any size) using the `analysis` made
 * from a copy of it. Null when the icon has no usable logo box, or when the crop no longer
 * classifies as a logo (the caller then keeps drawing the original with `cover`).
 */
export function makeCutout(source: Pixels, analysis: IconAnalysis): Cutout | null {
  if (analysis.kind === "opaque" || !analysis.bounds) return null;
  const square = cropSquare(analysis, source);
  if (!square) return null;
  const out = Math.min(MAX_CUTOUT_SIDE, Math.max(MIN_CUTOUT_SIDE, Math.round(square.side)));
  const bg = analysis.kind === "keyed" ? analysis.background : null;
  if (analysis.kind === "keyed" && !bg) return null;
  const pad = bg ? ([bg[0], bg[1], bg[2], 255] as const) : ([0, 0, 0, 0] as const);
  const crop = resample(source, square, out, pad);

  // Key the background out again at the crop's own resolution: the alpha is as sharp as the crop.
  const again = analyzePixels({ width: out, height: out, data: crop });
  if (again.kind !== analysis.kind || !again.alpha) return null;
  const data = new Uint8ClampedArray(out * out * 4);
  const back = again.background;
  if (again.kind === "keyed" && back) {
    const matted = matteRim(crop, out, again.alpha, back);
    for (let i = 0; i < out * out; i += 1) {
      data[i * 4] = matted.colour[i * 3] ?? 0;
      data[i * 4 + 1] = matted.colour[i * 3 + 1] ?? 0;
      data[i * 4 + 2] = matted.colour[i * 3 + 2] ?? 0;
      data[i * 4 + 3] = matted.alpha[i] ?? 0;
    }
    return { side: out, data };
  }
  // A transparent logo already has its own alpha and colours.
  for (let i = 0; i < out * out; i += 1) {
    const o = i * 4;
    data[o + 3] = again.alpha[i] ?? 0;
    if (data[o + 3] === 0) continue;
    data[o] = crop[o] ?? 0;
    data[o + 1] = crop[o + 1] ?? 0;
    data[o + 2] = crop[o + 2] ?? 0;
  }
  return { side: out, data };
}

/**
 * How a small icon's image fills its box (`data-icon-fit`): `logo` is the cut-out (square, already
 * cropped, drawn `contain`), `inset` a transparent logo whose cut-out failed (original on a plate
 * with a margin), `cover` everything else. Same words in `AppTile` of `@rulebox/ui`.
 */
export function iconFit(art: { kind: string; cutout?: string } | undefined): "logo" | "inset" | "cover" {
  if (art?.cutout) return "logo";
  return art?.kind === "transparent" ? "inset" : "cover";
}

/** The logo's box inside a cut-out, as fractions of its side (for tests and diagnostics). */
export function cutoutBounds(cutout: Cutout) {
  const alpha = new Uint8Array(cutout.side * cutout.side);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = cutout.data[i * 4 + 3] ?? 0;
  return boundsOf(alpha, cutout.side, cutout.side, BOUNDS_ALPHA);
}
