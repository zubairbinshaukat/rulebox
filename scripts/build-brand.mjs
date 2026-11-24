// Generates every logo file from the master render and the flat mark.
// Run with `pnpm gen:brand`. Outputs are committed; never edit them by hand.
//
// Sources (never edited by this script):
//   assets/brand/source/logo-cube-master.png   3D render, transparent, the logo itself
//   packages/ui/src/brand/geometry.ts          flat mark traced from it, for <= 32 px
//
// Outputs:
//   assets/brand/                              SVG, PNG, ICO, installer bitmaps
//   packages/ui/src/brand/cube/                WebP images + mark.svg <LogoMark> and <LogoMotion> load
//   packages/ui/src/brand/cube-still.ts        srcset + flat mark URL for <LogoMark>   (generated)
//   packages/ui/src/brand/cube-motion.ts       layers, keyhole box, door path for <LogoMotion> (generated)
//   (so packages/ui needs no geometry code at runtime)
//   apps/dashboard/public/, apps/website/public/   favicon.svg, favicon.ico, apple-touch-icon.png
//   apps/staff-app/src-tauri/icons/            Tauri window/bundle icons
//
// Small sizes: the render turns to mush below ~40 px, so 16-32 px icons use the
// flat mark; 48 px and up use the render.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { LOGO_KEYHOLE_CIRCLE, LOGO_PATHS, flatMarkSvg } from "../packages/ui/src/brand/geometry.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MASTER = join(root, "assets/brand/source/logo-cube-master.png");

/** Paper background for the opaque icons (apple-touch); --rb-paper in sRGB. */
const PAPER = "#f8f5f0";

function write(path, data) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  console.log(`${path}  (${(data.length / 1024).toFixed(1)} KB)`);
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---------- 1. Read the master and normalise it (in memory only) ----------

const master = await sharp(MASTER).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const W = master.info.width;
const H = master.info.height;
const px = Buffer.from(master.data);

// The render's body has alpha 253-254 (not quite opaque); make it opaque so
// icons do not show the background through. The 1-2 px anti-aliased edge stays.
let bx0 = W;
let by0 = H;
let bx1 = 0;
let by1 = 0;
for (let p = 0, i = 0; p < W * H; p++, i += 4) {
  if (px[i + 3] >= 248) px[i + 3] = 255;
  if (px[i + 3] > 8) {
    const x = p % W;
    const y = (p / W) | 0;
    bx0 = Math.min(bx0, x);
    bx1 = Math.max(bx1, x);
    by0 = Math.min(by0, y);
    by1 = Math.max(by1, y);
  }
}

// Square crop round the cube, 1.25% margin each side. geometry.ts traces the flat
// mark in this same box (0..100), so the two line up.
const side = Math.round(Math.max(bx1 - bx0 + 1, by1 - by0 + 1) * 1.025);
const CROP = {
  left: Math.round((bx0 + bx1) / 2 - side / 2),
  top: Math.round((by0 + by1) / 2 - side / 2),
  width: side,
  height: side,
};
const rgba = (buf, width, height) => sharp(buf, { raw: { width, height, channels: 4 } });
const cube = await rgba(px, W, H).extract(CROP).raw().toBuffer();
const S = side;
console.log(`master ${W}x${H}, cube crop ${S}px at ${CROP.left},${CROP.top}`);

// ---------- 2. Split the keyhole light from the body ----------

// The keyhole is the only warm part of the render: weight = how much red beats blue.
// Limited to the biggest warm area (a stray warm pixel on an edge would widen the box).
const warm = new Float32Array(S * S);
for (let p = 0, i = 0; p < S * S; p++, i += 4) {
  warm[p] = cube[i + 3] > 0 ? smooth(15, 70, cube[i] - cube[i + 2]) : 0;
}
let kx0 = S;
let ky0 = S;
let kx1 = 0;
let ky1 = 0;
{
  // Column/row histograms of strong warmth; the keyhole is one solid blob.
  const cols = new Float32Array(S);
  const rows = new Float32Array(S);
  for (let p = 0; p < S * S; p++) {
    if (warm[p] > 0.5) {
      cols[p % S]++;
      rows[(p / S) | 0]++;
    }
  }
  const minRun = S * 0.01;
  for (let x = 0; x < S; x++) if (cols[x] > minRun) ((kx0 = Math.min(kx0, x)), (kx1 = Math.max(kx1, x)));
  for (let y = 0; y < S; y++) if (rows[y] > minRun) ((ky0 = Math.min(ky0, y)), (ky1 = Math.max(ky1, y)));
}
if (kx1 <= kx0 || ky1 <= ky0) throw new Error("No keyhole found in the master render");
// Box for the light layer: the keyhole plus room for its soft edge.
const pad = Math.round(S * 0.012);
const KEY = {
  left: Math.max(0, kx0 - pad),
  top: Math.max(0, ky0 - pad),
  width: Math.min(S, kx1 + pad + 1) - Math.max(0, kx0 - pad),
  height: Math.min(S, ky1 + pad + 1) - Math.max(0, ky0 - pad),
};
const inKey = (x, y) => x >= KEY.left && y >= KEY.top && x < KEY.left + KEY.width && y < KEY.top + KEY.height;

// Body: the cube with the keyhole dark (light off). Light: only the warm pixels.
// Light over body at full opacity gives back the render.
const body = Buffer.from(cube);
const light = Buffer.alloc(KEY.width * KEY.height * 4);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const p = y * S + x;
    const i = p * 4;
    const w = inKey(x, y) ? warm[p] : 0;
    if (w <= 0) continue;
    const r = cube[i];
    const g = cube[i + 1];
    const b = cube[i + 2];
    // Unlit: a deep teal hole that keeps a little of the inner shading.
    const shade = 0.55 + (0.3 * r + 0.59 * g + 0.11 * b) / 255;
    body[i] = Math.round(r + (3 * shade - r) * w);
    body[i + 1] = Math.round(g + (30 * shade - g) * w);
    body[i + 2] = Math.round(b + (34 * shade - b) * w);
    const j = ((y - KEY.top) * KEY.width + (x - KEY.left)) * 4;
    light[j] = r;
    light[j + 1] = g;
    light[j + 2] = b;
    light[j + 3] = Math.round(cube[i + 3] * w);
  }
}

// Sheen mask: the cube's highlights (top face, bevels), as alpha. The light sweep
// in <LogoMotion> is masked with it so it only catches the edges that face up.
const sheen = Buffer.alloc(S * S * 4);
for (let p = 0, i = 0; p < S * S; p++, i += 4) {
  const l = 0.3 * cube[i] + 0.59 * cube[i + 1] + 0.11 * cube[i + 2];
  const a = Math.round(cube[i + 3] * (1 - warm[p]) * (0.25 * smooth(70, 110, l) + 0.75 * smooth(110, 190, l)));
  sheen[i] = 255;
  sheen[i + 1] = 255;
  sheen[i + 2] = 255;
  sheen[i + 3] = a;
}

// ---------- 3. Encoders ----------

const cubeImg = () => rgba(cube, S, S);

/** The render at `size` px. Small sizes get a gentle sharpen and a touch more saturation. */
async function renderPng(size) {
  let img = cubeImg().resize(size, size, { kernel: "lanczos3" });
  if (size <= 64) {
    img = rgba(await img.raw().toBuffer(), size, size)
      .modulate({ saturation: 1.1 })
      .sharpen({ sigma: 0.45, m1: 0.5, m2: 1.5 });
  }
  // Big sizes: 256-colour palette with dithering; the render's grain hides it and
  // the files shrink about 3x.
  return img.png(size >= 128 ? { palette: true, quality: 92, effort: 10, dither: 0.9 } : { compressionLevel: 9 }).toBuffer();
}

const flatSvg = flatMarkSvg({ title: "Rulebox" });
const flatPng = (size) => new Resvg(flatSvg, { fitTo: { mode: "width", value: size } }).render().asPng();
/** One icon size: the flat mark up to 32 px, the render from 48 px. */
const iconPng = (size) => (size <= 32 ? flatPng(size) : renderPng(size));

/** The render centred on an opaque paper square (iOS fills transparency with black). */
async function tilePng(size, scale = 0.8) {
  const inner = Math.round(size * scale);
  const off = Math.round((size - inner) / 2);
  return sharp({ create: { width: size, height: size, channels: 4, background: PAPER } })
    .composite([{ input: await renderPng(inner), left: off, top: off }])
    .flatten({ background: PAPER })
    .png({ palette: true, quality: 92, effort: 10, dither: 0.9 })
    .toBuffer();
}

/** ICO container holding PNG-compressed images. */
async function ico(sizes) {
  const images = await Promise.all(sizes.map(async (size) => ({ size, data: await iconPng(size) })));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

/** 24-bit bottom-up BMP (WiX dialog bitmaps accept only BMP). */
async function bmp(img) {
  const { data, info } = await img.flatten({ background: "#ffffff" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const stride = Math.ceil((info.width * 3) / 4) * 4;
  const out = Buffer.alloc(54 + stride * info.height);
  out.write("BM", 0, "ascii");
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(info.width, 18);
  out.writeInt32LE(info.height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(stride * info.height, 34);
  for (let y = 0; y < info.height; y++) {
    const row = 54 + (info.height - 1 - y) * stride;
    for (let x = 0; x < info.width; x++) {
      const s = (y * info.width + x) * 3;
      out[row + x * 3] = data[s + 2];
      out[row + x * 3 + 1] = data[s + 1];
      out[row + x * 3 + 2] = data[s];
    }
  }
  return out;
}

const webp = (img, quality = 86) => img.webp({ quality, alphaQuality: 100, effort: 6, smartSubsample: true }).toBuffer();

// ---------- 4. assets/brand ----------

const brand = "assets/brand";
rmSync(join(root, brand, "png"), { recursive: true, force: true });
write(`${brand}/rulebox-mark.svg`, `${flatMarkSvg({ title: "Rulebox" })}\n`);
write(`${brand}/rulebox.ico`, await ico([16, 24, 32, 48, 64, 256]));
for (const size of [16, 24, 32]) write(`${brand}/png/rulebox-mark-${size}.png`, flatPng(size));
for (const size of [48, 64, 128, 256, 512]) write(`${brand}/png/rulebox-cube-${size}.png`, await renderPng(size));
write(`${brand}/png/rulebox-tile-512.png`, await tilePng(512));

// WiX UI bitmaps: banner 493x58 (logo on the right, text area left white) and the
// welcome/finish dialog 493x312 (logo panel on the left 164 px, text area white).
{
  const banner = sharp({ create: { width: 493, height: 58, channels: 4, background: "#ffffff" } }).composite([
    { input: await renderPng(46), left: 493 - 46 - 10, top: 6 },
  ]);
  write(`${brand}/installer/banner.bmp`, await bmp(sharp(await banner.png().toBuffer())));
  const panel = sharp({ create: { width: 493, height: 312, channels: 4, background: "#ffffff" } }).composite([
    { input: await sharp({ create: { width: 164, height: 312, channels: 4, background: PAPER } }).png().toBuffer(), left: 0, top: 0 },
    { input: await renderPng(116), left: 24, top: 98 },
  ]);
  write(`${brand}/installer/dialog.bmp`, await bmp(sharp(await panel.png().toBuffer())));
}

// ---------- 5. packages/ui: images + generated modules ----------

const ui = "packages/ui/src/brand";
rmSync(join(root, ui, "cube"), { recursive: true, force: true });
const STILL = [128, 256, 512];
const MOTION = [128, 256, 512];
for (const size of STILL) {
  write(`${ui}/cube/cube-${size}.webp`, await webp(cubeImg().resize(size, size, { kernel: "lanczos3" })));
}
for (const size of MOTION) {
  const k = size / S;
  write(`${ui}/cube/body-${size}.webp`, await webp(rgba(body, S, S).resize(size, size, { kernel: "lanczos3" })));
  const lw = Math.max(1, Math.round(KEY.width * k));
  const lh = Math.max(1, Math.round(KEY.height * k));
  write(`${ui}/cube/light-${size}.webp`, await webp(rgba(light, KEY.width, KEY.height).resize(lw, lh, { kernel: "lanczos3", fit: "fill" }), 90));
}
write(`${ui}/cube/sheen-256.webp`, await webp(rgba(sheen, S, S).resize(256, 256, { kernel: "lanczos3" }), 70));
// The flat mark as a file, so <LogoMark> needs no geometry code at runtime.
write(`${ui}/cube/mark.svg`, `${flatMarkSvg()}\n`);

const pct = (v) => Math.round((v / S) * 10000) / 100;
const header = `// Generated by scripts/build-brand.mjs (pnpm gen:brand) from
// assets/brand/source/logo-cube-master.png. Do not edit.
// \`?no-inline\`: always separate files, never base64 in the JS bundle.
`;
const srcset = (prefix, sizes) => sizes.map((s) => `\${${prefix}${s}} ${s}w`).join(", ");

write(
  `${ui}/cube-still.ts`,
  `${header}
${STILL.map((s) => `import cube${s} from "./cube/cube-${s}.webp?no-inline";`).join("\n")}
import flat from "./cube/mark.svg?no-inline";

/** The render, square, transparent: \`srcSet\` with width descriptors and a fallback \`src\`. */
export const CUBE_STILL = {
  src: cube256,
  srcSet: \`${srcset("cube", STILL)}\`,
  /** The flat mark (geometry.ts) as an SVG file, for small sizes. */
  flat,
};
`,
);

// Keyhole centre: middle of the warm box horizontally, the centre of the round
// top (a third of the way down) vertically, which is where the glow looks hottest.
write(
  `${ui}/cube-motion.ts`,
  `${header}
${MOTION.map((s) => `import body${s} from "./cube/body-${s}.webp?no-inline";\nimport light${s} from "./cube/light-${s}.webp?no-inline";`).join("\n")}
import sheen from "./cube/sheen-256.webp?no-inline";

/** Layers of the render for <LogoMotion>; light over body at full opacity is the render. */
export const CUBE_MOTION = {
  /** The cube with the keyhole dark. */
  body: { src: body256, srcSet: \`${srcset("body", MOTION)}\` },
  /** The keyhole light alone, cropped to \`keyhole\`. */
  light: { src: light256, srcSet: \`${srcset("light", MOTION)}\` },
  /** Alpha mask of the cube's highlights, for the light sweep. */
  sheen,
  /** Box of the light layer, in % of the mark. */
  keyhole: { left: ${pct(KEY.left)}, top: ${pct(KEY.top)}, width: ${pct(KEY.width)}, height: ${pct(KEY.height)} },
  /** Where the glow is centred, in % of the mark. */
  glow: { x: ${pct((kx0 + kx1) / 2)}, y: ${pct(ky0 + (ky1 - ky0) * 0.3)} },
  /** The keyhole at its true size (geometry.ts, viewBox 0 0 100 100): the open/lock light door. */
  door: "${LOGO_PATHS.keyholeTrue}",
  /** The keyhole's round top (same units): open and lock zoom into its centre. */
  circle: { cx: ${LOGO_KEYHOLE_CIRCLE.cx}, cy: ${LOGO_KEYHOLE_CIRCLE.cy}, r: ${LOGO_KEYHOLE_CIRCLE.r} },
};
`,
);

// ---------- 6. Favicons and app icons ----------

const favicon = `${flatMarkSvg({ title: "Rulebox" })}\n`;
for (const app of ["apps/dashboard/public", "apps/website/public"]) {
  write(`${app}/favicon.svg`, favicon);
  write(`${app}/favicon.ico`, await ico([16, 32, 48]));
  write(`${app}/apple-touch-icon.png`, await tilePng(180));
}
write("apps/website/public/icon-512.png", await renderPng(512));

const tauri = "apps/staff-app/src-tauri/icons";
write(`${tauri}/32x32.png`, await iconPng(32));
write(`${tauri}/128x128.png`, await iconPng(128));
write(`${tauri}/128x128@2x.png`, await iconPng(256));
write(`${tauri}/icon.png`, await iconPng(512));
write(`${tauri}/icon.ico`, await ico([16, 24, 32, 48, 64, 256]));
