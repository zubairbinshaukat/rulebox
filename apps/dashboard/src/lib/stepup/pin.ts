/**
 * The action PIN rules of `convex/lib/stepUp.ts` (`actionPinProblem`),
 * mirrored so the form can answer before a round trip. The server checks
 * again; keep the two in step (`stepup.test.ts` runs the same cases).
 *
 * Lives under `lib/stepup/` (not `lib/validate.ts`) so it never reaches the
 * first load: only the step-up screens import it.
 */
import { strings } from "../strings";

const COMMON_PINS = new Set([
  "123456", "654321", "123123", "121212", "112233", "111222", "123321", "102030", "101010",
  "696969", "159753", "147258", "258369", "963852", "741852", "000000", "999999", "135790",
  "246810", "202020", "131313", "007007", "520520", "147852", "789456", "456789",
]);

export type PinProblem = "6 to 12 digits" | "repeated pattern" | "sequence" | "too common";

/** 6-12 ASCII digits; no repeated pattern, no up/down run (with wrap), not a common PIN. */
export function actionPinProblem(pin: string): PinProblem | null {
  if (!/^[0-9]{6,12}$/.test(pin)) return "6 to 12 digits";
  for (let p = 1; p <= pin.length / 2; p++) {
    if (pin.length % p === 0 && pin.slice(0, p).repeat(pin.length / p) === pin) return "repeated pattern";
  }
  const d = [...pin].map(Number);
  const steps = d.slice(1).map((x, i) => (x - d[i]! + 10) % 10);
  if (steps.every((s) => s === 1) || steps.every((s) => s === 9)) return "sequence";
  if (COMMON_PINS.has(pin)) return "too common";
  return null;
}

/** The sentence for a new PIN, or null when it is acceptable. */
export function newPinError(pin: string): string | null {
  const p = actionPinProblem(pin);
  if (p === null) return null;
  return p === "6 to 12 digits" ? strings.validate.pin : strings.validate.pinWeak;
}

/** What may be typed into a PIN field: digits only, at most 12. */
export function pinInput(value: string): string {
  return value.replace(/\D/g, "").slice(0, 12);
}
