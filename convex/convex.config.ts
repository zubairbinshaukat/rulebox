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
  },
});
app.use(rateLimiter);
export default app;
