import { describe, expect, it } from "vitest";
import {
  checkBudget,
  chunkFor,
  closure,
  dynamicDeps,
  parseHtml,
  reportRoutes,
  staticImports,
  type Budget,
  type Build,
  type FileSize,
} from "./size-core";

const HTML = `<!doctype html><html><head>
<script src="/assets/boot-abcdef12.js"></script>
<link rel="preload" href="/assets/figtree-latin-wght-normal-XXXXXX.woff2" as="font" type="font/woff2" crossorigin />
<script type="module" crossorigin src="/assets/index-AAAAAA.js"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor-BBBBBB.js">
<link rel="stylesheet" crossorigin href="/assets/index-CCCCCC.css">
<link rel="icon" href="/favicon.svg">
</head></html>`;

const ENTRY = [
  `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/SignIn-DDDDDD.js","assets/shared-EEEEEE.js","assets/Layout-FFFFFF.js","assets/Layout-GGGGGG.css"])))=>i.map(i=>d[i]);`,
  `import{a as e}from"./vendor-BBBBBB.js";import"./side-HHHHHH.js";`,
  "var s=e(()=>p(()=>import(`./SignIn-DDDDDD.js`),__vite__mapDeps([0,1])));",
  "var l=e(()=>p(()=>import(`./Layout-FFFFFF.js`),__vite__mapDeps([2,1,3])));",
  "var g=e(()=>import(`./Gallery-IIIIII.js`));",
].join("");

function size(gzip: number): FileSize {
  return { raw: gzip * 3, gzip, brotli: gzip - 10 };
}

function build(extra: Record<string, FileSize & { code?: string }> = {}): Build {
  const files = new Map<string, FileSize & { code?: string }>([
    ["assets/boot-abcdef12.js", { ...size(1024), code: "(function(){})()" }],
    ["assets/index-AAAAAA.js", { ...size(5 * 1024), code: ENTRY }],
    ["assets/vendor-BBBBBB.js", { ...size(80 * 1024), code: "export{a};" }],
    ["assets/side-HHHHHH.js", { ...size(1024), code: "" }],
    ["assets/index-CCCCCC.css", size(10 * 1024)],
    ["assets/SignIn-DDDDDD.js", { ...size(2 * 1024), code: `import{a}from"./shared-EEEEEE.js";` }],
    ["assets/shared-EEEEEE.js", { ...size(3 * 1024), code: `export{b as a}from"./vendor-BBBBBB.js";` }],
    ["assets/Layout-FFFFFF.js", { ...size(4 * 1024), code: "" }],
    ["assets/Layout-GGGGGG.css", size(2 * 1024)],
    ["assets/Gallery-IIIIII.js", { ...size(30 * 1024), code: "" }],
    ["assets/figtree-latin-wght-normal-XXXXXX.woff2", size(20 * 1024)],
    ...Object.entries(extra),
  ]);
  return { html: HTML, files };
}

describe("parseHtml", () => {
  it("finds scripts, module preloads, stylesheets and preloads under /assets only", () => {
    expect(parseHtml(HTML)).toEqual({
      scripts: ["assets/boot-abcdef12.js", "assets/index-AAAAAA.js"],
      modulePreloads: ["assets/vendor-BBBBBB.js"],
      styles: ["assets/index-CCCCCC.css"],
      preloads: ["assets/figtree-latin-wght-normal-XXXXXX.woff2"],
    });
  });
});

describe("staticImports", () => {
  it("reads named, side-effect and re-export imports, not dynamic ones", () => {
    expect(staticImports(ENTRY)).toEqual(["assets/vendor-BBBBBB.js", "assets/side-HHHHHH.js"]);
    expect(staticImports(`export{b as a}from"./vendor-BBBBBB.js";import * as x from './y-123456.js'`)).toEqual([
      "assets/vendor-BBBBBB.js",
      "assets/y-123456.js",
    ]);
  });
});

describe("dynamicDeps", () => {
  it("maps each dynamic import to Vite's preload list, the chunk itself first", () => {
    const deps = dynamicDeps(ENTRY);
    expect(deps.get("assets/SignIn-DDDDDD.js")).toEqual(["assets/SignIn-DDDDDD.js", "assets/shared-EEEEEE.js"]);
    expect(deps.get("assets/Layout-FFFFFF.js")).toEqual(["assets/Layout-FFFFFF.js", "assets/shared-EEEEEE.js", "assets/Layout-GGGGGG.css"]);
    expect(deps.get("assets/Gallery-IIIIII.js")).toEqual(["assets/Gallery-IIIIII.js"]);
  });
});

describe("closure and chunkFor", () => {
  it("follows static imports transitively, once per file", () => {
    const graph: Record<string, string[]> = { "a.js": ["b.js"], "b.js": ["c.js", "a.js", "d.css"], "c.js": [] };
    expect([...closure(["a.js"], (f) => graph[f] ?? [])].sort()).toEqual(["a.js", "b.js", "c.js", "d.css"]);
  });
  it("finds a module's chunk by name and hash, not by prefix", () => {
    const files = ["assets/SignInHelp-123456.js", "assets/SignIn-DDDDDD.js"];
    expect(chunkFor(files, "SignIn")).toBe("assets/SignIn-DDDDDD.js");
    expect(chunkFor(files, "Layout")).toBeUndefined();
  });
});

describe("reportRoutes", () => {
  it("sums the entry plus each route chunk with its deps", () => {
    const [signIn, overview] = reportRoutes(build(), [
      { name: "sign-in", chunks: ["SignIn"] },
      { name: "overview", chunks: ["Layout"], incrementalFrom: "sign-in" },
    ]);
    // boot 1 + index 5 + vendor 80 + side 1 + SignIn 2 + shared 3
    expect(signIn!.js.gzip).toBe(92 * 1024);
    expect(signIn!.css.gzip).toBe(10 * 1024);
    expect(signIn!.incremental.gzip).toBe(5 * 1024);
    // Layout JS 4 + its CSS 2; shared is already loaded by sign-in.
    expect(overview!.incremental.gzip).toBe(6 * 1024);
    expect(overview!.files).not.toContain("assets/Gallery-IIIIII.js");
  });
});

describe("checkBudget", () => {
  const budget: Budget = {
    routes: [{ name: "sign-in", chunks: ["SignIn"], maxJsKb: 100, maxCssKb: 12 }],
    maxTotalJsKb: 400,
    allowedFonts: [/-latin-wght-normal-/],
    forbiddenStrings: ["OFFICE-SCANNER"],
  };

  it("passes a build within budget", () => {
    expect(checkBudget(build(), budget)).toEqual([]);
  });

  it("names every limit that is broken", () => {
    const over = build({
      "assets/geist-mono-cyrillic-wght-normal-ZZZZZZ.woff2": size(13 * 1024),
      "assets/fixtures-JJJJJJ.js": { ...size(1024), code: 'const d="OFFICE-SCANNER"' },
    });
    over.files.set("assets/vendor-BBBBBB.js", { ...size(95 * 1024), code: "" });
    over.files.set("assets/index-CCCCCC.css", size(13 * 1024));
    const problems = checkBudget(over, {
      ...budget,
      routes: [...budget.routes, { name: "missing", chunks: ["Nope", "Optional?"] }],
      maxTotalJsKb: 100,
    });
    expect(problems).toEqual([
      "sign-in: initial JS 107.0 KB gzip > 100 KB",
      "sign-in: initial CSS 13.0 KB gzip > 12 KB",
      'missing: no chunk named "Nope" in the build',
      "all JS together 142.0 KB gzip > 100 KB",
      "font not in the allowed subsets: assets/geist-mono-cyrillic-wght-normal-ZZZZZZ.woff2",
      'assets/fixtures-JJJJJJ.js contains "OFFICE-SCANNER" (demo code in a live build)',
    ]);
  });
});
