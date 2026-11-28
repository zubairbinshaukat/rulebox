// Adds <link rel="modulepreload"> hints to the built HTML: the page's own module
// script (found at the end of <body>, it was discovered last) and, on the home
// page, the GSAP chunk (home-motion).
//
// src/scripts/site.ts fetches home-motion with import() once the page has
// loaded and the browser is idle. Left like that, the file is only discovered
// when the always-on script has run (HTML -> script -> chunk, a chain), and
// it starts late. A <link rel="modulepreload" fetchpriority="low"> in the
// HTML finds it at the first byte, fetches it behind everything the first
// screen needs, and the later import() finds it in the module map. Browsers
// and Lighthouse treat a preloaded file as non-critical, so it is no longer
// a link in the critical chain.
//
// The file name carries a content hash that only exists after the build, so
// this runs after `astro build` and edits the HTML. Pages are matched by the
// markup hooks home-motion.ts acts on (data-hero, data-steps, data-ink); the
// build fails if such a page exists and the chunk does not.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const chunk = readdirSync(`${dist}_astro`).find((f) => /^home-motion\.[\w-]+\.js$/.test(f));
// An attribute in markup, not in the inlined CSS (`[data-hero]` selectors).
const hook = /<[a-z][^>]*\sdata-(?:hero|steps|ink)[\s=>]/;
const link = (f) => `<link rel="modulepreload" href="/_astro/${f}" fetchpriority="low">`;

let n = 0;
const pages = readdirSync(dist, { recursive: true }).filter((f) => f.endsWith(".html"));
for (const name of pages) {
  let html = readFileSync(dist + name, "utf8");
  if (!html.includes("</head>")) continue; // redirect stubs and the like
  const links = [];
  // The page's module script(s): fetched at the top instead of after the whole body.
  for (const m of html.matchAll(/<script type="module" src="(\/_astro\/[^"]+\.js)"/g)) links.push(`<link rel="modulepreload" href="${m[1]}">`);
  if (hook.test(html)) {
    if (!chunk) {
      console.error(`preload-chunks: ${name} has motion hooks but dist/_astro has no home-motion chunk`);
      process.exit(1);
    }
    links.push(link(chunk));
  }
  const fresh = links.filter((l) => !html.includes(l));
  if (!fresh.length) continue;
  html = html.replace("</head>", `${fresh.join("")}</head>`);
  writeFileSync(dist + name, html);
  n++;
}
console.log(`preload-chunks: modulepreload hints added to ${n} page(s)`);

