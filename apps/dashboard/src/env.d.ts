/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONVEX_URL?: string;
  /** "1" = demo mode with in-memory fixtures (`pnpm dev:demo`). */
  readonly VITE_DEMO?: string;
}

/** The dashboard's package.json version (vite.config.ts `define`). */
declare const __APP_VERSION__: string;

/** "VITE_DEMO=1" at build time (vite.config.ts `define`). */
declare const __DEMO__: boolean;

/**
 * Idle-lock override for the end-to-end run, in ms (0 = use the server's
 * policy). Set only by the dev server from RULEBOX_TEST_IDLE_MS; always 0 in
 * builds (vite.config.ts `define`).
 */
declare const __STEPUP_TEST_IDLE_MS__: number;
