import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import Icons from "unplugin-icons/vite";
import { loadEnv, type Plugin, type Rollup } from "vite";
import { defineConfig } from "vitest/config";
import { SESSIONLESS_PATHS, ROUTE_SCREENS, SCREEN_FILES, type ScreenName } from "./src/app/route-table";

type OutputChunk = Rollup.OutputChunk;

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

/**
 * Step 4 #11: the Content-Security-Policy as a <meta> in the built page (so
 * `vite preview` is covered too). Build only: the dev server needs an inline
 * script for React Fast Refresh. `frame-ancestors` is not allowed in a meta;
 * it lives in public/_headers and vercel.json.
 */
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.convex.cloud; font-src 'self'; connect-src 'self' https://*.convex.cloud wss://*.convex.cloud https://*.convex.site; base-uri 'self'; form-action 'self'; object-src 'none'";

function cspMeta(): Plugin {
  return {
    name: "rulebox-csp-meta",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    },
  };
}

/**
 * Inlines the generated logo (public/favicon.svg, from `pnpm gen:brand`) into
 * index.html's loading placeholder, so the first paint needs no extra request.
 */
function placeholderLogo(): Plugin {
  return {
    name: "rulebox-placeholder-logo",
    transformIndexHtml(html) {
      const svg = readFileSync(fileURLToPath(new URL("./public/favicon.svg", import.meta.url)), "utf8")
        .trim()
        .replace("<svg ", '<svg width="56" height="56" ');
      return html.replace("<!--rb-logo-->", svg);
    },
  };
}

/**
 * The boot script (src/boot/boot.js) as a hashed asset, with the route map
 * filled in: for each URL of `route-table.ts`, the screen chunks the entry does
 * not already preload. Also preloads the Figtree Latin font, which the page
 * would otherwise discover only after the scripts render text.
 */
function bootScript(): Plugin {
  let root = process.cwd();
  let base = "/";
  const DEV_TAG = '<script src="/src/boot/boot.js"></script>';
  return {
    name: "rulebox-boot",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      root = config.root;
      base = config.base;
    },
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((c): c is OutputChunk => c.type === "chunk");
      const byFile = new Map(chunks.map((c) => [c.fileName, c]));
      const closure = (start: string[]) => {
        const seen = new Set<string>();
        const todo = [...start];
        while (todo.length) {
          const f = todo.pop()!;
          if (seen.has(f)) continue;
          seen.add(f);
          todo.push(...(byFile.get(f)?.imports ?? []));
        }
        return seen;
      };
      const preloaded = closure(chunks.filter((c) => c.isEntry).map((c) => c.fileName));
      const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
      const chunkOf = (name: ScreenName) => {
        const want = norm(resolvePath(root, SCREEN_FILES[name]));
        const chunk = chunks.find((c) => c.facadeModuleId && norm(c.facadeModuleId) === want);
        if (!chunk) throw new Error(`rulebox-boot: no chunk for ${SCREEN_FILES[name]}`);
        return chunk.fileName;
      };
      const files: string[] = [];
      const routes: Record<string, number[]> = {};
      for (const [key, screens] of Object.entries(ROUTE_SCREENS)) {
        const needed = closure(screens.map(chunkOf));
        routes[key] = [...needed]
          .filter((f) => !preloaded.has(f))
          .map((f) => {
            const url = base + f;
            if (!files.includes(url)) files.push(url);
            return files.indexOf(url);
          });
      }
      const map = JSON.stringify({ f: files, r: routes, p: SESSIONLESS_PATHS });
      const source = readFileSync(fileURLToPath(new URL("./src/boot/boot.js", import.meta.url)), "utf8");
      if (!source.includes("/*RB_ROUTES*/ null")) throw new Error("rulebox-boot: placeholder missing in boot.js");
      const code = source
        .replace("/*RB_ROUTES*/ null", map)
        .replace(/^\s*\/\/.*\n/gm, "");
      const fileName = `assets/boot-${createHash("sha256").update(code).digest("base64url").slice(0, 8)}.js`;
      this.emitFile({ type: "asset", fileName, source: code });

      const html = bundle["index.html"];
      if (!html || html.type !== "asset" || typeof html.source !== "string" || !html.source.includes(DEV_TAG)) {
        throw new Error("rulebox-boot: index.html has no boot script tag");
      }
      const font = Object.keys(bundle).find((f) => /figtree-latin-wght-normal-[\w-]+\.woff2$/.test(f));
      const fontLink = font ? `\n    <link rel="preload" href="${base}${font}" as="font" type="font/woff2" crossorigin />` : "";
      html.source = html.source.replace(DEV_TAG, `<script src="${base}${fileName}"></script>${fontLink}`);
    },
  };
}

export default defineConfig(({ mode, command }) => {
  const demo = loadEnv(mode, process.cwd(), "VITE_").VITE_DEMO === "1";
  // Test hook for the end-to-end run (plan 4.16): a shorter idle lock, only on
  // the dev server (`vite`, never `vite build`), from RULEBOX_TEST_IDLE_MS in
  // the shell. Production builds get the literal 0, and the minifier drops the
  // branch that reads it.
  const testIdle = command === "serve" ? Number(loadEnv(mode, process.cwd(), "RULEBOX_TEST_").RULEBOX_TEST_IDLE_MS ?? 0) : 0;
  return {
  // Solar icons are compiled into the bundle at build time (Decision 16/17: no runtime fetching).
  plugins: [react(), Icons({ compiler: "jsx", jsx: "react" }), cspMeta(), placeholderLogo(), bootScript()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Build-time switch so a live build drops the demo fixtures entirely.
    __DEMO__: JSON.stringify(demo),
    __STEPUP_TEST_IDLE_MS__: JSON.stringify(Number.isFinite(testIdle) && testIdle > 0 ? Math.floor(testIdle) : 0),
  },
  resolve: {
    alias: {
      "@convex": fileURLToPath(new URL("../../convex", import.meta.url)),
      // The data implementation (src/data/README.md): fixtures only in demo builds.
      "@rulebox/data-impl": fileURLToPath(new URL(demo ? "./src/data/demo/hooks.ts" : "./src/data/live/hooks.ts", import.meta.url)),
      "@rulebox/stepup-impl": fileURLToPath(new URL(demo ? "./src/data/stepup/demo.ts" : "./src/data/stepup/live.ts", import.meta.url)),
    },
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        // React with the router, and the Convex client, change rarely: each its own
        // long-cached chunk, so an app update re-downloads only the app's code.
        codeSplitting: {
          groups: [
            { name: "vendor-react", test: /node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/, priority: 2 },
            { name: "vendor-convex", test: /node_modules[\\/](convex|@convex-dev[\\/]auth|is-network-error)[\\/]/, priority: 1 },
            // The small shared helpers (lib, data seam, @rulebox/ui) as one chunk instead of
            // a dozen tiny ones: fewer requests on the first load, nearly all needed anyway.
            // (Scripts only: the stylesheets stay one file, in their import order.)
            // `lib/stepup/` and `data/stepup/` stay out: step-up code is loaded only
            // by the signed-in shell and the Security tab, never by sign-in.
            { name: "core", test: /([\\/]apps[\\/]dashboard[\\/]src[\\/](lib|data)|[\\/]packages[\\/]ui[\\/]src)[\\/](?!stepup[\\/]).*\.tsx?$/ },
          ],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    css: false,
  },
  };
});
