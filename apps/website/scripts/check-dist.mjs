// Build gates on the static output (plan §6.1, §7.2, §12). Fails the build on:
//   - placeholder strings ([EARLY-ACCESS RESULT, [RELEASE RESULT, [OWNER) in any page
//   - the operator console address anywhere in the output
//   - a page without exactly one <h1>, a <title>, a description or a canonical URL
//   - a duplicate <title>
//   - a page whose social card is missing
//   - any request to a font CDN, Google Fonts or an online icon API
//   - a number in src/data/numbers.ts with no source or a check older than 12 months
//   - logo preloader: overlay markup in any page's HTML (it is built by its inline
//     script, for real visitors only), or its script on any page but the home page
// Warns (does not fail) on long titles/descriptions and banned words (Story §4.5).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const errors = [];
const warnings = [];

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(dist);
const html = files.filter((f) => f.endsWith(".html"));
const text = files.filter((f) => /\.(html|xml|txt|js|css|json)$/.test(f));

const PLACEHOLDERS = ["[EARLY-ACCESS RESULT", "[RELEASE RESULT", "[OWNER"];
const FORBIDDEN_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "api.iconify.design", "cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com"];
const PRODUCTION = process.env.SITE_ENV === "production";
/* The logo preloader (components/Preloader.astro) ships, but only as an
   inline script on the home page that builds the overlay for real visitors.
   Crawlers and Lighthouse must get the page with no overlay in its HTML. */
const PRELOADER_KEY = "rb-preloaded";
const BANNED = ["revolutionary", "seamless", "next-generation", "military-grade", "leverage", "empower", "single pane of glass", "endpoint"];

for (const f of text) {
  const body = readFileSync(f, "utf8");
  const rel = relative(dist, f);
  for (const p of PLACEHOLDERS) if (body.includes(p)) errors.push(`${rel}: placeholder "${p}" must not ship`);
  if (/\badmin\.[a-z0-9-]+\.[a-z]/i.test(body)) errors.push(`${rel}: mentions an admin.<domain> address`);
  for (const h of FORBIDDEN_HOSTS) if (body.includes(h)) errors.push(`${rel}: loads from ${h} (offline-first rule)`);
  if (f.endsWith(".html")) {
    const outsideScripts = body.replace(/<script[\s\S]*?<\/script>/g, "");
    if (/class="rb-preloader/.test(outsideScripts)) errors.push(`${rel}: has preloader overlay markup in its HTML (it must be built by the script)`);
    if (body.includes(PRELOADER_KEY) && rel !== "index.html") errors.push(`${rel}: has the preloader script (home page only)`);
  }
}

const titles = new Map();
for (const f of html) {
  const rel = relative(dist, f);
  const body = readFileSync(f, "utf8");
  const h1 = (body.match(/<h1[\s>]/g) ?? []).length;
  if (h1 !== 1) errors.push(`${rel}: has ${h1} <h1> elements (needs exactly one)`);
  const title = body.match(/<title>([^<]*)<\/title>/)?.[1];
  if (!title) errors.push(`${rel}: no <title>`);
  else {
    if (titles.has(title)) errors.push(`${rel}: same <title> as ${titles.get(title)}`);
    titles.set(title, rel);
    if (title.length > 65) warnings.push(`${rel}: title is ${title.length} characters`);
  }
  const desc = body.match(/<meta name="description" content="([^"]*)"/)?.[1];
  if (!desc) errors.push(`${rel}: no meta description`);
  else if (desc.length < 70 || desc.length > 170) warnings.push(`${rel}: description is ${desc.length} characters`);
  if (!/<link rel="canonical" href="https?:\/\/[^"]+"/.test(body)) errors.push(`${rel}: no canonical URL`);
  const og = body.match(/<meta property="og:image" content="[^"]*\/og\/([^"]+\.png)"/)?.[1];
  if (og && !existsSync(join(dist, "og", og))) errors.push(`${rel}: social card og/${og} is missing (run: pnpm --filter @rulebox/website og)`);
  const visible = body.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").toLowerCase();
  for (const w of BANNED) if (visible.includes(w)) warnings.push(`${rel}: uses "${w}" (Story §4.5)`);
}

// Product screens (scripts/screens.mjs): every one a page uses must exist,
// and the image sitemap and JSON-LD may list product screens only, never
// stock photos (owner, 2026-11-25).
for (const f of html) {
  const body = readFileSync(f, "utf8");
  for (const m of body.matchAll(/\/screens\/([a-z0-9-]+\.(?:webp|avif))/g)) {
    if (!existsSync(join(dist, "screens", m[1]))) errors.push(`${relative(dist, f)}: product screen screens/${m[1]} is missing (run: pnpm --filter @rulebox/website screens)`);
  }
  for (const ld of body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    for (const u of ld[1].matchAll(/"url":"([^"]+\.(?:jpe?g|png|webp|avif))"/g)) {
      if (!/\/(screens|og)\/|icon-512\.png$/.test(u[1])) errors.push(`${relative(dist, f)}: JSON-LD lists an image that is not a product screen: ${u[1]}`);
    }
  }
}
for (const f of files.filter((x) => /sitemap-\d+\.xml$/.test(x))) {
  for (const m of readFileSync(f, "utf8").matchAll(/<image:loc>([^<]+)<\/image:loc>/g)) {
    if (!m[1].includes("/screens/")) errors.push(`${relative(dist, f)}: image sitemap lists ${m[1]} (product screens only)`);
  }
}

// Numbers: every entry needs a source URL and a recent check.
const numbersSrc = readFileSync(join(root, "src/data/numbers.ts"), "utf8");
const entries = numbersSrc.split(/\n  \{\n/).slice(1);
const yearAgo = Date.now() - 365 * 24 * 3600 * 1000;
for (const e of entries) {
  const id = e.match(/id: "([^"]+)"/)?.[1] ?? "?";
  if (!/sourceUrl:/.test(e)) errors.push(`numbers.ts ${id}: no source URL`);
  const checked = e.match(/checked: "(\d{4}-\d{2}-\d{2})"/)?.[1];
  if (!checked) errors.push(`numbers.ts ${id}: no checked date`);
  else if (Date.parse(checked) < yearAgo) errors.push(`numbers.ts ${id}: checked ${checked}, more than 12 months ago`);
}

for (const w of warnings) console.warn(`warn  ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`error ${e}`);
  console.error(`\ncheck-dist: ${errors.length} error(s) in ${html.length} pages`);
  process.exit(1);
}
console.log(`check-dist: ${html.length} pages passed (${warnings.length} warning(s))${PRODUCTION ? " (production)" : ""}`);
