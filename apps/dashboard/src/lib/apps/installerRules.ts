// Installer details (Phase 6 Step 13): the inline checks of the form and the pre-fill rule. They mirror convex/lib/appRules.ts
// (`normalizeInstallerDetails`) and convex/lib/installerDetect.ts; the server decides. Not part of `validate.ts` (which the first load
// carries): only the App screen and the demo use them.
import type { DetectedTech, WizardTech } from "../../data/types";

export const MAX_ANSWER_FILE_BYTES = 256 * 1024;
export const MIN_TIMEOUT_MIN = 5;
export const MAX_TIMEOUT_MIN = 120;
export const MAX_SUCCESS_CODES = 16;
export const MAX_PUBLISHER = 200;

/** What the technology picker offers, in the order of the plan's table. */
export const TECH_ORDER: WizardTech[] = ["nsis", "inno", "burn", "installshield_msi", "installshield_script", "advanced_installer"];

/** `0, 3010` -> `[0, 3010]`; `null` when something is not a whole number (or there are too many). Empty text is `[0]`. */
export function parseExitCodes(text: string): number[] | null {
  const parts = text.split(/[\s,;]+/).filter((p) => p !== "");
  if (parts.length > MAX_SUCCESS_CODES) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^-?\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < -2_147_483_648 || n > 2_147_483_647) return null;
    out.push(n);
  }
  return [...new Set([0, ...out])].sort((a, b) => a - b);
}

export const formatExitCodes = (codes: number[]): string => (codes.length === 0 ? "0" : [...new Set(codes)].join(", "));

/** True when the text is not a whole number of minutes from 5 to 120 (empty = the default of 30, fine). */
export function timeoutProblem(text: string): boolean {
  const t = text.trim();
  if (t === "") return false;
  return !/^\d+$/.test(t) || Number(t) < MIN_TIMEOUT_MIN || Number(t) > MAX_TIMEOUT_MIN;
}

/** `null` when fine; `"https"` for an address that is not https; `"iss"` when its path does not end in `.iss`. */
export function answerUrlProblem(value: string): "https" | "iss" | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname === "" || url.username !== "" || url.password !== "") return "https";
    return url.pathname.toLowerCase().endsWith(".iss") ? null : "iss";
  } catch {
    return "https";
  }
}

/** Every `{` or `}` must start exactly `{AnswerFile}` or `{LogFile}` (`check_silent_args` in `rulebox-policy`). */
export function silentArgTokenProblem(list: string[]): boolean {
  for (const arg of list) {
    let rest = arg;
    for (let at = rest.search(/[{}]/); at !== -1; at = rest.search(/[{}]/)) {
      const tail = rest.slice(at);
      const token = ["{AnswerFile}", "{LogFile}"].find((t) => tail.startsWith(t));
      if (token === undefined) return true;
      rest = tail.slice(token.length);
    }
  }
  return false;
}

/** The stored technologies; a plain EXE and an MSI are "no technology". */
export const storedTech = (t: DetectedTech): WizardTech | "" => (t === "exe" || t === "msi" ? "" : t);
