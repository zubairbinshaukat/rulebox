import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import Icons from "unplugin-icons/vite";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SITE_URL } from "./src/config";

const dist = fileURLToPath(new URL("./dist/", import.meta.url));

/** Leave pages out of the sitemap when the page itself asks not to be indexed
 *  (drafts, 404). Base.astro marks them with <meta name="rb-noindex">. */
function indexable(page: string): boolean {
  const path = new URL(page).pathname.replace(/\/$/, "") || "/index";
  const file = `${dist}${path.slice(1)}.html`;
  if (!existsSync(file)) return true;
  return !readFileSync(file, "utf8").includes('name="rb-noindex"');
}

// Static output only (plan Q1 a). The /api/* form handler is a separate
// Worker script in ./worker, served next to these files by one Worker.
export default defineConfig({
  site: SITE_URL,
  output: "static",
  trailingSlash: "never",
  build: {
    // /pricing -> pricing.html; Cloudflare static assets serve it at /pricing.
    format: "file",
    inlineStylesheets: "auto",
  },
  prefetch: false,
  integrations: [mdx(), sitemap({ filter: indexable })],
  vite: {
    // Solar icons only (Decision 16), compiled into the page at build time.
    plugins: [Icons({ compiler: "astro", scale: 1 })],
    server: { fs: { allow: ["../.."] } },
  },
});
