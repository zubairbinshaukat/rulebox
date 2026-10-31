// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** What `bar.css` must say: the strip, the address field, the states, and the motion rules. */

const style = readFileSync(new URL("../../src-tauri/src/webapp/bar.css", import.meta.url), "utf8");

const rule = (selector: string): string => {
  const at = style.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return style.slice(at, style.indexOf("}", at) + 1);
};

describe("the strip", () => {
  it("is 44 px high with a solid token background, over a transparent page", () => {
    expect(rule(".bar")).toContain("height: 44px");
    expect(rule(".bar")).toContain("background: var(--rb-surface)");
    expect(rule("html, body")).toContain("background: transparent");
  });

  it("is not selectable, so the address cannot be picked up or dragged out", () => {
    expect(rule("html, body")).toMatch(/user-select:\s*none/);
  });
});

describe("the address field", () => {
  it("shows the host in bold and the rest in the muted token", () => {
    expect(rule(".host")).toContain("font-weight: 600");
    expect(rule(".rest")).toContain("color: var(--rb-muted)");
  });

  it("shows the lock only for a secure site and the warning only for an insecure one", () => {
    expect(style).toContain('.address[data-kind="site"][data-secure="true"] .g-lock { display: block');
    expect(style).toContain('.address[data-kind="site"][data-secure="false"] .g-warn { display: block');
    expect(style).toContain(".sec .g { display: none; }");
  });

  it("cuts a long address with an ellipsis, and the rest shrinks before the host", () => {
    for (const part of [rule(".rest"), rule(".host")]) {
      expect(part).toContain("text-overflow: ellipsis");
      expect(part).toContain("overflow: hidden");
      expect(part).toContain("white-space: nowrap");
      expect(part).toContain("min-width: 0");
    }
    expect(rule(".rest")).toContain("flex: 0 100 auto");
    expect(rule(".host")).toContain("flex: 0 1 auto");
    expect(rule(".address")).toContain("min-width: 0");
  });
});

describe("states and motion", () => {
  it("has hover, a visible focus ring from the tokens, and a disabled state", () => {
    expect(style).toContain("button:hover { background: var(--rb-hover); }");
    expect(style).toContain("button:focus-visible { outline: 2px solid var(--rb-focus)");
    expect(style).toContain("button:disabled");
    expect(style).toContain(".actions[hidden] { display: none; }");
  });

  it("only ever animates opacity and transform, and is calm in Lite mode and reduced motion", () => {
    const transitions = [...style.matchAll(/transition:([^;}]+)/g)].map((match) => match[1]!.trim());
    expect(transitions.length).toBeGreaterThan(0);
    for (const transition of transitions) {
      if (transition === "none !important") continue;
      for (const part of transition.split(",")) expect(part.trim(), transition).toMatch(/^(opacity|transform) /);
    }
    expect(style).toContain("@media (prefers-reduced-motion: reduce)");
    expect(style).toContain(".calm * { transition: none !important; }");
    expect(style).not.toMatch(/animation|@keyframes|backdrop-filter|@import|url\(/);
  });
});
