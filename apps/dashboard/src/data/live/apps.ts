/**
 * Apps from `convex/apps.ts` as the screens' types. Pure functions (no Convex
 * React imports), used by `live/hooks.ts`.
 */
import type { FunctionReturnType } from "convex/server";
import type { api } from "@convex/_generated/api";
import type { AppDetail } from "../types";

type GetResult = FunctionReturnType<typeof api.apps.get>;

/**
 * `apps:get` as the edit screen's `AppDetail`. The install counts
 * (`apps:installSummary`) come with Step 17: until then the card says no PC has
 * reported an install.
 */
export function appDetailOf(r: GetResult): AppDetail {
  return { ...r, installCounts: {} };
}

/** The form for a new app needs nothing from the server (the kind comes from the address). One object, so screens see a stable value. */
export const NEW_APP: AppDetail = {
  _id: "new",
  name: "",
  kind: "web",
  archived: false,
  revision: 0,
  createdAt: 0,
  assignments: [],
  fileTypes: [],
  directEmployeeCount: 0,
  installCounts: {},
  groupOptions: [],
};
