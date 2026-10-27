import { lazy, type ComponentType } from "react";
import { screensForPath, type ScreenName } from "./route-table";

type Loader = () => Promise<{ default: ComponentType }>;

/** Every lazy screen chunk (route-level code splitting); paths in `route-table.ts`. */
const LOADERS: Record<ScreenName, Loader> = {
  SignIn: () => import("../screens/SignIn"),
  Join: () => import("../screens/Join"),
  Reset: () => import("../screens/Reset"),
  Mfa: () => import("../screens/Mfa"),
  Layout: () => import("./Layout").then((m) => ({ default: m.Layout })),
  Overview: () => import("../screens/Overview"),
  Devices: () => import("../screens/Devices"),
  DeviceDetail: () => import("../screens/DeviceDetail"),
  Groups: () => import("../screens/Groups"),
  GroupDetail: () => import("../screens/GroupDetail"),
  Employees: () => import("../screens/Employees"),
  EmployeeDetail: () => import("../screens/EmployeeDetail"),
  Apps: () => import("../screens/Apps"),
  AppEdit: () => import("../screens/AppEdit"),
  FileTypes: () => import("../screens/FileTypes"),
  Enrollment: () => import("../screens/Enrollment"),
  Audit: () => import("../screens/Audit"),
  Settings: () => import("../screens/Settings"),
  Gallery: () => import("../Gallery"),
  NotFound: () => import("../screens/NotFound"),
};

/**
 * A lazy screen. A chunk that fails to download throws during render;
 * `ChunkErrorBoundary` shows Try again for it (a reload: Chromium caches a
 * failed `import()`, so trying again in place does not help).
 */
export function lazyScreen(name: ScreenName, loaders: Record<ScreenName, Loader> = LOADERS): ComponentType {
  return lazy(() => loaders[name]());
}

const prefetched = new Set<ScreenName>();

/** Starts downloading screen chunks without rendering them (errors are ignored: the real load retries). */
export function prefetchScreens(names: readonly ScreenName[], loaders: Record<ScreenName, Loader> = LOADERS): void {
  for (const name of names) {
    if (prefetched.has(name)) continue;
    prefetched.add(name);
    loaders[name]().catch(() => prefetched.delete(name));
  }
}

/** Prefetches what a link target needs (for hover, focus and touch on links). */
export function prefetchPath(pathname: string): void {
  prefetchScreens(screensForPath(pathname));
}

interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

/** False on Data Saver or a 2G-class connection: then only what is needed is downloaded. */
export function canPrefetch(connection: NetworkInformationLike | undefined): boolean {
  if (!connection) return true;
  if (connection.saveData) return false;
  return !/(^|-)2g$/.test(connection.effectiveType ?? "");
}

/** Prefetches the likely next screens once the browser is idle (not on slow or metered connections). */
export function prefetchWhenIdle(names: readonly ScreenName[]): () => void {
  const nav = navigator as Navigator & { connection?: NetworkInformationLike };
  if (!canPrefetch(nav.connection)) return () => {};
  const run = () => prefetchScreens(names);
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(run, { timeout: 4000 });
    return () => window.cancelIdleCallback(id);
  }
  const t = window.setTimeout(run, 1500);
  return () => window.clearTimeout(t);
}
