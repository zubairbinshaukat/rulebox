/**
 * The printer models a driver INF file delivers (UI pass, enrollment plan 4.5): the names the Windows print driver store will list
 * once the package is installed, which is what the "This driver adds" chips of the driver form fill into `provides`. Read in this
 * browser from the INF inside the zip the admin picked; nothing is uploaded. A lazy chunk with `zipInspect.ts`.
 *
 * What is read (the INF format, "Manufacturer" and "Models" sections):
 *   [Manufacturer]                     `%Vendor% = Models, NTamd64`  or  `"Vendor" = Models, NTamd64.10.0`
 *   [Models.NTamd64]                   `%Printer1% = Install, USBPRINT\...`  or  `"Name" = Install, ...`
 *   [Strings]                          `Printer1 = "HP LaserJet 4000"`
 * The model sections of a manufacturer are the named section and every decorated one (`Models.NTamd64`, `Models.NTamd64.10.0`); when
 * a 64-bit one exists the 32-bit and ARM ones are ignored (the agent installs on 64-bit Windows). `%token%` keys are resolved from the
 * `[Strings]` sections (case-insensitive; `[Strings.0409]`-style localized ones after the plain one); a model whose token cannot be
 * resolved is skipped. At most `MAX_MODELS` unique names (case-insensitive, file order), each 1 to 100 characters without control
 * characters (the server's `provides` rule).
 */

/** The server accepts at most this many provided names per driver (`MAX_PROVIDES`). */
export const MAX_MODELS = 10;
/** The server's longest provided name (`MAX_PROVIDED_NAME`). */
export const MAX_MODEL_NAME = 100;

/**
 * An INF file's bytes as text. Windows INF files are often UTF-16 (LE with a BOM) and sometimes UTF-8 with a BOM; anything else is
 * read as UTF-8 and, when that is not valid, as Windows-1252 (the "ANSI" INFs of older drivers).
 */
export function decodeInf(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("windows-1252").decode(body);
  }
}

/** Drops a `;` comment, but not a `;` inside double quotes. */
function stripComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ";" && !quoted) return line.slice(0, i);
  }
  return line;
}

/** Logical lines: comments dropped, a trailing `\` joins the next line. */
function logicalLines(text: string): string[] {
  const out: string[] = [];
  let pending = "";
  for (const raw of text.split(/\r\n|\n|\r/)) {
    let line = stripComment(raw).trim();
    if (line.endsWith("\\")) {
      pending += `${line.slice(0, -1).trim()} `;
      continue;
    }
    line = `${pending}${line}`.trim();
    pending = "";
    if (line !== "") out.push(line);
  }
  if (pending.trim() !== "") out.push(pending.trim());
  return out;
}

interface Entry {
  key: string;
  values: string[];
}

/** `key = v1, v2` split at the first `=` (not one inside quotes) and at commas outside quotes. Lines without `=` have no key. */
function entryOf(line: string): Entry | null {
  let quoted = false;
  let eq = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === "=" && !quoted) {
      eq = i;
      break;
    }
  }
  if (eq < 0) return null;
  const values: string[] = [];
  let current = "";
  quoted = false;
  for (const ch of line.slice(eq + 1)) {
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      values.push(current.trim());
      current = "";
    } else current += ch;
  }
  values.push(current.trim());
  return { key: line.slice(0, eq).trim(), values };
}

const unquote = (s: string): string => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s);

/** Section name (lower case) -> its logical lines, in file order. Lines before the first section header are ignored. */
function sectionsOf(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of logicalLines(text)) {
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) {
      const name = (header[1] ?? "").trim().toLowerCase();
      current = sections.get(name) ?? [];
      sections.set(name, current);
    } else if (current !== null) current.push(line);
  }
  return sections;
}

/** `%token%` replaced from the strings (`%%` is a percent sign). Null when a token is unknown. */
function resolve(text: string, strings: Map<string, string>): string | null {
  let missing = false;
  const out = text.replace(/%([^%]*)%/g, (_all, token: string) => {
    if (token === "") return "%";
    const value = strings.get(token.toLowerCase());
    if (value === undefined) missing = true;
    return value ?? "";
  });
  return missing ? null : out;
}

function stringsOf(sections: Map<string, string[]>): Map<string, string> {
  const strings = new Map<string, string>();
  const names = [...sections.keys()].filter((n) => n === "strings" || n.startsWith("strings.")).sort((a, b) => (a === "strings" ? -1 : b === "strings" ? 1 : 0));
  for (const name of names) {
    for (const line of sections.get(name) ?? []) {
      const e = entryOf(line);
      if (e === null || e.key === "") continue;
      // A string value is everything after the first `=` (commas are part of it), without its quotes.
      const raw = line.slice(line.indexOf("=") + 1).trim();
      const key = unquote(e.key).toLowerCase();
      if (!strings.has(key)) strings.set(key, unquote(raw).replace(/%%/g, "%"));
    }
  }
  return strings;
}

const NON_64_BIT = /^(ntx86|ntarm|ntia64)/;

/** The model sections of one manufacturer line: the named one and its decorations, 64-bit only when there is a 64-bit one. */
function modelSections(sections: Map<string, string[]>, base: string): string[][] {
  const lower = base.toLowerCase();
  const names = [...sections.keys()].filter((n) => n === lower || n.startsWith(`${lower}.`));
  const suffix = (n: string) => n.slice(lower.length + 1);
  const has64 = names.some((n) => n.startsWith(`${lower}.`) && suffix(n).startsWith("ntamd64"));
  return names.filter((n) => !(has64 && n.startsWith(`${lower}.`) && NON_64_BIT.test(suffix(n)))).map((n) => sections.get(n) ?? []);
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The model names of an INF file's text, at most `max` unique ones in file order (see the file's comment). Never throws: text that
 * is not an INF gives an empty list.
 */
export function parseInfModels(text: string, max = MAX_MODELS): string[] {
  const sections = sectionsOf(text);
  const strings = stringsOf(sections);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of sections.get("manufacturer") ?? []) {
    const e = entryOf(line);
    const base = e?.values[0] === undefined ? "" : unquote(e.values[0]);
    // `Manufacturer = "Name"` lines without a models section name have nothing to read.
    if (e === null || base === "") continue;
    for (const body of modelSections(sections, base)) {
      for (const modelLine of body) {
        const m = entryOf(modelLine);
        if (m === null || m.key === "") continue;
        const name = resolve(unquote(m.key), strings)?.trim();
        if (name === undefined || name === "" || Array.from(name).length > MAX_MODEL_NAME || CONTROL.test(name)) continue;
        const id = name.toLowerCase();
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(name);
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}
