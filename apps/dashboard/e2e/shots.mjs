// Screenshots of chosen dashboard screens at the UI-pass widths (demo mode, no backend).
//
//   pnpm --filter @rulebox/dashboard dev:demo -- --port 4321 --strictPort   (in another terminal)
//   node e2e/shots.mjs http://localhost:4321 --out=../../.tmp/ui-pass/devices \
//        --paths=devices:/devices,device:@device,settings:/settings?tab=updates \
//        [--widths=390,820,1366,1920] [--themes=light,dark] [--full=0] [--storage=rulebox.view=cards]
//
// `@name` paths are discovered from the seeded demo lists: @device, @deviceLong,
// @group, @groupEmpty, @employee, @app, @appWeb. A path may carry a query string.
// Files are named <name>-<width>-<theme>.png. Only the browser page is captured.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).slice(k.length + 3);
const BASE = args.find((a) => !a.startsWith("--")) ?? "http://localhost:4321";
const OUT = resolve(opt("out", "../../.tmp/ui-pass/shots"));
const widths = opt("widths", "390,820,1366,1920").split(",").map(Number);
const themes = opt("themes", "light,dark").split(",");
const full = opt("full", "1") !== "0";
// --storage=key=value[,key=value]: localStorage entries set before the app loads (e.g. rulebox.view=cards).
const storage = opt("storage", "")
  .split(",")
  .filter(Boolean)
  .map((kv) => {
    const i = kv.indexOf("=");
    return [kv.slice(0, i), kv.slice(i + 1)];
  });
const paths = opt("paths", "overview:/")
  .split(",")
  .filter(Boolean)
  .map((p) => {
    const i = p.indexOf(":");
    return [p.slice(0, i), p.slice(i + 1)];
  });
mkdirSync(OUT, { recursive: true });

const PIN = "482915";
const browser = await chromium.launch({ headless: true, executablePath: process.env.RB_CHROME || undefined });

async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(100);
  await page
    .waitForFunction(() => document.querySelector("h1") && document.querySelectorAll(".dash-sk, [aria-busy='true']").length === 0, null, { timeout: 8000 })
    .catch(() => {});
  await page.waitForTimeout(200);
}

async function unlock(page) {
  const shown = await page.getByRole("heading", { name: "Enter your PIN" }).waitFor({ timeout: 2500 }).then(() => true, () => false);
  if (!shown) return;
  await page.getByLabel("PIN", { exact: true }).fill(PIN);
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.getByRole("heading", { name: "Enter your PIN" }).waitFor({ state: "detached" });
  await settle(page);
}

async function newPage(width, theme) {
  const ctx = await browser.newContext({
    viewport: { width, height: width < 600 ? 844 : width < 1000 ? 1180 : width < 1600 ? 860 : 1080 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    colorScheme: theme === "dark" ? "dark" : "light",
  });
  await ctx.addInitScript(
    ([t, extra]) => {
      try {
        localStorage.setItem("rulebox.theme", t);
        for (const [k, v] of extra) localStorage.setItem(k, v);
      } catch {
        /* ignore */
      }
    },
    [theme, storage],
  );
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
  await page.goto(`${BASE}/sign-in`);
  await settle(page);
  await page.getByLabel("Email").fill("owner@demo.rulebox.test");
  await page.getByLabel("Password", { exact: true }).fill("rulebox-demo-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await unlock(page);
  return page;
}

const DISCOVER = {
  device: ["/devices", "OFFICE-SCANNER"],
  deviceLong: ["/devices", "WAREHOUSE-RECEIVING-DOCK-EAST-TERMINAL-02-LEGACY-HARDWARE-ON-LOAN-FROM-HEAD-OFFICE"],
  group: ["/groups", "Pharmacy counter"],
  groupEmpty: ["/groups", "Training room"],
  employee: ["/employees?group=", null],
  app: ["/apps", "7-Zip"],
  appWeb: ["/apps", "Point of Sale"],
};
const found = {};
async function resolvePath(page, path) {
  if (!path.startsWith("@")) return path;
  const [name, rest = ""] = path.slice(1).split(/(?=[?/])/, 2);
  if (!found[name]) {
    const [list, text] = DISCOVER[name];
    await page.goto(`${BASE}${list}${text ? `?q=${encodeURIComponent(text)}` : ""}`);
    await unlock(page);
    await settle(page);
    const link = text ? page.getByRole("link", { name: text, exact: true }).first() : page.locator("main a[href^='/employees/']:not([href^='/employees/new'])").first();
    found[name] = await link.getAttribute("href");
  }
  return found[name] + rest;
}

for (const theme of themes) {
  for (const w of widths) {
    const page = await newPage(w, theme);
    for (const [name, path] of paths) {
      const url = await resolvePath(page, path);
      await page.goto(`${BASE}${url}`);
      await unlock(page);
      await settle(page);
      const file = join(OUT, `${name}-${w}-${theme}.png`);
      await page.screenshot({ path: file, fullPage: full });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      console.log(`${file}${overflow ? "  [horizontal overflow]" : ""}`);
    }
    await page.context().close();
  }
}
await browser.close();
