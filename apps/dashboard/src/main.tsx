import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import "@rulebox/ui/fonts.css";
import "@rulebox/ui/tokens.css";
import "@rulebox/ui/base.css";
import "./styles/dashboard.css";
import { ErrorBoundary } from "@rulebox/ui";
import { IS_DEMO } from "./data";
import { App } from "./App";

const root = createRoot(document.getElementById("root")!);

const shell = (children: ReactNode) => (
  <StrictMode>
    <ErrorBoundary title="Something went wrong">
      <BrowserRouter>{children}</BrowserRouter>
    </ErrorBoundary>
  </StrictMode>
);

if (IS_DEMO) {
  // Demo mode: in-memory fixtures, no backend (see src/data/README.md).
  root.render(shell(<App />));
} else {
  const url = import.meta.env.VITE_CONVEX_URL as string | undefined;
  if (!url) {
    root.render(
      <main style={{ padding: 32, maxWidth: 560 }}>
        <h1 style={{ fontSize: 20, fontWeight: 500 }}>Missing VITE_CONVEX_URL</h1>
        <p>
          Copy <code>.env.example</code> to <code>.env.local</code> in <code>apps/dashboard</code> and set{" "}
          <code>VITE_CONVEX_URL</code> to your Convex deployment URL, then restart the dev server. To look around
          without a backend, run <code>pnpm --filter @rulebox/dashboard dev:demo</code>.
        </p>
      </main>,
    );
  } else {
    // Step 4 wraps this in ConvexAuthProvider once @convex-dev/auth is installed.
    const convex = new ConvexReactClient(url);
    root.render(
      shell(
        <ConvexProvider client={convex}>
          <App />
        </ConvexProvider>,
      ),
    );
  }
}
