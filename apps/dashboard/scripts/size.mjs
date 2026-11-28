// Size budget of the live dashboard build (plan Section 15, performance work).
//
//   pnpm --filter @rulebox/dashboard build
//   pnpm --filter @rulebox/dashboard size [--dist=dist] [--json] [--no-check]
//
// Prints raw / gzip / Brotli sizes of every built file and what each route
// loads before it can render, then exits 1 when the build is over budget.
// The graph is read from the built files themselves (index.html, static
// imports and Vite's preload map), so no bundler plugin is needed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { checkBudget, kb, reportRoutes } from "./size-core.ts";

/**
 * The budget. Every number is gzip KB (1 KB = 1024 bytes), measured 2026-10-27.
 *
 * Sign-in can not go below ~105 KB: React 19 + react-dom (~57), react-router
 * (~15-20) and the Convex client with Convex Auth (~23) come before any app
 * code. The limits sit a few KB above today's build so a regression fails CI;
 * lower them when the build gets smaller (next: splitting strings.ts, ~13 KB,
 * per screen). On Slow 4G (~180 KB/s) 10 KB is ~55 ms; a round trip ~560 ms,
 * which is why the boot script preloads the route's chunks.
 */
/**
 * Screens over the default 25 KB on top of the overview after the UI pass (2026-11-28), with the measured value, the absolute
 * cold-load total before -> after the pass, and why. Needs owner OK.
 */
const UI_PASS_SCREEN_KB = {
  // 29.8; 174.5 -> 187.3: "Programs to review" tabs, the allow dialog that picks the rule itself, the list kit (was in the overview).
  Findings: 30.5,
  // 29.1; 180.1 -> 188.8: password in the add form (one encrypted save), Advanced section, group picker, the list kit.
  WifiEdit: 30,
  // 30.1; 178.3 -> 189.9: one-address printer parsing, automatic driver choice, "Another driver..." in the same save.
  PrinterEdit: 31,
  // 33.0; 178.6 -> 192.7: driver form filled from the file (the zip and INF readers themselves are lazy chunks), Advanced fields.
  DriverEdit: 34,
  // 27.5; 170.7 -> 184.7: "On your PCs now" strip, compose dialog with picture cards, segmented expiry and the live preview.
  Broadcasts: 28.5,
  // 34.3; 174.3 -> 192.0: the guided Add a PC wizard with live progress, codes aside as cards (the QR encoder is lazy).
  Enrollment: 35,
};

const BUDGET = {
  routes: [
    // 145 / 145 / 150 / 167.5 again (UI pass size trim 2026-11-28, measured 138.5 / 139.0 / 144.1 / 166.4). The UI pass had pushed them to 146 / 146 / 151 / 168.5 (measured 145.3 / 145.7 / 150.9 / 167.5 at the start of the pass, 148.0 / 148.6 / 153.6 / 177.7 after the new pages). What the trim did (vite.config.ts, src/app/Layout.tsx): `core` no longer holds the list state, the printer / driver / Wi-Fi / notice / rollout rules and four unused form controls; a `shell` chunk (audit and install texts, clock, view store, dialog and menu pieces, card and page header; no dependencies pulled in) is loaded by the signed-in shell only; the passkey reminder (with the step-up texts, ~5 KB) is a lazy chunk.
    { name: "sign-in", chunks: ["SignIn"], maxJsKb: 145, maxCssKb: 19 },
    { name: "join", chunks: ["Join"], maxJsKb: 145, maxCssKb: 19, maxIncrementalKb: 5, incrementalFrom: "sign-in" },
    { name: "pin-reset", chunks: ["PinReset"], maxJsKb: 150, maxCssKb: 19, maxIncrementalKb: 10, incrementalFrom: "sign-in" },
    // The signed-in shell (navigation, account menu) plus the first screen.
    // 2026-10-27, Step 5a: +3.5 KB for the step-up controller (idle lock, keep-alive,
    // tabs) that every signed-in page must run; its dialogs and screens stay lazy.
    { name: "overview", chunks: ["Layout", "Overview"], maxJsKb: 167.5, maxCssKb: 19, maxIncrementalKb: 33, incrementalFrom: "sign-in" }, // 33 (UI pass 2026-11-28, measured 32.4, needs owner OK): the overview's own total is unchanged (167.1 before and after the pass); sign-in got 4.7 KB smaller, so the same overview counts as more on top of it. 167.5: new install-detail text (driver_untrusted_publisher) and the {InstallDir} refusal strings, 2026-11-26 (measured 167.1), needs owner OK; 26: Networks nav entry (Phase 5 Step 13, owner 2026-11-14); 165 / 27: Messages nav entry (Phase 5 Step 15, needs owner OK); 166 / 27.5: Phase 5 Step 19, the lockdown and findings routes plus the overview warning lines (measured 165.5 / 27.2; the warning lines themselves are a lazy chunk), needs owner OK; 166.5: Phase 6 Steps 12, 13 and 19 data-layer hooks and types (measured 166.2), owner OK 2026-11-21; 167: install-detail texts for every agent detail (measured 166.7, Overview imports installDetail)
    // Every other screen, on top of an already loaded overview.
    ...[
      "Devices",
      "DeviceDetail",
      "Groups",
      "GroupDetail",
      "Rollout",
      "Lockdown",
      "Findings",
      "Employees",
      "EmployeeDetail",
      "Apps",
      "AppEdit",
      "FileTypes",
      "Networks",
      "WifiEdit",
      "PrinterEdit",
      "DriverEdit",
      "Broadcasts",
      "Enrollment",
      "Audit",
      "Settings",
    ].map((screen) => ({
      name: screen,
      chunks: ["Layout", screen],
      // AppEdit 29 (Phase 6 Step 13, measured 28.0): the inline checks and the spec mapping of the installer details. Detect, the pre-fill, the
      // details card and the local file check are lazy chunks of their own (AppInstaller 4.5 KB, localInstaller 5.6 KB, loaded on use). Needs owner OK.
      // DeviceDetail 25.5 (Phase 6 Step 19, measured 25.0 after the display card became a lazy chunk). Needs owner OK.
      // AppEdit 29.5 (2026-11-26, measured 29.2): the {InstallDir} token check in the silent-argument rules. Needs owner OK.
      // UI pass 2026-11-28 (owner decision: measure, trim what is cheap, raise only what remains). AppEdit (now 5.1) and DeviceDetail
      // (now 20.4) are split into lazy chunks and back under the default 25. The table, pager, search and dropdown kit no longer rides in
      // the overview's first load (it moved out to keep sign-in and the overview under their limits), so every list or form screen now
      // pays for it on top of the overview; their absolute totals (initial JS on a cold load) are in UI_PASS_SCREEN_KB's comments.
      maxIncrementalKb: UI_PASS_SCREEN_KB[screen] ?? 25,
      incrementalFrom: "overview",
    })),
  ],
  // 400 -> 490 (UI pass 2026-11-28, measured 484.4; 358.6 before the pass). Every byte of it is lazy: the new pages and their own
  // chunks (device tabs, settings sections, add-app start / Windows / website flows and the site rules, the lockdown pieces, the
  // enrollment wizard, QR encoder, zip and INF readers, the group / employee / rollout / messages pages, shared dropdown, tooltip,
  // cards and chip pieces). The design gallery is no longer built into a live build (-30 KB). Needs owner OK.
  maxTotalJsKb: 490,
  // Latin and Latin Extended only (accented names); other scripts use the system font.
  allowedFonts: [/-latin-wght-normal-/, /-latin-ext-wght-normal-/],
  // Demo fixtures and the demo store (src/data/fixtures, src/data/demo) must never
  // reach a live build. (The demo sign-in hints in strings.ts are allowed: tiny.)
  forbiddenStrings: ["OFFICE-SCANNER", "Pharmacy counter", "rulebox.demo.controls"],
};

const args = new Set(process.argv.slice(2));
const distArg = process.argv.slice(2).find((a) => a.startsWith("--dist="));
const DIST = resolve(distArg ? distArg.slice(7) : "dist");
if (!existsSync(join(DIST, "index.html"))) {
  console.error(`No build in ${DIST}. Run "pnpm --filter @rulebox/dashboard build" first.`);
  process.exit(2);
}

const files = new Map();
for (const name of readdirSync(join(DIST, "assets"))) {
  const path = join(DIST, "assets", name);
  if (!statSync(path).isFile()) continue;
  const buf = readFileSync(path);
  const text = /\.(js|css|svg)$/.test(name);
  files.set(`assets/${name}`, {
    raw: buf.length,
    gzip: text ? gzipSync(buf, { level: 9 }).length : buf.length,
    brotli: text ? brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length : buf.length,
    code: name.endsWith(".js") ? buf.toString("utf8") : undefined,
  });
}
const build = { html: readFileSync(join(DIST, "index.html"), "utf8"), files };
const reports = reportRoutes(build, BUDGET.routes);

if (args.has("--json")) {
  const out = {
    files: Object.fromEntries([...files].map(([f, { raw, gzip, brotli }]) => [f, { raw, gzip, brotli }])),
    routes: reports.map(({ name, files: list, js, css, incremental }) => ({ name, files: list, js, css, incremental })),
  };
  console.log(JSON.stringify(out, null, 2));
} else {
  const f1 = (n) => kb(n).toFixed(1).padStart(7);
  console.log("file".padEnd(58), "    raw", "   gzip", " brotli  (KB)");
  for (const [name, s] of [...files].sort((a, b) => b[1].raw - a[1].raw)) {
    console.log(name.padEnd(58), f1(s.raw), f1(s.gzip), f1(s.brotli));
  }
  console.log("\nroute".padEnd(16), "JS gzip", "  JS br", "CSS gzip", " CSS br", " +gzip vs base", "files");
  for (const r of reports) {
    console.log(
      r.name.padEnd(15),
      f1(r.js.gzip),
      f1(r.js.brotli),
      f1(r.css.gzip).padStart(8),
      f1(r.css.brotli),
      f1(r.incremental.gzip).padStart(14),
      String(r.files.length).padStart(5),
    );
  }
}

if (!args.has("--no-check")) {
  const problems = checkBudget(build, BUDGET, reports);
  if (problems.length) {
    console.error(`\nOver budget:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("\nWithin budget.");
}
