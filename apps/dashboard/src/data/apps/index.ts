/**
 * App list hooks. Like `../index.ts`, the implementation is picked at build
 * time: `vite.config.ts` points `@rulebox/apps-impl` at `demo.ts`
 * (VITE_DEMO=1) or `live.ts`. Imported only by lazy screens.
 */
import { appsApi } from "@rulebox/apps-impl";
import type { AppsApi } from "./api";

const api: AppsApi = appsApi;

export const { useAppsScreen, useAppInstalls } = api;
