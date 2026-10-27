// Key combination of the hidden admin exit (plan 4.10). A port of
// `rulebox_ipc::hotkey::parse` (crates/rulebox-ipc/src/hotkey.rs), which is
// the source of truth: the shared vectors in
// crates/rulebox-ipc/tests/vectors/hotkeys.json run against both (Rust:
// crates/rulebox-ipc/tests/hotkey_vectors.rs, TypeScript: convex/hotkey.test.ts).
//
// Grammar: tokens separated by `+`; whitespace around a token is ignored; case
// does not matter (ASCII only). Modifiers `Ctrl`, `Alt`, `Shift`, each at most
// once. Exactly one key: `A`-`Z`, `0`-`9` or `F1`-`F12`. At least one of Ctrl or
// Alt. So `Alt+Tab`, `Ctrl+Esc`, `Ctrl+Alt+Del` and Win combinations cannot be
// written.

export const DEFAULT_ADMIN_EXIT_HOTKEY = "Ctrl+Shift+F12";

/** The Rust `HotkeyError` variant names. */
export type HotkeyProblem =
  | "Empty"
  | "UnknownToken"
  | "NoKey"
  | "TwoKeys"
  | "DuplicateModifier"
  | "NeedsCtrlOrAlt";

export type HotkeyResult = { ok: true; canonical: string } | { ok: false; reason: HotkeyProblem };

/** Rust `char::is_whitespace` (Unicode White_Space); differs from JS `trim` on U+0085 and U+FEFF. */
function isRustWhitespace(cp: number): boolean {
  return (
    (cp >= 0x09 && cp <= 0x0d) ||
    cp === 0x20 ||
    cp === 0x85 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

/** Rust `str::trim`. */
function rustTrim(text: string): string {
  const cps = [...text];
  let start = 0;
  let end = cps.length;
  while (start < end && isRustWhitespace(cps[start]!.codePointAt(0)!)) start++;
  while (end > start && isRustWhitespace(cps[end - 1]!.codePointAt(0)!)) end--;
  return cps.slice(start, end).join("");
}

/** Rust `to_ascii_uppercase` / `to_ascii_lowercase`: only A-Z / a-z change. */
function asciiUpper(text: string): string {
  return text.replace(/[a-z]/g, (c) => c.toUpperCase());
}
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

type Key = { kind: "letter"; c: string } | { kind: "digit"; d: number } | { kind: "function"; n: number };

/** `parse_key`: one letter, one digit, or `F1`-`F12` (no sign, no leading zero). */
function parseKey(token: string): Key | null {
  const upper = asciiUpper(token);
  const chars = [...upper]; // Unicode scalar values, like Rust `chars()`
  if (chars.length === 0) return null;
  if (chars.length === 1) {
    const c = chars[0]!;
    if (/^[A-Z]$/.test(c)) return { kind: "letter", c };
    if (/^[0-9]$/.test(c)) return { kind: "digit", d: Number(c) };
    return null;
  }
  if (!upper.startsWith("F")) return null;
  const number = upper.slice(1);
  // Rust: `number.parse::<u8>()` then `n.to_string() == number` and 1..=12;
  // together exactly the plain decimal forms 1..12.
  if (!/^(?:[1-9]|1[0-2])$/.test(number)) return null;
  return { kind: "function", n: Number(number) };
}

export function parseHotkey(text: string): HotkeyResult {
  if (rustTrim(text) === "") return { ok: false, reason: "Empty" };
  const mods = { ctrl: false, alt: false, shift: false };
  let key: Key | null = null;
  for (const raw of text.split("+")) {
    const token = rustTrim(raw);
    const lower = asciiLower(token);
    if (lower === "ctrl" || lower === "alt" || lower === "shift") {
      if (mods[lower]) return { ok: false, reason: "DuplicateModifier" };
      mods[lower] = true;
      continue;
    }
    const parsed = parseKey(token);
    if (parsed === null) return { ok: false, reason: "UnknownToken" };
    if (key !== null) return { ok: false, reason: "TwoKeys" };
    key = parsed;
  }
  if (key === null) return { ok: false, reason: "NoKey" };
  if (!mods.ctrl && !mods.alt) return { ok: false, reason: "NeedsCtrlOrAlt" };
  const parts: string[] = [];
  if (mods.ctrl) parts.push("Ctrl");
  if (mods.alt) parts.push("Alt");
  if (mods.shift) parts.push("Shift");
  parts.push(key.kind === "letter" ? key.c : key.kind === "digit" ? String(key.d) : `F${key.n}`);
  return { ok: true, canonical: parts.join("+") };
}
