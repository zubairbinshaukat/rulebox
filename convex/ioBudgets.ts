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
};
