import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import Icons from "unplugin-icons/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // Solar icons are compiled into the bundle at build time (Decision 16/17: no runtime fetching).
  plugins: [react(), Icons({ compiler: "jsx", jsx: "react" })],
  resolve: {
    alias: { "@convex": fileURLToPath(new URL("../../convex", import.meta.url)) },
  },
  server: { port: 5173, strictPort: true },
});