import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import "@rulebox/ui/fonts.css";
import "@rulebox/ui/tokens.css";
import "@rulebox/ui/base.css";
import { ErrorBoundary } from "@rulebox/ui";
import { App } from "./App";

const url = import.meta.env.VITE_CONVEX_URL as string | undefined;
const root = createRoot(document.getElementById("root")!);

if (!url) {
  root.render(
    <div style={{ padding: 32, maxWidth: 560 }}>
      <h1 style={{ fontSize: 20, fontWeight: 500 }}>Missing VITE_CONVEX_URL</h1>
      <p>
        Copy <code>.env.example</code> to <code>.env.local</code> in <code>apps/dashboard</code> and set{" "}
        <code>VITE_CONVEX_URL</code> to your Convex deployment URL, then restart the dev server.
      </p>
    </div>,
  );
} else {
  const convex = new ConvexReactClient(url);
  root.render(
    <StrictMode>
      <ConvexProvider client={convex}>
        <ErrorBoundary title="Can't reach the Rulebox backend">
          <App />
        </ErrorBoundary>
      </ConvexProvider>
    </StrictMode>,
  );
}