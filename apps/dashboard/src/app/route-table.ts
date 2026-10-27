/**
 * Which lazy screen chunks each URL needs (plan Section 4.13 routes). Plain
 * data with no imports, so `vite.config.ts` can read it too: the build turns
 * it into the boot script's preload map (the current URL's chunks start
 * downloading in parallel with the entry) and the app uses it to prefetch the
 * next screen on hover and on idle. Keep it in step with `App.tsx`
 * (`route-table.test.ts` checks the files exist).
 */
export const SCREEN_FILES = {
  SignIn: "src/screens/SignIn.tsx",
  Join: "src/screens/Join.tsx",
  Reset: "src/screens/Reset.tsx",
  Mfa: "src/screens/Mfa.tsx",
  Layout: "src/app/Layout.tsx",
  Overview: "src/screens/Overview.tsx",
  Devices: "src/screens/Devices.tsx",
  DeviceDetail: "src/screens/DeviceDetail.tsx",
  Groups: "src/screens/Groups.tsx",
  GroupDetail: "src/screens/GroupDetail.tsx",
  Employees: "src/screens/Employees.tsx",
  EmployeeDetail: "src/screens/EmployeeDetail.tsx",
  Apps: "src/screens/Apps.tsx",
  AppEdit: "src/screens/AppEdit.tsx",
  FileTypes: "src/screens/FileTypes.tsx",
  Enrollment: "src/screens/Enrollment.tsx",
  Audit: "src/screens/Audit.tsx",
  Settings: "src/screens/Settings.tsx",
  Gallery: "src/Gallery.tsx",
  NotFound: "src/screens/NotFound.tsx",
} as const;

export type ScreenName = keyof typeof SCREEN_FILES;

/**
 * Screens that work without a session. Every other path (also `/mfa`, which
 * needs a signed-in member) lands on `/sign-in` when there is none, so the
 * boot script preloads the sign-in screen for it instead.
 */
export const SESSIONLESS_PATHS = ["/sign-in", "/join", "/reset"] as const;

const member = (screen: ScreenName): ScreenName[] => ["Layout", screen];

/**
 * Path → chunks. A last segment `:` stands for any id (`/devices/:` is
 * `/devices/<id>`); exact paths win (`/apps/new`). The gallery is left out on
 * purpose: it is never preloaded or prefetched.
 */
export const ROUTE_SCREENS: Record<string, ScreenName[]> = {
  "/sign-in": ["SignIn"],
  "/join": ["Join"],
  "/reset": ["Reset"],
  "/mfa": ["Mfa"],
  "/": member("Overview"),
  "/devices": member("Devices"),
  "/devices/:": member("DeviceDetail"),
  "/groups": member("Groups"),
  "/groups/:": member("GroupDetail"),
  "/employees": member("Employees"),
  "/employees/:": member("EmployeeDetail"),
  "/apps": member("Apps"),
  "/apps/:": member("AppEdit"),
  "/file-types": member("FileTypes"),
  "/enrollment": member("Enrollment"),
  "/audit": member("Audit"),
  "/settings": member("Settings"),
};

/** The table key for a pathname (`/devices/abc` → `/devices/:`), or null for an unknown path. */
export function routeKey(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (ROUTE_SCREENS[path]) return path;
  const withId = path.replace(/\/[^/]+$/, "/:");
  return withId !== path && ROUTE_SCREENS[withId] ? withId : null;
}

/** The screens a pathname needs (empty for an unknown path). */
export function screensForPath(pathname: string): ScreenName[] {
  const key = routeKey(pathname);
  return (key && ROUTE_SCREENS[key]) || [];
}
