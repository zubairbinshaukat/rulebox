import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { setLite, setTheme, ErrorBoundary } from "@rulebox/ui";
import "@rulebox/ui/fonts.css";
import "@rulebox/ui/tokens.css";
import "@rulebox/ui/base.css";

import { installExitKey } from "../lib/exitKey";
import { startShellStore, useShell } from "../lib/store";
import { call, isTauri } from "../lib/tauri";
import { DesktopRoot } from "./DesktopRoot";
import { DevOverlay } from "./DevOverlay";
import { PopupRoot } from "./popup/PopupRoot";
import { Taskbar } from "./taskbar/Taskbar";

/** Which of the three shell windows this page is: `#/desktop|taskbar|popup`. */
function routeOf(hash: string): "desktop" | "taskbar" | "popup" {
  const name = hash.replace(/^#\/?/, "");
  return name === "taskbar" || name === "popup" ? name : "desktop";
}

export function ShellRoot() {
  const route = routeOf(window.location.hash);
  const display = useShell((s) => s.display);

  useEffect(() => {
    void startShellStore();
  }, []);

  useEffect(() => {
    setTheme(display.theme);
    setLite(display.lite);
  }, [display.lite, display.theme]);

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
    return <Taskbar />;
  }
  if (route === "popup") {
    return <PopupRoot />;
  }
  return (
    <>
      <DesktopRoot />
      <DevOverlay />
    </>
  );
}

// The popup and taskbar windows are transparent: only their rounded panels
// paint, so the desktop shows around them.
if (routeOf(window.location.hash) !== "desktop") {
  document.documentElement.classList.add("rb-page-transparent");
}

// The administrator exit works from every Rulebox page, even one whose UI has crashed.
installExitKey();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary title="Something went wrong">
      <ShellRoot />
    </ErrorBoundary>
  </StrictMode>,
);
