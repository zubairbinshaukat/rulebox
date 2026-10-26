import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/target/**",
      "**/src-tauri/**",
      "**/gen/**",
      "convex/_generated/**",
      "packages/types/src/generated/**",
      "design/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  // Convex: every public function goes through convex/lib/functions.ts
  // (plan Phase 4, rule 3). Internal builders stay allowed.
  {
    files: ["convex/**/*.ts"],
    ignores: [
      "convex/lib/functions.ts",
      "convex/auth.ts",
      "convex/http.ts",
      "convex/**/*.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["./_generated/server", "../_generated/server"].map((name) => ({
            name,
            importNames: ["query", "mutation", "action"],
            message: "Use the wrappers in convex/lib/functions.ts",
          })),
        },
      ],
    },
  },
  // Convex logs: never arguments or values (plan Section 8).
  {
    files: ["convex/**/*.ts"],
    ignores: ["convex/**/*.test.ts"],
    rules: { "no-console": ["error", { allow: ["error", "warn"] }] },
  },
);