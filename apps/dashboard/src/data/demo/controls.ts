/** The demo controls' view of the store (used only by `app/DemoControls.tsx`). */
import type { Role } from "../types";
import {
  controls,
  resetDemo,
  roleOverride,
  setControls,
  setRoleOverride,
  simulateConcurrentEdit,
  useStoreVersion,
  type DemoControls,
} from "./store";

export function useDemoControls() {
  useStoreVersion();
  return {
    controls: controls(),
    role: roleOverride(),
    setControls: (patch: Partial<DemoControls>) => setControls(patch),
    setRole: (role: Role | null) => setRoleOverride(role),
    simulateConcurrentEdit,
    reset: resetDemo,
  };
}
