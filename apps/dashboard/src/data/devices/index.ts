/**
 * Device list hooks. Like `../index.ts`, the implementation is picked at build
 * time: `vite.config.ts` points `@rulebox/devices-impl` at `demo.ts`
 * (VITE_DEMO=1) or `live.ts`. Imported only by lazy screens.
 */
import { devicesApi } from "@rulebox/devices-impl";
import type { DevicesApi } from "./api";

const api: DevicesApi = devicesApi;

export const { useDevicesCount, useDevicesScreen, useDeviceInstalls } = api;
