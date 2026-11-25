// Publishes the sitemap at /sitemap.xml (owner choice, 2026-11-25).
// @astrojs/sitemap writes sitemap-index.xml + sitemap-0.xml. While the site
// fits in one chunk, /sitemap.xml is a copy of sitemap-0.xml (a full urlset
// with the image entries). If a second chunk ever appears, /sitemap.xml
// becomes a copy of the index instead, which search engines also accept.
import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const src = existsSync(`${dist}sitemap-1.xml`) ? "sitemap-index.xml" : "sitemap-0.xml";
if (!existsSync(dist + src)) {
  console.error(`sitemap-alias: dist/${src} not found`);
  process.exit(1);
}
copyFileSync(dist + src, `${dist}sitemap.xml`);
console.log(`sitemap-alias: dist/sitemap.xml <- ${src}`);
