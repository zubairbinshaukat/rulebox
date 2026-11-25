/*
 * Site-wide constants. One place to change when the owner decides.
 * Nothing in here is secret: every value ends up in public HTML.
 */

/**
 * Production origin, no trailing slash. The domain is not chosen yet
 * (plan Q2), so this is a placeholder. Override at build time with
 * SITE_URL=https://example.org pnpm --filter @rulebox/website build
 */
export const SITE_URL: string = (process.env.SITE_URL ?? "https://rulebox.org").replace(/\/$/, "");

/** True only for the real production build. Anything else is noindex. */
export const IS_PRODUCTION: boolean = process.env.SITE_ENV === "production";

export const SITE_NAME = "Rulebox";
export const TAGLINE = "Only what you allow.";
export const DEFAULT_DESCRIPTION =
  "Turn any Windows PC into a locked, branded staff workstation. Approved apps, websites and files only. Managed from the web. Open source (MIT).";

/**
 * Public repository. Plan Q5 (a): public under an organisation named for the
 * project. The organisation does not exist yet, so this is a placeholder.
 */
export const REPO_URL = "https://github.com/zubairbinshaukat/rulebox";
export const RELEASES_URL = `${REPO_URL}/releases`;
export const ISSUES_URL = `${REPO_URL}/issues`;

/** The customer dashboard. Never link the operator console. */
export const APP_URL = SITE_URL.replace("://", "://app.");

/** Contact addresses (shown as a no-JavaScript fallback next to forms). */
const host = new URL(SITE_URL).host;
export const CONTACT_EMAIL = `hello@${host}`;
export const SECURITY_EMAIL = `security@${host}`;

/**
 * Cloudflare Turnstile site key (public). The default is Cloudflare's
 * documented "always passes" test key, so local builds work.
 */
export const TURNSTILE_SITE_KEY = process.env.PUBLIC_TURNSTILE_SITE_KEY ?? "1x00000000000000000000AA";

/**
 * Primary call to action. After early access this becomes "Start free" ->
 * `${APP_URL}/sign-up` (Story 13.2). One line to change.
 */
export const CTA_PRIMARY = { label: "Request early access", href: "/early-access" } as const;
export const CTA_SECONDARY = { label: "See how it works", href: "/product" } as const;
