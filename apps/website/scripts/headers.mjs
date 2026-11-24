// Writes dist/_headers after the build (plan §12): security headers, cache
// rules, and a Content-Security-Policy whose script hashes are computed from
// the inline scripts Astro actually emitted (a static site cannot use nonces).
// The CSP ships as Report-Only first, as the plan asks; switch the header
// name to Content-Security-Policy once it has run clean for a while.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
];
writeFileSync(join(dist, "_headers"), lines.join("\n"));
console.log(`_headers written (${hashes.size} inline script hash(es), ${production ? "production" : "preview: noindex"})`);
