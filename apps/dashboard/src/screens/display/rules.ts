import type { DisplayChoice } from "../../data/types";

/** `LITE_MAX_RAM_MB` of `rulebox-ipc`: at or below this memory a PC picks Lite on its own (PRD 22.5). */
export const LITE_MAX_RAM_MB = 4352;

/**
 * True when the choice that will apply is Standard on a PC that reports 4 GB of memory or less: the PC's own choice, else its
 * group's. The server allows it (the administrator knows the hardware); the page warns.
 */
export function standardOnSmallPc(own: DisplayChoice, group: DisplayChoice, ramMb: number | undefined): boolean {
  const winner = own !== "auto" ? own : group;
  return winner === "standard" && ramMb !== undefined && ramMb <= LITE_MAX_RAM_MB;
}
