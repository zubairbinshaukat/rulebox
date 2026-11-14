import { StrictMode, Suspense, lazy, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { setLite, setTheme, ErrorBoundary } from "@rulebox/ui";
import "@rulebox/ui/fonts.css";
import "@rulebox/ui/tokens.css";
import "@rulebox/ui/base.css";
import "@rulebox/ui/staff.css";

import { startDevMotion, useForcedFullMotion } from "../lib/devMotion";
import { installExitKey } from "../lib/exitKey";
import { startShellStore, useShell } from "../lib/store";
import { call, isTauri } from "../lib/tauri";

// Each of the three shell windows loads only its own screens: the taskbar
// window never parses the desktop, the popup never parses the sign-in.
const DesktopRoot = lazy(() => import("./DesktopRoot").then((m) => ({ default: m.DesktopRoot })));
const DevOverlay = lazy(() => import("./DevOverlay").then((m) => ({ default: m.DevOverlay })));
const PopupRoot = lazy(() => import("./popup/PopupRoot").then((m) => ({ default: m.PopupRoot })));
const Taskbar = lazy(() => import("./taskbar/Taskbar").then((m) => ({ default: m.Taskbar })));
// The cover windows (lock / full-screen notice on every monitor) parse nothing else.
const CoverRoot = lazy(() => import("./notice/CoverRoot").then((m) => ({ default: m.CoverRoot })));
// The logo bench exists only in a build made with VITE_RB_BENCH=1 (Step 17 measurements).
const LogoBench = import.meta.env.VITE_RB_BENCH ? lazy(() => import("./bench/LogoBench")) : null;

/** Which shell window this page is: `#/desktop|taskbar|popup|cover`. */
function routeOf(hash: string): "desktop" | "taskbar" | "popup" | "cover" {
  const name = hash.replace(/^#\/?/, "");
  return name === "taskbar" || name === "popup" || name === "cover" ? name : "desktop";
}

export function ShellRoot() {
  const route = routeOf(window.location.hash);
  const display = useShell((s) => s.display);
  // Debug builds only (resource monitor): show every animation even in Lite.
  const forcedFullMotion = useForcedFullMotion();

  useEffect(() => {
    void startShellStore();
  }, []);

  useEffect(() => {
    setTheme(display.theme);
    setLite(display.lite && !forcedFullMotion);
  }, [display.lite, display.theme, forcedFullMotion]);

  // Only the desktop page reports "ready" and "alive": the agent's watchdog
  // must watch the page that carries the sign-in and the desktop.
  useEffect(() => {
    if (!isTauri() || route !== "desktop") {
      return;
    }
    void call("ui_ready", {});
    const id = window.setInterval(() => {
      void call("ui_alive", {});
    }, 5_000);
    return () => window.clearInterval(id);
  }, [route]);

  if (route === "taskbar") {
    return (
      <Suspense fallback={null}>
        <Taskbar />
      </Suspense>
    );
  }
  if (route === "popup") {
    return (
      <Suspense fallback={null}>
        <PopupRoot />
      </Suspense>
    );
  }
  if (route === "cover") {
    return (
      <Suspense fallback={null}>
        <CoverRoot />
      </Suspense>
    );
  }
  if (LogoBench && window.location.hash === "#/bench-logo") {
    return (
      <Suspense fallback={null}>
        <LogoBench />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <DesktopRoot />
      {import.meta.env.DEV ? <DevOverlay /> : null}
    </Suspense>
  );
}

// The popup and taskbar windows are transparent: only their rounded panels
// paint, so the desktop shows around them. A cover window is opaque (it hides what is under it).
const pageRoute = routeOf(window.location.hash);
if (pageRoute === "taskbar" || pageRoute === "popup") {
  document.documentElement.classList.add("rb-page-transparent");
}

// The administrator exit works from every Rulebox page, even one whose UI has crashed.
installExitKey();
// Debug builds only: restores "Force full motion" and follows the other windows.
startDevMotion();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary title="Something went wrong">
      <ShellRoot />
    </ErrorBoundary>
  </StrictMode>,
);
