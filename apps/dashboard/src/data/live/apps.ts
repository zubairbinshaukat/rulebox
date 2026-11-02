/**
 * Apps from `convex/apps.ts` as the screens' types. Pure functions (no Convex
 * React imports), used by `live/hooks.ts`.
 */
import type { FunctionReturnType } from "convex/server";
import type { api } from "@convex/_generated/api";
import { INSTALL_STATES, type AppDetail, type InstallCounts } from "../types";

type GetResult = FunctionReturnType<typeof api.apps.get>;
type SummaryResult = FunctionReturnType<typeof api.apps.installSummary>;

/** `apps:get` as the edit screen's `AppDetail` (the install counts are `apps:installSummary`, a query of its own). */
export function appDetailOf(r: GetResult): AppDetail {
  return r;
}

/** `apps:installSummary` (a count per state, 0 included) as the card's counts: only the states that have PCs. */
export function installCountsOf(r: SummaryResult): InstallCounts {
  const out: InstallCounts = {};
  for (const state of INSTALL_STATES) if (r[state] > 0) out[state] = r[state];
  // `capped` is optional on the server (absent unless a state hit the read cap).
  if ("capped" in r && r.capped === true) out.capped = true;
  return out;
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
  groupOptions: [],
};
