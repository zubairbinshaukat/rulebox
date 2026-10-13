import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { setLite, setTheme, ErrorBoundary } from "@rulebox/ui";
import "@rulebox/ui/fonts.css";
import "@rulebox/ui/tokens.css";
import "@rulebox/ui/base.css";

import { startShellStore, useShell } from "../lib/store";

export function AppRoot() {
  const display = useShell((s) => s.display);
  const link = useShell((s) => s.link);
  const session = useShell((s) => s.session);

  useEffect(() => {
    void startShellStore();
  }, []);

  useEffect(() => {
    setTheme(display.theme);
    setLite(display.lite);
  }, [display.lite, display.theme]);

  const sessionText =
    session.status === "signedIn" ? session.employee.name : session.status;

  return (
    <div style={{ padding: 24, color: "var(--rb-fg, var(--rb-ink))" }}>
      <div>Rulebox app</div>
      <div style={{ marginTop: 8, fontSize: 13, color: "var(--rb-muted)" }}>
        Link: {link} · Session: {sessionText}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary title="Something went wrong">
      <AppRoot />
    </ErrorBoundary>
  </StrictMode>,
);
