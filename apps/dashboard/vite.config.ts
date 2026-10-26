import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import Icons from "unplugin-icons/vite";
import { loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

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

export default defineConfig(({ mode }) => {
  const demo = loadEnv(mode, process.cwd(), "VITE_").VITE_DEMO === "1";
  return {
  // Solar icons are compiled into the bundle at build time (Decision 16/17: no runtime fetching).
  plugins: [react(), Icons({ compiler: "jsx", jsx: "react" }), cspMeta()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Build-time switch so a live build drops the demo fixtures entirely.
    __DEMO__: JSON.stringify(demo),
  },
  resolve: {
    alias: {
      "@convex": fileURLToPath(new URL("../../convex", import.meta.url)),
      // The data implementation (src/data/README.md): fixtures only in demo builds.
      "@rulebox/data-impl": fileURLToPath(new URL(demo ? "./src/data/demo/hooks.ts" : "./src/data/live/hooks.ts", import.meta.url)),
    },
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        // React, the router and the Convex client change rarely: one cacheable chunk.
        manualChunks(id) {
          if (/node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/.test(id)) return "vendor-react";
          if (/node_modules[\\/]gsap[\\/]|node_modules[\\/]@gsap[\\/]/.test(id)) return "vendor-gsap";
          return undefined;
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
  };
});
