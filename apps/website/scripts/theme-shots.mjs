// Screenshots for the colour review (light-only site, Deep teal): 1440/390
// for home, a use-case page, pricing, the pilot form and the open nav menu.
// One browser, one page at a time (low-memory machine).
//
//   node scripts/theme-shots.mjs [baseUrl] [--widths=390] [--only=home,nav]
//
// Output: apps/website/.screenshots/theme/

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", ".screenshots", "theme");
mkdirSync(out, { recursive: true });

const args = process.argv.slice(2);
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3).split(",") ?? d;
const base = (args.find((a) => a.startsWith("http")) ?? "http://localhost:4322").replace(/\/$/, "");
const widths = opt("widths", ["1440", "390"]).map(Number);
const shots = {
  home: { path: "/", full: true },
  usecase: { path: "/use-cases/clinics-and-pharmacies", full: true },
  pricing: { path: "/pricing", full: true },
  pilot: { path: "/pilot", full: true },
  nav: { path: "/", full: false, nav: true },
};
const only = opt("only", Object.keys(shots));

const browser = await chromium.launch();
try {
  for (const width of widths) {
    const ctx = await browser.newContext({
      viewport: { width, height: width > 600 ? 900 : 844 },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    });
    const page = await ctx.newPage();
    for (const name of only) {
      const s = shots[name];
      await page.goto(`${base}${s.path}?preloader=0`, { waitUntil: "load" });
      await page.waitForTimeout(900);
      if (s.full) {
        // Walk down once so lazy images load, then back to the top.
        await page.evaluate(async () => {
          for (let y = 0; y < document.documentElement.scrollHeight; y += 700) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 60));
          }
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(500);
      }
      if (s.nav) {
        if (width > 900) {
          await page.hover("[data-dd-trigger]");
          await page.click("[data-dd-trigger]");
        } else {
          await page.click("[data-mobile-toggle]");
        }
        await page.waitForTimeout(700);
      }
      await page.screenshot({ path: join(out, `${name}-${width}.png`), fullPage: s.full });
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(`Saved to ${out}`);