import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@rulebox/ui/fonts.css";
import "@rulebox/ui/tokens.css";
import "@rulebox/ui/base.css";
import { ErrorBoundary } from "@rulebox/ui";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary title="Something went wrong">
      <div style={{ padding: 24, color: "var(--rb-fg)" }}>Rulebox app</div>
    </ErrorBoundary>
  </StrictMode>,
);
