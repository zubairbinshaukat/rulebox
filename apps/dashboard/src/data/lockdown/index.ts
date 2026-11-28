/**
 * Lockdown hooks. Like `../index.ts`, the implementation is picked at build time: `vite.config.ts` points
 * `@rulebox/lockdown-impl` at `demo.ts` (VITE_DEMO=1) or `live.ts`. Imported only by the (lazy) lockdown, findings and
 * device screens.
 */
import { lockdownApi } from "@rulebox/lockdown-impl";
import type { LockdownApi } from "./api";

const api: LockdownApi = lockdownApi;

export const { useLockdownView, useLockdownSync, useSaveLockdown, useFindingsPage, useAllowOptions, useAllowFinding, useIgnoreFinding, useRemoveException, useAllowUsb } = api;
