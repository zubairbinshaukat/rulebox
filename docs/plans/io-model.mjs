#!/usr/bin/env node
// Rulebox database I/O and function-call model (post-Phase-5 plan, Section 1).
//
//   node docs/plans/io-model.mjs            # tables for both scenarios
//   node docs/plans/io-model.mjs --json     # raw numbers
//
// Pure arithmetic: no network, no Convex calls, no files written.
// Every number below is an ASSUMPTION unless the plan says it was measured.
// Change a constant, re-run, and copy the tables into the plan.
//
// Accounting model (Convex docs, 2026-10-27: "Database I/O = document and index
// data transferred between Convex functions and the underlying database"; the
// exact per-document / per-index rounding is NOT documented):
//   read  of one document           = docBytes + IDX
//   write (insert or patch) of a doc = docBytes + (userIndexes + SYS_IDX) * IDX
//   delete                          = (userIndexes + SYS_IDX) * IDX
// A patch is counted as a full rewrite of the document and of every index entry
// (pessimistic). Cached query results cost a function call but no I/O (Convex
// staff statement, not docs); re-runs after an invalidation cost full I/O.

const GB = 1e9; // Convex does not say GB or GiB; GiB would give 7 % more room.
const IDX = 64; // bytes per index entry read or written (assumption)
const SYS_IDX = 2; // by_id + by_creation_time on every table

const rd = (doc) => doc + IDX;
const wr = (doc, userIdx) => doc + (userIdx + SYS_IDX) * IDX;
const del = (userIdx) => (userIdx + SYS_IDX) * IDX;

// ---------------------------------------------------------------- document sizes (bytes, assumptions)
const S = {
  deviceRow: 450, // Phase 4 `devices` incl. secretHash + previousSecretHash
  deviceLean: 300, // proposed `devices` without credentials
  deviceCred: 220, // proposed `deviceCredentials`
  deviceStatus: 120, // Phase 4 `deviceStatus`
  liveness: 100, // proposed `deviceLiveness` (never subscribed by dashboards)
  presence: 100, // proposed `devicePresence` (changes on online/offline only)
  presenceShard: 80,
  orgStats: 150, // Phase 4 (deviceCount, pingIntervalMs)
  orgStatsWide: 450, // proposed counters
  reportFull: 1500, // `deviceReports` with the compat JSON
  summary: 250, // proposed `deviceSummary` (the list columns only)
  docPhase45: 12_000, // signed payload, Phase 4 + 5 keys, employees map inside
  docNoRoster: 8_000, // same without the employees map
  desiredMeta: 400, // other fields of a `desiredStates` row
  head: 250, // proposed `desiredHeads`
  versionRow: 150, // proposed `desiredVersions` (version, reason, bodyId)
  policyKey: 250,
  employee: 300,
  employeeSecret: 180,
  lockout: 120,
  groupMember: 120,
  orgRow: 500,
  rateLimit: 150,
  audit: 450,
  install: 300,
  phase5Report: 2_000,
  rosterDelta: 150,
  group: 150,
  authSession: 120,
  refreshToken: 150,
  member: 250,
  mfaSession: 120,
};

// ---------------------------------------------------------------- behaviour (assumptions)
const B = {
  statusChangesPerDay: 3, // full report changes (disk GB, kiosk phase, applied version)
  summaryChangesPerDay: 2, // of those, list columns that change
  reconnectsPerDay: 4, // sleep/wake, network loss (4 GB laptops)
  presenceTransitionsPerDay: 4, // online->offline->online twice
  signInsPerDevicePerDay: 4,
  deviceAuditPerDay: 0.5,
  installsPerDevicePerDay: 0.05, // new app per device every 20 days
  installTransitionsNow: 4, // pending, downloading, installing, installed
  installTransitionsProposed: 2, // accepted, terminal
  phase5WritesPerDay: 0.8, // Phase 5 plan 4.19 steady state
  publishBatch: 25,
  authRerunOnRefresh: false, // does a JWT refresh re-run every subscription? UNVERIFIED
};

// Per-tenant activity by fleet size (assumptions).
const TENANTS = [
  { n: 2, adminEdits: 0.1, employeeEvents: 0.05, dashHours: 2, employees: 4, groups: 1 },
  { n: 10, adminEdits: 0.3, employeeEvents: 0.3, dashHours: 8, employees: 20, groups: 2 },
  { n: 50, adminEdits: 1, employeeEvents: 1.5, dashHours: 30, employees: 80, groups: 4 },
  { n: 200, adminEdits: 2, employeeEvents: 5, dashHours: 120, employees: 300, groups: 10 },
  { n: 1000, adminEdits: 4, employeeEvents: 20, dashHours: 300, employees: 1500, groups: 50 },
];

// Phase 4 plan 4.9 heartbeat table (as written today).
const pingNow = (n) => (n <= 25 ? 5 : n <= 100 ? 15 : n <= 300 ? 30 : 60);
// Proposed: plan-based, not fleet-based (Section 2.1). Free plan = 30 min.
const pingProposed = () => 30;
const WATCH_PING_MIN = 1; // device detail page open: that one device pings each minute

// ---------------------------------------------------------------- per device per day
function deviceDay(t, scenario) {
  const now = scenario === "now";
  const P = now ? pingNow(t.n) : pingProposed(t.n);
  const pings = 1440 / P;
  const groupSize = Math.max(1, t.n / t.groups);
  // Document versions per device per day.
  const docChanges = now
    ? (t.adminEdits * 0.5 * t.n + t.employeeEvents * groupSize) / t.n
    : (t.adminEdits * 0.5 * t.n) / t.n;
  const rosterChanges = now ? 0 : (t.employeeEvents * groupSize) / t.n;
  const rows = [];
  const add = (flow, calls, readB, writeB) => rows.push({ flow, calls, readB, writeB });

  if (now) {
    add("heartbeat (write every call)", pings,
      pings * (rd(S.deviceRow) + rd(S.deviceStatus) + rd(S.orgStats)),
      pings * wr(S.deviceStatus, 2));
    add("status report (on change)", 0,
      B.statusChangesPerDay * rd(S.reportFull), B.statusChangesPerDay * wr(S.reportFull, 1));
    const doc = S.docPhase45 + S.desiredMeta;
    add("publish (per device version)", docChanges / B.publishBatch,
      docChanges * (rd(S.deviceRow) + rd(doc) + 1000 + rd(doc)),
      docChanges * (wr(doc, 1) + del(1)));
    add("agent subscription re-run", docChanges + B.reconnectsPerDay,
      (docChanges + B.reconnectsPerDay) * (rd(S.deviceRow) + rd(doc) + 3 * rd(S.policyKey)), 0);
    add("reconnect heartbeat", B.reconnectsPerDay,
      B.reconnectsPerDay * (rd(S.deviceRow) + rd(S.deviceStatus) + rd(S.orgStats)),
      B.reconnectsPerDay * wr(S.deviceStatus, 2));
    add("employee sign-in (verifyEmployee)", B.signInsPerDevicePerDay * 3,
      B.signInsPerDevicePerDay * (2 * rd(S.deviceRow) + rd(S.employee) + rd(S.employeeSecret) + IDX +
        rd(S.groupMember) + rd(S.orgRow) + rd(S.rateLimit)),
      B.signInsPerDevicePerDay * wr(S.rateLimit, 1));
    add("device audit", B.deviceAuditPerDay,
      B.deviceAuditPerDay * (rd(S.deviceRow) + IDX), B.deviceAuditPerDay * wr(S.audit, 4));
    const it = B.installsPerDevicePerDay * B.installTransitionsNow;
    add("install results", it, it * (rd(S.deviceRow) + rd(S.install)), it * wr(S.install, 4));
    add("Phase 5 reports", B.phase5WritesPerDay,
      B.phase5WritesPerDay * (rd(S.deviceRow) + rd(S.phase5Report)), B.phase5WritesPerDay * wr(S.phase5Report, 2));
  } else {
    add("liveness ping", pings,
      pings * (rd(S.deviceCred) + rd(S.liveness)), pings * wr(S.liveness, 2));
    add("presence transitions (+sweep)", B.presenceTransitionsPerDay / 2,
      B.presenceTransitionsPerDay * (rd(S.presence) + rd(S.presenceShard)),
      B.presenceTransitionsPerDay * (wr(S.presence, 2) + wr(S.presenceShard, 1)));
    add("status report (on change)", 0,
      B.statusChangesPerDay * rd(S.reportFull) + B.summaryChangesPerDay * rd(S.summary),
      B.statusChangesPerDay * wr(S.reportFull, 1) + B.summaryChangesPerDay * wr(S.summary, 1));
    const body = S.docNoRoster + 100;
    add("publish (head + body)", docChanges / B.publishBatch,
      docChanges * (rd(S.deviceLean) + rd(S.head) + 1000 + rd(S.versionRow)),
      docChanges * (wr(body, 1) + wr(S.head, 1) + wr(S.versionRow, 1) + del(1) + del(1)));
    add("agent head re-run", docChanges + rosterChanges + B.reconnectsPerDay,
      (docChanges + rosterChanges + B.reconnectsPerDay) * (rd(S.deviceCred) + rd(S.head) + rd(S.group)), 0);
    add("agent body fetch (one-shot)", docChanges,
      docChanges * (rd(S.deviceCred) + rd(body)), 0);
    add("roster delta fetch", rosterChanges,
      rosterChanges * (rd(S.deviceCred) + 2 * rd(S.rosterDelta)), 0);
    add("reconnect ping", B.reconnectsPerDay,
      B.reconnectsPerDay * (rd(S.deviceCred) + rd(S.liveness)), B.reconnectsPerDay * wr(S.liveness, 2));
    add("employee sign-in (limiter on failure only)", B.signInsPerDevicePerDay * 2,
      B.signInsPerDevicePerDay * (2 * rd(S.deviceCred) + rd(S.employee) + rd(S.employeeSecret) + IDX +
        rd(S.groupMember) + rd(S.orgRow)),
      0);
    const it = B.installsPerDevicePerDay * B.installTransitionsProposed;
    add("install results (batched)", it / 2, it * (rd(S.deviceCred) + rd(S.install)), it * wr(S.install, 4));
    add("device audit (batched)", B.deviceAuditPerDay / 2,
      B.deviceAuditPerDay * (rd(S.deviceCred) + IDX), B.deviceAuditPerDay * wr(S.audit, 4));
    add("Phase 5 reports", B.phase5WritesPerDay / 2,
      B.phase5WritesPerDay * (rd(S.deviceCred) + rd(S.phase5Report)), B.phase5WritesPerDay * wr(S.phase5Report, 2));
  }
  return { P, docChanges, rosterChanges, rows };
}

// ---------------------------------------------------------------- dashboard per user-hour
const AUTH = rd(S.authSession) + rd(S.member) + rd(S.mfaSession); // requireMember on every run
const MIX = { overview: 0.3, list: 0.4, detail: 0.15, audit: 0.05, other: 0.1 };

function dashHour(t, scenario) {
  const now = scenario === "now";
  const P = now ? pingNow(t.n) : pingProposed(t.n);
  const dd = deviceDay(t, scenario);
  const visible = Math.min(50, t.n);
  const auditPerHour = (t.adminEdits * 1.5 + t.n * B.deviceAuditPerDay) / 24;
  const heartbeatsPerHour = t.n * (60 / P);
  const transitionsPerHour = (t.n * B.presenceTransitionsPerDay) / 24;
  const docPerHour = (dd.docChanges * t.n) / 24;
  const screens = {};
  const scr = (name, runBytes, rerunsPerHour) => {
    screens[name] = { runBytes, rerunsPerHour, bytesPerHour: runBytes * (1 + rerunsPerHour), callsPerHour: 1 + rerunsPerHour };
  };
  if (now) {
    const doc = S.docPhase45 + S.desiredMeta;
    scr("overview", AUTH + rd(S.orgStats) + Math.min(t.n, 1001) * rd(S.deviceStatus) +
      Math.min(t.employees, 1001) * rd(S.employee) + 15 * rd(800) + t.groups * rd(S.group) +
      10 * rd(S.audit) + 50 * rd(S.audit) + 3 * rd(S.policyKey),
      heartbeatsPerHour + auditPerHour);
    const listRun = AUTH + visible * (rd(S.deviceRow) + rd(S.reportFull) + rd(doc)) + t.groups * rd(S.group);
    const liveRun = AUTH + visible * rd(S.deviceStatus);
    screens.list = {
      runBytes: listRun + liveRun,
      rerunsPerHour: 0,
      bytesPerHour:
        listRun * (1 + (visible * (B.statusChangesPerDay + dd.docChanges)) / 24) +
        liveRun * (1 + visible * (60 / P)),
      callsPerHour: 2 + (visible * (B.statusChangesPerDay + dd.docChanges)) / 24 + visible * (60 / P),
    };
    // fleet:get (+ installs, history) re-runs on report / document changes;
    // fleet:liveStatus for the one device re-runs on each of its heartbeats.
    scr("detail", AUTH + rd(S.deviceRow) + rd(S.reportFull) + 5 * rd(doc) + t.groups * rd(S.group) +
      20 * rd(S.install) + 20 * rd(S.audit),
      (B.statusChangesPerDay + dd.docChanges) / 24);
    screens.detail.bytesPerHour += (AUTH + rd(S.deviceStatus)) * (1 + 60 / P);
    screens.detail.callsPerHour += 1 + 60 / P;
  } else {
    scr("overview", AUTH + rd(S.orgStatsWide) + 4 * rd(S.presenceShard) + 10 * rd(S.audit) + 3 * rd(S.policyKey),
      transitionsPerHour + auditPerHour + docPerHour / Math.max(1, t.n));
    scr("list", AUTH + visible * (rd(S.deviceLean) + rd(S.summary) + rd(S.presence) + rd(S.head)) + t.groups * rd(S.group),
      (visible * (B.presenceTransitionsPerDay + B.summaryChangesPerDay + dd.docChanges)) / 24);
    // Detail page: the device pings every minute while open (watch mode) and the
    // page subscribes to that one liveness row.
    const watch = 60 / WATCH_PING_MIN;
    scr("detail", AUTH + rd(S.deviceLean) + rd(S.reportFull) + 5 * rd(S.versionRow) + t.groups * rd(S.group) +
      rd(S.liveness) + 20 * rd(S.install) + 20 * rd(S.audit),
      (B.statusChangesPerDay + dd.docChanges) / 24);
    // The agent's extra pings (charged to the viewer) and the one-row liveness
    // query that re-runs after each of them.
    screens.detail.bytesPerHour +=
      watch * (rd(S.deviceCred) + rd(S.liveness) + wr(S.liveness, 2)) + watch * (AUTH + rd(S.liveness));
    screens.detail.callsPerHour += watch * 2;
  }
  scr("audit", AUTH + 50 * rd(S.audit), auditPerHour);
  scr("other", AUTH + 30 * rd(400), 0.5);

  let bytes = 0;
  let calls = 0;
  for (const [k, share] of Object.entries(MIX)) {
    bytes += share * screens[k].bytesPerHour;
    calls += share * screens[k].callsPerHour;
  }
  // account:me + JWT refresh every 10 minutes (Convex Auth 0.0.96 refreshSession:
  // reads token + session, patches the old token, inserts a new one).
  const refreshes = 6;
  bytes += refreshes * (2 * rd(S.refreshToken) + rd(S.authSession) + wr(S.refreshToken, 2) + wr(S.refreshToken, 2));
  calls += refreshes;
  if (B.authRerunOnRefresh) {
    bytes += refreshes * Object.entries(MIX).reduce((a, [k, s]) => a + s * screens[k].runBytes, 0);
  }
  return { bytes, calls, screens };
}

// ---------------------------------------------------------------- tenant month
function tenantMonth(t, scenario) {
  const d = deviceDay(t, scenario);
  const perDevice = d.rows.reduce(
    (a, r) => ({ calls: a.calls + r.calls, bytes: a.bytes + r.readB + r.writeB }),
    { calls: 0, bytes: 0 },
  );
  const dh = dashHour(t, scenario);
  const signIn = 2_000; // member sign-in + TOTP: session, refresh token, mfaSessions, limiter, memberSecrets
  const signIns = t.dashHours / 1.5;
  return {
    P: d.P,
    deviceBytes: perDevice.bytes * 30 * t.n,
    deviceCalls: perDevice.calls * 30 * t.n,
    dashBytes: dh.bytes * t.dashHours + signIns * signIn,
    dashCalls: dh.calls * t.dashHours + signIns * 6,
    perDeviceDayBytes: perDevice.bytes,
    perDeviceDayCalls: perDevice.calls,
    dashHourBytes: dh.bytes,
    dashHourCalls: dh.calls,
    rows: d.rows,
    screens: dh.screens,
  };
}

// ---------------------------------------------------------------- output
const kb = (b) => (b / 1e3).toFixed(1);
const mb = (b) => (b / 1e6).toFixed(b < 1e6 ? 2 : 1);
const int = (x) => Math.round(x).toLocaleString("en-US");
const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);

const asJson = process.argv.includes("--json");
const out = {};
for (const scenario of ["now", "proposed"]) {
  out[scenario] = TENANTS.map((t) => ({ n: t.n, ...tenantMonth(t, scenario) }));
}
if (asJson) {
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

for (const scenario of ["now", "proposed"]) {
  const title = scenario === "now" ? "A. Phase 4/5 plans as written" : "B. With the rules of this plan";
  console.log(`\n=== ${title} ===`);
  const ref = TENANTS[1]; // 10-device tenant: per-flow breakdown
  const m = tenantMonth(ref, scenario);
  console.log(`\nPer device per day (10-device tenant, ping every ${m.P} min):`);
  console.log(`${pad("flow", 44)}${lpad("calls", 9)}${lpad("read KB", 10)}${lpad("write KB", 10)}`);
  for (const r of m.rows) {
    console.log(`${pad(r.flow, 44)}${lpad(r.calls.toFixed(1), 9)}${lpad(kb(r.readB), 10)}${lpad(kb(r.writeB), 10)}`);
  }
  console.log(`${pad("TOTAL", 44)}${lpad(m.perDeviceDayCalls.toFixed(1), 9)}${lpad(kb(m.perDeviceDayBytes), 20)}`);

  console.log(`\nDashboard, one open user-hour (screen mix ${JSON.stringify(MIX)}):`);
  console.log(`${pad("tenant", 10)}${lpad("MB/hour", 10)}${lpad("calls/hour", 12)}   per screen MB/hour`);
  for (const t of TENANTS) {
    const x = tenantMonth(t, scenario);
    const per = Object.entries(x.screens).map(([k, v]) => `${k} ${mb(v.bytesPerHour)}`).join(", ");
    console.log(`${pad(t.n + " PCs", 10)}${lpad(mb(x.dashHourBytes), 10)}${lpad(int(x.dashHourCalls), 12)}   ${per}`);
  }

  console.log(`\nTenant month (30 days):`);
  console.log(`${pad("tenant", 10)}${lpad("ping", 6)}${lpad("dev MB", 9)}${lpad("dash MB", 9)}${lpad("total MB", 10)}${lpad("calls", 11)}${lpad("MB/device", 11)}${lpad("dev/GB", 8)}`);
  for (const x of out[scenario]) {
    const total = x.deviceBytes + x.dashBytes;
    console.log(
      `${pad(x.n + " PCs", 10)}${lpad(x.P + "m", 6)}${lpad(mb(x.deviceBytes), 9)}${lpad(mb(x.dashBytes), 9)}${lpad(mb(total), 10)}` +
        `${lpad(int(x.deviceCalls + x.dashCalls), 11)}${lpad((total / x.n / 1e6).toFixed(2), 11)}${lpad(int(GB / (total / x.n)), 8)}`,
    );
  }
  const free = out[scenario][0];
  const freeBytes = free.deviceBytes + free.dashBytes;
  const freeCalls = free.deviceCalls + free.dashCalls;
  console.log(`\nFree tenants (2 PCs) that fit, by the binding limit:`);
  for (const [label, bytes] of [["1 GB I/O", 1 * GB], ["3 GB I/O", 3 * GB]]) {
    console.log(`  ${pad(label, 12)} ${lpad(int(bytes / freeBytes), 6)} tenants`);
  }
  console.log(`  ${pad("1 M calls", 12)} ${lpad(int(1e6 / freeCalls), 6)} tenants`);
  console.log(`  ${pad("1,000 sess.", 12)} ${lpad(int(1000 / 2), 6)} tenants (if every PC is online at once)`);
}
console.log(
  "\nAll figures are estimates from the constants at the top of this file; see plan Section 1.6 for the measurement procedure.",
);
