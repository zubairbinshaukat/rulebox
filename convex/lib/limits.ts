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
export const JWT_DURATION_MS = 10 * MINUTE_MS;

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
