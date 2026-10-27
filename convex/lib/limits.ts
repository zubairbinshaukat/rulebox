// Named limits (plan Section 10: every `.take(n)` uses a constant from here).

/** Bumped whenever a public function changes incompatibly (plan Step 3, edge case 14). */
export const SERVER_API_VERSION = 1;

/** Memberships `requireMember` reads per user (plan 4.6). */
export const MAX_MEMBERSHIPS = 20;
/** Members screen and "last owner" checks (`members.by_org_role`). */
export const MAX_MEMBERS = 200;
/** Members screen invite list (`invites.by_org`, newest first). */
export const MAX_INVITES_LISTED = 100;
/** Unused invites read per email when a user is created (`invites.by_email`). */
export const MAX_INVITES_PER_EMAIL = 10;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Join invite lifetime (`members:invite`). */
export const INVITE_TTL_MS = 7 * DAY_MS;
/** Owner bootstrap invite and password-reset code lifetime. */
export const OWNER_INVITE_TTL_MS = DAY_MS;
export const RESET_CODE_TTL_MS = DAY_MS;

/** Convex Auth sessions (plan Step 3; Section 9: 12 h idle, 7 days total). */
export const SESSION_TOTAL_MS = 7 * DAY_MS;
export const SESSION_INACTIVE_MS = 12 * HOUR_MS;
/**
 * Member JWT lifetime (A10, owner Q7: 60 minutes, was 10). Revocation stays
 * instant: `getSignedIn` reads the `authSessions` row on every call, and
 * mutations/actions also refuse a session past its `expirationTime`.
 */
export const JWT_DURATION_MS = 60 * MINUTE_MS;

/**
 * Maintenance of Convex Auth's tables (A10). A used refresh token is kept this
 * long after its first use (Convex Auth's reuse window is 10 s), then deleted
 * unless it is the parent of an unused token.
 */
export const REFRESH_TOKEN_USED_GRACE_MS = MINUTE_MS;
/** Convex Auth's `authRateLimits` row is fully refilled after an hour without attempts. */
export const AUTH_RATE_LIMIT_REFILL_MS = HOUR_MS;
/** Rate-limiter component rows created longer ago than this are cleared daily. */
export const RATE_LIMIT_ROW_MAX_AGE_MS = 7 * DAY_MS;

/** TOTP (plan Step 3.4). */
export const TOTP_MAX_FAILURES = 5;
export const TOTP_LOCK_MS = 15 * MINUTE_MS;
export const RECOVERY_CODE_COUNT = 10;

/** Audit (plan 4.11). */
export const AUDIT_SUMMARY_MAX = 300;
export const AUDIT_RETENTION_DAYS = 365;
/** Invites are deleted this long after they expired (plan Step 3.6). */
export const INVITE_RETENTION_MS = 30 * DAY_MS;

/** Batch size of the daily maintenance job (plan Step 3.6). */
export const MAINTENANCE_BATCH = 500;

/** Name lengths (plan edge case 27). */
export const MAX_DEVICE_NAME = 100;
export const MAX_EMAIL = 254;

/**
 * Step-up authentication (plan 4.16, Step 5a). Server time only.
 *
 * - A session is "unlocked" while it verified an action PIN or passkey less
 *   than STEP_UP_MAX_AGE_MS ago AND it was active (keepAlive or a member
 *   write) less than STEP_UP_IDLE_MS + STEP_UP_KEEPALIVE_MS ago. The
 *   dashboard locks itself after STEP_UP_IDLE_MS of real idle time and
 *   sends keepAlive at most every STEP_UP_KEEPALIVE_MS while the person
 *   types or clicks; the server tolerance covers that cadence.
 * - A major action needs a "fresh" step-up: verified less than
 *   STEP_UP_FRESH_MS ago (the one constant to change).
 */
export const STEP_UP_IDLE_MS = 10 * MINUTE_MS;
export const STEP_UP_KEEPALIVE_MS = 5 * MINUTE_MS;
export const STEP_UP_FRESH_MS = 5 * MINUTE_MS;
export const STEP_UP_MAX_AGE_MS = 8 * HOUR_MS;
/** `lastActiveAt` is rewritten only when it is at least this old (write budget). */
export const STEP_UP_ACTIVITY_QUANTUM_MS = 4 * MINUTE_MS;
/** A verification more than this far in the future (clock step between servers) is ignored. */
export const STEP_UP_CLOCK_SLACK_MS = MINUTE_MS;
/** First factor without a step-up: only this soon after a password (+ TOTP) sign-in. */
export const STEP_UP_BOOTSTRAP_MS = 15 * MINUTE_MS;
/** WebAuthn challenges: single use, this long. */
export const STEP_UP_CHALLENGE_TTL_MS = 2 * MINUTE_MS;
/** Passkeys per person. */
export const MAX_PASSKEYS = 10;
/** Step-up rows of one user read when a passkey is removed or a person is reset. */
export const MAX_STEP_UP_SESSIONS = 100;
/** Action PIN lockout: free failures, then a delay doubling from the base up to the cap. */
export const PIN_FREE_FAILURES = 2;
export const PIN_BACKOFF_BASE_MS = 30_000;
export const PIN_BACKOFF_MAX_MS = 15 * MINUTE_MS;
/** Failures since the last success after which the action PIN is disabled until reset. */
export const PIN_HARD_LIMIT = 10;
export const MAX_PASSKEY_NAME = 64;
/** A WebAuthn response JSON larger than this is refused before parsing. */
export const MAX_WEBAUTHN_RESPONSE_BYTES = 32 * 1024;

// Plan limits per organization live in lib/plans.ts (`orgPlans`, Step 5);
// `DEFAULT_MAX_DEVICES` (Step 3) was replaced by `orgPlans.limits.maxDevices`.

/** Organization settings (plan 4.10, Step 5). */
export const MAX_ORG_NAME = 100;
export const MAX_OFFLINE_DAYS = 30;
export const MAX_DEFAULT_QUOTA_GB = 2000;
export const MAX_HOTKEY_TEXT = 64;

/** Groups (plan Step 5.6). */
export const MAX_GROUP_NAME = 64;
export const MAX_GROUP_DESCRIPTION = 300;
/** `groups:list` reads at most this many groups (`groups.by_org`, tiny). */
export const MAX_GROUPS_LISTED = 500;
/** Device / employee counts per group are read with `.take(GROUP_COUNT_CAP + 1)` and shown as "500+". */
export const GROUP_COUNT_CAP = 500;
/** `groups:get` assigned apps (`appAssignments.by_group`). */
export const MAX_GROUP_APPS = 150;
/** Unexpired enrollment codes of a group checked by `groups:delete` (`by_group_expires`). */
export const MAX_GROUP_CODES_CHECKED = 100;

/** Publish queue (plan 4.4, Step 5 skeleton): debounce and the list cap before "all devices". */
export const PUBLISH_DEBOUNCE_MS = 1_500;
export const MAX_PUBLISH_TARGETS = 500;

/** `maintenance:migratePlans`: organizations per run, and the most rows it recounts per table. */
export const MIGRATION_ORG_BATCH = 20;
export const MAX_RECOUNT_ROWS = 5_000;

