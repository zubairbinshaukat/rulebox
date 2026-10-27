import { createContext, useContext } from "react";
import { errorCodeOf } from "../lib/errors";
import type { StepUpController } from "../lib/stepup/controller";

/**
 * The signed-in shell's step-up controller (null outside `StepUpProvider`).
 * The confirm-and-retry itself happens in the data seam for every write
 * (`lib/stepUpRetry.ts`); screens use this only for "Lock now" and clocks.
 */
export const StepUpContext = createContext<StepUpController | null>(null);

export function useStepUpController(): StepUpController | null {
  return useContext(StepUpContext);
}

/** A call that still needs a confirmation (the dialog was cancelled). */
export function needsStepUp(e: unknown): boolean {
  const code = errorCodeOf(e);
  return code === "step_up_required" || code === "step_up_setup_required";
}
