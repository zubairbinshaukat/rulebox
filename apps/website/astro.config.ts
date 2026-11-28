import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import Icons from "unplugin-icons/vite";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SITE_URL } from "./src/config";
import { codeFrame } from "./src/lib/code-frame";

const dist = fileURLToPath(new URL("./dist/", import.meta.url));

function pageHtml(page: string): string | undefined {
  const path = new URL(page).pathname.replace(/\/$/, "") || "/index";
  const file = `${dist}${path.slice(1)}.html`;
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

/** Leave pages out of the sitemap when the page itself asks not to be indexed
 *  (drafts, 404). Base.astro marks them with <meta name="rb-noindex">. */
function indexable(page: string): boolean {
  const html = pageHtml(page);
  return !html || !html.includes('name="rb-noindex"');
}

/** Image sitemap: every product screenshot (/screens/*, rendered by
 *  scripts/screens.mjs) that the page really shows in an <img>. Only
 *  /screens/ files qualify, so stock photos (Pexels) never appear here. */
function withImages<T extends { url: string }>(item: T): T {
  const html = pageHtml(item.url);
  if (!html) return item;
  const urls = new Set<string>();
  for (const m of html.matchAll(/<img\b[^>]*\bsrc="(\/screens\/[^"]+)"/g)) urls.add(`${SITE_URL}${m[1]}`);
  if (!urls.size) return item;
  return { ...item, img: [...urls].map((url) => ({ url })) };
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
    // Inline every page's CSS (about 120 kB raw, 25 kB compressed per page). 'auto' kept four
    // stylesheets (global, layout, page, DesktopMock) as separate files, and each is
    // render-blocking: Lighthouse measured about 500 ms (mobile) before first paint, and the
    // web fonts could only be found after the global sheet arrived. Cost: pages no longer
    // share a cached stylesheet; the HTML (compressed by Cloudflare) carries it instead.
    inlineStylesheets: "always",
  },
  prefetch: false,
  markdown: {
    // Colours come from tokens (--code-* in tokens.css, mapped in global.css).
    shikiConfig: { theme: "css-variables", transformers: [codeFrame()] },
  },
  integrations: [mdx(), sitemap({ filter: indexable, serialize: withImages })],
  vite: {
    // Solar icons only (Decision 16), compiled into the page at build time.
    plugins: [Icons({ compiler: "astro", scale: 1 })],
    server: { fs: { allow: ["../.."] } },
  },
});
