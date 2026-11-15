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
 * Most Convex Auth sessions one person keeps. A new sign-in past it deletes the
 * oldest ones (`pruneOldSessions`), so "end every session" (`deleteUserSessions`)
 * stays one bounded transaction. Far above real use (a few browsers).
 */
export const MAX_USER_SESSIONS = 25;
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

/** Recovery codes per set (the action PIN's fallback). */
export const RECOVERY_CODE_COUNT = 10;

/** Audit (plan 4.11). */
export const AUDIT_SUMMARY_MAX = 300;
/**
 * Retention is per organization (`orgPlans.limits.auditRetentionDays`, A14;
 * `maintenance:pruneAudit`). This is the most a plan may set (`limitsProblem`)
 * and the daily backstop for rows no organization owns any more.
 */
export const MAX_AUDIT_RETENTION_DAYS = 3650;
/** Invites are deleted this long after they expired (plan Step 3.6). */
export const INVITE_RETENTION_MS = 30 * DAY_MS;

/** `audit:list` / `audit:forTarget` page size cap (a page is one index range of audit rows). */
export const MAX_AUDIT_PAGE = 50;
/** `audit:forTarget` target id length (an id is 32 characters; anything longer cannot match). */
export const MAX_AUDIT_TARGET_ID = 64;
/** Audit rows the overview shows (plan Step 17 item 6). */
export const OVERVIEW_AUDIT_ROWS = 10;

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
/** First action PIN without a step-up: only this soon after a password sign-in (Phase 4b: no TOTP). */
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
/**
 * Failures since the last success after which the action PIN is LOCKED for
 * PIN_LOCKOUT_MS (Phase 4b owner decision 2026-11-03: it was disabled until
 * reset, which let a password thief lock the owner out). Passkey, recovery
 * code, email reset and an Owner reset still work while it is locked.
 */
export const PIN_HARD_LIMIT = 10;
export const PIN_LOCKOUT_MS = 24 * HOUR_MS;
/**
 * Long-term PIN limit (Phase 4b security review): failures are also counted
 * in a rolling PIN_WINDOW_MS window that a success does NOT reset (a password
 * thief cannot hide behind the victim's daily unlock). PIN_HARD_LIMIT failures
 * in the window since the last lockout lock the PIN too, and each lockout in
 * the window is longer than the one before (PIN_LOCKOUT_STEPS_MS; the first
 * equals PIN_LOCKOUT_MS). MAX_PIN_WINDOW_ENTRIES bounds the stored timestamps.
 */
export const PIN_WINDOW_MS = 30 * DAY_MS;
export const PIN_LOCKOUT_STEPS_MS = [PIN_LOCKOUT_MS, 72 * HOUR_MS, 7 * DAY_MS] as const;
export const MAX_PIN_WINDOW_ENTRIES = 64;
/** "N wrong PIN attempts on your account" email after this many failures since the last unlock. */
export const PIN_WARN_AT = 5;

/**
 * Forgot PIN by email (Phase 4b Part C). A link token lives PIN_RESET_TTL_MS;
 * rows are pruned by the daily job PIN_RESET_RETENTION_MS after creation.
 * MAX_PIN_RESETS_READ bounds the per-user read that retires older tokens.
 */
export const PIN_RESET_TTL_MS = 30 * MINUTE_MS;
export const PIN_RESET_RETENTION_MS = 7 * DAY_MS;
export const MAX_PIN_RESETS_READ = 10;
/** Raw link tokens longer than this are refused before hashing (a token is 43 base64url characters). */
export const MAX_PIN_RESET_TOKEN = 128;

/** Outgoing mail (lib/mail.ts): one request deadline; at most one retry. */
export const MAIL_TIMEOUT_MS = 10_000;
export const MAX_MAIL_SUBJECT = 200;
export const MAX_MAIL_TEXT = 4_000;

/** Platform secrets (Phase 4b Part C): longest value accepted by `platform:setSecret`. */
export const MAX_PLATFORM_SECRET = 2_048;
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

/** Enrollment codes (plan Step 6; PRD 12.3 short-lived, limited-use). */
export const MIN_CODE_USES = 1;
export const MAX_CODE_USES = 100;
export const MIN_CODE_TTL_MINUTES = 15;
export const MAX_CODE_TTL_MINUTES = 7 * 24 * 60; // 10,080
export const MAX_CODE_LABEL = 64;
/** `enrollmentCodes:list` page size (`paginationOpts.numItems`). */
export const MAX_CODE_PAGE = 50;
/**
 * Codes created in the last MAX_CODE_TTL read when `create` finds the
 * `activeEnrollmentCodes` counter at the limit (expired codes leave the counter
 * only by this recount or `stats:reconcile`). Above it the create is refused.
 */
export const MAX_CODE_RECOUNT = 200;
/** `enrollment:enroll` argument bounds (refused with `invalid_request` above them). */
export const MAX_DEVICE_NAME_INPUT = 1_000;
export const MAX_AGENT_VERSION = 64;
export const MAX_COMPAT_JSON_BYTES = 32 * 1024;

/** Publish queue (plan 4.4, Step 5 skeleton): debounce and the list cap before "all devices". */
export const PUBLISH_DEBOUNCE_MS = 1_500;
export const MAX_PUBLISH_TARGETS = 500;

/** `maintenance:migratePlans`: organizations per run, and the most rows it recounts per table. */
// One per run: a single large organization's recount (up to MAX_RECOUNT_DEVICES x ~4 reads, plus
// the other tables) already uses about half of Convex's 16,384-document read limit.
export const MIGRATION_ORG_BATCH = 1;
export const MAX_RECOUNT_ROWS = 5_000;
/** Devices recounted per organization (each costs up to 4 reads: device, credentials, summary, presence). */
export const MAX_RECOUNT_DEVICES = 2_000;

/** Devices (plan Step 7). */
/** Device pages (`fleet:list`): at most this many rows per page (post-Phase-5 2.5). */
export const MAX_FLEET_PAGE = 50;
/** List search text (lib/listing.ts `cleanSearch`; Phase 4b list contract). */
export const MAX_SEARCH_TEXT = 100;
/** Rows per page of any dashboard list (lib/listing.ts; the pager offers 10, 25, 50). */
export const MAX_LIST_PAGE = 50;
/** Group names joined into a device page (`groups.by_org`, tiny). */
export const MAX_GROUPS_JOINED = 500;
/** `maintenance:migrateDevices` and the purge of a removed device: rows per run. */
export const MIGRATION_DEVICE_BATCH = 100;
export const PURGE_BATCH = 100;
/** `presence:sweep`: devices marked offline per run (it reschedules while full). */
export const SWEEP_BATCH = 500;
/** Ping-interval propagation: liveness rows per run. */
export const PING_PROPAGATION_BATCH = 200;
/** Organizations per run of the global ping-interval propagation. */
export const PING_PROPAGATION_ORG_BATCH = 50;
/** Online counters per organization (`orgPresence`): a reconnect storm spreads over shards. */
export const PRESENCE_SHARDS = 4;
/** Watch mode (plan 4.9): pings every FAST_PING_MS until `fastUntil`. */
export const FAST_PING_MS = MINUTE_MS;
export const WATCH_MS = 5 * MINUTE_MS;
/** `fleet:watch` writes only when it extends `fastUntil` by at least this much. */
export const WATCH_MIN_EXTEND_MS = 2 * MINUTE_MS;
/** "Check now": devices per click; checks are deleted this long after the click. */
export const MAX_CHECK_DEVICES = 50;
export const FLEET_CHECK_RETENTION_MS = DAY_MS;
/** Offline grace = 2.5 x the device's interval + this (plan 4.9). */
export const OFFLINE_GRACE_EXTRA_MS = MINUTE_MS;

/** Signing and the publisher (plan 4.4, 4.5, Step 8). */
/** Devices built, signed and written per `publish:run` (it reschedules itself for the rest). */
export const PUBLISH_BATCH = 25;
/** Versions kept per device: after inserting N, versions <= N - KEEP_VERSIONS are pruned. */
export const KEEP_VERSIONS = 5;
/** Old versions deleted per device per publish (index range). */
export const MAX_PRUNE_PER_DEVICE = 10;
/** `policyKeys` rows read per status (tiny: a few per organization). */
export const MAX_POLICY_KEYS_PER_STATUS = 20;
/** `keys:trustProgress` page size (devices of the organization). */
export const MAX_TRUST_PAGE = 200;
/** Roster log (A6): a signed snapshot every this many entries; `fetchRoster` answers at most this many entries. */
export const ROSTER_SNAPSHOT_EVERY = 200;
export const MAX_ROSTER_FETCH = 200;


/** Apps, winget, web metadata, file types (plan Step 10; 4.8). */
export const MAX_APP_NAME = 60;
export const MAX_APP_DESCRIPTION = 300;
/** Allowed domains an admin lists for a web app; the URL's own host is added on top (plan Step 10 item 3). */
export const MAX_ALLOWED_DOMAINS = 20;
export const MAX_APP_URL = 2_048;
/** `args`, `fileArgTemplate` and silent switches: entries and characters per entry (plan 4.8 "Path templates"). */
export const MAX_APP_ARGS = 16;
export const MAX_APP_ARG_LENGTH = 200;
/** Session cleanup folders per app (4.12; the count is not in the plan, it bounds the document). */
export const MAX_RESET_FOLDERS = 20;
export const MAX_EXE_PATH = 260;
/** Largest installer the agent downloads (4.8: 4 GiB). */
export const MAX_INSTALLER_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_SUCCESS_EXIT_CODES = 16;
/** `apps:list` page size cap. */
export const MAX_APP_PAGE = 50;
/** `apps:get`: assignments (`appAssignments.by_app`), file types and direct employees read per app. */
export const MAX_APP_ASSIGNMENTS = 500;
export const MAX_APP_FILE_TYPES = 201;
export const APP_EMPLOYEE_COUNT_CAP = 1_000;
/** File-type rules per organization (`fileHandlers`, tiny). */
export const MAX_FILE_HANDLERS = 200;
/**
 * `apps:installSummary` counts each state up to this many rows ("1000+" above it, plan Step 17 item 1);
 * `apps:installs` / `fleet:installs` page size cap;.
 */
export const INSTALL_COUNT_CAP = 1_000;
export const MAX_INSTALL_PAGE = 50;
/**
 * Failed results of one app read when an assign / unassign / archive / restore
 * moves `failedInstallCount` (lib/installs.ts); above it `stats:reconcile` is
 * scheduled for the organization.
 */
export const FAILED_DELTA_CAP = 500;
/** A PC's install results re-tagged per transaction after a move or revoke (`stats:retagDevice` continues). */
export const INSTALL_RETAG_BATCH = 200;
/** `stats:reconcile`: devices / employees / failed results per run of one stage (each run is one transaction). */
export const RECONCILE_DEVICE_BATCH = 200;
export const RECONCILE_EMPLOYEE_BATCH = 1_000;
export const RECONCILE_FAILED_BATCH = 200;
/** `maintenance:pruneAudit`: audit rows deleted per run (one organization per run, A14). */
export const AUDIT_PRUNE_BATCH = 500;
/** Rows of a removed app deleted per run of `apps:purgeApp` (it reschedules while full). */
export const APP_PURGE_BATCH = 100;
/** Icons: a PNG of at most 32 KiB and 512 x 512 pixels (plan Step 10 "Do NOT"). */
export const MAX_ICON_BYTES = 32 * 1024;
export const MAX_ICON_PIXELS = 512;
/** Web metadata fetch (plan Step 10 item 5): page, manifest, redirects, time. */
export const WEBMETA_MAX_PAGE_BYTES = 1024 * 1024;
export const WEBMETA_MAX_MANIFEST_BYTES = 256 * 1024;
export const WEBMETA_TIMEOUT_MS = 10_000;
export const WEBMETA_MAX_REDIRECTS = 4;
/** Winget: manifest and listing size caps, cache lifetime (4.8: 24 hours). */
export const WINGET_MAX_MANIFEST_BYTES = 512 * 1024;
export const WINGET_MAX_LISTING_BYTES = 512 * 1024;
export const WINGET_TIMEOUT_MS = 10_000;
export const WINGET_CACHE_MS = DAY_MS;
/** Version folders tried (newest first) when the latest has no installer manifest. */
export const WINGET_MAX_VERSION_TRIES = 3;
/** App pickers (`apps.by_org_archived`, plan 4.3 `.take(500)`). */
export const MAX_APP_OPTIONS = 500;
/** `publishApp`: direct employee grants followed to their groups; above these it republishes every device instead. */
export const MAX_GRANT_LOOKUPS = 50;
export const MAX_GRANT_GROUPS = 20;

/** Employees (plan Step 11; 4.12). */
export const MAX_EMPLOYEE_NAME = 100;
export const MAX_USERNAME = 64;
export const MIN_EMPLOYEE_PASSWORD = 8;
export const MAX_EMPLOYEE_PASSWORD = 256;
/** `employees:list` page size cap, and `employees:search` rows (`search_text`, `.take(50)`). */
export const MAX_EMPLOYEE_PAGE = 50;
export const MAX_EMPLOYEE_SEARCH = 50;
/** `employees:search` with a group filter: search hits examined (one `by_group_employee` range each) while looking for MAX_EMPLOYEE_SEARCH members. */
export const MAX_EMPLOYEE_SEARCH_SCAN = 400;
/** Groups an employee can be in (`employees:get` reads `.take(100)`), and direct app grants (4.4 rule 6). */
export const MAX_EMPLOYEE_GROUPS = 100;
export const MAX_EMPLOYEE_APPS = 50;
/** Members of one group: what one signed document may carry (4.4 rule 6). */
export const MAX_GROUP_EMPLOYEES = 2_000;
/** Groups named on one row of the employee list; more are flagged "and more". */
export const EMPLOYEE_ROW_GROUPS = 5;
/**
 * The publisher's transaction budget (Step 11 review). Convex limits for ONE
 * query or mutation (docs.convex.dev/production/state/limits, read 2026-11-01):
 *   index ranges read (calls to db.get + db.query) 4,096 | documents scanned
 *   32,000 | data read 16 MiB | documents written 16,000 | data written 16 MiB |
 *   user-code execution time 1 s (database time not counted) | 1,000 scheduled
 *   functions.
 * One `publish:run` builds up to PUBLISH_BATCH (25) devices, which can belong
 * to 25 different groups, so the work of a group must be small and the run as a
 * whole must stop loading groups well before the limits.
 * - A group's direct-grant reads are capped at MAX_GROUP_GRANT_EMPLOYEES
 *   members (one `groupMembers.by_group_grants` range + one `employeeApps`
 *   range each, at most MAX_EMPLOYEE_APPS rows) and MAX_GROUP_GRANT_APPS
 *   distinct granted apps; beyond that the group degrades with an audit entry.
 * - A run keeps a running total of ranges and documents read by group loads and
 *   loads one more group only if its worst case still fits the run budget
 *   (the rest of the batch goes back to the queue and the next hop). The
 *   budgets leave room for the ~15 ranges / ~10 documents each of the 25
 *   devices needs, and for old-version pruning.
 */
export const MAX_GROUP_GRANT_EMPLOYEES = 100;
export const MAX_GROUP_GRANT_APPS = 150;
export const RUN_RANGE_BUDGET = 3_000;
export const RUN_DOC_BUDGET = 18_000;
/** Worst case of ONE group's load: group + assignments + their apps + grant members + their apps. */
export const GROUP_LOAD_WORST_RANGES = 2 + MAX_GROUP_APPS + 1 + MAX_GROUP_GRANT_EMPLOYEES + MAX_GROUP_GRANT_APPS;
export const GROUP_LOAD_WORST_DOCS =
  1 + MAX_GROUP_APPS + MAX_GROUP_APPS + MAX_GROUP_GRANT_EMPLOYEES * (MAX_EMPLOYEE_APPS + 1) + MAX_GROUP_GRANT_APPS;
/** Pending roster removals signed per `employees:resyncRoster` run (it reschedules while full). */
export const ROSTER_RESYNC_BATCH = 50;

// ---------------------------------------------------------------- Phase 5 (Step 10)
/** `keys:rewrapAll`: orgKeys rows re-wrapped per run (it reschedules while full). */
export const REWRAP_BATCH = 50;
/** `deviceApi:reportFindings`: fingerprints per call (plan 4.19). */
export const MAX_FINDINGS_PER_CALL = 50;
/** `deviceApi:reportApply`: Wi-Fi profile / printer states per report (plan 4.2). */
export const MAX_ITEM_STATES = 50;
/** `deviceApi:reportSecurityDaily`: permission-denial rows per device day, and per organization day (plan 4.2). */
export const MAX_PERMISSION_DENIALS = 100;
export const MAX_ORG_PERMISSION_DENIALS = 500;
/** `deviceApi:reportAcks`: acknowledgements per call (the document carries at most 5 broadcasts). */
export const MAX_ACKS_PER_CALL = 20;
/** Lockdown limits of plan 4.3 rule 4 / 4.2 (the Rust side has the same numbers). */
export const MAX_GROUP_EXCEPTIONS = 200;
export const MAX_WIFI_PROFILES = 50;
export const MAX_DEVICE_WIFI = 20;
export const MAX_DEVICE_PRINTERS = 20;
export const MAX_ORG_PRINTERS = 100;
export const MAX_ACTIVE_BROADCASTS = 5;
/** `groupConfigs.config` in UTF-8 bytes, and how many versions per group are kept (plan 4.14). */
export const MAX_GROUP_CONFIG_BYTES = 262_144;
export const KEEP_GROUP_CONFIGS = 20;
export const PRUNE_GROUP_CONFIGS_PER_RUN = 10;
/** `security:rollup`: device rows per run; retention batches (plan 4.19, Step 10 item 7). */
export const SECURITY_ROLLUP_BATCH = 200;
export const DEVICE_SECURITY_RETENTION_DAYS = 14;
export const ORG_SECURITY_RETENTION_DAYS = 90;
export const SECURITY_RETENTION_BATCH = 200;
/** `apps:get`: the days of denial counts shown on the app page (plan 4.13: the last 30 `orgSecurityDaily` rows). */
export const APP_DENIAL_DAYS = 30;
/**
 * Group configuration snapshots in bulk (Phase 5 Step 20b, replaces the 10-group caps of Steps 13 to 16b). An edit that changes the
 * configuration of many groups (an app record, a file-type rule, a permission change, a Wi-Fi profile, a printer, a driver, an
 * "Allow") snapshots the first SNAPSHOT_SYNC_GROUPS groups in its own transaction (each snapshot reads up to ~1,000 documents with a
 * full catalogue) and schedules `groupBatches:snapshotBatch` for the rest, SNAPSHOT_BATCH_GROUPS groups per transaction. A batch
 * reads the live inputs when it runs, so it is idempotent and a later edit that lands first is never overwritten. More than
 * MAX_SNAPSHOT_GROUPS_TOTAL groups (the most `groups:list` shows) is `too_large`, detail "groups".
 */
export const SNAPSHOT_SYNC_GROUPS = 10;
export const SNAPSHOT_BATCH_GROUPS = 10;
export const MAX_SNAPSHOT_GROUPS_TOTAL = 500;
/** Group ids accepted in one `saveWifi` / `savePrinter` / `drivers:save` call, and chosen in one "Allow". */
export const MAX_NETWORK_GROUPS = 100;
/**
 * Group delete cleanup (`groupBatches:cleanupDeletedGroup`): configurations and exceptions deleted per transaction (a configuration can be
 * 256 KB), broadcasts cancelled per transaction (a full batch schedules the next one).
 */
export const GROUP_CLEANUP_CONFIGS = 10;
export const GROUP_CLEANUP_EXCEPTIONS = 100;
export const GROUP_CLEANUP_BROADCASTS = 50;
/** `networks:list`: group names shown per profile (the row also carries the total). */
export const MAX_WIFI_LIST_GROUPS = 10;
/** `networks:wifiDetail`: groups and apply reports per group read for the counts. */
export const MAX_WIFI_DETAIL_GROUPS = 10;
export const MAX_WIFI_DETAIL_REPORTS = 200;
/** Printers (Phase 5 Step 14, plan 4.2 / 4.15): the same string limits as `PrinterSpec` in `rulebox-policy`. */
export const MAX_PRINTER_NAME = 60;
export const MAX_PRINTER_ADDRESS = 255;
export const MAX_PRINTER_QUEUE = 64;
export const MAX_PRINTER_DRIVER = 100;
/** `orgSettings.phase5Settings.approvedPrinterDrivers`: names an organization adds to the inbox list. */
export const MAX_APPROVED_PRINTER_DRIVERS = 20;
/**
 * Windows' Standard TCP/IP port (raw and LPR printers) stores the host in 48 characters and the LPR queue in 32
 * (`PORT_DATA_1`), so a longer value cannot be created on the PC. DEVIATION from plan 4.2 (host up to 253, queue up
 * to 64); `ipp` and `share` keep the plan's limits.
 */
export const MAX_TCP_PORT_HOST = 48;
export const MAX_LPR_QUEUE = 32;
/**
 * Drivers (Phase 5 Step 14b, plan 4.15 / PRD 24.2): packages pushed to a group. Per organization, per device document,
 * and the strings an admin may enter.
 */
export const MAX_ORG_DRIVERS = 50;
export const MAX_DEVICE_DRIVERS = 20;
export const MAX_DRIVER_NAME = 60;
export const MAX_DRIVER_INF = 120;
export const MAX_DRIVER_ARGS = 16;
export const MAX_DRIVER_EXIT_CODES = 8;
export const MAX_DRIVER_PROVIDES = 10;
/** `drivers:detail`: result rows read for the counts (`capped` says the sample was cut). */
export const MAX_DRIVER_DETAIL_RESULTS = 200;
/** Rows of `driverResults` deleted per transaction when a driver is deleted (a full batch schedules the next one). */
export const DRIVER_RESULT_PURGE_BATCH = 100;
/** Sealed boxes deleted per transaction when a profile goes away or becomes open. */
export const SEALED_PURGE_BATCH = 100;
/** `seal:forDevices`: devices sealed per run (each needs one box per assigned profile). */
export const SEAL_DEVICES_PER_RUN = 25;
/**
 * Broadcast rows read per target when a document is built (newest first; cancelled and expired ones are skipped, then the
 * newest MAX_ACTIVE_BROADCASTS are kept). 30, not 10 (owner 2026-11-15): more than this many newer cancelled/expired rows
 * would hide an older live one. Reads only rows that exist, so the usual cost is unchanged.
 */
export const BROADCAST_READ = 30;
/** Device lock and broadcasts (Phase 5 Step 15, plan 4.17): text limits (the Rust side has the same numbers), the active cap per organization. */
export const MAX_LOCK_MESSAGE = 300;
export const MAX_LOCK_CONTACT = 100;
export const MAX_BROADCAST_TITLE = 80;
export const MAX_BROADCAST_BODY = 500;
export const MAX_ORG_ACTIVE_BROADCASTS = 20;
/** A broadcast's expiry may be at most this far ahead (an owner decision is open: the plan sets no upper bound). */
export const MAX_BROADCAST_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
/** `broadcasts:list`: rows per page. */
export const MAX_BROADCAST_PAGE = 50;
/** The server day a security summary may name: today, or this many days back (clock slack). */
export const SECURITY_DAY_SLACK = 2;
/**
 * Rollout rings (Phase 5 Step 16, plan 4.14). Apply reports read per ring-health run (plan: `.take(1001)`), devices read to size a
 * ring (`RING_COUNT_CAP + 1`; a ring above the cap is treated as that big, so the 50 % minimum of an automatic promotion is
 * computed over at most this many PCs), devices listed on the rollout screen, devices changed by one bulk ring call.
 */
export const ROLLOUT_HEALTH_READ = 1001;
export const RING_COUNT_CAP = 200;
export const MAX_RING_LIST = 100;
export const MAX_RING_BULK = 100;
/** `rollouts:tick`: rollouts read per page (the evaluation of each runs in its own scheduled transaction). */
export const ROLLOUT_TICK_PAGE = 25;
/** Automatic promotion: bake time range in hours and the failure-percentage range (plan 4.14; defaults 24 h and 10 %). */
export const MIN_BAKE_HOURS = 1;
export const MAX_BAKE_HOURS = 168;
export const MIN_FAILURE_PCT = 1;
export const MAX_FAILURE_PCT = 100;
/**
 * Lockdown screens (Phase 5 Step 19, plan 4.20). Findings per page; open findings counted for the "N new" link (more shows as "50+");
 * exceptions listed on the group screen (newest first; the document still carries up to MAX_GROUP_EXCEPTIONS); groups one "Allow"
 * may add an exception to (the first SNAPSHOT_SYNC_GROUPS in the same transaction, the rest in scheduled batches); the reason text.
 */
export const MAX_FINDINGS_PAGE = 50;
export const OPEN_FINDINGS_CAP = 50;
export const MAX_EXCEPTIONS_LISTED = 50;
export const MAX_ALLOW_GROUPS = MAX_NETWORK_GROUPS;
export const MAX_EXCEPTION_REASON = 200;
/** `lockdown:allowOptions`: programs offered in the "Allow for app" picker. */
export const MAX_ALLOW_APPS = 200;
/** Account lockout (plan 4.6 I7, 4.8): the threshold may not be below 5; the same numbers as the agent's check. */
export const MIN_LOCKOUT_THRESHOLD = 5;
export const MAX_LOCKOUT_THRESHOLD = 999;
export const MAX_LOCKOUT_MINUTES = 99_999;
/** "Allow USB for this PC" (plan 4.3 `usbTempAllow`, edge case 62): whole hours, at most this many. */
export const MAX_USB_ALLOW_HOURS = 8;
/** Overview warnings (plan 4.20, Q2): program rules in audit mode for longer than this; rows shown per warning. */
export const AUDIT_WARN_DAYS = 14;
export const OVERVIEW_WARNING_ROWS = 3;
/** Share of a ring that must have applied the version before an automatic promotion (plan 4.14: 50 %), and at least this many PCs. */
export const PROMOTE_MIN_SHARE = 0.5;
