// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The popups (Start, account, quick settings, switcher, confirm, monitor,
 * preview) are separate transparent windows. Any alpha in their panel shows the
 * windows beneath unblurred, which made the text hard to read. Their panels
 * must be opaque, with no backdrop-filter. The taskbar pills (.rb-dock) stay glass.
 */
const components = readFileSync(new URL("../../../../../packages/ui/src/components.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../../../../../packages/ui/src/tokens.css", import.meta.url), "utf8");
const popupRoot = readFileSync(new URL("./PopupRoot.tsx", import.meta.url), "utf8");

/** Declarations of every top-level rule whose selector list contains exactly `selector`. */
function declarations(css: string, selector: string): string[] {
  const out: string[] = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = rule.exec(stripped); m; m = rule.exec(stripped)) {
    const selectors = m[1]!.split(",").map((s) => s.trim());
    if (selectors.includes(selector)) {
      out.push(m[2]!);
    }
  }
  return out;
}

function property(blocks: string[], name: string): string | undefined {
  let value: string | undefined;
  for (const block of blocks) {
    const found = new RegExp(`(?:^|;|\\s)${name}\\s*:\\s*([^;]+)`, "g");
    for (let m = found.exec(block); m; m = found.exec(block)) {
      value = m[1]!.trim();
    }
  }
  return value;
}

/** True when the colour (a token, a literal or a color-mix) carries alpha. */
function hasAlpha(value: string): boolean {
  return /\/\s*[\d.]+\s*\)/.test(value) || /rgba|hsla/i.test(value) || /transparent/.test(value);
}

const POPUP_ROOTS = [".rb-surface--popover", ".rb-monitor", ".rb-switcher"];

describe("popup surfaces are solid", () => {
  it("renders the popup page inside a popover Surface", () => {
    expect(popupRoot).toMatch(/<Surface\s+kind="popover"/);
  });

  it("the popover Surface paints an opaque token with no backdrop-filter", () => {
    const blocks = declarations(components, ".rb-surface--popover");
    expect(blocks.length).toBeGreaterThan(0);
    expect(property(blocks, "background")).toBe("var(--rb-surface)");
    expect(property(blocks, "backdrop-filter")).toBe("none");
    expect(property(blocks, "-webkit-backdrop-filter")).toBe("none");
  });

  it("keeps the border, shadow and a 12-26 px radius", () => {
    const blocks = declarations(components, ".rb-surface--popover");
    expect(property(blocks, "border-color")).toBeDefined();
    expect(property(blocks, "box-shadow")).toBe("var(--rb-shadow-popover)");
    expect(property(blocks, "border-radius")).toBe("var(--rb-r-xl)");
    const radius = Number(/--rb-r-xl:\s*(\d+)px/.exec(tokens)?.[1]);
    expect(radius).toBeGreaterThanOrEqual(12);
    expect(radius).toBeLessThanOrEqual(26);
  });

  it.each(POPUP_ROOTS)("%s has no alpha background and no backdrop-filter", (selector) => {
    const blocks = declarations(components, selector);
    expect(blocks.length).toBeGreaterThan(0);
    const background = property(blocks, "background") ?? "";
    expect(hasAlpha(background)).toBe(false);
    expect(background).not.toMatch(/glass/);
    const filter = property(blocks, "backdrop-filter");
    expect(filter === undefined || filter === "none").toBe(true);
  });

  it("--rb-surface is opaque in light, dark and system-dark", () => {
    const values = [...tokens.matchAll(/--rb-surface:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(values.length).toBeGreaterThanOrEqual(3);
    for (const value of values) {
      expect(hasAlpha(value)).toBe(false);
    }
  });
});
