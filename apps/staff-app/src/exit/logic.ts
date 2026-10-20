import type { AdminExitView, ExitAnswer } from "@rulebox/types";

/** What the exit dialog does, as pure rules (Section 7.11). */

export const PIN_MIN = 4;
export const PIN_MAX = 12;
/** After this long without the agent, the recovery line is added. */
export const RECOVERY_AFTER_MS = 30_000;
/** A call that timed out while the link is up may be tried again after this. */
export const RETRY_AFTER_UNAVAILABLE_MS = 5_000;

export const MESSAGES = {
  wrong: "That PIN is not right.",
  checking: "Checking…",
  signingOut: "Signing out to Windows…",
  waiting: "Rulebox can't check the PIN right now. Waiting for the Rulebox service…",
  unsupported: "Admin exit is not available on this PC yet.",
  recovery: "If this does not change: restart this PC while holding Shift, or turn kiosk off from the dashboard.",
} as const;

/** Digits only, at most 12: whatever else is typed or pasted is dropped. */
export function filterPin(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, PIN_MAX);
}

export function pinReady(pin: string): boolean {
  return pin.length >= PIN_MIN && pin.length <= PIN_MAX && /^\d+$/.test(pin);
}

/** `272000` -> `4:32`. Seconds round up, so it never shows 0:00 while still locked. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Where the dialog is in its own flow. */
export type Phase =
  | { kind: "ready" }
  | { kind: "checking" }
  | { kind: "wrong"; attemptsLeft: number | null }
  | { kind: "locked"; until: number }
  | { kind: "signingOut" }
  | { kind: "unavailable"; since: number };

/** The phase after the agent answered (or failed to). `"close"` means the exit is off: the dialog goes away. */
export function afterAnswer(answer: ExitAnswer, now: number): Phase | "close" {
  switch (answer.status) {
    case "signingOut":
      return { kind: "signingOut" };
    case "wrongPin":
      return { kind: "wrong", attemptsLeft: answer.attemptsLeft };
    case "lockedOut":
      return { kind: "locked", until: now + answer.retryAfterMs };
    case "disabled":
      return "close";
    case "unavailable":
      return { kind: "unavailable", since: now };
  }
}

export interface Presentation {
  fieldDisabled: boolean;
  /** The line under the field: an error or a status. */
  message: string | null;
  tone: "error" | "info" | null;
  /** The extra recovery line (waiting for 30 seconds, or not supported). */
  recovery: boolean;
  canSubmit: boolean;
  /** The dialog should close itself (the exit was turned off). */
  closes: boolean;
}

/**
 * What the dialog shows. `waitingSince` is when the agent link was first seen
 * down (null while it is up); `pin` is what is typed now.
 */
export function present(
  view: AdminExitView,
  phase: Phase,
  pin: string,
  now: number,
  waitingSince: number | null,
): Presentation {
  const base = { fieldDisabled: false, message: null, tone: null, recovery: false, canSubmit: pinReady(pin), closes: false };
  if (!view.enabled) {
    return { ...base, fieldDisabled: true, canSubmit: false, closes: true };
  }
  const linked = view.link === "linked";
  if (linked && !view.supported) {
    return { ...base, fieldDisabled: true, canSubmit: false, message: MESSAGES.unsupported, tone: "info", recovery: true };
  }
  const waiting = (message: string): Presentation => ({
    ...base,
    fieldDisabled: true,
    canSubmit: false,
    message,
    tone: "info",
    recovery: waitingSince !== null && now - waitingSince >= RECOVERY_AFTER_MS,
  });
  if (!linked) {
    return waiting(MESSAGES.waiting);
  }
  switch (phase.kind) {
    case "checking":
      return { ...base, fieldDisabled: true, canSubmit: false, message: MESSAGES.checking, tone: "info" };
    case "signingOut":
      return { ...base, fieldDisabled: true, canSubmit: false, message: MESSAGES.signingOut, tone: "info" };
    case "locked": {
      const left = phase.until - now;
      if (left <= 0) {
        return base;
      }
      return {
        ...base,
        fieldDisabled: true,
        canSubmit: false,
        message: `Too many tries. Try again in ${formatCountdown(left)}.`,
        tone: "error",
      };
    }
    case "unavailable":
      // The PIN is not kept or re-sent; the field comes back by itself.
      return now - phase.since >= RETRY_AFTER_UNAVAILABLE_MS ? base : waiting(MESSAGES.waiting);
    case "wrong": {
      const left = phase.attemptsLeft;
      const extra = left === null ? "" : left === 1 ? " 1 try left." : ` ${left} tries left.`;
      return { ...base, message: MESSAGES.wrong + extra, tone: "error" };
    }
    case "ready":
      return base;
  }
}
