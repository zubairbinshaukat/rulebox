// The key events of the admin-exit recorder as the text the grammar reads (pure, so the component file only exports components).
import * as v from "../../lib/validate";

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "OS"]);

/** The parts of a key event the recorder reads (a subset of `KeyboardEvent`, so tests can pass plain objects). */
export interface KeyParts {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * The combination a key event stands for, as the text the grammar reads (`Ctrl+Shift+F12`), or null for a lone modifier (the admin is
 * still holding the keys down). Letters and digits come from the physical key (`code`), so the layout and Shift do not change them.
 * The Windows key is written `Win`, which the grammar refuses with its own sentence.
 */
export function comboOfKeyEvent(e: KeyParts): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  let key: string;
  if (/^F\d{1,2}$/.test(e.key)) key = e.key;
  else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const parts: string[] = [];
  if (e.metaKey) parts.push("Win");
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** The keys of a combination as separate caps (`Ctrl`, `Shift`, `F12`): the canonical text when it is valid, else the text as typed. */
export function keysOf(text: string): string[] {
  const r = v.parseHotkey(text);
  const t = r.ok ? r.canonical : text;
  return t.split("+").map((k) => k.trim()).filter(Boolean);
}
