import { describe, expect, it } from "vitest";

/**
 * The exit page must work when everything else is broken, so its entry may not
 * reach the shared store, GSAP, or any icon (Section 7.11). Checked on the
 * source: static imports are followed.
 */
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob<string>("/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true })).map(
    ([key, text]) => [key.replace(/^\/src\//, ""), text],
  ),
);

function graph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    const code = SOURCES[file];
    if (code === undefined || files.has(file)) continue;
    files.add(file);
    for (const match of code.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)) {
      const spec = (match[1] ?? match[2]) as string;
      if (!spec.startsWith(".")) {
        packages.add(spec);
        continue;
      }
      const parts = file.split("/").slice(0, -1);
      for (const part of spec.split("/")) {
        if (part === "..") parts.pop();
        else if (part !== ".") parts.push(part);
      }
      const base = parts.join("/");
      const hit = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((c) => SOURCES[c] !== undefined);
      if (hit) queue.push(hit);
    }
  }
  return { files, packages };
}

describe("the administrator-exit page", () => {
  const exit = graph("exit/main.tsx");

  it("is found by the test at all", () => {
    expect(exit.files.has("exit/AdminExit.tsx")).toBe(true);
  });

  it("does not import the store, GSAP, icons or the motion helpers", () => {
    expect([...exit.files].filter((f) => /lib\/(store|motion)\./.test(f))).toEqual([]);
    for (const spec of exit.packages) {
      expect(spec, `the exit page imports ${spec}`).not.toMatch(/gsap|~icons|zustand/);
    }
    for (const file of exit.files) {
      expect(SOURCES[file] ?? "", file).not.toMatch(/~icons\//);
    }
  });

  it("does not reach the desktop, the taskbar or the viewers", () => {
    expect([...exit.files].filter((f) => /^(shell|apps)\//.test(f))).toEqual([]);
  });
});

describe("every Rulebox page listens for the exit key", () => {
  it.each(["shell/main.tsx", "apps/main.tsx", "exit/main.tsx"])("%s installs the listener", (entry) => {
    expect(SOURCES[entry] ?? "").toContain("installExitKey();");
  });
});
