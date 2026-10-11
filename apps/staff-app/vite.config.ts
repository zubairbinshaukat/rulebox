import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@convex": fileURLToPath(new URL("../../convex", import.meta.url)) },
  },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
});