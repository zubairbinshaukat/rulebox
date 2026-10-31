import { base64Encode } from "./crypto";
import { fail } from "./errors";
import { MAX_ICON_BYTES, MAX_ICON_PIXELS, WEBMETA_MAX_MANIFEST_BYTES, WEBMETA_MAX_PAGE_BYTES } from "./limits";
import { fetchableUrl, fetchPublic, type PublicFetchOptions } from "./safeFetch";

// "Fetch details" for a web app (plan Step 10 item 5): read the page, find the
// web app manifest, take its name, theme colour and best icon. The scan is a
// handful of regular expressions over the first megabyte of HTML (no DOM
// parser: the page is untrusted and the scan has to be bounded and testable).
// Nothing is stored: the dashboard shows a preview and `apps:saveIcon` stores
// the icon only when the admin saves the app.

export type WebMeta = { name?: string; hue?: number; iconPng?: Uint8Array };

// ---------------------------------------------------------------- HTML scan

/** A tag cannot contain `<`: a scan that meets one starts over, so the work stays linear on hostile pages. */
const TAG = /<link\b[^<>]{0,1000}>/gi;
const MAX_LINK_TAGS = 100;

/** Attribute values of one tag: `rel="manifest" href='/m.json'` -> { rel, href }. Names lower-case. */
export function attributesOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+)))?/g;
  const inner = tag.replace(/^<link\b/i, "").replace(/\/?>$/, "");
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const name = m[1]!.toLowerCase();
    if (!(name in out)) out[name] = (m[2] ?? m[3] ?? m[4] ?? "").trim();
  }
  return out;
}

export type LinkTag = { rel: string[]; href: string; sizes: string; type: string };

/**
 * `html` without comments, `<script>` and `<style>` bodies (a `<link>` inside them is not a link). One
 * linear pass with `indexOf`: an unterminated block simply ends the text, and no pattern can backtrack.
 */
export function stripNoise(html: string): string {
  const lower = html.replace(/[A-Z]/g, (c) => c.toLowerCase()); // ASCII only: same length as `html`
  const blocks: [string, string][] = [["<!--", "-->"], ["<script", "</script"], ["<style", "</style"]];
  let out = "";
  let at = 0;
  for (;;) {
    let next = -1;
    let block: [string, string] = blocks[0]!;
    for (const b of blocks) {
      const i = lower.indexOf(b[0], at);
      if (i !== -1 && (next === -1 || i < next)) {
        next = i;
        block = b;
      }
    }
    if (next === -1) return out + html.slice(at);
    out += html.slice(at, next);
    const end = lower.indexOf(block[1], next + block[0].length);
    if (end === -1) return out;
    const close = lower.indexOf(">", end);
    if (close === -1) return out;
    at = close + 1;
  }
}

/** Every `<link>` with an href, in document order. */
export function linkTags(html: string): LinkTag[] {
  const out: LinkTag[] = [];
  for (const m of stripNoise(html).matchAll(TAG)) {
    if (out.length >= MAX_LINK_TAGS) break;
    const a = attributesOf(m[0]);
    if (a.href === undefined || a.href === "" || a.rel === undefined) continue;
    out.push({ rel: a.rel.toLowerCase().split(/\s+/).filter(Boolean), href: decodeEntities(a.href), sizes: a.sizes ?? "", type: (a.type ?? "").toLowerCase() });
  }
  return out;
}

/** `&amp;` in an href is the only entity that matters for addresses. */
function decodeEntities(text: string): string {
  return text.replace(/&amp;/gi, "&").replace(/&#x2f;/gi, "/").replace(/&#47;/g, "/");
}

export function manifestHref(html: string): string | null {
  return linkTags(html).find((l) => l.rel.includes("manifest"))?.href ?? null;
}

export function appleTouchIconHref(html: string): string | null {
  const icons = linkTags(html).filter((l) => l.rel.includes("apple-touch-icon") || l.rel.includes("apple-touch-icon-precomposed"));
  return pickBySize(icons.map((l) => ({ src: l.href, sizes: l.sizes, type: l.type })));
}

// ---------------------------------------------------------------- colour and icons

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` -> the HSL hue in whole degrees (0-359); null for anything else or a grey. */
export function hueFromColor(color: string | undefined): number | null {
  if (color === undefined) return null;
  let hex = color.trim().toLowerCase();
  if (!/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(hex)) return null;
  hex = hex.slice(1);
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return null; // grey: no hue to take
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return Math.round(((h * 60) % 360 + 360) % 360) % 360;
}

type IconCandidate = { src: string; sizes: string; type: string };

/** Largest declared side in a `sizes` string ("48x48 96x96", "any" = 0); null when none is declared. */
function declaredSide(sizes: string): number | null {
  const sides = [...sizes.toLowerCase().matchAll(/(\d+)x(\d+)/g)].map((m) => Math.min(Number(m[1]), Number(m[2])));
  return sides.length === 0 ? null : Math.max(...sides);
}

/** The icon whose declared size is closest to 128 and at least 48; an undeclared size ranks last. */
function pickBySize(icons: IconCandidate[]): string | null {
  const sized = icons
    .map((i) => ({ i, side: declaredSide(i.sizes) }))
    .filter((x) => x.side !== null && x.side >= 48)
    .sort((a, b) => Math.abs(a.side! - 128) - Math.abs(b.side! - 128) || a.side! - b.side!);
  if (sized[0] !== undefined) return sized[0].i.src;
  return icons.find((i) => declaredSide(i.sizes) === null)?.src ?? null;
}

type Manifest = { name?: string; short_name?: string; theme_color?: string; icons?: unknown };

function isPngIcon(i: IconCandidate): boolean {
  if (i.type !== "") return i.type === "image/png";
  return /\.png(\?|#|$)/i.test(i.src);
}

/** The manifest's PNG icons as candidates (SVG, WebP and ICO icons are skipped: the Staff App wants a PNG). */
export function manifestIcons(m: Manifest): IconCandidate[] {
  if (!Array.isArray(m.icons)) return [];
  const out: IconCandidate[] = [];
  for (const raw of m.icons as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.src !== "string" || r.src === "") continue;
    out.push({ src: r.src, sizes: typeof r.sizes === "string" ? r.sizes : "", type: typeof r.type === "string" ? r.type.toLowerCase() : "" });
  }
  return out.filter(isPngIcon);
}

export function pickManifestIcon(m: Manifest): string | null {
  return pickBySize(manifestIcons(m));
}

// ---------------------------------------------------------------- PNG

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height of a PNG (signature + IHDR checked), or null when `bytes` is not a PNG of 1..512 pixels a side and at most 32 KiB. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 33 || bytes.length > MAX_ICON_BYTES) return null;
  if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return null;
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1 || width > MAX_ICON_PIXELS || height > MAX_ICON_PIXELS) return null;
  return { width, height };
}

// ---------------------------------------------------------------- fetching

export type WebMetaFetch = Pick<PublicFetchOptions, "fetch">;

async function getIcon(href: string, base: URL, opts: WebMetaFetch): Promise<Uint8Array | null> {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (!fetchableUrl(url)) return null;
  const res = await fetchPublic(url.href, { ...opts, maxBytes: MAX_ICON_BYTES, accept: "image/png,*/*;q=0.5" });
  return res.ok && pngSize(res.bytes) !== null ? res.bytes : null;
}

function parseManifest(bytes: Uint8Array): Manifest | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Manifest) : null;
  } catch {
    return null;
  }
}

function cleanName(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  // A site-supplied name is shown in the dashboard and on the PCs: drop control characters (C0, DEL, C1) and
  // the invisible bidi / zero-width marks that can make text read in another order or hide characters.
  // eslint-disable-next-line no-control-regex
  const t = text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "").trim();
  return t.length >= 1 && t.length <= 60 ? t : undefined;
}

/**
 * Fetch the page at `pageUrl` (already checked with `webUrlProblem`) and
 * collect what the manifest offers. Throws `webmeta_failed` when the page
 * itself cannot be read; a missing or broken manifest or icon only leaves
 * those fields out (the Staff App then draws a letter tile).
 */
export async function fetchWebMeta(pageUrl: string, opts: WebMetaFetch = {}): Promise<WebMeta> {
  const page = await fetchPublic(pageUrl, { ...opts, maxBytes: WEBMETA_MAX_PAGE_BYTES, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" });
  if (!page.ok) fail("webmeta_failed", { detail: page.reason });
  const html = new TextDecoder().decode(page.bytes);
  const base = page.url;

  const out: WebMeta = {};
  const href = manifestHref(html);
  if (href !== null) {
    let manifestUrl: URL | null;
    try {
      manifestUrl = new URL(href, base);
    } catch {
      manifestUrl = null;
    }
    if (manifestUrl !== null && fetchableUrl(manifestUrl)) {
      const res = await fetchPublic(manifestUrl.href, { ...opts, maxBytes: WEBMETA_MAX_MANIFEST_BYTES, accept: "application/manifest+json,application/json;q=0.9,*/*;q=0.5" });
      const m = res.ok ? parseManifest(res.bytes) : null;
      if (m !== null) {
        const name = cleanName(m.name) ?? cleanName(m.short_name);
        if (name !== undefined) out.name = name;
        const hue = hueFromColor(typeof m.theme_color === "string" ? m.theme_color : undefined);
        if (hue !== null) out.hue = hue;
        const icon = pickManifestIcon(m);
        // Icon addresses in a manifest are relative to the manifest, not to the page.
        if (icon !== null) {
          const bytes = await getIcon(icon, manifestUrl, opts);
          if (bytes !== null) out.iconPng = bytes;
        }
      }
    }
  }
  if (out.iconPng === undefined) {
    const iconHref = appleTouchIconHref(html);
    const candidates = [iconHref, "/favicon.png"].filter((c): c is string => c !== null);
    for (const c of candidates) {
      const bytes = await getIcon(c, base, opts);
      if (bytes !== null) {
        out.iconPng = bytes;
        break;
      }
    }
  }
  return out;
}

/** A preview the dashboard can show without storing anything: `data:image/png;base64,...` (at most ~43 KB). */
export function iconDataUrl(png: Uint8Array): string {
  return `data:image/png;base64,${base64Encode(png)}`;
}
