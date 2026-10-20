import { describe, expect, it } from "vitest";

/**
 * The viewers are heavy (PDF.js, a Word converter, a spreadsheet reader). They
 * must be separate chunks that load the first time a file is opened, and the
 * desktop and taskbar bundle must not pull them in (PRD 22.4). This checks the
 * import graph of the source: static imports are followed, `import()` is not.
 */

// Every source file of the app, as text, keyed by its path from `src/`.
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }),
  ).map(([key, text]) => [key.replace(/^\/src\//, ""), text]),
);

const HEAVY = /pdfjs-dist|docx-preview|dompurify|^xlsx$/;

/** `a/b/c.ts` + `../d` -> `a/d` (no `fs`, so it runs anywhere). */
function resolveFrom(file: string, specifier: string): string[] {
  const parts = file.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  const base = parts.join("/");
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
}

/** The files a module reaches through static imports, and the packages it names. */
function staticGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    const code = SOURCES[file];
    if (code === undefined || files.has(file)) continue;
    files.add(file);
    for (const match of code.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)) {
      const specifier = (match[1] ?? match[2]) as string;
      if (specifier.startsWith(".")) {
        const local = resolveFrom(file, specifier).find((candidate) => SOURCES[candidate] !== undefined);
        if (local) queue.push(local);
      } else {
        packages.add(specifier);
      }
    }
  }
  return { files, packages };
}

describe("viewer chunks", () => {
  it("can be found in the source map at all (guards the test itself)", () => {
    expect(Object.keys(SOURCES)).toContain("shell/main.tsx");
    expect(Object.keys(SOURCES)).toContain("apps/viewers/ViewerHost.tsx");
    expect(Object.keys(SOURCES)).toContain("apps/viewers/PdfViewer.tsx");
  });

  it("are not part of the desktop and taskbar bundle", () => {
    const graph = staticGraph("shell/main.tsx");
    expect([...graph.files].filter((f) => f.startsWith("apps/"))).toEqual([]);
    for (const spec of graph.packages) {
      expect(spec, `the shell imports ${spec}`).not.toMatch(HEAVY);
    }
  });

  it("are not loaded with the built-in app window either, only when a file is opened", () => {
    const graph = staticGraph("apps/main.tsx");
    const files = [...graph.files];
    // The host that chooses a viewer is part of the window; no viewer is.
    expect(files).toContain("apps/viewers/ViewerHost.tsx");
    expect(files.filter((f) => /(Image|Pdf|Docx|Xlsx|Csv|Text)Viewer\.tsx$|MediaPlayer\.tsx$/.test(f))).toEqual([]);
    for (const spec of graph.packages) {
      expect(spec, `the app window imports ${spec}`).not.toMatch(HEAVY);
    }
  });

  it("each load through a dynamic import in the host", () => {
    const host = SOURCES["apps/viewers/ViewerHost.tsx"] ?? "";
    for (const file of ["ImageViewer", "MediaPlayer", "TextViewer", "CsvViewer", "PdfViewer", "DocxViewer", "XlsxViewer", "Unsupported"]) {
      expect(host).toContain(`lazy(() => import("./${file}"))`);
      expect(host, `${file} must not be a static import`).not.toMatch(new RegExp(`^import .* from "\\./${file}"`, "m"));
    }
  });

  it("keep each heavy library inside the one viewer that needs it", () => {
    const owners: Record<string, string> = {
      "pdfjs-dist": "apps/viewers/PdfViewer.tsx",
      "docx-preview": "apps/viewers/DocxViewer.tsx",
      dompurify: "apps/viewers/docxFrame.ts",
      xlsx: "apps/viewers/xlsxRead.ts",
    };
    for (const [library, owner] of Object.entries(owners)) {
      const pattern = new RegExp(`from "${library}[/"]`);
      const users = Object.entries(SOURCES)
        .filter(([file, code]) => pattern.test(code) && !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"))
        .map(([file]) => file);
      expect(users, `who imports ${library}`).toEqual([owner]);
    }
  });
});
