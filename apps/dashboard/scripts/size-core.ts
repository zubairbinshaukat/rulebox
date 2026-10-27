/**
 * Pure part of the dashboard's size budget (`pnpm --filter @rulebox/dashboard
 * size`): reads the chunk graph of a Vite build out of the built files and
 * checks it against the budget. No Node APIs here, so it is unit tested
 * (`size-core.test.ts`) and the CLI (`size.mjs`) only does the file IO.
 */

/** Compressed and raw size of one built file. */
export interface FileSize {
  raw: number;
  gzip: number;
  brotli: number;
}

/** One route: the lazy chunks (by module name) it needs on top of the entry. */
export interface RouteSpec {
  name: string;
  /** Module names such as `Layout` or `SignIn` (the chunk file is `<name>-<hash>.js`). */
  chunks: string[];
  /** Max gzip KB of all JS this route loads first (entry + its chunks). */
  maxJsKb?: number;
  /** Max gzip KB of all CSS this route loads first. */
  maxCssKb?: number;
  /** Max gzip KB of JS + CSS on top of `incrementalFrom` (or the entry). */
  maxIncrementalKb?: number;
  /** Route whose files count as already loaded for `maxIncrementalKb`. */
  incrementalFrom?: string;
}

export interface Budget {
  routes: RouteSpec[];
  /** Max gzip KB of every JS file in the build together (plan Section 15). */
  maxTotalJsKb: number;
  /** Font files allowed in the build (regular expressions on the file name). */
  allowedFonts: RegExp[];
  /** Strings that must not appear in any JS of a live build (demo fixtures). */
  forbiddenStrings: string[];
}

export interface HtmlRefs {
  scripts: string[];
  modulePreloads: string[];
  styles: string[];
  preloads: string[];
}

const ASSET = /^\/?(assets\/[^"'`?#]+)$/;

function normalize(href: string): string | null {
  const m = ASSET.exec(href.trim());
  return m?.[1] ?? null;
}

/** The files `index.html` loads: module scripts, modulepreloads, stylesheets and preloads (assets only). */
export function parseHtml(html: string): HtmlRefs {
  const refs: HtmlRefs = { scripts: [], modulePreloads: [], styles: [], preloads: [] };
  for (const tag of html.match(/<(script|link)\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag)?.[1];
    if (/^<script/i.test(tag)) {
      const src = attr("src");
      const file = src ? normalize(src) : null;
      if (file) refs.scripts.push(file);
      continue;
    }
    const href = attr("href");
    const file = href ? normalize(href) : null;
    if (!file) continue;
    const rel = (attr("rel") ?? "").toLowerCase();
    if (rel === "modulepreload") refs.modulePreloads.push(file);
    else if (rel === "stylesheet") refs.styles.push(file);
    else if (rel === "preload") refs.preloads.push(file);
  }
  return refs;
}

/**
 * Static imports of a built chunk (`import{a}from"./x.js"`, `import"./x.js"`),
 * as `assets/` paths. Dynamic `import()` calls are not included.
 */
export function staticImports(code: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:import|export)\s*(?:[\w${},\s*]+?\s*from\s*)?["'`]\.\/([^"'`]+)["'`]/g;
  for (const m of code.matchAll(re)) out.add(`assets/${m[1]}`);
  return [...out];
}

/**
 * Vite's preload map of a chunk: for each dynamic `import("./X.js")` the list
 * of files (JS and CSS) Vite loads with it, from `__vite__mapDeps`.
 */
export function dynamicDeps(code: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const table = /m\.f=\[([^\]]*)\]/.exec(code);
  const files = table?.[1] ? [...table[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]) : [];
  const re = /import\(\s*["'`]\.\/([^"'`]+)["'`]\s*\)\s*(?:,\s*__vite__mapDeps\(\[([\d,\s]*)\]\))?/g;
  for (const m of code.matchAll(re)) {
    const target = `assets/${m[1]}`;
    const deps = m[2] ? m[2].split(",").filter(Boolean).map((i) => files[Number(i)]).filter((f): f is string => !!f) : [];
    result.set(target, [...new Set([target, ...deps])]);
  }
  return result;
}

/** Every file reachable from `start` through static imports (the start files included). */
export function closure(start: Iterable<string>, importsOf: (file: string) => string[]): Set<string> {
  const seen = new Set<string>();
  const todo = [...start];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (f.endsWith(".js")) todo.push(...importsOf(f));
  }
  return seen;
}

/** The built chunk of a module, `assets/<name>-<hash>.js`. */
export function chunkFor(files: Iterable<string>, name: string): string | undefined {
  const re = new RegExp(`^assets/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[\\w-]{6,}\\.js$`);
  for (const f of files) if (re.test(f)) return f;
  return undefined;
}

export interface Build {
  html: string;
  /** Every built file under `assets/` with its size and (for JS) its source. */
  files: Map<string, FileSize & { code?: string }>;
}

export interface RouteReport {
  name: string;
  files: string[];
  js: FileSize;
  css: FileSize;
  /** JS + CSS not already loaded by the route it is measured from. */
  incremental: FileSize;
  missing: string[];
}

const ZERO: FileSize = { raw: 0, gzip: 0, brotli: 0 };

function sum(files: Iterable<string>, build: Build, test: (f: string) => boolean): FileSize {
  const total = { ...ZERO };
  for (const f of files) {
    if (!test(f)) continue;
    const s = build.files.get(f);
    if (!s) continue;
    total.raw += s.raw;
    total.gzip += s.gzip;
    total.brotli += s.brotli;
  }
  return total;
}

/** The files the entry needs before anything renders (scripts, their imports, CSS). */
export function entryFiles(build: Build): Set<string> {
  const refs = parseHtml(build.html);
  const importsOf = (f: string) => staticImports(build.files.get(f)?.code ?? "");
  return closure([...refs.scripts, ...refs.modulePreloads, ...refs.styles], importsOf);
}

/** All files a route loads first: the entry plus each lazy chunk with its preload deps. */
export function routeFiles(build: Build, route: RouteSpec): { files: Set<string>; missing: string[] } {
  const importsOf = (f: string) => staticImports(build.files.get(f)?.code ?? "");
  const deps = new Map<string, string[]>();
  for (const [, s] of build.files) {
    if (!s.code) continue;
    for (const [k, v] of dynamicDeps(s.code)) deps.set(k, [...new Set([...(deps.get(k) ?? []), ...v])]);
  }
  const files = entryFiles(build);
  const missing: string[] = [];
  for (const name of route.chunks) {
    const optional = name.endsWith("?");
    const chunk = chunkFor(build.files.keys(), optional ? name.slice(0, -1) : name);
    if (!chunk) {
      if (!optional) missing.push(name);
      continue;
    }
    for (const f of closure(deps.get(chunk) ?? [chunk], importsOf)) files.add(f);
  }
  return { files, missing };
}

const isJs = (f: string) => f.endsWith(".js");
const isCss = (f: string) => f.endsWith(".css");

export function reportRoutes(build: Build, routes: RouteSpec[]): RouteReport[] {
  const byName = new Map<string, Set<string>>();
  const reports: RouteReport[] = [];
  const entry = entryFiles(build);
  for (const route of routes) {
    const { files, missing } = routeFiles(build, route);
    byName.set(route.name, files);
    const base = (route.incrementalFrom ? byName.get(route.incrementalFrom) : undefined) ?? entry;
    const extra = [...files].filter((f) => !base.has(f));
    reports.push({
      name: route.name,
      files: [...files].sort(),
      js: sum(files, build, isJs),
      css: sum(files, build, isCss),
      incremental: sum(extra, build, (f) => isJs(f) || isCss(f)),
      missing,
    });
  }
  return reports;
}

export const kb = (bytes: number) => bytes / 1024;

/** Every way the build breaks the budget, as readable sentences (empty = within budget). */
export function checkBudget(build: Build, budget: Budget, reports = reportRoutes(build, budget.routes)): string[] {
  const problems: string[] = [];
  for (const r of reports) {
    const spec = budget.routes.find((s) => s.name === r.name)!;
    for (const m of r.missing) problems.push(`${r.name}: no chunk named "${m}" in the build`);
    if (spec.maxJsKb !== undefined && kb(r.js.gzip) > spec.maxJsKb)
      problems.push(`${r.name}: initial JS ${kb(r.js.gzip).toFixed(1)} KB gzip > ${spec.maxJsKb} KB`);
    if (spec.maxCssKb !== undefined && kb(r.css.gzip) > spec.maxCssKb)
      problems.push(`${r.name}: initial CSS ${kb(r.css.gzip).toFixed(1)} KB gzip > ${spec.maxCssKb} KB`);
    if (spec.maxIncrementalKb !== undefined && kb(r.incremental.gzip) > spec.maxIncrementalKb)
      problems.push(
        `${r.name}: ${kb(r.incremental.gzip).toFixed(1)} KB gzip on top of ${spec.incrementalFrom ?? "the entry"} > ${spec.maxIncrementalKb} KB`,
      );
  }
  const totalJs = sum(build.files.keys(), build, isJs);
  if (kb(totalJs.gzip) > budget.maxTotalJsKb)
    problems.push(`all JS together ${kb(totalJs.gzip).toFixed(1)} KB gzip > ${budget.maxTotalJsKb} KB`);
  for (const f of build.files.keys()) {
    if (f.endsWith(".woff2") || f.endsWith(".woff")) {
      if (!budget.allowedFonts.some((re) => re.test(f))) problems.push(`font not in the allowed subsets: ${f}`);
    }
  }
  for (const [f, s] of build.files) {
    for (const needle of budget.forbiddenStrings) {
      if (s.code?.includes(needle)) problems.push(`${f} contains "${needle}" (demo code in a live build)`);
    }
  }
  return problems;
}
