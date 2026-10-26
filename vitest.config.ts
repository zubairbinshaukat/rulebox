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
          server: { deps: { inline: ["convex-test"] } },
        },
      },
    ],
  },
});
