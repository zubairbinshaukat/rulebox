// Document versions that come from OUTSIDE the publisher (an agent's report,
// rows of Phase 2). The agent is untrusted: a value that is not a plain
// non-negative integer (NaN, Infinity, a fraction, a negative, 1e300) must not
// reach a signed document, where it would break `buildPayload` or make the
// device's first version absurd.

/**
 * Largest version the server accepts from an agent report or builds on (a
 * device's first signed version is above what it reported). Far above anything
 * real and inside u32 / i32 on the agent side.
 */
export const MAX_APPLIED_VERSION = 1_000_000_000;

/** `n` when it is a safe integer in 0..MAX_APPLIED_VERSION, else undefined ("not reported"). */
export function sanitizeVersion(n: number | null | undefined): number | undefined {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > MAX_APPLIED_VERSION) return undefined;
  return n;
}
