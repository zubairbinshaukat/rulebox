// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * WCAG 2.2 AA contrast of the design tokens (PRD 11, Step 17). jsdom paints
 * nothing, so axe cannot check colours; this reads `tokens.css` itself and
 * computes the ratios for the pairs the Staff App really draws, in the light
 * theme, the dark theme (both the `[data-theme="dark"]` form and the
 * `prefers-color-scheme` "auto" form) and Lite mode. Frosted surfaces are
 * checked over the worst of the page and the two backdrop blobs.
 */

// The stylesheet itself, as text (Vite blanks a CSS import, even ?raw, in tests).
const css = readFileSync(new URL("../../../../packages/ui/src/tokens.css", import.meta.url), "utf8");

function block(start: RegExp): string {
  const found = start.exec(css);
  if (!found) throw new Error(`no block for ${start}`);
  let depth = 1;
  let i = css.indexOf("{", found.index) + 1;
  const from = i;
  while (depth > 0 && i < css.length) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    i++;
  }
  return css.slice(from, i - 1);
}

function vars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/--rb-([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function oklch(L: number, C: number, H: number, a = 1): Rgba {
  const h = (H * Math.PI) / 180;
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const enc = (x: number) => {
    const v = Math.min(1, Math.max(0, x));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return {
    r: enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: enc(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a,
  };
}

function colour(value: string, scope: Record<string, string>): Rgba {
  if (value === "white") return { r: 1, g: 1, b: 1, a: 1 };
  const m = /^oklch\(([^)]+)\)$/.exec(value);
  if (!m) throw new Error(`cannot read ${value}`);
  const inner = m[1]!.replace(/var\(--rb-([a-z0-9-]+)\)/g, (_, name: string) => scope[name]!);
  const [main, alpha] = inner.split("/").map((part) => part.trim());
  const [L, C, H] = main!.split(/\s+/).map(Number);
  return oklch(L!, C!, H!, alpha === undefined ? 1 : Number(alpha));
}

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ({ r, g, b }: Rgba) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const over = (top: Rgba, under: Rgba): Rgba => ({
  r: top.r * top.a + under.r * (1 - top.a),
  g: top.g * top.a + under.g * (1 - top.a),
  b: top.b * top.a + under.b * (1 - top.a),
  a: 1,
});
function ratio(fg: Rgba, bg: Rgba): number {
  const f = fg.a < 1 ? over(fg, bg) : fg;
  const [hi, lo] = [luminance(f), luminance(bg)].sort((a, b) => b - a);
  return (hi! + 0.05) / (lo! + 0.05);
}

const light = vars(block(/:root\s*\{/));
const dark = { ...light, ...vars(block(/\[data-theme="dark"\]\s*\{/)) };
const autoDark = { ...light, ...vars(block(/\[data-theme="auto"\]\s*\{/)) };

/** The surface and the backgrounds it can sit over (page, blob A, blob B, both). */
function backdrops(scope: Record<string, string>): Rgba[] {
  const page = colour(scope["bg"]!, scope);
  const a = over({ ...colour(scope["blob-a"]!, scope), a: 0.5 }, page);
  const b = over({ ...colour(scope["blob-b"]!, scope), a: 0.7 }, page);
  return [page, a, b, over({ ...colour(scope["blob-b"]!, scope), a: 0.7 }, a)];
}

/** The worst ratio of `fg` on `bg`; a `glass:` background is checked over every backdrop (Lite has none). */
function worst(scope: Record<string, string>, fg: string, bg: string, lite: boolean): number {
  const text = colour(scope[fg]!, scope);
  if (bg.startsWith("glass:")) {
    const glass = colour(scope[lite ? "surface" : bg.slice(6)]!, scope);
    return Math.min(...backdrops(scope).map((under) => ratio(text, lite ? glass : over(glass, under))));
  }
  return ratio(text, over(colour(scope[bg]!, scope), colour(scope["bg"]!, scope)));
}

/** [foreground token, background, needed ratio, what it is]. 4.5 for text, 3 for icons, borders and focus rings. */
const PAIRS: ReadonlyArray<readonly [string, string, number, string]> = [
  ["ink", "bg", 4.5, "body text"],
  ["ink", "surface", 4.5, "text on cards, dialogs, the Files window"],
  ["ink", "paper", 4.5, "title bar"],
  ["ink", "hover", 4.5, "chips, hovered rows"],
  ["ink", "glass:surface-glass", 4.5, "sign-in panel, tiles"],
  ["ink", "glass:glass-bar", 4.5, "taskbar"],
  ["ink", "glass:glass-strong", 4.5, "popups"],
  ["muted", "bg", 4.5, "secondary text on the page"],
  ["muted", "surface", 4.5, "secondary text on surfaces"],
  ["muted", "paper", 4.5, "unfocused title"],
  ["muted", "hover", 4.5, "segmented control, neutral pill"],
  ["muted", "accent-soft", 4.5, "secondary text on a selected row"],
  ["muted", "glass:surface-glass", 4.5, "tile description"],
  ["muted", "glass:glass-bar", 4.5, "clock date"],
  ["muted", "glass:glass-strong", 4.5, "popup hints"],
  ["faint", "surface", 4.5, "placeholder"],
  ["faint", "bg", 4.5, "hints on the page"],
  ["faint", "hover", 4.5, "hints on hover"],
  ["faint", "glass:glass-strong", 4.5, "hints in popups"],
  ["accent-text", "accent-soft", 4.5, "pill, active nav, avatar"],
  ["accent-text", "surface", 4.5, "link on a surface"],
  ["accent-text", "bg", 4.5, "link on the page"],
  ["accent-text", "glass:surface-glass", 4.5, "link on the sign-in panel"],
  ["on-ink", "ink", 4.5, "primary button, count badge"],
  ["danger-text", "surface", 4.5, "error text"],
  ["danger-text", "danger-soft", 4.5, "error banner"],
  ["danger-text", "bg", 4.5, "error on the page"],
  ["danger-text", "glass:surface-glass", 4.5, "sign-in error"],
  ["success-text", "success-soft", 4.5, "success pill"],
  ["success-text", "hover", 4.5, "battery on the chip"],
  ["warning-text", "warning-soft", 4.5, "warning banner"],
  ["warning-text", "hover", 4.5, "warning icon on the chip"],
  ["warning-text", "glass:surface-glass", 4.5, "warning on the sign-in panel"],
  ["focus", "surface", 3, "focus ring on surfaces"],
  ["focus", "bg", 3, "focus ring on the page"],
  ["focus", "accent-soft", 3, "focus ring on a selected row"],
  ["focus", "hover", 3, "focus ring on a hovered row"],
  ["focus", "glass:surface-glass", 3, "focus ring on tiles"],
  ["focus", "glass:glass-bar", 3, "focus ring on the taskbar"],
  ["focus", "glass:glass-strong", 3, "focus ring in popups"],
  ["line-strong", "surface", 3, "input edge on a surface"],
  ["line-strong", "bg", 3, "input edge on the page"],
  ["line-strong", "glass:glass-strong", 3, "input edge in popups"],
  ["line-strong", "glass:surface-glass", 3, "input edge on the sign-in panel"],
  ["muted", "glass:glass-bar", 3, "open-window mark on the taskbar"],
  ["warning-text", "surface", 3, "hung-window dot, warning meter"],
  ["warning-text", "hover", 3, "warning progress fill on its track"],
  ["danger", "hover", 3, "danger progress fill on its track"],
  ["accent", "hover", 3, "progress fill on its track"],
  ["danger", "surface", 3, "danger icon"],
  ["success", "hover", 3, "bell dot on the chip"],
  ["white", "danger", 3, "close button on hover"],
  ["white", "accent", 3, "switch thumb on the on-track"],
];

const THEMES: ReadonlyArray<readonly [string, Record<string, string>, boolean]> = [
  ["light", light, false],
  ["dark", dark, false],
  ["auto (follows the system, dark)", autoDark, false],
  ["light + Lite", light, true],
  ["dark + Lite", dark, true],
];

describe("design token contrast (WCAG AA)", () => {
  for (const [name, scope, lite] of THEMES) {
    it(`${name}: every text, icon, border and focus pair passes`, () => {
      const failures: string[] = [];
      for (const [fg, bg, need, what] of PAIRS) {
        const scoped = fg === "white" ? { ...scope, white: "white" } : scope;
        const got = worst(scoped, fg, bg, lite);
        if (got < need) failures.push(`${fg} on ${bg} (${what}): ${got.toFixed(2)}:1, needs ${need}:1`);
      }
      expect(failures).toEqual([]);
    });
  }

  it("a white glyph keeps 3:1 across the middle of the tile gradient at every app hue", () => {
    for (const [name, scope] of [["light", light] as const, ["dark", dark] as const]) {
      const mid = (Number(scope["art-top-l"]) + Number(scope["art-bottom-l"])) / 2;
      for (let hue = 0; hue < 360; hue += 10) {
        const art = oklch(mid, Number(scope["art-c"]), hue);
        expect(ratio({ r: 1, g: 1, b: 1, a: 1 }, art), `${name} hue ${hue}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("the system-follows-dark theme has exactly the dark theme's values", () => {
    const darkOnly = vars(block(/\[data-theme="dark"\]\s*\{/));
    const autoOnly = vars(block(/\[data-theme="auto"\]\s*\{/));
    expect(autoOnly).toEqual(darkOnly);
  });
});
