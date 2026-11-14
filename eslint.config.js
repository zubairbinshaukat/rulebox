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
  // (plan Phase 4, rule 3). Internal queries / mutations too (I/O probe);
  // internal actions have no db and stay allowed.
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
            importNames: ["query", "mutation", "action", "internalQuery", "internalMutation"],
            message: "Use the wrappers in convex/lib/functions.ts (internalQuery / internalMutation are counted by the I/O probe there)",
          })),
        },
      ],
    },
  },
  // The policy signing seed is read ONLY by convex/lib/signing.ts (plan 4.5, A11).
  // Caught: `env.X` / `process.env.X`, `env["X"]`, env[`X`], destructuring
  // (`const { X } = env`, `{ X: k }`), and taking the whole environment
  // (`{ ...env }`, `const e = env`, `env[key]`, `fn(env)`), which would let the
  // seed be read under another name. `.seed` of a SigningKey is signing.ts's too
  // (everyone else signs with `signWith`). Tests are exempt.
  {
    files: ["convex/**/*.ts"],
    ignores: ["convex/lib/signing.ts", "convex/convex.config.ts", "convex/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[property.name=/^RULEBOX_POLICY_KEY/]",
          message: "Only convex/lib/signing.ts reads the signing seed (use loadOrgSigningKey).",
        },
        {
          selector: "Property[key.name=/^RULEBOX_POLICY_KEY/]",
          message: "Only convex/lib/signing.ts reads the signing seed (use loadOrgSigningKey).",
        },
        {
          selector: "Literal[value=/^RULEBOX_POLICY_KEY(_NEXT)?$/]",
          message: "Only convex/lib/signing.ts reads the signing seed (use loadOrgSigningKey).",
        },
        {
          selector: "TemplateElement[value.cooked=/^RULEBOX_POLICY_KEY(_NEXT)?$/]",
          message: "Only convex/lib/signing.ts reads the signing seed (use loadOrgSigningKey).",
        },
        {
          selector: "MemberExpression[computed=true][object.name='env']",
          message: "Do not index the environment dynamically; name the variable (only convex/lib/signing.ts may read the signing seed).",
        },
        {
          selector: "MemberExpression[computed=true][property.name='env']",
          message: "Do not index the environment dynamically; name the variable (only convex/lib/signing.ts may read the signing seed).",
        },
        {
          selector: "SpreadElement > :matches(Identifier[name='env'], MemberExpression[property.name='env'])",
          message: "Do not pass, copy or spread the whole environment; read named variables (only convex/lib/signing.ts may read the signing seed).",
        },
        {
          selector: "VariableDeclarator > :matches(Identifier[name='env'], MemberExpression[property.name='env']).init",
          message: "Do not pass, copy or spread the whole environment; read named variables (only convex/lib/signing.ts may read the signing seed).",
        },
        {
          selector: "CallExpression > :matches(Identifier[name='env'], MemberExpression[property.name='env']).arguments",
          message: "Do not pass, copy or spread the whole environment; read named variables (only convex/lib/signing.ts may read the signing seed).",
        },
        {
          selector: "MemberExpression[property.name='seed']",
          message: "Only convex/lib/signing.ts touches a key's seed (sign with signWith).",
        },
      ],
    },
  },
  // The deployment master key (Phase 5 Step 10, plan 4.18) is read ONLY by convex/lib/keyring.ts.
  {
    files: ["convex/**/*.ts"],
    ignores: ["convex/lib/keyring.ts", "convex/convex.config.ts", "convex/**/*.test.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        ...["RULEBOX_MASTER_KEY", "RULEBOX_MASTER_KEY_NEXT"].map((property) => ({
          object: "env",
          property,
          message: "Only convex/lib/keyring.ts reads the master key.",
        })),
        ...["RULEBOX_MASTER_KEY", "RULEBOX_MASTER_KEY_NEXT"].map((property) => ({
          object: "process.env",
          property,
          message: "Only convex/lib/keyring.ts reads the master key.",
        })),
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