import type { NameRule } from "@rulebox/types";

const MAX_UNITS = 255;
export const INTERNAL_PREFIX = ".rulebox-";

const RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

function isSuperscriptDevice(stem: string): boolean {
  const upper = stem.toUpperCase();
  for (const prefix of ["COM", "LPT"]) {
    if (upper.startsWith(prefix)) {
      const rest = upper.slice(prefix.length);
      if (rest === "\u00B9" || rest === "\u00B2" || rest === "\u00B3") {
        return true;
      }
    }
  }
  return false;
}

/** Returns the user-facing message corresponding to a NameRule. */
export function nameRuleMessage(rule: NameRule): string {
  switch (rule) {
    case "empty":
      return "A name can't be empty.";
    case "dotName":
      return "A name can't be just dots.";
    case "badCharacter":
      return 'A name can\'t contain any of  < > : " / \\ | ? *';
    case "trailingDotOrSpace":
      return "A name can't end with a dot or a space.";
    case "reservedName":
      return "That name is reserved by Windows.";
    case "tooLong":
      return "That name is too long.";
    case "direction":
      return "A name can't contain text-direction characters.";
    case "internal":
      return "That name is reserved by Rulebox.";
  }
}

export interface ValidationResult {
  valid: boolean;
  rule?: NameRule;
  message?: string;
}

/** Check one path component for validity against NTFS and Rulebox rules. */
export function validateName(name: string): ValidationResult {
  if (name.length === 0) {
    return { valid: false, rule: "empty", message: nameRuleMessage("empty") };
  }
  if (name === "." || name === "..") {
    return { valid: false, rule: "dotName", message: nameRuleMessage("dotName") };
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    const ch = name[i];
    if (
      ch === "<" ||
      ch === ">" ||
      ch === ":" ||
      ch === '"' ||
      ch === "/" ||
      ch === "\\" ||
      ch === "|" ||
      ch === "?" ||
      ch === "*" ||
      code < 32 ||
      code === 127
    ) {
      return {
        valid: false,
        rule: "badCharacter",
        message: nameRuleMessage("badCharacter"),
      };
    }
    // Text direction overrides
    if (
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return {
        valid: false,
        rule: "direction",
        message: nameRuleMessage("direction"),
      };
    }
  }
  if (name.endsWith(".") || name.endsWith(" ")) {
    return {
      valid: false,
      rule: "trailingDotOrSpace",
      message: nameRuleMessage("trailingDotOrSpace"),
    };
  }
  // Count UTF-16 code units (same as JavaScript string length)
  if (name.length > MAX_UNITS) {
    return { valid: false, rule: "tooLong", message: nameRuleMessage("tooLong") };
  }
  // Stem check for reserved Windows device names
  const stem = (name.split(".")[0] ?? name).trimEnd();
  const upperStem = stem.toUpperCase();
  if (RESERVED.has(upperStem) || isSuperscriptDevice(stem)) {
    return {
      valid: false,
      rule: "reservedName",
      message: nameRuleMessage("reservedName"),
    };
  }
  if (name.startsWith(INTERNAL_PREFIX)) {
    return { valid: false, rule: "internal", message: nameRuleMessage("internal") };
  }
  return { valid: true };
}

/** Split a filename into its base name and extension. */
export function splitBaseAndExt(filename: string): { base: string; ext: string } {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0) {
    return { base: filename, ext: "" };
  }
  return {
    base: filename.slice(0, lastDot),
    ext: filename.slice(lastDot),
  };
}
