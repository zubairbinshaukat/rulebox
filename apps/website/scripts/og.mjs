// Social cards (1200x630), one per page, from the built HTML.
//
//   pnpm --filter @rulebox/website build
//   pnpm --filter @rulebox/website og      # writes public/og/*.png and dist/og/*.png
//   pnpm --filter @rulebox/website og blog- # only the cards whose key starts with blog-
//
// Pages that show a product screen (an <img> from /screens/, rendered by
// scripts/screens.mjs, which `pnpm og` runs first) get that screen on the card.
//
// Renders an HTML template with the bundled Figtree font in the Playwright
// Chromium that apps/dashboard already installed (no download, no font CDN).
// The PNGs are committed like the brand files, so normal builds need no
// browser. scripts/check-dist.mjs fails the build if a page's card is missing.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const outPublic = join(root, "public", "og");
const outDist = join(dist, "og");
mkdirSync(outPublic, { recursive: true });
mkdirSync(outDist, { recursive: true });

const font = pathToFileURL(join(root, "node_modules/@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2")).href;
const mono = pathToFileURL(join(root, "node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2")).href;

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".html") ? [p] : [];
  });
}
const decode = (s) => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

const pages = new Map();
for (const file of walk(dist)) {
  const html = readFileSync(file, "utf8");
  const img = html.match(/<meta property="og:image" content="[^"]*\/og\/([^"]+)\.png"/)?.[1];
  const title = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1];
  if (!img || !title) continue;
  const label = relative(dist, file).split(sep)[0].replace(/\.html$/, "");
  const shot = html.match(/<img\b[^>]*\bsrc="\/screens\/([a-z0-9-]+)\.webp"/)?.[1];
  pages.set(img, { shot, title: decode(title.replace(/<br\b[^>]*>/g, " ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()), section: label === "index" ? "" : label });
}

// The logo render made by `pnpm gen:brand` (assets/brand/png).
const markUrl = pathToFileURL(join(root, "../../assets/brand/png/rulebox-cube-128.png")).href;
const mark = `<img src="${markUrl}" width="64" height="64" alt="">`;

/* Only these keys (prefixes), when given on the command line. */
const only = process.argv.slice(2);
if (only.length) for (const k of [...pages.keys()]) if (!only.some((p) => k.startsWith(p))) pages.delete(k);

const shotUrl = (key) => pathToFileURL(join(root, "public", "screens", `${key}.webp`)).href;

const tones = ["#f5c518", "#3d7be0", "#ec5a3f", "#7b4fd6", "#3fc08b"];
const template = (p, i) => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:F;src:url(${font}) format("woff2");font-weight:300 900}
@font-face{font-family:M;src:url(${mono}) format("woff2");font-weight:100 900}
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;background:#f8f5f0;font-family:F;color:#231e19;position:relative;overflow:hidden}
.s{position:absolute;border-radius:28px}
.a{right:-40px;top:-60px;width:330px;height:420px;background:${tones[i % 5]}}
.b{right:200px;bottom:-70px;width:240px;height:260px;background:#231e19;background-image:radial-gradient(circle,rgba(255,255,255,.3) 1.6px,transparent 1.9px);background-size:16px 16px}
.c{right:40px;bottom:70px;width:150px;height:150px;background:${tones[(i + 2) % 5]}}
.brand{position:absolute;left:72px;top:64px;display:flex;align-items:center;gap:16px;font-weight:650;font-size:34px;letter-spacing:-.03em}
.sec{position:absolute;left:72px;top:180px;font-family:M;font-size:22px;letter-spacing:.1em;text-transform:uppercase;color:#6e655c}
h1{position:absolute;left:72px;top:226px;width:${p.shot ? 500 : 760}px;font-size:${p.title.length > 48 ? 58 : 70}px;line-height:1;font-weight:560;letter-spacing:-.045em}
.tag{position:absolute;left:72px;bottom:60px;font-size:26px;color:#6e655c}
.tag b{color:#185c45;font-weight:600}
.shot{position:absolute;left:610px;top:100px;width:660px;border-radius:18px;border:1px solid rgba(35,30,25,.12);box-shadow:0 1px 2px rgba(35,30,25,.08),0 40px 80px -30px rgba(35,30,25,.45)}
</style></head><body>
${p.shot ? `<span class="s a" style="top:-60px;height:330px"></span><img class="shot" src="${shotUrl(p.shot)}" alt="">` : `<span class="s a"></span><span class="s b"></span><span class="s c"></span>`}
<div class="brand">${mark}Rulebox</div>
${p.section ? `<p class="sec">${p.section.replace(/-/g, " ")}</p>` : ""}
<h1>${p.title.replace(/</g, "&lt;")}</h1>
<p class="tag"><b>Only what you allow.</b> Open-source kiosk OS for Windows.</p>
</body></html>`;

const tmp = join(root, ".og-tmp");
mkdirSync(tmp, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
let i = 0;
for (const [key, p] of pages) {
  const file = join(tmp, `${key}.html`);
  writeFileSync(file, template(p, i++));
  await page.goto(pathToFileURL(file).href);
  await page.evaluate(() => document.fonts.ready);
  const png = join(outPublic, `${key}.png`);
  await page.screenshot({ path: png, type: "png" });
  copyFileSync(png, join(outDist, `${key}.png`));
}
await browser.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`${pages.size} social cards written to public/og/${only.length ? ` (only: ${only.join(", ")})` : ""}`);
