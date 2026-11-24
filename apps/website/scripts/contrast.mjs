// WCAG 2.2 contrast check for the colour tokens (part of the build).
//
//   node scripts/contrast.mjs            check, print failures, exit 1 on any
//   node scripts/contrast.mjs --table    also print every pair with its ratio
//   node scripts/contrast.mjs --hex      print the paper background as hex (theme-color)
//
// The site is light-only with dark accent sections and one palette, Deep
// teal (final, owner 2026-11-25). Reads src/styles/tokens.css: the raw
// --lt-*/--dk-* values plus the paper block and the .section-dark scope that
// map them onto the tokens components use. Every pair is checked on paper
// and inside the dark scope. Colours with alpha are composited over the
// pair's background, translucent backgrounds over the scope's --bg.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tokensCss = readFileSync(join(root, "src/styles/tokens.css"), "utf8");
const args = process.argv.slice(2);
const errors = [];

/* ---------- Parse the raw palette values (--lt-x / --dk-x) ---------- */
const base = {};
for (const m of tokensCss.matchAll(/:root\s*\{([^}]*)\}/g)) {
  for (const d of m[1].matchAll(/--((?:lt|dk)-[\w-]+)\s*:\s*([^;]+);/g)) base[d[1]] = d[2].trim();
}
if (!Object.keys(base).length) {
  console.error("contrast: no palette values (--lt-*/--dk-*) found in tokens.css");
  process.exit(1);
}

/* ---------- The two scopes: paper and dark sections ---------- */
function mapping(re, label) {
  const m = tokensCss.match(re);
  if (!m) {
    errors.push(`tokens.css: could not find the ${label} block`);
    return {};
  }
  return Object.fromEntries([...m[1].matchAll(/--([\w-]+):\s*var\(--((?:lt|dk)-[\w-]+)\)/g)].map((d) => [d[1], d[2]]));
}
const scopes = {
  paper: mapping(/\/\* -+ Paper[^*]*\*\/\s*:root\s*\{([^}]*)\}/, "paper"),
  dark: mapping(/\.section-dark,\s*\.night\s*\{([^}]*)\}/, ".section-dark"),
};
{
  const a = Object.keys(scopes.paper).sort().join();
  const b = Object.keys(scopes.dark).sort().join();
  if (a !== b) errors.push("tokens.css: the paper block and the .section-dark scope map different tokens");
  const used = new Set([...Object.values(scopes.paper), ...Object.values(scopes.dark)]);
  for (const k of Object.keys(base)) if (!used.has(k)) errors.push(`tokens.css: --${k} is never mapped to a token`);
  for (const k of used) if (!(k in base)) errors.push(`tokens.css: a scope maps to --${k}, which the palette does not define`);
}

/* ---------- Colour maths (OKLCH -> sRGB, WCAG luminance) ---------- */
function parseColour(str) {
  const m = str.match(/^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    const L = m[1].endsWith("%") ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { L, rgb: oklchToSrgb(L, parseFloat(m[2]), parseFloat(m[3])), a };
  }
  throw new Error(`unsupported colour ${str}`);
}
function oklchToSrgb(L, C, H) {
  const hr = (H * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  // Gamma-encode and clip to the sRGB gamut, as a browser would show it.
  return lin.map((c) => {
    const x = Math.min(1, Math.max(0, c));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  });
}
const over = (top, under) => top.rgb.map((c, i) => c * top.a + under[i] * (1 - top.a));
function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const toHex = (rgb) => "#" + rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");

/* ---------- The pairs that occur on the site ----------
   [foreground, background, minimum, what]. 4.5 = text, 3 = large text or
   UI (control edges, focus ring, icons that carry meaning). A minimum
   below 1 is an OKLCH lightness difference, not a WCAG ratio. */
const T = 4.5;
const U = 3;
const pairs = [];
const add = (fgs, bgs, min, what) => {
  for (const f of [].concat(fgs)) for (const b of [].concat(bgs)) pairs.push([f, b, min, what]);
};
const paper = ["bg", "bg-stone", "surface", "surface-2"];
add(["ink", "ink-2", "muted"], paper, T, "text");
add("faint", ["bg", "bg-stone", "surface"], T, "faint text (breadcrumbs, credits, placeholders)");
add("faint", "surface-2", U, "faint large text on wells");
add("primary-text", ["bg", "bg-stone", "surface"], T, "primary text");
add("primary-text", "primary-soft", T, "primary text on its tint");
add("ink", "primary-soft", T, "selected text");
add("accent-text", [...paper, "accent-soft"], T, "links");
add("on-primary", ["primary", "primary-hover", "primary-pressed"], T, "button label");
add("primary", ["bg", "surface"], U, "button and checked control edge");
add("control", ["bg", "surface"], U, "form control edge");
add("focus", ["bg", "bg-stone", "surface"], U, "focus ring");
add(["on-night", "on-night-muted"], ["night", "night-2"], T, "text on dark cards");
add(["on-night-ok", "on-night-deny"], "night", T, "terminal states on dark cards");
add("night", "bg", 0.035, "dark card stands apart from its surroundings (OKLCH dL)");
for (const c of ["blue", "violet", "coral", "sun", "mint"]) {
  add(`c-${c}-ink`, [`c-${c}-soft`, "bg", "surface", "surface-2"], T, `${c} text`);
  add(`c-${c}-on`, `c-${c}`, T, `ink on solid ${c}`);
}
add(["c-blue", "c-violet", "c-coral", "c-mint", "c-sun"], "night", U, "vivid icons on dark cards");
add("success-ink", "success-soft", T, "success message");
add("warning-ink", "warning-soft", T, "warning message");
add("danger-ink", ["danger-soft", "bg", "surface"], T, "danger and field errors");
add(["success", "warning", "danger"], ["bg", "surface"], U, "status icons, dots, invalid control edge");
add(["chip-glass-ink", "c-blue-ink", "c-violet-ink", "c-coral-ink", "c-sun-ink", "c-mint-ink"], "chip-glass", T, "label pill over photos");
add("mock-ink", ["mock-bg", "mock-window", "mock-paper", "mock-chip"], T, "drawn desktop text");
add("mock-muted", ["mock-bg", "mock-window", "mock-paper"], T, "drawn desktop secondary text");
add("mock-go-ink", "mock-go", T, "drawn desktop sign-in button and badge count");
add("mock-accent-text", "mock-accent-soft", T, "drawn desktop avatar initials");
add("mock-warn-ink", "mock-warn-soft", T, "drawn desktop Offline pill");
add("mock-good", "mock-chip", T, "drawn desktop battery level");
add("mock-control", ["mock-window", "mock-bg"], U, "drawn desktop field edge");
add("mock-accent", ["mock-bg", "mock-window"], U, "drawn desktop running dot, active bar, focus ring");
for (const g of ["calendar", "card", "video", "folder", "chat", "badge", "chart", "document"]) add("mock-glyph", `mock-art-${g}-b`, U, `white glyph on the ${g} tile art`);
add("ink", "glass", T, "text on glass (nav)");

/* ---------- Run ---------- */
const rows = [];
{
  const raw = base;
  for (const [scope, map] of Object.entries(scopes)) {
    const col = (token) => {
      if (!(token in map)) throw new Error(`token --${token} is not mapped`);
      return parseColour(raw[map[token]]);
    };
    const solid = (token, under) => {
      const c = col(token);
      return c.a >= 1 ? c.rgb : over(c, under);
    };
    const page = col("bg").rgb;
    for (const [f, b, min, what] of pairs) {
      let ratio;
      try {
        if (min < 1) ratio = Math.abs(col(f).L - col(b).L);
        else {
          const under = b.startsWith("mock-") && b !== "mock-bg" ? solid("mock-bg", page) : page;
          const bgRgb = solid(b, under);
          const fg = over(col(f), bgRgb);
          const l1 = luminance(fg);
          const l2 = luminance(bgRgb);
          ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        }
      } catch (e) {
        errors.push(`${scope}: ${e.message}`);
        continue;
      }
      rows.push({ scope, fg: f, bg: b, ratio, min, ok: ratio + 1e-9 >= min, what });
    }
  }
}

if (args.includes("--hex")) {
  console.log(`paper bg ${toHex(parseColour(base[scopes.paper.bg]).rgb)}  dark-section bg ${toHex(parseColour(base[scopes.dark.bg]).rgb)}`);
}
const fmt = (r) => (r.min < 1 ? r.ratio.toFixed(3) : r.ratio.toFixed(2));
if (args.includes("--table")) {
  for (const r of rows) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.scope.padEnd(5)} ${fmt(r).padStart(6)} (min ${r.min})  ${r.fg} on ${r.bg}  [${r.what}]`);
}
for (const r of rows.filter((x) => !x.ok)) errors.push(`${r.scope}: ${r.fg} on ${r.bg} is ${fmt(r)}, needs ${r.min} (${r.what})`);

const lowest = (scope) => Math.min(...rows.filter((r) => r.scope === scope && r.min === T).map((r) => r.ratio)).toFixed(2);
const summary = `Deep teal: ${rows.filter((r) => r.ok).length}/${rows.length} pass (lowest text pair: paper ${lowest("paper")}:1, dark section ${lowest("dark")}:1)`;

if (errors.length) {
  for (const e of errors) console.error(`error ${e}`);
  console.error(`\ncontrast: ${errors.length} problem(s)\n  ${summary}`);
  process.exit(1);
}
console.log(`contrast: ${rows.length} pairs (paper + dark sections) pass WCAG 2.2 AA\n  ${summary}`);
