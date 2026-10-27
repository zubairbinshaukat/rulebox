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
  "enrollment:enroll": { maxReads: 10, maxReadBytes: 8_192, maxWrites: 12, maxWriteBytes: 40_960 },

  // ---- Step 7: the agent's calls (plan 4.9, 5.1 amended). Measured with the probe
  // (convex-test, `JSON.stringify` bytes; patches counted as the patch value, so the
  // Convex-side write size is the full row + its index entries).
  // The Phase 2 subscription: credentials, newest device-scope document (Phase 2 docs are
  // small), the device row only when there is none (+ the group-scope document). Measured 2 / 0.5 KB.
  "devices:desiredState": { maxReads: 4, maxReadBytes: 8_192, maxWrites: 0, maxWriteBytes: 0, live: true },
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

  // ---- Step 7: fleet (dashboard). Member wrapper = 3 reads; writes + step-up row = 4.
  // One page: 50 x (devices + summary + presence) + groups map (tiny) + wrapper. Measured for 50
  // new-shape devices: 153 reads / 34 KB. (Devices enrolled before Step 7 carry ~1.5 KB of
  // deprecated fields until `maintenance:narrowDevices` ran.) Re-runs on device, summary or
  // presence changes only, never on pings.
  "fleet:list": { maxReads: 250, maxReadBytes: 65_536, maxWrites: 0, maxWriteBytes: 0, live: true },
  // device, credentials, report (compat <= 32 KB), summary, presence, groups (tiny). Measured 8 / 2.1 KB.
  "fleet:get": { maxReads: 3 + 5 + 50, maxReadBytes: 49_152, maxWrites: 0, maxWriteBytes: 0, live: true },
  // device; writes: device, audit. Unchanged: 0 writes. Measured 5 / 1.1 KB, 2 writes.
  "fleet:rename": { maxReads: 5, maxReadBytes: 4_096, maxWrites: 2, maxWriteBytes: 1_024 },
  // device, credentials, group, orgStats, publishQueue; writes: device, orgStats, queue, audit
  // (+ one scheduled publish run). Measured 8 / 1.7 KB, 4 writes.
  "fleet:move": { maxReads: 9, maxReadBytes: 6_144, maxWrites: 4, maxWriteBytes: 2_048 },
  // device, credentials, (off: step-up row again), publishQueue; writes: device, queue, audit.
  "fleet:setKiosk": { maxReads: 9, maxReadBytes: 6_144, maxWrites: 3, maxWriteBytes: 2_048 },
  // device, credentials, device again, summary, orgStats, liveness, shard, presence; writes:
  // credentials, orgStats, liveness, shard, presence, audit. Already revoked: 0 writes.
  "fleet:revoke": { maxReads: 13, maxReadBytes: 8_192, maxWrites: 6, maxWriteBytes: 2_048 },
  // device, credentials, the 6 per-device rows; deletes them + the device, audit, one scheduled
  // purge (installResults / documents, PURGE_BATCH per run). Not revoked: 0 writes.
  "fleet:remove": { maxReads: 12, maxReadBytes: 49_152, maxWrites: 8, maxWriteBytes: 1_024 },
  // device, credentials; writes: credentials, audit. Already requested: 0 writes.
  "fleet:requestCredentialRotation": { maxReads: 6, maxReadBytes: 4_096, maxWrites: 2, maxWriteBytes: 1_024 },
  // device, orgPlans (+ platformSettings), liveness, credentials; writes: liveness only when it
  // extends `fastUntil` by >= 2 min (+ limiter row). Measured 6 / 1.6 KB, 0-1 write.
  "fleet:watch": { maxReads: 8, maxReadBytes: 4_096, maxWrites: 2, maxWriteBytes: 512 },
  // The one watched liveness row (+ device). Re-runs at most once a minute while watched.
  "fleet:liveness": { maxReads: 4, maxReadBytes: 2_048, maxWrites: 0, maxWriteBytes: 0, live: true },
  // <= 50 x (device + liveness) + limiter; writes: check row + <= 50 liveness patches + limiter.
  // Measured for 50: 104 reads / 25 KB, 51 writes / 4.4 KB. 1 per minute per organization.
  "fleet:checkNow": { maxReads: 3 + 1 + 100 + 1, maxReadBytes: 32_768, maxWrites: 53, maxWriteBytes: 16_384 },
  // check row + <= 50 liveness rows; subscribed for <= 60 s. Measured 54 / 17.6 KB.
  "fleet:checkResult": { maxReads: 3 + 1 + 50, maxReadBytes: 24_576, maxWrites: 0, maxWriteBytes: 0, live: true },
};
