import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { setLite, setTheme, ErrorBoundary } from "@rulebox/ui";
import "@rulebox/ui/fonts.css";
import "@rulebox/ui/tokens.css";
import "@rulebox/ui/base.css";

import { installExitKey } from "../lib/exitKey";
import { startShellStore, useShell } from "../lib/store";
import { AppHost } from "./AppHost";

export function AppRoot() {
  const display = useShell((s) => s.display);

  useEffect(() => {
    void startShellStore();
  }, []);

  useEffect(() => {
    setTheme(display.theme);
    setLite(display.lite);
  }, [display.lite, display.theme]);

  return <AppHost />;
}

// The administrator exit works from every Rulebox page, even one whose UI has crashed.
installExitKey();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary title="Something went wrong">
      <AppRoot />
    </ErrorBoundary>
  </StrictMode>,
);
