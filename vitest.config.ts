import { defineConfig } from "vitest/config";

// Root test config. The dashboard has its own (apps/dashboard/vite.config.ts).
// `pnpm test:convex` runs the "convex" project: convex-test in the edge
// runtime, like the Convex default runtime.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "convex",
          include: ["convex/**/*.test.ts"],
          environment: "edge-runtime",
          // Heavy files (auth, ioBudgets) run in parallel and can pass 5 s
          // under load; they finish fine alone. Generous cap, not a hang guard.
          testTimeout: 30_000,
          server: { deps: { inline: ["convex-test"] } },
        },
      },
      // Node scripts (Step 8: scripts/policy-key.mjs).
      {
        test: {
          name: "scripts",
          include: ["scripts/**/*.test.mjs"],
          environment: "node",
        },
      },
    ],
  },
});
