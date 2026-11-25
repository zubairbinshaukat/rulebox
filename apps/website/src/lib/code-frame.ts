/*
 * Shiki transformer: wraps every highlighted code block (docs, blog) in a
 * frame with a header bar: the language label and a copy button. Built at
 * compile time, so the label shows without JavaScript; the button is wired
 * by scripts/prose.ts and hidden when JavaScript is off (html:not(.js)).
 * Icons are Solar (Decision 16), read from the bundled icon set.
 */
import { createRequire } from "node:module";

/** The slice of Shiki's transformer API used here (shiki is not a direct dependency). */
interface ShikiTransformer {
  name: string;
  root(this: { options: { lang?: string } }, root: { children: { type: string; tagName?: string }[] }): void;
}

type El = { type: "element"; tagName: string; properties: Record<string, unknown>; children: Node[] };
type Node = El | { type: "text"; value: string };

const solar = createRequire(import.meta.url)("@iconify-json/solar/icons.json") as {
  icons: Record<string, { body: string }>;
};

/** Tiny parser for Solar's simple SVG bodies (g/path, attributes, self-closing). */
function svgChildren(body: string): Node[] {
  const root: El = { type: "element", tagName: "root", properties: {}, children: [] };
  const stack: El[] = [root];
  for (const m of body.matchAll(/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g)) {
    const [, closing, tag = "g", attrs = "", selfClose] = m;
    if (closing) {
      stack.pop();
      continue;
    }
    const properties: Record<string, string> = {};
    for (const a of attrs.matchAll(/([a-zA-Z-:]+)="([^"]*)"/g)) if (a[1]) properties[a[1]] = a[2] ?? "";
    const el: El = { type: "element", tagName: tag, properties, children: [] };
    (stack[stack.length - 1] ?? root).children.push(el);
    if (!selfClose) stack.push(el);
  }
  return root.children;
}

function icon(name: string, cls: string): El {
  const body = solar.icons[name]?.body;
  if (!body) throw new Error(`Solar icon ${name} not found`);
  return {
    type: "element",
    tagName: "svg",
    properties: { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", width: "16", height: "16", class: `icon ${cls}`, "aria-hidden": "true" },
    children: svgChildren(body),
  };
}

const LABELS: Record<string, string> = {
  powershell: "PowerShell",
  ps1: "PowerShell",
  pwsh: "PowerShell",
  bash: "Bash",
  sh: "Shell",
  shell: "Shell",
  cmd: "Command Prompt",
  bat: "Batch",
  xml: "XML",
  json: "JSON",
  jsonc: "JSON",
  ts: "TypeScript",
  typescript: "TypeScript",
  js: "JavaScript",
  javascript: "JavaScript",
  toml: "TOML",
  yaml: "YAML",
  yml: "YAML",
  html: "HTML",
  css: "CSS",
  rust: "Rust",
  rs: "Rust",
  text: "Text",
  txt: "Text",
  plaintext: "Text",
};

const el = (tagName: string, properties: Record<string, unknown>, children: Node[]): El => ({ type: "element", tagName, properties, children });

export function codeFrame(): ShikiTransformer {
  return {
    name: "rulebox:code-frame",
    root(root) {
      const pre = root.children.find((n) => n.type === "element" && n.tagName === "pre");
      if (!pre) return;
      const lang = (this.options.lang ?? "text").toLowerCase();
      const label = LABELS[lang] ?? lang.toUpperCase();
      const frame = el("div", { class: "code", "data-lang": lang }, [
        el("div", { class: "code-bar" }, [
          el("span", { class: "code-lang" }, [{ type: "text", value: label }]),
          el("button", { type: "button", class: "code-copy", "aria-label": `Copy ${label} code` }, [
            icon("copy-linear", "i-copy"),
            icon("check-read-linear", "i-done"),
            el("span", { class: "code-copy-text" }, [{ type: "text", value: "Copy" }]),
          ]),
        ]),
        pre as unknown as El,
      ]);
      root.children = [frame as never];
    },
  };
}
