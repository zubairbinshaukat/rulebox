// The notes of a GitHub release as plain-text blocks (Settings -> Updates, plan `docs/plans/ui-pass/settings.md` 5.7). The server sends
// the notes as markdown source (<= 4,000 characters, no `\r`, no HTML comments); this turns them into headings, bullets and paragraphs of
// TEXT: markers are stripped (`#`, `**`, `__`, backticks, `[text](url)` -> text, images dropped, HTML tags dropped). The screen renders
// every block as React text nodes: no `dangerouslySetInnerHTML`, no links inside notes, no markdown library. Pure.

export type NotesBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "paragraph"; text: string };

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " };

/** A link destination `(...)`, with one level of parentheses inside (`(https://en.wikipedia.org/wiki/A_(b))`). */
const DEST = "\\((?:[^()]|\\([^()]*\\))*\\)";

/** One line of inline markdown as plain text. */
export function plainInline(raw: string): string {
  let t = raw;
  t = t.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  t = t.replace(/<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ""); // a script's own text is not notes either
  t = t.replace(/<(https?:\/\/[^>\s]+)>/gi, "$1"); // <https://example.com>: keep the address as text
  t = t.replace(/<\/?[A-Za-z][^>]*>/g, ""); // HTML tags: the tag goes, the text between stays
  t = t.replace(new RegExp(`!\\[[^\\]]*\\]${DEST}`, "g"), "").replace(/!\[[^\]]*\]\[[^\]]*\]/g, ""); // images
  t = t.replace(new RegExp(`\\[([^\\]]*)\\]${DEST}`, "g"), "$1").replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1"); // links: the text only
  t = t.replace(/`+([^`]*)`+/g, "$1");
  t = t.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1");
  t = t.replace(/(?<![A-Za-z0-9_])__(?=\S)(.+?)(?<=\S)__(?![A-Za-z0-9_])/g, "$1");
  t = t.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1");
  t = t.replace(/\*(?=\S)([^*]+?)(?<=\S)\*/g, "$1");
  t = t.replace(/(?<![A-Za-z0-9_])_(?=\S)([^_]+?)(?<=\S)_(?![A-Za-z0-9_])/g, "$1");
  t = t.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (e) => ENTITIES[e] ?? e);
  return t.replace(/\s+/g, " ").trim();
}

/**
 * The notes as blocks. A line starting with `#` is a heading, with `-` / `*` / `+` / `1.` a bullet (nesting is flattened, task boxes
 * dropped); a block quote marker, a code fence and a horizontal rule are dropped; other consecutive lines form one paragraph.
 * Blocks that are empty after stripping are dropped.
 */
export function notesBlocks(text: string): NotesBlock[] {
  const blocks: NotesBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    const t = plainInline(para.join(" "));
    if (t !== "") blocks.push({ kind: "paragraph", text: t });
    para = [];
  };
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.replace(/^\s{0,3}>\s?/, "").trimEnd();
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (/^\s*(```|~~~)/.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s*=+\s*$/.test(line)) {
      flush();
      continue;
    }
    if (/^\s*(?:#{1,6}|[-*+]|\d{1,3}[.)])\s*$/.test(line)) {
      flush(); // a marker with nothing after it
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      flush();
      const t = plainInline(heading[2]!);
      if (t !== "") blocks.push({ kind: "heading", level: Math.min(heading[1]!.length, 3) as 1 | 2 | 3, text: t });
      continue;
    }
    const bullet = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (bullet !== null) {
      flush();
      const t = plainInline(bullet[1]!);
      if (t !== "") blocks.push({ kind: "bullet", text: t });
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}
