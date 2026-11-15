// Database I/O budget per public AND internal function (post-Phase-5 plan 2.13, A16).
// `convex/ioBudgets.test.ts` (Phase 4 Step 18) enforces these rows: it seeds the
// large-org fixture, calls every public function (and, via `tests/convex/ioInternal.ts`,
// every internal one) with the I/O probe on, and fails a function without a row or over
// its budget. Every new public or internal function adds its row here (plan 4.2.1).
// Internal queries / mutations are built with `internalQuery` / `internalMutation` from
// `lib/functions.ts`, which count their `ctx.db` like the public wrappers do, so the
// number of an action is the sum of the internal functions it calls. Not counted: the
// rate limiter and other components (their rows live in the component's own tables), file
// storage, and anything that runs later from the scheduler (each scheduled function has
// its own row).
//
// Counts are documents per call INCLUDING the member wrapper: `requireMember`
// reads the session and the memberships (normally 1) (2); member
// writes also read the step-up row (1) and patch it at most once per 4
// minutes of activity (not counted below). Bytes are estimates (rows of
// ~150-450 B). `live`: subscribed by the dashboard.

/** `GROUP_COUNT_CAP + 1`: the devices read to count a group's PCs. */
const GROUP_COUNT_CAP_READ = 501;

export type IoBudget ={ maxReads: number; maxReadBytes: number; maxWrites: number; maxWriteBytes: number; live?: true };

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
  // Step 18 (large-org probe: 10 groups, 200 PCs, 300 employees): measured 514 reads / 121 KB, so the
  // row below is the LARGE-org case. The free tenant stays under ~100 reads / 40 KB. Same RISK as above.
  "groups:list": { maxReads: 3 + 500 + 100, maxReadBytes: 140_000, maxWrites: 0, maxWriteBytes: 0, live: true },
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
  // Step 18 probe: 7 reads / 1.7 KB, 7 writes (+ the PC's `installResults` tag clear, `.first()` read).
  "devices:unenroll": { maxReads: 9, maxReadBytes: 4_096, maxWrites: 8, maxWriteBytes: 2_048 },

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
  // ---- Phase 5 Step 10: the lockdown reports (plan 4.11, 4.19). Every one writes NOTHING when nothing changed (the write-count
  // tests in `lockdownReports.test.ts` pin that); the numbers below are the call that does write. The rate limiter (one
  // `deviceReports` token per call that wrote, `deviceWrites` per row) is a component call, not counted.
  // credentials (wrapper), the device's one report row, the group named in `config`; writes: the report (insert or replace, ~2.5 KB).
  "deviceApi:reportApply": { maxReads: 4, maxReadBytes: 8_192, maxWrites: 2, maxWriteBytes: 6_144 },
  // credentials; per finding (<= MAX_FINDINGS_PER_CALL = 50): the finding by (org, fingerprint) and, when it exists, the (finding, device) link;
  // writes per NEW pair: the link + the finding (insert, or patch of `deviceCount`). A repeat reads 2 and writes 0.
  "deviceApi:reportFindings": { maxReads: 1 + 2 * 50, maxReadBytes: 40_000, maxWrites: 2 * 50, maxWriteBytes: 60_000 },
  // credentials, the device's row of that day; writes: insert or patch of the day's row (<= 100 denials, ~1.5 KB typical, ~7 KB worst).
  "deviceApi:reportSecurityDaily": { maxReads: 3, maxReadBytes: 12_288, maxWrites: 2, maxWriteBytes: 12_288 },
  // credentials, the device; per acknowledgement (<= MAX_ACKS_PER_CALL = 20): the broadcast and the device's ack row; writes: one ack row and
  // (Step 15) the broadcast's `ackCount` patch each.
  "deviceApi:reportAcks": { maxReads: 2 + 2 * 20, maxReadBytes: 24_000, maxWrites: 2 * 20 + 1, maxWriteBytes: 12_288 },
  // credentials, the device, and on a REPLACEMENT the old key's sealed boxes (<= MAX_DEVICE_WIFI + 1); writes: the device patch + those
  // boxes deleted (+ the credentials settle patch) and one scheduled `seal:forDevices`. A repeat of the same key writes nothing.
  "deviceApi:registerSealKey": { maxReads: 2 + 21, maxReadBytes: 24_576, maxWrites: 1 + 21 + 1, maxWriteBytes: 4_096 },

  // ---- Step 7: fleet (dashboard). Member wrapper = 3 reads; writes + step-up row = 4.
  // One page: 50 x (devices + summary + presence) + groups map (tiny) + wrapper. Measured for 50
  // new-shape devices: 153 reads / 34 KB. (Devices enrolled before Step 7 carry ~1.5 KB of
  // deprecated fields until `maintenance:narrowDevices` ran.) Re-runs on device, summary or
  // presence changes only, never on pings.
  // Step 8: + one head per row (~250 B) for `latestVersion`.
  "fleet:list": { maxReads: 300, maxReadBytes: 81_920, maxWrites: 0, maxWriteBytes: 0, live: true },
  // device, credentials, report (compat <= 32 KB), summary, presence, groups (tiny). Measured 8 / 2.1 KB.
  // Step 8: + the last 5 version rows (~150 B each).
  // Step 15: + the PC's lock (<= 1).
  "fleet:get": { maxReads: 3 + 5 + 50 + 5 + 1, maxReadBytes: 50_176 + 1_024, maxWrites: 0, maxWriteBytes: 0, live: true },
  // Step 15 (plan 4.17): device, credentials, the old lock, publishQueue (+ step-up row); writes: old lock deleted, new lock, its `lockId` patch,
  // queue, audit (+ one scheduled publish run). The same text again: 0 writes.
  "fleet:lock": { maxReads: 12, maxReadBytes: 8_192, maxWrites: 6, maxWriteBytes: 4_096 },
  // device, the lock, publishQueue (+ step-up row); writes: lock deleted, queue, audit. Not locked: 0 writes.
  "fleet:unlock": { maxReads: 9, maxReadBytes: 6_144, maxWrites: 3, maxWriteBytes: 2_048 },
  // device; writes: device, audit. Unchanged: 0 writes. Measured 5 / 1.1 KB, 2 writes.
  "fleet:rename": { maxReads: 5, maxReadBytes: 4_096, maxWrites: 2, maxWriteBytes: 1_024 },
  // device, credentials, group, orgStats, publishQueue; writes: device, orgStats, queue, audit
  // (+ one scheduled publish run). Measured 8 / 1.7 KB, 4 writes.
  // Step 17 review: + the PC's install results re-tagged (<= 200 per run, `stats:retagDevice` continues)
  // with the app and the old / new assignment of each failed one; + their patches and orgStats.
  "fleet:move": { maxReads: 9 + 50 + 200 + 200 + 400, maxReadBytes: 400_000, maxWrites: 4 + 50 + 200 + 1, maxWriteBytes: 60_000 },
  // device, credentials, (off: step-up row again), publishQueue; writes: device, queue, audit.
  "fleet:setKiosk": { maxReads: 9, maxReadBytes: 6_144, maxWrites: 3, maxWriteBytes: 2_048 },
  // device, credentials, device again, summary, orgStats, liveness, shard, presence; writes:
  // credentials, orgStats, liveness, shard, presence, audit. Already revoked: 0 writes.
  // Step 17 review: + the PC's install results un-tagged (as fleet:move). Step 14b: + <= 50 driver results re-tagged (first page only).
  "fleet:revoke": { maxReads: 13 + 50 + 200 + 200 + 200, maxReadBytes: 400_000, maxWrites: 6 + 50 + 200, maxWriteBytes: 60_000 },
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
  // Phase 5 Step 10: + the organization's own signing key row (`loadOrgSigningKey` reads it to open the seed) and the two
  // active `orgKeys` rows (signing, sealing) for the `orgKeys` block: +3 reads of rows that hold a wrapped key (~0.3 KB each).
  "keys:status": { maxReads: 3 + 11 + 3, maxReadBytes: 8_192, maxWrites: 0, maxWriteBytes: 0, live: true },
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
  // Phase 5 Step 10 (an action): authorize (4) + `storeMigratedKey` (its own row below); the env seed and the master key never touch the database.
  "keys:migrateFromEnv": { maxReads: 4 + 4, maxReadBytes: 6_144, maxWrites: 4, maxWriteBytes: 3_072 },

  // ---- Step 10: apps, assignments, file types. Wrapper 3 reads (+1 step-up for writes). A change
  // that alters a document ends in `publishApp`: assignments by app (<= 501), grants (<= 51) with
  // their groups (<= 21 each, only when grants exist), the publish queue (1 read; insert or patch
  // + one scheduled run) = typically 3 reads, 2 writes.
  // One page of <= 50 apps, each with its group count (`.take(101)`) and icon address. Never
  // `installResults`. RISK: 50 apps each in 100 groups read ~5,000 assignments; a free tenant
  // (20 apps, 3 groups) reads ~80.
  "apps:list": { maxReads: 3 + 50 + 50 * 101, maxReadBytes: 900_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // app, assignments (<= 500), groups (<= 500), file types (<= 201), direct grants (<= 1,001).
  // Phase 5 Step 11: + the last 30 `orgSecurityDaily` rows (a website only; each <= 500 denial rows of ~90 B =
  // 45 KB worst case, a few hundred bytes in practice). They change once a day (the 01:00 UTC rollup), so the
  // subscription is not re-run by device reports. UNSURE: the byte cap is the worst case, not a measurement.
  "apps:get": { maxReads: 3 + 1 + 500 + 500 + 201 + 1001 + 30, maxReadBytes: 2_000_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // <= 500 non-archived apps (the group page's picker; subscribed only while its dialog is open).
  "apps:options": { maxReads: 3 + 500, maxReadBytes: 500_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // orgPlans, orgStats (+ platformSettings before migration); writes: app, orgStats, audit.
  "apps:createWeb": { maxReads: 4 + 3, maxReadBytes: 4_096, maxWrites: 3, maxWriteBytes: 4_096 },
  // as createWeb, + the portable app's path patched once its id is known.
  "apps:createDesktop": { maxReads: 4 + 3, maxReadBytes: 4_096, maxWrites: 4, maxWriteBytes: 8_192 },
  // app, file types (only when the file argument is cleared), publishApp; unchanged: 1 read, 0 writes.
  "apps:update": { maxReads: 4 + 1 + 1 + 501 + 51 + 51 * 21 + 1, maxReadBytes: 250_000, maxWrites: 4, maxWriteBytes: 8_192 },
  // Phase 5 Step 11. Same permissions again: app only (wrapper + 1 read, 0 writes). A change: app, assignments
  // (<= 11), one `snapshotGroupConfig` per group (<= 10; each worst case: group, lockdown, org, exceptions
  // 2 x 201, Wi-Fi 51, printers 101, newest version, rollout, prune 10 = ~570 reads) and publishApp (as
  // `apps:update`). Writes: app, audit, per group <= 13 (version, rollout, <= 10 pruned versions, queue merge)
  // + queue. Bytes: a snapshot is <= 256 KiB (MAX_GROUP_CONFIG_BYTES) but a typical one is ~2 KB.
  // UNSURE: worst-case numbers, not measured (the matrix call is the no-change case).
  "apps:setPermissions": { maxReads: 4 + 1 + 11 + 10 * 621 + 501 + 51 + 51 * 21 + 1, maxReadBytes: 2_500_000, maxWrites: 4 + 10 * 13, maxWriteBytes: 2_700_000 },
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
  // Phase 4b: the row is restated (with the search + group checks) in the Phase 4b block below.
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
  // MEASURED 5 reads / 1.2 KB, 3 writes (authorize + passwordTarget + `employees:storePassword`; Step 18 item 9).
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
  // A page of <= 50 audit rows (~300 B each). Re-runs when a row is written inside the loaded range.
  "audit:list": { maxReads: 3 + 50, maxReadBytes: 40_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  "audit:forTarget": { maxReads: 3 + 50, maxReadBytes: 40_000, maxWrites: 0, maxWriteBytes: 0, live: true },

  // ---- Phase 4b Part A: server-driven lists (lib/listing.ts). `sort` / `search` / page size do not
  // change the rows above: a sort is one index range like the default order (fleet:list,
  // employees:list, apps:list, enrollmentCodes:list, audit:list / forTarget, apps:installs,
  // fleet:installs), a search reads one page of hits. Exceptions are re-stated below.
  // employees:list with `search` + `groupId`: + one `groupMembers.by_group_employee` check per hit (<= 50).
  "employees:list": { maxReads: 3 + 1 + 50 + 50 + 50 + 500 + 50 * 6, maxReadBytes: 400_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // Totals (`<table>:count`): wrapper + the one `orgStats` row (~400 B), never a list row. Re-run on any
  // counter write of the organization, which is why they are separate from the lists.
  "fleet:count": { maxReads: 3 + 1, maxReadBytes: 2_048, maxWrites: 0, maxWriteBytes: 0, live: true },
  "employees:count": { maxReads: 3 + 1, maxReadBytes: 2_048, maxWrites: 0, maxWriteBytes: 0, live: true },
  "apps:count": { maxReads: 3 + 1, maxReadBytes: 2_048, maxWrites: 0, maxWriteBytes: 0, live: true },
  // Small bounded tables, sorted / searched / paged in the query with an exact `total`:
  // groups (<= 500 rows, ~200 B) + the page's device / employee counts (`.take(501)` each, as groups:list
  // but for <= numItems groups instead of all of them). Free tenant (3 groups, 2 PCs, 25 employees): ~35.
  // RISK (unchanged from groups:list): a page of 50 big groups reads up to 50 x 1,002 count rows.
  "groups:page": { maxReads: 3 + 500 + 100, maxReadBytes: 140_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // members (<= 200); no per-row reads (the TOTP lookup per row went away with TOTP, WP5b).
  "members:page": { maxReads: 3 + 200, maxReadBytes: 60_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // the newest invites (<= 100).
  "members:invitesPage": { maxReads: 3 + 100, maxReadBytes: 40_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // rules (<= 201) + one app per distinct program (<= 201; app specs ~1-2 KB).
  "fileHandlers:page": { maxReads: 3 + 201 + 201, maxReadBytes: 450_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // a page of <= 50 failed results, their apps and (group, app) assignments (cached per call), their PCs.
  "overview:failedInstallsPage": { maxReads: 3 + 50 + 50 + 50 + 50, maxReadBytes: 160_000, maxWrites: 0, maxWriteBytes: 0, live: true },

  // ---- Phase 4b Parts B and C: PIN at sign-in, recovery codes, forgot PIN by email.
  // Public query (signed-out: 0-1 reads): session, memberships (<= 20), their orgs (<= 20) and the
  // person's `stepUpFactors` row (1; changes only when the PIN, its recovery codes or a passkey id
  // change, never on a wrong attempt: those counters live in `pinCounters`). NO secret, flag or
  // counter row (security review finding 7); the lock screen's lockout, attempts and "reset by email"
  // are in `stepUp:status.pin`.
  "account:me": { maxReads: 1 + 20 + 20 + 1, maxReadBytes: 16_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // Public action, SESSION-BOUND (no email argument): the caller's session (query: session row), then 2
  // limiter rows (per user, global; read + write each) and one scheduled run. The scheduled
  // `deliverPinReset` (only with mail configured): 3 secret reads, then createPinReset: user,
  // memberships (<= 20), the person's newest links (<= 10, unused ones deleted), insert, one audit row
  // per active membership (<= 20); then one Resend call.
  "account:requestPinReset": { maxReads: 1 + 2 + 3 + 1 + 20 + 10, maxReadBytes: 24_000, maxWrites: 2 + 1 + 10 + 20, maxWriteBytes: 16_000 },
  // NOTE (security follow-up): sessions per person are capped at MAX_USER_SESSIONS (25) by
  // `pruneOldSessions` at every sign-in, so the "<= 101 sessions" bounds below are now far looser
  // than the real worst case (<= 25). `stepUp:setActionPin` also schedules one notice mail and,
  // on a change, deletes the other sessions' step-up rows (<= 25). No query changed cost.
  // ESTIMATE (the matrix call answers `invalid_argument`: the current password is checked by Convex Auth; the internal
  // parts `account:passwordAccountOf` and `account:finishPasswordChange` are measured below).
  // Self-service password change (major action: authorize = session, member, step-up row; then the
  // limiter row, the password account + Convex Auth's own verification, `modifyAccountCredentials`).
  // finishPasswordChange: the person's other sessions (<= 101) + refresh tokens (~2 each) + step-up
  // rows (<= 100), memberships (<= 20), one audit row per membership, one scheduled notice.
  "account:changePassword": { maxReads: 6 + 4 + 101 + 202 + 100 + 20, maxReadBytes: 100_000, maxWrites: 4 + 101 + 202 + 100 + 20 + 1, maxWriteBytes: 32_000 },
  // Public action: session (query), limiter (1 read, 1 write); finishPinReset: token row, session,
  // PIN row, the person's links (<= 10), their sessions (<= 101) + refresh tokens (~2 each) + step-up
  // rows (<= 100) for the sign-out of every other session, step-up row, user,
  // memberships (<= 20); writes: token, PIN row, deletes, step-up row, one audit row per membership,
  // one scheduled notice. A wrong / spent token: 1-2 reads, 0-1 write (the burn).
  // MEASURED (Step 18, internal calls now counted; a fresh session, a valid link): 9 reads / 1.5 KB,
  // 4 writes. Lowered from 441 / 437: sessions per person are capped at MAX_USER_SESSIONS = 25 (see
  // the NOTE above), so the worst case is pinResetCaller (3) + finishPinReset (`account:finishPinReset`
  // below, 135 reads / 123 writes).
  "account:redeemPinReset": { maxReads: 3 + 135, maxReadBytes: 45_000, maxWrites: 2 + 123, maxWriteBytes: 24_000 },
  // authorize (wrapper + step-up row) + PIN row; writes: PIN row (10 hashes, ~700 B), audit.
  "stepUp:generateRecoveryCodes": { maxReads: 4 + 1, maxReadBytes: 4_096, maxWrites: 2, maxWriteBytes: 2_048 },
  // The lock screen and every signed-in page load (live on EVERY screen): wrapper (3) + the person's
  // `stepUpFactors` row (PIN hash + <= 10 recovery hashes, ~1.3 KB), their passkeys (<= MAX_PASSKEYS = 10,
  // ~400 B each), the session's `stepUpSessions` row, the `pinCounters` row (only with a PIN set) and,
  // with no PIN yet, the session row (bootstrap window). Re-runs when one of those rows changes: the
  // counters only on a wrong attempt, the step-up row at most once per activity quantum (4 minutes).
  "stepUp:status": { maxReads: 3 + 1 + 10 + 1 + 1 + 1, maxReadBytes: 12_288, maxWrites: 0, maxWriteBytes: 0, live: true },

  // ---- Step 18: rows for the functions that had none. MEASURED = the probe's number for a call that ran
  // to completion on the large-org fixture. Internal queries / mutations are counted since Step 18
  // item 9, so an ACTION is MEASURED when the test calls it with arguments that get through (the
  // internal functions it calls are in the total). An action stays ESTIMATE when the matrix call
  // stops at an early refusal (it needs WebAuthn, Convex Auth's own credential check, an Argon2 PIN
  // hash or a real reset code); its row is then built from the MEASURED rows of the internal
  // functions it calls (caps in brackets).
  // Public; no database access at all. Measured 0 / 0.
  "health:ping": { maxReads: 0, maxReadBytes: 0, maxWrites: 0, maxWriteBytes: 0 },
  // ESTIMATE (the matrix call answers `invite_invalid`; needs Convex Auth's account and a real reset code;
  // the internal parts are `account:consumeResetCode`, `account:auditPasswordReset`, `account:signOutStepUp`
  // below). Public action: limiter (1 read, 1 write), invite by token hash (1), the user (<= 3),
  // the password account (<= 2), the person's sessions (<= MAX_USER_SESSIONS = 25) + refresh tokens (~2 each),
  // invite patch, audit; writes: limiter, account, invite, deleted sessions + tokens (<= 75), audit.
  "account:redeemReset": { maxReads: 2 + 1 + 3 + 2 + 25 + 50 + 5, maxReadBytes: 40_000, maxWrites: 1 + 1 + 1 + 75 + 2, maxWriteBytes: 24_000 },
  // MEASURED 4 reads / 0.9 KB, 2 writes (authorize + `members:storeInvite`). Worst case: authorize (4) + storeInvite: member by email, orgPlans + orgStats (+ platformSettings), limiter; writes: limiter, invite, audit.
  "members:invite": { maxReads: 4 + 8, maxReadBytes: 6_144, maxWrites: 3, maxWriteBytes: 2_048 },
  // MEASURED 4 reads / 0.9 KB, 2 writes (invite, audit); an already-spent code: 4 reads, 0 writes.
  "members:revokeInvite": { maxReads: 5, maxReadBytes: 2_048, maxWrites: 2, maxWriteBytes: 1_024 },
  // MEASURED 4 reads / 0.9 KB, 2 writes. Demoting an Owner adds `assertNotLastOwner`: the members (<= MAX_MEMBERS = 200).
  "members:changeRole": { maxReads: 4 + 1 + 200, maxReadBytes: 60_000, maxWrites: 2, maxWriteBytes: 1_024 },
  // MEASURED 8 reads / 1.6 KB, 3 writes. Worst case: assertNotLastOwner (<= 200), plan counters, the person's other
  // memberships (<= 20) and, when they have none active, their sessions (<= 25) + refresh tokens + step-up rows (~4 each).
  "members:setDisabled": { maxReads: 4 + 1 + 200 + 3 + 20 + 100, maxReadBytes: 80_000, maxWrites: 3 + 100, maxWriteBytes: 40_000 },
  // MEASURED 4 reads / 0.9 KB, 2 writes (authorize + `members:storeResetCode`). Worst case: authorize (4) + the target member, limiter; writes: limiter, invite (reset code), audit.
  "members:createResetCode": { maxReads: 4 + 4, maxReadBytes: 6_144, maxWrites: 3, maxWriteBytes: 2_048 },
  // MEASURED 3 reads / 0.7 KB. Writes the step-up row at most once per activity quantum (4 minutes).
  "stepUp:keepAlive": { maxReads: 4, maxReadBytes: 2_048, maxWrites: 1, maxWriteBytes: 512 },
  // MEASURED 3 reads / 0.7 KB, 1 write (the step-up row is locked).
  "stepUp:lock": { maxReads: 4, maxReadBytes: 2_048, maxWrites: 1, maxWriteBytes: 512 },
  // MEASURED 10 reads / 2 KB, 2 writes (no other sessions; `stepUp:storeActionPin` with 10 other sessions: 16 reads, 12 writes).
  // Worst case: authorize + factors, counters, the person's other sessions' step-up rows (<= 25) and memberships (<= 20);
  // writes: factors, counters (deleted), this session's step-up row, the others' deleted, one audit row per membership.
  "stepUp:setActionPin": { maxReads: 4 + 3 + 25 + 20, maxReadBytes: 40_000, maxWrites: 3 + 25 + 20, maxWriteBytes: 24_000 },
  // ESTIMATE (the matrix call stops at a wrong PIN: 3 reads, 1 write; a right PIN needs a real Argon2 hash; the internal
  // parts `stepUp:beginPinAttempt`, `finishPinSuccess`, `noticePinFailures` are measured below).
  // authorize + factors, counters, step-up row; a wrong attempt writes counters (1); the locking one also an
  // audit row per membership (<= 20) and one scheduled notice.
  "stepUp:verifyActionPin": { maxReads: 4 + 4 + 20, maxReadBytes: 16_000, maxWrites: 2 + 20 + 1, maxWriteBytes: 12_000 },
  // MEASURED 3 reads / 0.7 KB, 0 writes: since Phase 4b the PIN is required, so it always refuses.
  "stepUp:clearActionPin": { maxReads: 4, maxReadBytes: 2_048, maxWrites: 0, maxWriteBytes: 0 },
  // MEASURED 3 reads (a missing passkey); found: + the passkey, patch.
  "stepUp:renamePasskey": { maxReads: 5, maxReadBytes: 3_072, maxWrites: 1, maxWriteBytes: 1_024 },
  // wrapper (4) + the passkey, the person's passkeys (<= MAX_PASSKEYS = 10), step-up rows that used it (<= 25), memberships (<= 20); writes: delete, patches, audit per membership.
  "stepUp:removePasskey": { maxReads: 4 + 1 + 10 + 25 + 20, maxReadBytes: 30_000, maxWrites: 1 + 25 + 20, maxWriteBytes: 16_000 },
  // MEASURED 5 reads / 1.2 KB (no factors to remove). Worst case: the target member, factors, passkeys (<= 10),
  // counters, the person's sessions' step-up rows (<= 25) and memberships (<= 20); writes: deletes of those, audit per membership.
  "stepUp:resetMember": { maxReads: 4 + 1 + 1 + 10 + 1 + 25 + 20, maxReadBytes: 30_000, maxWrites: 1 + 10 + 1 + 25 + 20, maxWriteBytes: 16_000 },
  // ESTIMATE (the matrix call answers `not_ready`: no pepper / codes; the internal part `stepUp:recoveryReset` is measured
  // below: 31 reads, 25 writes with 10 other sessions). Action: authorize + factors, counters, recovery hashes (in the factors row), the person's sessions'
  // step-up rows (<= 25), memberships (<= 20); writes: factors, counters, step-up rows, audit per membership.
  "stepUp:resetWithRecoveryCode": { maxReads: 4 + 3 + 25 + 20, maxReadBytes: 40_000, maxWrites: 3 + 25 + 20, maxWriteBytes: 24_000 },
  // ESTIMATE (WebAuthn needs a real authenticator; the internal parts `stepUp:createChallenge`, `consumeChallenge`,
  // `storePasskey`, `finishPasskeySuccess`, `flagClone` are measured below). Passkey actions: authorize (4) + factors (1) + the person's passkeys (<= 10) + the challenge rows of the
  // session (<= 2 per purpose); writes: challenge insert / delete. Verification patches the counter and the step-up
  // row and audits per membership (<= 20); registration inserts the passkey and audits.
  "passkeys:beginRegistration": { maxReads: 4 + 1 + 10 + 2, maxReadBytes: 12_000, maxWrites: 3, maxWriteBytes: 2_048 },
  "passkeys:finishRegistration": { maxReads: 4 + 1 + 10 + 2 + 20, maxReadBytes: 16_000, maxWrites: 2 + 1 + 20, maxWriteBytes: 12_000 },
  "passkeys:beginVerification": { maxReads: 4 + 1 + 10 + 2, maxReadBytes: 12_000, maxWrites: 3, maxWriteBytes: 2_048 },
  "passkeys:finishVerification": { maxReads: 4 + 1 + 10 + 2 + 20, maxReadBytes: 16_000, maxWrites: 4 + 20, maxWriteBytes: 12_000 },
  // MEASURED 4 reads (a no-change save). The sum of update + setGroups + setDirectApps in one transaction: employee, username
  // check, <= 100 groups, <= 101 memberships, <= 50 apps, <= 51 grants, roster rows (<= 100) + key, queue;
  // writes: employee, <= 100 members, <= 200 roster entries + rows, <= 50 grants, audit, queue.
  "employees:save": { maxReads: 4 + 1 + 1 + 100 + 101 + 50 + 51 + 200 + 5, maxReadBytes: 150_000, maxWrites: 1 + 100 + 200 + 50 + 5, maxWriteBytes: 100_000 },

  // ======================================================================================================
  // ---- Step 18 item 9: INTERNAL functions (scheduler, the actions' helpers, CLI, maintenance stages).
  // MEASURED = `tests/convex/ioInternal.ts` ran the function on the large-org fixture (200 PCs, 300
  // employees, 30 apps, 10 groups, 500 audit rows + a second organization), with whatever backlog the
  // case seeds ("full batch" = a whole batch of the function's own limit). The budget is the measured
  // number or, where the fixture is smaller than the function's cap, the cap itself (in brackets).
  // No wrapper: reads are the function's own (no session / membership read). The rate limiter is a
  // component and is not counted (`reserveAttempt` is 0 here for that reason).
  // ======================================================================================================

  // ---- account. `authorize` is the first call of every member ACTION.
  // MEASURED 3 reads / 0.7 KB (session, member, step-up row). Worst case: + the person's memberships (<= 20).
  "account:authorize": { maxReads: 4 + 20, maxReadBytes: 12_000, maxWrites: 0, maxWriteBytes: 0 },
  // MEASURED 1 read (the invite by token hash).
  "account:checkJoinInvite": { maxReads: 2, maxReadBytes: 2_048, maxWrites: 0, maxWriteBytes: 0 },
  // MEASURED 2 reads, 1 write (invite, member; the invite is marked used).
  "account:consumeResetCode": { maxReads: 3, maxReadBytes: 3_072, maxWrites: 1, maxWriteBytes: 512 },
  // MEASURED 0 reads, 1 write (the audit row).
  "account:auditPasswordReset": { maxReads: 1, maxReadBytes: 1_024, maxWrites: 1, maxWriteBytes: 1_024 },
  // MEASURED 5 reads / 1 KB, 2 writes (3 sealed mail settings + createPinReset; the Resend call is outside the database).
  // Worst case: 3 + createPinReset (user, memberships <= 20, links <= 10) = 34; writes as createPinReset.
  "account:deliverPinReset": { maxReads: 3 + 1 + 20 + 10, maxReadBytes: 24_000, maxWrites: 1 + 10 + 20, maxWriteBytes: 16_000 },
  // MEASURED 2 reads, 2 writes (link row + 1 audit). Worst case: user, memberships (<= 20), newest links (<= 10, unused ones deleted).
  "account:createPinReset": { maxReads: 1 + 20 + 10, maxReadBytes: 20_000, maxWrites: 1 + 10 + 20, maxWriteBytes: 16_000 },
  // MEASURED 2 reads (session, step-up row).
  "account:pinResetCaller": { maxReads: 3, maxReadBytes: 2_048, maxWrites: 0, maxWriteBytes: 0 },
  // MEASURED 30 reads / 6 KB, 24 writes with 10 other sessions (each: session, ~2 refresh tokens' worth of rows, step-up row).
  // Worst case: link, session, PIN row, counters, links (<= 10), the person's other sessions (<= MAX_USER_SESSIONS = 25)
  // + refresh tokens (~2 each) + step-up rows (<= 25), user, memberships (<= 20) = 135; writes: link, PIN row, counters,
  // deletes (<= 100), one audit row per membership (<= 20), one scheduled notice.
  "account:finishPinReset": { maxReads: 135, maxReadBytes: 40_000, maxWrites: 123, maxWriteBytes: 12_000 },
  // MEASURED 12 reads, 11 writes with 10 other sessions. Worst case: the person's step-up rows (<= 25, one per session).
  "account:signOutStepUp": { maxReads: 30, maxReadBytes: 8_000, maxWrites: 30, maxWriteBytes: 1_024 },
  // MEASURED 0 reads (a person without a password account); with one: 1 read.
  "account:passwordAccountOf": { maxReads: 1, maxReadBytes: 1_024, maxWrites: 0, maxWriteBytes: 0 },
  // MEASURED 25 reads / 5 KB, 21 writes with 10 other sessions. Worst case: sessions (<= 25) + refresh tokens (~2 each) +
  // step-up rows (<= 25), user, memberships (<= 20); writes: those deletes, one audit row per membership, one scheduled notice.
  "account:finishPasswordChange": { maxReads: 121, maxReadBytes: 36_000, maxWrites: 121, maxWriteBytes: 12_000 },

  // ---- apps
  // MEASURED (full batch: 100 install results + 100 grants) 200 reads / 49 KB, 200 deletes. (APP_PURGE_BATCH x 2; it reschedules while full.)
  "apps:purgeApp": { maxReads: 2 * 100 + 2, maxReadBytes: 60_000, maxWrites: 2 * 100, maxWriteBytes: 2_048 },
  // MEASURED 1 read (the app).
  "apps:iconTarget": { maxReads: 2, maxReadBytes: 2_048, maxWrites: 0, maxWriteBytes: 0 },
  // MEASURED 1 read, 2 writes for an unassigned app (app patch, audit). An assigned app adds `publishApp`: assignments by app
  // (<= 501), grants (<= 51) with their groups (<= 21 each), the publish queue; writes: app, audit, queue (+ run). As `apps:saveIcon`.
  "apps:attachIcon": { maxReads: 1 + 501 + 51 + 51 * 21 + 1, maxReadBytes: 250_000, maxWrites: 4, maxWriteBytes: 4_096 },
  // MEASURED 1 read (a cached answer, ~0.4 KB).
  "apps:cachedWinget": { maxReads: 2, maxReadBytes: 4_096, maxWrites: 0, maxWriteBytes: 0 },
  // MEASURED 0 reads + 1 write for a new answer; 1 read + 1 write for a replaced one.
  "apps:storeWinget": { maxReads: 1, maxReadBytes: 4_096, maxWrites: 1, maxWriteBytes: 4_096 },

  // ---- device API (the sign-in action's two internal calls) and the device-action authorizer
  // MEASURED 5 reads / 1.4 KB (no password row). Full path: credentials, device, org, liveness, employee, lockout, secret, membership = 8 (+ limiter, uncounted).
  "deviceApi:loadForVerify": { maxReads: 9, maxReadBytes: 8_192, maxWrites: 0, maxWriteBytes: 0 },
  // MEASURED 2 reads, 1 write (a wrong password with a liveness refresh). Worst case: credentials, device, lockout, employee, device;
  // writes: liveness, lockout, audit (the locking attempt).
  "deviceApi:finishVerify": { maxReads: 6, maxReadBytes: 4_096, maxWrites: 3, maxWriteBytes: 2_048 },
  // MEASURED 0: it only takes a token from the rate limiter component.
  "deviceApi:reserveAttempt": { maxReads: 0, maxReadBytes: 0, maxWrites: 0, maxWriteBytes: 0 },
  // MEASURED 2 reads / 0.6 KB (credentials, device). The first call of every device ACTION.
  "devices:authorizeDevice": { maxReads: 3, maxReadBytes: 2_048, maxWrites: 0, maxWriteBytes: 0 },

  // ---- Phase 5 Step 10: per-organization keys (internal; every row holds a WRAPPED key, never returned to a client).
  // An internal action's number is the sum of the internal functions it calls.
  // org, the two active-key checks, the registered key; writes: 2 key rows + the registered key + audit + the publish request
  // (queue read + insert + one scheduled run). A Phase 4 organization (registered key) writes only the sealing row + audit.
  "keys:storeOrgKeys": { maxReads: 7, maxReadBytes: 4_096, maxWrites: 6, maxWriteBytes: 3_072 },
  "keys:createOrgKeys": { maxReads: 7, maxReadBytes: 4_096, maxWrites: 6, maxWriteBytes: 3_072 },
  // the signing row check, the registered key, the sealing check; writes: 2 key rows + audit.
  "keys:storeMigratedKey": { maxReads: 4, maxReadBytes: 3_072, maxWrites: 3, maxWriteBytes: 2_048 },
  // REWRAP_BATCH = 50 rows of `orgKeys.by_master_key` (~0.3 KB each).
  "keys:rewrapBatch": { maxReads: 50, maxReadBytes: 20_000, maxWrites: 0, maxWriteBytes: 0 },
  // per update (<= 50): the row (compare-and-set) + a patch; one audit row per organization touched (worst: 50 organizations).
  "keys:storeRewrapped": { maxReads: 50, maxReadBytes: 20_000, maxWrites: 50 + 50, maxWriteBytes: 30_000 },
  // rewrapBatch + storeRewrapped, then at most one rescheduled run.
  "keys:rewrapAll": { maxReads: 100, maxReadBytes: 40_000, maxWrites: 100, maxWriteBytes: 30_000 },
  // ---- Phase 5 Step 13: Wi-Fi profiles (plan 4.15, 4.20). UNSURE: the worst cases below are not measured (the matrix calls are
  // the no-change / refused cases); a snapshot of one group reads up to ~570 documents (see `apps:setPermissions`).
  // wrapper (4) + <= 51 profiles + the names of <= 10 groups each (a per-query cache, so <= the organization's groups; 10 x 50 at worst).
  // Step 14: + <= 101 printers (names of their first 10 groups come from the same per-query cache) + the organization row.
  // Step 14b: + <= 51 drivers (MAX_ORG_DRIVERS; their group names come from the same cache).
  // NOTE (Step 14b): a group snapshot now also reads the organization's drivers (<= 51), so the "~570" of the rows below is 621 (10 x 621).
  "networks:list": { maxReads: 4 + 51 + 101 + 51 + 1 + 10 * 50, maxReadBytes: 450_000, maxWrites: 0, maxWriteBytes: 0 },
  // wrapper (4) + the profile + <= 10 group names + <= 10 groups x (200 + 1) apply reports (~1-3 KB each; a report only changes when
  // a PC's state does). The dashboard screen subscribes to it: that is why the sample is capped.
  "networks:wifiDetail": { maxReads: 4 + 1 + 10 + 10 * 201, maxReadBytes: 6_500_000, maxWrites: 0, maxWriteBytes: 0 },
  // wrapper (4) + profile + <= 100 group checks + the count of profiles (50) + 10 existence checks + 10 snapshots (~570 each). Writes: profile,
  // audit, per group <= 13 (version, rollout, pruned versions, queue). The boxes of a profile that becomes open go in `networks:purgeSealed`.
  "networks:saveWifi": { maxReads: 4 + 1 + 100 + 50 + 10 + 10 * 621 + 1, maxReadBytes: 2_500_000, maxWrites: 1 + 1 + 10 * 13 + 3, maxWriteBytes: 2_700_000 },
  // wrapper (4) + profile + <= 10 snapshots; writes: profile, audit, per group <= 13; boxes: `networks:purgeSealed`.
  "networks:deleteWifi": { maxReads: 4 + 1 + 10 + 10 * 621 + 1, maxReadBytes: 2_500_000, maxWrites: 1 + 1 + 10 * 13 + 3, maxWriteBytes: 2_700_000 },
  // ---- Phase 5 Step 14: printers (plan 4.15, 4.20). UNSURE like the Wi-Fi rows: the matrix calls are the no-change / refused cases.
  // Same shape as `networks:wifiDetail`.
  "networks:printerDetail": { maxReads: 4 + 1 + 10 + 10 * 201, maxReadBytes: 6_500_000, maxWrites: 0, maxWriteBytes: 0 },
  // wrapper (4) + organization row + <= 100 group checks (groups + defaults) + printer + <= 101 printers (name / default checks)
  // + <= 10 existence checks + 10 snapshots (~570 each). Writes: printer, audit, per group <= 13.
  "networks:savePrinter": { maxReads: 4 + 1 + 200 + 1 + 50 + 101 + 10 + 10 * 621 + 1, maxReadBytes: 2_500_000, maxWrites: 1 + 1 + 10 * 13 + 3, maxWriteBytes: 2_700_000 },
  // wrapper (4) + printer + <= 10 snapshots; writes: printer, audit, per group <= 13.
  "networks:deletePrinter": { maxReads: 4 + 1 + 10 + 10 * 621 + 1, maxReadBytes: 2_500_000, maxWrites: 1 + 1 + 10 * 13 + 3, maxWriteBytes: 2_700_000 },
  // Step 14b: the approved printer driver names: wrapper (4) + the organization row; writes: the organization patch + audit. No snapshot (documents carry
  // the driver name; the agent checks its local store). No change: 5 reads, 0 writes.
  "networks:setApprovedPrinterDrivers": { maxReads: 5, maxReadBytes: 4_096, maxWrites: 2, maxWriteBytes: 4_096 },
  // ---- Phase 5 Step 15: broadcasts (plan 4.17). UNSURE until measured: the matrix calls are the first-call cases.
  // wrapper (3) + a page of <= 50 rows + the names of the groups / PCs they point to (a per-query cache, <= 50). Subscribed by the Broadcasts
  // screen; it re-runs when a row of the page changes (an acknowledgement patches `ackCount`).
  "broadcasts:list": { maxReads: 3 + 50 + 50, maxReadBytes: 80_000, maxWrites: 0, maxWriteBytes: 0, live: true },
  // wrapper (4) + the target (a group + <= 501 of its PCs, or a PC + its credentials) + the two live-count ranges (<= 21 rows each) + the
  // publish queue; writes: broadcast, queue, audit (+ one scheduled publish run). Refused: 0 writes.
  "broadcasts:send": { maxReads: 4 + 1 + GROUP_COUNT_CAP_READ + 42 + 2, maxReadBytes: 400_000, maxWrites: 3, maxWriteBytes: 4_096 },
  // wrapper (4) + the broadcast + its group + publish queue; writes: broadcast, queue, audit. Already cancelled: 0 writes.
  "broadcasts:cancel": { maxReads: 4 + 1 + 1 + 1, maxReadBytes: 6_144, maxWrites: 3, maxWriteBytes: 2_048 },
  // ---- Phase 5 Step 14b: drivers (PRD 24.2). UNSURE like the rows above: the matrix calls are the no-change / refused cases.
  // wrapper (4) + the driver + <= 10 group names + <= 201 results (~0.3 KB each; a row only changes when a PC's state does). The Networks screen
  // does not subscribe to it (`networks:list` carries the rows only).
  "drivers:detail": { maxReads: 4 + 1 + 10 + 201, maxReadBytes: 150_000, maxWrites: 0, maxWriteBytes: 0 },
  // wrapper (4) + <= 100 group checks + the driver + <= 51 drivers (name / cap checks) + <= 10 existence checks + 10 snapshots (621 each). Writes:
  // driver, audit, per group <= 13.
  "drivers:save": { maxReads: 4 + 100 + 1 + 51 + 10 + 10 * 621 + 1, maxReadBytes: 2_500_000, maxWrites: 1 + 1 + 10 * 13 + 3, maxWriteBytes: 2_700_000 },
  // wrapper (4) + driver + <= 10 snapshots; writes: driver, audit, per group <= 13; its results: `drivers:purgeResults`.
  "drivers:remove": { maxReads: 4 + 1 + 10 + 10 * 621 + 1, maxReadBytes: 2_500_000, maxWrites: 1 + 1 + 10 * 13 + 3, maxWriteBytes: 2_700_000 },
  "drivers:retry": { maxReads: 4 + 1 + 10 + 10 * 621 + 1, maxReadBytes: 2_500_000, maxWrites: 1 + 1 + 10 * 13 + 3, maxWriteBytes: 2_700_000 },
  // one batch of results (DRIVER_RESULT_PURGE_BATCH = 100): reads and deletes.
  "drivers:purgeResults": { maxReads: 100, maxReadBytes: 60_000, maxWrites: 100, maxWriteBytes: 60_000 },
  // one batch of boxes (SEALED_PURGE_BATCH = 100): reads and deletes.
  "networks:purgeSealed": { maxReads: 100, maxReadBytes: 60_000, maxWrites: 100, maxWriteBytes: 60_000 },
  // authorize (4) + `wifi:target` (profile + sealing key) + `wifi:storePassphrase` + the limiter row; no database read happens for the
  // passphrase itself (an action).
  "wifi:setPassphrase": { maxReads: 4 + 2 + 1 + 1 + 10 + 10 * 621 + 2, maxReadBytes: 2_500_000, maxWrites: 1 + 1 + 10 * 13 + 3, maxWriteBytes: 2_700_000 },
  "wifi:target": { maxReads: 2, maxReadBytes: 4_096, maxWrites: 0, maxWriteBytes: 0 },
  // profile, <= 10 group checks and snapshots; writes: profile, audit, per group <= 13.
  "wifi:storePassphrase": { maxReads: 1 + 10 + 10 * 621 + 1, maxReadBytes: 2_500_000, maxWrites: 1 + 1 + 10 * 13 + 3, maxWriteBytes: 2_700_000 },
  // Wi-Fi sealing (4.18): SEAL_DEVICES_PER_RUN = 25 devices per run, each with <= MAX_DEVICE_WIFI = 20 assigned profiles.
  // jobs: the sealing key, <= 51 profiles, per device the device + one sealed-box lookup per assigned profile
  // (typical: 1-3 profiles a group, so ~75-100 reads; the cap is 25 x 21).
  "seal:jobs": { maxReads: 1 + 51 + 25 * (1 + 20), maxReadBytes: 420_000, maxWrites: 0, maxWriteBytes: 0 },
  // per box (<= 25 x 20): the device, the profile and the old box; writes: one box each (insert or patch) + the publish request.
  "seal:storeSealed": { maxReads: 3 * 25 * 20 + 1, maxReadBytes: 900_000, maxWrites: 25 * 20 + 2, maxWriteBytes: 450_000 },
  // jobs + storeSealed; the X25519 / HKDF / XChaCha work is CPU, not I/O.
  "seal:forDevices": { maxReads: (1 + 51 + 25 * 21) + (3 * 25 * 20 + 1), maxReadBytes: 1_320_000, maxWrites: 25 * 20 + 2, maxWriteBytes: 450_000 },
  // Security counters (4.2, 4.19): one organization per step. A full step reads the org page (1), yesterday's device rows (<= 200),
  // the org row of that day (1) and the expired rows (<= 200 device days + <= 200 organization days); writes the org row (1) and
  // deletes those. Typical rows are < 1 KB (<= 10 denials); the worst row is ~7 KB (device, 100 denials) or ~35 KB (organization,
  // 500 denials), so a full backlog stays under Convex's 16 MiB read limit.
  "security:rollup": { maxReads: 1 + 200 + 1 + 200 + 200, maxReadBytes: 1_500_000, maxWrites: 1 + 200 + 200, maxWriteBytes: 8_192 },

  // ---- employees
  // MEASURED 4 reads (1 group, 1 app). Worst case: username check + groups (<= 100) + apps (<= 50).
  "employees:createPrecheck": { maxReads: 1 + 100 + 50, maxReadBytes: 100_000, maxWrites: 0, maxWriteBytes: 0 },
  // MEASURED 6 reads / 1.6 KB, 10 writes (1 group, 1 app). Worst case: the `employees:create` row without the authorize (4).
  "employees:storeNew": { maxReads: 1 + 100 + 50 + 3 + 1 + 1 + 100 * 2 + 2, maxReadBytes: 120_000, maxWrites: 1 + 1 + 100 + 50 + 200 + 1 + 1 + 3, maxWriteBytes: 90_000 },
  // MEASURED 1 read.
  "employees:passwordTarget": { maxReads: 2, maxReadBytes: 2_048, maxWrites: 0, maxWriteBytes: 0 },
  // MEASURED 1 read, 3 writes (an employee in 1 group). Worst case: the `employees:setPassword` row without authorize + target (5).
  "employees:storePassword": { maxReads: 1 + 1 + 101 + 1 + 100 + 2, maxReadBytes: 60_000, maxWrites: 1 + 1 + 200 + 1 + 1, maxWriteBytes: 60_000 },
  // MEASURED (full batch: 50 removals waiting for a key) 102 reads / 18 KB, 102 writes / 13 KB: group + employee per row, then
  // the signed roster entries and rows, and the pending rows deleted. (ROSTER_RESYNC_BATCH = 50; it reschedules while full.)
  "employees:resyncRoster": { maxReads: 160, maxReadBytes: 40_000, maxWrites: 130, maxWriteBytes: 30_000 },

  // ---- enrollment codes, fleet, mail
  // MEASURED 2 reads, 3 writes. Worst case: the `enrollmentCodes:create` row without the authorize (4).
  "enrollmentCodes:storeCode": { maxReads: 5 + 201, maxReadBytes: 90_000, maxWrites: 3, maxWriteBytes: 1_536 },
  // MEASURED (full batch: 100 install results) 102 reads / 30 KB, 102 writes. Worst case: 5 tables x PURGE_BATCH (100): install results,
  // documents (x2 indexes), bodies (<= ~13 KB typical, up to the payload cap), versions; it reschedules while any is full.
  // Phase 5 Step 10: + 4 tables x PURGE_BATCH (finding links, sealed Wi-Fi boxes, the apply report, the lock): 9 tables, <= 100 rows each.
  // MEASURED (100 install results + 100 finding links + 20 sealed boxes + the report + the lock) 224 reads / 73 KB, 224 deletes.
  "fleet:purgeDevice": { maxReads: 10 * 100 + 2, maxReadBytes: 1_900_000, maxWrites: 10 * 100, maxWriteBytes: 4_096 },
  // MEASURED 2 reads / 0.4 KB (the sealed API key and sender; the Resend call is outside the database).
  "mail:send": { maxReads: 3, maxReadBytes: 2_048, maxWrites: 0, maxWriteBytes: 0 },

  // ---- maintenance (one run = one batch; each reschedules itself while a batch is full)
  // MEASURED (stage `sessions` with a backlog of 520 expired sessions) 500 reads / 70 KB, 500 deletes. MAINTENANCE_BATCH = 500;
  // the heaviest stage in bytes is `auditLog` (~350 B x 500). `rateLimiter` is a component call (uncounted).
  "maintenance:daily": { maxReads: 500 + 12, maxReadBytes: 250_000, maxWrites: 500 + 12, maxWriteBytes: 4_096 },
  // MEASURED 501 reads / 151 KB, 500 deletes: one organization's page of expired audit rows (AUDIT_PRUNE_BATCH = 500) + its plan.
  "maintenance:pruneAudit": { maxReads: 500 + 20, maxReadBytes: 260_000, maxWrites: 500, maxWriteBytes: 4_096 },
  // MEASURED 966 reads / 255 KB, 16 writes for 6 organizations (one with 200 PCs): `ensureOrgRows` recounts every counter from the
  // rows (measured with the old batch of 20; MIGRATION_ORG_BATCH is now 1 organization per run, so one run reads less). A single
  // organization's recount reads up to MAX_RECOUNT_DEVICES = 2,000 PCs x ~4 rows (+ groups, members, apps), about half of Convex's
  // 16,384-document read limit. One-time migration of Step 5 (already run on dev); budget = the fixture case.
  "maintenance:migratePlans": { maxReads: 1_200, maxReadBytes: 320_000, maxWrites: 130, maxWriteBytes: 40_000 },
  // MEASURED 300 reads / 79 KB, 0 writes (100 devices that are already migrated: device, credentials, liveness). Worst case (nothing
  // migrated yet): per device the 7 rows it reads, up to 6 inserts (credentials, liveness, presence + shard, summary, report with compat <= 32 KB).
  "maintenance:migrateDevices": { maxReads: 100 * 8, maxReadBytes: 4_000_000, maxWrites: 100 * 6, maxWriteBytes: 4_000_000 },
  // MEASURED 200 reads / 54 KB, 0 writes (already narrow). Worst case: device + credentials + status per device, one replace per device.
  "maintenance:narrowDevices": { maxReads: 100 * 3, maxReadBytes: 400_000, maxWrites: 100, maxWriteBytes: 100_000 },
  // MEASURED 201 reads / 54 KB (the verify pass: 100 devices x credentials + head); the delete pass is 100 reads + 100 deletes.
  "maintenance:dropDesiredStates": { maxReads: 205, maxReadBytes: 100_000, maxWrites: 100, maxWriteBytes: 2_048 },
  // MEASURED (full batch: 100 + 100 rows) 200 reads / 39 KB, 200 deletes.
  "maintenance:dropTotpTables": { maxReads: 2 * 100 + 2, maxReadBytes: 60_000, maxWrites: 2 * 100, maxWriteBytes: 2_048 },

  // ---- members, plans
  // MEASURED 1 read, 2 writes. Worst case: the `members:invite` row without the authorize (4).
  "members:storeInvite": { maxReads: 8, maxReadBytes: 6_144, maxWrites: 3, maxWriteBytes: 2_048 },
  // MEASURED 1 read, 2 writes (invite, audit). Worst case: the target member, the limiter.
  "members:storeResetCode": { maxReads: 4, maxReadBytes: 3_072, maxWrites: 3, maxWriteBytes: 2_048 },
  // MEASURED 2 reads (org, no plan row yet). With a plan: org, plan, counters, platform settings.
  "plans:show": { maxReads: 6, maxReadBytes: 6_144, maxWrites: 0, maxWriteBytes: 0 },
  // MEASURED 1 read, 2 writes (settings, schedules `presence:applyPingInterval`).
  "plans:setGlobalPingInterval": { maxReads: 2, maxReadBytes: 2_048, maxWrites: 3, maxWriteBytes: 2_048 },
  "plans:setOrgPingInterval": { maxReads: 5, maxReadBytes: 4_096, maxWrites: 5, maxWriteBytes: 3_072 },
  "plans:setLimits": { maxReads: 6, maxReadBytes: 6_144, maxWrites: 5, maxWriteBytes: 4_096 },
  "plans:setPlanDefaults": { maxReads: 2, maxReadBytes: 2_048, maxWrites: 3, maxWriteBytes: 3_072 },

  // ---- platform (operator secrets; tiny tables)
  // MEASURED with all three mail settings stored: the store (1 read, 2-3 writes: secret, audit, flag) + the flag recompute (7 reads).
  "platform:setSecret": { maxReads: 10, maxReadBytes: 4_096, maxWrites: 4, maxWriteBytes: 2_048 },
  "platform:storeSecret": { maxReads: 2, maxReadBytes: 2_048, maxWrites: 3, maxWriteBytes: 2_048 },
  "platform:clearSecret": { maxReads: 5, maxReadBytes: 4_096, maxWrites: 4, maxWriteBytes: 2_048 },
  "platform:mailInputs": { maxReads: 3, maxReadBytes: 2_048, maxWrites: 0, maxWriteBytes: 0 },
  "platform:setMailFlag": { maxReads: 5, maxReadBytes: 3_072, maxWrites: 1, maxWriteBytes: 1_024 },
  "platform:refreshMailFlag": { maxReads: 8, maxReadBytes: 4_096, maxWrites: 1, maxWriteBytes: 1_024 },
  "platform:readSecret": { maxReads: 2, maxReadBytes: 1_024, maxWrites: 0, maxWriteBytes: 0 },
  "platform:checkSecrets": { maxReads: 12, maxReadBytes: 6_144, maxWrites: 1, maxWriteBytes: 1_024 },
  "platform:status": { maxReads: 3, maxReadBytes: 2_048, maxWrites: 0, maxWriteBytes: 0 },

  // ---- presence, publish, settings, setup
  // MEASURED (every online PC overdue; 110 PCs) 248 reads / 54 KB, 223 writes / 6 KB: per PC the liveness row, its presence row and
  // a shard counter; ~2.2 reads and ~2 writes per PC. SWEEP_BATCH = 500 PCs per run (it reschedules while full).
  "presence:sweep": { maxReads: 1_300, maxReadBytes: 300_000, maxWrites: 1_300, maxWriteBytes: 80_000 },
  // MEASURED (200 PCs, every interval differs) 202 reads / 51 KB, 201 writes. Worst case: PING_PROPAGATION_BATCH = 200 liveness rows
  // + each PC's head (read, patched when it differs) + the plan.
  "presence:applyPingInterval": { maxReads: 1 + 200 * 2, maxReadBytes: 160_000, maxWrites: 200 * 2, maxWriteBytes: 60_000 },
  // MEASURED (all 200 PCs queued; 10 groups of 3 apps) 274 reads / 89 KB, 74 writes / 167 KB for one batch of PUBLISH_BATCH = 25 PCs:
  // ~11 reads per PC (mostly the group loads, shared inside the run) and ~3 writes per PC (a ~6 KB signed document body + head + version).
  // The design ceiling is higher for groups with many apps and grants (RUN_DOC_BUDGET = 18,000 documents; `publishBudget.test.ts`).
  // Phase 5 Step 10: per PC + its lock (1) + its own broadcasts (<= BROADCAST_READ = 30, usually 0) + one sealed-box lookup per Wi-Fi profile with a
  // passphrase; per group in the run (cached) + its rollout (1), the configuration of each ring's version (1-3 rows of ~3-12 KB) and
  // its broadcasts (<= 30). Budgeted for 25 PCs in 10 groups with <= 3 broadcasts and <= 3 profiles each; documents grow by the
  // Phase 5 keys (typical 12 KB, worst 64 KB: plan 4.3), so a batch writes up to 25 x ~16 KB. MEASURED on the fixture without Phase 5
  // data: unchanged (274 reads / 89 KB, 74 writes / 167 KB); with a configuration, a Wi-Fi box and 2 broadcasts per group, a lock on
  // every 10th PC: 346 reads / 137 KB, 77 writes / 222 KB (`ioInternal.ts`, second case).
  "publish:run": { maxReads: 340 + 25 * 7 + 10 * 8, maxReadBytes: 300_000, maxWrites: 95, maxWriteBytes: 450_000 },
  // MEASURED 2 reads, 4 writes. Without the authorize (4) of `settings:setExitPin`: org, orgSecrets, publishQueue.
  "settings:storeExitPin": { maxReads: 4, maxReadBytes: 3_072, maxWrites: 5, maxWriteBytes: 2_048 },
  // MEASURED 4 reads, 8 writes: a new organization, its Default group, plan, counters and secrets rows, the invite, audit.
  // Adopting an existing member-less organization (`existingOrgId`) also recounts it (as `maintenance:migratePlans`, per organization).
  "setup:createOwnerInvite": { maxReads: 12, maxReadBytes: 8_192, maxWrites: 12, maxWriteBytes: 8_192 },
  "setup:storeOwnerInvite": { maxReads: 12, maxReadBytes: 8_192, maxWrites: 12, maxWriteBytes: 8_192 },

  // ---- stats (the nightly recount; one stage page per run)
  // MEASURED stage `devices` (200 PCs) 802 reads / 205 KB; stage `employees` (300 of up to RECONCILE_EMPLOYEE_BATCH = 1,000) 303 reads /
  // 87 KB. Budget: the larger of the caps (1,000 employees); the `finish` stage writes the counters (<= ~15 rows).
  "stats:reconcile": { maxReads: 1_010, maxReadBytes: 300_000, maxWrites: 20, maxWriteBytes: 8_192 },
  // MEASURED 1 read (one organization per run).
  "stats:reconcileAll": { maxReads: 2, maxReadBytes: 1_024, maxWrites: 0, maxWriteBytes: 0 },
  // MEASURED 2 reads (no results). Worst case: device, credentials + INSTALL_RETAG_BATCH = 200 results, each with its app and <= 2
  // assignment lookups (as `fleet:move`); writes: the patches.
  "stats:retagDevice": { maxReads: 2 + 200 + 200 + 400, maxReadBytes: 400_000, maxWrites: 200 + 5, maxWriteBytes: 60_000 },

  // ---- step-up (called by the action wrappers in stepUp.ts / passkeys.ts / account.ts)
  // MEASURED 1 read, 2 writes (the PIN row with 10 hashes, audit).
  "stepUp:storeRecoveryCodes": { maxReads: 2, maxReadBytes: 2_048, maxWrites: 2, maxWriteBytes: 2_048 },
  // MEASURED 2 reads (factors, step-up row).
  "stepUp:authorizeChange": { maxReads: 3, maxReadBytes: 2_048, maxWrites: 0, maxWriteBytes: 0 },
  // MEASURED 16 reads, 12 writes with 10 other sessions. Worst case: factors, counters, step-up row, user + the other sessions'
  // step-up rows (<= 25); writes: factors, counters, step-up, the others' deleted, audit, one scheduled notice.
  "stepUp:storeActionPin": { maxReads: 4 + 25 + 10, maxReadBytes: 12_000, maxWrites: 4 + 25 + 3, maxWriteBytes: 8_000 },
  // MEASURED 1 read, 1 write (the counters row).
  "stepUp:beginPinAttempt": { maxReads: 3, maxReadBytes: 2_048, maxWrites: 2, maxWriteBytes: 1_024 },
  // MEASURED 2 reads, 2 writes (counters, step-up row).
  "stepUp:finishPinSuccess": { maxReads: 4, maxReadBytes: 2_048, maxWrites: 3, maxWriteBytes: 1_024 },
  // MEASURED 1 read, 1 write (one audit row; one scheduled notice).
  "stepUp:noticePinFailures": { maxReads: 2, maxReadBytes: 1_024, maxWrites: 2, maxWriteBytes: 1_024 },
  // MEASURED 31 reads / 7.8 KB, 25 writes with 10 other sessions. Worst case: session, factors, the other sessions (<= 25) + refresh tokens
  // (~2 each) + step-up rows (<= 25), passkeys (<= 10), challenges, counters, user; writes: those deletes, factors, counters, audit.
  "stepUp:recoveryReset": { maxReads: 130, maxReadBytes: 40_000, maxWrites: 120, maxWriteBytes: 12_000 },
  // MEASURED 2 reads, 1 write. Worst case: passkeys (<= 10), factors, the previous challenges (<= 4); writes: factors patch, deletes, the insert.
  "stepUp:createChallenge": { maxReads: 16, maxReadBytes: 8_000, maxWrites: 6, maxWriteBytes: 2_048 },
  // MEASURED 2 reads, 1 write (the challenge is consumed).
  "stepUp:consumeChallenge": { maxReads: 3, maxReadBytes: 2_048, maxWrites: 2, maxWriteBytes: 512 },
  // MEASURED 0 reads (clash lookup finds nothing; the passkeys range has none), 2 writes. Worst case: clash + passkeys (<= 10).
  "stepUp:storePasskey": { maxReads: 12, maxReadBytes: 6_000, maxWrites: 2, maxWriteBytes: 2_048 },
  // MEASURED 3 reads, 2 writes (passkey counter, step-up row).
  "stepUp:finishPasskeySuccess": { maxReads: 5, maxReadBytes: 3_072, maxWrites: 3, maxWriteBytes: 1_024 },
  // MEASURED 13 reads, 2 writes with 10 sessions. Worst case: the passkey + the step-up rows that used it (<= 25); writes: patch, deletes, audit.
  "stepUp:flagClone": { maxReads: 30, maxReadBytes: 10_000, maxWrites: 27, maxWriteBytes: 4_096 },

  // ---- testing:* (TEST-ONLY seed helpers for E2E and load tests; refuse unless RULEBOX_ALLOW_TEST_SEED=1, never run in production).
  // Measured on `E2E io` organizations; the budgets only stop a helper from growing by accident.
  // MEASURED 5 reads, 9 writes (a new organization through `setup:storeOwnerInvite`, the signing key).
  "testing:seedE2E": { maxReads: 12, maxReadBytes: 8_192, maxWrites: 14, maxWriteBytes: 8_192 },
  "testing:registerSeedKey": { maxReads: 3, maxReadBytes: 2_048, maxWrites: 1, maxWriteBytes: 1_024 },
  // MEASURED 3 reads, 1 write. Worst case: + the person's other sessions' step-up rows (<= 25).
  "testing:setKnownPin": { maxReads: 40, maxReadBytes: 12_000, maxWrites: 30, maxWriteBytes: 8_000 },
  "testing:storeKnownPin": { maxReads: 40, maxReadBytes: 12_000, maxWrites: 30, maxWriteBytes: 8_000 },
  // MEASURED 2 reads, 10 writes (device, credentials, presence + shard, liveness, summary, report, token, stats).
  "testing:seedDevice": { maxReads: 8, maxReadBytes: 6_144, maxWrites: 14, maxWriteBytes: 4_096 },
  // MEASURED (count 200 = MAX_FLEET) 204 reads, 1,410 writes / 206 KB: ~7 rows per PC in ONE transaction. Test-only; far below Convex's
  // 16,000-write limit, but do not raise MAX_FLEET.
  "testing:seedFleet": { maxReads: 210, maxReadBytes: 50_000, maxWrites: 1_450, maxWriteBytes: 240_000 },
  "testing:simulateEdit": { maxReads: 4, maxReadBytes: 2_048, maxWrites: 3, maxWriteBytes: 2_048 },
  // MEASURED 401 reads / 102 KB, 400 deletes: DELETE_BUDGET = 400 rows per run (it reschedules itself).
  "testing:deleteOrg": { maxReads: 410, maxReadBytes: 140_000, maxWrites: 400, maxWriteBytes: 4_096 },
};
