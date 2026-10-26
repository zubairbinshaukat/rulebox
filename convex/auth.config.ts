// Convex Auth: this deployment issues and verifies its own member JWTs.
// (`process.env` is how auth.config.ts reads deployment env vars.)
declare const process: { env: Record<string, string | undefined> };

export default {
  providers: [{ domain: process.env.CONVEX_SITE_URL, applicationID: "convex" }],
};
