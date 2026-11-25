// Writes dist/_headers after the build (plan §12): security headers, cache
// rules, and a Content-Security-Policy whose script hashes are computed from
// the inline scripts Astro actually emitted (a static site cannot use nonces).
// The CSP ships as Report-Only first, as the plan asks; switch the header
// name to Content-Security-Policy once it has run clean for a while.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const production = process.env.SITE_ENV === "production";

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".html") ? [p] : [];
  });
}

const hashes = new Set();
for (const f of walk(dist)) {
  const html = readFileSync(f, "utf8");
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)) {
    hashes.add(`'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  }
}

const csp = [
  "default-src 'self'",
  `script-src 'self' ${[...hashes].join(" ")} https://challenges.cloudflare.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://cloudflareinsights.com",
  "frame-src https://challenges.cloudflare.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const lines = [
  "/*",
  "  X-Content-Type-Options: nosniff",
  "  Referrer-Policy: strict-origin-when-cross-origin",
  "  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()",
  "  X-Frame-Options: DENY",
  "  Cross-Origin-Opener-Policy: same-origin",
  `  Content-Security-Policy-Report-Only: ${csp}`,
  // HSTS only on the real domain, after a week of clean running (plan §12).
  ...(production ? ["  Strict-Transport-Security: max-age=31536000"] : ["  X-Robots-Tag: noindex"]),
  "",
  "/_astro/*",
  "  Cache-Control: public, max-age=31536000, immutable",
  "",
  "/og/*",
  "  Cache-Control: public, max-age=86400",
  "",
  "/screens/*",
  "  Cache-Control: public, max-age=86400",
  "",
];

/*
 * Stock photos stay out of image search (owner, 2026-11-25). Only product
 * screens (/screens/*) and our own graphics should be indexed. Every photo
 * comes from a source file in src/assets/use-cases or src/assets/home (the
 * Pexels photos, see src/data/photos.ts); Astro emits each variant (sizes,
 * formats, nav thumbnails) as /_astro/<source basename>.<hash>.<ext>. One
 * rule per source basename covers all its variants and stays far below
 * Cloudflare's 100-rule limit (one rule per file would not: ~235 files).
 */
const PHOTO_DIRS = ["src/assets/use-cases", "src/assets/home"].map((d) => join(root, d));
const photosSrc = readFileSync(join(root, "src/data/photos.ts"), "utf8");
const photoBases = new Set([
  ...[...photosSrc.matchAll(/from "\.\.\/assets\/[^"]*?([^/"]+)\.(?:jpe?g|png|webp|avif)"/g)].map((m) => m[1]),
  ...PHOTO_DIRS.filter(existsSync).flatMap((d) => readdirSync(d).filter((n) => /\.(jpe?g|png|webp|avif)$/i.test(n)).map((n) => n.replace(/\.[^.]+$/, ""))),
]);
const astroFiles = existsSync(join(dist, "_astro")) ? readdirSync(join(dist, "_astro")) : [];
const noindex = [];
for (const base of [...photoBases].sort()) {
  const files = astroFiles.filter((n) => n.startsWith(`${base}.`));
  if (!files.length) continue;
  noindex.push({ base, files });
  lines.push(`/_astro/${base}.*`, "  X-Robots-Tag: noindex", "");
}
const RULE_LIMIT = 100;
const rules = lines.filter((l) => l.startsWith("/")).length;
if (rules > RULE_LIMIT) throw new Error(`_headers has ${rules} rules; Cloudflare allows ${RULE_LIMIT}`);

writeFileSync(join(dist, "_headers"), lines.join("\n"));
const photoFiles = noindex.reduce((n, x) => n + x.files.length, 0);
console.log(
  `_headers written (${hashes.size} inline script hash(es), ${production ? "production" : "preview: noindex"}; ` +
    `noindex on ${photoFiles} stock-photo file(s) from ${noindex.length} source(s), ${rules} rules)`,
);
if (process.argv.includes("--list")) for (const x of noindex) console.log(`  noindex /_astro/${x.base}.*  (${x.files.length} files)`);
