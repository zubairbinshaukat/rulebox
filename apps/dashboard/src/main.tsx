import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
// Latin subsets only (size budget: scripts/size.mjs); the Figtree file is preloaded by the build.
import "@rulebox/ui/fonts-latin.css";
import "@rulebox/ui/tokens.css";
import "@rulebox/ui/base.css";
import "./styles/dashboard.css";
import { AppErrorBoundary } from "./app/AppErrorBoundary";
import { IS_DEMO } from "./data";
import { App } from "./App";

const root = createRoot(document.getElementById("root")!);

const shell = (children: ReactNode) => (
  <StrictMode>
    <AppErrorBoundary>
      <BrowserRouter>{children}</BrowserRouter>
    </AppErrorBoundary>
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
    const convex = new ConvexReactClient(url);
    root.render(
      shell(
        // Convex Auth keeps its own tokens (localStorage); the dashboard stores
        // nothing about the session. Passwords only: never read a `?code=` from
        // the URL (that is for OAuth / magic links, which Rulebox does not use).
        <ConvexAuthProvider client={convex} shouldHandleCode={false}>
          <App />
        </ConvexAuthProvider>,
      ),
    );
  }
}
