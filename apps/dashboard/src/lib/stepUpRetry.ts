import { toAppError } from "./errors";

/**
 * Step-up retry for every write of the data seam (plan 4.16). The signed-in
 * shell registers a handler that opens the confirm dialog
 * (`stepup/StepUpProvider.tsx`, loaded lazily); until then, or outside the
 * shell, errors pass through unchanged. Tiny on purpose: it is part of the
 * first load.
 */
type Handler = (error: unknown) => Promise<boolean>;

let handler: Handler | null = null;

export function setStepUpHandler(h: Handler): () => void {
  handler = h;
  return () => {
    if (handler === h) handler = null;
  };
}

/**
 * Runs `call`; on `step_up_required` / `step_up_setup_required` (not "sign in
 * again", which no dialog fixes) asks the handler, then runs it exactly once
 * more. Cancelled: the original error is thrown.
 */
export async function withStepUp<R>(call: () => Promise<R>): Promise<R> {
  try {
    return await call();
  } catch (e) {
    const a = toAppError(e);
    const code = a?.code;
    if (!handler || !(code === "step_up_required" || (code === "step_up_setup_required" && a?.detail !== "reauthenticate"))) throw e;
    if (!(await handler(e))) throw e;
    return await call();
  }
}
