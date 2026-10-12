// Generates every static logo file from packages/ui/src/brand/geometry.ts.
// Run with `pnpm gen:brand`. Outputs are committed; never edit them by hand.
//
//   assets/brand/                     source set (SVG, PNG, ICO)
//   apps/dashboard/public/            favicon.svg, favicon.ico, apple-touch-icon.png
//   apps/staff-app/src-tauri/icons/   Tauri window/bundle icons

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import {
  LOGO_BOX,
  LOGO_BRAND,
  LOGO_CELLS,
  LOGO_OFF_OPACITY,
  LOGO_TILE_BG,
  LOGO_VIEWBOX,
} from "../packages/ui/src/brand/geometry.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// sRGB equivalents of the tokens in packages/ui/src/tokens.css.
const INK = "#231e19"; // --rb-ink (light theme)
const INK_ON_DARK = "#f8f4f1"; // --rb-ink (dark theme)
const TILE = "#141413"; // app icon background
const ON_TILE = "#ffffff";

const n = (v) => String(Math.round(v * 100) / 100);

function cells({ on, off, hideOff }) {
  return LOGO_CELLS.filter((c) => c.on || !hideOff)
    .map((c) => {
      const fill = c.leg ? LOGO_BRAND : c.on ? on : off;
      const opacity = c.on ? "" : ` opacity="${LOGO_OFF_OPACITY}"`;
      return `<rect x="${n(c.x)}" y="${n(c.y)}" width="${n(c.size)}" height="${n(c.size)}" rx="${n(c.rx)}" fill="${fill}"${opacity}/>`;
    })
    .join("");
}

function svg(body, extra = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LOGO_VIEWBOX} ${LOGO_VIEWBOX}" role="img" aria-label="Rulebox">${extra}${body}</svg>\n`;
}

/** Outlined mark in one ink color. */
function mark(ink, { hideOff = false } = {}) {
  const b = LOGO_BOX;
  const box = `<rect x="${b.x}" y="${b.y}" width="${b.size}" height="${b.size}" rx="${b.rx}" fill="none" stroke="${ink}" stroke-width="${b.stroke}"/>`;
  return svg(box + cells({ on: ink, off: ink, hideOff }));
}

/** Outlined mark that follows the viewer's light/dark theme. */
function markAuto({ hideOff = false } = {}) {
  const style = `<style>.i{fill:${INK}}.s{stroke:${INK}}@media (prefers-color-scheme:dark){.i{fill:${INK_ON_DARK}}.s{stroke:${INK_ON_DARK}}}</style>`;
  return mark("INK", { hideOff })
    .replace("<rect", `${style}<rect`)
    .replaceAll('fill="INK"', 'class="i"')
    .replaceAll('stroke="INK"', 'class="s"');
}

/** Filled dark tile (app icon, favicon). `square` drops the rounded corners. */
function icon({ hideOff = false, square = false } = {}) {
  const t = LOGO_TILE_BG;
  const bg = `<rect width="${t.size}" height="${t.size}" rx="${square ? 0 : t.rx}" fill="${TILE}"/>`;
  return svg(bg + cells({ on: ON_TILE, off: ON_TILE, hideOff }));
}

function png(source, size) {
  return new Resvg(source, { fitTo: { mode: "width", value: size } }).render().asPng();
}

/** ICO container holding PNG-compressed images. */
function ico(images) {
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

function write(path, data) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  console.log(path);
}

// Below ~48 px the blocked dots turn to noise, so small sizes drop them.
const iconPng = (size) => png(icon({ hideOff: size < 48 }), size);
const iconIco = () => ico([16, 24, 32, 48, 64, 256].map((size) => ({ size, data: iconPng(size) })));

const brand = "assets/brand";
write(`${brand}/rulebox-mark.svg`, markAuto());
write(`${brand}/rulebox-mark-light.svg`, mark(INK));
write(`${brand}/rulebox-mark-dark.svg`, mark(INK_ON_DARK));
write(`${brand}/rulebox-mark-compact.svg`, markAuto({ hideOff: true }));
write(`${brand}/rulebox-icon.svg`, icon());
write(`${brand}/rulebox-icon-compact.svg`, icon({ hideOff: true }));
write(`${brand}/rulebox.ico`, iconIco());
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
  write(`${brand}/png/rulebox-icon-${size}.png`, iconPng(size));
}
write(`${brand}/png/rulebox-mark-light-512.png`, png(mark(INK), 512));
write(`${brand}/png/rulebox-mark-dark-512.png`, png(mark(INK_ON_DARK), 512));

const dashboard = "apps/dashboard/public";
write(`${dashboard}/favicon.svg`, icon({ hideOff: true }));
write(`${dashboard}/favicon.ico`, ico([16, 32, 48].map((size) => ({ size, data: iconPng(size) }))));
write(`${dashboard}/apple-touch-icon.png`, png(icon({ square: true }), 180));

const tauri = "apps/staff-app/src-tauri/icons";
write(`${tauri}/32x32.png`, iconPng(32));
write(`${tauri}/128x128.png`, iconPng(128));
write(`${tauri}/128x128@2x.png`, iconPng(256));
write(`${tauri}/icon.png`, iconPng(512));
write(`${tauri}/icon.ico`, iconIco());
