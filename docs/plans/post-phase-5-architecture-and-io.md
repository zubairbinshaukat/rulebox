# After Phase 5 — Hosted service architecture and database I/O

> **For the implementing agent:** this file is the plan for everything that
> turns Rulebox into a hosted, pooled service: the database I/O budget, plans
> and limits, multi-tenant security, the operator console, the file-storage
> pool, and the changes this forces on Phases 4, 5 and 6. Read `CLAUDE.md`
> first, then Section 0 of this file. Section 7 lists changes to **other**
> plans; several must land before Phase 4 Steps 6, 7, 8 and 12 are written
> (marked **BEFORE**). One step = one commit (`Hosted step N: <what>`), made
> only when the user says so.
>
> **Seven rules override everything else in this file:**
>
> 1. **Database I/O and function calls are budgets, not afterthoughts.** Every
>    new public function has a row in `convex/ioBudgets.ts` (reads, read
>    bytes, writes, write bytes per call) and a test that fails when the
>    function exceeds it (Section 2.13). A review that adds a write without a
>    budget row is refused.
> 2. **Nothing a dashboard subscribes to changes on a timer.** Pings, clocks
>    and counters that tick are never read by a live query. Dashboards read
>    *transitions* (online → offline), *summaries* and *counters updated on
>    change* (Section 2).
> 3. **The agent keeps exactly one subscription**, and it is small: a
>    ~250-byte head row, never the signed payload (Section 2.4).
> 4. **Never unlock a device to save resources.** Every degrade mode and
>    every limit keeps devices on their last signed document; the hidden
>    admin exit and `rulebox-agent recover` keep working (Phase 2 Q11).
> 5. **The control plane holds no tenant secrets and cannot publish.** No
>    signing key, no master key, no employee data, no file contents, no audit
>    contents ever reach the operator console (recommendation file, rule 2).
> 6. **Every tenant-scoped read is scoped by the server**, through an index
>    whose first equality is the caller's `orgId` (or an id already checked
>    with `assertInOrg`), enforced at run time by `orgDb` (Section 4.3).
> 7. **Nothing here is run against the dev deployment** unless the user says
>    so. The I/O measurements of Section 1.6 run in a separate, throw-away
>    Convex project that the owner creates.

Research date for every price, limit and API fact in this file:
**2026-10-27**. Items marked **(unverified)** could not be confirmed from a
primary source; each says how it gets confirmed. Every I/O number is an
**estimate** from `docs/plans/io-model.mjs` (Section 1.4) until Section 1.6
has been run.

---

## Updates since this plan was written

None yet. When the user answers Section 8.4, record the answers here and in
`docs/plans/README.md`.

---

## 0. Summary

**The headline.** With the Phase 4 and 5 plans *as written*, one free Convex
deployment (1 GB database I/O, 1,000,000 function calls a month) holds about
**70 devices**, i.e. **≈ 35 free 2-PC tenants** — and the function-call
budget runs out at ≈ 54 tenants. The dominant costs are the 5-minute
heartbeat that reads a 450-byte device row and writes a status row on every
call, the overview query that re-reads every device's status row on every
heartbeat, and lists that read whole signed payloads to show a version
number.

With the rules of this plan the same deployment holds about **445 devices
per GB, ≈ 220 free 2-PC tenants per GB, ≈ 670 per 3 GB**; the binding limit
then becomes **function calls (≈ 246 free tenants per 1 M calls)** and, after
that, **1,000 concurrent sessions** (every online PC holds one WebSocket).
The biggest single lever is the ping interval (30 minutes for free tenants,
with on-demand "watch" and "Check now" for real-time); the structural fixes
alone (no interval change) take a device from ≈ 14 MB to ≈ 8 MB a month.

**What that means for the business** (Section 8.4, Q1): a public free tier
cannot run on Convex's *Free* plan, because the Free plan has **hard caps**
and, when they are hit, "new mutations that attempt to commit more insertions
or updates may fail" — for every tenant at once, including enrollment,
signing and audit. Run the data plane on a paid plan (Starter pay-as-you-go
or Professional) from the first outside tenant, with an alert at 50 % and
the degrade ladder of Section 2.12 at 80 %.

**Top changes to other plans (Section 7):** plan/limit model and `maxDevices`
in `enroll`; device credentials split from `devices`; presence by transitions
instead of a write per heartbeat; ping interval by plan, not by fleet size;
desired-state head/body split; the employee roster out of the signed device
document; overview counters instead of capped scans; lists never read
payloads; `deviceSummary` split from `deviceReports`; rate limiter consumed on
failures only; JWT lifetime and refresh-token cleanup; per-org signing keys
behind an interface from Phase 4 Step 8.

---

## 1. The I/O model

### 1.1 What Convex counts (verified 2026-10-27)

Primary source: Convex docs, "Limits" (`docs.convex.dev/production/state/limits`).
The pricing page (`convex.dev/pricing`, `convex.dev/plans`) did not load in
the research session; its figures below come from search-result extracts of
that page and are marked.

| Resource | Free plan | Professional | What counts | Status |
|---|---|---|---|---|
| Function calls | 1,000,000 / month total | 25,000,000 included | "Explicit client calls, scheduled executions, subscription updates, and file accesses count as function calls" | verified (docs) |
| Database I/O | 1 GB / month total | 50 GB included | "Document and index data transferred between Convex functions and the underlying database"; "Data not returned due to a `filter` counts as scanned" | verified (docs) |
| Database storage | 0.5 GB total | 50 GB | rows and indexes; "Each index is priced as another copy of the table" | verified (docs) |
| File storage | 1 GB total | 100 GB | Convex `_storage` files | verified (docs) |
| File egress | 1 GB / month | 50 GB | | verified (docs) |
| Action compute | 20 GB-hours / month | 250 GB-hours | Convex runtime 64 MiB, Node 512 MiB | verified (docs) |
| Concurrent sessions | 1,000 (S16 tier, Free and Starter) | 10,000 (S256) | one per connected client: **each online agent and each open dashboard tab** | verified (docs) |
| Concurrency | 16 queries, 16 mutations, 64 actions, 8 scheduled jobs; 4 MiB/s mutation write throughput | 256 / 256 / 512 / 256; 8 MiB/s | | verified (docs) |
| Per transaction | 16 MiB read, 16 MiB written, 32,000 docs scanned, 4,096 index ranges, 16,000 docs written | same | | verified (docs) |
| Document size | 1 MiB; 8,192 array elements | same | | verified (docs) |
| Developers / deployments | 1–6 / 40 (Free and Starter) | 1–20 / 300 | | verified (docs) |
| Free plan behaviour at the cap | "hard resource caps … new mutations that attempt to commit more insertions or updates may fail" | Starter: usage-based beyond the included amounts | | verified (docs) |
| Starter overage | function calls $2.20 per million beyond 1 M; action compute $0.33 per GB-hour | — | | **(unverified)**: search extract of `convex.dev/plans` |
| Database I/O overage price | ≈ $0.20–0.22 per GB | — | | **(unverified)**: third-party sites only |
| Referral bonus ("about 3 GB with referrals") | — | — | | **(unverified)**: no Convex page found; one forum user reports 4 GB with 4 referrals that dropped to 1 GB on moving to Starter |
| Cached query results | count as a function call, **no** database I/O; a re-run after invalidation costs full I/O; one subscriber re-runs, the others read the cache | | | **(unverified)**: Convex staff answers on the community Discord, not docs |
| Per-document / per-index rounding of I/O | not documented | | | **(unverified)**: the model uses 64 bytes per index entry, Section 1.2 |

Phase 4 Section 4.9 recorded the same free-plan figures on 2026-10-20; they
have not changed.

### 1.2 Accounting assumptions (the formulas)

All in `docs/plans/io-model.mjs`; change a constant there and re-run.

```
read(doc)            = docBytes + IDX                       // one document, by id or index
write(doc, k)        = docBytes + (k + SYS_IDX) × IDX       // insert or patch; k = user indexes
delete(k)            = (k + SYS_IDX) × IDX
IDX = 64 bytes, SYS_IDX = 2 (by_id, by_creation_time), 1 GB = 10^9 bytes
```

- A patch is counted as a full rewrite of the document and of every index
  entry (pessimistic; Convex may rewrite only changed index keys).
- A query re-run reads every document it touches again. A cache hit costs one
  function call and no I/O.
- Every re-run of a member query also pays `requireMember`:
  `authSessions` + `members.by_user` + `mfaSessions` ≈ **0.68 KB** (code:
  `convex/lib/authz.ts`).
- Document sizes (bytes): `devices` 450 (with two 64-hex secret hashes),
  `deviceStatus` 120, `orgStats` 150, `deviceReports` 1,500 (the compat JSON
  dominates), signed payload 12,000 for a Phase 4+5 document with the
  employees map (Phase 5 Section 14 says "typical ≤ 12 KB"), 8,000 without
  it, `auditLog` 450, `installResults` 300, rate-limiter row 150.
- Behaviour per device per day: 3 status changes, 4 reconnects, 4 presence
  transitions, 4 employee sign-ins, 0.5 device audit events, 0.05 new app
  installs, 0.8 Phase 5 report writes (Phase 5 Section 4.19).
- Tenant activity by size (admin edits/day, employee changes/day, dashboard
  hours/month): 2 PCs (0.1, 0.05, 2 h), 10 (0.3, 0.3, 8 h), 50 (1, 1.5, 30 h),
  200 (2, 5, 120 h), 1,000 (4, 20, 300 h). An admin edit republishes half the
  org's devices; an employee change republishes the devices of that
  employee's group (org size ÷ groups).
- Dashboard screen mix while open: overview 30 %, device list 40 %, device
  detail 15 %, audit 5 %, other 10 %; one Convex Auth refresh every 10
  minutes (`JWT_DURATION_MS`).

### 1.3 Flows: what each one reads and writes

"Now" = the Phase 4 / Phase 5 text and the code in `convex/` on
2026-10-27. "Proposed" = this plan.

| Flow | Now | Proposed | Why it changes |
|---|---|---|---|
| Agent subscription | `devices:desiredState` reads the device row (450 B) + newest `desiredStates` row (**12.4 KB payload**) + 3 `policyKeys`; re-runs on every new version, every device-row patch and (pessimistically) every reconnect | reads `deviceCredentials` (220 B) + `desiredHeads` (250 B) + the group's `rosterEpoch` (150 B); the body is fetched once per version with the one-shot `devices:fetchDesired` | a re-run costs 0.7 KB instead of 13 KB; signals (watch, check-now, roster) become cheap |
| Heartbeat / presence | `devices:heartbeat` every 5–60 min (fleet-size table): reads device row + `deviceStatus` + `orgStats`, **writes `deviceStatus` every call** | `devices:ping` every 30 min (free) / 5 min (paid): reads credentials + `deviceLiveness`, writes liveness (100 B); `devicePresence` and the org's presence counter change only on online/offline **transitions** | dashboards stop re-running on every ping |
| Status / compatibility | full 12-field report on change, compared against the device row; written into `devices` (Phase 2) / `deviceReports` (Step 7) | `deviceSummary` (the 7 list columns, 250 B) + `deviceReports` (detail, 1.5 KB) written separately, each on its own change; disk space quantized (Section 2.6) | the list re-runs only when a list column changes |
| Install results | one call per state transition (pending, downloading, installing, installed) | two writes per install (accepted, terminal), batched into `deviceApi:report` | half the writes, fewer calls |
| Audit events (device) | one `reportAudit` call per flush, idempotency read + insert per record | unchanged per record; flush at most every 10 min except security events (immediate) | — |
| Sign-in (`verifyEmployee`) | action + internal query + rate-limiter mutation (3 calls), reads device, employee, secret, lockout, membership, org; writes one limiter row | 2 calls; limiter consumed **only on a failed password** (Section 2.9) | successful sign-ins write nothing |
| Enrollment | one mutation: token, device, `deviceStatus`, token patch (≈ 3 KB once) | + `orgPlans` + `orgStats` check (`maxDevices`), credentials row, head row, audit (≈ 5 KB once) | limits; one-off cost is negligible |
| Rate limiter | `@convex-dev/rate-limiter` 0.4.2: each `limit` = one component mutation reading and writing one 150-byte row per key (patch, or insert for a new key); **rows are never deleted** | same, plus a weekly `clearAll` of rows older than 7 days (Section 2.9) | the table otherwise grows by one row per email / device ever seen |
| Member sign-in, MFA, sessions | Convex Auth 0.0.96: sign-in inserts `authSessions` + `authRefreshTokens`, our limiter row, `mfaSessions` + `memberSecrets` patch on TOTP (≈ 2 KB); **every 10 minutes a refresh** reads the token and session, patches the old token and inserts a new one (≈ 1 KB); used refresh tokens are kept until the session expires (7 days) | `JWT_DURATION_MS` 60 min (the session row is checked on every call, so revocation stays instant); maintenance deletes used refresh tokens older than 1 minute | 6× fewer refresh writes; the token table stops growing per open hour |
| Dashboard overview | `orgStats` + `deviceStatus.by_org_last_seen` `.take(1001)` + capped counts + 10 audit + 50-row audit scan for the publish banner; **re-runs on every heartbeat in the org** | one `orgStats` row with counters + 4 presence shards + 10 audit rows; re-runs on transitions, counter changes and new audit rows | Section 2.3 |
| Device list | `fleet:list` (50 devices + 50 reports + **50 newest payloads** for `latestVersion`) + `fleet:liveStatus` (50 status rows, re-runs on every visible heartbeat) | one query: 50 × (`devices` 300 B + `deviceSummary` + `devicePresence` + `desiredHeads`) | Section 2.5 |
| Device detail | `fleet:get` with **5 payloads** for the version list + live status | `desiredVersions` rows (150 B) for the list; that one device pings every minute while the page is open ("watch") | Section 2.2 |
| Audit screen | page of 50, re-runs on every new org audit row | same | acceptable |
| Publish fan-out | per device: read device, read newest payload (hash compare), build, write payload, read + delete the pruned payload, then every agent re-reads its payload: ≈ 55 KB per device per version | read head (hash), write body + head + version row, delete pruned body by id, agent reads body once: ≈ 21 KB | Section 2.4 |

### 1.4 Results

Output of `node docs/plans/io-model.mjs` (2026-10-27, unchanged constants).
"dev/GB" = devices per GB of database I/O per month for tenants of that
size.

**A. Phase 4 / 5 plans as written**

Per device per day, 10-device tenant (heartbeat every 5 min):

| Flow | Calls | Read KB | Write KB |
|---|---|---|---|
| heartbeat (write every call) | 288.0 | 262.7 | 108.3 |
| status report (on change) | 0 | 4.7 | 5.1 |
| publish (per device version) | 0.0 | 7.9 | 3.8 |
| agent subscription re-run | 4.3 | 59.9 | 0 |
| reconnect heartbeat | 4.0 | 3.6 | 1.5 |
| employee sign-in | 12.0 | 10.6 | 1.4 |
| device audit | 0.5 | 0.3 | 0.4 |
| install results | 0.2 | 0.2 | 0.1 |
| Phase 5 reports | 0.8 | 2.1 | 1.8 |
| **Total** | **309.8** | **474.4 KB read + written** | |

Dashboard, one open user-hour: 2 PCs 0.41 MB, 10 PCs 2.3 MB, 50 PCs 8.6 MB,
200 PCs 27 MB, 1,000 PCs **189 MB** (the overview alone re-reads up to 1,001
status rows on each of 1,000 heartbeats an hour: 618 MB per overview-hour).

| Tenant | Ping | Devices MB/mo | Dashboard MB/mo | Total MB/mo | Calls/mo | MB per device | Devices per GB |
|---|---|---|---|---|---|---|---|
| 2 PCs | 5 min | 27.8 | 0.8 | 28.7 | 18,637 | 14.3 | 70 |
| 10 PCs | 5 min | 142.3 | 18.4 | 160.7 | 93,728 | 16.1 | 62 |
| 50 PCs | 15 min | 386.5 | 258.3 | 644.8 | 182,290 | 12.9 | 78 |
| 200 PCs | 30 min | 1,374 | 3,243 | 4,617 | 447,622 | 23.1 | 43 |
| 1,000 PCs | 60 min | 7,379 | 56,789 | 64,168 | 1,542,979 | 64.2 | 16 |

Free 2-PC tenants that fit: **35 per 1 GB, 105 per 3 GB, 54 per 1 M calls.**

**B. With the rules of this plan** (free plan ping 30 min)

Per device per day, 10-device tenant:

| Flow | Calls | Read KB | Write KB |
|---|---|---|---|
| liveness ping | 48.0 | 21.5 | 17.1 |
| presence transitions (+ sweep) | 2.0 | 1.2 | 2.5 |
| status report (on change) | 0 | 5.3 | 6.0 |
| publish (head + body) | 0.0 | 0.3 | 1.4 |
| agent head re-run | 4.3 | 3.5 | 0 |
| agent body fetch (one-shot) | 0.1 | 1.3 | 0 |
| roster delta fetch | 0.1 | 0.1 | 0 |
| reconnect ping | 4.0 | 1.8 | 1.4 |
| employee sign-in (limiter on failure only) | 8.0 | 8.0 | 0 |
| install results (batched) | 0.1 | 0.1 | 0.1 |
| device audit (batched) | 0.3 | 0.2 | 0.4 |
| Phase 5 reports | 0.4 | 1.9 | 1.8 |
| **Total** | **67.3** | **75.8 KB read + written** | |

Dashboard, one open user-hour: 2 PCs 0.04 MB, 10 PCs 0.06 MB, 50 PCs 0.40 MB,
200 PCs 0.51 MB, 1,000 PCs 0.99 MB (the detail page's watch mode is ≈ 0.12 MB
of that per hour of detail view).

| Tenant | Ping | Devices MB/mo | Dashboard MB/mo | Total MB/mo | Calls/mo | MB per device | Devices per GB |
|---|---|---|---|---|---|---|---|
| 2 PCs | 30 min | 4.4 | 0.07 | 4.5 | 4,073 | 2.24 | 446 |
| 10 PCs | 30 min | 22.7 | 0.46 | 23.2 | 20,437 | 2.32 | 431 |
| 50 PCs | 30 min | 125.0 | 12.1 | 137.1 | 103,826 | 2.74 | 365 |
| 200 PCs | 30 min | 562.9 | 60.8 | 623.7 | 424,011 | 3.12 | 321 |
| 1,000 PCs | 30 min | 3,428 | 298.7 | 3,727 | 2,175,346 | 3.73 | 268 |

Free 2-PC tenants that fit: **223 per 1 GB, 669 per 3 GB, 246 per 1 M
calls, 500 by sessions** (if every PC were online at once).

**Paid "real-time" tier** (same rules, ping every 5 minutes): the liveness
ping becomes ≈ 232 KB per device per day, the rest stays ≈ 37 KB, so
≈ **8 MB per device per month, ≈ 125 devices per GB, ≈ 8,640 ping calls per
device per month** (Professional's 25 M calls ≈ 2,800 such devices). Price
paid tiers from these numbers, not from the free ones.

### 1.5 What dominates, and how sensitive it is

- **Pings dominate** in scenario B (51 % of device bytes, 71 % of calls).
  Every halving of the interval doubles them. That is why the interval is a
  plan setting (Section 3) and real-time is on demand (Section 2.2).
- **The overview dominates** scenario A for big tenants. Any query whose read
  set includes a row that changes on a timer is a defect (rule 2).
- **Document fan-out** is small in B because the roster no longer rides in
  the document: an employee change costs each device of the group one 0.7 KB
  head re-run plus a 0.4 KB delta fetch instead of a 13 KB payload read and a
  12 KB payload write.
- **Unknowns that could move the numbers by 2×:** per-index-entry size and
  rounding (IDX), whether a JWT refresh re-runs every open subscription
  (`authRerunOnRefresh`: if yes, each dashboard hour costs 6 extra full
  re-runs — ≈ +0.1 MB/hour in B, +1–15 MB/hour in A), whether a reconnect
  re-runs the subscription or reads the cache, real payload sizes (Phase 5
  Step 21 measures them).

### 1.6 Measurement procedure (for the owner; nothing was measured yet)

No number in 1.4 was measured. The author did not run `npx convex dev
--once` or touch the dev deployment. To measure:

1. **Separate project.** Create a new Convex project `rulebox-io-lab` in the
   Convex dashboard (free). Never point it at real devices. Deploy the code
   under test to it with `npx convex deploy` using that project's deploy key
   in a separate shell (`$env:CONVEX_DEPLOY_KEY = ...`); the repo's
   `.env.local` (dev deployment) is not touched.
2. **Probe build.** Set `RULEBOX_IO_PROBE=1` on that deployment only. The
   function wrappers (Section 2.13) then log one line per call:
   `io function=<name> reads=<n> readBytes=<b> writes=<n> writeBytes=<b>`
   with bytes = `JSON.stringify(doc).length` (an approximation of Convex's
   own accounting).
3. **One flow at a time.** With `scripts/fleet-sim.mjs` (Phase 4 Step 18,
   extended with `--flow <name> --count <n>`), run each flow in isolation in
   its own UTC day: 20 simulated devices × 24 h of pings; 100 sign-ins; one
   org-wide publish to 20 devices; one dashboard tab per screen for 1 h
   (Playwright, idle); one tab idle 1 h on the overview with 20 pinging
   devices (checks rule 2 and `authRerunOnRefresh`).
4. **Read Convex's numbers.** The next day, read the project's Usage page:
   function calls and database I/O for that day, by function if the page
   breaks it down **(unverified that it does; the dashboard's Insights page
   is expected to show bytes and documents read per function — confirm)**.
   Also `npx convex logs --prod` output of step 2 for the same window.
5. **Record and compare.** Write the numbers into
   `docs/plans/io-measurements.md` (new; one table per flow: model estimate,
   probe bytes, Convex-reported bytes, ratio). Adjust `IDX` and the document
   sizes in `io-model.mjs` until the model is within 25 % for every flow; re-run
   it and update Section 1.4.
6. **Delete the lab project** when done.

Cost: about 30,000 function calls and < 100 MB of I/O on the lab project's
own free allowance.

### 1.7 Measured vs estimated

| Item | Status |
|---|---|
| Convex plan limits (1.1) | verified from docs, except the rows marked |
| What Convex Auth and the rate limiter write per call | **read from the installed source** (`@convex-dev/auth` 0.0.96 `refreshSession.js`, `refreshTokens.js`, `rateLimit.js`; `@convex-dev/rate-limiter` `component/lib.js`, `schema.js`) |
| What our functions read and write | read from `convex/*.ts` (2026-10-27, partly uncommitted) and the Phase 4/5 plans |
| Every byte count and rate in 1.4 | **estimate** |

---

## 2. Design rules to stay inside the budget

### 2.1 Presence without timer writes in anything that is read live

Convex gives server code no "client disconnected" signal **(unverified that
none exists; none is documented)**, so "online" needs a periodic signal. The
design keeps that signal out of every live query:

| Table | Rows | Written | Read by |
|---|---|---|---|
| `deviceLiveness` | 1 per device: `deviceId`, `orgId`, `seenBucket` (Unix ms ÷ 60,000), `online: boolean` | by `devices:ping` and by **any** device call whose bucket differs (a sign-in or report counts as a ping) | `devices:ping`, the sweep, the device detail page while open (one row) |
| `devicePresence` | 1 per device: `deviceId`, `orgId`, `online`, `since` | only on a transition | `fleet:list`, `fleet:get` |
| `orgPresence` | 4 shards per org (16 above 1,000 devices): `orgId`, `shard`, `online: number` | only on a transition (`shard = hash(deviceId) % shards`) | `overview:get` (sums the shards) |

- **Online → offline** is found by `presence:sweep` (cron, every 5 minutes):
  `deviceLiveness.by_online_seen [online, seenBucket]` with `online = true`
  and `seenBucket < now − grace`, `.take(500)`, rescheduling while full.
  `grace = 2.5 × pingInterval + 1 min` of the device's org (read from a
  per-org map built once per sweep run from `orgPlans`, Section 3.1). It
  reads only devices that just went silent.
- **Offline → online**: the ping that finds `online = false` patches all
  three tables in one mutation.
- Dashboards show "Online" or "Offline since 14:05", never "last seen 40 s
  ago" on lists.

### 2.2 Adaptive intervals and real-time on demand

- **Base interval is a plan limit** (`limits.pingIntervalMs`): free 30 min,
  paid 5 min (Section 3.1); the server answers `nextPingInMs` on every ping;
  the agent clamps to `[60 s, 6 h]` (today `MAX_PING_MS` is 1 h; raise it so
  degrade mode 2 can work).
- **Watch mode** (device detail page): `fleet:watch({ deviceId })` (viewer,
  rate-limited 6/min per member) sets `desiredHeads.fastUntil = now + 5 min`
  (rounded up to the minute, written only when it extends the current value
  by ≥ 2 min). The agent's head subscription sees it and pings every 60 s
  until `fastUntil`. The page subscribes to that one `deviceLiveness` row and
  shows "Last contact 20 s ago". Cost: ≈ 0.12 MB per hour of open detail
  page (model).
- **Check now** (device list, ≤ 50 visible devices): `fleet:checkNow({ deviceIds })`
  (admin, 1 per minute per org) bumps `desiredHeads.pingNonce` on those
  devices; each agent pings within 0–5 s; `fleet:checkResult({ checkId })`
  (subscribed for at most 60 s) reads the ≤ 50 liveness rows and shows
  answered / no answer. Cost ≈ 65 KB per click for 50 devices.
- **Event pings**: the agent pings at once after a reconnect (with the
  jitter of Section 2.10), and any device call refreshes liveness, so a PC
  in use shows up without waiting for the interval.

### 2.3 Snapshot and counter tables (updated on change, never scanned)

`orgStats` (1 row per org) gains counters, each changed in the **same
mutation** that changes the counted thing: `deviceCount` (non-revoked),
`employeeCount`, `activeEmployeeCount`, `appCount`, `groupCount`,
`noGroupDeviceCount`, `outOfSupportCount`, `failedInstallCount`,
`storageBytes`, `publishFailedAt`, `lastActivityAt` (day resolution: written
at most once a day). A nightly `stats:reconcile` (one org per run, paginated)
recounts and fixes drift, writing only when a counter differs.

- `orgStats` is written by admin edits and rare device events; it is the
  only hot org row and stays below ~1 write/minute for a 1,000-device org.
  Presence counts live in the `orgPresence` shards so a reconnect storm
  does not conflict on `orgStats`.
- Never count with `.take(1001)` in a live query. Never scan the audit log
  for a banner.

### 2.4 Split tables by change rate; fixed-size documents; no big row rewritten for a small change

| Hot, small, read live | Cold, big, read once |
|---|---|
| `desiredHeads` (version, contentHash, keyId, bodyId, pingNonce, fastUntil, relocate flag) — the agent's subscription | `desiredBodies` (the signed payload) — `devices:fetchDesired({ version })` one-shot |
| `desiredVersions` (version, reason, createdAt, bodyId) — device page history | |
| `deviceCredentials` (secret hashes, state) — every device call | `devices` (name, group, ring, kiosk) — lists and the publisher |
| `deviceSummary` (list columns) | `deviceReports` (compat JSON, posture) — detail page |
| `deviceLiveness`, `devicePresence` | |

- The agent verifies the body's signature and that `version`, `keyId` and
  SHA-256 match the head before applying (the head itself is not signed; the
  body is, so a forged head can only cause a fetch that fails verification).
- **The employee roster leaves the device document.** Today
  `doc.employees` (id → credentialRevision) makes every employee change
  rewrite and re-read the whole document on every device of the group. It
  becomes a **signed per-group roster log**: `rosterEntries { orgId,
  groupId, epoch, employeeId, credentialRevision | removed, signature }`
  (signed `rulebox.roster/1\n<orgId>\n<groupId>\n<epoch>\n<employeeId>\n<rev|removed>`
  with the org signing key) and `groupRoster { groupId, epoch, snapshotEpoch }`.
  The head query reads `groupRoster.epoch`; the agent calls
  `devices:fetchRoster({ sinceEpoch })` (≤ 200 entries; above that, or when
  `sinceEpoch < snapshotEpoch`, it gets a signed full snapshot). Offline
  sign-in rules of Phase 4 Step 13 apply to the roster instead of
  `doc.employees`. Entries older than the snapshot are pruned.
- Rows that are rewritten on small changes stay small: no arrays that grow
  with fleet size inside a hot row; arrays in rows are capped (as Phase 4/5
  already do).

### 2.5 What may be subscribed, and how many rows a live query may read

| Never subscribe to | Instead |
|---|---|
| `deviceLiveness` (except one row on the watched detail page) | `devicePresence` |
| `deviceStatus.lastSeenAt` (retired) | presence transitions |
| `desiredBodies`, `desiredStates.payload` | `desiredHeads`, `desiredVersions` |
| `rateLimits`, `authRefreshTokens`, `employeeLockouts` lists | — |
| any table scanned to count | `orgStats`, `orgPresence` |

Read limits per execution of a live query (enforced by the probe test,
Section 2.13): **≤ 250 documents and ≤ 64 KB** for list screens (page of
50), **≤ 60 documents and ≤ 32 KB** for the overview, **≤ 20 documents** for
the agent's head query. Pages stay at 50 rows (`initialNumItems: 50`,
"Load more"); no screen loads more than 200 rows at once. Pickers that need
more than 200 options use search.

### 2.6 Write on change, quantize, coalesce

- **Write only when the stored value differs** (already Phase 4 rule 5);
  compare in the mutation, after reading the small row.
- **Quantize noisy values before comparing:** `diskFreeGb` is reported as a
  band (`<5`, `5–10`, `10–20`, `20–50`, `50–100`, `>100`) plus the exact
  value only in `deviceReports` when the band changes; RAM is static; CPU and
  memory pressure (PRD 22.6) become a **daily** summary in the existing
  Phase 5 `deviceSecurityDaily`-style row (`lowMemoryMinutes`,
  `cpuHighMinutes`), never a per-ping value.
- **Coalesce** device reports in the agent: status, install results, audit
  (non-security) and Phase 5 apply reports go out together in one
  `deviceApi:report` call at most every 60 s (security events at once).
- **Coalesce admin edits:** the 1.5 s publish debounce of Phase 4 stays;
  bulk screens (assign app to 10 groups) send one mutation.

### 2.7 Pagination and fan-out limits

Phase 4's limits stay (`PUBLISH_BATCH = 25`, `MAX_GROUP_EMPLOYEES = 2000`,
pages of 50). Added: `MAX_PUBLISH_DEVICES_PER_HOUR` per org = `4 ×
deviceCount + 100` (beyond it the queue waits; the dashboard shows "Changes
are being sent"), and the publisher waits `runAfter(250)` between batches
for orgs above 200 devices, so one tenant's republish cannot hold every
mutation slot (16 on the S16 tier).

### 2.8 Audit and log retention

| Data | Retention | Pruning |
|---|---|---|
| `auditLog` | by plan: free 30 days, paid 365 days (`limits.auditRetentionDays`) | `maintenance:pruneAudit`, per org through `auditLog.by_org_at` with the org's cutoff, 500 per run |
| `desiredBodies` / `desiredVersions` | 5 per device (Phase 4) | publisher, by id |
| `rosterEntries` | until the next snapshot (snapshot every 200 entries) | roster job |
| `deviceSecurityDaily`, `orgSecurityDaily` | 14 / 90 days (Phase 5) | Phase 5 rollup |
| `orgUsageDaily` | 400 days | maintenance |
| `authRefreshTokens` with `firstUsedTime` older than 60 s | deleted | maintenance (index `sessionId` per expired or live session batch) |
| `rateLimits` (component) | rows created > 7 days ago | weekly `clearAll({ before })` (resets those buckets; acceptable, they refill anyway) |
| `installResults` of removed devices or deleted apps | deleted with them | Phase 4 |
| Daily maintenance scans | must not page whole tables in a pooled deployment: `invites.by_expires_at`, `authSessions` expiry via a new `sessionExpiry { sessionId, expiresAt }` index table written at session creation **(or Convex Auth's own index if one exists — unverified)** | — |

### 2.9 Rate-limiter and auth writes

- `verifyPerDevice` is **checked** (read-only `check`) before the Argon2
  verify and **consumed only on a wrong password** (a correct password is
  no attack; Argon2 cost already bounds throughput). The server lockout
  (`employeeLockouts`) stays.
- `signInPerEmail` stays (one write per member sign-in attempt; rare).
- New per-tenant buckets (Section 4.4) are consumed by admin actions only.
- `JWT_DURATION_MS` 10 → 60 minutes: `getSignedIn` reads the session row on
  every call, so a deleted session still stops working at once; the JWT only
  bounds how long a stolen token works **without** the session row, which
  cannot happen. Refresh writes drop 6×.

### 2.10 Backoff, jitter and the thundering herd

- Agent: on any backend error, exponential backoff 5 s → 10 min with full
  jitter; a failed ping waits for the next slot (Phase 4) but never less than
  the backoff.
- After a disconnect longer than 5 minutes, the first ping waits a random
  0–120 s (today 0–10 s), and the server may answer `nextPingInMs` with an
  extra random spread of up to 25 % for the next three pings when
  `deploymentLoad = high` (set by the operator or by degrade mode).
- Reconnect re-subscribes the head (≈ 0.7 KB); nothing else runs until the
  first ping, so 1,000 devices returning cost ≈ 1 MB, not 13 MB.
- The Convex Rust client's own reconnect backoff **(unverified; read
  `convex` crate 0.10.x source before Phase 6)**.

### 2.11 Batching of agent reports

`deviceApi:report({ status?, summary?, installs?, audit?, apply?, findings?,
acks? })` replaces separate calls where they would fire within 60 s of each
other. One credentials read per call instead of one per report kind.
Idempotency rules of each part stay (audit `eventKey`, install upsert).

### 2.12 Degrade modes (shed load in this order)

The data plane computes `deploymentUsage` daily from `orgUsageDaily`
(Section 3.5) and the owner enters Convex's real month-to-date numbers from
the Usage page in the console (until an API exists **(unverified)**). Levels
are set automatically from the estimate and manually by an operator:

| Level | Trigger (month-to-date vs plan allowance, pro-rated) | Action | Never |
|---|---|---|---|
| 0 Normal | < 50 % | — | |
| 1 Watchful | ≥ 50 % | operator alert; "Check now" limited to 1 per 5 min per org | |
| 2 Slow | ≥ 70 % | free tenants: ping 60 min, watch mode off, audit page live updates off (manual refresh) | unlock, stop publishes |
| 3 Defer | ≥ 80 % | free tenants: ping 2 h; agents keep install progress and Phase 5 daily summaries local (send terminal states only); paid tenants unchanged | drop security audit (queue on device) |
| 4 Close the door | ≥ 90 % | new free sign-ups and new free enrollments refused ("We are at capacity"); dashboards of free tenants read-only except security actions (revoke, lock, PIN) | |
| 5 Freeze free tenants | ≥ 97 % or Convex warning e-mail | free tenants' agents told `nextPingInMs = 6 h`, publishes queued; devices keep their last signed document and stay locked | unlock; touch paid tenants |

A **single tenant** over its own budget (Section 3.5) gets the same ladder
applied to that tenant only, starting at level 2.

### 2.13 Write budget per feature, and the CI test

**Review rule:** every new or changed public or internal function adds or
updates its row in `convex/ioBudgets.ts`:

```ts
export const IO_BUDGETS: Record<string, { maxReads: number; maxReadBytes: number; maxWrites: number; maxWriteBytes: number; live?: true }> = {
  "devices:ping":         { maxReads: 2,   maxReadBytes: 1_024,  maxWrites: 1, maxWriteBytes: 512 },
  "devices:headState":    { maxReads: 4,   maxReadBytes: 2_048,  maxWrites: 0, maxWriteBytes: 0, live: true },
  "overview:get":         { maxReads: 60,  maxReadBytes: 32_768, maxWrites: 0, maxWriteBytes: 0, live: true },
  "fleet:list":           { maxReads: 250, maxReadBytes: 65_536, maxWrites: 0, maxWriteBytes: 0, live: true },
  // …
};
```

and the PR description states "writes per device per day" for any device
flow it adds (like Phase 5 Section 4.19).

**CI test** (`convex/ioBudgets.test.ts`, runs with Vitest and `convex-test`):

1. The wrappers in `convex/lib/functions.ts` wrap `ctx.db` in a counting
   proxy when `process.env.RULEBOX_IO_PROBE` is set (always in tests):
   counts documents returned by `get`, `first`, `unique`, `take`, `collect`,
   `paginate` and their `JSON.stringify` length, and every `insert`,
   `patch`, `replace`, `delete` with the written document's length.
   Component calls (rate limiter) count as one read + one write of 150 bytes.
2. A seed builds a "large org" fixture (200 devices, 300 employees, 30 apps,
   10 groups, 500 audit rows) and a second org.
3. The test walks the generated `api` (like Phase 4's authorization matrix),
   calls every function with fixture arguments, and asserts the counters are
   within its `IO_BUDGETS` row; a function without a row fails the test.
4. **Re-run test for live queries:** for each `live: true` query, record its
   read set (tables + index ranges) and assert that none of the "never
   subscribe" tables of 2.5 is in it, then run `devices:ping` for 50 devices
   and assert via convex-test's reactive `t.query` (or by re-checking the read
   set) that `overview:get` and `fleet:list` did not need to re-run **(how
   convex-test exposes invalidation is unverified; the read-set check is the
   fallback)**.

---

## 3. Quota and plan enforcement

### 3.1 Data model (data plane)

| Table | Size | Fields | Indexes |
|---|---|---|---|
| `orgPlans` | tiny (1 per org) | `orgId`, `plan: "free"\|"team"\|"custom"`, `status: "active"\|"suspended"\|"pendingDeletion"`, `limits: planLimits`, `degradeLevel: number` (0–5), `suspendedReason: v.optional(string)` (≤ 200, operator text, shown to the tenant), `deleteAfter: v.optional(number)`, `revision: number`, `updatedBy: string` (`"operator:<id>"` or `"system"`), `updatedAt` | `by_org [orgId]`, `by_status [status]`, `by_plan [plan]` |
| `planDefaults` | tiny (1 per plan) | `plan`, `limits: planLimits`, `revision` | `by_plan [plan]` |
| `signupEmails` | grows | `emailKey: string` (SHA-256 of the normalized address), `orgId`, `createdAt` | `by_email_key [emailKey]` |
| `orgUsageDaily` | grows (400 days) | `orgId`, `day`, `pings`, `publishBytes`, `reportWrites`, `signIns`, `dashboardMinutes`, `estimatedIoBytes`, `estimatedCalls` | `by_org_day [orgId, day]`, `by_day_io [day, estimatedIoBytes]` |

```ts
export const planLimits = v.object({
  maxDevices: v.number(),          // free 2
  maxEmployees: v.number(),        // free 25
  maxApps: v.number(),             // free 20
  maxGroups: v.number(),           // free 3
  maxMembers: v.number(),          // free 2
  auditRetentionDays: v.number(),  // free 30
  storageQuotaBytes: v.number(),   // free 1 GiB (Section 6)
  maxUploadBytes: v.number(),      // free 500 MiB
  pingIntervalMs: v.number(),      // free 1_800_000
  watchMode: v.boolean(),          // free true
  maxEnrollmentCodesActive: v.number(), // free 5
});
```

`planDefaults` are set by the operator (Section 5); `orgPlans.limits` is a
**copy** made at sign-up and changed only by the operator per tenant (no
silent change of existing tenants when the default changes; the console
offers "apply new default to all free tenants" as an explicit action).

### 3.2 Where limits are enforced (server only)

| Limit | Enforced in | Answer |
|---|---|---|
| `maxDevices` | `enrollment:enroll` (same transaction: `orgStats.deviceCount` vs `orgPlans.limits.maxDevices`; counts non-revoked devices) | `ConvexError({ code: "plan_limit", detail: "devices" })`; the agent shows "This organization has reached its device limit. Ask your administrator." and stays unenrolled |
| `maxDevices` after a downgrade | `orgPlans` change → `plans:applyLimits` job marks the newest devices beyond the limit `deviceCredentials.state = "overLimit"` (100 per run) | over-limit devices: the publisher skips them (they keep their last signed document and stay locked), pings answer `planState: "overLimit"`, the dashboard shows a red badge "Over plan limit — not updated" |
| `status = suspended` | same job sets `state = "suspended"` for every device; member wrappers refuse writes except revoke/lock/PIN/export | devices keep the last document; the dashboard is read-only with a banner and the operator's reason |
| `maxEmployees`, `maxApps`, `maxGroups`, `maxMembers`, `maxEnrollmentCodesActive` | the create mutations (read `orgStats` + `orgPlans`) | `plan_limit` with `detail` |
| `storageQuotaBytes`, `maxUploadBytes` | `files:beginUpload` (Section 6) | `plan_limit` |
| `auditRetentionDays` | `maintenance:pruneAudit` | — |
| `pingIntervalMs`, `watchMode` | `devices:ping`, `fleet:watch` | — |

Heartbeat-time enforcement reads **only** `deviceCredentials.state` (already
read for authentication), never `orgPlans` per ping.

### 3.3 What a limit-reached device and dashboard show

- Device enrolling over the limit: the CLI prints the message above, exit
  code 3; nothing on the PC changes (enrollment is atomic).
- Enrolled device over the limit after a downgrade: keeps working as it is;
  the Staff App shows nothing (employees are not the audience); the
  dashboard device row shows "Over plan limit — not updated" and the
  overview a banner "2 PCs are over your plan's limit. Contact us to
  upgrade, or remove PCs."
- Dashboard at a limit: the "Add" button stays enabled; the dialog explains
  the limit and shows a **Contact us** button (`mailto:` the address in
  `ORG_UPGRADE_CONTACT`, a data-plane env value, and a prefilled subject
  with the org's public id). No payment in v1 (billing placeholder, Section
  5.6).

### 3.4 Upgrade flow and operator changes

1. Tenant clicks Contact us → e-mail to the owner.
2. Operator opens the tenant in the console, edits plan and limits
   (step-up, Section 5.3), writes a note.
3. Console calls `platform:setPlan` (Section 4.5) with `expectedRevision`;
   the data plane writes `orgPlans`, an audit row in the **tenant's** audit
   log (`org.planChanged`, actor "Rulebox support"), and runs
   `plans:applyLimits` (clears `overLimit` when the new limit allows).
4. The tenant's dashboard updates live (it subscribes to its plan via
   `account:me`).

### 3.5 Per-tenant usage (estimated, cheap)

Convex reports usage per deployment, not per tenant. The data plane
estimates per tenant without a write per call:

- `orgStats` gains `publishBytesToday` (added once per publish **run**, not
  per device) and `reportWritesToday` (added in `deviceApi:report`, which
  already writes); pings are **not** counted per ping: the nightly
  `usage:rollup` estimates them as `deviceCount × 1440 ÷ pingMinutes` minus
  offline time from `devicePresence.since`.
- `dashboardMinutes` = refresh tokens created that day for the org's
  members' sessions × JWT minutes.
- `usage:rollup` writes one `orgUsageDaily` row per org per day with
  `estimatedIoBytes` from the Section 1.2 formulas, then resets the
  `*Today` counters.
- A tenant whose 7-day average exceeds 3× the plan's expected budget gets
  degrade level 2 automatically and appears on the console's "noisy
  tenants" list.

### 3.6 Abuse controls for free sign-up

| Control | Design |
|---|---|
| Hosted sign-up | `signup:start` HTTP action (`POST /signup/start`; HTTP actions see request headers, so the client IP from `CF-Connecting-IP` is available when the site is behind Cloudflare) → Turnstile token verified server-side; e-mail normalized; disposable-domain list (bundled static file, updated at release) refused; rate limits `signupPerIp` (5/hour), `signupGlobal` (60/hour) |
| E-mail verification | 8-digit code (SHA-256 stored, 15 min, 5 attempts) sent through an e-mail provider (Resend or similar, **free-tier limits unverified**); the org and the Owner account are created only after the code checks |
| One free org per verified e-mail | `signupEmails.by_email_key` on the normalized address (lower-case; for Gmail-style domains dots and `+tag` removed **for this check only**); a second free org for the same key → "You already have a free organization." |
| MFA | unchanged (Owner must enrol TOTP, Phase 4) |
| Enrollment abuse | `enrollGlobal` becomes per org (`enrollPerOrg` 10/min) plus a global 120/min; free plan `maxDevices = 2` caps the damage |
| Inactive free tenant cleanup | `lastActivityAt` = latest of member sign-in and device presence (day resolution, `orgStats`). Day 45 without activity: warning e-mail; day 60: second warning; day 75: `status = suspended`; day 90: `pendingDeletion` with `deleteAfter = +30 days`; then `tenants:purge` deletes every row of the org in batches. Devices of a deleted tenant are told `revoked` first and **stay locked**; the e-mails say this and link the "recover a PC" guide (local admin exit, `rulebox-agent recover`) |
| Content abuse (uploads) | Section 6 (scan, type and size limits) |

---

## 4. Pooled multi-tenancy security

### 4.1 Per-organization signing and sealing keys

Phase 5 Section 4.18 already specifies the design: a deployment master key
in env (`RULEBOX_MASTER_KEY`, 32 bytes), per-org Ed25519 signing seeds and
32-byte sealing keys stored wrapped in `orgKeys` with XChaCha20-Poly1305 and
AAD `orgId‖purpose‖keyId`. This plan adopts it unchanged and adds:

| Question | Answer |
|---|---|
| Who can use the master key | Only `convex/lib/keyring.ts`, called by the publisher mutation, the roster signer and the sealing action. No query imports it; a lint rule forbids importing `keyring.ts` outside an allow-list of three files. The control plane never has it. Convex deployment admins (the owner) can read env vars: they can sign for every tenant, and the terms must say so |
| Org creation | `keys:createOrgKeys` runs inside sign-up (action: random seed → internal mutation stores wrapped rows), so **an org can never exist without keys**; `enroll` refuses with `not_ready` until they exist (Phase 4 rule) |
| Rotation of an org key | Phase 4 endorsement flow, with the next seed created by `keys:createOrgKeys({ purpose, status: "next" })` instead of an env var. Owner-triggered from Settings → Signing |
| Rotation of the master key | Phase 5's `keys:rewrapAll` (50 rows per run), then swap env values; yearly and on every operator offboarding |
| Loss of the master key | every org key is lost; per org: Phase 4's "key lost" path (new key, re-enroll or `trust-key`). Prevention: two offline copies (owner's password manager + sealed paper), tested restore yearly on the I/O lab project |
| Compromise of the master key | rotate master key and **every org signing key** (endorsement flow); devices accept new keys only via endorsement by a key they trust, so a thief with the old key and DB write access could endorse their own key: treat as a full incident, re-enroll high-value tenants |
| External KMS | Phase 5 Q9 (b): when a paying tier exists. The `keyring.ts` interface (`unwrap(orgId, purpose, keyId)`) is the seam |

### 4.2 Per-organization Wi-Fi and other secret sealing

Phase 5 4.18 (sealed boxes bound to `orgId` and `deviceId`) is adopted.
Added rule: every future secret that a device needs follows the same
pattern (org sealing key at rest, per-device sealed box in the document);
none is stored in plain text, none is returned by any query, and the
platform API has no field that can carry one.

### 4.3 Tenant isolation: `orgDb` and the authorization test table

- **`orgDb(ctx)`** (new, `convex/lib/orgDb.ts`): the member wrappers hand
  handlers `ctx.db` wrapped so that `query(table).withIndex(name, q => …)`
  on any table with an `orgId` field throws unless the index's first
  equality is `orgId == ctx.orgId`, or the index is in the allow-list of
  id-scoped indexes (`by_device`, `by_group`, `by_employee`, `by_app`, …)
  **and** the id was returned by `getInOrg` / `assertInOrg` earlier in the
  same call (the wrapper records checked ids). `get(id)` on such a table
  returns `null` when `doc.orgId !== ctx.orgId`. Device wrappers do the same
  with the device's `orgId`. Cost: none (in-memory checks).
- **Authorization table** (extends Phase 4 Step 18 `authzMatrix.test.ts`):
  for every public function × caller ∈ {signed out, viewer, admin without
  MFA, admin, owner, device, **owner of org B**, **device of org B**,
  **suspended org's owner**, **platform API caller**, **platform API caller
  with a bad signature**} the expected answer (allowed / exact code). The
  test fails when a function is missing from the table.
- **Cross-tenant property test:** two orgs with identical names, usernames,
  app names and group names; for every query, every returned id belongs to
  the caller's org (walk the result JSON for `_id`-shaped strings and check
  their `orgId`).
- **Leak checks:** `secrets.test.ts` (Phase 4) also runs every
  `platform:*` function and asserts no field name or value from a deny-list
  (`secretHash`, `passwordHash`, `pinHash`, `wrapped`, `sealed`, `email` of
  employees, `summary` of audit rows, file names) appears.

### 4.4 Noisy neighbours and per-tenant rate limits

| Resource | Limit | Key |
|---|---|---|
| Admin mutations | 120 / min per member, 600 / min per org | `memberWrites`, `orgWrites` |
| Publishes | `MAX_PUBLISH_DEVICES_PER_HOUR` (2.7) | org |
| Enrollment | 10 / min per org, 120 / min global | `enrollPerOrg`, `enrollGlobal` |
| Employee creation / password sets | 300 / hour per org | `employeeWrites` |
| Check now / watch | 1 / min per org; 6 / min per member | `checkNow`, `watch` |
| Uploads | 20 / day per org, `maxUploadBytes` | `uploads` |
| Sign-in attempts | per e-mail (Phase 4) | — |
| Concurrency | publisher batches spaced (2.7); maintenance jobs one org per run | — |

Limits are consumed in mutations that already write (the limiter row write
is the only extra), and checked with the read-only `check` first.

### 4.5 The data-plane platform API (contract for the console)

**Transport.** Convex HTTP actions on the data plane under
`/platform/v1/*` (`convex/http.ts` route group, file `convex/platform.ts`).
Never a deploy key: a Convex deploy key gives full admin over the data plane
(read all tables, deploy code), which is exactly what the console must not
have.

**Authentication between planes.**

- The control plane holds an Ed25519 **platform signing key** in its own env
  (`PLATFORM_SIGNING_KEY`, plus `_NEXT` during rotation). The data plane
  holds the matching public keys in env (`PLATFORM_PUBLIC_KEYS`, a JSON list
  of `{ keyId, publicKey, notAfter }`).
- Request: headers `X-Rb-Key-Id`, `X-Rb-Timestamp` (Unix ms),
  `X-Rb-Nonce` (16 random bytes, hex), `X-Rb-Operator` (operator id, for
  audit), `X-Rb-Signature` = Ed25519 over
  `"rulebox.platform/1\n" + method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + operator + "\n" + sha256hex(body)`.
- Data plane checks: key id known and not past `notAfter`; |now −
  timestamp| ≤ 60 s; nonce unseen (`platformNonces { nonce, expiresAt }`,
  `by_nonce`, pruned hourly); signature; operator id format. Failure → 401
  with no detail; 10 failures/min → the route group answers 429 for 5 min
  and alerts.
- Rotation: add `_NEXT` public key to the data plane, switch the control
  plane to sign with `_NEXT`, remove the old public key after 24 h. Yearly
  and on every operator offboarding.
- Network: the data plane's HTTP actions are public on `*.convex.site`;
  security rests on the signature, not on IP. (Convex custom domains or IP
  allow-lists for HTTP actions: **unverified**.)

**Functions (exact list; nothing else exists).**

| Route | Returns / does | Never returns |
|---|---|---|
| `GET /platform/v1/tenants?cursor&limit≤100&status&plan` | page of `{ orgPublicId, name, plan, status, createdAt, lastActivityDay, counts: { devices, onlineDevices, employees, apps, groups, members }, agentVersions: top 3 with counts, degradeLevel }` | ids of internal rows, e-mails of members, anything per device |
| `GET /platform/v1/tenants/:orgPublicId` | the row above + `limits`, `revision`, owner e-mail **domain only** (`acme.com`), 30 days of `orgUsageDaily`, storage used | employee names, device names, audit contents, file names |
| `POST /platform/v1/tenants/:orgPublicId/plan` `{ plan, limits, expectedRevision, note }` | updates `orgPlans`, tenant audit row, `applyLimits` | — |
| `POST /platform/v1/tenants/:orgPublicId/suspend` `{ reason, expectedRevision }` | `status = suspended` | — |
| `POST /platform/v1/tenants/:orgPublicId/restore` `{ expectedRevision }` | `status = active` | — |
| `POST /platform/v1/tenants/:orgPublicId/delete` `{ expectedRevision, approvalId }` | `pendingDeletion`, `deleteAfter = +30 days` (only from `suspended`) | — |
| `POST /platform/v1/tenants/:orgPublicId/support-request` `{ minutes ≤ 60, reason }` | creates a pending request the **tenant Owner** approves in their dashboard; approval creates a time-boxed viewer membership for the named operator's support account (separate e-mail identity) | anything before approval |
| `GET /platform/v1/usage?day` | deployment totals of `orgUsageDaily` + top 20 tenants by estimated I/O | per-device rows |
| `PUT /platform/v1/plan-defaults/:plan` `{ limits, revision }` | `planDefaults` | — |
| `POST /platform/v1/degrade` `{ level, scope: "free" \| "all" \| orgPublicId }` | sets degrade level | — |
| `PUT /platform/v1/storage/accounts/:accountId` `{ provider, endpoint, region, bucket, capacityBytes, state, sealedCredentials }` | storage pool config (Section 6); the secret arrives **sealed** to the data plane's storage public key | the secret, ever |
| `GET /platform/v1/storage/accounts` | `{ accountId, provider, bucket, capacityBytes, usedBytes, tenants, state, errorRate24h }` | credentials |

`orgPublicId` is a random 12-character id stored on `organizations`
(`publicId`, index `by_public_id`), so Convex ids of the data plane never
leave it.

**What the API must never expose** (test-enforced, 4.3): signing or
sealing keys (wrapped or not), the master key, device secrets or their
hashes, employee records or names, member e-mails beyond the domain, audit
contents, file names or contents, desired-state payloads, Wi-Fi data, and
any write that publishes desired state or changes a device's document.

### 4.6 When and how a large tenant moves to its own deployment

**When:** a tenant above ~1,000 devices, one with contractual isolation or
data-residency needs, or one whose usage is > 25 % of the shared
deployment's.

**How (Phase H5, Section 8.1):**

1. Provision a deployment with the same code; set its master key.
2. `tenants:export` (internal, paged by `orgId` through every table's org
   index) writes JSONL; `tenants:import` on the target remaps every id
   (Convex ids are per deployment) and re-wraps `orgKeys` under the new
   master key (key ids unchanged, so devices keep trusting them).
3. **Relocation in the agent protocol** (reserve now, Section 7): the head
   gains `relocate: { url, deviceId, notBefore }` taken from a signed
   agent-only document key `relocate` (signed by the org key). The agent
   verifies the signature, stores the new URL and device id atomically with
   its existing device secret (the target already has the same secret
   hash), subscribes to the target, and falls back to the old URL for 7
   days if the target rejects it.
4. Members sign in at the tenant's own dashboard host; the hosted
   dashboard reads its Convex URL from `/config.json` at start (Section 7,
   cheap now) so a tenant subdomain can point at a different deployment
   without a rebuild.
5. After every device has moved, `tenants:purge` on the shared deployment.

---

## 5. Operator console plan

### 5.1 Stack

| Part | Choice |
|---|---|
| App | `apps/console/` — Vite + React + TS, `packages/ui`, Solar icons, offline-bundled fonts (CLAUDE.md rules apply) |
| Backend | a **separate Convex project** ("control plane"), functions in `convex-console/` (own `convex.json` / deploy key) |
| Hosting | Cloudflare Pages behind Cloudflare Access (SSO + hardware key + device posture), own domain `console.<domain>`; never on the tenant dashboard's origin |
| Operator auth | WebAuthn passkeys only, own implementation (`@simplewebauthn/server` in a Node action; Convex Auth has no WebAuthn provider **(unverified)**); sessions in control-plane tables; 8 h total, 15 min idle |
| Access binding | the console sends the Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`) with every sign-in; a Node action verifies it against the team's JWKS and `aud`; the operator session stores the Access subject and expires with it |
| Data-plane calls | only from control-plane **actions** that sign requests (4.5) |

The control-plane Convex URL is public like any Convex deployment; Access
protects only the static site. Every control-plane function therefore checks
the operator session itself (rule CR-3).

### 5.2 Screens

| Path | Screen | Data | Min role |
|---|---|---|---|
| `/` | Global health: deployment usage month-to-date vs allowance (estimate + owner-entered Convex figures), degrade level, tenants by plan/status, sign-ups this week, alerts | `cp:overview` | viewer |
| `/tenants` | List with search by name / public id, filters plan/status/degrade, sort by usage | `cp:tenants` (proxied page) | viewer |
| `/tenants/:id` | Metadata, counts, limits editor, usage chart (30 days), storage, support requests, operator notes, actions Suspend / Restore / Delete | `cp:tenant` | viewer / admin |
| `/usage` | Per-tenant I/O and calls (estimated), noisy tenants, degrade controls | `cp:usage` | viewer / admin |
| `/plans` | Plan defaults editor, "apply to all free tenants" | `cp:plans` | admin |
| `/storage` | Pool accounts: capacity, used, tenants, errors; add / drain / disable account; rotate credentials | `cp:storage` | admin (owner for credentials) |
| `/support` | Support access requests and active sessions, end session | `cp:support` | support |
| `/operators` | Operators, roles, passkeys, pending approvals (two-person) | `cp:operators` | owner |
| `/audit` | Operator audit log (hash chain status, last off-box export) | `cp:audit` | viewer |
| `/settings` | Platform key rotation status, contact address, legal links | `cp:settings` | owner |

### 5.3 Security requirements (from the recommendation file, numbered)

| # | Requirement |
|---|---|
| CR-1 | Separate app, origin, Convex deployment and auth from the tenant dashboard; no shared code paths that import tenant dashboard modules; no shared cookies |
| CR-2 | The console holds no signing, sealing or master key and has no function that publishes desired state |
| CR-3 | Every control-plane function goes through `operatorQuery/operatorMutation/operatorAction(minRole, { stepUp? })`; raw `query/mutation/action` imports are a lint error |
| CR-4 | Metadata only: the platform API (4.5) is the only path to tenant data |
| CR-5 | Support access is consented by the tenant Owner, ≤ 60 min, read-only, logged in both audit logs |
| CR-6 | Network layer: Cloudflare Access with SSO and a hardware key; device posture or mTLS; country allow-list |
| CR-7 | Passkeys only, no passwords; sessions ≤ 8 h, idle ≤ 15 min |
| CR-8 | Step-up (fresh passkey assertion ≤ 5 min) for suspend, restore, delete, plan change, degrade level ≥ 3, key rotation, storage credentials, support access, operator changes |
| CR-9 | Two-person rule for: delete tenant, rotate the platform key, add/remove an operator, change roles, break-glass use, degrade level 5. Approval is a second operator's step-up on a pending `approvals` row (expires in 24 h) |
| CR-10 | Roles `viewer < support < admin < owner`; 2–3 humans; no shared accounts |
| CR-11 | Break-glass: one sealed offline passkey, alarmed on use (e-mail to all operators), rotated after use |
| CR-12 | Operator audit log append-only, hash-chained (`hash = sha256(prevHash ‖ canonical row)`), exported hourly to a write-only bucket (credentials allow `PutObject` only) |
| CR-13 | Alerts on sign-in, failed sign-in, step-up, role change, support session, platform 401 bursts |
| CR-14 | Strict CSP (no inline script, no third-party, `frame-ancestors 'none'`), `X-Content-Type-Options`, Referrer-Policy, Permissions-Policy; no `dangerouslySetInnerHTML` |
| CR-15 | Typed server validators on every input; no server fetch of user-supplied URLs except the allow-listed data-plane URL |
| CR-16 | Generic errors, rate limits and lockouts on sign-in and on every mutation |
| CR-17 | Supply chain: pinned versions, `minimumReleaseAge`, lockfile review, secret and dependency scanning in CI, deploys only from the protected branch by CI |
| CR-18 | Independent penetration test of console + data plane before the first paying tenant and after every major change |
| CR-19 | Offboarding runbook: remove operator → rotate platform key → rotate data-plane master key → rotate storage credentials → review audit |
| CR-20 | Kill switch: degrade level 5 for all free tenants in one step-up + approval |

### 5.4 Test plan

- **Unit/integration (convex-test, control plane):** role matrix for every
  `cp:*` function (viewer/support/admin/owner/signed-out/expired session/no
  step-up/stale step-up); two-person approvals (same operator cannot
  approve own request; expired approval refused); hash-chain verification
  detects an edited or deleted row.
- **Platform API (data plane):** signature vectors (shared JSON file used by
  both planes); replay (same nonce) refused; timestamp skew 61 s refused;
  unknown key id refused; rotated-out key refused after `notAfter`; each
  route's response checked against the never-return deny-list (4.3).
- **E2E (Playwright, local):** sign in with a virtual WebAuthn
  authenticator (Chromium CDP virtual authenticator), change a plan, see
  the tenant dashboard update; suspend → tenant dashboard read-only.
- **Security:** CSP header test on the built site; `npm audit`-style
  dependency scan; a red-team checklist run before the pen test.

### 5.5 Threat model

| Threat | Impact | Control |
|---|---|---|
| Stolen operator password | — | there are no passwords (CR-7) |
| Stolen Access session | console page loads; no operator session | separate passkey sign-in (CR-7), Access JWT bound to the session |
| XSS in the console | acts as the operator within session | CSP (CR-14), no HTML injection, step-up for dangerous actions (CR-8), two-person for the worst (CR-9) |
| Compromised operator laptop | as XSS, plus passkey use while unlocked | device posture (CR-6), short idle timeout, step-up, alerts (CR-13) |
| Malicious operator | suspend/delete tenants, change plans | metadata-only API, two-person delete, 30-day soft delete, off-box audit (CR-12); cannot sign policies or read data (CR-2, CR-4) |
| Leaked platform signing key | forge platform API calls (suspend, plan) | no publish/no data routes exist; rotation (4.5); 401 burst alerts; nonce + timestamp |
| Control-plane database leak | operator list, notes, usage metadata | no tenant secrets stored; storage credentials are only ever sealed to the data plane |
| Data-plane bug crossing tenants | tenant data leak | `orgDb`, authorization table, cross-tenant property test (4.3) |
| Replay of a captured platform request | repeat a suspend | nonce table + 60 s window + `expectedRevision` |
| Supply-chain compromise | code in either plane | CR-17, separate deploy keys per plane |
| Operator offboarding forgotten | lingering access | CR-19 runbook, quarterly access review |

### 5.6 Edge cases

| Case | Rule |
|---|---|
| Two operators edit the same tenant | every write carries `expectedRevision`; the second gets "Changed by <operator> at <time>. Reload." |
| Operator offboarding | CR-19; their pending approvals expire; their support memberships are deleted in the data plane (`support-request` sessions end) |
| Tenant deletion requested by the tenant | Owner clicks "Delete organization" (step-up TOTP) in the tenant dashboard → `pendingDeletion` for 30 days with "Restore" for the Owner; then purge. Console sees status only |
| Tenant export | Owner-only "Export" in the tenant dashboard (members, devices, employees without secrets, apps, groups, audit) as JSON through a Convex file with a 24 h link; never available to the console |
| Billing | placeholder: `orgPlans.plan` and `limits` only; "Contact us"; a billing provider is a later decision (never store card data) |
| Control plane down | tenants unaffected (the data plane does not depend on it); plan changes wait |
| Data plane down | console shows "data plane unreachable"; no retries faster than 30 s |
| Clock skew between planes | 60 s window; console shows the skew from the data plane's `Date` header |

### 5.7 Implementation steps (console)

#### Step C1 — Control-plane project and operator auth

**Files:** `convex-console/{schema.ts,auth.ts,lib/functions.ts,lib/webauthn.ts,lib/audit.ts}`,
`apps/console/` skeleton, `pnpm dev:console` script.
1. Tables `operators`, `operatorPasskeys`, `operatorSessions`, `approvals`,
   `operatorAudit` (hash-chained).
2. WebAuthn registration (invite code made by CLI for the first owner) and
   sign-in in Node actions; Access JWT verification.
3. Wrappers with role, step-up and audit; lint rule.
**Verify:** convex-test role matrix; Playwright virtual authenticator
sign-in. **Done when:** an owner can sign in locally with a virtual
passkey and every function is behind a wrapper. **Do NOT:** add a
password provider; reuse the tenant dashboard's auth.

#### Step C2 — Platform API in the data plane

**Files:** `convex/platform.ts`, `convex/http.ts` (route group),
`convex/lib/platformAuth.ts`, `convex/schema.ts` (`platformNonces`,
`organizations.publicId`), shared vectors `packages/types/platform-vectors.json`.
**Verify:** signature vectors in both planes; replay/skew/unknown-key tests;
deny-list test. **Done when:** every route of 4.5 answers correctly to
signed requests and 401 otherwise. **Do NOT:** add a route not in 4.5;
use a deploy key.

#### Step C3 — Tenants list and detail

**Files:** `convex-console/tenants.ts` (actions calling the API, cached in a
`tenantCache` table refreshed on demand, never a polling loop),
`apps/console/src/screens/{Tenants,Tenant}.tsx`.
**Done when:** list, search, detail render from the API.
**Do NOT:** store tenant metadata longer than 24 h in the control plane.

#### Step C4 — Plans, limits, suspend/restore/delete

Step-up, two-person delete, `expectedRevision`. **Verify:** E2E: change
`maxDevices` → enrollment of a third device refused in the data plane.

#### Step C5 — Usage and degrade controls

`/usage`, `/` health; owner enters Convex month-to-date figures; degrade
API. **Done when:** level changes reach agents' `nextPingInMs` in a
simulated fleet.

#### Step C6 — Support access

Tenant-side approval UI in the tenant dashboard (Settings → Support),
time-boxed membership, both audit logs. **Do NOT:** allow writes in support
sessions.

#### Step C7 — Storage pool screens (with Section 6 Step S2)

#### Step C8 — Operator management, approvals, audit export, alerts

#### Step C9 — Hardening and pen-test preparation

CSP, headers, dependency and secret scanning in CI, runbooks
(`docs/ops/{incident,offboarding,break-glass}.md`).

---

## 6. File storage pool plan

### 6.1 Decision first: pooled free accounts or one paid account

The owner's idea (`.personal/installer-hosting-tigris.md`) pools several
free Tigris accounts. Research (2026-10-27, search extracts of
`tigrisdata.com/pricing`): Tigris free = 5 GB storage, 10,000 class A and
100,000 class B requests per month, free egress; paid = $0.02 per
GB-month, $0.005 per 1,000 class A, $0.0005 per 1,000 class B
**(unverified on the page itself)**. Cloudflare R2: 10 GB-month, 1 M class
A, 10 M class B free, $0.015 per GB-month, free egress **(unverified on the
page itself)**.

At those prices 100 free tenants × 1 GB = 100 GB costs about **$2 a month**
on one paid account. Pooling free accounts saves that and risks the
provider's terms (multiple accounts to get around free limits are commonly
forbidden — **Tigris's terms not checked: unverified**); a ban would break
every tenant's installs at once. **Recommendation (Q4): one paid account
per provider, with the pool abstraction kept** for capacity, regions,
provider failover and the operator's ability to add accounts. The design
below works for both.

### 6.2 Provider abstraction

```ts
// convex/lib/storage/provider.ts (Node runtime actions only)
export interface StorageProvider {
  presignPut(o: { key: string; contentLength: number; contentType: string; sha256B64?: string; expiresSec: number }): Promise<string>;
  presignGet(o: { key: string; expiresSec: number; filename: string }): Promise<string>;
  head(key: string): Promise<{ size: number; etag: string } | null>;
  delete(key: string): Promise<void>;
}
// S3-compatible implementation (SigV4) covers Tigris, R2, B2; one per account row.
```

### 6.3 Data model (data plane)

| Table | Fields | Indexes |
|---|---|---|
| `storageAccounts` | `accountId`, `provider: "tigris"\|"r2"\|"s3"`, `endpoint`, `region`, `bucket`, `capacityBytes`, `usedBytes`, `state: "active"\|"draining"\|"full"\|"disabled"`, `sealedCredentials` (sealed to the data plane's storage key), `credentialsKeyId`, `errorCount24h`, `revision` | `by_account [accountId]`, `by_state_used [state, usedBytes]` |
| `tenantStorage` | `orgId`, `homeAccountId`, `usedBytes`, `reservedBytes` | `by_org [orgId]` |
| `files` | `orgId`, `accountId`, `objectKey` (`t/<orgPublicId>/<random>`), `name` (≤ 120, display only), `kind: "installer"\|"icon"`, `sizeBytes`, `sha256` (server-computed), `state: "uploading"\|"scanning"\|"clean"\|"rejected"\|"deleted"`, `rejectReason`, `createdBy`, `createdAt`, `deleteAfter` | `by_org_created [orgId, createdAt]`, `by_state_created [state, createdAt]`, `by_account [accountId]` |

Credentials: the operator types them into the console once; the console
seals them (X25519 sealed box, the Phase 5 `rulebox.seal/1` construction)
to the data plane's **storage public key** (`STORAGE_SEAL_PUBLIC_KEY`
published by `GET /platform/v1/storage/key`) and sends only the sealed
blob. Only `convex/lib/storage/credentials.ts` (Node action) unseals with
`STORAGE_SEAL_PRIVATE_KEY` (data-plane env). Never in the browser, never in
a query result, never logged. Rotation: add new credentials as a new
revision, switch, delete the old key at the provider.

### 6.4 Flows

1. **Upload** (admin): `files:beginUpload({ name, sizeBytes, kind })`
   (action) checks `maxUploadBytes`, extension and type list, the per-org
   upload limit and `tenantStorage.usedBytes + reservedBytes + size ≤
   storageQuotaBytes`; reserves the bytes; picks the account (6.5); inserts
   `files` (`uploading`); returns a **presigned PUT** URL (expires 15 min,
   `Content-Length` and `Content-Type` signed). The browser uploads directly.
2. **Finish:** `files:finishUpload({ fileId })` → `head` checks size → state
   `scanning` → signed request to the **scanner** (6.6).
3. **Scanner result** (HTTP action `/storage/v1/scan-result`, signed by the
   scanner key): sets `sha256` (computed by the scanner while streaming the
   object; never trusted from the browser), `clean` or `rejected`; moves the
   reservation to `usedBytes`. Only `clean` files can be picked for an app.
4. **Install on a device:** the catalogue entry carries `{ source: "hosted",
   fileId, sha256, sizeBytes }` (signed). Right before downloading, the agent
   calls `deviceApi:downloadUrl({ fileId })` (one-shot; checks the file is
   assigned to an app the device has) → presigned GET, 60 min, with HTTP Range
   (resume) **(Range on presigned GET for Tigris: unverified; R2 and S3
   support it)**. The agent verifies SHA-256 as in Phase 4.
5. **Delete:** removing an app that is the last user of a file sets
   `deleteAfter = now + 7 days`; `files:purge` (daily) deletes the object and
   the row and frees the bytes. Tenant purge deletes the prefix.
   `uploading` rows older than 24 h are deleted with their objects.

### 6.5 Account selection and automatic switch

- New uploads go to `tenantStorage.homeAccountId` while that account is
  `active` and below 90 % of `capacityBytes`; otherwise the router picks the
  `active` account with the lowest `usedBytes ÷ capacityBytes`
  (`by_state_used`) and makes it the tenant's new home. A tenant's existing
  files stay where they are (the `files` row knows its account).
- At 90 % an account becomes `full` (no new uploads); at 3 failed calls in
  5 minutes, `disabled` for 15 minutes (circuit breaker) and an operator
  alert. All accounts full → `files:beginUpload` answers `storage_full` and
  the operator is alerted; nothing else breaks.
- `draining` (operator): no new uploads; a migration job copies files to
  other accounts (server-side copy is not possible across providers: the
  scanner worker streams them) and updates rows.

### 6.6 Malware scanning

Convex actions cannot run a scanner (no binaries; 64/512 MiB). Use a small
**scanner worker** (container with ClamAV + a SHA-256 stream, on a cheap
host such as Fly.io or Cloudflare Containers **(host choice and limits
unverified)**) that receives a presigned GET, streams the object, computes
SHA-256, scans, and posts the signed result. Optional second opinion: a
VirusTotal **hash lookup** (no upload); the public API's terms forbid
commercial use **(unverified; check before using)**. Rejected files are
deleted within 24 h and an audit row `file.rejected` is written in the
tenant's log.

### 6.7 Limits, cost and failure handling

| Item | Free plan | Paid |
|---|---|---|
| File types | `.msi`, `.exe`, `.msix` installers (magic bytes checked by the scanner: `MZ`, OLE CFB, ZIP for MSIX); icons `.png` ≤ 256 KB | same |
| Max file | 500 MiB | 4 GiB |
| Quota | 1 GiB | by plan |
| Upload rate | 20 per day | by plan |

Cost at the unverified prices: storage $0.015–0.02 per GB-month, egress
free (R2, Tigris); scanner host a few dollars a month. Failures: provider
outage → installs fail with `download_failed` and retry with backoff
(Phase 4 engine); scanner outage → files stay `scanning`, the dashboard says
so; quota race → reservations make it impossible to exceed.

### 6.8 What the dashboard and the console show

- **Dashboard:** Apps → "Upload installer" with progress, scan state
  pills (`Uploading`, `Scanning`, `Clean`, `Rejected: <reason>`),
  Settings → Storage bar "0.4 of 1 GB used", the file list with Delete.
- **Console:** `/storage` accounts table (capacity, used, tenants, state,
  errors), add/drain/disable, rotate credentials; tenant detail shows
  storage used vs quota.

### 6.9 Steps (storage)

- **S1** — provider interface, `files`/`tenantStorage`/`storageAccounts`
  tables, upload/finish/purge with a fake provider in convex-test.
- **S2** — console storage screens and sealed credentials (with C7).
- **S3** — scanner worker and signed result route; vectors for the signature.
- **S4** — dashboard upload UI; agent `downloadUrl`; catalogue `hosted`
  source (Phase 4 Step 10/14 extension).
- **Do NOT:** put credentials in an env var per account in the browser
  build, trust a client SHA-256, serve files through Convex file storage,
  allow any type outside the list.

---

## 7. Amendments to existing plans

"When" = **BEFORE** means the change must be made before the named Phase 4
step is written, because doing it afterwards means rewriting that step's
code and tests (or, for agent protocol items, shipping a protocol change to
devices). "Cost later" is the price of postponing it.

| # | Plan / file | Exact change | Reason | When | Cost later |
|---|---|---|---|---|---|
| A1 | Phase 4 4.2, Step 6/8 `enroll` | Add `orgPlans` (3.1) and enforce `maxDevices` in `enrollment:enroll` (`plan_limit`); `setup:createOwnerInvite` creates `orgPlans` with the self-host plan `custom` and no limits | pooled free tier depends on it; same transaction as the device insert | **BEFORE Step 6** (enrollment) | medium: enroll is the security-sensitive mutation, rework + retest |
| A2 | Phase 4 4.2, 4.6, Step 7/12, `lib/deviceAuth.ts` | Move `secretHash`, `previousSecretHash`, `rotateCredential`, `revoked` into `deviceCredentials { deviceId, orgId, secretHash, previousSecretHash?, rotate?, state }`; device wrappers read only that row | every device call reads 220 B instead of the 450 B device row; rename/move stop re-running the agent subscription | **BEFORE Step 7** | high: every device function and test |
| A3 | Phase 4 4.9, Step 7, dashboard `useLiveStatus`, `LiveStatus` type, `lib/online.ts` | Replace "heartbeat writes `deviceStatus.lastSeenAt` every call" with `deviceLiveness` / `devicePresence` / `orgPresence` + `presence:sweep` (2.1); remove `fleet:liveStatus`; `DeviceRow` gains `presence: { online, since }`; overview uses shard sums | read amplification of every open list and overview | **BEFORE Step 7** | high: hooks, screens and agent timing |
| A4 | Phase 4 4.9 table, `lib/heartbeat.ts` | `pingIntervalFor(plan)` from `orgPlans.limits.pingIntervalMs` (free 30 min, paid 5 min, self-host default 5 min) instead of fleet size; `devices:heartbeat` renamed `devices:ping` (keep the old name as an alias for Phase 2 agents until Phase 6) | interval is the largest lever; must be a plan setting | **BEFORE Step 7** | low |
| A5 | Phase 4 4.4, 4.5, 5.1, Step 8, Step 9, Step 13; `crates/rulebox-policy` | Head/body split: `desiredHeads` (subscribed), `desiredBodies`, `desiredVersions`; agent subscription returns the head; new one-shot `devices:fetchDesired({ version })`; pruning by id; `fleet:list`/`fleet:get` read heads/versions, never payloads | subscription re-runs drop from ~13 KB to ~0.7 KB; enables watch/check-now/roster signals | **BEFORE Step 8** (publisher) and Step 9 (agent) | very high once agents ship: wire protocol |
| A6 | Phase 4 4.4 (doc `employees`), 4.12, Step 11, Step 13; Phase 5 4.3 | Employee roster out of the device document into the signed per-group roster log (2.4); offline sign-in checks the roster | employee changes stop republishing whole documents (the largest fan-out) | **BEFORE Step 8**; agent side in Step 13 | very high after Phase 6 |
| A7 | Phase 4 4.13 overview, Step 17, `OverviewScreen` type | `overview:get` reads `orgStats` counters (2.3) + presence shards + 10 audit rows; no `.take(1001)`; `publishFailedAt` from `orgStats`, not an audit scan; counters maintained in the same mutations | overview re-ran on every heartbeat reading up to 1,001 rows | before Step 17 (counters from Step 5 on: each create/delete mutation updates its counter) | medium |
| A8 | Phase 4 Step 7 `fleet:list`, `fleet:get`, 4.2 `deviceReports` | Split `deviceSummary` (list columns) from `deviceReports`; lists never read `desiredStates`; `latestVersion` from the head | lists re-read 50 payloads (≈ 650 KB) per re-run | **BEFORE Step 7** | medium |
| A9 | Phase 4 Step 12, `lib/rateLimits.ts` | `verifyPerDevice` checked before and consumed only on a wrong password; per-org `enrollPerOrg`; add weekly `rateLimits` cleanup; per-tenant buckets of 4.4 | successful sign-ins write nothing; limiter table stops growing forever | **BEFORE Step 12** | low |
| A10 | Phase 4 Step 3 (in progress), `lib/limits.ts`, `maintenance.ts` | `JWT_DURATION_MS` 10 → 60 min; maintenance deletes used `authRefreshTokens` (> 60 s after `firstUsedTime`); maintenance stops paging whole `authSessions`/`invites`/`mfaSessions` tables (indexed expiry, 2.8) | refresh writes ×6 and unbounded token rows per open hour; full scans grow with tenants | now (Step 3 is uncommitted; tell the backend agent) | low |
| A11 | Phase 4 4.5, Step 8 `lib/signing.ts` | Write `loadOrgSigningKey(ctx, orgId)` as the only signing entry point now (env-seed implementation in Phase 4; `keyring.ts` in Phase 5 Step 10); `keys:registerActive` per org | per-org keys (Phase 5 4.18) become a swap of one function | **BEFORE Step 8** | medium |
| A12 | Phase 4 Step 12/13, agent `backend/task.rs`, `backend/mod.rs` | `deviceApi:report` batched call (2.11); install reports: accepted + terminal only; agent backoff with full jitter (2.10); first ping jitter 0–120 s after a > 5 min outage; `MAX_PING_MS` 1 h → 6 h; ping answer carries `planState` and `nextPingInMs` | write and call budget; degrade modes need long intervals | **BEFORE Step 12** (server) and Step 13 (agent) | medium |
| A13 | Phase 4 Step 13 agent + `rulebox-policy` | Reserve the agent-only document key `relocate` and head fields `pingNonce`, `fastUntil`; agent pings on nonce change and every 60 s until `fastUntil` | watch/check-now and future tenant moves without another protocol bump | before Step 13 | high after Phase 6 (devices in the field) |
| A14 | Phase 4 4.11, `maintenance.ts` | Audit retention from `orgPlans.limits.auditRetentionDays` (per org, `by_org_at`); no audit row for successful employee sign-ins (already true; keep it) | free tenants' audit is the largest growing table | before Step 17 | low |
| A15 | Phase 4 4.6 "Ready for more than one organization", Step 18 | `orgDb` runtime scoping (4.3); authorization table gains org-B, suspended and platform callers; cross-tenant property test | pooled = one missed check leaks across tenants | Step 2 wrappers exist; add `orgDb` **before Step 7** so every new query is born scoped | medium (retrofit + audit of all queries) |
| A16 | Phase 4 Step 18 `fleet-sim.mjs`; new `convex/ioBudgets.ts` + test | I/O probe in the wrappers, budgets table, CI test (2.13) | rule 1 | with A15 | low |
| A17 | Dashboard `src/data` (`api.ts`, `types.ts`, README) | `useLiveStatus` removed; `DeviceRow.presence`; `useWatchDevice`, `useCheckNow`, `useCheckResult`; `OverviewScreen` adds `onlineCount`, `overLimitCount`, `plan`; `Me` adds `plan: { name, limits, status }`; `plan_limit` error code; demo fixtures updated | screens must follow A3, A7, 3.3 | with A3 / A7 | low now (fixtures only) |
| A18 | Dashboard `main.tsx` | Read the Convex URL from `/config.json` at start (fallback `VITE_CONVEX_URL`) | tenant moves (4.6) and one hosted build for several deployments | any time before Phase 6 hosting | low |
| A19 | Phase 5 4.2, 4.19, Steps 9–10 | Apply reports, findings and daily summaries go through `deviceApi:report` (A12); Phase 5 document additions go into `desiredBodies` (A5); `orgKeys` creation at sign-up (4.1); daily CPU/memory summary (2.6) joins `deviceSecurityDaily` | consistency with A5/A12; PRD 22.6 without per-ping values | before Phase 5 Step 9 | low |
| A20 | Phase 5 Step 10 | Per-org keys **must** be done before the first outside tenant (already stated); add `keys:createOrgKeys` to sign-up and a test "no org without keys" | pooled launch blocker | as Phase 5 | — |
| A21 | Phase 6 plan (not written) | Include: I/O measurement (1.6) during the pilot; installer hosting via Section 6 (replaces PRD 16's R2-only line — tell the user, update the PRD); agent `downloadUrl` flow | real numbers before pricing | when Phase 6 is written | — |
| A22 | PRD 11 / 11.1, 16, 22.6 | 11: "interval grows with fleet size" → "interval is set by plan; real-time on demand"; 11.1 rule 4 add "dashboards read transitions, not timestamps"; 16: installer storage via the provider pool; 22.6: CPU/memory as daily summary | the PRD must match (CLAUDE.md: tell the user) | with this plan's approval | — |

**Top 10 by urgency:** A5, A6, A2, A3, A1, A8, A4, A11, A12, A10.

---

## 8. Phase order, effort, risks, questions

### 8.1 Phase order after Phase 5

Effort in focused engineering weeks for one developer with agent help;
±50 %.

| # | Phase | Contents | Effort | Depends on |
|---|---|---|---|---|
| — | Phase 4 amendments | A1–A17 folded into the remaining Phase 4 steps (not a separate phase) | +1.5–2 weeks on Phase 4 | now |
| 6 | Installer + pilot | Phase 6 as planned + 1.6 measurement + A21 | as planned + 1 week | Phase 5 |
| H1 | Pooled data plane readiness | plans/limits (3), sign-up with abuse controls, `orgDb` audit, per-tenant usage and degrade ladder (2.12), retention, tenant export/delete, `orgPublicId`, legal pages placeholders, Convex paid plan switch | 3–4 weeks | Phase 5 Step 10 (org keys) |
| H2 | Operator console | Section 5 (C1–C9) | 3–4 weeks | H1 |
| H3 | File storage pool | Section 6 (S1–S4) + scanner | 2–3 weeks | H1; C7 with H2 |
| H4 | Launch hardening | pen test (external), status page, backups and restore drill, runbooks, alerting, load test with 500 simulated devices on a paid lab project | 2 weeks + external lead time | H1–H3 |
| H5 | Silo moves (when a large tenant needs it) | 4.6 export/import, relocation in the agent | 2 weeks | Phase 6 agents with A13 |

### 8.2 Risks

| Risk | Impact | Handling |
|---|---|---|
| Model off by 2× (index accounting, cache behaviour) | budgets wrong | 1.6 measurement before pricing; degrade ladder |
| Free plan hard cap hit | writes fail for every tenant | paid plan from the first outside tenant (Q1) |
| 1,000 concurrent sessions on S16 | > 1,000 online PCs + dashboards fail to connect | Professional plan (10,000) when online devices approach 700 |
| 30-minute presence feels "not real-time" | product perception | watch mode, check-now, event pings; paid 5-minute tier |
| Convex Auth beta changes refresh behaviour | A10 assumptions break | pinned version; re-read source on each upgrade |
| One tenant's republish starves others (16 mutation slots) | latency spikes | 2.7 spacing and hourly cap |
| Pooled authorization bug | cross-tenant leak | `orgDb`, authorization table, property test, pen test |
| Storage provider terms / account ban | installs break | one paid account (Q4), abstraction, second provider ready |
| Scanner false positives on legitimate installers | blocked rollouts | operator override per file hash with audit (owner role only) |
| Master key in Convex env | owner/insider can sign for all tenants | documented; KMS later (Phase 5 Q9) |

### 8.3 Edge cases (I/O and limits)

| Case | Rule |
|---|---|
| Device clock wrong | buckets use server time only |
| Device pings during sweep | mutation serializability: last writer wins; a device marked offline by the sweep is marked online by its next ping (one extra transition, accepted) |
| Mass reconnect after a Convex incident | head re-subscriptions only; pings jittered 0–120 s (2.10) |
| Downgrade from 50 to 2 devices | newest 48 `overLimit`, kept locked, not updated; dashboard explains |
| Org suspended mid-publish | publisher checks `orgPlans.status` per run; queue kept |
| Watch left open overnight | `fastUntil` renewed only while the page is visible (`document.visibilityState`) |
| Roster gap after long offline | agent asks from its epoch; server answers a signed snapshot |
| Self-hosted deployment | `orgPlans` `custom` with unlimited limits and 5-minute ping; no sign-up routes (env `RULEBOX_HOSTED` unset) |

### 8.4 Open questions for the owner

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q1 | Convex plan for the shared data plane | (a) stay on Free until it fills; (b) Starter pay-as-you-go from the first outside tenant; (c) Professional from launch | **(b)**, with a usage alert at 50 % and Professional when online devices approach 700 or I/O passes ~20 GB/month. On Free, hitting the hard cap breaks writes for every tenant |
| Q2 | Free plan presence interval | (a) 30 min + watch/check-now; (b) 15 min; (c) 5 min | **(a)**; it is the difference between ≈ 220 and ≈ 70 free tenants per GB |
| Q3 | Free plan limits | (a) 2 devices, 25 employees, 20 apps, 3 groups, 2 members, 30-day audit, 1 GiB storage; (b) other | **(a)** |
| Q4 | File storage | (a) one paid account per provider with the pool abstraction; (b) pooled free accounts as in the note | **(a)**; pooling saves ≈ $2/month per 100 GB and risks a ban that breaks every tenant |
| Q5 | Malware scanning | (a) ClamAV worker; (b) ClamAV + VirusTotal hash lookup (premium API); (c) none until paid tiers | **(a)** from the first upload; (b) when budget allows |
| Q6 | Employee roster out of the signed document (A6) | (a) yes, signed roster log; (b) keep it in the document | **(a)**; it is the largest fan-out and gets more expensive after agents ship |
| Q7 | JWT lifetime (A10) | (a) 60 min; (b) keep 10 min | **(a)**; revocation stays instant because the session row is checked on every call |
| Q8 | Operators at launch | (a) owner only (two-person rule waits); (b) owner + one | **(b)** before the first paying tenant; (a) acceptable for a free beta with break-glass |
| Q9 | Inactive free tenant cleanup | (a) warn 45/60, suspend 75, delete 90 (+30 soft); (b) longer | **(a)** |
| Q10 | Referral bonus | Is the "3 GB with referrals" figure from the Convex dashboard? | Please confirm from the dashboard's billing page; this plan uses 1 GB and shows 3 GB only as a scenario |

### 8.5 Could not be verified

- Convex pricing-page figures (overage prices, database I/O price per GB):
  the page did not load; values from search extracts and third-party sites.
- The referral bonus for database I/O.
- How Convex accounts index entries and whether there is per-document
  rounding (the model's `IDX = 64`).
- That cached query results cost no database I/O and that only one
  subscriber re-runs (Convex staff on Discord, not docs).
- Whether a Convex Auth JWT refresh re-runs a client's subscriptions.
- Whether a reconnect re-runs or serves the agent's subscription from cache.
- Whether the Convex dashboard's Usage/Insights pages break I/O down per
  function, and the usage reporting delay.
- That Convex offers no server-side connection presence API (none
  documented).
- How `convex-test` exposes query invalidation (2.13 step 4 has a fallback).
- Convex Auth support for WebAuthn; Convex custom domains or IP allow-lists
  for HTTP actions.
- Convex Rust client reconnect backoff.
- Tigris and R2 prices and free tiers (search extracts only; Tigris pricing
  page fetch failed); Tigris terms on multiple accounts; Range support on
  Tigris presigned GETs.
- E-mail provider free-tier limits; scanner host limits; VirusTotal terms.
- Every I/O number in Section 1.4 (estimates until 1.6 runs).

### 8.6 Sources (research date 2026-10-27)

- Convex limits (plan resources, concurrency, transactions, free-plan hard
  caps): https://docs.convex.dev/production/state/limits
- Convex plans page (Starter overage extract): https://www.convex.dev/plans
- Convex Starter plan announcement (2025-06-18):
  https://news.convex.dev/introducing-the-new-convex-starter-plan-pay-for-only-what-you-need/
- Convex pricing FAQ (not loaded; cited by search): https://www.convex.dev/pricing/faq
- Cached reads and bandwidth (Convex staff, community):
  https://discord-questions.convex.dev/m/1289596926580363335 and related
  threads https://discord-questions.convex.dev/m/1201071249179287636
- Referral report (community, anecdotal):
  https://discord-questions.convex.dev/m/1385451322316165120
- Convex Management API deploy keys (why the console does not use one):
  https://docs.convex.dev/management-api/create-deploy-key
- Installed sources read: `node_modules/@convex-dev/auth` 0.0.96
  (`server/implementation/mutations/refreshSession.js`, `refreshTokens.js`,
  `rateLimit.js`, `sessions.js`); `node_modules/@convex-dev/rate-limiter`
  (`component/lib.js`, `component/schema.js`)
- Tigris pricing (search extract): https://www.tigrisdata.com/pricing/ ,
  https://www.tigrisdata.com/docs/pricing/
- Cloudflare R2 pricing (search extracts):
  https://developers.cloudflare.com/r2/pricing/
- Repository: `CLAUDE.md`, `docs/prd.md` (10, 11, 11.1, 16, 21, 22.6),
  `docs/plans/phase-4-dashboard-state.md` (4.2–4.13, Steps 6–8, 12, 17, 18,
  13, 15), `docs/plans/phase-5-lockdown.md` (4.2, 4.18, 4.19, 14, 20),
  `docs/plans/tenant-admin-panel-recommendation.md`,
  `apps/dashboard/src/data/{README.md,api.ts,types.ts}`, `convex/*.ts`,
  `apps/agent/src/backend/task.rs`,
  `.personal/installer-hosting-tigris.md` (gitignored).
