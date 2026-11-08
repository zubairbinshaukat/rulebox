import { defineApp } from "convex/server";
import { v } from "convex/values";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";

// Every name is optional so a fresh deployment pushes before any is set
// (plan 4.5). Values are read only through `env` from `_generated/server`,
// and only by the module named in plan 4.7 for each secret.
const app = defineApp({
  env: {
    RULEBOX_POLICY_KEY: v.optional(v.string()),
    RULEBOX_POLICY_KEY_NEXT: v.optional(v.string()),
    GITHUB_TOKEN: v.optional(v.string()),
    RULEBOX_ALLOW_TEST_SEED: v.optional(v.literal("1")),
    // Step-up passkeys (plan 4.16): relying party per environment.
    RULEBOX_WEBAUTHN_RP_ID: v.optional(v.string()),
    RULEBOX_WEBAUTHN_ORIGINS: v.optional(v.string()),
    RULEBOX_WEBAUTHN_RP_NAME: v.optional(v.string()),
    // Hosted (pooled) deployment (plan Step 5, A1): new organizations get the
    // "free" plan instead of the self-host "custom" plan.
    RULEBOX_HOSTED: v.optional(v.literal("1")),
    // Platform secrets master key (Phase 4b Part C): standard base64 of 32
    // random bytes, set by the operator. Read only by lib/platformSecrets.ts.
    // Missing or invalid: platform secrets cannot be set or read and the
    // forgot-PIN email is off.
    RULEBOX_PLATFORM_KEY: v.optional(v.string()),
    // Pepper for the recovery-code HMAC (lib/recoveryCodes.ts): at least 32
    // random characters, set by the operator. Missing: recovery codes can be
    // neither created nor used (`not_ready`).
    RULEBOX_RECOVERY_PEPPER: v.optional(v.string()),
  },
});
app.use(rateLimiter);
export default app;
