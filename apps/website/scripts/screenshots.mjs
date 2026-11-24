// Screenshots of the built site for review. Uses the Playwright browsers
// already installed for apps/dashboard (no download).
//
//   pnpm --filter @rulebox/website preview   (in another terminal, port 4321)
//   node scripts/screenshots.mjs [baseUrl] [--only=/path,/path] [--home-scroll]
//
// Output: apps/website/.screenshots/ (gitignored)

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", ".screenshots");
mkdirSync(out, { recursive: true });

const args = process.argv.slice(2);
const base = (args.find((a) => a.startsWith("http")) ?? "http://localhost:4321").replace(/\/$/, "");
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const homeScroll = args.includes("--home-scroll");

const L1 = [
  "/",
  "/product",
  "/features",
  "/features/lockdown",
  "/features/staff-desktop",
  "/features/employee-sign-in",
  "/features/apps",
  "/features/dashboard",
  "/use-cases",
  "/use-cases/shared-staff-pcs",
  "/pricing",
  "/pilot",
  "/download",
  "/open-source",
  "/security",
  "/security/disclosure",
  "/roadmap",
  "/changelog",
  "/docs",
  "/about",
  "/contact",
  "/legal/privacy",
  "/404",
];
const pages = only ?? L1;
const slug = (p) => (p === "/" ? "home" : p.slice(1).replaceAll("/", "_"));

const browser = await chromium.launch();
async function shoot(path, { width, height, name, full = true }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: "no-preference" });
  const page = await ctx.newPage();
  await page.goto(base + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(2200);
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: full });
  await ctx.close();
}

for (const p of pages) {
  // Light-only site (owner, 2026-11-25).
  await shoot(p, { width: 1440, height: 900, name: `${slug(p)}-1440` });
  if (p === "/" || !only) await shoot(p, { width: 390, height: 844, name: `${slug(p)}-390` });
}

if (homeScroll) {
  // Viewport shots while scrolling, to check the sticky hero and the day graphic.
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(base + "/", { waitUntil: "networkidle" });
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    let i = 0;
    for (let y = 0; y < total && i < 26; y += 700, i++) {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(out, `scroll-${String(i).padStart(2, "0")}.png`) });
    }
    await ctx.close();
  }
}

await browser.close();
console.log(`Saved to ${out}`);
