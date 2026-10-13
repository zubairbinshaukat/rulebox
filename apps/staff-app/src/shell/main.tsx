import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { setLite, setTheme, ErrorBoundary } from "@rulebox/ui";
import "@rulebox/ui/fonts.css";
import "@rulebox/ui/tokens.css";
import "@rulebox/ui/base.css";

import { startShellStore, useShell } from "../lib/store";
import { call, isTauri } from "../lib/tauri";
import { DevOverlay } from "./DevOverlay";
import { StatusPanel } from "./StatusPanel";

export function ShellRoot() {
  const display = useShell((s) => s.display);

  useEffect(() => {
    void startShellStore();
  }, []);

  useEffect(() => {
    setTheme(display.theme);
    setLite(display.lite);
  }, [display.lite, display.theme]);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    void call("ui_ready", {});
    const id = window.setInterval(() => {
      void call("ui_alive", {});
    }, 5_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <>
      <StatusPanel />
      <DevOverlay />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary title="Something went wrong">
      <ShellRoot />
    </ErrorBoundary>
  </StrictMode>,
);
