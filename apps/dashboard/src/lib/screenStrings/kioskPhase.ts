import type { KioskPhase } from "../../data/types";

export const kioskPhaseStrings = {
  notApplied: "Not applied",
  applying: "Applying",
  applied: "Applied",
  failed: "Failed",
  unknown: "Unknown",
} as const satisfies Record<KioskPhase, string>;
