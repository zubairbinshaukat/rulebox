// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The web app bar lives in a WebView2 page of its own where `tokens.css` is not loaded, so `bar.css`
 * carries its own copy of the few tokens it needs. This keeps the copy equal to the design tokens
 * (light and dark), keeps the icons equal to Solar, and checks WCAG 2.2 AA for what the bar draws.
 */

const barCss = readFileSync(new URL("../../src-tauri/src/webapp/bar.css", import.meta.url), "utf8");
const script = readFileSync(new URL("../../src-tauri/src/webapp/bar.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../../../../packages/ui/src/tokens.css", import.meta.url), "utf8");

function block(text: string, start: RegExp): string {
  const found = start.exec(text);
  if (!found) throw new Error(`no block for ${start}`);
  let depth = 1;
  let i = text.indexOf("{", found.index) + 1;
  const from = i;
  while (depth > 0 && i < text.length) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
    i++;
  }
  return text.slice(from, i - 1);
}

function vars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/--rb-([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

const tokenLight = vars(block(css, /:root\s*\{/));
const tokenDark = { ...tokenLight, ...vars(block(css, /\[data-theme="dark"\]\s*\{/)) };
const barLight = vars(block(barCss, /:root\s*\{/));
const barDark = { ...barLight, ...vars(block(barCss, /\[data-theme="dark"\]\s*\{/)) };

describe("bar.css colours", () => {
  for (const [name, bar, tokens] of [
    ["light", barLight, tokenLight],
    ["dark", barDark, tokenDark],
  ] as const) {
    it(`are the ${name} design tokens, value for value`, () => {
      expect(Object.keys(bar).length).toBeGreaterThan(8);
      for (const [key, value] of Object.entries(bar)) {
        expect(value, `--rb-${key}`).toBe(tokens[key]);
      }
    });
  }

  it("uses only tokens it declares", () => {
    const used = new Set([...barCss.matchAll(/var\(--rb-([a-z0-9-]+)\)/g)].map((m) => m[1]!));
    for (const key of used) expect(barLight[key], `--rb-${key} is declared`).toBeTruthy();
  });
});

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function oklch(value: string): Rgb {
  const m = /^oklch\(([^)/]+)\)$/.exec(value);
  if (!m) throw new Error(`cannot read ${value}`);
  const [L, C, H] = m[1]!.trim().split(/\s+/).map(Number) as [number, number, number];
  const h = (H * Math.PI) / 180;
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const mm = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const enc = (x: number) => {
    const v = Math.min(1, Math.max(0, x));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return {
    r: enc(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s),
    g: enc(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s),
    b: enc(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s),
  };
}

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ({ r, g, b }: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(oklch(a)), luminance(oklch(b))].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("bar.css contrast", () => {
  for (const [name, t] of [
    ["light", barLight],
    ["dark", barDark],
  ] as const) {
    it(`text, icons, the lock, the keyboard ring and the menu edge reach AA on the ${name} surfaces`, () => {
      const c = (key: string) => t[key]!;
      expect(ratio(c("ink"), c("surface")), "icons on the bar").toBeGreaterThanOrEqual(4.5);
      expect(ratio(c("ink"), c("hover")), "icon on a hovered button").toBeGreaterThanOrEqual(4.5);
      expect(ratio(c("ink"), c("bg")), "host on the address field").toBeGreaterThanOrEqual(4.5);
      expect(ratio(c("muted"), c("bg")), "rest of the address").toBeGreaterThanOrEqual(4.5);
      expect(ratio(c("success-text"), c("bg")), "lock").toBeGreaterThanOrEqual(4.5);
      expect(ratio(c("danger-text"), c("bg")), "warning icon").toBeGreaterThanOrEqual(4.5);
      expect(ratio(c("focus"), c("surface")), "focus ring").toBeGreaterThanOrEqual(3);
      expect(ratio(c("focus"), c("bg")), "focus ring on the field").toBeGreaterThanOrEqual(3);
      expect(ratio(c("line-strong"), c("surface")), "edge of the menu").toBeGreaterThanOrEqual(3);
    });
  }
});

/** `name: '<svg body>'` entries of the ICONS table in the script. */
function drawnIcons(): Record<string, string> {
  const table = /var ICONS = \{([\s\S]*?)\n {2}\};/.exec(script);
  if (!table) throw new Error("no ICONS in bar.js");
  const out: Record<string, string> = {};
  for (const m of table[1]!.matchAll(/^ {4}(\w+): '(.*)',$/gm)) out[m[1]!] = m[2]!;
  return out;
}

describe("bar.js icons", () => {
  const solar = JSON.parse(
    readFileSync(new URL("../../node_modules/@iconify-json/solar/icons.json", import.meta.url), "utf8"),
  ) as { width: number; height: number; icons: Record<string, { body: string }> };
  const SOLAR_OF: Record<string, string> = {
    back: "arrow-left-linear",
    forward: "arrow-right-linear",
    reload: "refresh-linear",
    stop: "close-linear",
    lock: "lock-keyhole-linear",
    warn: "danger-triangle-linear",
    app: "window-frame-linear",
    blocked: "shield-warning-linear",
    more: "menu-dots-linear",
    info: "info-circle-linear",
    star: "star-linear",
  };

  it("are drawn on Solar's 24 x 24 grid with its 1.5 stroke", () => {
    expect(solar.width).toBe(24);
    expect(solar.height).toBe(24);
    expect(script).toContain('svg.setAttribute("viewBox", "0 0 24 24")');
  });

  for (const [name, icon] of Object.entries(SOLAR_OF)) {
    it(`${name} is Solar ${icon}, exactly`, () => {
      const body = solar.icons[icon]?.body ?? "";
      expect(body, `${icon} exists`).not.toBe("");
      expect(body).toContain('stroke-width="1.5"');
      expect(drawnIcons()[name]).toBe(body);
    });
  }

  it("are only Solar -linear icons, and the credit is kept", () => {
    expect(Object.keys(drawnIcons()).sort()).toEqual(Object.keys(SOLAR_OF).sort());
    for (const icon of Object.values(SOLAR_OF)) expect(icon).toMatch(/-linear$/);
    const notices = readFileSync(new URL("../../../../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
    expect(notices).toMatch(/solar/i);
  });

  it("include every key the Rust action registry may name", () => {
    const rust = readFileSync(new URL("../../src-tauri/src/webapp/bar.rs", import.meta.url), "utf8");
    const keys = /ICON_KEYS: &\[&str\] = &\[([^\]]*)\]/.exec(rust)?.[1] ?? "";
    const named = [...keys.matchAll(/"(\w+)"/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    for (const key of named) expect(drawnIcons()[key], key).toBeTruthy();
  });
});
