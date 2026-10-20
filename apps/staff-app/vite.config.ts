import react from "@vitejs/plugin-react";
import Icons from "unplugin-icons/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Solar icons are compiled into the bundle at build time (Decision 16/17: no runtime fetching).
  plugins: [react(), Icons({ compiler: "jsx", jsx: "react" })],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        shell: "shell.html",
        apps: "apps.html",
        exit: "exit.html",
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Step 1 has no tests yet; the plan still requires `pnpm test` to pass.
    passWithNoTests: true,
  },
});
