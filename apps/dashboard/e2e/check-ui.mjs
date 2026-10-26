// Headless UI check for the demo build (pnpm build:demo, then pnpm preview:demo).
// Takes screenshots of every screen (1280x800 and 390x844, light and dark),
// checks for horizontal overflow at 320 px and runs axe-core on every screen.
//
//   node e2e/check-ui.mjs [baseUrl] [--only=shots|overflow|axe|keyboard]
//
// Screenshots go to <repo>/.tmp/phase4/ (gitignored). Only the browser page is
// captured, never the desktop.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../../../.tmp/phase4");
mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const BASE = args.find((a) => !a.startsWith("--")) ?? "http://localhost:4180";
const only = (args.find((a) => a.startsWith("--only=")) ?? "").slice(7);
const run = (part) => !only || only.split(",").includes(part);
const executablePath = process.env.RB_CHROME || undefined;

const browser = await chromium.launch({ headless: true, executablePath });

async function newPage({ width, height, theme, reduced = true }) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    reducedMotion: reduced ? "reduce" : "no-preference",
    colorScheme: theme === "dark" ? "dark" : "light",
  });
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem("rulebox.theme", t);
    } catch {
      /* ignore */
    }
  }, theme);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`  [console] ${m.text()}`);
  });
  return page;
}

async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  // Wait for skeletons (simulated latency) to go away.
  await page.waitForTimeout(100);
  await page
    .waitForFunction(() => document.querySelector("h1") && document.querySelectorAll(".dash-sk, [aria-busy='true']").length === 0, null, { timeout: 8000 })
    .catch(() => {});
  await page.waitForTimeout(150);
}

async function signIn(page) {
  await page.goto(`${BASE}/sign-in`);
  await settle(page);
  await page.getByLabel("Email").fill("owner@demo.rulebox.test");
  await page.getByLabel("Password", { exact: true }).fill("rulebox-demo-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/mfa/);
  await settle(page);
  await page.getByLabel("6-digit code").fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/mfa"));
  await settle(page);
}

/** Ids are deterministic (seeded fixtures): read them once from the lists. */
async function discover(page) {
  const href = async (path, text) => {
    await page.goto(`${BASE}${path}`);
    await settle(page);
    const link = text ? page.getByRole("link", { name: text, exact: true }).first() : page.locator("table a").first();
    return link.getAttribute("href");
  };
  return {
    device: await href("/devices", "OFFICE-SCANNER"),
    deviceLong: await href("/devices", "WAREHOUSE-RECEIVING-DOCK-EAST-TERMINAL-02-LEGACY-HARDWARE-ON-LOAN-FROM-HEAD-OFFICE"),
    group: await href("/groups", "Pharmacy counter"),
    groupEmpty: await href("/groups", "Training room"),
    employee: await href("/employees?group=", null),
    app: await href("/apps", "7-Zip"),
    appWeb: await href("/apps", "Point of Sale"),
  };
}

function routes(ids) {
  return [
    ["overview", "/"],
    ["devices", "/devices"],
    ["device", ids.device],
    ["device-long", ids.deviceLong],
    ["groups", "/groups"],
    ["group", ids.group],
    ["group-empty", ids.groupEmpty],
    ["employees", "/employees"],
    ["employee", ids.employee],
    ["employee-new", "/employees/new"],
    ["apps", "/apps"],
    ["app-desktop", ids.app],
    ["app-web", ids.appWeb],
    ["app-new-web", "/apps/new?kind=web"],
    ["app-new-desktop", "/apps/new?kind=desktop"],
    ["file-types", "/file-types"],
    ["enrollment", "/enrollment"],
    ["audit", "/audit"],
    ["settings-org", "/settings"],
    ["settings-exit", "/settings?tab=adminExit"],
    ["settings-signing", "/settings?tab=signing"],
    ["settings-members", "/settings?tab=members"],
    ["settings-about", "/settings?tab=about"],
    ["gallery", "/gallery"],
    ["not-found", "/this-does-not-exist"],
  ];
}

const PUBLIC = [
  ["sign-in", "/sign-in"],
  ["join", "/join"],
  ["reset", "/reset"],
];

const report = { overflow: [], axe: [], keyboard: [] };

if (run("shots")) {
  for (const theme of ["light", "dark"]) {
    for (const [w, h] of [
      [1280, 800],
      [390, 844],
    ]) {
      const page = await newPage({ width: w, height: h, theme });
      for (const [name, path] of PUBLIC) {
        await page.goto(`${BASE}${path}`);
        await settle(page);
        await page.screenshot({ path: join(OUT, `${name}-${w}-${theme}.png`), fullPage: true });
      }
      // MFA setup + recovery codes: join as the invited admin.
      await page.goto(`${BASE}/join`);
      await settle(page);
      await page.getByLabel("Invite code").fill("JOIN-DEMO-2026");
      await page.getByLabel("Email").fill("new.admin@demo.rulebox.test");
      await page.getByLabel("New password").fill("a-long-password-1");
      await page.getByLabel("Repeat the password").fill("a-long-password-1");
      await page.getByRole("button", { name: "Create account" }).click();
      await page.waitForURL(/\/mfa/);
      await page.getByText("Enter the 6-digit code the app shows.").waitFor();
      await settle(page);
      await page.screenshot({ path: join(OUT, `mfa-setup-${w}-${theme}.png`), fullPage: true });
      await page.getByLabel("6-digit code").fill("123456");
      await page.getByRole("button", { name: "Confirm" }).click();
      await page.getByText("Save your recovery codes").waitFor();
      await settle(page);
      await page.screenshot({ path: join(OUT, `mfa-recovery-${w}-${theme}.png`), fullPage: true });
      // Sign out, then sign in as the owner (MFA verify screen).
      await page.evaluate(() => sessionStorage.clear());
      await page.goto(`${BASE}/sign-in`);
      await settle(page);
      await page.getByLabel("Email").fill("owner@demo.rulebox.test");
      await page.getByLabel("Password", { exact: true }).fill("rulebox-demo-1");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/mfa/);
      await page.getByText("Enter your code").waitFor();
      await settle(page);
      await page.screenshot({ path: join(OUT, `mfa-verify-${w}-${theme}.png`), fullPage: true });
      await page.getByLabel("6-digit code").fill("123456");
      await page.getByRole("button", { name: "Verify" }).click();
      await page.waitForURL((u) => !u.pathname.startsWith("/mfa"));
      const ids = await discover(page);
      for (const [name, path] of routes(ids)) {
        await page.goto(`${BASE}${path}`);
        await settle(page);
        await page.screenshot({ path: join(OUT, `${name}-${w}-${theme}.png`), fullPage: true });
      }
      if (w === 390) {
        await page.goto(`${BASE}/`);
        await settle(page);
        await page.getByRole("button", { name: "Open menu" }).click();
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(OUT, `nav-sheet-${w}-${theme}.png`) });
      }
      // A confirm dialog and the enrollment one-time code.
      await page.goto(`${BASE}/enrollment`);
      await settle(page);
      await page.getByRole("button", { name: "Create code" }).first().click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(OUT, `enrollment-dialog-${w}-${theme}.png`) });
      await page.getByRole("dialog").getByRole("button", { name: "Create code" }).click();
      await page.getByText("This code is shown only now.").waitFor();
      await settle(page);
      await page.screenshot({ path: join(OUT, `enrollment-code-${w}-${theme}.png`), fullPage: true });
      await page.goto(`${BASE}${ids.device}`);
      await settle(page);
      await page.getByRole("button", { name: "Revoke" }).click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(OUT, `confirm-revoke-${w}-${theme}.png`) });
      await page.context().close();
      console.log(`shots ${theme} ${w}: done`);
    }
  }
}

if (run("overflow") || run("axe")) {
  for (const width of run("overflow") ? [320, 1280] : [1280]) {
    for (const theme of run("axe") ? ["light", "dark"] : ["light"]) {
      const page = await newPage({ width, height: 800, theme });
      for (const [name, path] of PUBLIC) {
        await page.goto(`${BASE}${path}`);
        await settle(page);
        await check(page, name, width, theme);
      }
      await signIn(page);
      const ids = await discover(page);
      for (const [name, path] of routes(ids)) {
        await page.goto(`${BASE}${path}`);
        await settle(page);
        await check(page, name, width, theme);
      }
      await page.context().close();
      console.log(`checks ${theme} ${width}: done`);
    }
  }
}

async function check(page, name, width, theme) {
  await page.waitForTimeout(300); // let entrance fades finish before measuring contrast
  if (run("overflow")) {
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    if (o.sw > o.iw) {
      const culprits = await page.evaluate(() =>
        [...document.querySelectorAll("body *")]
          .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
          .slice(0, 5)
          .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} (${Math.round(el.getBoundingClientRect().right)})`),
      );
      report.overflow.push({ name, width, ...o, culprits });
    }
  }
  if (run("axe") && width === 1280) {
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    for (const v of r.violations) {
      report.axe.push({
        name,
        theme,
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.slice(0, 3).map((n) => `${n.target.join(" ")} :: ${n.failureSummary?.split("\n")[1] ?? ""}`),
      });
    }
  }
}

if (run("keyboard")) {
  // Keyboard-only: sign in with Tab/Enter, open a form, submit it with Enter.
  const page = await newPage({ width: 1280, height: 800, theme: "light" });
  await page.goto(`${BASE}/sign-in`);
  await settle(page);
  await page.keyboard.press("Tab");
  const tabOrder = [];
  for (let i = 0; i < 6; i++) {
    tabOrder.push(await page.evaluate(() => `${document.activeElement?.tagName} ${document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim().slice(0, 30)}`));
    await page.keyboard.press("Tab");
  }
  report.keyboard.push({ step: "sign-in tab order", tabOrder });
  await page.goto(`${BASE}/sign-in`);
  await settle(page);
  await page.getByLabel("Email").focus();
  await page.keyboard.type("owner@demo.rulebox.test");
  await page.keyboard.press("Tab");
  await page.keyboard.type("rulebox-demo-1");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/mfa/);
  await settle(page);
  await page.keyboard.type("123456");
  await page.keyboard.press("Enter");
  await page.waitForURL((u) => !u.pathname.startsWith("/mfa"));
  await settle(page);
  report.keyboard.push({ step: "sign-in + MFA by keyboard", ok: true, url: page.url() });
  // Skip link.
  await page.keyboard.press("Tab");
  const skip = await page.evaluate(() => document.activeElement?.textContent);
  await page.keyboard.press("Enter");
  const afterSkip = await page.evaluate(() => document.activeElement?.id);
  report.keyboard.push({ step: "skip link", first: skip, focusedAfter: afterSkip });
  // Groups: open "New group" by keyboard, Enter submits, Escape closes.
  await page.goto(`${BASE}/groups`);
  await settle(page);
  await page.getByRole("button", { name: "New group" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const focusedInDialog = await page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]")));
  await page.keyboard.press("Enter"); // empty name → validation
  await page.waitForTimeout(150);
  const err = await page.locator(".dash-field__error").first().textContent().catch(() => null);
  const invalidFocused = await page.evaluate(() => document.activeElement?.getAttribute("aria-invalid"));
  await page.keyboard.type("Keyboard group");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/groups\/.+/, { timeout: 5000 }).catch(() => {});
  report.keyboard.push({ step: "new group dialog", focusedInDialog, error: err, invalidFocused, url: page.url() });
  await page.goto(`${BASE}/groups`);
  await settle(page);
  await page.getByRole("button", { name: "New group" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  const restored = await page.evaluate(() => document.activeElement?.textContent?.trim());
  report.keyboard.push({ step: "escape closes and restores focus", focused: restored });
  // Settings tabs with arrow keys.
  await page.goto(`${BASE}/settings`);
  await settle(page);
  await page.getByRole("tab", { name: "Organization" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(150);
  report.keyboard.push({ step: "settings tabs arrow", url: page.url(), focused: await page.evaluate(() => document.activeElement?.textContent) });
  await page.context().close();
}

await browser.close();
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(`overflow problems: ${report.overflow.length}`);
for (const o of report.overflow) console.log(`  ${o.name} @${o.width}: ${o.sw} > ${o.iw}  ${o.culprits.join(" | ")}`);
console.log(`axe violations: ${report.axe.length}`);
for (const a of report.axe) console.log(`  [${a.theme}] ${a.name}: ${a.id} (${a.impact}) ${a.help}\n      ${a.nodes.join("\n      ")}`);
for (const k of report.keyboard) console.log(`  keyboard: ${JSON.stringify(k)}`);
