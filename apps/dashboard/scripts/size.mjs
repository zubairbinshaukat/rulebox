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
const BUDGET = {
  routes: [
    { name: "sign-in", chunks: ["SignIn"], maxJsKb: 145, maxCssKb: 19 },
    { name: "join", chunks: ["Join"], maxJsKb: 145, maxCssKb: 19, maxIncrementalKb: 5, incrementalFrom: "sign-in" },
    { name: "mfa", chunks: ["Mfa"], maxJsKb: 150, maxCssKb: 19, maxIncrementalKb: 10, incrementalFrom: "sign-in" },
    // The signed-in shell (navigation, account menu) plus the first screen.
    { name: "overview", chunks: ["Layout", "Overview"], maxJsKb: 160, maxCssKb: 19, maxIncrementalKb: 25, incrementalFrom: "sign-in" },
    // Every other screen, on top of an already loaded overview.
    ...[
      "Devices",
      "DeviceDetail",
      "Groups",
      "GroupDetail",
      "Employees",
      "EmployeeDetail",
      "Apps",
      "AppEdit",
      "FileTypes",
      "Enrollment",
      "Audit",
      "Settings",
    ].map((screen) => ({ name: screen, chunks: ["Layout", screen], maxIncrementalKb: 25, incrementalFrom: "overview" })),
  ],
  maxTotalJsKb: 400,
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
