// Product screenshots as real image files, so search engines can index the
// product (the drawn Staff App screens are HTML/CSS on the pages).
//
//   pnpm --filter @rulebox/website screens   # writes public/screens/* (and dist/screens/* if built)
//
// 1. A temporary build into .screens-dist/ with RB_RENDER_SCREENS=1, which
//    turns on src/pages/render-screens/[variant].astro: one DesktopMock per
//    page, laid out at 1600 px (the mock scales as one picture, so this is a
//    true 1600 px layout, not an upscale). The normal build has no such pages.
// 2. One Chromium page screenshots each mock, as a screen (square corners).
// 3. sharp (Astro's own image library) writes AVIF + WebP at 1600 and 800 px.
// The files are committed, like the OG cards; `pnpm og` runs this first.

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { SCREENS, SCREEN_SIZE } from "../src/data/screens.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const tmpDist = join(root, ".screens-dist");
const outPublic = join(root, "public", "screens");
mkdirSync(outPublic, { recursive: true });

// sharp ships with Astro (its image service); resolve it from there.
const sharp = createRequire(createRequire(import.meta.url).resolve("astro/package.json"))("sharp");

console.log("screens: temporary build with the render pages ...");
const build = spawnSync(`pnpm exec astro build --outDir "${tmpDist}"`, {
  cwd: root,
  shell: true,
  stdio: ["ignore", "ignore", "inherit"],
  env: { ...process.env, RB_RENDER_SCREENS: "1" },
});
if (build.status !== 0) throw new Error("screens: temporary build failed");

// A tiny static server for the temporary build (pages use root-relative URLs).
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webp": "image/webp", ".avif": "image/avif", ".png": "image/png" };
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = join(tmpDist, extname(p) ? p : `${p}.html`);
  if (!file.startsWith(tmpDist) || !existsSync(file) || statSync(file).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: SCREEN_SIZE.width, height: SCREEN_SIZE.height }, deviceScaleFactor: 1, reducedMotion: "reduce" });
let n = 0;
try {
  for (const s of Object.values(SCREENS)) {
    await page.goto(`${origin}/render-screens/${s.key}`, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    // A screen, not a framed window: square corners, no border or shadow.
    await page.addStyleTag({ content: "#screen .mock{border-radius:0!important;border:0!important;box-shadow:none!important}" });
    const mock = page.locator("#screen .mock");
    const box = await mock.boundingBox();
    if (!box || Math.round(box.width) !== SCREEN_SIZE.width || Math.round(box.height) !== SCREEN_SIZE.height) {
      throw new Error(`screens: ${s.key} rendered at ${box?.width}x${box?.height}, expected ${SCREEN_SIZE.width}x${SCREEN_SIZE.height}`);
    }
    const png = await mock.screenshot({ type: "png" });
    for (const [w, suffix] of [
      [SCREEN_SIZE.width, ""],
      [SCREEN_SIZE.width / 2, "-800"],
    ]) {
      const img = sharp(png).resize({ width: w });
      await img.clone().avif({ quality: 62, effort: 6 }).toFile(join(outPublic, `${s.key}${suffix}.avif`));
      await img.clone().webp({ quality: 84, effort: 6 }).toFile(join(outPublic, `${s.key}${suffix}.webp`));
    }
    console.log(`  ${s.key}`);
    n++;
  }
} finally {
  await browser.close();
  server.close();
  rmSync(tmpDist, { recursive: true, force: true });
}

// Keep an existing build in step, like og.mjs does.
if (existsSync(dist)) {
  mkdirSync(join(dist, "screens"), { recursive: true });
  for (const s of Object.values(SCREENS))
    for (const f of [`${s.key}.avif`, `${s.key}.webp`, `${s.key}-800.avif`, `${s.key}-800.webp`]) copyFileSync(join(outPublic, f), join(dist, "screens", f));
}
console.log(`${n} product screens written to public/screens/ (AVIF + WebP, ${SCREEN_SIZE.width} and ${SCREEN_SIZE.width / 2} px)`);
