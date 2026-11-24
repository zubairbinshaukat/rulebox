/*
 * Rulebox logo: a soft deep-teal cube with a glowing amber keyhole.
 *
 * The master is a 3D render (assets/brand/source/logo-cube-master.png, never
 * edited). `pnpm gen:brand` (scripts/build-brand.mjs) derives every raster
 * file from it. This file is the hand-traced **flat mark**: the same cube as
 * three flat faces plus the keyhole, for sizes where the render turns to mush
 * (favicons, 16-32 px icons, anything under ~40 px in the UI).
 *
 * Coordinates are in a 100x100 box that matches the square crop of the render
 * the build script makes (1 unit = 1% of the crop), so the flat mark and the
 * render line up. Keep this file free of imports so Node can load it directly.
 */

export const LOGO_VIEWBOX = 100;

/** Cube teal (the render's front face, lit), close to the site primary #005c62. */
export const LOGO_TEAL = "#0b6970";
/** Keyhole amber (the light inside the keyhole). Mirrors --rb-brand in tokens.css. */
export const LOGO_AMBER = "#f2a12a";

/** Flat face colours, sampled from the render and nudged for contrast at 16 px. */
export const LOGO_FACES = {
  top: "#14929b",
  front: "#0b6970",
  side: "#05474d",
  edge: "#7fd8da",
  keyhole: LOGO_AMBER,
  /** Keyhole gradient: the light is brightest at the bottom of the slot, as in the render. */
  keyholeTop: "#e88f1c",
  keyholeBottom: "#ffc75a",
} as const;

type Pt = readonly [number, number];

// Corners of the cube as it sits in the render (3/4 view).
const BACK: Pt = [44, 2.5]; // top face, far corner
const LEFT: Pt = [2.5, 21.5]; // top-left of the front face
const RIGHT: Pt = [96, 13.5]; // top-right of the side face
const FRONT: Pt = [63.5, 29.5]; // the corner nearest the viewer (top)
const FRONT_LOW: Pt = [63, 96.5]; // the corner nearest the viewer (bottom)
const LEFT_LOW: Pt = [3, 83]; // bottom-left of the front face
const RIGHT_LOW: Pt = [97, 75]; // bottom-right of the side face

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Closed path through `pts` with each corner rounded by `radius` (quadratic). */
function rounded(pts: readonly Pt[], radius: number): string {
  const n = pts.length;
  let d = "";
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const prev = pts[(i + n - 1) % n]!;
    const next = pts[(i + 1) % n]!;
    const toPrev = Math.hypot(prev[0] - p[0], prev[1] - p[1]);
    const toNext = Math.hypot(next[0] - p[0], next[1] - p[1]);
    const a = Math.min(radius, toPrev / 2) / toPrev;
    const b = Math.min(radius, toNext / 2) / toNext;
    const inX = p[0] + (prev[0] - p[0]) * a;
    const inY = p[1] + (prev[1] - p[1]) * a;
    const outX = p[0] + (next[0] - p[0]) * b;
    const outY = p[1] + (next[1] - p[1]) * b;
    d += `${i === 0 ? "M" : "L"}${r2(inX)} ${r2(inY)}Q${p[0]} ${p[1]} ${r2(outX)} ${r2(outY)}`;
  }
  return `${d}Z`;
}

const poly = (pts: readonly Pt[]) => `M${pts.map((p) => `${p[0]} ${p[1]}`).join("L")}Z`;

/** Keyhole: a circle over a flared slot, as cut into the front face. */
// Drawn 12% larger than in the render (around its centre) so it still reads at 16 px.
const KEY = { cx: 35.2, cy: 48.6, r: 7.6, slotTop: 53, slotBottom: 74.6, topHalf: 3.6, bottomHalf: 7.2 };
const KEY_SCALE = 1.12;

function keyhole(scale: number): string {
  const { cx, r, slotTop, slotBottom, topHalf, bottomHalf } = KEY;
  // Scale around the middle of the whole keyhole, not the circle.
  const mid = (KEY.cy - r + slotBottom) / 2;
  const cy = mid + (KEY.cy - mid) * scale;
  const R = r * scale;
  const t = topHalf * scale;
  const b = bottomHalf * scale;
  const yTop = mid + (slotTop - mid) * scale;
  const yBottom = mid + (slotBottom - mid) * scale;
  // Where the slot's sides leave the circle.
  const join = cy + Math.sqrt(Math.max(0, R * R - t * t));
  return (
    `M${r2(cx - t)} ${r2(join)}` +
    `A${r2(R)} ${r2(R)} 0 1 1 ${r2(cx + t)} ${r2(join)}` +
    `L${r2(cx + b)} ${r2(yBottom - 1.2 * scale)}` +
    `Q${r2(cx + b + 0.2 * scale)} ${r2(yBottom)} ${r2(cx + b - 1.4 * scale)} ${r2(yBottom)}` +
    `L${r2(cx - b + 1.4 * scale)} ${r2(yBottom)}` +
    `Q${r2(cx - b - 0.2 * scale)} ${r2(yBottom)} ${r2(cx - b)} ${r2(yBottom - 1.2 * scale)}` +
    `L${r2(cx - t)} ${r2(Math.max(join, yTop))}Z`
  );
}

/** Path data for each part of the flat mark (viewBox 0 0 100 100). */
export const LOGO_PATHS = {
  silhouette: rounded([BACK, RIGHT, RIGHT_LOW, FRONT_LOW, LEFT_LOW, LEFT], 12),
  top: poly([LEFT, BACK, RIGHT, FRONT]),
  front: poly([LEFT, FRONT, FRONT_LOW, LEFT_LOW]),
  side: poly([FRONT, RIGHT, RIGHT_LOW, FRONT_LOW]),
  /** The bright bevel between the top and front faces. */
  edge: `M${LEFT[0] + 4} ${LEFT[1] + 0.6}L${FRONT[0] - 3} ${FRONT[1] - 0.3}`,
  keyhole: keyhole(KEY_SCALE),
  /** The keyhole at its true size in the render (the <LogoMotion> light door). */
  keyholeTrue: keyhole(1),
};

/** The keyhole's round top at its true size: the point <LogoMotion> zooms into. */
export const LOGO_KEYHOLE_CIRCLE = { cx: KEY.cx, cy: KEY.cy, r: KEY.r };

/**
 * The flat mark as a standalone SVG string (favicons, generated files, Astro).
 * `<LogoMark>` renders the same paths as JSX. `id` prefixes the clip and
 * gradient ids; give each copy inlined into one page its own.
 */
export function flatMarkSvg({ size, title, id = "rb-mark" }: { size?: number; title?: string; id?: string } = {}): string {
  const dims = size ? ` width="${size}" height="${size}"` : "";
  const label = title ? ` role="img" aria-label="${title}"` : ` aria-hidden="true"`;
  const f = LOGO_FACES;
  const p = LOGO_PATHS;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LOGO_VIEWBOX} ${LOGO_VIEWBOX}"${dims}${label}>` +
    `<defs><clipPath id="${id}-c"><path d="${p.silhouette}"/></clipPath>` +
    `<linearGradient id="${id}-k" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${f.keyholeTop}"/><stop offset="1" stop-color="${f.keyholeBottom}"/></linearGradient></defs>` +
    `<g clip-path="url(#${id}-c)">` +
    `<path d="${p.side}" fill="${f.side}"/>` +
    `<path d="${p.front}" fill="${f.front}"/>` +
    `<path d="${p.top}" fill="${f.top}"/>` +
    `<path d="${p.edge}" stroke="${f.edge}" stroke-width="2.6" stroke-linecap="round" fill="none"/>` +
    `</g>` +
    `<path d="${p.keyhole}" fill="url(#${id}-k)"/>` +
    `</svg>`
  );
}
