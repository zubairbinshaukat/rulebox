/**
 * Pure pixel analysis of an app icon (no DOM): is it a logo on transparency, or a
 * picture with its own opaque background, and what is the logo's silhouette?
 *
 * Why: a catalogue icon is any PNG (a web app's apple-touch-icon, later one the
 * dashboard uploads). Many are a logo on a flat opaque square. Drawn as the
 * tile's large faded watermark, that square shows as a visible block. So the
 * shell looks at each icon once (`iconArt.ts`) and derives:
 *
 *  - `transparent`: the border is clear. The alpha channel is the silhouette.
 *  - `keyed`: the border is one flat colour (or clear corners round a flat
 *    plate). That colour, flood-filled from the edge, is keyed out of the
 *    silhouette, so the watermark is the logo alone.
 *  - `opaque`: no flat border (a photo, a gradient). No silhouette; the tile
 *    falls back to the app's Solar glyph for its watermark.
 *
 * Small icons do not draw the silhouette as a mask either: a keyed or transparent
 * icon is cropped to the logo's bounding box (`bounds`) and enlarged to fill its
 * rounded box (`iconCutout.ts`), on a plate of the icon's own background colour
 * (keyed) or in the app's colour, light or dark depending on the logo (`tone`)
 * (transparent). An opaque icon (a photo) keeps `cover`.
 */

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, row by row, like `ImageData.data`. */
  data: ArrayLike<number>;
}

export type IconKind = "transparent" | "keyed" | "opaque";

/** A box as fractions of the image (0 to 1, `right` and `bottom` exclusive). */
export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface IconAnalysis {
  kind: IconKind;
  /** The silhouette's alpha plane (`width * height`); null for `opaque`. */
  alpha: Uint8Array | null;
  /** The flat border colour as `rgb(r g b)`; null when the border is clear or not flat. */
  edge: string | null;
  /** The same colour as numbers (for `keyed`), used to lift the logo off its background. */
  background: [number, number, number] | null;
  /** The logo's bounding box (alpha above `BOUNDS_ALPHA`), as fractions of the image; null for `opaque`. */
  bounds: Bounds | null;
  /** Mean relative luminance (0 to 1) of the logo's own pixels. */
  luma: number;
  /** `light` when the logo is mostly light (it needs a dark plate), else `dark`. */
  tone: "light" | "dark";
}

/** Silhouette pixels below this alpha (a faint shadow, noise) do not count towards the logo's box. */
export const BOUNDS_ALPHA = 48;

/** A border pixel at or below this alpha counts as clear. */
const CLEAR_ALPHA = 24;
/** At least this share of the border must be clear for a `transparent` icon. */
const CLEAR_BORDER_SHARE = 0.8;
/** A `transparent` icon whose opaque pixels cover more than this is really a plate. */
const MAX_COVERAGE = 0.82;
/** A silhouette covering less than this has lost its logo (the logo is the background). */
const MIN_COVERAGE = 0.02;
/** A border colour is flat when this share of the opaque border is within `FLAT_DISTANCE` of the median. */
const FLAT_SHARE = 0.9;
const FLAT_DISTANCE = 24;
/** Flood-fill reach and the start of the soft edge (RGB distance from the background). */
const REACH = 40;
const SOFT = 10;
/** Pixels this close to the background are cleared even if the edge does not reach them (a letter's hole). */
const HOLE_REACH = 14;
const HOLE_SOFT = 5;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Mean relative luminance of the logo's own pixels, weighted by `alpha`. */
function logoLuma(px: Pixels, alpha: ArrayLike<number>): number {
  let sum = 0;
  let weight = 0;
  for (let i = 0; i < px.width * px.height; i += 1) {
    const a = alpha[i] ?? 0;
    if (a < 32) continue;
    const o = i * 4;
    const y =
      0.2126 * channel(px.data[o] ?? 0) + 0.7152 * channel(px.data[o + 1] ?? 0) + 0.0722 * channel(px.data[o + 2] ?? 0);
    sum += y * a;
    weight += a;
  }
  return weight > 0 ? sum / weight : 0;
}

/** A mean relative luminance of 0.4 is about the middle of the lightness scale. */
function toneOf(luma: number): "light" | "dark" {
  return luma > 0.4 ? "light" : "dark";
}

function coverageOf(alpha: ArrayLike<number>, count: number): number {
  let sum = 0;
  for (let i = 0; i < count; i += 1) sum += alpha[i] ?? 0;
  return count > 0 ? sum / (255 * count) : 0;
}

/** Indexes of the outermost ring of pixels. */
function ring(width: number, height: number): number[] {
  const out: number[] = [];
  for (let x = 0; x < width; x += 1) out.push(x, (height - 1) * width + x);
  for (let y = 1; y < height - 1; y += 1) out.push(y * width, y * width + width - 1);
  return out;
}

/** The box of the pixels whose alpha reaches `min`, as fractions of the image; null if none. */
export function boundsOf(alpha: ArrayLike<number>, width: number, height: number, min = BOUNDS_ALPHA): Bounds | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((alpha[y * width + x] ?? 0) < min) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { left: x0 / width, top: y0 / height, right: (x1 + 1) / width, bottom: (y1 + 1) / height };
}

const OPAQUE: IconAnalysis = { kind: "opaque", alpha: null, edge: null, background: null, bounds: null, luma: 0, tone: "dark" };

/** Classify an icon and derive its silhouette. Pure and deterministic. */
export function analyzePixels(px: Pixels): IconAnalysis {
  const { width, height, data } = px;
  const count = width * height;
  if (width < 2 || height < 2 || data.length < count * 4) return OPAQUE;
  const alphaOf = (i: number) => data[i * 4 + 3] ?? 0;
  const border = ring(width, height);

  // 1. A clear border: the alpha channel is the silhouette.
  const clear = border.filter((i) => alphaOf(i) <= CLEAR_ALPHA).length;
  if (clear / border.length >= CLEAR_BORDER_SHARE) {
    const alpha = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) alpha[i] = alphaOf(i);
    const coverage = coverageOf(alpha, count);
    if (coverage >= MIN_COVERAGE && coverage <= MAX_COVERAGE) {
      const luma = logoLuma(px, alpha);
      return {
        kind: "transparent",
        alpha,
        edge: null,
        background: null,
        bounds: boundsOf(alpha, width, height),
        luma,
        tone: toneOf(luma),
      };
    }
    if (coverage < MIN_COVERAGE) return OPAQUE; // nothing visible: nothing to draw
    // Opaque nearly everywhere with clear corners (a rounded plate): treat as a plate below.
  }

  // 2. A flat border colour: key it out from the edge.
  const solid = border.filter((i) => alphaOf(i) >= 200);
  if (solid.length < border.length * 0.3) return OPAQUE;
  const bg = [0, 1, 2].map((c) => median(solid.map((i) => data[i * 4 + c] ?? 0)));
  const dist = (i: number) => {
    const dr = (data[i * 4] ?? 0) - (bg[0] ?? 0);
    const dg = (data[i * 4 + 1] ?? 0) - (bg[1] ?? 0);
    const db = (data[i * 4 + 2] ?? 0) - (bg[2] ?? 0);
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };
  const flat = solid.filter((i) => dist(i) <= FLAT_DISTANCE).length / solid.length >= FLAT_SHARE;
  const edge = `rgb(${bg.join(" ")})`;
  if (!flat) return { ...OPAQUE, edge: null };

  const alpha = new Uint8Array(count).fill(255);
  const seen = new Uint8Array(count);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;
  const passable = (i: number) => alphaOf(i) < 128 || dist(i) <= REACH;
  for (const i of border) {
    if (!seen[i] && passable(i)) {
      seen[i] = 1;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++] as number;
    const clearHere = alphaOf(i) < 128;
    const d = clearHere ? 0 : dist(i);
    alpha[i] = clearHere ? 0 : Math.round(255 * Math.min(1, Math.max(0, (d - SOFT) / (REACH - SOFT))));
    const x = i % width;
    const y = (i - x) / width;
    const next = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1];
    for (const n of next) {
      if (n >= 0 && !seen[n] && passable(n)) {
        seen[n] = 1;
        queue[tail++] = n;
      }
    }
  }
  // Holes the edge cannot reach (the inside of an "O"): clear what is very close to the background.
  for (let i = 0; i < count; i += 1) {
    if (seen[i]) continue;
    const d = dist(i);
    if (d <= HOLE_REACH) {
      alpha[i] = Math.min(alpha[i] ?? 255, Math.round(255 * Math.min(1, Math.max(0, (d - HOLE_SOFT) / (HOLE_REACH - HOLE_SOFT)))));
    }
  }

  const coverage = coverageOf(alpha, count);
  if (coverage < MIN_COVERAGE || coverage > MAX_COVERAGE) return { ...OPAQUE, edge };
  const bounds = boundsOf(alpha, width, height);
  if (!bounds) return { ...OPAQUE, edge };
  const luma = logoLuma(px, alpha);
  return {
    kind: "keyed",
    alpha,
    edge,
    background: [bg[0] ?? 0, bg[1] ?? 0, bg[2] ?? 0],
    bounds,
    luma,
    tone: toneOf(luma),
  };
}
