// Database I/O budget per public function (post-Phase-5 plan 2.13, A16).
// The probe test that enforces these rows comes with Phase 4 Step 18; until
// then every step adds the rows of the functions it creates (plan 4.2.1).
//
// Counts are documents per call INCLUDING the member wrapper: `requireMember`
// reads the session, the memberships (normally 1) and the MFA row (3); member
// writes also read the step-up row (1) and patch it at most once per 4
// minutes of activity (not counted below). Bytes are estimates (rows of
// ~150-450 B). `live`: subscribed by the dashboard.

export type IoBudget = { maxReads: number; maxReadBytes: number; maxWrites: number; maxWriteBytes: number; live?: true };

export const IO_BUDGETS: Record<string, IoBudget> = {
  // ---- Step 5: settings. `get` re-runs only when the organization row changes.
  "settings:get": { maxReads: 4, maxReadBytes: 2_048, maxWrites: 0, maxWriteBytes: 0, live: true },
  // orgPlans + orgStats (+ platformSettings without a per-tenant interval, + 1 before migration).
  "settings:plan": { maxReads: 7, maxReadBytes: 4_096, maxWrites: 0, maxWriteBytes: 0, live: true },
  // org (+ step-up row again when the admin exit changes) + publishQueue; writes: org, audit,
  // queue, scheduled run. Unchanged values: 1 read, 0 writes.
  "settings:update": { maxReads: 7, maxReadBytes: 4_096, maxWrites: 4, maxWriteBytes: 2_048 },
  // authorize (4) + storeExitPin: org, orgSecrets, publishQueue; writes: orgSecrets, org, audit,
  // queue, scheduled run. Argon2id runs in the action (CPU, no I/O).
  "settings:setExitPin": { maxReads: 7, maxReadBytes: 3_072, maxWrites: 5, maxWriteBytes: 2_048 },
  // org (x2), orgSecrets, publishQueue; no PIN set: 1 read, 0 writes.
  "settings:clearExitPin": { maxReads: 8, maxReadBytes: 3_072, maxWrites: 5, maxWriteBytes: 2_048 },

  // ---- Step 5: groups. Counts per group read `.take(501)` of devices and
  // groupMembers (plan Step 5.11); a free tenant (3 groups, 2 devices, 25
  // employees) stays under ~90 documents. RISK: a large org (e.g. 20 groups of
  // 500 devices) reads ~10,000 documents per run and approaches Convex's
  // 16,384-document read limit; per-group counters (Step 7/11 maintain them,
  // Step 17 reads them) are the fix. Budget below = the free-tenant case.
  "groups:list": { maxReads: 100, maxReadBytes: 40_960, maxWrites: 0, maxWriteBytes: 0, live: true },
  // group + assignments (150) + their apps (150) + counts (1002).
  "groups:get": { maxReads: 3 + 1 + 150 + 150 + 1002, maxReadBytes: 600_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // name check, orgPlans, orgStats (+ platformSettings before migration); writes: group, orgStats, audit.
  "groups:create": { maxReads: 8, maxReadBytes: 3_072, maxWrites: 3, maxWriteBytes: 1_536 },
  // group, name check; unchanged: 0 writes; else group + audit.
  "groups:rename": { maxReads: 6, maxReadBytes: 2_048, maxWrites: 2, maxWriteBytes: 1_024 },
  // group, 3 x `.first()` dependents, unexpired codes of the group (<= 100), orgStats;
  // writes: delete, orgStats, audit. Refused: 0 writes.
  "groups:remove": { maxReads: 4 + 1 + 3 + 100 + 1, maxReadBytes: 40_960, maxWrites: 3, maxWriteBytes: 1_024 },

  // ---- Step 6: enrollment codes.
  // authorize (4) + storeCode: group, orgPlans (+ platformSettings before migration), orgStats,
  // token-hash clash check; at the limit + the recount of codes created in the last 7 days
  // (<= 201). Writes: token, orgStats, audit. Refused: 0 writes.
  "enrollmentCodes:create": { maxReads: 4 + 5 + 201, maxReadBytes: 90_000, maxWrites: 3, maxWriteBytes: 1_536 },
  // wrapper (3) + a page of <= 50 codes + their groups and creators (cached per call).
  "enrollmentCodes:list": { maxReads: 3 + 50 + 50 + 50, maxReadBytes: 60_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // wrapper + step-up (4), token, orgStats; writes: token, orgStats, audit. Already revoked: 0 writes.
  "enrollmentCodes:revoke": { maxReads: 6, maxReadBytes: 2_048, maxWrites: 3, maxWriteBytes: 1_024 },
  // Public (Step 7 shape). Limiter global + per org (2 reads, 2 writes), token, credentials by
  // secret (+ legacy devices by secret), orgPlans (+ platformSettings), orgStats, orgPlans again
  // for the ping interval; writes: limiter x2, token, device (identity), credentials, liveness,
  // presence, online shard, summary, report (compat <= 32 KB), orgStats, audit = 12.
  // Measured (probe, limiter excluded): 5 reads / 1.5 KB, 10 writes / 1.3 KB. Refused: 0 writes.
  // Step 8: + the org's key rows (3 index reads, a few rows) and the publish queue (read; insert
  // or patch + one scheduled run) for the device's first signed document.
  "enrollment:enroll": { maxReads: 16, maxReadBytes: 12_288, maxWrites: 13, maxWriteBytes: 41_984 },

  // ---- Step 7: the agent's calls (plan 4.9, 5.1 amended). Measured with the probe
  // (convex-test, `JSON.stringify` bytes; patches counted as the patch value, so the
  // Convex-side write size is the full row + its index entries).
  // The Phase 2 subscription: credentials, newest device-scope document (Phase 2 docs are
  // small), the device row only when there is none (+ the group-scope document). Measured 2 / 0.5 KB.
  // Step 8: the Phase 2 ALIAS reads the head and the newest body by id (~13 KB once; bodies
  // never change, so it re-runs only on a new head); without a head, the Phase 2 rows as before.
  "devices:desiredState": { maxReads: 5, maxReadBytes: 540_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // ---- Step 8: the signed document (A5, A6). The subscription: credentials, head, group roster,
  // <= 3 x key rows (a few). Plan 5.1: <= 20 documents, <= 2 KB (`devices.test.ts` measures it).
  "devices:headState": { maxReads: 20, maxReadBytes: 2_048, maxWrites: 0, maxWriteBytes: 0, live: true },
  // One-shot: credentials + one body (<= MAX_PAYLOAD_BYTES; ~13 KB typical), once per version.
  "devices:fetchDesired": { maxReads: 2, maxReadBytes: 530_000, maxWrites: 0, maxWriteBytes: 0 },
  // One-shot: credentials, device, roster row, <= 201 entries (~300 B) or the snapshot.
  "devices:fetchRoster": { maxReads: 4 + 201, maxReadBytes: 80_000, maxWrites: 0, maxWriteBytes: 0 },
  // Alias of ping + the status snapshot until deviceApi:report (Step 12). Typical (same minute):
  // 2 reads / 0.5 KB, 0 writes; new minute: 1 write (liveness, ~250 B row); with a changed status:
  // + summary and report (2 reads, <= 2 writes); outOfSupport flip: + orgStats; offline -> online:
  // + presence and one shard (2 reads, 2 writes); pre-migration device: + devices row, orgPlans,
  // platformSettings. Worst case below.
  "devices:heartbeat": { maxReads: 10, maxReadBytes: 40_960, maxWrites: 7, maxWriteBytes: 36_864 },
  // Plan row (post-Phase-5 2.13) is "2 reads, 1 KB, 1 write, 512 B": that is the common case and
  // holds (measured 2 / 0.5 KB, 0-1 write). An offline -> online transition adds presence + shard
  // (4 reads, 3 writes); a settled rotation adds the credentials patch.
  "devices:ping": { maxReads: 4, maxReadBytes: 2_048, maxWrites: 4, maxWriteBytes: 1_536 },
  // credentials, device, summary, orgStats, liveness, presence, shard; writes: credentials,
  // orgStats, liveness, shard, presence, audit. Measured 7 / 1.6 KB, 6 writes.
  "devices:unenroll": { maxReads: 8, maxReadBytes: 4_096, maxWrites: 6, maxWriteBytes: 2_048 },

  // ---- Step 12: the device API (A9, A12). Counts include the wrapper's credentials read.
  // Sign-in: the action + ONE query (credentials, limiter check, device, org, liveness,
  // employee, lockout, secret, membership = 9). Success writes nothing unless liveness is due
  // (+ the finish mutation: credentials, liveness, 1 write; a lockout row to clear: +1 read,
  // 1 delete). Wrong password: + limiter row, lockout row (insert / patch); the locking one
  // also reads employee + device and writes the audit row.
  "deviceApi:verifyEmployee": { maxReads: 9 + 6, maxReadBytes: 8_192, maxWrites: 5, maxWriteBytes: 2_048 },
  // credentials; status: summary + report (2 reads, <= 2 writes, compat <= 32 KB) + orgStats on
  // an outOfSupport flip; installs (<= 50): app + result each (<= 100 reads, <= 50 writes) +
  // orgStats; Step 17 review: + the device (its group tags every row) + <= 2 assignment lookups per result
  // (does the result count before / after); audit (<= 50): device + one event-key lookup each (+ the dropped row). A replay
  // writes nothing (`deviceApi.test.ts` measures it).
  "deviceApi:report": { maxReads: 1 + 3 + 101 + 1 + 100 + 52, maxReadBytes: 120_000, maxWrites: 2 + 1 + 51 + 51, maxWriteBytes: 90_000 },
  "deviceApi:reportAudit": { maxReads: 1 + 52, maxReadBytes: 40_000, maxWrites: 51, maxWriteBytes: 40_000 },
  "deviceApi:reportInstalls": { maxReads: 1 + 101 + 1 + 100, maxReadBytes: 60_000, maxWrites: 51, maxWriteBytes: 20_000 },
  // credentials (wrapper; + its settle patch), credentials again, device; writes: credentials, audit.
  "deviceApi:rotateCredential": { maxReads: 3, maxReadBytes: 2_048, maxWrites: 3, maxWriteBytes: 1_024 },

  // ---- Step 7: fleet (dashboard). Member wrapper = 3 reads; writes + step-up row = 4.
  // One page: 50 x (devices + summary + presence) + groups map (tiny) + wrapper. Measured for 50
  // new-shape devices: 153 reads / 34 KB. (Devices enrolled before Step 7 carry ~1.5 KB of
  // deprecated fields until `maintenance:narrowDevices` ran.) Re-runs on device, summary or
  // presence changes only, never on pings.
  // Step 8: + one head per row (~250 B) for `latestVersion`.
  "fleet:list": { maxReads: 300, maxReadBytes: 81_920, maxWrites: 0, maxWriteBytes: 0, live: true },
  // device, credentials, report (compat <= 32 KB), summary, presence, groups (tiny). Measured 8 / 2.1 KB.
  // Step 8: + the last 5 version rows (~150 B each).
  "fleet:get": { maxReads: 3 + 5 + 50 + 5, maxReadBytes: 50_176, maxWrites: 0, maxWriteBytes: 0, live: true },
  // device; writes: device, audit. Unchanged: 0 writes. Measured 5 / 1.1 KB, 2 writes.
  "fleet:rename": { maxReads: 5, maxReadBytes: 4_096, maxWrites: 2, maxWriteBytes: 1_024 },
  // device, credentials, group, orgStats, publishQueue; writes: device, orgStats, queue, audit
  // (+ one scheduled publish run). Measured 8 / 1.7 KB, 4 writes.
  // Step 17 review: + the PC's install results re-tagged (<= 200 per run, `stats:retagDevice` continues)
  // with the app and the old / new assignment of each failed one; + their patches and orgStats.
  "fleet:move": { maxReads: 9 + 200 + 200 + 400, maxReadBytes: 400_000, maxWrites: 4 + 200 + 1, maxWriteBytes: 60_000 },
  // device, credentials, (off: step-up row again), publishQueue; writes: device, queue, audit.
  "fleet:setKiosk": { maxReads: 9, maxReadBytes: 6_144, maxWrites: 3, maxWriteBytes: 2_048 },
  // device, credentials, device again, summary, orgStats, liveness, shard, presence; writes:
  // credentials, orgStats, liveness, shard, presence, audit. Already revoked: 0 writes.
  // Step 17 review: + the PC's install results un-tagged (as fleet:move).
  "fleet:revoke": { maxReads: 13 + 200 + 200 + 200, maxReadBytes: 400_000, maxWrites: 6 + 200, maxWriteBytes: 60_000 },
  // device, credentials, the 6 per-device rows; deletes them + the device, audit, one scheduled
  // purge (installResults / documents, PURGE_BATCH per run). Not revoked: 0 writes.
  "fleet:remove": { maxReads: 12, maxReadBytes: 49_152, maxWrites: 8, maxWriteBytes: 1_024 },
  // device, credentials; writes: credentials, audit. Already requested: 0 writes.
  "fleet:requestCredentialRotation": { maxReads: 6, maxReadBytes: 4_096, maxWrites: 2, maxWriteBytes: 1_024 },
  // device, orgPlans (+ platformSettings), liveness, credentials; writes: liveness only when it
  // extends `fastUntil` by >= 2 min (+ limiter row). Measured 6 / 1.6 KB, 0-1 write.
  // Step 8: + the head (fastUntil) when it writes.
  "fleet:watch": { maxReads: 9, maxReadBytes: 4_608, maxWrites: 3, maxWriteBytes: 768 },
  // The one watched liveness row (+ device). Re-runs at most once a minute while watched.
  "fleet:liveness": { maxReads: 4, maxReadBytes: 2_048, maxWrites: 0, maxWriteBytes: 0, live: true },
  // <= 50 x (device + liveness) + limiter; writes: check row + <= 50 liveness patches + limiter.
  // Measured for 50: 104 reads / 25 KB, 51 writes / 4.4 KB. 1 per minute per organization.
  // Step 8: + <= 50 heads read and patched (`pingNonce`).
  "fleet:checkNow": { maxReads: 3 + 1 + 150 + 1, maxReadBytes: 45_056, maxWrites: 103, maxWriteBytes: 20_480 },
  // check row + <= 50 liveness rows; subscribed for <= 60 s. Measured 54 / 17.6 KB.
  "fleet:checkResult": { maxReads: 3 + 1 + 50, maxReadBytes: 24_576, maxWrites: 0, maxWriteBytes: 0, live: true },

  // ---- Step 8: Settings -> Signing (keys.ts). Wrapper 3 reads (+1 step-up for writes).
  // key rows (3 index reads, a few rows), the env key's row, orgStats.
  // Step 17 follow-up: + one `rosterPending` row (`rosterPending` flag).
  "keys:status": { maxReads: 3 + 11, maxReadBytes: 6_144, maxWrites: 0, maxWriteBytes: 0, live: true },
  // next key + one page of <= 200 devices x (device, presence, summary). Step 17 follow-up: the
  // summary carries `trustedKeyIds`; the report (compat <= 32 KB) is read only for a summary written
  // before that field existed (it is rewritten at the agent's next report). The byte cap keeps that worst case.
  "keys:trustProgress": { maxReads: 3 + 1 + 600, maxReadBytes: 6_500_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // key by id, key rows; writes: retire old rows (force), insert, audit, queue + scheduled run.
  "keys:registerActive": { maxReads: 4 + 12, maxReadBytes: 8_192, maxWrites: 8, maxWriteBytes: 4_096 },
  // active key row, key by id, next row; writes: insert (with endorsement), audit.
  "keys:prepareRotation": { maxReads: 4 + 3, maxReadBytes: 4_096, maxWrites: 2, maxWriteBytes: 2_048 },
  // key rows; writes: retire old, activate next, audit, queue + scheduled run.
  "keys:finishRotation": { maxReads: 4 + 11, maxReadBytes: 8_192, maxWrites: 5, maxWriteBytes: 3_072 },

  // ---- Step 10: apps, assignments, file types. Wrapper 3 reads (+1 step-up for writes). A change
  // that alters a document ends in `publishApp`: assignments by app (<= 501), grants (<= 51) with
  // their groups (<= 21 each, only when grants exist), the publish queue (1 read; insert or patch
  // + one scheduled run) = typically 3 reads, 2 writes.
  // One page of <= 50 apps, each with its group count (`.take(101)`) and icon address. Never
  // `installResults`. RISK: 50 apps each in 100 groups read ~5,000 assignments; a free tenant
  // (20 apps, 3 groups) reads ~80.
  "apps:list": { maxReads: 3 + 50 + 50 * 101, maxReadBytes: 900_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // app, assignments (<= 500), groups (<= 500), file types (<= 201), direct grants (<= 1,001).
  "apps:get": { maxReads: 3 + 1 + 500 + 500 + 201 + 1001, maxReadBytes: 700_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // <= 500 non-archived apps (the group page's picker; subscribed only while its dialog is open).
  "apps:options": { maxReads: 3 + 500, maxReadBytes: 500_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // orgPlans, orgStats (+ platformSettings before migration); writes: app, orgStats, audit.
  "apps:createWeb": { maxReads: 4 + 3, maxReadBytes: 4_096, maxWrites: 3, maxWriteBytes: 4_096 },
  // as createWeb, + the portable app's path patched once its id is known.
  "apps:createDesktop": { maxReads: 4 + 3, maxReadBytes: 4_096, maxWrites: 4, maxWriteBytes: 8_192 },
  // app, file types (only when the file argument is cleared), publishApp; unchanged: 1 read, 0 writes.
  "apps:update": { maxReads: 4 + 1 + 1 + 501 + 51 + 51 * 21 + 1, maxReadBytes: 250_000, maxWrites: 4, maxWriteBytes: 8_192 },
  // app, orgPlans/orgStats when restoring, publishApp; writes: app, orgStats, audit, queue (+ scheduled run).
  // Step 17 review: + assignments (<= 500) and <= 501 failed results (failedInstallCount follows).
  "apps:setArchived": { maxReads: 4 + 1 + 3 + 501 + 51 + 51 * 21 + 1 + 500 + 501, maxReadBytes: 500_000, maxWrites: 5, maxWriteBytes: 4_096 },
  // app, assignments `.first()`, file types `.first()`; writes: app, audit, one scheduled purge (+ icon file).
  "apps:remove": { maxReads: 4 + 3, maxReadBytes: 6_144, maxWrites: 3, maxWriteBytes: 2_048 },
  // app, publishApp; writes: app, audit, queue (`purgeApp`, internal: <= 100 install results + <= 100 grants per run).
  "apps:retry": { maxReads: 4 + 1 + 501 + 51 + 51 * 21 + 1, maxReadBytes: 250_000, maxWrites: 4, maxWriteBytes: 4_096 },
  // authorize (4) + attachIcon: app, publishApp; writes: app, audit, queue. The upload is an action.
  "apps:saveIcon": { maxReads: 4 + 1 + 501 + 51 + 51 * 21 + 1, maxReadBytes: 250_000, maxWrites: 4, maxWriteBytes: 4_096 },
  // authorize (4) + 2 rate-limiter rows; the fetch is outside the database.
  "apps:fetchWebMeta": { maxReads: 6, maxReadBytes: 4_096, maxWrites: 1, maxWriteBytes: 512 },
  // authorize (4) + cache lookup + cache write + 2 rate-limiter rows (a cached answer reads 5).
  "apps:resolveWinget": { maxReads: 8, maxReadBytes: 8_192, maxWrites: 2, maxWriteBytes: 4_096 },
  // <= 201 rules, <= 500 apps (the picker).
  "fileHandlers:list": { maxReads: 3 + 201 + 500 + 10, maxReadBytes: 500_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // app, rule by extension, rules (<= 200, only for a new one), publishApp x2; writes: rule, audit, queue.
  "fileHandlers:set": { maxReads: 4 + 1 + 1 + 200 + 2 * (501 + 51 + 51 * 21) + 1, maxReadBytes: 500_000, maxWrites: 4, maxWriteBytes: 2_048 },
  // rule, app, publishApp; writes: delete, audit, queue.
  "fileHandlers:remove": { maxReads: 4 + 2 + 501 + 51 + 51 * 21 + 1, maxReadBytes: 250_000, maxWrites: 4, maxWriteBytes: 2_048 },
  // group, app, assignment `.first()`, assignments (<= 150), publish queue; writes: assignment, audit, queue.
  // Step 17 review: + <= 501 failed results of the app (does the group's count move) + orgStats.
  "groups:assignApp": { maxReads: 4 + 2 + 1 + 150 + 1 + 501 + 1, maxReadBytes: 60_000, maxWrites: 4, maxWriteBytes: 2_048 },
  // assignment, group, app, queue; unchanged: 1 read, 0 writes.
  "groups:updateAssignment": { maxReads: 4 + 4, maxReadBytes: 6_144, maxWrites: 3, maxWriteBytes: 2_048 },
  "groups:unassignApp": { maxReads: 4 + 4 + 501 + 1, maxReadBytes: 250_000, maxWrites: 5, maxWriteBytes: 2_048 },

  // ---- Step 11: employees. Worst cases are the caps (100 groups, 50 grants per employee);
  // a typical call (1-3 groups, no grants) reads under 20 documents.
  // wrapper (3) + a page of <= 50 + the groups (<= 500, tiny) + <= 6 memberships per row (+ 50 gets for a group's page).
  "employees:list": { maxReads: 3 + 1 + 50 + 50 + 500 + 50 * 6, maxReadBytes: 400_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // wrapper + group + <= 51 hits + a membership check each + groups + rows' memberships.
  "employees:search": { maxReads: 3 + 1 + 51 + 51 + 500 + 50 * 6, maxReadBytes: 400_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // wrapper + groups (<= 500) + apps (<= 500) + the organization.
  "employees:options": { maxReads: 3 + 500 + 500 + 1, maxReadBytes: 500_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // wrapper + employee + <= 101 memberships + <= 50 grants + lockout + the pickers. Never `employeeSecrets`.
  "employees:get": { maxReads: 3 + 1 + 101 + 50 + 1 + 1001, maxReadBytes: 520_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // authorize (4) + storeNew: username check, <= 100 groups, <= 50 apps, orgPlans + orgStats (+ platformSettings),
  // orgStats for the group room, key row, <= 100 groupRoster rows (+ a snapshot per 200 entries), queue; writes:
  // employee, secret, <= 100 members, <= 50 grants, <= 100 roster entries + <= 100 roster rows, stats, audit, queue (+ run).
  "employees:create": { maxReads: 4 + 1 + 100 + 50 + 3 + 1 + 1 + 100 * 2 + 2, maxReadBytes: 120_000, maxWrites: 1 + 1 + 100 + 50 + 200 + 1 + 1 + 3, maxWriteBytes: 90_000 },
  // employee, username check, <= 101 memberships, <= 100 roster rows + key; writes: employee, <= 100 x (entry + roster row), audit.
  "employees:update": { maxReads: 4 + 1 + 1 + 101 + 1 + 100 * 2, maxReadBytes: 80_000, maxWrites: 1 + 200 + 1, maxWriteBytes: 60_000 },
  // employee, <= 100 groups, <= 101 memberships, group names, stats (when 2,000 employees), key, roster rows; writes: members, entries, roster rows, employee, audit, queue.
  "employees:setGroups": { maxReads: 4 + 1 + 100 + 101 + 100 + 2 + 1 + 100 * 2 + 3, maxReadBytes: 120_000, maxWrites: 100 + 200 + 1 + 1 + 3, maxWriteBytes: 90_000 },
  // employee, <= 50 apps, <= 51 grants, memberships (<= 101), queue; writes: grants, employee, audit, queue (+ run).
  "employees:setDirectApps": { maxReads: 4 + 1 + 50 + 51 + 101 + 1, maxReadBytes: 60_000, maxWrites: 50 + 1 + 1 + 3, maxWriteBytes: 20_000 },
  // authorize (4) + target query (1) + storePassword: employee, secret, memberships (<= 101), key, roster rows; the limiter row.
  "employees:setPassword": { maxReads: 4 + 1 + 1 + 1 + 101 + 1 + 100 + 2, maxReadBytes: 60_000, maxWrites: 1 + 1 + 200 + 1 + 1, maxWriteBytes: 60_000 },
  // employee, memberships, key, roster rows, grants `.first()`, queue; writes: entries, roster rows, employee, stats, audit, queue.
  "employees:setDisabled": { maxReads: 4 + 1 + 101 + 1 + 100 + 3 + 1 + 1, maxReadBytes: 60_000, maxWrites: 200 + 1 + 1 + 1 + 3, maxWriteBytes: 60_000 },
  // employee, lockout; none: 0 writes.
  "employees:unlock": { maxReads: 4 + 2, maxReadBytes: 2_048, maxWrites: 2, maxWriteBytes: 1_024 },
  // employee, secret, lockout, <= 101 memberships, <= 51 grants, stats; writes: deletes of all of those, stats, audit.
  "employees:remove": { maxReads: 4 + 1 + 1 + 1 + 101 + 51 + 1, maxReadBytes: 40_000, maxWrites: 1 + 1 + 1 + 100 + 50 + 1 + 1, maxWriteBytes: 4_096 },
  // group, employee, membership `.first()`, memberships (<= 101), stats, key, roster row, grants `.first()`, queue.
  "groups:addEmployee": { maxReads: 4 + 2 + 1 + 101 + 1 + 1 + 1 + 1 + 1, maxReadBytes: 40_000, maxWrites: 7, maxWriteBytes: 4_096 },
  "groups:removeEmployee": { maxReads: 4 + 2 + 1 + 1 + 1 + 1 + 1 + 1, maxReadBytes: 40_000, maxWrites: 7, maxWriteBytes: 4_096 },

  // ---- Step 17: install status, overview, audit, history. Wrapper 3 reads.
  // The app, then per state `.take(1,001)` of its results (only 5 states are ever stored). RISK: this is
  // the one dashboard query whose cost grows with the fleet: an app on 5,000 PCs reads ~5,000 results
  // (~1 MB) and re-runs on every result change of that app while its page is open. It is a query of its
  // own (not part of `apps:get`) and subscribed only by the open App page's install panel; a counter per
  // (app, state) would replace it if a rollout to thousands of PCs is ever watched live.
  "apps:installSummary": { maxReads: 3 + 1 + 500 + 5 * 1_001, maxReadBytes: 1_100_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // app + its assignments (<= 500; only results of an assigning group count) + a page of <= 50 results + their devices.
  "apps:installs": { maxReads: 3 + 1 + 500 + 50 + 50, maxReadBytes: 60_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // device + its group's assignments (<= 150) + a page of <= 50 results + their apps (one get each; an app spec is ~1-2 KB).
  "fleet:installs": { maxReads: 3 + 1 + 150 + 50 + 50, maxReadBytes: 160_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // Plan row (A7): <= 60 documents, <= 32 KB. counters, <= 4 online shards, plan (+ platformSettings
  // before migration), 2 key rows, 10 audit rows, 1 rosterPending row = ~25; never a device, liveness, payload or result row.
  // Re-runs on a counter change, a PC going online / offline and a new audit row; never on a ping.
  "overview:get": { maxReads: 60, maxReadBytes: 32_768, maxWrites: 0, maxWriteBytes: 0, live: true },
  // Step 17 review: <= 100 failed results examined (newest `updatedAt`) for 20 that count, their apps and
  // (group, app) assignments (cached per call) and the 20 PCs; subscribed only while `failedInstallCount` > 0.
  "overview:failedInstalls": { maxReads: 3 + 100 + 100 + 100 + 20, maxReadBytes: 300_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // A page of <= 50 audit rows (~300 B each). Re-runs when a row is written inside the loaded range.
  "audit:list": { maxReads: 3 + 50, maxReadBytes: 40_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  "audit:forTarget": { maxReads: 3 + 50, maxReadBytes: 40_000, maxWrites: 0, maxWriteBytes: 0, live: true },
};
