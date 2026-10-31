import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { setLite, setTheme, ErrorBoundary } from "@rulebox/ui";
import "@rulebox/ui/fonts.css";
import "@rulebox/ui/tokens.css";
import "@rulebox/ui/base.css";

import { startDevMotion, useForcedFullMotion } from "../lib/devMotion";
import { installExitKey } from "../lib/exitKey";
import { startShellStore, useShell } from "../lib/store";
import { AppHost } from "./AppHost";

export function AppRoot() {
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

  return <AppHost />;
}

// The administrator exit works from every Rulebox page, even one whose UI has crashed.
installExitKey();
// Debug builds only: restores "Force full motion" and follows the other windows.
startDevMotion();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary title="Something went wrong">
      <AppRoot />
    </ErrorBoundary>
  </StrictMode>,
);
