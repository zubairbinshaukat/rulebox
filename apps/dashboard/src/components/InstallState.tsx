import { Pill, type PillTone } from "@rulebox/ui";
import type { InstallState } from "../data/types";
import { strings } from "../lib/strings";

const TONE: Record<InstallState, PillTone> = {
  installed: "success",
  failed: "danger",
  pending: "neutral",
  downloading: "neutral",
  installing: "neutral",
  removing: "neutral",
  removed: "neutral",
  unsupported: "warning",
};

const BUSY: InstallState[] = ["pending", "downloading", "installing", "removing"];

/** Install state pill (Step 17): text + colour, a small spinner while in progress. */
export function InstallStatePill({ state }: { state: InstallState }) {
  return (
    <Pill tone={TONE[state]} dot={!BUSY.includes(state)}>
      {BUSY.includes(state) ? <span className="dash-spin" aria-hidden="true" style={{ width: 10, height: 10 }} /> : null}
      {strings.installState[state]}
    </Pill>
  );
}


