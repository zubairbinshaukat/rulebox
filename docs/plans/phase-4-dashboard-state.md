# Phase 4 — Dashboard and desired state

> **For the implementing agent:** follow this plan step by step. Each step
> has a **Done when** check — run it and see it pass before moving on.
> Read `CLAUDE.md` first, then the reading list in Section 3. Do not build
> anything listed under Non-goals. One step = one commit
> (`Phase 4 step N: <what>`), made only when the user says so.
>
> **Six rules override everything else in this file:**
>
> 1. **Nothing system-altering runs on the dev machine.** Installing,
>    uninstalling or removing software, deleting app data folders, and
>    every agent command that changes Windows (`enroll` without
>    `--simulate`, `recover`, `unenroll` without `--simulate`,
>    `service install`) run only on the Hyper-V VM, and only the **user**
>    runs them. New mutating `Platform` methods call
>    `guard::require_test_machine()` first, like the Phase 2 ones. **Never
>    create the test-machine marker, on any machine.**
> 2. **Secrets never reach a reader that does not need them.** The device
>    secret, employee password hashes, the exit-PIN hash, TOTP secrets,
>    recovery codes, enrollment tokens and the policy signing key are
>    never returned by a dashboard query, never written to the audit log,
>    never logged, and never added to `rulebox_policy::DesiredState` (that
>    type is sent whole to the Staff session). Each one has exactly one
>    writer and one reader, named in Section 4.7.
> 3. **Every public Convex function goes through a wrapper from
>    `convex/lib/functions.ts`** (`memberQuery`, `memberMutation`,
>    `memberAction`, `deviceQuery`, `deviceMutation`, `deviceAction`, and
>    `publicQuery` / `publicMutation` / `publicAction` for exactly four
>    unauthenticated entry points: `health:ping`, `account:me`,
>    `account:redeemReset`, `enrollment:enroll`). Importing `query`, `mutation` or
>    `action` from `./_generated/server` anywhere else is a bug; a lint
>    rule enforces it (Step 2).
> 4. **The six data access rules of CLAUDE.md apply to every query.**
>    `.withIndex(...)` always; no `.filter()` on a query; no `.collect()`
>    on the tables marked "grows" in Section 4.2; lists use `.paginate()`;
>    fast-changing data stays in its own tables. Section 4.3 lists every
>    index; a query that needs an index not listed there means you stop
>    and add it to the plan's table in your report.
> 5. **The agent trusts only what it verified.** A desired-state document
>    is applied only after its Ed25519 signature checks against a key the
>    agent already trusts, its `deviceId` is this device and its `version`
>    is not lower than the last applied one (Section 4.5). An installer
>    runs only after its SHA-256 matches. There is no "accept unsigned"
>    switch in a release build.
> 6. **Locked decisions (PRD 21.1) are not re-opened**, and Phase 3's
>    files (`apps/staff-app`) are changed only in Step 15, after Phase 3
>    Step 19 is committed.

Research date for every version and API fact in this file:
**2026-10-20**. Items marked **(unverified)** could not be confirmed from
a primary source; the plan says how each one gets confirmed.

---

## Updates since this plan was written

None yet. When the user answers Section 21, record the answers here and in
`docs/plans/README.md`, and change the affected steps before starting.

---

## 1. Goal

At the end of Phase 4:

1. An organization deploys its own Convex backend and dashboard. The
   first **Owner** is created from the command line; further members are
   invited by the Owner. Members sign in with email and password, and
   Owners and Admins must pass a **TOTP second factor** (PRD 12.3).
   Roles are **Owner, Admin, Viewer** (PRD 15).
2. The dashboard manages **groups, devices, employees, apps, file
   handlers, enrollment codes and organization settings** (kiosk on/off
   per device, hidden admin exit PIN and key combination, power options,
   offline sign-in days, default quota). Every screen is backed by one
   query (PRD 11.1 rule 1), long lists are paginated, and the UI follows
   the Rulebox design system with Solar icons, offline-bundled assets,
   light/dark and reduced motion.
3. Every change produces a new, **versioned, Ed25519-signed desired state**
   per affected device. The agent verifies the signature, the device id
   and the version before applying anything (PRD 10, 12.3, Decision 15).
4. The agent's **employee directory** and **audit sink** talk to Convex:
   employees sign in on any allowed device with their own password, the
   offline cache is purged when an employee is disabled, removed from
   the device's group or has a new password, and every admin-exit use
   and lockout lands in the dashboard **audit log** next to every
   administrative action (PRD 12.3, 12.4).
5. **Remote installs:** an admin adds a desktop app from the winget
   catalogue (the server resolves the manifest to an installer URL and
   SHA-256), from an MSI or EXE URL with its SHA-256, or as a portable EXE;
   assigns it to a group; each device in the group downloads it, verifies
   the hash, installs it silently as SYSTEM without the winget CLI, and
   reports ✅/❌ per device. The app appears for employees only once it is
   installed (PRD 9.3, 13.5, 13.6 #1).
6. Device status is live: online/offline and last seen come from a small
   separate table; heartbeats slow down as the fleet grows so a pilot
   fleet stays inside the Convex free tier (PRD 11, 11.1).
7. Signing out of the Staff App resets each app's listed data folders
   (PRD 5.3).

On the **dev machine** everything runs against a Convex **dev
deployment** (the existing `npx convex dev` deployment) and the agent in
`--simulate` mode; the install engine and folder reset run against
`SimPlatform`. The real install, folder reset, signature check on a
kiosk and Phase 2's three open VM items are verified on the VM by the
user (Step 21).

## 2. Non-goals (do NOT build in Phase 4)

| Not in Phase 4 | Belongs to |
|---|---|
| Rollout rings, promotion, one-click rollback of a group to an earlier version (PRD 24.3). Phase 4 keeps the history (Section 4.4) so Phase 5 can build them | Phase 5 |
| Lockdown policies, App Control, process watchdog, Wi-Fi and printer profiles, device lock, broadcast messages (PRD 12.2, 24.2, 24.4) | Phase 5 |
| Editing web app **permissions** and counting blocked requests (PRD 24.1). Phase 4 stores the PRD defaults and passes them through unchanged | Phase 5 |
| Installer **uploads** (MSI/EXE stored by Rulebox). Phase 4 accepts an `https://` URL plus SHA-256 only. Convex file storage is too small for installers (PRD 16 names Cloudflare R2) | Phase 6 or later (Section 21, Q4) |
| Branding beyond the organization name: logo, colours, wallpaper on devices (PRD 3.1). Phase 4 stores the name; the `branding.logo` field stays `null` | Section 21, Q3 |
| Agent self-update, Staff App update channels and deadlines (PRD 23) | v1.x / later |
| Multi-organization in one deployment, plugin system for app types, `npx create-rulebox` (PRD 17 v2). The schema keeps `orgId` on every row (including `policyKeys`), the membership lookup already returns a list, and MFA hangs off the user, so v2 needs no data migration. What v2 still builds is listed in Section 4.6 "Ready for more than one organization" | v2 |
| MSI installer, release builds, code signing, hosting the dashboard on Cloudflare Pages / Vercel (Phase 4 writes the header files but does not deploy) | Phase 6 |
| Idle auto-logout, shift hours (PRD 4.7, 24.5) | later |
| Uninstalling EXE-type apps (only MSI and portable apps are removed when unassigned; Section 4.8) | later |
| Running the `winget` CLI or the `Microsoft.WinGet.Client` module anywhere (CLAUDE.md hard rule; PRD 13.6 #1). Phase 4 uses the manifest's URL and hash only | — |

---

## 3. Prerequisites

### 3.1 Reading list (read these, in this order)

- `CLAUDE.md` (all of it, especially "Data access rules").
- This file, Sections 1 to 10, before Step 1.
- `docs/prd.md` — Sections 3.1, 3.2, 5, 6, 8, 9.1–9.4, 10, 11, 11.1,
  12.1, 12.3, 12.4, 13.5, 13.6 (rows 1, 5, 6, 9), 15, 16, 21 (locked;
  never re-open), 22.5, 24.1, 24.3, 25.
- `docs/plans/phase-2-agent-core.md` — Sections 5.4 (enrollment), 5.8
  (backend client), 5.9 (employee session), 5.10 (admin exit), 5.11
  (audit queue), 6.11 (protocol 1.1), 12 (hand-off notes, "Phase 4
  owns").
- `docs/plans/phase-2-vm-results.md` — "Decisions" and "Not tested".
- `docs/plans/phase-3-staff-shell.md` — Section 6 (agent port), 7.11
  (admin exit), 13 rows 7 and 24.
- Code: everything under `convex/`; `apps/agent/src/backend/`,
  `directory.rs`, `audit.rs`, `agent_policy.rs`, `session.rs` (top 200
  lines), `employee_cache.rs`, `kdf.rs`, `enroll.rs` (top 200 lines);
  `crates/rulebox-policy/src/lib.rs`; `crates/rulebox-ipc/src/lib.rs`,
  `methods.rs`, `requests.rs`; `apps/dashboard/src/*`;
  `packages/ui/src/index.ts`.

### 3.2 What exists today

**Convex** (`convex/`, `convex` npm 1.46.0, dev deployment configured in
the root `.env.local`):

- `schema.ts`: `organizations`, `groups`, `devices` (identity plus the
  agent's reported status fields), `deviceStatus` (`lastSeenAt` only),
  `employees`, `apps` (`config: v.any()`), `desiredStates` (one row per
  scope and version, `scope` is a device or group id string, `doc:
  v.any()`), `enrollmentTokens`, `auditLog` (`actor`, `action`, `target`,
  `at`).
- `enrollment.ts`: `enroll` (public mutation, atomic, idempotent retry).
- `devices.ts`: `desiredState` (the agent's one subscription; device
  scope wins over group scope; `signature: null`), `heartbeat` (writes
  `deviceStatus` always and `devices` only when the status changed;
  `nextPingInMs` fixed at 300,000), `unenroll`.
- `lib/deviceAuth.ts`: `sha256Hex`, `checkDevice`, `requireDevice`
  (device id + secret as arguments, constant-time compare).
- `lib/deepEqual.ts`, `health.ts` (`ping`).
- `dev.ts`: internal mutations for the command line only:
  `seedOrg`, `createEnrollmentCode`, `setKiosk`, `setAdminExit`,
  `revokeDevice`, `revokeEnrollmentToken`. It imports `env` from
  `./_generated/server` (typed platform env vars `CONVEX_CLOUD_URL`,
  `CONVEX_SITE_URL`).
- No auth, no `http.ts`, no `crons.ts`, no tests, no `convex.config.ts`.

**Dashboard** (`apps/dashboard/`): `main.tsx` (requires `VITE_CONVEX_URL`,
`ConvexProvider`), `App.tsx` (two tabs: Status and Gallery),
`Status.tsx` (`health.ping`), `Gallery.tsx` (design-system gallery, keep
it). Vite with `unplugin-icons`, alias `@convex`. No router, no tests.

**Shared:** `packages/ui` (Button, Input, Panel, Pill, Switch, Dialog,
MenuList, Tabs, Notice, Spinner, StatCard, SegmentedControl, LogoMark,
LogoMotion, … and `--rb-*` tokens). `packages/types` is a hand-kept barrel
of ts-rs output; `pnpm gen:types` runs
`cargo test -p rulebox-policy -p rulebox-ipc -p rulebox-staff export_bindings`.

**Agent** (`apps/agent`, Phase 2, VM-verified): one Convex client, one
subscription to `devices:desiredState`, heartbeat with jitter,
`desired-state.json` cache (`CachedDesired { version, doc, signature }`),
version floor (`last_applied_version`), revocation keeps the kiosk, the
startup warning "policy signatures are not verified until Phase 4", and
three seams waiting for Phase 4:

| Seam | Today | File |
|---|---|---|
| `EmployeeDirectory` | `UnavailableDirectory` on a real agent; `FixtureDirectory` in `--sim-demo` or with `fixtureDirectory` + marker | `directory.rs` |
| `AuditSink` | `NullAuditSink` (records stay queued, cap 500); `LogAuditSink` in simulate | `audit.rs` |
| Agent-only keys of the document | `adminExit`, `power`, `orgName` read by `AgentPolicy::from_doc`; written by `dev.ts` | `agent_policy.rs` |

**Staff App** (Phase 3, Steps 1–16 done, 17–19 left): talks only to the
agent over IPC 1.1 (`IpcAgent`); `DemoAgent` (debug builds,
`RULEBOX_STAFF_DEMO=1`) is the UI-development stand-in. The Staff App
never connects to Convex (Phase 3 decision P1, A-13).

### 3.3 Hand-off: what Phase 2 and Phase 3 left, and what Phase 4 does with it

| Left by | Item | Phase 4 action | Step |
|---|---|---|---|
| Phase 2 | `convex/dev.ts` helpers | Replaced by dashboard functions. The file is deleted; test seeding moves to `convex/testing.ts` (internal, refuses to run unless `RULEBOX_ALLOW_TEST_SEED=1` is set on the deployment) | 20 |
| Phase 2 | `signature: null`, startup warning | Signed envelope; agent verifies; warning removed | 8, 9 |
| Phase 2 | Desired state per device **or** group, merged by "device wins" | One materialized, signed document per device, built from org, group, device, apps and employees (Section 4.4) | 8 |
| Phase 2 | `nextPingInMs` fixed at 5 minutes | Scaled with fleet size (Section 4.9) | 7 |
| Phase 2 | Reported status fields inside `devices` (they invalidate the agent's own subscription and every device list on each change) | Moved to a new `deviceReports` table (Section 4.2) | 7 |
| Phase 2 | `UnavailableDirectory` / `FixtureDirectory` | `ConvexDirectory`; the `fixtureDirectory` config key is removed once Phase 3 Step 18 is done (Step 13 says how to check) | 12, 13 |
| Phase 2 | `NullAuditSink` | `ConvexAuditSink`, idempotent on `AuditRecord.id` | 12, 13 |
| Phase 2 | `adminExit`, `power`, `orgName` written by `dev.ts` | Written by the publisher from organization settings; PIN hashed on the server with the agent's Argon2id parameters; at least 6 digits | 5, 8 |
| Phase 2 | `session.signOut` cleans nothing (PRD 5.3 deferred) | Agent resets the catalogue apps' `resetFolders` after sign-out | 16 |
| Phase 2 | "`apps.changed` event if the catalogue must refresh while signed in (a 1.2 addition)" | Protocol 1.2: events `apps.changed` and `session.ended` (Section 5.2) | 13, 15 |
| Phase 2 | Q1 "device secret now; proper auth in Phase 4" | Decision D4: keep the device secret (Convex's documented "service authentication" pattern) and add credential rotation; JWT is not adopted. Confirm with the user (Section 21, Q1) | 7, 12, 13 |
| Phase 2 | Q3 `organizations.branding.logoUrl` vs Rust `Branding.logo` | `organizations.branding` is removed; the document's `branding` is `{ name: <org name>, logo: null }`, which matches the Rust type | 2, 8 |
| Phase 2 VM run | Three fixes unit-tested only: exit-hold timing (incl. the 15 s rule), kill-on-close job, `recover` for LSA auto sign-in owners | Re-checked in the Phase 4 VM run | 21 |
| Phase 3 | `FilesHub::set_handlers` has no caller ("Open with" always answers "no handler") | The Staff App feeds it from `snapshot.desiredState.fileHandlers`, mapped to catalogue apps | 15 |
| Phase 3 | Edge case 7: employee disabled while signed in has no signal | `session.ended { reason: "employeeRemoved" }` (protocol 1.2) | 15 |
| Phase 3 | `DemoAgent` stands in for the real backend | **Stays** as the UI-development stand-in (debug builds only). Real devices already use `IpcAgent`; what replaces the fixture data on a real device is the agent's `ConvexDirectory` and the signed catalogue. `DemoAgent` gains the 1.2 events so the Staff UI can be developed against them | 15 |

**Ordering against Phase 3.** Steps 1–14 and 16–20 do not touch
`apps/staff-app` and can start now. **Step 15 must wait until Phase 3
Step 19 is committed** (it edits Staff App files that Phase 3 Steps 17–19
still change). Step 0 checks this.

### 3.4 Decisions this plan assumes

Section 21 lists the questions that belong to the user, each with a
recommendation. The plan is written for the recommended option. In Step 0
you show Section 21 to the user and wait. If the user picks a different
option, stop and ask how the affected steps should change; do not
improvise. Section 19 lists every decision this plan made on its own.

---

## 4. Architecture

### 4.1 Components and data flow

```
 Dashboard (browser)                 Convex deployment                         Device
 ───────────────────                 ─────────────────                         ──────
 member signs in ──Convex Auth──▶ users/authSessions + members + mfaSessions
 edits settings ──memberMutation──▶ config tables ──requestPublish()──▶ publishQueue
                                                         │ scheduler (1.5 s debounce)
                                                         ▼
                                     publish:run  builds one document per affected
                                     device, signs it (Ed25519, key from env var),
                                     inserts desiredStates(version+1)
                                                         │ (reactive)
                                     devices:desiredState ◀── one subscription ── agent
                                                                                 │ verify sig, deviceId,
                                                                                 │ version floor; cache
                                                                                 ▼
                                     devices:heartbeat ◀── every nextPingInMs ─── agent (status only on change)
                                     deviceApi:verifyEmployee ◀── on sign-in ──── agent ◀─IPC─ Staff App
                                     deviceApi:reportAudit ◀── queued records ─── agent
                                     deviceApi:reportInstalls ◀── state changes ─ agent install task
 device list ◀── fleet:list (paginated) + fleet:liveStatus (lastSeen of the visible page)
```

- **The agent holds exactly one subscription** (`devices:desiredState`).
  Every other agent call is a one-shot call caused by an event (a
  heartbeat timer, a sign-in, a queued record, an install result).
- **The document is materialized and signed at write time**, never
  computed in the agent's query. Reason: the query must be cheap and
  stable (it re-runs only when the device's own row or newest document
  changes), signing needs the private key, and every version must be
  stored for audit and for Phase 5 rollback.
- **The Staff App still never talks to Convex** (Phase 3 P1).

### 4.2 Data model

Legend: **grows** = never `.collect()`; list with `.paginate()`, "latest"
with `.take(n)`. **tiny** = at most a few rows per organization; reading
all rows of one organization through an index with `.take(LIMIT)` is
allowed where LIMIT is named. Every table has `orgId` or hangs off a row that does (except the
per-user MFA tables, `wingetCache` and the Convex Auth tables), and every query filters on it through an
index.

All fields below are exact. `v.optional` marks fields that existing
Phase 2 rows lack or that are truly optional. Timestamps are Unix ms
(`v.number()`).

| Table | Size | Fields | Indexes |
|---|---|---|---|
| `organizations` | tiny | `name: string`, `settings: v.optional(orgSettings)` (missing = defaults, Section 4.10), `revision: v.optional(number)` (missing = 0), `createdAt: v.optional(number)` | — (read by id) |
| `orgSecrets` | tiny (1 per org) | `orgId`, `exitPinHash: v.optional(string)` (Argon2id PHC) | `by_org [orgId]` |
| `orgStats` | tiny (1 per org) | `orgId`, `deviceCount: number`, `pingIntervalMs: number` | `by_org [orgId]` |
| `members` | tiny | `orgId`, `userId: v.id("users")`, `email: string` (lower-case), `role: "owner"\|"admin"\|"viewer"`, `status: "active"\|"disabled"`, `createdAt: number`, `revision: number` | `by_user [userId]` (one row per membership, read with `.take(MAX_MEMBERSHIPS)`), `by_org_user [orgId, userId]` (uniqueness), `by_org_email [orgId, email]`, `by_org_role [orgId, role]` |
| `invites` | tiny | `orgId`, `email: string` (lower-case), `role`, `kind: "join"\|"passwordReset"`, `tokenHash: string` (SHA-256 hex), `expiresAt: number`, `createdBy: v.optional(v.id("members"))`, `usedAt: v.optional(number)` | `by_token_hash [tokenHash]`, `by_email [email]`, `by_org [orgId]` |
| `memberSecrets` | tiny (1 per **user**, not per membership: the authenticator belongs to the person) | `userId: v.id("users")`, `totpSecret: v.optional(string)` (base32), `totpPending: v.optional(string)`, `totpEnabledAt: v.optional(number)`, `recoveryHashes: v.array(string)` (SHA-256 hex), `lastTotpStep: number`, `totpFailures: number`, `totpLockedUntil: number` | `by_user [userId]` |
| `mfaSessions` | small (1 per signed-in session) | `sessionId: v.id("authSessions")`, `userId: v.id("users")`, `verifiedAt: number` (one verification covers every organization of that session) | `by_session [sessionId]`, `by_user [userId]` |
| `groups` | tiny | `orgId`, `name: string`, `description: v.optional(string)`, `revision: v.optional(number)`, `createdAt: v.optional(number)` | `by_org [orgId]` (exists), `by_org_name [orgId, name]` |
| `devices` | **grows** | Phase 2 identity fields (`orgId`, `groupId`, `name`, `secretHash`, `revoked`, `enrolledAt`, `enrollmentTokenId`, `hardwareIdHash`) plus `previousSecretHash: v.optional(string)`, `rotateCredential: v.optional(boolean)`, `kioskEnabled: v.optional(boolean)` (missing = true), `revision: v.optional(number)`. **The 12 reported status fields are removed** (moved to `deviceReports`) | `by_org [orgId]`, `by_group [groupId]` (exist), `by_secret_hash` (exists), `by_previous_secret_hash [previousSecretHash]`; search index `search_name { searchField: "name", filterFields: ["orgId"] }` |
| `deviceReports` | grows (1 per device) | `deviceId`, `orgId`, the 12 status fields of Phase 2 (`agentVersion` … `compat`) plus `trustedKeyIds: v.optional(v.array(string))`, `outOfSupport: boolean`, `updatedAt: number` | `by_device [deviceId]` |
| `deviceStatus` | grows (1 per device), **fast-changing** | `deviceId`, `orgId: v.optional(id)` (backfilled by the next heartbeat), `lastSeenAt` | `by_device` (exists), `by_org_last_seen [orgId, lastSeenAt]` |
| `employees` | **grows** | `orgId`, `name`, `username` (normalized: trim + lower-case), `searchText: string` (`name + " " + username`, lower-case), `quotaGb: v.optional(number)` (missing = org default), `disabled: boolean`, `credentialRevision: number`, `passwordSetAt: v.optional(number)`, `revision: number`, `createdAt: number`. **`groupIds` is removed** (membership moves to `groupMembers`) | `by_org [orgId]` (exists), `by_org_username [orgId, username]` (exists); search index `search_text { searchField: "searchText", filterFields: ["orgId"] }` |
| `employeeSecrets` | grows (1 per employee) | `employeeId`, `passwordHash: string` (PHC) | `by_employee [employeeId]` |
| `employeeLockouts` | grows, fast-changing | `employeeId`, `orgId`, `failures: number`, `lastFailureAt: number`, `lockedUntil: number` | `by_employee [employeeId]` |
| `groupMembers` | grows | `orgId`, `groupId`, `employeeId` | `by_group [groupId]`, `by_employee [employeeId]`, `by_group_employee [groupId, employeeId]` |
| `apps` | grows (slowly) | `orgId`, `name`, `description: v.optional(string)`, `kind: "web"\|"desktop"`, `hue: v.optional(number)`, `web: v.optional(webSpec)`, `desktop: v.optional(desktopSpec)`, `icon: v.optional({ storageId: v.id("_storage"), sha256: string, sizeBytes: number })`, `archived: boolean`, `revision: number`, `createdAt: number` (validators in Section 4.8) | `by_org [orgId]` (exists), `by_org_archived [orgId, archived]` |
| `appAssignments` | grows | `orgId`, `groupId`, `appId`, `audience: "everyone"\|"selected"`, `pinnedTaskbar: boolean`, `pinnedDesktop: boolean` | `by_group [groupId]`, `by_app [appId]`, `by_group_app [groupId, appId]` |
| `employeeApps` | grows | `orgId`, `employeeId`, `appId` | `by_employee [employeeId]`, `by_app [appId]`, `by_employee_app [employeeId, appId]` |
| `fileHandlers` | tiny (≤ 200 per org) | `orgId`, `extension: string` (lower-case, with dot), `appId` | `by_org_ext [orgId, extension]`, `by_app [appId]` |
| `enrollmentTokens` | grows | Phase 2 fields plus `label: v.optional(string)`, `createdBy: v.optional(v.id("members"))` | `by_org` (exists), `by_token_hash` (exists), `by_org_created [orgId, createdAt]` |
| `desiredStates` | grows (pruned to 5 per device) | `orgId`, `deviceId: v.id("devices")`, `version: number`, `payload: string`, `signature: string` (base64), `keyId: string`, `contentHash: string`, `createdAt: number`, `reason: string` | `by_device_version [deviceId, version]` |
| `publishQueue` | tiny (1 per org) | `orgId`, `allDevices: boolean`, `groupIds: v.array(id)`, `deviceIds: v.array(id)`, `scheduled: v.optional(v.id("_scheduled_functions"))`, `requestedAt: number` | `by_org [orgId]` |
| `policyKeys` | tiny (per org) | `orgId`, `keyId: string` (16 hex), `publicKey: string` (base64, 32 bytes), `status: "active"\|"next"\|"retired"`, `endorsement: v.optional({ byKeyId: string, signature: string })`, `createdAt: number`. Trust is per organization: the same public key may be registered by two organizations as two rows | `by_org_key_id [orgId, keyId]` (uniqueness), `by_org_status [orgId, status]` |
| `installResults` | **grows** (devices × apps) | `orgId`, `deviceId`, `appId`, `state: "pending"\|"downloading"\|"installing"\|"installed"\|"failed"\|"removing"\|"removed"\|"unsupported"`, `appRevision: number`, `attempts: number`, `exitCode: v.optional(number)`, `detail: v.optional(string)` (≤ 200 chars, fixed texts), `updatedAt: number` | `by_device [deviceId]`, `by_device_app [deviceId, appId]`, `by_app_state [appId, state]`, `by_org_state [orgId, state]` |
| `wingetCache` | tiny | `packageId: string`, `version: string`, `resolved: wingetResolved` (Section 4.8), `fetchedAt: number` | `by_package_version [packageId, version]` |
| `auditLog` | **grows** | `orgId`, `at: number`, `actorType: "member"\|"device"\|"system"`, `actorId: v.optional(string)`, `actorLabel: string`, `action: string` (Section 4.11 list), `targetType: v.optional(string)`, `targetId: v.optional(string)`, `targetLabel: v.optional(string)`, `summary: string` (≤ 300 chars), `eventKey: v.optional(string)` | `by_org_at [orgId, at]` (exists), `by_event_key [eventKey]`, `by_org_target [orgId, targetId, at]`, `by_at [at]` |
| `authTables` | Convex Auth | `users`, `authSessions`, `authAccounts`, … from `@convex-dev/auth/server`, spread unchanged | as provided |

Fields **removed** from Phase 2 tables: `organizations.branding`,
`employees.groupIds`, `apps.type` and `apps.config` and `apps.iconUrl`,
`desiredStates.scope` and `desiredStates.doc`, `auditLog.actor` and
`auditLog.target`, the 12 status fields of `devices`. Step 2 says how
existing rows are handled.

**Why each separation exists** (PRD 11.1 rule 4, "keep fast-changing data
separate"):

- `deviceStatus` changes on every heartbeat. Nothing but `fleet:liveStatus`
  and `overview:get` reads it; the agent's subscription never does.
- `deviceReports` changes when the agent's status changes (disk space,
  kiosk phase, shell health). Device lists read it; **the agent's
  subscription does not** (in Phase 2 these fields sat in `devices`, so
  every status change re-ran the agent's own subscription).
- `employeeLockouts` changes on failed sign-ins; employee lists do not
  read it (the detail page does).
- `orgStats` is read by `heartbeat`, written only on enroll / remove.

### 4.3 Index list (complete) and the query that uses each

A query not in this table does not exist in Phase 4. Every
`withIndex` call names one of these indexes.

| Index | Used by |
|---|---|
| `members.by_user` | every member wrapper (`requireMember`, `.take(MAX_MEMBERSHIPS)`), `account:me` |
| `members.by_org_user` | uniqueness check on join / invite acceptance |
| `members.by_org_email` | invite creation (duplicate check), `auth.ts` callbacks |
| `members.by_org_role` | "last owner" check, members screen (`.take(200)`) |
| `invites.by_token_hash` | join, password reset |
| `invites.by_email` | `profile()` / `createOrUpdateUser` |
| `invites.by_org` | members screen (`.take(100)`, newest first) |
| `memberSecrets.by_user`, `mfaSessions.by_session`, `mfaSessions.by_user` | MFA |
| `groups.by_org` | group list (`.take(500)`, tiny), group pickers |
| `groups.by_org_name` | duplicate name check |
| `devices.by_org` | device list (`paginate`), publisher "all devices" (`paginate` in batches) |
| `devices.by_group` | group detail device list (`paginate`), publisher per group |
| `devices.by_secret_hash`, `devices.by_previous_secret_hash` | enrollment idempotency, credential rotation |
| `devices.search_name` | device search box (`.take(50)`) |
| `deviceReports.by_device`, `deviceStatus.by_device` | joins per listed device (`.unique()`) |
| `deviceStatus.by_org_last_seen` | overview "seen recently" count (`.take(1001)`) |
| `orgStats.by_org`, `orgSecrets.by_org`, `publishQueue.by_org` | `.unique()` |
| `employees.by_org` | employee list (`paginate`) |
| `employees.by_org_username` | uniqueness, `verifyEmployee` |
| `employees.search_text` | employee search (`.take(50)`) |
| `employeeSecrets.by_employee`, `employeeLockouts.by_employee` | `.unique()` |
| `groupMembers.by_group` | publisher (employees of a group, `.take(MAX_GROUP_EMPLOYEES + 1)`), group detail (`paginate`) |
| `groupMembers.by_employee` | employee detail (`.take(100)`), publisher target resolution |
| `groupMembers.by_group_employee` | add/remove membership, `verifyEmployee` "may sign in here" |
| `apps.by_org` / `apps.by_org_archived` | app list (`paginate`), pickers (`.take(500)`) |
| `appAssignments.by_group` | publisher, group detail (`.take(MAX_GROUP_APPS + 1)`) |
| `appAssignments.by_app` | app detail, publisher target resolution (`.take(500)`) |
| `appAssignments.by_group_app` | assign / unassign |
| `employeeApps.by_employee` / `by_app` / `by_employee_app` | publisher, employee detail, app detail |
| `fileHandlers.by_org_ext` | publisher (`.take(201)`), settings screen, uniqueness |
| `fileHandlers.by_app` | app delete / archive check |
| `enrollmentTokens.by_token_hash` | `enroll` |
| `enrollmentTokens.by_org_created` | enrollment screen (`paginate`, newest first) |
| `desiredStates.by_device_version` | agent subscription (`order("desc").first()`), publisher (latest + pruning), device detail (`.take(5)`) |
| `policyKeys.by_org_status`, `policyKeys.by_org_key_id` | publisher, subscription key list, signing settings |
| `installResults.by_device` | device detail (`paginate`) |
| `installResults.by_device_app` | `reportInstalls` upsert |
| `installResults.by_app_state` | app detail counts per state (`.take(1001)` per state) |
| `installResults.by_org_state` | overview "failed installs" (`.take(20)`) |
| `wingetCache.by_package_version` | winget resolve |
| `auditLog.by_org_at` | audit screen (`paginate`, `order("desc")`), overview (`.take(10)`) |
| `auditLog.by_org_target` | "history" panel on a device / employee / app page (`paginate`) |
| `auditLog.by_event_key` | `reportAudit` idempotency |
| `auditLog.by_at` | retention cron |

### 4.4 The desired-state document (version 2) and the publisher

**One document per device.** It contains the Phase 2 shape unchanged
(so `DesiredState` and `AgentPolicy::from_doc` keep working) plus three
new agent-only keys. The document is the `doc` inside a signed payload.

```jsonc
// payload: the exact UTF-8 string that is signed. Built by convex/lib/desired.ts.
{
  "format": "rulebox.desired/2",
  "keyId": "3f2a9c0d11e4b7a8",
  "orgId": "<organizations id>",
  "deviceId": "<devices id>",
  "version": 12,
  "issuedAtMs": 1760950000000,
  "doc": {
    // --- rulebox_policy::DesiredState (sent to the Staff App; NEVER a secret here) ---
    "kioskEnabled": true,
    "apps": ["files", "k57a…", "k58b…"],          // catalogue ids available on this device
    "allowedSites": [],                            // unused until Phase 5; always []
    "fileHandlers": { ".docx": "k58b…" },         // extension → catalogue id; only apps in "apps"
    "storage": { "defaultQuotaGb": 10 },
    "branding": { "name": "Acme", "logo": null },
    "version": 12,
    // --- agent-only keys of Phase 2 (agent_policy.rs) ---
    "adminExit": { "enabled": true, "hotkey": "Ctrl+Shift+F12", "pinHash": "$argon2id$v=19$m=19456,t=2,p=1$…$…" },
    "power": { "sleep": true, "restart": true, "shutDown": true },
    "orgName": "Acme",
    // --- agent-only keys added in Phase 4 ---
    "catalog": [ /* CatalogApp, Section 4.8 */ ],
    "employees": { "<employees id>": 3 },        // who may sign in here → credentialRevision
    "offlineDays": 3
  }
}
```

Rules for the builder (`buildDeviceDoc` in `convex/lib/desired.ts`, a
**pure** function of its input object, unit-tested):

1. Key order is exactly the order shown above, at every level; arrays
   are sorted (`apps` and `catalog` by id with `"files"` first,
   `employeeIds` by id); objects used as maps (`fileHandlers`,
   `employees`) have keys inserted in sorted order. `JSON.stringify` then
   gives the same bytes for the same input. Numbers are integers only.
2. `adminExit` is omitted entirely when the organization has no PIN and
   the exit is enabled (the agent then reports it off, as today);
   `{ "enabled": false, "hotkey": … }` when disabled; with `pinHash` when
   set and enabled.
3. `employees` holds the members of the device's group that are not
   disabled. A device with no group gets `{}` (nobody can sign in;
   the dashboard shows a warning on such devices).
4. The built-in Files app is always first in `catalog` with id `"files"`,
   audience `everyone`, `pinnedTaskbar: true`.
5. `contentHash` = SHA-256 hex of `JSON.stringify(doc)` with `version`
   set to 0. If it equals the newest stored row's `contentHash`, nothing
   is written (rule 5, write only on change).
6. Size cap: `payload` ≤ 524,288 bytes (`MAX_PAYLOAD_BYTES`). Above it
   the device is skipped, an audit entry `policy.publishFailed` with
   summary "document too large" is written, and the error is shown on the
   device page. Limits that keep it there: `MAX_GROUP_EMPLOYEES = 2000`,
   `MAX_GROUP_APPS = 150`, `MAX_EMPLOYEE_APPS = 50`.

**Versions.** `version` is per device: newest row's version + 1 (1 for
the first). It never goes down. Rollback (Phase 5) republishes old
content under a new, higher version.

**History.** After inserting version N the publisher deletes rows of
that device with `version <= N - 5` (index range, at most 10 per run).
The device page shows the last 5 versions with their `reason`.

**The publisher** (`convex/publish.ts`, internal):

```ts
// convex/lib/publish.ts — called by every mutation that changes what a device should look like
export type PublishTarget =
  | { kind: "org" } | { kind: "group"; groupId: Id<"groups"> }
  | { kind: "device"; deviceId: Id<"devices"> } | { kind: "employee"; employeeId: Id<"employees"> }
  | { kind: "app"; appId: Id<"apps"> };
export async function requestPublish(ctx: MutationCtx, orgId: Id<"organizations">, target: PublishTarget): Promise<void>;
// convex/publish.ts
export const run = internalMutation({ args: { orgId: v.id("organizations") }, returns: v.null(), handler });
```

- `requestPublish` resolves `employee` → the employee's groups (via
  `groupMembers.by_employee`, `.take(100)`), and `app` → the groups it is
  assigned to plus the groups of employees who have it directly
  (`.take(500)` each), then merges the result into the org's single
  `publishQueue` row (`allDevices` wins over lists; lists are
  de-duplicated and capped at 500 ids, beyond which `allDevices` becomes
  true). If `scheduled` is empty it schedules
  `ctx.scheduler.runAfter(1500, internal.publish.run, { orgId })` and
  stores the id. The 1.5-second delay merges a burst of edits into one
  publish.
- `run` reads and clears the queue row, then processes **at most 25
  devices** (`PUBLISH_BATCH`). Remaining work is written back to the
  queue and `run` reschedules itself with `runAfter(0)`. Group-level
  inputs (assignments, members, apps) are loaded once per group per run
  and reused for every device of that group in the batch.
- For each device: skip revoked devices; build; compare `contentHash`;
  sign; insert; prune; no audit entry per device (the admin action that
  caused the publish already has one).
- **Signing key missing or mismatched** (Section 4.5): `run` writes
  nothing, keeps the queue, writes one audit entry
  `policy.publishFailed` per run with summary "signing key not
  configured", and does **not** reschedule. The dashboard shows a red
  banner on every page until the key is fixed; fixing it
  (`keys:registerActive`) calls `requestPublish(org)`.
- The queue row is the only hot row; it is written by admin edits only
  (a few per minute at most), so write conflicts are not a concern.

### 4.5 Signing, keys, rotation and loss

- **Algorithm:** Ed25519 (RFC 8032). TypeScript: `@noble/ed25519` 3.2.0
  with `@noble/hashes` 2.4.0 for SHA-512 (`ed.hashes.sha512 = sha512`),
  so signing runs inside the `publish:run` **mutation** (pure JS, no
  randomness needed; Convex's own WebCrypto Ed25519 signing is
  documented as actions-only). Rust: `ed25519-dalek` 3.0.0 with default
  features, `VerifyingKey::verify_strict`.
- **What is signed:** the UTF-8 bytes of `payload`, exactly as stored and
  sent. No canonicalization anywhere: the agent verifies the bytes it
  received, then parses them. The envelope on the wire:
  `{ version, payload, signature, keyId }` where `signature` is standard
  base64 (with padding) of the 64 bytes.
- **Key id:** first 16 lower-case hex characters of SHA-256 of the 32
  raw public-key bytes.
- **Where the private key lives:** the Convex environment variable
  `RULEBOX_POLICY_KEY` (standard base64 of the 32-byte Ed25519 seed),
  declared **optional** in `convex/convex.config.ts` so a fresh deploy
  succeeds before a key exists. Never in the database, never in the
  browser, never in the repository. Only `convex/lib/signing.ts` reads
  it. Anyone who can read the deployment's environment variables
  (deployment admins in the Convex dashboard) can sign policies; they
  already control the backend, so this does not widen the trust base.
  What signing adds: a document changed in the database, in transit, or
  in the device's cache, or replayed to another device, or older than
  one already applied, is refused.
- **Creating the first key (Owner, once):**
  1. `node scripts/policy-key.mjs generate --out .tmp/policy-key.seed`
     (new; uses Node's `crypto.generateKeyPairSync("ed25519")`; writes
     only the base64 seed to the file, refuses to overwrite an existing
     file; prints the key id and the base64 public key, never the seed).
  2. The Owner sets the seed (the file's only line) as the env var:
     `npx convex env set RULEBOX_POLICY_KEY "<seed>"` and then deletes
     the file and the shell history line
     (`Clear-History; Remove-Item (Get-PSReadLineOption).HistorySavePath`
     is the user's choice; the plan only tells them). Convex documents
     passing secrets through stdin or a file; whether `env set` reads a
     single value from stdin on 1.47 is **(unverified)**, so Step 8 tries
     `Get-Content .tmp\policy-key.seed | npx convex env set RULEBOX_POLICY_KEY`
     first and records which form worked.
  3. Dashboard → Settings → Signing → **Register key**
     (`keys:registerActive`, Owner): an action derives the public key
     from the env seed, inserts the `policyKeys` row `status: "active"` for the caller's `orgId` (`key_exists` when the organization already has that key id)
     and requests a publish of every device.
- **Trust is per organization.** Every `policyKeys` row carries the
  `orgId` of the organization whose devices trust it. A device is only
  ever told the keys of its own organization. In Phase 4 the private
  seed is still one deployment env var (`RULEBOX_POLICY_KEY`), which is
  right for one organization per deployment; where per-organization seeds
  would live in v2 is an open question (Section 4.6, "Ready for more than
  one organization").
- **Trust on the device:** `enrollment:enroll` returns
  `policyKeys: [{ keyId, publicKey }]` (the active key, and the next key
  when one exists). The agent stores them in `AgentState.trusted_keys`
  (new field). Enrollment is refused with `ConvexError({ code:
  "not_ready" })` while no active key exists, so a device can never be
  enrolled without a root of trust.
- **Rotation** (Owner, rare):
  1. Generate a second key as above and set it as `RULEBOX_POLICY_KEY_NEXT`.
  2. Settings → Signing → **Prepare rotation** (`keys:prepareRotation`):
     derives the next public key, signs the endorsement message
     `rulebox.key-endorsement/1\n<nextKeyId>\n<nextPublicKeyBase64>`
     with the active key, inserts `policyKeys { status: "next",
     endorsement }`.
  3. The subscription result carries `keys: [{ keyId, publicKey,
     endorsement }]` for **every** `policyKeys` row, oldest first
     (retired ones too, so a device that was offline through several
     rotations can walk the endorsement chain). An agent that does not
     trust a listed key verifies its endorsement with a key it trusts,
     then adds it to `trusted_keys` and reports `trustedKeyIds` in the
     next status. The Signing page shows "N of M devices trust the new
     key".
  4. When every device that should rotate trusts it, the Owner swaps
     the env values (`RULEBOX_POLICY_KEY` = next seed, remove
     `RULEBOX_POLICY_KEY_NEXT`) and clicks **Finish rotation**
     (`keys:finishRotation`): checks that the env key now matches the
     `next` row, marks the old row `retired`, the next row `active`, and
     republishes every device.
  5. The subscription result also lists retired key ids
     (`retiredKeyIds`). An agent removes a key from `trusted_keys` only
     when it is listed there **and** the agent has already accepted a
     document signed by another trusted key. It never removes its last
     trusted key. (Step 9 test `retired_key_is_dropped_only_after_a_newer_signed_doc`.)
- **Key lost** (env var deleted and no copy): nothing new can be signed;
  devices keep working on their cached documents (kiosk stays as it is,
  Q11 spirit). Recovery: create a new key, register it with
  `keys:registerActive --force` (Owner; allowed only when no active key
  row matches the env), and **re-enroll** every device (or, on each
  device as administrator, `rulebox-agent trust-key <base64>`, a new
  admin-pipe command that adds a key; elevated administrator only). The
  dashboard explains both paths on the Signing page.
- **Key stolen:** rotate immediately (steps above); because devices
  accept any document signed by any trusted key until the old key is
  retired, also re-enroll devices if the thief could reach them. This is
  written on the Signing page too.
- **No expiry** on documents. A device that is offline for months keeps
  its last document (the kiosk must keep working, PRD 9.4). The freeze
  attack (an attacker who blocks updates) is accepted and listed in
  Section 13.

### 4.6 Function catalogue and authorization

Wrappers (`convex/lib/functions.ts`, built on `convex-helpers`
0.1.128 `customQuery` / `customMutation` / `customAction` from
`convex-helpers/server/customFunctions`):

```ts
export type Role = "owner" | "admin" | "viewer";
// ctx gains: member: Doc<"members">, orgId: Id<"organizations">, actor: AuditActor
export function memberQuery(minRole: Role): /* query builder */;
export function memberMutation(minRole: Role): /* mutation builder */;
export function memberAction(minRole: Role): /* action builder; checks via an internal query */;
// ctx gains: device: Doc<"devices">. Args deviceId + deviceSecret are consumed by the wrapper.
export const deviceQuery, deviceMutation, deviceAction;
```

`requireMember(ctx, minRole)`:

1. `getAuthUserId(ctx)` → null → `ConvexError({ code: "unauthenticated" })`.
2. Pick the membership. Load the user's rows with `members.by_user`
   `.take(MAX_MEMBERSHIPS)` (20, `lib/limits.ts`). The wrapper also
   consumes an optional argument `orgId` (it never reaches the handler;
   the Phase 4 dashboard never sends it):
   - `orgId` given: no membership in that organization → `not_found`
     (does not confirm the organization exists); that membership is
     `disabled` → `forbidden`.
   - `orgId` absent: no membership, or every membership `disabled` →
     `forbidden`; exactly one active → that one; more than one active →
     `org_required`.

   The client's `orgId` only selects among memberships the server just
   loaded; the organization is never taken from the client alone.
3. Role rank (`viewer < admin < owner`) below `minRole` → `forbidden`.
4. For role `owner` or `admin`: `getAuthSessionId(ctx)` must have an
   `mfaSessions` row → otherwise `mfa_required`. (Viewers may enable
   TOTP; it is not required.)
5. Returns `{ member, orgId: member.orgId }`. **Every** id argument a
   handler receives is then checked with `assertInOrg(doc, orgId)`
   (throws `not_found`, never `forbidden`, so other organizations' ids
   are not confirmed to exist).

Device wrappers call `checkDevice` (Phase 2) with the new rule:
the secret may match `secretHash` **or** `previousSecretHash`; a match on
`secretHash` while `previousSecretHash` is set clears
`previousSecretHash` (mutations only). Revoked → `{ kind: "revoked" }`
answers stay as in Phase 2 for the three existing functions; the new
device functions answer `ConvexError({ code: "device_rejected" })` for
unknown, wrong secret or revoked alike.

**Matrix** (✓ allowed; — refused). "Device" = the agent with its own
credentials; it can only touch its own device's rows.

| Function (file:name) | Kind | Unauth | Viewer | Admin | Owner | Device |
|---|---|---|---|---|---|---|
| `auth:*` (Convex Auth sign-in/out, refresh) | Convex Auth | ✓ | ✓ | ✓ | ✓ | — |
| `account:me` | query | returns `null` | ✓ | ✓ | ✓ | — |
| `account:redeemReset` | action | ✓ (needs a valid reset code) | — | — | — | — |
| `mfa:status`, `mfa:beginSetup`, `mfa:confirmSetup`, `mfa:verify`, `mfa:useRecoveryCode` | mixed | — | ✓ | ✓ (before MFA) | ✓ (before MFA) | — |
| Every **query** in `overview`, `fleet`, `groups`, `employees`, `apps`, `fileHandlers`, `enrollmentCodes`, `audit`, `settings`, `keys` and `members:list` (for example `fleet:list`, `fleet:liveStatus`, `fleet:installs`, `apps:installSummary`, `keys:trustProgress`) | query | — | ✓ | ✓ | ✓ | — |
| Every create/update/delete in `groups`, `fleet` (rename, move, kiosk, revoke, remove, rotate credential), `employees` (incl. `setPassword` action), `apps` (incl. `resolveWinget`, `fetchWebMeta` actions), `fileHandlers`, `enrollmentCodes`, `settings` (incl. `setExitPin` action) | mutation/action | — | — | ✓ | ✓ | — |
| `members:*` (invite, change role, disable, password-reset code, reset someone's TOTP), `keys:registerActive`, `keys:prepareRotation`, `keys:finishRotation` | mutation/action | — | — | — | ✓ | — |
| `enrollment:enroll` | mutation (public, token-checked, rate-limited) | ✓ token | — | — | — | — |
| `devices:desiredState`, `devices:heartbeat`, `devices:unenroll` | Phase 2 device functions | — | — | — | — | ✓ |
| `deviceApi:verifyEmployee`, `deviceApi:reportAudit`, `deviceApi:reportInstalls`, `deviceApi:rotateCredential` | device | — | — | — | — | ✓ |
| `setup:createOwnerInvite`, `testing:*`, `publish:run`, `maintenance:*`, every `internal*` | internal | CLI / scheduler only | | | | |

Rules: the last Owner cannot be demoted, disabled or removed
(`last_owner`). A member cannot change their own role. Admins cannot
create Owners.

#### Ready for more than one organization

Phase 4 ships one organization per deployment (D1). These rules are
built and tested now so that adding a second organization later needs
no data migration. Every table with an `orgId` is new in Phase 4 or
already has it, so `orgId` is required from the start on `members`,
`policyKeys` and the others; only `deviceStatus.orgId` stays optional
(Phase 2 rows).

| Edge case | Rule |
|---|---|
| Same person, two organizations | Two `members` rows, one `users` row. MFA (`memberSecrets`, `mfaSessions`) belongs to the user, so they enrol an authenticator once and one verification covers the session |
| Duplicate membership | Convex indexes do not enforce uniqueness. Every insert into `members` first reads `by_org_user` in the same mutation (mutations are serializable, so two racing joins cannot both pass) and returns the existing row or `already_member` |
| Disabling in one organization | `members:setDisabled` calls `invalidateSessions` and deletes the user's `mfaSessions` **only when the user has no other active membership**. Otherwise the disabled row alone blocks them, because `requireMember` checks it on every call |
| Last Owner | Counted per organization (`members.by_org_role`), never per user |
| Same email invited by two organizations | Invites are per organization (`invites.by_org`); acceptance checks `by_org_user`. In Phase 4 an email that already has a member row in a different organization gets `already_member` (only tests create a second organization) |
| Another organization's id | `not_found` from `assertInOrg`, as today |
| Same public signing key in two organizations | Two `policyKeys` rows, one per organization (`by_org_key_id`); rotating in one never touches the other |
| Device keys | `desiredState` and `enroll` return only the device's organization's keys |
| Audit rows | `orgId` of the organization the action ran in, never the user's "home" |
| More than `MAX_MEMBERSHIPS` memberships | Rows beyond 20 are ignored by `requireMember`; the Phase 4 UI cannot produce them |

`account:me` also returns `memberships: [{ orgId, orgName, role }]`
(active ones only). The dashboard shows an organization switcher only
when the list has more than one entry.

**Proof, not a promise:** `authz.test.ts` builds two organizations and a
user who is a member of both (Section 4.6 tests) so the claim "no data
change in v2" is checked on every run.

**What v2 still has to build** (not data changes):

- The organization switcher and the client sending `orgId`.
- The invite path for an existing user (attach a membership instead of
  creating a user). How Convex Auth's `createOrUpdateUser` behaves for an
  existing account is **(unverified)**; check it first.
- A home for per-organization signing seeds. Convex env vars are
  deployment-wide, so options are a master key in env that encrypts each
  organization's seed in the database, or an external key service.
  **Open; decide in v2.** Until then every organization in a deployment
  signs with the one env seed, and trust stays per organization. This
  also means whoever operates the deployment can sign for every
  organization, which is acceptable for self-hosting and must be stated
  for any hosted offer.
- Per-organization rate limits (`enrollGlobal` is per deployment) and
  `orgStats` counters per organization (already one row each).
- Narrowing `deviceStatus.orgId` to required once every row has it.

### 4.7 Secrets: one writer, one reader

| Secret | Stored as | Written by | Read by | Never |
|---|---|---|---|---|
| Device secret | SHA-256 hex in `devices.secretHash` / `previousSecretHash` | `enroll`, `deviceApi:rotateCredential` | `checkDevice` | returned by any query |
| Enrollment token | SHA-256 hex | `enrollmentCodes:create` (returns the code **once**) | `enroll` | listed again; logged |
| Employee password | Argon2id PHC in `employeeSecrets` | `employees:setPassword` action (via internal mutation) | `deviceApi:verifyEmployee` (via internal query) | returned, logged, in the document |
| Exit PIN | Argon2id PHC in `orgSecrets.exitPinHash` | `settings:setExitPin` action | `publish:run` → document → agent | returned by `settings:get` (it returns `pinSet: boolean` only) |
| Member password | Convex Auth (`authAccounts`, Scrypt) | Convex Auth, `account:redeemReset` | Convex Auth | touched by our code otherwise |
| TOTP secret | base32 in `memberSecrets.totpSecret` | `mfa:confirmSetup` | `mfa:verify` | returned after `beginSetup` |
| Recovery codes | SHA-256 hex list | `mfa:confirmSetup` (shown once) | `mfa:useRecoveryCode` | stored plain |
| Invite / reset code | SHA-256 hex | `members:invite`, `members:createResetCode`, `setup:createOwnerInvite` (shown once) | `auth.ts` `profile()`, `account:redeemReset` | stored plain |
| Policy signing seed | env `RULEBOX_POLICY_KEY` (+ `_NEXT`) | the Owner with the CLI | `convex/lib/signing.ts` | in the DB, the repo, the browser, a log |

A test (`convex/secrets.test.ts`, Step 18) calls **every** public query
as an Owner and asserts that no returned value contains `$argon2`, a
64-hex string equal to any stored hash, or a TOTP secret.

### 4.8 Apps, catalogue and installs

**Validators** (`convex/lib/validators.ts`):

```ts
export const webPermissions = v.object({ camera: v.boolean(), microphone: v.boolean(), screenShare: v.boolean(),
  clipboardRead: v.boolean(), notifications: v.boolean(), downloads: v.boolean(), printing: v.boolean(), geolocation: v.boolean() });
export const DEFAULT_WEB_PERMISSIONS = { camera: false, microphone: false, screenShare: false, clipboardRead: false,
  notifications: true, downloads: true, printing: false, geolocation: false }; // PRD 24.1, same as rulebox_ipc WebPermissions::default
export const webSpec = v.object({ url: v.string(), allowedDomains: v.array(v.string()), permissions: webPermissions });
export const installSpec = v.object({
  kind: v.union(v.literal("msi"), v.literal("exe"), v.literal("portable")),
  url: v.string(),                 // https:// only
  sha256: v.string(),              // 64 lower-case hex
  sizeBytes: v.number(),           // 1 .. 4 GiB; 0 = unknown
  silentArgs: v.array(v.string()), // exe only; msi gets "/qn /norestart" from the agent
  productCode: v.optional(v.string()), // msi; "{GUID}" upper-case
  successExitCodes: v.array(v.number()), // always includes 0; msi adds 3010 and 1641 in the agent
  removeWhenUnassigned: v.boolean(),     // ignored for exe (cannot uninstall in Phase 4)
});
export const desktopSpec = v.object({
  source: v.union(v.literal("winget"), v.literal("msi"), v.literal("exe"), v.literal("portable"), v.literal("preinstalled")),
  exe: v.string(),                     // path template, Section "Path templates"
  args: v.array(v.string()),
  fileArgTemplate: v.array(v.string()),// e.g. ["{file}"]; [] = the app cannot open files
  install: v.optional(installSpec),    // absent for "preinstalled"
  wingetId: v.optional(v.string()), wingetVersion: v.optional(v.string()),
  resetFolders: v.array(v.string()),   // PRD 5.3; Section 4.12
});
```

**`CatalogApp`** (in the document's `catalog`; Rust type in
`crates/rulebox-policy/src/catalog.rs`, exported to TypeScript with
ts-rs and used by `convex/lib/desired.ts` through
`import type { CatalogApp } from "@rulebox/types"`):

```rust
#[serde(rename_all = "camelCase")]
pub struct CatalogApp {
    pub id: String,                       // "files" or a Convex apps id
    pub name: String,
    pub description: Option<String>,
    pub kind: CatalogKind,                // "builtin" | "web" | "desktop"
    pub builtin: Option<BuiltinSpec>,     // { tool: "files" }
    pub web: Option<WebSpec>,             // { url, allowedDomains, permissions }
    pub desktop: Option<DesktopSpec>,     // { exe, args, fileArgTemplate, install: Option<InstallSpec>, resetFolders }
    pub pinned_taskbar: bool,
    pub pinned_desktop: bool,
    pub hue: Option<u16>,
    pub icon: Option<IconRef>,            // { url, sha256 } ; url = ctx.storage.getUrl(storageId)
    pub audience: Audience,               // "everyone" | "selected"
    pub employee_ids: Vec<String>,        // sorted; used when audience is "selected"
    #[ts(type = "number")] pub revision: u64,
}
pub struct InstallSpec { pub kind: InstallKind /* msi|exe|portable */, pub url: String, pub sha256: String,
    #[ts(type = "number")] pub size_bytes: u64, pub silent_args: Vec<String>, pub product_code: Option<String>,
    pub success_exit_codes: Vec<i32>, pub remove_when_unassigned: bool }
```

Unknown enum strings map to `Unknown` with the `unknown_on_new_values!`
pattern (copy the macro into `rulebox-policy`); a `CatalogApp` whose
kind is `Unknown` is skipped by the agent.

**What a device's catalogue contains** (built per device by the
publisher):

- Every non-archived app assigned to the device's group
  (`appAssignments.by_group`), with that assignment's `audience`,
  pins, and `employeeIds` = employees of the group that have the app in
  `employeeApps` (only meaningful for `selected`).
- Every non-archived **web** app granted directly to an employee of the
  group (`employeeApps`) that the group does not already assign:
  audience `selected`, `employeeIds` = those employees, no pins.
- A desktop app granted directly to an employee but not assigned to the
  group is **not** included: it would need an install the group did not
  ask for. The employee page says so next to such an app ("Only on
  devices whose group has this app").

**Which apps an employee sees on a device** (agent, `catalog.rs`
`visible_apps(catalog, employee_id, installed)`): audience `everyone`,
or `employee_ids` contains the employee; and for desktop apps with an
`install`, only when the install state is `installed` (PRD 13.5: never a
half-installed app); desktop apps without `install` (`preinstalled`) are
shown when their exe exists. The result is mapped to
`rulebox_ipc::requests::AppEntry` (icons from the icon cache).

**Path templates** (for `exe`; checked by `convex/lib/pathRules.ts`
**and** by the agent before use):

- Must start with exactly one of `{ProgramFiles}\`, `{ProgramFilesX86}\`,
  `{RuleboxApps}\<this app's id>\` (portable apps), `{SystemRoot}\System32\`.
- The rest: 1 to 8 components separated by `\`, each 1–100 characters
  from letters, digits, space and `._-()+&`, not `.` or `..`; ends in
  `.exe` (case-insensitive). Total ≤ 260 characters after expansion.
- The agent expands `{ProgramFiles}` and `{ProgramFilesX86}` from
  `FOLDERID_ProgramFiles` / `FOLDERID_ProgramFilesX86`, `{SystemRoot}`
  from `FOLDERID_Windows`, `{RuleboxApps}` to
  `<install root>\apps` (`C:\Program Files\Rulebox\apps`).
- `args` and `fileArgTemplate`: each ≤ 200 characters, at most 16;
  `fileArgTemplate` must contain `{file}` exactly once when not empty.

**Sources:**

| Source | How it is added | Install by the agent |
|---|---|---|
| `winget` | Admin enters a package id (e.g. `VideoLAN.VLC`) and optionally a version; `apps:resolveWinget` (action) fetches the manifest from `https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests/<first letter lower-case>/<id with "." → "/">/<version>/<id>.installer.yaml` (version list via the GitHub contents API `https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/...`; `GITHUB_TOKEN` env var optional, raises 60 → 5,000 requests/hour), picks one installer entry (below), and fills `installSpec` | as `msi` or `exe` |
| `msi` | URL + SHA-256 + product code (optional) | `msiexec /i "<file>" /qn /norestart /l*v "<log>"` |
| `exe` | URL + SHA-256 + silent arguments (required, non-empty) | `"<file>" <silentArgs…>` |
| `portable` | URL + SHA-256 of a single `.exe` | copied to `{RuleboxApps}\<appId>\<file name from exe template>` |
| `preinstalled` | Only an exe path (the app is already on the PCs or installed by other means) | nothing |

**Choosing a winget installer entry** (`convex/lib/winget.ts`
`pickInstaller(manifest)`, pure, unit-tested on three committed
manifests in `convex/testdata/winget/`):

1. Drop entries with `Scope: user`, `Architecture: arm64`, or
   `InstallerType` (entry-level, else manifest-level) not in
   `msi, wix, exe, inno, nullsoft, burn`.
2. Prefer `Scope: machine` over no scope; then `x64` over `x86` /
   `neutral`; then `msi`/`wix` over the others.
3. `msi`/`wix` → kind `msi`, `productCode` from `ProductCode` (entry,
   else manifest, else `AppsAndFeaturesEntries[0].ProductCode`).
   Others → kind `exe` with `silentArgs` from `InstallerSwitches.Silent`
   (entry, else manifest), or the type default when absent:
   `inno` → `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-`,
   `nullsoft` → `/S`, `burn` → `/quiet /norestart`; plain `exe` with no
   `Silent` switch → **refused** ("this package has no silent install").
4. `successExitCodes` = `[0]` plus every `InstallerSuccessCodes` value.
5. `sha256` = `InstallerSha256` lower-cased; `url` = `InstallerUrl`
   (must be `https://`).
6. Nothing usable → `ConvexError({ code: "winget_unsupported", reason })`
   shown in the form.

The YAML is parsed with the `yaml` npm package (pure JS; version pinned
in Step 10 after `pnpm view yaml version` — **(unverified)** here). The
resolved result is cached in `wingetCache` for 24 hours.

**The agent never runs `winget`**, never loads `Microsoft.WinGet.Client`,
and never downloads anything not named by a signed document.

**Install engine** (agent, `apps/agent/src/installs/`; Step 14):

- Desired set = catalogue desktop apps with an `install`. Installed
  record per app in `<data>\state\installs.json`:
  `{ appId, sha256, state, attempts, nextTryMs, lastExitCode }`.
- An app needs work when: not installed and its exe is missing; or its
  installed `sha256` differs from the catalogue's (new version); or it
  is no longer in the catalogue, `removeWhenUnassigned` is true and kind
  is `msi` or `portable`.
- **One operation at a time**, by a dedicated `installs` task. It runs on
  `DesiredChanged`, at start, and when the earliest `nextTryMs` comes
  due (a timer for retries, not a backend poll).
- **Download** to `<data>\downloads\<sha256>.<msi|exe>` (the protected
  data directory; the Staff account cannot write there) with streaming
  SHA-256; reject when the size exceeds `sizeBytes` (if non-zero) or
  4 GiB; delete on mismatch. Reuse a file whose hash already matches.
  Free disk check before download: need `sizeBytes × 3` free on the
  system drive, else `failed` with detail `low_disk`.
- **Install** (WindowsPlatform, guarded): `CreateProcessW` of
  `%SystemRoot%\System32\msiexec.exe` or the downloaded exe, as SYSTEM,
  no window, in the data directory, waiting at most 30 minutes
  (`INSTALL_TIMEOUT`); on timeout the process tree is terminated and the
  result is `failed`/`timeout`. MSI log to
  `<data>\logs\install-<appId>.log` (last 5 kept).
- **Exit codes:** success when in `successExitCodes`, or for MSI one of
  `0, 3010, 1641` (3010/1641 set `restartPending: true` in the status
  report; the agent never restarts the PC). `1618` (another install
  running) → retry after 2 minutes without counting an attempt. Anything
  else → attempt counted.
- **After success** the exe path must exist within 10 seconds, else
  `failed` with detail `exe_missing_after_install`.
- **Retries:** attempts 1–5 back off 1, 5, 15, 60, 360 minutes; after the
  5th failure the state stays `failed` until the catalogue entry's
  `revision` changes (the admin presses **Retry**, which bumps the app's
  revision and republishes).
- **Removal:** MSI with a product code → `msiexec /x <ProductCode> /qn
  /norestart` (1605 "unknown product" counts as removed); portable →
  delete `{RuleboxApps}\<appId>` (refuse a reparse point); exe → never
  removed (only hidden).
- **Reporting:** every state transition is sent with
  `deviceApi:reportInstalls` in batches of up to 50, only the transitions
  the server has not acknowledged (kept in `installs.json`
  `reportedState`), when online; on reconnect the unacknowledged ones
  are sent again. The server upserts `installResults` (write only on
  change).
- **Simulate mode:** `SimPlatform` fakes download and install (a
  scripted exit code per app id, default 0) and creates the exe in its
  fake file set, so the whole flow is testable on the dev machine.

### 4.9 Heartbeat, online status and the free tier

Convex free plan (verified 2026-10-20): **1,000,000 function calls /
month, 1 GB database I/O / month, 0.5 GB database storage, 1 GB file
storage, 1 GB file egress, 20 GB-hours action compute, 1,000 concurrent
sessions, 16 concurrent queries and 16 concurrent mutations.**

`nextPingInMs` by fleet size (`convex/lib/heartbeat.ts`
`pingIntervalFor(deviceCount)`; stored in `orgStats.pingIntervalMs` when
`deviceCount` changes):

| Devices in the org | Interval | Heartbeat calls / month (30 days) |
|---|---|---|
| 1–25 | 5 min | ≤ 216,000 |
| 26–100 | 15 min | ≤ 288,000 |
| 101–300 | 30 min | ≤ 432,000 |
| 301+ | 60 min | 720 per device (1,000 devices = 720,000) |

Online rule (dashboard, `apps/dashboard/src/lib/online.ts`):
`online = now - lastSeenAt <= 2.5 × pingIntervalMs + 60,000`. The agent
already sends a heartbeat 0–10 s after every reconnect, so a device that
comes back shows online within seconds; a device that goes away shows
offline after at most 2.5 intervals. The device page says "Last seen
12 minutes ago" rather than only a dot. `now` comes from a 30-second
ticking hook (`useNow(30_000)`); queries never call `Date.now()` for
this.

Other budgets: the agent's subscription re-runs only when its device row
or newest document changes; `verifyEmployee` is one action per online
sign-in; `reportAudit` / `reportInstalls` are event-driven. The
dashboard's `fleet:liveStatus` re-runs on each heartbeat of a visible
device only while a device list is open. Section 15 has the full budget.

### 4.10 Organization settings

```ts
export const orgSettings = v.object({
  offlineDays: v.number(),       // 0..30, default 3 (PRD 13.6 #6); 0 = no offline sign-in
  defaultQuotaGb: v.number(),    // 0..2000, default 10; 0 = unlimited
  power: v.object({ sleep: v.boolean(), restart: v.boolean(), shutDown: v.boolean() }), // default all true
  adminExit: v.object({ enabled: v.boolean(), hotkey: v.string() }), // default true, "Ctrl+Shift+F12"
});
```

- The hotkey text is validated on the server with the same grammar as
  `rulebox_ipc::hotkey::parse` (modifiers Ctrl/Alt/Shift, at least two
  of them or one plus F1–F12, key A–Z, 0–9 or F1–F12; refused:
  Alt+Tab, Alt+F4, Ctrl+Alt+Del, Ctrl+Esc, Win combinations). Port the
  rules to `convex/lib/hotkey.ts` and run the Rust crate's accepted and
  refused examples as a table test in both languages (vectors in
  `crates/rulebox-ipc/tests/vectors/hotkeys.json`, new).
- The exit PIN: 6 to 12 ASCII digits (PRD 12.4 dashboard rule; Phase 2
  VM decision 3). Refused: all digits the same, and the ascending or
  descending runs `012345…`/`987654…`.

### 4.11 Audit log

- Append-only. No mutation updates or deletes an audit row except the
  retention cron (365 days, `AUDIT_RETENTION_DAYS`).
- `writeAudit(ctx, entry)` in `convex/lib/audit.ts` is the only writer.
  It truncates `summary` to 300 characters and refuses (throws in tests,
  drops the field in production) any `summary` that matches
  `/\$argon2|password|secret|token/i` with a value after it — callers
  write fixed texts with names, never values.
- **Actions** (exact strings; one per mutation that changes something):
  `org.settingsChanged`, `org.exitPinSet`, `org.exitPinCleared`,
  `member.invited`, `member.joined`, `member.roleChanged`,
  `member.disabled`, `member.enabled`, `member.resetCodeCreated`,
  `member.passwordReset`, `member.mfaEnabled`, `member.mfaReset`,
  `group.created`, `group.renamed`, `group.deleted`,
  `device.enrolled`, `device.renamed`, `device.moved`,
  `device.kioskEnabled`, `device.kioskDisabled`, `device.revoked`,
  `device.removed`, `device.credentialRotationRequested`,
  `device.credentialRotated`, `enrollment.codeCreated`,
  `enrollment.codeRevoked`, `employee.created`, `employee.updated`,
  `employee.passwordSet`, `employee.disabled`, `employee.enabled`,
  `employee.deleted`, `employee.groupsChanged`, `employee.appsChanged`,
  `employee.lockedOut` (server-side lock), `app.created`,
  `app.updated`, `app.archived`, `app.deleted`, `app.assigned`,
  `app.unassigned`, `app.retryRequested`, `fileHandler.set`,
  `fileHandler.removed`, `policy.keyRegistered`,
  `policy.rotationPrepared`, `policy.rotationFinished`,
  `policy.publishFailed`, and from devices:
  `device.adminExitSuccess`, `device.adminExitWrongPin`,
  `device.adminExitLockedOut`, `device.adminExitFailed`,
  `device.employeeLockedOut`, `device.auditDropped`.
- Device records: `eventKey = "dev:" + deviceId + ":" + record.id`;
  a repeated key is ignored (idempotent, Phase 2 5.11). `at` =
  `record.atMs + record.serverTimeOffsetMs` when the offset is known,
  else `record.atMs`; when the result is more than 7 days in the future
  or before the device's `enrolledAt`, `at` = server receive time and the
  summary says "(device clock wrong)".
- Viewers can read the audit log (it holds no secrets).

### 4.12 Employees, sign-in and session cleanup

- **Username:** 1–64 characters after normalization (trim, lower-case),
  letters, digits, `.`, `_`, `-`; unique per organization
  (`by_org_username`). The same rule as the agent's normalization.
- **Password (set by an admin):** 8–256 characters, not equal to the
  username; hashed with Argon2id m=19456 KiB, t=2, p=1, 16-byte salt,
  32-byte output (the agent's `kdf.rs` constants) by `hash-wasm` 4.12.0
  in a default-runtime action. Each set bumps `credentialRevision` and
  republishes the employee's groups (the agent then drops the offline
  cache entry, so the old password stops working offline too).
- **`deviceApi:verifyEmployee`** (device action):
  1. Internal query `deviceApi.loadForVerify`: device check; employee by
     `by_org_username`; secret; lockout row; membership of the device's
     group (`groupMembers.by_group_employee`); org settings.
  2. Per-device rate limit (`@convex-dev/rate-limiter` 0.4.2,
     `verifyPerDevice`: token bucket 30 per minute, capacity 30) via an
     internal mutation; over the limit → `{ kind: "lockedOut",
     retryAfterMs }`.
  3. No employee, disabled, or not in the device's group: still run one
     Argon2id verify against a fixed dummy hash (equal timing), then
     answer `wrongCredentials` / `disabled` / `notAllowedHere`
     respectively. `disabled` and `notAllowedHere` are only answered
     when the password **was** correct (so they do not reveal which
     usernames exist).
  4. Server lockout (`employeeLockouts`): 10 consecutive failures →
     locked 15 minutes, audit `employee.lockedOut`. The agent's own
     per-device schedule (Phase 2) stays in front of it.
  5. Answer: `{ kind: "ok", employee: { id, username, name, role: null,
     quotaBytes }, offlineDays, credentialRevision }` where `quotaBytes`
     = (employee `quotaGb` ?? org `defaultQuotaGb`) × 1,073,741,824
     (0 = unlimited).
- **Session cleanup (PRD 5.3):** `resetFolders` entries are templates
  `{LocalAppData}\<rel>` or `{RoamingAppData}\<rel>`, `<rel>` 1–6
  components with the path-template character rules; resolved inside the
  **Staff profile** (`state.staff.profile_dir` + `AppData\Local` or
  `AppData\Roaming`). Agent behaviour in Step 16.

### 4.13 Dashboard screens

Routing: `react-router` 8 in **declarative mode** (`BrowserRouter`,
`Routes`, `Route`, `Outlet`, `Link`, `NavLink`, `useNavigate`,
`useParams`). Browser history; the host serves `index.html` for
unknown paths (Section 4.15). Every screen except the four public ones is
inside `<RequireMember>` (Step 4).

| Path | Screen | The one data query | Min role to see / to act |
|---|---|---|---|
| `/sign-in` | Email + password; link "Have an invite code?" | — | public |
| `/join` | Invite code + email + new password (sign-up flow) | — | public |
| `/reset` | Reset code + email + new password | — | public |
| `/mfa` | Set up TOTP (QR as `otpauth://` text + secret in groups of 4, confirm code, show recovery codes once) or enter a code / recovery code | `mfa:status` | signed in |
| `/` | Overview: device totals, seen-recently count, failed installs (latest 20), recent audit (10), warnings (no signing key, devices without group, out-of-support devices) | `overview:get` | viewer |
| `/devices` | Device list: name, group, online dot + "last seen", agent version, Windows build (red badge when out of support), kiosk phase, applied/desired version; filter by group; search by name; "Load more" | `fleet:list` (+ `fleet:liveStatus` for the visible ids; + `fleet:search` when the search box is used) | viewer |
| `/devices/:id` | Device detail: identity, status, compatibility report, kiosk switch, group picker, rename, apps and install states (paginated), last 5 document versions, history panel; actions Revoke, Remove, Rotate credential | `fleet:get` (+ `fleet:liveStatus`, `audit:forTarget`) | viewer / admin |
| `/groups` | Group list with device and employee counts (counts capped: "500+") | `groups:list` | viewer |
| `/groups/:id` | Group: name, description; assigned apps (audience, pins, add/remove); devices (paginated); employees (paginated, add/remove) | `groups:get` (+ two paginated lists `fleet:list({groupId})`, `employees:list({groupId})`) | viewer / admin |
| `/employees` | Employee list: name, username, groups, quota, disabled; search; "Add employee" | `employees:list` / `employees:search` | viewer / admin |
| `/employees/new`, `/employees/:id` | Form: name, username, quota (blank = org default), groups, direct apps, disabled; "Set password" dialog; lockout state with "Unlock"; history | `employees:get` | viewer / admin |
| `/apps` | App list: icon/hue, name, kind/source, groups count, install summary (installed / failed / pending); "Add app" | `apps:list` | viewer / admin |
| `/apps/new`, `/apps/:id` | Form by kind: Web (URL → "Fetch details" fills name/icon/hue from the manifest; allowed domains); Desktop (source picker: winget id → "Resolve", MSI/EXE/portable URL + SHA-256 + args, or preinstalled; exe path; file argument; reset folders); assignments; install status per state with device links (paginated); Retry; Archive; Delete | `apps:get` | viewer / admin |
| `/file-types` | Extension → app table, add/remove | `fileHandlers:list` | viewer / admin |
| `/enrollment` | Create code (group required, uses 1–100, expiry 15 min–7 days, label); the code is shown **once** in a copy field with "Copied" feedback; list (paginated) with state (active / used up / expired / revoked) and Revoke | `enrollmentCodes:list` | viewer / admin |
| `/audit` | Audit log, newest first, "Load more"; each row: time, actor, action, target link, summary | `audit:list` | viewer |
| `/settings` | Tabs: Organization (name, offline days, default quota, power options), Admin exit (enabled, key combination, set / clear PIN), Signing (key id, fingerprint, device trust counts, register / rotate, loss instructions), Members (Owner: invite, roles, disable, reset code, reset 2FA), About (versions, Solar credit "Icons: Solar by 480 Design (CC BY 4.0)", GSAP notice) | `settings:get` (+ `members:list` on that tab, `keys:status` on Signing) | viewer / admin / owner per tab |
| `/gallery` | The existing design-system gallery (members only) | — | viewer |
| `*` | Not found | — | — |

States every data screen has (the shared components of Step 4):

- **Loading:** `useQuery` returns `undefined` → skeleton rows (static
  blocks, no shimmer animation in Lite or reduced motion). Never a
  spinner over the whole page for more than one region.
- **Empty:** an `EmptyState` with one sentence and the primary action
  ("No devices yet. Create an enrollment code to add the first PC.").
- **Error:** query errors are caught by an `ErrorBoundary` per screen
  region with "Try again"; mutation errors map a `ConvexError` code to a
  sentence from `lib/strings.ts` and appear next to the form (never
  `alert()`).
- **Disconnected:** a banner at the top when
  `useConvexConnectionState().isWebSocketConnected` has been false for
  3 seconds: "Reconnecting… Changes you make now are sent when the
  connection is back." Mutations stay enabled (Convex queues them).
- **Stale edit:** every edit form sends the `revision` it loaded; the
  server answers `ConvexError({ code: "stale_edit" })` when it changed;
  the form shows "Someone else changed this. Reload to see their
  changes." with a Reload button that re-reads and keeps nothing.
- **Pagination:** `usePaginatedQuery(..., { initialNumItems: 50 })`,
  "Load more" loads 50 more; the button disappears at `Exhausted`.
  Rows can move between pages as data changes (Convex pages are
  reactive); that is accepted.
- **Forms:** plain controlled inputs and hand-written validators in
  `lib/validate.ts` that mirror the server's rules (the server is
  authoritative). Submit disabled while pending; Enter submits; errors
  are linked with `aria-describedby`.
- **Optimistic updates:** only for toggles (kiosk switch, archive, pins)
  through `withOptimisticUpdate`; everything else waits for the server.

Motion (PRD 25): GSAP only in `useGSAP()` through
`apps/dashboard/src/lib/motion.ts` (same API as the Staff App's: fade-only
in reduced motion or Lite), for page entry (y 8 → 0 + autoAlpha, 200 ms),
dialogs, toasts and row insert/remove (Flip for the device list reorder is
**not** used). Hover and press are CSS. Icons: Solar `-linear`, the active
navigation item `-bold-duotone` (Decision 16).

### 4.14 File layout

```
convex/
├─ convex.config.ts         # (new) defineApp({ env }), app.use(rateLimiter)
├─ auth.config.ts           # (new) Convex Auth provider config
├─ auth.ts                  # (new) convexAuth({ providers: [Password(...)] , callbacks })
├─ http.ts                  # (new) auth.addHttpRoutes(http)
├─ crons.ts                 # (new) audit retention, invite cleanup, mfaSessions cleanup
├─ schema.ts                # rewritten (Section 4.2)
├─ setup.ts                 # (new) internal createOwnerInvite
├─ account.ts  mfa.ts  members.ts
├─ settings.ts  keys.ts  publish.ts
├─ groups.ts  fleet.ts  employees.ts  apps.ts  fileHandlers.ts
├─ enrollmentCodes.ts  audit.ts  overview.ts
├─ enrollment.ts            # Phase 2, changed (keys, rate limit, orgStats, audit)
├─ devices.ts               # Phase 2 agent functions, changed (envelope, heartbeat → deviceReports)
├─ deviceApi.ts             # (new) verifyEmployee, reportAudit, reportInstalls, rotateCredential
├─ maintenance.ts           # (new) cron targets
├─ testing.ts               # (new) guarded seed/cleanup for e2e (replaces dev.ts)
├─ health.ts                # unchanged
├─ lib/
│  ├─ functions.ts  authz.ts  errors.ts  validators.ts  audit.ts
│  ├─ deviceAuth.ts (changed)  deepEqual.ts  crypto.ts (base64, hex, randomToken for actions)
│  ├─ signing.ts  desired.ts  publish.ts  heartbeat.ts  hotkey.ts  pathRules.ts
│  ├─ totp.ts  argon.ts (actions only)  winget.ts  webmeta.ts  rateLimits.ts  limits.ts
├─ testdata/winget/*.yaml   # three real manifests, committed
└─ *.test.ts                # convex-test suites (vitest project "convex")

apps/dashboard/
├─ index.html  vite.config.ts  vitest.config.ts  playwright.config.ts
├─ public/_headers          # Cloudflare Pages security headers (Section 9)
├─ vercel.json              # same headers + SPA rewrite
├─ src/
│  ├─ main.tsx  App.tsx (routes)  Gallery.tsx (kept)
│  ├─ app/  RequireMember.tsx  Layout.tsx  Nav.tsx  ConnectionBanner.tsx  Toasts.tsx
│  ├─ components/  DataTable.tsx  LoadMore.tsx  StatusDot.tsx  Field.tsx  ConfirmDialog.tsx
│  │               EmptyState.tsx  PageHeader.tsx  CopyField.tsx  Skeleton.tsx  RoleGate.tsx
│  ├─ screens/  SignIn.tsx  Join.tsx  Reset.tsx  Mfa.tsx  Overview.tsx  Devices.tsx  DeviceDetail.tsx
│  │            Groups.tsx  GroupDetail.tsx  Employees.tsx  EmployeeDetail.tsx  Apps.tsx  AppEdit.tsx
│  │            FileTypes.tsx  Enrollment.tsx  Audit.tsx  Settings.tsx  NotFound.tsx
│  └─ lib/  strings.ts  format.ts  errors.ts  validate.ts  online.ts  useNow.ts  motion.ts
└─ e2e/  *.spec.ts          # Playwright

crates/rulebox-policy/src/  lib.rs (DesiredState unchanged)  catalog.rs  envelope.rs (new)
crates/rulebox-policy/tests/vectors/  signed-v2.json  catalog-v2.json (new)
crates/rulebox-ipc/  methods.rs/types.rs/requests.rs (protocol 1.2)  tests/vectors/hotkeys.json (new)
apps/agent/src/  backend/{mod,convex,task}.rs (changed)  directory.rs  audit.rs  catalog.rs (new)
                 installs/{mod,download,engine,report}.rs (new)  cleanup.rs (new)  trust.rs (new)
apps/staff-app/src-tauri/src/  agent/{ipc,demo}.rs  model.rs  files/mod.rs (handlers wiring)  (Step 15 only)
scripts/policy-key.mjs  gen-policy-vectors.mjs  gen-argon-vectors.mjs  fleet-sim.mjs (all new)
tests/convex/identity.ts (new; test helper kept outside convex/ so it is never pushed)
vitest.config.ts (new, root; project "convex")
```

### 4.15 Dependencies (versions checked 2026-10-20)

Add to `pnpm-workspace.yaml` `catalog:` (exact versions, like the Phase 3
block) and reference with `catalog:`:

| Package | Version | Where | Why |
|---|---|---|---|
| `convex` | `1.47.0` (bump from 1.46.0) | root, dashboard | `.staged()` and the large-index deploy check |
| `@convex-dev/auth` | `0.0.96` | root (Convex functions), dashboard | member sign-in (beta; Section 13) |
| `@auth/core` | `0.41.1` | root | peer of `@convex-dev/auth` |
| `@convex-dev/rate-limiter` | `0.4.2` | root | enroll / verify / invite limits |
| `convex-helpers` | `0.1.128` | root | `customQuery` / `customMutation` / `customAction` |
| `@noble/ed25519` | `3.2.0` | root | signing in a mutation |
| `@noble/hashes` | `2.4.0` | root | SHA-512 for noble, HMAC-SHA1 for TOTP |
| `hash-wasm` | `4.12.0` | root | Argon2id in default-runtime actions (WebAssembly is supported there) |
| `yaml` | latest 2.x at Step 10, **(unverified)** | root | winget manifests |
| `react-router` | `8.5.0` (published 2026-10-19; pnpm's default `minimumReleaseAge` of 1 day lets it install after 2026-10-20 13:49 UTC; if refused, use `8.4.0`) | dashboard | routing |
| `convex-test` | `0.0.62` | root dev | function tests |
| `@edge-runtime/vm` | `5.0.0` | root dev | convex-test environment |
| `vitest` | `5.0.4` (catalog) | root dev, dashboard dev | tests |
| `jsdom`, `@testing-library/react` | catalog | dashboard dev | component tests |
| `@testing-library/user-event` | `14.6.8` | dashboard dev | component tests |
| `@playwright/test` | `1.64.1` | dashboard dev | e2e (Chromium only; the browser download is about 150–200 MB, tell the user first) |
| `gsap`, `@gsap/react` | catalog (3.15.0 / 2.1.2) | dashboard | motion |
| `@rulebox/types` | `workspace:*` | root dev | type-only imports from `convex/` |

Rust, add to `[workspace.dependencies]`:

| Crate | Version | Features | Used by |
|---|---|---|---|
| `ed25519-dalek` | `3.0.0` | defaults (`fast`, `zeroize`) | `rulebox-policy` (verify) |
| `reqwest` | `0.13.5` | `default-features = false`, `["native-tls", "stream", "http2", "system-proxy"]` | agent downloads (reuses SChannel like the Convex client; avoids compiling rustls + aws-lc) |

`base64` 0.23.1 and `sha2` 0.11.1 are already in the workspace. Do not
add `ring`, `rustls`, `openssl`, `async-trait` or any winget crate.

**Disk:** `ed25519-dalek` and `reqwest` add roughly 100–200 MB to
`target\debug` (estimate); Playwright's Chromium about 200 MB under
`%LOCALAPPDATA%\ms-playwright`. Step 0 checks free space.

---

## 5. Contracts that change

### 5.1 Backend wire contract (agent ↔ Convex)

All names stay; shapes change additively where possible. The agent and
the server change together in this phase (there is no field fleet), but
every change is still written so that an older agent gets a clean
refusal rather than a wrong action.

| Function | Phase 2 | Phase 4 |
|---|---|---|
| `enrollment:enroll` | returns `{ deviceId, orgId, deviceName, serverTimeMs }` | adds `policyKeys: [{ keyId, publicKey }]`; throws `not_ready` when no active key; rate limit `enrollGlobal` (token bucket 60/min per deployment) → `rate_limited` |
| `devices:desiredState` | `desired: { version, doc, signature: null }` | `desired: { version, payload, signature, keyId } \| null`, plus top-level `keys: [{ keyId, publicKey, endorsement: { byKeyId, signature } \| null }]` and `retiredKeyIds: string[]`. Reads only `devices`, `desiredStates`, `policyKeys` (no `Date.now()`) |
| `devices:heartbeat` | `status` strict object with 12 keys; writes `devices` | `status` gains optional `trustedKeyIds: string[]` and `restartPending: boolean` (14 keys); writes `deviceReports`; answer gains `rotateCredential: boolean`; `nextPingInMs` from `orgStats` |
| `devices:unenroll` | unchanged | also audits `device.revoked` with actor "device" |
| `deviceApi:verifyEmployee` | — | action, Section 4.12 |
| `deviceApi:reportAudit` | — | `{ deviceId, deviceSecret, records: AuditRecord[] (≤ 50), dropped: number }` → `{ accepted: number }` |
| `deviceApi:reportInstalls` | — | `{ deviceId, deviceSecret, results: [{ appId, state, appRevision, attempts, exitCode?, detail? }] (≤ 50) }` → `{ accepted: number }`; unknown app ids are ignored (counted as accepted) |
| `deviceApi:rotateCredential` | — | `{ deviceId, deviceSecret, newSecretHash }` → `{ kind: "ok" }`; idempotent: if `secretHash` already equals `newSecretHash` and the caller presented `previousSecretHash`, answer ok |

**Order of deployment within the phase:** server first (Steps 7, 8,
12), agent second (Steps 9, 13, 14). Between Step 8 and Step 9 a
Phase 2 agent receives the new envelope, fails to parse it
(`Protocol` error, logged) and keeps its cached state — a clean refusal,
never a wrong action. The strict `statusValidator` gets the two new
optional keys **before** the agent sends them (Step 7), and the Rust test
that pins `STATUS_KEYS` is updated in Step 9.

### 5.2 IPC protocol 1.2 (agent ↔ Staff App)

Additive minor version (`PROTOCOL_MINOR = 2`). 1.1 clients keep working:
the Phase 2 `IpcClient` already ignores unknown events, and unknown
outcome strings map to `Unknown`.

| Addition | Shape | When |
|---|---|---|
| Capability `appsChanged` | listed in `hello` when the agent sends the event | always on a 1.2 agent with `apps` |
| Event `apps.changed` | `{}` | the signed-in employee's visible app list changed (new document, or an install finished or failed) — at most one per 2 seconds |
| Capability `sessionEnded` | | always on a 1.2 agent with `session` |
| Event `session.ended` | `{ reason: "employeeRemoved" \| "credentialChanged" \| "revoked" }` (enum with `Unknown`) | the agent cleared the session because the employee is no longer in `doc.employees`, their `credentialRevision` changed, or the device was revoked |
| `SignInOutcome::NotAllowedHere` | outcome string `"notAllowedHere"` | the directory answered that the employee is not in this device's group (or not in `doc.employees` while offline) |

The `AgentSnapshot` does not change (the catalogue is not in it, and the
`DesiredState` part stays secret-free).

---

## 6. Steps

| Step | What | Machine | Depends on | Touches |
|---|---|---|---|---|
| 0 | Preflight | dev | — | nothing |
| 1 | Tooling and test harness | dev | 0 | root, `convex/`, dashboard config |
| 2 | Schema v2, function wrappers, errors, audit helper | dev | 1 | `convex/` |
| 3 | Member accounts: Convex Auth, invites, owner bootstrap, MFA | dev | 2 | `convex/` |
| 4 | Dashboard foundation | dev | 3 | dashboard, `packages/ui` |
| 5 | Organization settings, exit PIN, groups | dev | 4 | `convex/`, dashboard |
| 6 | Enrollment codes | dev | 5 | `convex/`, dashboard |
| 7 | Devices: reports split, heartbeat scaling, fleet screens | dev | 6 | `convex/`, dashboard |
| 8 | Signing keys and the publisher | dev | 7 | `convex/`, `scripts/`, `rulebox-policy` vectors, dashboard |
| 9 | Agent: verify signed documents, key trust | dev (simulate) | 8 | `rulebox-policy`, agent |
| 10 | Apps, winget, web metadata, assignments, file types | dev | 8 | `convex/`, dashboard, `rulebox-policy` (catalog) |
| 11 | Employees | dev | 10 | `convex/`, dashboard |
| 12 | Device API (server) | dev | 11 | `convex/` |
| 13 | Agent: Convex directory, audit sink, catalogue, credential rotation, protocol 1.2 | dev (simulate) | 9, 12 | agent, `rulebox-ipc` |
| 14 | Agent: install engine | dev (simulate) | 13 | agent |
| 15 | Staff App: protocol 1.2 and file handlers | dev (demo + simulate) | 13, **Phase 3 Step 19** | `apps/staff-app` |
| 16 | Agent: session cleanup (reset folders) | dev (simulate) | 13 | agent |
| 17 | Dashboard: install status, overview, audit, history | dev | 12, 14 | `convex/`, dashboard |
| 18 | Security and load hardening | dev | 17 | tests, `scripts/` |
| 19 | End-to-end tests (Playwright) | dev | 18 | dashboard |
| 20 | Retire `dev.ts`, docs | dev | 19 | `convex/`, docs |
| 21 | VM run (the user runs it) | **VM** | 15, 16, 20 | nothing new |
| 22 | Wrap-up | dev | 21 | docs |

Rules for every step:

- Verify only what you touched: `pnpm test:convex`,
  `pnpm --filter @rulebox/dashboard typecheck|lint|test`,
  `cargo clippy -p <crate> --all-targets -- -D warnings`,
  `cargo test -p <crate>`. Workspace-wide commands run in Step 22.
- Convex changes are deployed to the **dev deployment** with
  `npx convex dev --once` (it typechecks and pushes). Never
  `npx convex deploy` (production) in this phase.
- **UI steps are not done until you ran the dashboard and looked at
  it** (`pnpm dev:dashboard`, then screenshots of each new screen in
  light and dark, with the browser at 1280×800 and at 390×844). Take
  screenshots of the dashboard's browser tab only, never the whole
  screen. Keep them in `.tmp/phase4/` (gitignored) for the report.
- No `unwrap()` / `expect()` outside tests; no new `unsafe` (Phase 4 has
  no reason for any: process creation goes through `rulebox-win32`,
  which already wraps it — if a new Win32 call is needed, add it to
  `rulebox-win32` with a `// SAFETY:` comment and say so in the report).
- TypeScript: `strict`, no `any` except `v.any()` validators that already
  exist; no `as` casts on data from the server except branded ids; no
  `dangerouslySetInnerHTML`; no `eval`/`new Function`.
- Convex: every public function through a wrapper (rule 3); `args` and
  `returns` validators on every function; errors are
  `fail(code, extra?)` from `convex/lib/errors.ts`; random values
  (tokens, salts, TOTP secrets, recovery codes) are made **only in
  actions** (`crypto.getRandomValues` in queries and mutations is a
  seeded generator, not a secure source).
- Icons: Solar only, `-linear`, active nav `-bold-duotone`
  (`import IconDevices from '~icons/solar/laptop-linear'`).
- If an API name here does not match the version you installed, use the
  equivalent and record it under "Deviations" in your report.

---

### Step 0 — Preflight (stop if anything fails)

1. Record `node --version` (≥ 22), `pnpm --version`, `rustc --version`,
   free space on D: and C:, the size of `target\`, `git status --short`,
   `git log --oneline -5`.
2. **Disk:** stop below **10 GB** free on D:. Tell the user that
   Playwright's Chromium (~200 MB, C:) and the new crates (~200 MB) will
   be downloaded or built.
3. **Phase 3 status:** read the Phase 3 row of `docs/plans/README.md`
   and `git log --oneline --grep "Phase 3 step 19"`. If Step 19 is not
   committed, note "Step 15 blocked until Phase 3 Step 19" and continue
   with the other steps; never edit `apps/staff-app` before that.
4. **Dev deployment:** `npx convex dev --once` must succeed on the
   current code. Then list what data exists:
   `npx convex data` (tables and counts) and record it. The VM from the
   Phase 2 run was reverted, so the dev deployment holds only test data.
5. Show the user Section 21 (open questions) and Section 20 (deviations)
   and wait for answers. Record them in "Updates since this plan was
   written" and in `docs/plans/README.md`.

**Done when:** all recorded, the user answered Section 21.

---

### Step 1 — Tooling and test harness

**Files:** `pnpm-workspace.yaml`, root `package.json`,
`apps/dashboard/package.json`, `convex/convex.config.ts` (new),
`convex/tsconfig.json`, `vitest.config.ts` (new, root),
`apps/dashboard/vitest.config.ts` (new), `eslint.config.js`,
`.gitignore`.

1. Add the JS packages of Section 4.15 to the catalog and to the
   packages that use them. `pnpm install`. Do not bypass
   `minimumReleaseAge`.
2. `convex/tsconfig.json`: add `"moduleResolution": "Bundler"` and
   `"skipLibCheck": true` (required by Convex Auth).
3. `convex/convex.config.ts`:

   ```ts
   import { defineApp } from "convex/server";
   import { v } from "convex/values";
   import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
   const app = defineApp({
     env: {
       RULEBOX_POLICY_KEY: v.optional(v.string()),
       RULEBOX_POLICY_KEY_NEXT: v.optional(v.string()),
       GITHUB_TOKEN: v.optional(v.string()),
       RULEBOX_ALLOW_TEST_SEED: v.optional(v.literal("1")),
     },
   });
   app.use(rateLimiter);
   export default app;
   ```

   If `defineApp` on 1.47 does not take `env` in this form, use the
   documented form and record it; the four names must stay optional.
4. Root `vitest.config.ts` with one project:
   `{ name: "convex", include: ["convex/**/*.test.ts"], environment: "edge-runtime", server: { deps: { inline: ["convex-test"] } } }`.
   Root scripts: `"test:convex": "vitest run --project convex"`.
5. `apps/dashboard/vitest.config.ts`: `environment: "jsdom"`, include
   `src/**/*.test.{ts,tsx}`; script `"test": "vitest run"`; also
   `"e2e": "playwright test"` (config comes in Step 19).
6. `eslint.config.js`: add a rule for `convex/**/*.ts` except
   `convex/lib/functions.ts`, `convex/auth.ts`, `convex/http.ts` and
   `*.test.ts`; until Step 2 also `health.ts`, `devices.ts`,
   `enrollment.ts` and `dev.ts`, which Step 2 moves onto the wrappers
   and removes from the exemption list:
   `no-restricted-imports` with `paths: [{ name: "./_generated/server", importNames: ["query", "mutation", "action"], message: "Use the wrappers in convex/lib/functions.ts" }]`
   (and the same for `"../_generated/server"`). Internal builders
   (`internalQuery`, …) stay allowed.
7. A first test `convex/health.test.ts`: `convexTest(schema, modules)`
   calls `api.health.ping` and gets `ok: true`. `modules` is
   `import.meta.glob("./**/*.*s")` in a shared `convex/test.setup.ts`
   (exported `modules`).

**Verify:** `pnpm install`; `npx convex dev --once`; `pnpm typecheck`;
`pnpm lint`; `pnpm test:convex` (1 test).

**Done when:** all pass and the lint rule fires on a scratch file that
imports `mutation` (delete the scratch file afterwards).

**Do NOT:** add Playwright browsers yet; change any agent or Staff App
file.

---

### Step 2 — Schema v2, function wrappers, errors, audit helper

**Files:** `convex/schema.ts`, `convex/lib/{functions,authz,errors,validators,audit,limits,crypto}.ts`
(new), `convex/lib/deviceAuth.ts`, `convex/devices.ts`,
`convex/enrollment.ts`, `convex/dev.ts`, tests
`convex/authz.test.ts`, `convex/audit.test.ts`.

**Existing data.** Phase 4 redefines `employees`, `apps`,
`desiredStates` and `auditLog` incompatibly. Before deploying:

1. Count rows in those four tables (`npx convex data <table>`).
2. If any has rows, **stop and ask the user** to clear exactly those
   tables in the Convex dashboard (Data → table → Clear table) for the
   **dev** deployment. Do not clear them yourself, never touch a
   production deployment.
3. The other tables are widened: new fields are `v.optional` (Section
   4.2) and helpers supply defaults (`orgSettingsOf(org)`,
   `deviceKioskEnabled(device)`).
4. `devices`: the 12 status fields move to `deviceReports`. Keep them
   in the `devices` validator as `v.optional` **for this step only**,
   marked `// removed in Step 7`; Step 7 copies them over and then
   removes them.

**Schema:** exactly Section 4.2, plus `...authTables` from
`@convex-dev/auth/server`. Put shared validators (`orgSettings`,
`webPermissions`, `webSpec`, `installSpec`, `desktopSpec`, `role`,
`installState`, `auditActorType`) in `lib/validators.ts`.

**Errors** (`lib/errors.ts`):

```ts
export type ErrorCode = "unauthenticated" | "forbidden" | "mfa_required" | "not_found" | "invalid_argument"
  | "stale_edit" | "conflict" | "last_owner" | "rate_limited" | "not_ready" | "invite_invalid"
  | "account_disabled" | "mfa_invalid_code" | "mfa_locked" | "mfa_already_enabled" | "winget_unsupported"
  | "winget_unreachable" | "webmeta_failed" | "device_rejected" | "too_large" | "has_dependents";
export type ErrorData = { code: ErrorCode; field?: string; retryAfterMs?: number; detail?: string };
export function fail(code: ErrorCode, extra?: Omit<ErrorData, "code">): never; // throws new ConvexError(data)
```

`detail` is a short fixed English text for logs and tests; the
dashboard shows its own sentence per code (Step 4).

**Wrappers** (`lib/functions.ts`, Section 4.6). Signatures:

```ts
type MemberOpts = { skipMfa?: true };                         // ONLY the five mfa:* functions pass it, with minRole "viewer"
export function memberQuery<R extends Role>(minRole: R, opts?: MemberOpts);    // returns a customQuery builder
export function memberMutation<R extends Role>(minRole: R, opts?: MemberOpts);
export function memberAction<R extends Role>(minRole: R, opts?: MemberOpts);   // runs internal.account.authorize (internalQuery) first
export const deviceQuery, deviceMutation, deviceAction;       // consume { deviceId: v.string(), deviceSecret: v.string() }
export const publicQuery, publicMutation, publicAction;        // no auth; ONLY health:ping, account:me, account:redeemReset, enrollment:enroll
// ctx additions
type MemberCtx = { member: Doc<"members">; orgId: Id<"organizations">; actor: { type: "member"; id: string; label: string } };
type DeviceCtx = { device: Doc<"devices"> };
```

`lib/authz.ts`: `requireMember(ctx, minRole)` (Section 4.6 steps 1–5),
`assertInOrg(doc, orgId)`, `roleRank(role)`, `checkRevision(doc,
expected)` (throws `stale_edit` when `(doc.revision ?? 0) !==
expected`), `nextRevision(doc)`.

**Audit** (`lib/audit.ts`): `writeAudit(ctx: MutationCtx, e: { orgId,
actor, action, targetType?, targetId?, targetLabel?, summary, eventKey? })`
with the summary rule of Section 4.11 and an `AuditAction` union type of
the exact action strings (so a typo is a type error).

**Phase 2 functions** keep working: `devices.ts` and `enrollment.ts`
move to the device / public wrappers with unchanged behaviour (their
names, args and returns stay identical; the agent must not notice).
`dev.ts` is adapted only as far as the new schema requires (it is
deleted in Step 20).

**Tests:**

- `authz.test.ts`: `unauthenticated` without identity; `forbidden` for a
  user with no member row and for a disabled member; role ranks
  (viewer < admin < owner) for a sample `memberQuery("admin")`;
  `mfa_required` for an admin without an `mfaSessions` row and success
  with one; viewer without MFA passes; `assertInOrg` answers `not_found`
  for a document of another organization; `checkRevision`.
- `authz.test.ts`, **two organizations**: a user who is an active member
  of both → `org_required` without `orgId`, the right member with it;
  `orgId` of an organization they do not belong to → `not_found`; one of
  the two memberships disabled → the other still works without `orgId`,
  the disabled one answers `forbidden` with it; a user whose every
  membership is disabled → `forbidden`; a second insert for the same
  `(orgId, userId)` returns `already_member`; `setDisabled` in one
  organization keeps the user's sessions and `mfaSessions` while another
  active membership exists and removes them when none does; the last
  Owner rule is per organization; the same public key registers in both
  organizations as two rows, and `desiredState` / `enroll` for a device
  of organization A never list organization B's keys.
- `audit.test.ts`: summary truncated to 300; a summary containing
  `$argon2…` throws in tests; `eventKey` stored.
- The identity helper `tests/convex/identity.ts` (test-only, **outside**
  `convex/` so the Convex bundler never pushes it):
  `asMember(t, { role, mfa })` inserts `users`, `authSessions`,
  `members` (and `mfaSessions` when `mfa`), returns
  `t.withIdentity({ subject: \`${userId}|${sessionId}\` })`. Confirm in
  the `@convex-dev/auth` source that `getAuthUserId` /
  `getAuthSessionId` read `subject` as `userId|sessionId`; if not, adapt
  the helper and record it.

**Verify:** `npx convex dev --once`; `pnpm typecheck`; `pnpm lint`;
`pnpm test:convex`. With the simulated agent of an enrolled test device
(if one exists in the dev deployment): heartbeat still answers `ok`.

**Done when:** all pass; the agent's Rust tests are untouched and still
pass (`cargo test -p rulebox-agent backend`).

**Do NOT:** delete data yourself; rename any Phase 2 function or
argument; add a `.filter()`.

---

### Step 3 — Member accounts: Convex Auth, invites, owner bootstrap, MFA

**PRD:** 12.3 (2FA for Owner and Admin), 15 (roles). **Files:**
`convex/auth.config.ts`, `convex/auth.ts`, `convex/http.ts`,
`convex/setup.ts`, `convex/account.ts`, `convex/mfa.ts`,
`convex/members.ts`, `convex/lib/{totp,crypto,rateLimits}.ts`,
`convex/crons.ts`, tests `convex/{auth,mfa,members}.test.ts`.

1. **Convex Auth setup** (labs.convex.dev/auth/setup/manual):
   run `npx @convex-dev/auth` **against the dev deployment** to create
   `JWT_PRIVATE_KEY` and `JWKS` (it may also write files: keep
   `auth.config.ts` and `http.ts`, then adapt them to the shapes below;
   `SITE_URL` is not needed for passwords only).

   ```ts
   // convex/auth.config.ts
   export default { providers: [{ domain: process.env.CONVEX_SITE_URL, applicationID: "convex" }] };
   // convex/http.ts
   const http = httpRouter(); auth.addHttpRoutes(http); export default http;
   // convex/auth.ts
   export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
     providers: [Password<DataModel>({ profile, validatePasswordRequirements })],
     session: { totalDurationMs: 7 * DAY, inactiveDurationMs: 12 * HOUR },
     jwt: { durationMs: 10 * MINUTE },
     signIn: { maxFailedAttempsPerHour: 10 },        // the misspelling is the real option name
     callbacks: { createOrUpdateUser, beforeSessionCreation },
   });
   ```

   - `validatePasswordRequirements(pw)`: 12–256 characters; at least
     one letter and one digit; else `fail("invalid_argument", { field: "password" })`.
   - `profile(params, ctx)`: email = trimmed lower-case `params.email`
     (1–254 chars, contains one `@`). For `params.flow === "signUp"`:
     `params.inviteCode` must hash (SHA-256) to an `invites` row of kind
     `join`, same email, `expiresAt > now`, no `usedAt`; else
     `fail("invite_invalid")`. Returns `{ email }`.
   - `createOrUpdateUser(ctx, args)`: existing user → return it.
     Otherwise find the newest unused, unexpired `join` invite for the
     email (`invites.by_email`, `.take(10)`), insert `users { email }`,
     insert `members { orgId, userId, email, role, status: "active",
     createdAt, revision: 0 }`, set `usedAt`, audit `member.joined`.
     No invite → `fail("invite_invalid")`. This is what makes open
     sign-up impossible.
   - `beforeSessionCreation(ctx, { userId })`: member missing or
     disabled → `fail("account_disabled")`.
2. **Owner bootstrap** (`setup.ts`): `createOwnerInvite` is an
   `internalAction({ orgName, email, allowAdditionalOrg?: boolean })`:
   generates a 20-character Crockford token, calls
   `internal.setup.storeOwnerInvite` (internal mutation) which refuses
   when an organization already exists and `allowAdditionalOrg` is not
   true, creates the organization with default settings
   (`DEFAULT_ORG_SETTINGS`), its `orgStats` (`deviceCount: 0`,
   `pingIntervalMs: 300000`), `orgSecrets` and a "Default" group, and
   the owner invite (24 hours). Returns `{ orgId, inviteCode }`.
   Usage, printed in the README later:
   `npx convex run setup:createOwnerInvite '{"orgName":"Acme","email":"owner@acme.test"}'`.
3. **Account** (`account.ts`): `me` (`publicQuery`): `null` when
   signed out; else `{ email, role, status, orgId, orgName, memberships: [{ orgId, orgName, role }], mfa: {
   enrolled, required, verified }, serverApiVersion }` or
   `{ noAccess: true, serverApiVersion }` when the user has no member
   row. `serverApiVersion` is the constant `SERVER_API_VERSION = 1` in
   `lib/limits.ts`, bumped whenever a public function changes
   incompatibly; the dashboard compares it with its own
   `DASHBOARD_API_VERSION` and shows "A new version of the dashboard is
   available — Reload" when they differ (edge case 14). `authorize` (internal query used by
   `memberAction`). `redeemReset` (action, public, rate limit
   `redeemCode` 10/min global): `{ email, code, newPassword }` → internal
   mutation checks a `passwordReset` invite (marks used) → then
   `modifyAccountCredentials(ctx, { provider: "password", account: { id: email, secret: newPassword } })`
   and `invalidateSessions(ctx, { userId })` from
   `@convex-dev/auth/server`; audit `member.passwordReset`. **(unverified)**
   exact helper names and whether they run in an action: check the
   package's exports; if `modifyAccountCredentials` is missing, stop and
   ask.
4. **MFA** (`mfa.ts`, `lib/totp.ts`): TOTP per RFC 6238, SHA-1, 6
   digits, 30 s, window ±1 step, HMAC from `@noble/hashes`.
   - `status` (member query, any role, MFA not required).
   - `beginSetup` (action): 20 random bytes → base32 secret stored as
     `totpPending`; returns `{ secret, uri }` with
     `otpauth://totp/Rulebox:<email>?secret=<s>&issuer=Rulebox&algorithm=SHA1&digits=6&period=30`.
     Already enrolled → `mfa_already_enabled`.
   - `confirmSetup` (action, `{ code }`): makes 10 recovery codes
     (`XXXX-XXXX`, Crockford), calls an internal mutation that verifies
     `code` against `totpPending`, moves it to `totpSecret`, stores the
     SHA-256 of each recovery code, inserts `mfaSessions` for the
     current session, audits `member.mfaEnabled`. Returns the codes once.
   - `verify` (mutation, `{ code }`): locked (`totpLockedUntil > now`)
     → `mfa_locked` with `retryAfterMs`; a code whose step is ≤
     `lastTotpStep` is refused (replay); 5 consecutive failures → locked
     15 minutes; success → `lastTotpStep`, reset failures, insert
     `mfaSessions`.
   - `useRecoveryCode` (mutation): normalize (upper-case, strip spaces
     and dashes, re-insert dash), compare hashes, remove the used hash,
     insert `mfaSessions`, audit. Same lockout counter.
5. **Members** (`members.ts`, Owner unless noted): `list` (viewer:
   members of the org, `.take(200)`, emails and roles, never secrets);
   `invite` (action: `{ email, role }`, role ≠ owner unless caller is
   owner, 7-day code, returns the code once, audit `member.invited`);
   `revokeInvite`; `changeRole` (`last_owner`, no self-change);
   `setDisabled` (only when the user has no other active membership:
   calls `invalidateSessions` and deletes the user's
   `mfaSessions`, `last_owner`); `createResetCode` (action, 24-hour
   `passwordReset` code shown once); `resetMfa` (clears TOTP fields and
   `mfaSessions`, audit `member.mfaReset`). CLI fallback when the only
   Owner lost their authenticator: `maintenance:resetMfaByEmail`
   (internal mutation).
6. **Crons** (`crons.ts`): `crons.daily("cleanup", { hourUTC: 3, minuteUTC: 0 }, internal.maintenance.daily)`.
   `maintenance.daily` (internal mutation, batched with `.take(500)` per
   table and rescheduling itself while more remains): delete
   `mfaSessions` whose `authSessions` row is gone; delete invites
   expired more than 30 days ago; delete audit rows older than 365 days
   (`auditLog.by_at`).

**Tests** (`auth.test.ts`, `mfa.test.ts`, `members.test.ts`):

1. `createOwnerInvite` twice → the second refuses.
2. `createOrUpdateUser` without an invite → `invite_invalid`; with an
   expired, used or other-email invite → `invite_invalid`; with a valid
   one → member with the invite's role, invite marked used.
3. `beforeSessionCreation` refuses a disabled member.
4. TOTP: the RFC 6238 SHA-1 test vectors (seed
   `12345678901234567890`, times 59 → `287082`, 1111111109 → `081804`,
   1234567890 → `005924`, 2000000000 → `279037`, using the last 6
   digits) pass; window ±1 accepted, ±2 refused; replay refused; 5
   failures lock; recovery code works once.
5. Members: admin cannot invite an owner; last owner cannot be demoted
   or disabled; self role change refused; disabled member's sessions
   invalidated (assert `invalidateSessions` called through a spy or the
   `authSessions` rows gone).
6. `me` for a user without member row → `{ noAccess: true }`.

**Verify:** `npx convex dev --once`; typecheck; lint;
`pnpm test:convex`; then create the real first owner on the dev
deployment with `npx convex run setup:createOwnerInvite ...` and keep the
code for Step 4 (do not commit it).

**Done when:** all pass and the dev deployment has one organization with
an unused owner invite.

**Do NOT:** enable any other Convex Auth provider; store TOTP secrets in
`users`; return a secret from a query; skip the MFA rule for admins in
any wrapper.

---

### Step 4 — Dashboard foundation

**Files:** `apps/dashboard/src/main.tsx`, `App.tsx`, `app/*`,
`components/*`, `screens/{SignIn,Join,Reset,Mfa,Overview,NotFound}.tsx`
(Overview is a placeholder until Step 17), `lib/{strings,format,errors,validate,useNow,motion}.ts`,
`public/_headers`, `vercel.json`, `index.html`; `packages/ui`
additions; tests in `src/**/*.test.tsx`.

1. `main.tsx`: `ConvexReactClient(VITE_CONVEX_URL)` inside
   `ConvexAuthProvider` (from `@convex-dev/auth/react`), then
   `BrowserRouter`, then `App`. Keep the missing-URL message.
2. `App.tsx`: routes of Section 4.13. Public: `/sign-in`, `/join`,
   `/reset`. Signed-in but MFA allowed: `/mfa`. Everything else under
   `<Route element={<RequireMember />}><Route element={<Layout />}>…`.
3. `RequireMember`: `useConvexAuth()`; while loading → full-page
   `Spinner`; not authenticated → `<Navigate to={"/sign-in?next=" + encodeURIComponent(path)} />`;
   `account:me` → `noAccess` → page "This account has no access to
   Rulebox" with Sign out; `mfa.required && !mfa.verified` →
   `/mfa?next=…`; else `<Outlet context={me} />`. `next` is accepted only
   when it starts with `/` and not `//` (open-redirect guard; unit test).
4. `Layout`: left navigation (Overview, Devices, Groups, Employees,
   Apps, File types, Enrollment, Audit log, Settings) with Solar
   `-linear` icons and `-bold-duotone` for the active item; top bar with
   organization name, connection banner slot, account menu (email,
   role, Sign out). At widths below 768 px the navigation becomes a menu
   button that opens a `Dialog`. Main content max width 1200 px.
5. **Screens:** SignIn (email, password, "Sign in"; errors: wrong
   credentials "Email or password is not right.", rate limited "Too many
   attempts. Try again in an hour or ask an Owner for a reset code.");
   Join (invite code, email, password twice, calls
   `signIn("password", formData)` with `flow: "signUp"` and
   `inviteCode`); Reset (code, email, password twice →
   `account:redeemReset`, then to `/sign-in`); Mfa (setup or verify,
   recovery code link; after setup shows the 10 recovery codes with
   "I saved them" before continuing; QR drawn from the `otpauth://` URI
   with `uqr` 0.1.3 `encode()` into `<rect>` elements, plus the secret
   in groups of four for manual entry).
6. **Shared components** (`apps/dashboard/src/components/`):
   `DataTable` (semantic `<table>`, sticky header, row link via an
   explicit "Open" link or the name cell link, never a clickable `<tr>`
   only), `LoadMore`, `StatusDot` (colour **and** text), `Field` (label,
   input slot, hint, error with `aria-describedby`), `ConfirmDialog`
   (typed confirmation for destructive actions: the user types the
   name), `EmptyState`, `PageHeader`, `CopyField` (read-only input +
   Copy button; `navigator.clipboard.writeText` with a select-all
   fallback when `!window.isSecureContext`), `Skeleton`, `RoleGate`
   (`minRole` → children or nothing), `Toasts` (a `role="status"`
   live region mounted once in `Layout`).
7. **`packages/ui` additions** (generic only): `Select` (native
   `<select>` styled), `Textarea`, `Checkbox`, table styles in
   `components.css` (`.rb-table`), `Badge` if `Pill` is not enough
   (prefer `Pill`). Add them to the Gallery.
8. **Strings** (`lib/strings.ts`): every user-visible sentence as a
   typed constant object (functions for interpolation, `Intl.PluralRules`
   for counts). `lib/errors.ts`: `messageFor(error: unknown): string`
   maps every `ErrorCode` to a sentence; unknown errors →
   "Something went wrong. Try again."
9. **Format** (`lib/format.ts`): `formatDateTime`, `formatRelative`
   (`Intl.RelativeTimeFormat`, "2 minutes ago"), `formatBytes`,
   `formatGb`, cached `Intl` instances, browser locale.
10. **Motion** (`lib/motion.ts`): `useMotionLevel()` (`"fade"` when
    `prefers-reduced-motion: reduce`), `enter(el)` / `exit(el)` as in
    Phase 3; used by `Layout` for page entry and by dialogs and toasts.
11. **Security headers**: `public/_headers` (Cloudflare Pages) and
    `vercel.json` with:
    `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.convex.cloud; font-src 'self'; connect-src 'self' https://*.convex.cloud wss://*.convex.cloud https://*.convex.site; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`,
    `X-Content-Type-Options: nosniff`,
    `Referrer-Policy: strict-origin-when-cross-origin`,
    `X-Frame-Options: DENY`,
    `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`.
    `vercel.json` also has `"rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]`.
    No `404.html` (Cloudflare Pages then serves the SPA for any path).
    `'unsafe-inline'` in `style-src` is required by React `style` props
    and GSAP; scripts stay strict. Add the same policy as a `<meta>` in
    `index.html` **without** `frame-ancestors` (not allowed in meta) so
    `vite preview` is covered too.

**Tests (Vitest + Testing Library, Convex hooks mocked):**
`RequireMember` redirects (signed out, no access, MFA needed, OK);
`next` guard rejects `//evil.test` and `https://evil.test`;
`messageFor` covers every `ErrorCode` (exhaustive switch, a test
iterates the union through a const list); `CopyField` fallback; SignIn
shows the rate-limit sentence; `Layout` marks the active nav item with
`aria-current="page"`.

**Verify:** typecheck, lint, test; `pnpm dev:dashboard`; join with the
owner invite of Step 3, set up TOTP with a real authenticator app (or
compute codes with a small script from the shown secret), sign out, sign
in, MFA prompt, recovery code once. Screenshots: sign-in, join, MFA
setup, MFA verify, layout with placeholder overview — light, dark,
narrow.

**Done when:** the full sign-in and MFA loop works against the dev
deployment, tests pass, screenshots taken.

**Do NOT:** store anything about the session yourself (Convex Auth
owns `localStorage`); add a UI library, a form library or a state
library; load fonts or icons from the network.

---

### Step 5 — Organization settings, exit PIN, groups

**PRD:** 4.7, 12.4, 13.6 #6, 3.1 (groups). **Files:**
`convex/settings.ts`, `convex/groups.ts`, `convex/lib/{hotkey,argon,publish}.ts`
(`publish.ts` only the `requestPublish` function with an empty queue
consumer for now), `convex/publish.ts` (a stub `run` that only clears
the queue until Step 8), `crates/rulebox-ipc/tests/vectors/hotkeys.json`
(new) and a Rust test that reads it, dashboard `screens/Settings.tsx`
(Organization and Admin exit tabs), `Groups.tsx`, `GroupDetail.tsx`
(apps/devices/employees sections show "Coming in a later step" until
Steps 7, 10, 11), tests `convex/{settings,groups}.test.ts`.

1. `settings:get` (viewer): `{ name, revision, settings, exitPin: {
   set: boolean } }` — never the hash.
2. `settings:update` (admin, `{ expectedRevision, name, settings }`):
   validates every field (Section 4.10), `stale_edit`, bumps revision,
   audit `org.settingsChanged` with a summary listing changed field
   names, `requestPublish(org)`.
3. `settings:setExitPin` (admin action, `{ pin }`): 6–12 digits and the
   weak-PIN rules → `invalid_argument`; `hashSecret(pin)` from
   `lib/argon.ts` (hash-wasm `argon2id` with `memorySize: 19456,
   iterations: 2, parallelism: 1, hashLength: 32`, 16 random salt bytes,
   `outputType: "encoded"`); internal mutation stores it in `orgSecrets`,
   audits `org.exitPinSet` (no PIN, no hash in the summary),
   republishes. `settings:clearExitPin` (admin mutation) removes it,
   audit `org.exitPinCleared`.
4. **Argon2 compatibility vector:** add
   `crates/rulebox-policy/tests/vectors/argon2id.json` =
   `[{ "secret": "246813", "phc": "<hash made by lib/argon.ts>" }, …3 entries]`
   generated once with `node scripts/gen-argon-vectors.mjs` (uses
   hash-wasm); a Rust test in `apps/agent` (`kdf.rs` tests) verifies
   each with `kdf::verify_secret` → `true` and `kdf::check_hash` → `Ok`,
   and a TS test re-verifies them with `argon2Verify`.
5. **Hotkey** (`lib/hotkey.ts`): `parseHotkey(text) → { ok: true,
   canonical } | { ok: false, reason }` following
   `rulebox_ipc::hotkey::parse`. Vectors: copy every accepted and refused
   example from the Rust tests into `hotkeys.json`
   (`{ "accept": [["ctrl+shift+f12","Ctrl+Shift+F12"], …], "reject": ["Alt+Tab", …] }`);
   the Rust test asserts the crate agrees with the file, the TS test
   asserts `parseHotkey` agrees.
6. **Groups** (`groups.ts`): `list` (viewer: groups with counts —
   devices via `devices.by_group` `.take(501)` length, employees via
   `groupMembers.by_group` `.take(501)`; shown as "500+" above 500),
   `get` (viewer: group + assigned apps, `.take(150)`), `create` (admin,
   unique name per org → `conflict`), `rename`, `delete` (refused with
   `has_dependents` while devices, members, assignments or enrollment
   codes reference it; the dialog lists what to move first). Audit each.
7. Dashboard: Settings → Organization tab (form with revision
   handling) and Admin exit tab (enabled switch, key combination text
   field with live validation and "Use default", PIN dialog: two fields,
   digits only, `inputMode="numeric"`, `autocomplete="off"`, never shown
   again; "Clear PIN" with confirmation). Groups list and detail.

**Tests:** settings validation (every bound), stale edit, PIN rules
(5 digits refused, 13 refused, `111111` and `123456` refused, `246813`
accepted), `settings:get` never contains `$argon2`, groups unique name,
delete refused with dependents, viewer cannot write (`forbidden`),
cross-org group id → `not_found`, `requestPublish` merges targets
(org wins; lists capped at 500 → `allDevices`).

**Verify:** test commands; `cargo test -p rulebox-ipc hotkey`;
`cargo test -p rulebox-agent kdf`; run the dashboard, screenshots of
both settings tabs and the group screens.

**Done when:** all pass; the Argon2 vectors made by hash-wasm verify in
Rust.

**Do NOT:** hash the PIN in the browser; send the PIN to any query; let
the hotkey grammar differ from the Rust crate.

---

### Step 6 — Enrollment codes

**PRD:** 9.1, 12.3 (short-lived, limited-use, revocable), 15.
**Files:** `convex/enrollmentCodes.ts`, `screens/Enrollment.tsx`, tests
`convex/enrollmentCodes.test.ts`.

1. `create` (admin action, `{ groupId, uses (1–100), ttlMinutes (15–10080), label? }`):
   token as in Phase 2 (20 Crockford characters, 100 bits) made in the
   action; internal mutation checks the group is in the org, stores the
   hash with `createdBy`, audits `enrollment.codeCreated`; the code is
   `RBX1.` + base64url(`<CONVEX_CLOUD_URL>#<token>`) exactly as
   `dev.ts` builds it (move `base64UrlEncode` and
   `assertAgentAcceptableUrl` to `lib/crypto.ts` and reuse). Returns
   `{ code, expiresAt }` once.
2. `list` (viewer, paginated by `by_org_created`, newest first): label,
   group name, uses left, expiry, state (`active` / `usedUp` / `expired`
   / `revoked`, computed from the row and a client-passed `nowMs`
   rounded to the minute — never `Date.now()` in the query), creator
   email. Never the hash.
3. `revoke` (admin): sets `revoked`, audit.
4. Screen: form, the one-time code panel ("This code is shown only
   now. Enter it on the PC: `rulebox-agent enroll <code>`." with
   `CopyField`), list with Revoke.

**Tests:** code format round-trips through the agent's parser rules
(same checks as `enroll_code.rs`: prefix, base64url, `https://` URL, 20
Crockford chars); viewer cannot create; group of another org →
`not_found`; `list` contains no `tokenHash`; revoked code refused by
`enroll`.

**Verify:** test commands; screenshots of the form, the one-time code
panel and the list. The real end-to-end check (a dashboard code enrolls
a simulated agent) happens in Step 9, after signing exists.

**Done when:** tests pass and the screens work against the dev
deployment.

**Do NOT:** show a code a second time; log it.

---

### Step 7 — Devices: reports split, heartbeat scaling, fleet screens

**PRD:** 3.1, 11, 11.1 rules 4 and 5, 13.6 #4. **Files:**
`convex/schema.ts`, `convex/devices.ts`, `convex/enrollment.ts`,
`convex/fleet.ts`, `convex/lib/heartbeat.ts`, `convex/maintenance.ts`
(one-off copy), `screens/Devices.tsx`, `DeviceDetail.tsx`,
`lib/online.ts`, tests `convex/{devices,fleet}.test.ts`.

1. **Move reported fields.** Internal mutation
   `maintenance:moveDeviceReports` (paginated, 100 per run, reschedules
   itself) copies the 12 fields of every `devices` row into a new
   `deviceReports` row and unsets them on `devices`. Run it once with
   `npx convex run maintenance:moveDeviceReports '{}'`; then remove the
   12 fields from the `devices` validator and deploy.
2. **`heartbeat`** writes status into `deviceReports` (insert on first,
   patch only when different, as today), sets `deviceStatus.orgId`
   when missing, reads `orgStats.pingIntervalMs` for `nextPingInMs`, and
   returns `rotateCredential: device.rotateCredential === true`.
   `statusValidator` gains `trustedKeyIds: v.optional(v.union(v.array(v.string()), v.null()))`
   and `restartPending: v.optional(v.union(v.boolean(), v.null()))`.
   `outOfSupport` is computed on write: build < 19045, or Windows 11
   build 26100 (24H2) Home/Pro editions after 2026-10-13, or Windows 10
   any edition (support ended 2025-10-14); the rule lives in
   `lib/lifecycle.ts` as a dated table so it can be updated
   (`{ build: 26100, editions: ["Core","Professional"], endMs: Date.UTC(2026,9,13) }`, …).
3. **`orgStats`**: `enroll` increments `deviceCount` and sets
   `pingIntervalMs = pingIntervalFor(count)`; `fleet:remove` decrements.
4. **`fleet.ts`** (viewer queries, admin mutations):
   - `list({ paginationOpts, groupId? })`: page of `devices` (by
     `by_group` when `groupId`, else `by_org`, `order("desc")`), each
     joined with its `deviceReports` (`.unique()`), group name (from a
     per-call map of `groups.by_org` `.take(500)`), and the newest
     `desiredStates` version (`.first()`), returning exactly the columns
     of Section 4.13. **Not** `deviceStatus`.
   - `liveStatus({ deviceIds })` (≤ 100 ids, each `assertInOrg`):
     `{ pingIntervalMs, items: [{ deviceId, lastSeenAt }] }`.
   - `search({ text })`: `search_name` with `orgId` filter, `.take(50)`.
   - `get({ deviceId })`: device, report, group, the last 5 document
     versions (`version`, `createdAt`, `reason`; not the payload), and
     flags (`noGroup`, `revoked`, `rotateCredential`).
   - `rename`, `move({ groupId })`, `setKiosk({ enabled })`, `revoke`,
     `requestCredentialRotation`, `remove` (only when revoked; deletes
     `deviceStatus`, `deviceReports`, `installResults`, `desiredStates`
     of the device in batches through a scheduled internal mutation,
     then the device; decrements `orgStats`). Each with
     `expectedRevision`, audit, `requestPublish(device)` where it changes
     the document (rename does not: the name is not in the document).
5. **Dashboard:** Devices list with group filter (a `Select`), search box
   (debounced 250 ms; switches to `fleet:search` results), live dots
   from `fleet:liveStatus` of the loaded ids, "Last seen" from
   `formatRelative`. Device detail as in Section 4.13 (install section
   empty until Step 17). Revoke and Remove use `ConfirmDialog` with the
   device name typed. A device with no group shows a warning: "No
   employee can sign in on this PC until it is in a group."

**Tests:** heartbeat writes `deviceReports` only on change and never
`devices`; `desiredState` does not re-run because of a status change
(assert by reading: it does not touch `deviceReports` — a test that
fails if `desiredState` reads that table, using a convex-test spy on
`ctx.db.query` table names); `pingIntervalFor` table boundaries (25 →
5 min, 26 → 15 min, 100, 101, 300, 301); `outOfSupport` cases;
`liveStatus` refuses 101 ids and foreign ids; `remove` refused unless
revoked; viewer cannot rename.

**Verify:** test commands; deploy; with a simulated agent enrolled
earlier (if any) the dashboard shows it online with a fresh "Last seen";
screenshots of list (with 0 and with ≥ 1 device) and detail.

**Done when:** all pass; `devices` has no status fields left in the
dev deployment.

**Do NOT:** read `deviceStatus` in `fleet:list`; call `Date.now()` in a
query; delete a non-revoked device.

---

### Step 8 — Signing keys and the publisher

**PRD:** 10, 12.3, Decision 15. **Files:** `scripts/policy-key.mjs`,
`scripts/gen-policy-vectors.mjs` (new), `convex/lib/{signing,desired,publish}.ts`,
`convex/publish.ts`, `convex/keys.ts`, `convex/devices.ts`
(`desiredState`), `convex/enrollment.ts`,
`crates/rulebox-policy/tests/vectors/signed-v2.json` (new),
`screens/Settings.tsx` (Signing tab), tests
`convex/{signing,desired,publish,keys}.test.ts`.

1. **`lib/signing.ts`:**

   ```ts
   export function keyIdOf(publicKey: Uint8Array): string;                    // sha256 → first 16 hex
   export function loadSigningKey(which: "active" | "next"): { seed: Uint8Array; publicKey: Uint8Array; keyId: string } | null;
   export function signPayload(payload: string, seed: Uint8Array): string;    // base64 of ed.sign(utf8(payload), seed)
   export function verifyPayload(payload: string, signatureB64: string, publicKey: Uint8Array): boolean;
   export function endorsementMessage(keyId: string, publicKeyB64: string): string; // "rulebox.key-endorsement/1\n<keyId>\n<pub>"
   ```

   Uses `@noble/ed25519` with `ed.hashes.sha512 = sha512` set once at
   module load. A malformed env value (not base64 of 32 bytes) returns
   `null` and the caller treats it as "missing".
2. **`lib/desired.ts`:** `buildDeviceDoc(input: BuildInput): DesiredDocV2`
   and `buildPayload({ keyId, orgId, deviceId, version, issuedAtMs, doc }): string`
   exactly as Section 4.4 (key order, sorting). `BuildInput` is a plain
   object (org, settings, pinHash, group, assignments, apps, employees,
   employeeApps, fileHandlers, device) so the builder is testable without
   a database. Until Step 10 the catalogue holds only `"files"`; until
   Step 11 `employees` is `{}`.
3. **`publish.ts` `run`** as Section 4.4 (batch of 25, per-group cache,
   skip unchanged, prune to 5, missing-key handling).
4. **`desiredState`** returns the envelope of Section 5.1, `keys` = every
   `policyKeys` row of the device's organization, oldest first (`by_org_status` for each of the three
   statuses, `.take(20)` each, merged and sorted by `createdAt`) and
   `retiredKeyIds`. An old
   row without `payload` is never returned (there are none after Step 2's
   clear).
5. **`enroll`**: refuses with `not_ready` when no `active` key exists;
   returns the organization's `policyKeys`; requests a publish for the new device;
   increments `orgStats` (Step 7). Rate limit `enrollGlobal`.
6. **`keys.ts`** (Owner unless noted): `status` (viewer: active / next
   / retired rows with key id and fingerprint = key id in groups of 4);
   `trustProgress({ paginationOpts })` (viewer: one page of up to 200
   non-revoked devices of the org via `devices.by_org`, joined with
   `deviceReports`, returning `{ page: { total, trustNext }, isDone,
   continueCursor }`; the Signing tab loads pages one after another and
   sums them, only while a `next` key exists); `registerActive` (action: derives the key from
   `RULEBOX_POLICY_KEY`; refuses when an active row exists unless
   `force` and the active row's public key differs from the env; inserts
   the row; audit; publish all); `prepareRotation`; `finishRotation`
   (Section 4.5).
7. **Vectors:** `scripts/gen-policy-vectors.mjs` builds a fixed input
   (two apps, one employee, PIN hash from Step 5's vector, fixed ids and
   `issuedAtMs`), signs with the RFC 8032 test-1 seed
   (`9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60`),
   and writes `signed-v2.json` = `{ publicKey, keyId, payload, signature, version }`.
   `desired.test.ts` asserts `buildPayload(buildDeviceDoc(fixedInput))`
   equals the vector's `payload` byte for byte and that `signPayload`
   gives its `signature`. Commit the vector; the Rust side reads the same
   file in Step 9.
8. **Dashboard Signing tab:** status, Register key (with the exact CLI
   lines of Section 4.5 to copy), Prepare / Finish rotation with the
   trust counts, the "key lost" and "key stolen" instructions.

**Tests:** RFC 8032 test 1 (`ed.sign` of the empty message gives the
published signature); vector equality; `verifyPayload` false for one
flipped byte in payload or signature; `buildDeviceDoc` ordering and
sorting (shuffle the input arrays, same bytes); `adminExit` cases of
Section 4.4 rule 2; publish: unchanged content writes nothing, changed
content writes `version + 1`, pruning keeps 5, revoked devices skipped,
batch of 25 reschedules, missing key writes nothing and audits once,
oversize payload audits `policy.publishFailed`; `desiredState` never
reads `deviceStatus` / `deviceReports`; `enroll` `not_ready` without a
key; `registerActive` refuses a second active key; endorsement verifies.

**Verify:** test commands; generate a dev key
(`node scripts/policy-key.mjs generate --out .tmp/policy-key.seed`),
set it on the **dev** deployment, Register key in the dashboard, delete
the seed file; `npx convex data desiredStates` shows signed rows for
existing devices. Screenshot of the Signing tab.

**Done when:** all pass; the vector file is committed; the dev
deployment publishes signed documents.

**Do NOT:** sign in an action and pass the signature to a mutation (the
payload and its row must be written in the same transaction); put the
seed anywhere but the env var; add an "unsigned" mode.

---

### Step 9 — Agent: verify signed documents, key trust

**PRD:** 10, 12.3, 13.5 (clock drift). **Files:**
`crates/rulebox-policy/{Cargo.toml,src/lib.rs,src/envelope.rs}`,
`apps/agent/src/{state.rs,agent.rs,trust.rs (new),enroll.rs,backend/mod.rs,backend/convex.rs,backend/task.rs,ipc_admin.rs,cli.rs}`,
`crates/rulebox-ipc/src/admin.rs` (new admin method), root
`Cargo.toml`.

1. **`rulebox-policy/src/envelope.rs`** (no I/O, fully unit-tested):

   ```rust
   pub const PAYLOAD_FORMAT: &str = "rulebox.desired/2";
   #[derive(Clone, PartialEq, Eq, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
   pub struct TrustedKey { pub key_id: String, pub public_key: String /* base64, 32 bytes */ }
   #[derive(Clone, PartialEq, Eq, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
   pub struct SignedEnvelope { pub version: u64, pub payload: String, pub signature: String, pub key_id: String }
   #[derive(Clone, Debug, PartialEq, Deserialize)] #[serde(rename_all = "camelCase")]
   pub struct Payload { pub format: String, pub key_id: String, pub org_id: String, pub device_id: String,
                        pub version: u64, pub issued_at_ms: u64, pub doc: serde_json::Value }
   pub struct PublishedKey { pub key_id: String, pub public_key: String, pub endorsement: Option<Endorsement> }
   pub struct Endorsement { pub by_key_id: String, pub signature: String }
   #[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
   pub enum VerifyError { UnknownKey, BadEncoding, BadSignature, BadFormat, KeyIdMismatch, WrongOrg, WrongDevice, VersionMismatch }
   pub fn key_id_of(public_key: &[u8; 32]) -> String;
   pub fn verify_envelope(env: &SignedEnvelope, trusted: &[TrustedKey], org_id: &str, device_id: &str)
       -> Result<Payload, VerifyError>;
   pub fn verify_endorsement(key: &PublishedKey, trusted: &[TrustedKey]) -> Result<TrustedKey, VerifyError>;
   ```

   `verify_envelope` order: find `key_id` among `trusted` (else
   `UnknownKey`); decode key (base64, 32 bytes, `VerifyingKey::from_bytes`,
   refuse `is_weak()`) and signature (base64, 64 bytes) (else
   `BadEncoding`); `verify_strict(payload.as_bytes(), &sig)` (else
   `BadSignature`); **only then** `serde_json::from_str::<Payload>`
   (else `BadFormat`); `format == PAYLOAD_FORMAT`; `payload.key_id ==
   env.key_id` (else `KeyIdMismatch`); org, device; `payload.version ==
   env.version`. `Debug` of `SignedEnvelope` / `Payload` never prints
   `doc` (it holds the PIN hash).
2. **Agent state:** `AgentState.trusted_keys: Vec<TrustedKey>` and
   `AgentState.last_doc_key_id: Option<String>`, both
   `#[serde(default)]`. `enroll.rs` saves `policyKeys` from the enroll
   answer (parse in `convex.rs` `parse_enroll_response`; an answer without
   `policyKeys` → `Protocol` error, which the user sees as
   `backend_rejected`). The admin-pipe enroll answer maps the server code
   `not_ready` to the reason `backend_not_ready` with the message "The
   organization has no signing key yet. Register one in the dashboard
   (Settings → Signing)."
3. **Subscription parsing:** `DesiredFetch` becomes

   ```rust
   pub enum DesiredFetch {
       Ok { desired: Option<SignedEnvelope>, keys: Vec<PublishedKey>, retired_key_ids: Vec<String> },
       Revoked, UnknownDevice,
   }
   ```

   `Debug` stays redacted.
4. **`backend/task.rs`:** on `Ok`:
   1. `trust::update(&mut state, &keys, &retired)` (in `trust.rs`):
      walk `keys` in the given order (oldest first) and add every key
      whose endorsement verifies against a key trusted at that moment
      (so chains work); drop a retired key only when
      `last_doc_key_id` is set and differs from it; never drop the last
      key; save `agent-state.json` when changed.
   2. `desired = None` → as before (enrollment default).
   3. `verify_envelope` with the device's org and id. `Err(e)` → log
      `policy_rejected` with the `VerifyError` name and version, set
      `sync.problem = Some("desired_state_untrusted")` (reported as
      `kioskError`), keep the previous state. `Ok(payload)` → the
      existing `DesiredSync::accept(version, payload.doc, …)`, then set
      `last_doc_key_id`.
   4. An equal version with **different** content is now refused (a
      signed version never changes) and logged; identical content stays
      `Unchanged`.
   5. Remove the startup warning "policy signatures are not verified
      until Phase 4".
5. **Cache:** `CachedDesired` gains `payload: Option<String>`,
   `key_id: Option<String>` (with the existing `signature`). It stores
   the envelope as received. At start `load_cached` re-verifies; a cache
   without `payload` (Phase 2 format) or failing verification is
   ignored with an error log, and the effective state falls back to the
   Phase 2 rules (enrollment default).
6. **No trusted key** (a device enrolled before Phase 4): every document
   fails `UnknownKey`; the status says `desired_state_untrusted`; the
   dashboard shows "Re-enroll this PC" on that device. No trust on first
   use.
7. **`rulebox-agent trust-key <base64-public-key>`** (new CLI command and
   admin-pipe method `admin.trustKey { publicKey }`, elevated
   administrator only, same checks as `admin.enroll`): adds the key,
   prints its key id. For the "key lost" recovery (Section 4.5).
8. **Status:** `StatusReport` gains `trusted_key_ids: Option<Vec<String>>`
   (sorted) and `restart_pending: Option<bool>` (always `None` until
   Step 14); update `STATUS_KEYS` to the 14 keys of the server.

**Tests** (`rulebox-policy`): `vector_from_convex_verifies` (reads
`tests/vectors/signed-v2.json`); `rfc8032_test1`; `flipped_payload_byte_fails`;
`flipped_signature_byte_fails`; `unknown_key_id`; `key_id_mismatch_inside_payload`;
`wrong_device`; `wrong_org`; `version_mismatch`; `weak_key_refused`;
`endorsement_round_trip`; `debug_hides_doc`.
**Tests** (agent, `FakeBackend`): `signed_doc_is_applied`;
`forged_doc_keeps_previous_state_and_reports_untrusted`;
`replayed_doc_of_other_device_is_refused`;
`rolled_back_version_is_ignored` (lower version, validly signed);
`same_version_different_content_is_refused`;
`endorsed_next_key_becomes_trusted_and_is_reported`;
`retired_key_is_dropped_only_after_a_newer_signed_doc`;
`last_key_is_never_dropped`; `phase2_cache_is_ignored`;
`cache_is_reverified_at_start`; `enroll_saves_policy_keys`;
`enroll_not_ready_maps_to_backend_not_ready`; `status_keys_match_server`.

**Verify:** `cargo clippy -p rulebox-policy -p rulebox-agent --all-targets -- -D warnings`;
`cargo test -p rulebox-policy -p rulebox-agent`. Then on the dev machine
(simulate mode only):

```powershell
cargo run -p rulebox-agent -- run --console --simulate           # terminal 1
cargo run -p rulebox-agent -- enroll "<code from the dashboard>" --simulate   # terminal 2
cargo run -p rulebox-agent -- status --simulate
```

In the dashboard switch the device's kiosk off and on; the agent log
shows each new version as accepted within seconds, without polling.

**Done when:** all pass and the simulated agent applies dashboard
changes with verified signatures.

**Do NOT:** parse the payload before the signature check; trust a key
from an unsigned source after enrollment; run `enroll` without
`--simulate`.

---

### Step 10 — Apps, winget, web metadata, assignments, file types

**PRD:** 6, 6.1, 6.2, 6.3, 7.2, 13.6 #1. **Files:**
`crates/rulebox-policy/src/catalog.rs` (new, ts-rs export),
`packages/types/src/index.ts`, `convex/apps.ts`, `convex/fileHandlers.ts`,
`convex/groups.ts` (assignments), `convex/lib/{winget,webmeta,pathRules,denyList,desired}.ts`,
`convex/testdata/winget/` (three manifests: one MSI with ProductCode, e.g.
`7zip.7zip`; one Inno or NSIS exe; one with only `Scope: user` entries),
`screens/{Apps,AppEdit,FileTypes,GroupDetail}.tsx`, tests
`convex/{apps,winget,webmeta,fileHandlers,pathRules}.test.ts`.

1. **Rust types** of Section 4.8 in `catalog.rs`
   (`CatalogApp`, `CatalogKind`, `BuiltinSpec`, `WebSpec`,
   `DesktopSpec`, `InstallSpec`, `InstallKind`, `IconRef`, `Audience`),
   with `#[ts(export)]` and the unknown-value macro. Generate with
   `cargo test -p rulebox-policy export_bindings` (cheap; do **not** run
   the full `pnpm gen:types`, which compiles the Staff App) and add the
   files to `packages/types/src/index.ts`. Add a golden test:
   `tests/vectors/catalog-v2.json` (written by
   `scripts/gen-policy-vectors.mjs`, same fixed input as Step 8) parses
   into `Vec<CatalogApp>` and serializes back to the same JSON.
2. **`apps.ts`:** `list({ paginationOpts, archived })`, `get({ appId })`
   (app, assignments with group names, file types, direct employees count
   — `.take(1001)`), `createWeb`, `createDesktop`, `update`
   (`expectedRevision`), `setArchived`, `remove` (only archived and not
   assigned anywhere and no file type → else `has_dependents`; deletes
   its `installResults` in batches), `retry` (bumps `revision`,
   republishes: the agent's attempt counter resets on a new revision),
   `resolveWinget` (action), `fetchWebMeta` (action), `saveIcon`
   (action: stores a ≤ 32 KiB PNG from `fetchWebMeta` in Convex file
   storage, records `sha256`).
3. **Validation** (server, mirrored in `lib/validate.ts` on the client):
   - Web: `url` `https://`, host not an IP literal in a private,
     loopback or link-local range and not `localhost`; `allowedDomains`
     ≤ 20 entries, each a host name or `*.host` (one leading wildcard),
     lower-case, no scheme, no path; the URL's host is added
     automatically. Permissions = `DEFAULT_WEB_PERMISSIONS` (not editable
     in Phase 4).
   - Desktop: `exe` and arguments per "Path templates"; `install` per
     source; `sha256` 64 hex; `url` `https://`; `resetFolders` per
     Section 4.12; `portable` requires `exe` to start with
     `{RuleboxApps}\<appId>\` — since the id is not known before insert,
     the form uses `{RuleboxApps}\{AppId}\<name>.exe` and the server
     replaces `{AppId}` after insert.
4. **`resolveWinget`**: Section 4.8. Errors: GitHub not reachable or
   rate-limited → `winget_unreachable` (message suggests `GITHUB_TOKEN`);
   no usable installer → `winget_unsupported` with the reason. The
   result fills the form; the admin still enters the exe path ("Where is
   the program after install?") with a hint built from the package's
   `DefaultInstallLocation` when present.
5. **`fetchWebMeta`** (`lib/webmeta.ts`): fetch the page (≤ 1 MiB,
   10 s, `redirect: "follow"`, final URL must still be `https://`),
   find `<link rel="manifest">` with a simple, tested regex scan (no DOM
   parser), fetch the manifest (≤ 256 KiB), take `name` / `short_name`,
   `theme_color` → `hue` (hex → HSL hue, rounded), and the best icon
   (PNG, declared size closest to 128, ≥ 48), else `apple-touch-icon`,
   else `/favicon.png`; download ≤ 32 KiB and confirm the PNG signature;
   else no icon (the Staff App draws a letter tile). Returns a preview;
   nothing is stored until Save.
6. **Assignments** (`groups.ts`): `assignApp({ groupId, appId, audience,
   pinnedTaskbar, pinnedDesktop })` (unique per pair → `conflict`;
   `MAX_GROUP_APPS`), `updateAssignment`, `unassignApp`. Each audits and
   republishes the group.
7. **File types** (`fileHandlers.ts`): `list`, `set({ extension, appId })`
   (extension `^\.[a-z0-9]{1,10}$`, not in `DENY_EXTENSIONS` — copy the
   list from `apps/staff-app/src-tauri/src/files/types.rs` `DENY` into
   `convex/lib/denyList.ts` with a comment naming the source; the app
   must be a desktop app with a non-empty `fileArgTemplate`),
   `remove`. Publishing: `fileHandlers` in each device's document keeps
   only extensions whose app is in that device's catalogue.
8. **Builder:** catalogue and `fileHandlers` per Section 4.8; icons as
   `{ url: await ctx.storage.getUrl(storageId), sha256 }` (the URL is
   read in the mutation; it is stable while the file exists).
9. **Screens:** Apps list, AppEdit with the source picker and inline
   validation, "Fetch details" and "Resolve" buttons with pending
   states, assignments section, File types screen, GroupDetail apps
   section (assign dialog with audience and pins).

**Tests:** the three winget fixtures (MSI picked with product code;
Inno exe with the default silent switch; user-scope-only refused);
`pickInstaller` preference order; path rules (accepted:
`{ProgramFiles}\VideoLAN\VLC\vlc.exe`; refused: `C:\x.exe`,
`{ProgramFiles}\..\x.exe`, `{ProgramFiles}\a\b.bat`, 9 components,
`{RuleboxApps}\other\x.exe` for a portable app); web URL rules (http,
`https://10.0.0.1`, `https://localhost`); webmeta regex on three saved
HTML snippets (`convex/testdata/webmeta/*.html`) with `fetch` stubbed;
deny-listed extension refused; builder includes only assigned apps,
`selected` audience with the right `employeeIds`, file handlers only for
apps in the catalogue; archiving an app removes it from every document
(publish test); viewer cannot create; cross-org app id → `not_found`.

**Verify:** test commands; `cargo test -p rulebox-policy`; dashboard:
add a web app with Fetch details, add `7zip.7zip` with Resolve, assign
both to a group with a simulated device; the device's version
increases and the simulated agent logs the new version. Screenshots.

**Done when:** all pass.

**Do NOT:** call GitHub from the browser; run winget anywhere; accept an
`http://` installer URL; store an icon larger than 32 KiB.

---

### Step 11 — Employees

**PRD:** 3.1, 5.2, 6.3, 8, 13.6 #6. **Files:** `convex/employees.ts`,
`convex/groups.ts` (members section), `convex/lib/desired.ts`,
`screens/{Employees,EmployeeDetail,GroupDetail}.tsx`, tests
`convex/employees.test.ts`.

1. Functions (viewer reads, admin writes): `list({ paginationOpts,
   groupId? })` (`by_org`, or `groupMembers.by_group` joined to
   employees), `search({ text })` (`search_text`, `.take(50)`), `get`
   (employee, groups `.take(100)`, direct apps `.take(50)`, lockout
   state, `passwordSet: boolean`), `create({ name, username, quotaGb?,
   groupIds, password? })`, `update({ expectedRevision, name, username,
   quotaGb })` (a username change bumps `credentialRevision`),
   `setGroups({ expectedRevision, groupIds })` (diff → insert / delete
   `groupMembers`), `setDirectApps({ expectedRevision, appIds })`
   (`MAX_EMPLOYEE_APPS`), `setDisabled`, `setPassword` (action; Section
   4.12; bumps `credentialRevision`), `unlock` (clears
   `employeeLockouts`), `remove` (only when disabled; deletes secrets,
   lockout, memberships, direct apps; audit keeps the name).
2. Every write audits and calls `requestPublish({ kind: "employee" })`
   (and the previous groups when groups change).
3. Builder: `employees` map and `employeeIds` per Section 4.4 / 4.8.
4. Screens: list with search and group filter; detail form; "Set
   password" dialog (two fields, shows the rules, never echoes);
   lockout banner with Unlock; direct apps picker with the note for
   desktop apps; disabled employees greyed with a "Disabled" pill.

**Tests:** username normalization and uniqueness (`Maya` vs `maya`);
password rules (7 chars refused, equals username refused); the stored
hash verifies with `argon2Verify` and is not returned by `get`;
`credentialRevision` bumps on password set and rename; group change
republishes both old and new groups' devices; disabled employee left out
of `employees` in documents; `remove` refused while active; viewer
cannot write; foreign employee id → `not_found`.

**Verify / Done when:** tests pass; the simulated agent's document shows
the employee map (check with `status --simulate` and the agent log, not
by printing the document); screenshots.

**Do NOT:** return `passwordHash`; let the dashboard set a password for
an employee of another organization; hash in the browser.

---

### Step 12 — Device API (server)

**PRD:** 5.2, 12.3, 12.4, 13.5. **Files:** `convex/deviceApi.ts`,
`convex/lib/{argon,rateLimits}.ts`, `convex/devices.ts` (rotation
acceptance in `checkDevice`), tests `convex/deviceApi.test.ts`.

1. `verifyEmployee` (Section 4.12). Answer union:
   `{ kind: "ok", employee, offlineDays, credentialRevision } | { kind: "wrongCredentials" } | { kind: "disabled" } | { kind: "notAllowedHere" } | { kind: "lockedOut", retryAfterMs }`.
   Device problems → `device_rejected`.
2. `reportAudit({ records, dropped })`: ≤ 50 records; each record's
   `kind` must be one of the five Phase 2 kinds (else skipped); `detail`
   ≤ 100 chars and matching `^[a-z0-9:_ -]*$` (else dropped);
   `username` ≤ 64; idempotent on `eventKey`; `dropped > 0` → one extra
   `device.auditDropped` row "N records were lost on the device".
   Returns `{ accepted }` = number of records now known to the server
   (new + duplicates), so the agent can `ack`.
3. `reportInstalls({ results })`: upsert per `(deviceId, appId)` with
   `by_device_app`, write only when a field differs; skip app ids that
   are not in the device's org; `detail` ≤ 200 chars from the fixed list
   `download_failed, hash_mismatch, too_large, low_disk, timeout,
   exit_code, exe_missing_after_install, unsupported, busy, remove_failed`.
4. `rotateCredential({ newSecretHash })`: 64 hex; caller authenticated
   with the current secret → `previousSecretHash = secretHash`,
   `secretHash = newSecretHash`, `rotateCredential = false`, audit
   `device.credentialRotated`; caller authenticated with
   `previousSecretHash` and `secretHash == newSecretHash` → ok
   (idempotent retry). `checkDevice` clears `previousSecretHash` the
   first time the new secret is used in a mutation.
5. Rate limits (`lib/rateLimits.ts`, names exact): `enrollGlobal`
   (token bucket 60/min), `verifyPerDevice` (30/min, key = device id),
   `redeemCode` (10/min global), `inviteCreate` (30/hour per org).
   Tests run with the component registered as the rate-limiter README
   describes for `convex-test`; if that is not possible, `checkLimit`
   reads `process.env.RULEBOX_TEST_DISABLE_LIMITS === "1"` (set only by
   the test setup) and one test covers the real limiter through
   `npx convex run` against the dev deployment manually (record it).

**Tests:** every answer of `verifyEmployee`, including: wrong password
for a disabled employee → `wrongCredentials` (not `disabled`); right
password, not in the device's group → `notAllowedHere`; unknown
username → `wrongCredentials` and the dummy verify ran (spy); 10
failures → `lockedOut` and audit `employee.lockedOut`; a correct
password resets the counter; same username in another org not found;
revoked device → `device_rejected`. Audit: duplicates ignored, bad kind
skipped, clock correction rules of Section 4.11, `dropped`. Installs:
write-on-change, foreign app ignored, bad detail refused. Rotation:
happy path, retry with old secret after rotation, old secret refused
once the new one was used, wrong secret refused.

**Verify / Done when:** tests pass; deployed.

**Do NOT:** log arguments in these functions (they carry passwords and
secrets); answer `disabled` or `notAllowedHere` for a wrong password.

---

### Step 13 — Agent: Convex directory, audit sink, catalogue, credential rotation, protocol 1.2

**Files:** `crates/rulebox-ipc/src/{lib.rs,methods.rs,types.rs,requests.rs,client.rs}`
(1.2), `crates/rulebox-policy` (catalog visibility helper),
`apps/agent/src/{backend/mod.rs,backend/convex.rs,backend/task.rs,directory.rs,audit.rs,agent_policy.rs,session.rs,employee_cache.rs,catalog.rs (new),secrets.rs,ipc_shell.rs,main.rs,agent.rs}`.

1. **Protocol 1.2** in `rulebox-ipc` exactly as Section 5.2:
   `PROTOCOL_MINOR = 2`; `events::APPS_CHANGED = "apps.changed"`,
   `events::SESSION_ENDED = "session.ended"`; `SessionEndedData { reason:
   SessionEndReason }` with `EmployeeRemoved`, `CredentialChanged`,
   `Revoked`, `Unknown`; `CAP_APPS_CHANGED = "appsChanged"`,
   `CAP_SESSION_ENDED = "sessionEnded"`; `SignInOutcome::NotAllowedHere`
   (`"notAllowedHere"`); `ClientEvent::AppsChanged` and
   `ClientEvent::SessionEnded(SessionEndReason)` in the client. Golden
   JSON tests like the existing ones.
2. **`Backend` trait** gains:

   ```rust
   fn verify_employee(&self, auth: &DeviceAuth, username: &str, password: &str)
       -> BoxFuture<'_, Result<VerifyAnswer, BackendError>>;          // action deviceApi:verifyEmployee
   fn report_audit(&self, auth: &DeviceAuth, records: &[AuditRecord], dropped: u64)
       -> BoxFuture<'_, Result<usize, BackendError>>;
   fn report_installs(&self, auth: &DeviceAuth, results: &[InstallReport])
       -> BoxFuture<'_, Result<usize, BackendError>>;
   fn rotate_credential(&self, auth: &DeviceAuth, new_secret_hash: &str)
       -> BoxFuture<'_, Result<(), BackendError>>;
   ```

   `HeartbeatResponse` gains `rotate_credential: bool` (missing → false).
   `ConvexBackend` uses `client.action` for `verifyEmployee` (the 30 s
   `CALL_TIMEOUT` stays; the session layer's 6 s applies on top).
   `FakeBackend` scripts all four.
3. **`BackendLink`** (new, `backend/mod.rs`): `Arc<BackendLink>` holding
   `RwLock<Option<(Arc<dyn Backend>, DeviceAuth)>>`, set when the backend
   task starts, cleared when it stops or the device is revoked. Created
   in `agent::run` and passed to the directory and the audit sink, which
   are built before enrollment.
4. **`ConvexDirectory`** (`directory.rs`): `available()` = true;
   `verify` → `BackendLink` empty → `Unreachable`; else
   `verify_employee` → map: ok → `DirectoryAnswer::Ok(DirectoryEmployee
   { employee, apps: visible_apps(...), offline_days,
   credential_revision })`; `notAllowedHere` →
   `DirectoryAnswer::NotAllowedHere` (new variant) → outcome
   `notAllowedHere`, counted failure undone; `BackendError::Unreachable |
   Timeout` → `Unreachable`; `Rejected { code: "device_rejected" }` →
   `Unavailable`. `choose()` gains `DirectoryChoice::Convex`, used by the
   real agent and by `--simulate` without `--sim-demo`.
   **`fixtureDirectory`:** if `docs/plans/README.md` shows Phase 3 as done
   (its VM Step 18 ran), delete the config key, the `choose` branch and
   `vm-deploy.ps1 -FixtureDirectory`; otherwise keep them, unchanged, and
   say so in the report.
5. **Catalogue** (`apps/agent/src/catalog.rs`): `AgentPolicy` gains
   `catalog: Vec<CatalogApp>` and `employees: BTreeMap<String, u64>`
   (from the document; bad shape → empty and a logged problem
   `catalog_invalid`). `visible_apps(catalog, employee_id, installed:
   &dyn Fn(&str) -> InstallView) -> Vec<AppEntry>` per Section 4.8
   (path templates expanded and re-checked with the same rules as
   `convex/lib/pathRules.ts`; an entry that fails is skipped and logged).
   Until Step 14 every install view is "installed when the exe exists"
   (`Platform::file_exists`, new read-only method).
6. **Session** (`session.rs`, `employee_cache.rs`): the cache entry gains
   `employee_id` (already in `employee`) and `credential_revision: u64`
   (`#[serde(default)]`). On every new `AgentPolicy`:
   - drop cache entries whose employee id is not in `employees` or whose
     revision differs;
   - the signed-in employee missing → clear the session and broadcast
     `session.ended { reason: "employeeRemoved" }`; revision differs →
     `credentialChanged`;
   - recompute the signed-in employee's apps; if different, store them
     and broadcast `apps.changed` (debounced 2 s).
   Offline sign-in also refuses an employee not in `employees`
   (`notAllowedHere`) when a signed document exists. Revocation
   broadcasts `session.ended { reason: "revoked" }`.
7. **`ConvexAuditSink`** (`audit.rs`): `deliver` → `BackendLink` empty →
   `Unreachable`; else `report_audit(records, dropped)`; `Ok` when
   `accepted == records.len()`. Real agent and simulate without
   `--sim-demo` use it; `--sim-demo` keeps `LogAuditSink`.
8. **Credential rotation** (`backend/task.rs`, `secrets.rs`): when a
   heartbeat answers `rotate_credential: true` and no rotation is in
   progress: generate a new 32-byte secret (hex), save it as
   `Secrets.rotating_device_secret` **first**, call
   `rotate_credential(old auth, sha256_hex(new))`; on `Ok` move it to
   `device_secret`, clear the pending one, restart the subscription with
   the new auth (`BackendLink` updated). On error keep both and retry at
   the next heartbeat. **At start**, if `rotating_device_secret` exists,
   call `rotate_credential` again with the old secret (idempotent on the
   server); if the server answers `device_rejected` for the old secret,
   try one heartbeat with the new one and adopt it on success. An
   `unknownDevice` subscription answer while a rotation is pending is
   **not** treated as revocation until both secrets were tried.

**Tests (agent, `FakeBackend`):** `convex_directory_maps_every_answer`;
`not_allowed_here_does_not_count_a_failure`;
`cache_entry_dropped_when_employee_leaves_the_doc`;
`cache_entry_dropped_when_revision_changes`;
`signed_in_employee_removed_ends_session_with_event`;
`apps_changed_sent_once_per_burst`; `offline_sign_in_refused_when_not_in_doc`;
`audit_sink_acks_only_when_all_accepted`; `rotation_happy_path`;
`rotation_lost_answer_recovers_at_start`;
`unknown_device_during_rotation_is_not_revocation`;
`heartbeat_without_rotate_field_means_false`;
`path_template_expansion_and_rejection`. IPC: golden JSON for the two
events and the new outcome; a 1.1-style client ignores the new events
(the existing client test with an unknown event name).

**Verify:** clippy and tests for `rulebox-ipc`, `rulebox-policy`,
`rulebox-agent`. Simulate run against the dev deployment: create an
employee in a group with the simulated device, set a password, then with
`fake_staff` (`i <user> <password>`) sign in → `ok` with the group's
apps; disable the employee in the dashboard → `fake_staff` prints a
`session.ended` event; the audit log shows an admin-exit record after
`x` with a wrong PIN (`fake_staff` `x`).

**Done when:** all of that works and tests pass.

**Do NOT:** put the catalogue or `employees` into `AgentSnapshot` or
`DesiredState`; call the backend from `apps.list`; log a password.

---

### Step 14 — Agent: install engine

**PRD:** 3.2, 6, 9.3, 12.3, 13.5, 13.6 #1. **Files:**
`apps/agent/src/installs/{mod.rs,download.rs,engine.rs,report.rs,icons.rs}` (new),
`apps/agent/src/platform/{mod.rs,sim.rs,windows.rs}`,
`apps/agent/src/{agent.rs,paths.rs,catalog.rs,backend/task.rs}`,
`apps/agent/Cargo.toml`, root `Cargo.toml`.

1. **Platform additions:**

   ```rust
   // read-only
   fn file_exists(&self, path: &Path) -> Result<bool, PlatformError>;            // (Step 13)
   fn known_folders(&self) -> Result<KnownFolders, PlatformError>;               // program_files, program_files_x86, windows
   // mutating: WindowsPlatform calls guard::require_test_machine() first
   fn run_installer(&self, cmd: &InstallerCommand, timeout: Duration) -> Result<InstallerExit, PlatformError>;
   fn place_portable(&self, from: &Path, to: &Path) -> Result<(), PlatformError>;   // creates parent dirs under <install>\apps; refuses reparse points
   fn remove_portable(&self, app_dir: &Path) -> Result<(), PlatformError>;          // only below <install>\apps; refuses reparse points
   pub struct InstallerCommand { pub program: PathBuf, pub args: Vec<String>, pub working_dir: PathBuf }
   pub enum InstallerExit { Code(i32), TimedOut }
   ```

   `WindowsPlatform::run_installer` uses `std::process::Command` with
   `CREATE_NO_WINDOW` (`std::os::windows::process::CommandExt`), no
   inherited handles beyond the defaults, waits with `try_wait` every
   500 ms in `spawn_blocking`, and on timeout calls `kill()` and returns
   `TimedOut`. The program must be `%SystemRoot%\System32\msiexec.exe`
   or a file inside `<data>\downloads\`; anything else →
   `PlatformError::Other("program not allowed")`.
2. **Downloader** (`download.rs`): trait `Downloader { fn fetch(&self,
   url, dest, expected_sha256, max_bytes) -> BoxFuture<Result<(),
   DownloadError>> }`; `HttpDownloader` on `reqwest` (features of Section
   4.15; `connect_timeout` 30 s; a read that stalls 60 s fails — use
   `read_timeout` if 0.13.5 has it, else wrap each chunk in
   `tokio::time::timeout`); streams into `<dest>.part` while hashing,
   checks size and hash, renames to `dest`; on mismatch deletes and
   returns `HashMismatch`. Only `https://` URLs. `FakeDownloader` for
   tests.
3. **Engine** (`engine.rs`): the state machine of Section 4.8, state in
   `<data>\state\installs.json` (`schema: 1`, atomic writes, corrupt-file
   rule of Phase 2). One task (`installs`) started by `agent::run`;
   triggers: `DesiredChanged`, start, retry timer, `revoked` (stop after
   the current operation; nothing new). It never runs while the device is
   not enrolled or revoked.
4. **Visibility:** the catalogue helper of Step 13 now asks the engine:
   desktop apps with `install` are visible only in state `installed`.
   A transition into or out of `installed` for an app the signed-in
   employee could see triggers `apps.changed`.
5. **Reporting** (`report.rs`): Section 4.8; `restartPending` in the
   status when any MSI returned 3010 or 1641 since the last boot.
   `installs.json` stores `restartPendingSinceMs`; it is cleared when
   `Platform::boot_time_ms()` (new read-only method; `WindowsPlatform`
   gets it from a new `rulebox_win32::osinfo::boot_time_ms()` =
   now − `GetTickCount64`, with a `// SAFETY:` comment if the binding is
   `unsafe`; `SimPlatform` returns a settable value) is later than it.
6. **Icons** (`icons.rs`): for catalogue entries with `icon`, download
   (≤ 32 KiB, `https://` only, the Convex deployment host only) into
   `<data>\icons\<sha256>.png` when missing; `visible_apps` fills
   `icon_png_base64` from that file. Failures leave the icon empty.
7. **SimPlatform:** `run_installer` returns a scripted exit (default
   `Code(0)`) and, on success, adds the expanded exe path to its fake
   file set; `place_portable` / `remove_portable` act on the fake set.

**Tests:** `msi_success_reports_installed_and_becomes_visible`;
`exit_3010_sets_restart_pending`; `exit_1618_retries_without_counting`;
`failure_backs_off_1_5_15_60_360_then_stops`;
`new_revision_resets_attempts`; `hash_mismatch_deletes_the_file`;
`size_over_limit_refused`; `low_disk_refused`;
`exe_missing_after_install_is_failure`;
`new_sha_triggers_reinstall`; `unassigned_msi_with_remove_flag_uninstalls`;
`unassigned_exe_is_only_hidden`; `portable_placed_and_removed`;
`program_outside_downloads_refused`; `revoked_stops_after_current_operation`;
`reports_only_unacknowledged_transitions`; `http_url_refused`;
`icon_from_other_host_refused`.

**Verify:** clippy + tests for `rulebox-agent`. Simulate run: assign the
`7zip.7zip` app to the simulated device's group → the agent downloads
the real MSI into the simulate data directory (about 1.5 MB, the
network is fine), hash matches, the fake install "succeeds", the
dashboard device page shows `installed` after Step 17 (until then check
`installResults` with `npx convex data installResults`).

**Done when:** all pass and the simulated flow reports `installed`.

**Do NOT:** run any real installer on the dev machine (the guard
refuses it; do not work around it); use `winget`, PowerShell or
`ShellExecute`; download from a URL not in a verified document.

---

### Step 15 — Staff App: protocol 1.2 and file handlers

**Starts only after Phase 3 Step 19 is committed.** **Files:**
`apps/staff-app/src-tauri/src/{agent/ipc.rs,agent/demo.rs,agent/mod.rs,model.rs,session.rs,files/mod.rs,commands.rs}`,
`apps/staff-app/src/shell/signin/*`, Staff App tests in
`src-tauri/src/main.rs` modules (the lib harness does not run; see
Phase 3 notes).

1. `IpcAgent`: map `ClientEvent::AppsChanged` → the existing catalogue
   refresh (`refresh_catalogue` path, one `apps.list` call);
   `ClientEvent::SessionEnded(reason)` → the same path as a log out
   (close the employee's apps the way `session.rs` already does, clear
   memory) and show on the sign-in screen: `employeeRemoved` → "Your
   account can't be used on this PC any more.", `credentialChanged` →
   "Your password was changed. Sign in again.", `revoked` → "This PC was
   removed from your organization.", `unknown` → "You were signed out."
2. `SignInOutcome::NotAllowedHere` → "You can't sign in on this PC. Ask
   your administrator." (`AgentPort` model gains the variant.)
3. **File handlers:** on every snapshot change, build
   `BTreeMap<extension, appId>` from `snapshot.desired_state.file_handlers`
   and call `FilesHub::set_handlers` (the method Step 12 of Phase 3
   left without a caller). "Open with" then lists the handler app when it
   is in the employee's catalogue.
4. `DemoAgent`: snapshot `fileHandlers: { ".txt": "notepad" }`; dev
   commands `{ "appsChanged": true }` and `{ "sessionEnded": "employeeRemoved" }`
   in the dev poller so the UI can be exercised.

**Tests:** model mapping of the new outcome and events; handler map
built from a snapshot; demo agent emits the events.

**Verify:** the Phase 3 checks (`cargo clippy -p rulebox-staff …`,
`cargo test -p rulebox-staff --bin rulebox-staff`, `pnpm --filter
@rulebox/staff-app typecheck|lint|test`); run with
`RULEBOX_STAFF_DEMO=1` and screenshot the three sign-in messages (Rulebox
windows only, with `.tmp/winshot.ps1`).

**Done when:** all pass.

**Do NOT:** add a Convex connection to the Staff App; change the
`AgentSnapshot`.

---

### Step 16 — Agent: session cleanup (reset folders)

**PRD:** 5.3, 13.3. **Files:** `apps/agent/src/cleanup.rs` (new),
`session.rs`, `platform/{mod,sim,windows}.rs`.

1. `Platform::reset_folder(&self, profile_dir: &Path, template: &str) ->
   Result<ResetOutcome, PlatformError>` (mutating, guarded): resolves
   `{LocalAppData}` → `<profile>\AppData\Local`, `{RoamingAppData}` →
   `<profile>\AppData\Roaming`; re-checks the template rules; walks each
   component from the base and **refuses** if any existing component is
   a reparse point; then `std::fs::remove_dir_all` (it does not follow
   links). `ResetOutcome::{Removed, Absent, InUse}` (sharing violation on
   any file → `InUse`, already-deleted files stay deleted).
2. When: on `session.signOut` and when the Staff Windows session ends
   with an employee session active — 3 seconds later (apps are closed by
   the Staff App before it calls `signOut`), for the `resetFolders` of
   **every** desktop app in the current catalogue (not only the ones the
   employee opened: an app may have been started by another app). `InUse`
   → one retry after 10 seconds, then logged; the next sign-out tries
   again. Never during an active session.
3. Logged at `info` with the template only; no file names.

**Tests:** template resolution; refusal of `..`, absolute paths, an
unknown token, a reparse point at any level (SimPlatform models one);
`InUse` retry; nothing runs while a session is active; sign-out triggers
the reset of every catalogue app's folders.

**Verify / Done when:** clippy and tests pass. The real deletion is a
VM checklist item.

**Do NOT:** delete anything outside the Staff profile's `AppData`;
follow a junction; reset while an employee is signed in.

---

### Step 17 — Dashboard: install status, overview, audit, history

**Files:** `convex/{apps,fleet,overview,audit}.ts`,
`screens/{Overview,DeviceDetail,AppEdit,Audit}.tsx`,
`components/HistoryPanel.tsx`, tests `convex/{overview,audit}.test.ts`.

1. `apps:installSummary({ appId })` (viewer): counts per state from
   `installResults.by_app_state` `.take(1001)` per state ("1000+").
   `apps:installs({ appId, state, paginationOpts })`: devices in a state,
   joined with device names.
2. `fleet:installs({ deviceId, paginationOpts })`: the device's results
   joined with app names; app detail and device detail render state
   pills (`installed` success, `failed` danger with the detail text from
   `lib/strings.ts`, `pending/downloading/installing` neutral with a
   small spinner, `removed`, `unsupported`), and "Retry" (admin) on
   failed rows (calls `apps:retry`).
3. `overview:get({ nowMs })` (`nowMs` rounded down to the minute by the
   client): device count (`orgStats`), seen in the last `2.5 ×
   interval`
   (`deviceStatus.by_org_last_seen` `.take(1001)`), devices without a
   group (`devices.by_group` with `groupId` undefined, `.take(101)`),
   out-of-support count (not indexed: shown only on the devices list as
   a badge; the overview links there — do not scan), failed installs
   (`installResults.by_org_state` `failed`, `.take(20)` joined with
   names), recent audit (`.take(10)`), signing key state, publish
   failure banner (latest `policy.publishFailed` within 24 hours via
   `auditLog.by_org_at` `.take(50)` scan of the newest rows).
4. `audit:list({ paginationOpts })` and `audit:forTarget({ targetId,
   paginationOpts })`. Screen: newest first, Load more, actor and target
   links, relative and absolute time (title attribute).
5. `HistoryPanel` on device, employee, app and group pages.

**Tests:** counts with 0 / 3 / over-cap rows; `overview:get` reads no
`desiredStates` payloads; audit pagination order; `forTarget` scoped to
the org.

**Verify / Done when:** tests pass; screenshots of overview (empty org
and with data), device installs, app install summary, audit log.

**Do NOT:** compute "online" on the server; scan `devices` for the
overview.

---

### Step 18 — Security and load hardening

**Files:** `convex/authzMatrix.test.ts`, `convex/secrets.test.ts`,
`convex/crossOrg.test.ts`, `scripts/fleet-sim.mjs` (new),
`convex/testing.ts` (seed helpers used by the script; Step 20 finishes
it).

1. **Authorization matrix test:** one table in the test lists every
   public function of `api` (built by walking the generated `api`
   object; the test fails when a function is missing from the table)
   with its minimum role or "device" / "public". For each function and
   each of {signed out, viewer, admin without MFA, admin, owner, device,
   other org's owner} it calls with minimal valid arguments and asserts
   allowed or the exact refusal code.
2. **Secrets test:** Section 4.7.
3. **Cross-org test:** two organizations; for every function that takes
   an id, the other org's id gives `not_found`.
4. **Policy attack tests** live in the agent (Step 9 list) — re-run and
   list them in the report.
5. **Load check** (`scripts/fleet-sim.mjs --devices 50 --minutes 10
   --interval-seconds 10`): uses `testing:seedFleet` (internal, guarded
   by `RULEBOX_ALLOW_TEST_SEED=1`, creates a separate org "Load test" with
   50 devices and known secrets), then runs 50 simulated agents with
   `ConvexClient` from `convex/browser`: one `desiredState`
   subscription each, a heartbeat every interval with jitter, and 20
   admin edits spread over the run (via `testing:simulateEdit`).
   Reports: heartbeat p50/p95 latency, any errors (write conflicts must
   be 0), number of documents published, and the function-call count
   from the run. Afterwards `testing:deleteOrg` removes the load org.
   **Ask the user before running it** (it uses about 3,500 function
   calls of the free tier).
6. Review checklist (Section 9) walked once; every item ticked or
   reported.

**Verify / Done when:** the three test files pass; load check run with
the user's consent and numbers reported; checklist done.

**Do NOT:** run the load check against anything but the dev deployment.

---

### Step 19 — End-to-end tests (Playwright)

**Files:** `apps/dashboard/playwright.config.ts`, `apps/dashboard/e2e/*.spec.ts`,
`apps/dashboard/e2e/helpers.ts`, `convex/testing.ts`.

1. Ask the user, then `pnpm --filter @rulebox/dashboard exec playwright install chromium`.
2. Config: `testDir: "e2e"`, Chromium only, `webServer: { command:
   "pnpm dev", url: "http://localhost:5173", reuseExistingServer: true }`,
   `use.baseURL`. Runs against the dev deployment.
3. `testing:seedE2E` (internal action, guarded): creates org
   `E2E <runId>` and returns an owner invite code; `testing:seedDevice`
   creates a fake device with a known secret in a group; `testing:deleteOrg`
   removes everything of an org (batched). `helpers.ts` calls them with
   `npx convex run` and computes TOTP codes with `@noble/hashes`.
4. Specs: `auth.spec.ts` (join with invite, MFA setup, sign out, sign in
   with TOTP, recovery code, wrong password message); `roles.spec.ts`
   (viewer sees no edit buttons and a direct mutation attempt from the
   page's console fails with `forbidden`); `apps-groups.spec.ts` (web
   app via form, assign to group, device page shows a higher document
   version); `employees.spec.ts` (create, set password, disable);
   `enrollment.spec.ts` (create code, shown once, revoke);
   `settings.spec.ts` (stale edit: two pages edit the same settings; the
   second gets the reload message); `a11y.spec.ts` (keyboard-only
   navigation through the main screens; focus visible; dialogs trap and
   return focus; `prefers-reduced-motion` emulated → no transform
   animation runs (check computed style during the entry)).
5. Every spec cleans up its org in `afterAll`.

**Verify / Done when:** `pnpm --filter @rulebox/dashboard e2e` passes
twice in a row.

**Do NOT:** run e2e against production; leave seeded orgs behind.

---

### Step 20 — Retire `dev.ts`, docs

1. Delete `convex/dev.ts`. Everything it did now exists in the
   dashboard; test seeding lives in `convex/testing.ts`, whose functions
   are `internal*` and start with
   `if (env.RULEBOX_ALLOW_TEST_SEED !== "1") fail("forbidden")`.
2. `scripts/vm-deploy.ps1`: nothing changes except the
   `-FixtureDirectory` removal decided in Step 13.
3. `README.md`: a "Run your own Rulebox backend" section: create a
   Convex project, `npx convex deploy`, `npx @convex-dev/auth --prod`,
   `npx convex run setup:createOwnerInvite --prod …`, policy key
   generation and registration, dashboard env (`VITE_CONVEX_URL`),
   hosting headers files, `GITHUB_TOKEN` (optional).
4. `THIRD_PARTY_NOTICES.md`: add `@convex-dev/auth` (Apache-2.0),
   `@noble/ed25519` and `@noble/hashes` (MIT), `hash-wasm` (MIT),
   `react-router` (MIT), `uqr` (MIT), `yaml` (ISC), `convex-helpers`
   (Apache-2.0), `@convex-dev/rate-limiter` (Apache-2.0),
   `ed25519-dalek` (BSD-3-Clause), `reqwest` (MIT/Apache-2.0). Check each
   licence in the installed `package.json` / `Cargo.toml` and correct
   this list if it differs.
5. Do not edit `docs/prd.md` or `CLAUDE.md`; give the user Section 20.

**Done when:** `git grep -n "dev:"` finds no reference to the deleted
functions; README section reviewed by you once as a new user would read
it.

---

### Step 21 — VM run (the user runs this)

Snapshot the VM first (`before-phase4-vm-run`). The agent prepares the
build (`cargo build -p rulebox-agent -p rulebox-shell`, the Staff App
debug build of Phase 3) and the checklist; **the user** creates the
test-machine marker inside the VM by hand and runs every step. Results
go to `docs/plans/phase-4-vm-results.md` (new).

**Enrollment and signing**
- [ ] A code from the dashboard enrolls the VM; the device appears
      online; `status` shows the trusted key id.
- [ ] Kiosk off / on from the dashboard applies within seconds (signed
      document, new version in the log).
- [ ] Editing `desired-state.json` by hand (as administrator) and
      restarting the agent: the cache is refused (`policy_rejected`) and
      the kiosk keeps its state.
- [ ] Key rotation end to end: prepare, the VM reports trust, finish;
      the next document is signed by the new key.

**Employees**
- [ ] An employee of the device's group signs in online; an employee of
      another group gets "You can't sign in on this PC".
- [ ] Network off: the same employee signs in offline; after the admin
      disables them (network back on), the Staff App ends the session
      with the message, and offline sign-in no longer works.
- [ ] Password changed in the dashboard: the old password fails offline
      after the next document.

**Installs**
- [ ] `7zip.7zip` (winget, MSI) assigned → downloaded, installed silently
      as SYSTEM, no UAC, no window in the Staff session; the tile appears
      only after `installed`; dashboard shows ✅.
- [ ] An EXE app (Inno or NSIS from winget) installs silently.
- [ ] A portable EXE lands in `C:\Program Files\Rulebox\apps\<id>\`.
- [ ] A wrong SHA-256 → `hash_mismatch`, nothing runs, ❌ with detail.
- [ ] Unassign the MSI with "remove" → uninstalled.
- [ ] Network cut mid-download → retried later; no half-installed tile.

**Admin exit, audit, cleanup**
- [ ] PIN set in the dashboard works at the VM; wrong PINs appear in the
      audit log within a minute of the network being up.
- [ ] Reset folders: an app's `%LOCALAPPDATA%\<folder>` is gone after
      sign-out; a junction planted there by the Staff account is refused
      (log) and its target untouched.

**Phase 2 re-checks (from `docs/plans/README.md`)**
- [ ] Exit hold: after a correct PIN and a restart within 15 seconds of
      the Staff session ending, Staff is signed in again on that boot
      (the 15 s rule); after 5 minutes without sign-in, auto sign-in is
      back.
- [ ] Kill the launcher: its Staff App goes with it (kill-on-close job),
      one Staff App after relaunch.
- [ ] `recover` on a VM whose owner had LSA auto sign-in: `AutoAdminLogon`
      ends `0` with the explanation, no failed auto sign-in loop.

**Done when:** every item has a result (✅, ❌ with notes, or "not
tested" with the reason) in `phase-4-vm-results.md`.

---

### Step 22 — Wrap-up

1. Run and paste: `pnpm typecheck`, `pnpm lint`, `pnpm test:convex`,
   `pnpm --filter @rulebox/dashboard test`,
   `cargo clippy --workspace --all-targets -- -D warnings`,
   `cargo test --workspace`, the size of `target\`.
2. Leftover checks: `git grep -n "\.filter(" convex` returns nothing in
   query code; `git grep -n "\.collect()" convex` only on tables marked
   tiny with a named limit (or none); no import of `query`/`mutation`/
   `action` outside `lib/functions.ts` (the lint rule); no
   `dangerouslySetInnerHTML`; every icon import starts with
   `~icons/solar/`; no network URL in `apps/dashboard/index.html` or CSS.
3. Delete `.tmp/policy-key.seed` if it still exists, Playwright reports,
   stray downloads.
4. Update `docs/plans/README.md`: Phase 4 → `✅ Done` only after the
   user reviewed the VM results; until then `In progress (awaiting VM
   run)`.
5. Commit only when the user says so; no push; no attribution.

## Final report format (keep it short)

- ✅ / ❌ per step's **Done when**.
- Versions installed (Section 4.15) and any deviation.
- Screenshot list (screen × light / dark / narrow).
- Load-check numbers (Step 18), test counts per suite.
- VM results summary and every **(unverified)** item confirmed or
  disproved.
- Open questions for the user.

## Stop and ask the user if

- free disk space is below 10 GB, or Playwright / new crates would be
  downloaded for the first time;
- existing rows block a schema deploy (Step 2), or anything would delete
  data in a deployment;
- a step would need a real install, uninstall or folder deletion on the
  dev machine, or the test-machine marker;
- `@convex-dev/auth` lacks `modifyAccountCredentials` /
  `invalidateSessions`, or Convex Auth's sign-up cannot be closed as
  described in Step 3;
- Ed25519 signing with `@noble/ed25519` fails inside a mutation on the
  deployed runtime;
- hash-wasm Argon2id hashes do not verify in Rust (Step 5 vectors);
- a **Done when** check still fails after two honest attempts;
- you need a dependency not in Section 4.15, or a newer major of one;
- the PRD and this plan disagree on something not listed in Section 20.

---

## 7. Edge cases and failure modes

| # | What can go wrong | Required behaviour | Step |
|---|---|---|---|
| 1 | Device offline when a change is made | The new version waits in `desiredStates`; the device page shows "Waiting for the PC (applied v11, latest v12)" from `deviceReports.appliedVersion` vs newest version; the agent gets it on reconnect through the subscription (PRD 9.4) | 7, 8 |
| 2 | Device clock wrong | Nothing in the agent depends on its clock for trust (no expiry). Audit times are corrected with the server offset (4.11). Lockout clocks keep the Phase 2 rule | 9, 12 |
| 3 | Duplicate enrollment (lost answer, retry) | Phase 2 idempotency stays: same token and secret hash → same device, no use consumed | 8 |
| 4 | Enrollment with a used-up, expired or revoked code | The agent prints the server's reason; the code's row shows why in the dashboard | 6 |
| 5 | Enrollment before a signing key exists | `not_ready` → "The organization has no signing key yet" | 8, 9 |
| 6 | Device revoked mid-install | The current operation finishes (an MSI is never killed half-way unless it times out); nothing new starts; the kiosk keeps its state (Q11); reports stop | 14 |
| 7 | Two admins edit the same thing | `expectedRevision` → `stale_edit` → reload message; publishes merge in the queue | 2, 4 |
| 8 | Half-applied policy (agent crashed mid-reconcile) | The reconciler is idempotent (Phase 2); `appliedVersion` is written only after success; the next start re-applies the cached signed document | 9 |
| 9 | Forged, replayed or rolled-back document | Refused (`policy_rejected`), previous state kept, `kioskError: desired_state_untrusted` visible on the device page | 9 |
| 10 | Large fleet vs free tier | Heartbeat interval scales (4.9); the overview shows a warning above 300 devices: "Your fleet may exceed the Convex free plan; see Usage in the Convex dashboard" | 7, 17 |
| 11 | Convex outage or overload (HTTP errors, 16 concurrent limit) | Agent: one-shot calls time out and retry later; sign-in falls back to the offline cache (Phase 2); reconnect jitter. Dashboard: connection banner, mutations queue in the client | 4, 13 |
| 12 | Signing key rotated (once or several times) while a device was offline | `keys` lists **every** `policyKeys` row of the device's organization, oldest first, each with its endorsement. The agent processes them in that order before verifying the document, so it walks the chain A → B → C from the key it trusts, then drops retired keys per 4.5 step 5. Only a device that trusts no key in the chain needs re-enrollment | 8, 9 |
| 13 | Signing key lost / stolen | Section 4.5 | 8 |
| 14 | Stale dashboard tab (old JS after a deploy) | Convex keeps old function signatures working only if args are compatible; the dashboard checks `api` version: `account:me` returns `serverVersion` (a constant bumped with breaking changes); a mismatch shows "A new version of the dashboard is available — Reload" | 4 |
| 15 | Employee deleted, files still on laptops | Files stay (PRD 8: local, v1). The agent drops the cache entry; nobody can sign in as that employee; the folder stays under `RuleboxFiles\<id>`. Deleting those folders is a later feature; the delete dialog says so | 11, 13 |
| 16 | Employee renamed (username) | `credentialRevision` bump → devices drop the old cache entry; online sign-in with the new name works | 11 |
| 17 | Employee in several groups | May sign in on devices of any of them; sees each device's catalogue filtered by audience | 8, 13 |
| 18 | Device without a group | Document with `employees: {}`; nobody can sign in; dashboard warning | 7, 8 |
| 19 | App archived while installed | Removed from catalogues: MSI/portable with `removeWhenUnassigned` are uninstalled; others hidden | 10, 14 |
| 20 | winget manifest changed upstream (new version) | Nothing happens until an admin presses "Check for update" (re-resolve) — documents must not change silently | 10 |
| 21 | Installer URL now serves a different file | Hash mismatch → `failed/hash_mismatch`; the admin re-resolves | 14 |
| 22 | Another MSI install running (1618) | Retry in 2 minutes, not counted | 14 |
| 23 | Install needs a reboot (3010) | `installed` + `restartPending` shown on the device page; the agent never reboots | 14 |
| 24 | Member loses their authenticator | Recovery code; else an Owner resets their MFA; the only Owner uses the CLI `maintenance:resetMfaByEmail` | 3 |
| 25 | Last Owner tries to leave / demote | `last_owner` | 3 |
| 26 | XSS in an app name or employee name | React escaping only; no `dangerouslySetInnerHTML`; CSP blocks inline script | 4 |
| 27 | Very long names / Unicode | Names 1–100 characters (devices 100, employees 100, apps 60, groups 60), trimmed, control characters refused; display truncates with CSS and a `title` | 2 |
| 28 | Publish fails for one device (too large) | Other devices continue; audit `policy.publishFailed`; device page error | 8 |
| 29 | Device credential rotation answer lost | Idempotent retry with the old secret; the new one adopted after one successful use | 12, 13 |
| 30 | Audit queue overflow on a long-offline device | Phase 2 cap 500; `device.auditDropped` row with the count | 12 |
| 31 | Dashboard open on a phone | Layout works at 390 px: navigation in a menu, tables scroll horizontally inside their panel (never the page) | 4 |
| 32 | `RULEBOX_POLICY_KEY` set to a malformed value | Treated as missing: publish refused, banner | 8 |

## 8. Observability

- **Audit log** for every administrative action and every device
  security event (4.11). It is the user-facing record.
- **Convex logs:** functions log at most one line per failure, with the
  error code and ids, never arguments, secrets, payloads or passwords
  (`console.log(args)` is forbidden; a lint rule
  `no-console` in `convex/**` except `console.error` / `console.warn` with
  a fixed message string).
- **Agent logs:** `policy_rejected`, `install` transitions, `verify`
  outcomes (never the password), rotation steps; the Phase 2 rule that
  other crates log at `warn` at most stays (it hid the device secret).
- **Dashboard health:** overview warnings (no signing key, publish
  failures, devices without group, out-of-support Windows, fleet size
  vs free plan).

## 9. Security checklist

Walked in Step 18; each line ticked or reported.

- [ ] Every public function uses a wrapper; the authorization matrix
      test covers every function in `api`.
- [ ] Every id argument is checked with `assertInOrg`; cross-org test
      green.
- [ ] Admin and Owner functions require an MFA-verified session.
- [ ] Open sign-up impossible (no invite → refused), invite and reset
      codes single-use, hashed, expiring, rate-limited.
- [ ] No query returns a secret (Section 4.7 test).
- [ ] Random values only from actions.
- [ ] Policy documents signed in the same mutation that stores them;
      agent verifies before parsing; device id, org id and version
      bound; no unsigned path in release builds.
- [ ] Installers: `https://` only, SHA-256 verified before execution,
      stored in the SYSTEM-only data directory, program allow-list in
      `run_installer`, no `winget` / PowerShell / `ShellExecute`.
- [ ] Path templates validated on the server and again in the agent;
      reset folders never leave the Staff profile's `AppData`, never
      follow reparse points.
- [ ] Dashboard: strict CSP (scripts), `frame-ancestors 'none'`,
      `nosniff`, no `dangerouslySetInnerHTML`, open-redirect guard on
      `next`, tokens only in Convex Auth's storage.
- [ ] CSRF: not applicable — Convex calls carry the JWT in the
      WebSocket / request body, not in cookies; nothing in Phase 4 uses
      cookies.
- [ ] Audit log append-only, no secrets in summaries.
- [ ] Device secret, enrollment token, PIN, passwords never logged by
      agent or server.
- [ ] Convex Auth tokens live in `localStorage` (documented behaviour):
      the CSP and the absence of HTML injection are what protect them;
      sessions expire after 12 hours idle / 7 days total.

## 10. Coding standards (match the repository)

- **TypeScript:** strict, `noUncheckedIndexedAccess`; named exports;
  one component per file; styles via `var(--rb-*)` tokens or
  `packages/ui` classes, never raw colours; strings from
  `lib/strings.ts`; no default exports except where a tool requires one
  (Convex `schema.ts`, `auth.config.ts`, `http.ts`, `crons.ts`,
  `convex.config.ts`).
- **Convex:** wrappers only; `args` + `returns` validators; `.withIndex`
  always, never `.filter()` on a query (filtering a small array in
  JavaScript after an indexed read with a named limit is fine);
  `.paginate()` for "grows" tables, `.take(LIMIT)` with a named constant
  from `lib/limits.ts` otherwise; no `Date.now()` in queries; random
  only in actions; errors through `fail()`; one `writeAudit` per
  changing mutation; `requestPublish` whenever a document input
  changes. Internal functions for everything the CLI or scheduler calls.
- **Rust:** workspace lints (`unwrap_used`, `expect_used` warn → denied
  by `-D warnings` in clippy); no `unwrap()` / `expect()` outside tests;
  no new `unsafe` (Step rules); `thiserror` for error types; secrets
  have hand-written `Debug` that prints `<redacted>`; `BoxFuture` for
  async trait methods (no `async-trait`); every mutating `Platform`
  method calls the guard first in `WindowsPlatform`.
- **Wire types:** camelCase JSON; enums that cross a process boundary
  map unknown strings to `Unknown`; additive changes only within a
  protocol major.

## 11. Migration and backward-compatibility rules

- **IPC:** 1.2 is additive (5.2). A future 1.3 follows the same rule:
  new methods behind capabilities, new events ignored by old clients,
  new enum strings mapped to `Unknown`.
- **Backend wire:** a field the agent did not send before is
  `v.optional` on the server **before** the agent sends it; the strict
  `statusValidator` key list is pinned by a Rust test.
- **Document format:** `format: "rulebox.desired/2"`. A future `/3`
  ships an agent that accepts both before the server writes `/3`; an
  agent refuses an unknown format (`BadFormat`) and keeps its state.
- **Schema:** new fields `v.optional` first, backfill with a batched
  internal mutation (or `@convex-dev/migrations` if a table is large),
  then tighten. Never a deploy that needs data deleted without the
  user's consent (Step 2).
- **Cache files on the device:** new fields `#[serde(default)]`; a file
  in an old format is ignored or re-read, never fatal.

## 12. Test strategy

### 12.1 Dev machine (automated and manual, safe)

| Area | Kind |
|---|---|
| Every Convex function (authz, validation, data rules, publishing, signing, device API) | `convex-test` + Vitest (`pnpm test:convex`) |
| Builder ↔ Rust types, signatures, Argon2, hotkeys | shared vector files read by TS and Rust tests |
| `rulebox-policy` envelope and catalogue | `cargo test -p rulebox-policy` |
| Agent: trust, directory, audit sink, rotation, catalogue, installs, cleanup | `cargo test -p rulebox-agent` with `FakeBackend`, `SimPlatform`, `FakeDownloader`, paused time |
| Agent against the real dev deployment | `run --console --simulate` + `enroll --simulate` + `fake_staff` (Steps 9, 13, 14) |
| Dashboard components and screens | Vitest + Testing Library |
| Dashboard flows end to end | Playwright against the dev deployment (Step 19) |
| Load | `scripts/fleet-sim.mjs`, with consent (Step 18) |

### 12.2 VM only (the user runs it)

Real installs and uninstalls, reset folders, signature refusal of a
tampered cache on a real kiosk, offline sign-in with a revoked employee,
and the three Phase 2 re-checks: Step 21. **Never on the dev machine:**
agent `enroll`/`recover`/`unenroll` without `--simulate`,
`service install`, any installer, the test-machine marker.

## 13. Known risks from research

| Risk | Detail | Handling |
|---|---|---|
| Convex Auth is beta (0.0.96) | "may change in backward-incompatible ways"; no TOTP; no setting to close sign-up | Pinned version; sign-up closed in `profile` + `createOrUpdateUser`; own TOTP (Step 3); open question Q2 offers Better Auth |
| Convex Auth tokens in `localStorage` | Any XSS can steal the refresh token | CSP, no HTML injection, short idle timeout, documented mitigation (clear `authSessions`, rotate keys) |
| Ed25519 signing in mutations | Convex's own WebCrypto signing is documented as actions-only | Pure-JS `@noble/ed25519` in the mutation; a deployed check in Step 8 (Stop-and-ask item) |
| `crypto.getRandomValues` in queries/mutations | Seeded per execution, not a secure source | Rule: random only in actions |
| Free tier | 1M calls, 1 GB DB I/O per month | Heartbeat scaling, write-on-change, `deviceReports` split, document only on content change, 5-version history |
| Freeze attack | An attacker who blocks updates keeps a device on an old document | Accepted (no expiry; kiosk must work offline); listed for the user |
| GitHub rate limit for winget | 60 requests/hour unauthenticated | Server-side cache 24 h, optional `GITHUB_TOKEN` |
| winget manifests without a silent switch / user-scope only | Cannot be installed as SYSTEM silently | Refused with a reason at resolve time |
| MSI that needs a reboot or another install running | 3010/1641/1618 | Handled (4.8) |
| `std::process::Child::kill` kills only the installer process | A timed-out installer's child processes may continue | Accepted for Phase 4; noted for Phase 6 (job object) |
| Convex client in Rust has no proxy support | Phase 2 risk | unchanged |
| Two Rust TLS stacks | reqwest 0.13 defaults to rustls + aws-lc | `default-features = false` + `native-tls` |

## 14. Disk and dev environment

- One Cargo workspace, one `target\`; `-p` per crate until Step 22;
  debug builds only; no `--release`.
- pnpm only; no `minimumReleaseAge` bypass.
- Playwright Chromium only, after asking.
- The dev Convex deployment is shared with any test VM enrolled to it:
  never clear tables without the user's consent, never run load or e2e
  seeds without the guard env var, and always delete seeded orgs.
- Secrets created during development (`.tmp/policy-key.seed`, invite
  codes, recovery codes) are never committed; `.tmp/` is gitignored.

## 15. Performance budget and free tier

| Item | Budget | How measured |
|---|---|---|
| Heartbeats | ≤ 432,000 calls/month up to 300 devices (4.9) | arithmetic; Step 18 counts |
| Agent subscription re-runs | one per document change per device | convex-test spy (Step 7, 8) |
| Document size | ≤ 512 KiB; typical 10–60 KiB | publish test |
| DB I/O per org-wide change | ≈ devices × document size × 2 (write + agent read) — 100 devices × 30 KiB ≈ 6 MB | arithmetic; keep org-wide edits rare |
| Dashboard page load | first screen interactive < 2 s on the dev machine; JS ≤ 400 KiB gzip (`vite build` report) | Step 22 |
| Device list | 50 rows per page; `fleet:liveStatus` ≤ 100 ids | tests |
| `verifyEmployee` | < 1.5 s server time (Argon2 ≈ 0.1–0.3 s) | Step 18 / VM |
| Lite mode | the dashboard is not a Lite-mode surface; it honours reduced motion | — |

## 16. Accessibility

- Keyboard: every action reachable; visible focus ring; skip link to
  main content; dialogs trap and return focus (`Dialog` from
  `packages/ui`).
- Semantics: one `<h1>` per screen; tables with `<th scope>`; forms with
  `<label>`; errors via `aria-describedby`; live region for toasts;
  navigation `aria-current="page"`; status never colour alone.
- Contrast ≥ 4.5:1 for text in light and dark.
- Reduced motion: fades only (`lib/motion.ts`).
- 200 % zoom usable; 390 px width usable.

## 17. Hand-off to Phase 5

- The document format has room for new agent-only keys (`policies`,
  `wifi`, `printers`, `lock`, `broadcast`); add them like `catalog` (Rust
  type in `rulebox-policy`, builder in `convex/lib/desired.ts`, vectors).
- Rollout rings and rollback: `desiredStates` keeps 5 versions per
  device; a ring is a set of devices; rollback = publish older content
  under a new version. The publisher's per-device batching is the place
  to add "only devices in ring X".
- Web app permissions editor: `apps.web.permissions` already stored and
  carried in the catalogue.
- `installResults` and the install engine are the model for Wi-Fi /
  printer apply results.

## 18. Definition of done for Phase 4

1. Steps 1–22 **Done when** checks pass; the final report is written.
2. A new organization can be set up from the README alone: deploy,
   owner invite, MFA, signing key, enrollment code, enrolled VM.
3. Every document a device applies is signed and verified; a tampered
   or replayed one is refused on the VM.
4. Employees sign in online through Convex and offline through the
   cache; a disabled employee is locked out on every device after the
   next document, offline included.
5. A winget MSI, a winget EXE and a portable app install silently on
   the VM, and the dashboard shows the per-device result.
6. The audit log shows admin actions and device exit/lockout events.
7. The three Phase 2 re-check items have a VM result.
8. `docs/plans/README.md` Phase 4 row updated; Section 20 handed to the
   user.

## 19. Decisions made in this plan

PRD 21.1 decisions are untouched. These are this plan's own:

| # | Decision | Reason |
|---|---|---|
| D1 | One organization per deployment in the UI; `orgId` on every row; `setup:createOwnerInvite` refuses a second org unless asked (tests and e2e use extra orgs) | PRD 17 puts multi-org in v2; the schema, the membership lookup, MFA and the signing-key table are ready for it (Section 4.6) and cross-org isolation is still tested |
| D2 | Roles Owner / Admin / Viewer with the matrix of 4.6 | PRD 15 |
| D3 | Convex Auth Password provider + our own TOTP gate per session (`mfaSessions`) | Convex Auth has no 2FA; PRD 12.3 requires it for Owner/Admin; keeps the PRD's named auth library |
| D4 | Devices keep the 256-bit secret as credential, plus dashboard-triggered rotation | Convex documents shared-secret checks for service authentication; JWT needs signing infrastructure and token expiry on an open Rust socket is undocumented (Q1 asks the user) |
| D5 | One materialized document per device, signed at write time, 5 versions kept | Cheap agent query, device-bound signatures, history for Phase 5 |
| D6 | Sign the exact payload bytes; no canonical JSON | Removes JS/Rust canonicalizer mismatch (JWS approach) |
| D7 | Ed25519 seed in a Convex env var; `@noble/ed25519` in the publishing mutation | Never in DB or browser (task constraint); atomic sign-and-store |
| D8 | Trust anchored at enrollment; rotation by endorsement; no expiry | No TOFU later; offline devices must keep working |
| D9 | Argon2id with hash-wasm in default-runtime actions, agent parameters | WebAssembly is supported; same parameters as `kdf.rs`; verified by shared vectors |
| D10 | Employee sign-in verified on the server (`verifyEmployee` action), not by shipping hashes to devices | Hashes of all employees never leave the server |
| D11 | Catalogue and allowed employees travel in the signed document; the agent computes each employee's apps | Live updates (`apps.changed`) and offline correctness without extra calls |
| D12 | Group-based install; per-employee grants for web apps everywhere, desktop apps only where installed | A desktop app needs an install the group asked for |
| D13 | Installer by `https://` URL + SHA-256 only; winget resolved on the server; EXE uninstall not supported | CLAUDE.md winget rule; no upload storage in the free tier |
| D14 | Heartbeat interval table of 4.9; online computed in the browser | Free tier; no `Date.now()` in queries |
| D15 | react-router 8 declarative mode, no form/state/UI libraries | Smallest surface for ~15 screens |
| D16 | Optimistic updates only for toggles | Server truth elsewhere |
| D17 | `expectedRevision` on every edit | Two-admin safety |
| D18 | Audit retention 365 days, append-only | Bounded storage on the free tier |
| D19 | Protocol 1.2: `apps.changed`, `session.ended`, `notAllowedHere` | Phase 2 hand-off asked for `apps.changed`; Phase 3 edge case 7 |
| D20 | Reset folders after sign-out for every catalogue desktop app | PRD 5.3 |

## 20. Deviations from the PRD (tell the user)

Do not edit the PRD in this phase; give this list to the user.

| PRD section | Deviation or proposed change | Why |
|---|---|---|
| 12.3 ("2FA required for Owner and Admin") | Implemented as our own TOTP layer on top of Convex Auth, with recovery codes; Viewers optional | Convex Auth has no 2FA |
| 16 ("Convex Auth with 2FA") | Same as above; name the TOTP layer | Gap |
| 12.3 ("signed by an organization key") | One Ed25519 key per deployment, held in a Convex env var, rotated by endorsement; documents bound to device id and version; no expiry | Defines the mechanism; the key lives with the backend, so signing protects against tampering in the DB, in transit and on the device, and against replay/rollback — **not** against someone who controls the Convex deployment |
| 12.3 ("installer manifests are signed") | The installer URL and SHA-256 are inside the signed document; there is no separate manifest | One signature covers both |
| 6 (Custom installer "installer upload") | URL + SHA-256 only in v1 Phase 4; uploads later (Q4) | Free-tier storage; PRD 16 already says R2 |
| 6 (Winget app "agent installs silently") | The server resolves the winget manifest; the agent installs from URL + hash; apps without a silent machine-wide installer are refused | PRD 13.6 #1, CLAUDE.md |
| 5.2 / 6.3 ("apps assigned per group and per employee") | Desktop apps are installed per group; a per-employee desktop grant shows only where the group installs it; web apps per employee work everywhere | An install needs a group scope |
| 10 (desired-state example) | The document also carries `catalog`, `employees`, `offlineDays` (agent-only) and lives inside a signed payload | Needed for apps and offline revocation |
| 11 ("interval 2 → 5 → 10 minutes") | 5 → 15 → 30 → 60 minutes | The free-tier arithmetic of 11.1 |
| 11.1 rule 1 ("one query per screen") | Device lists use a second, tiny `liveStatus` query | Rule 4 requires status to be separate |
| 13.5 ("token and signature checks tolerate small clock differences") | Signature checks do not use the clock at all | Stronger and simpler |
| 13.6 #6 | Implemented: revocation list = the allowed-employees map in each document, plus `credentialRevision` | |
| 15 ("Multi-organization with roles") | Roles now; one org per deployment in the UI | PRD 17 v2 |
| 22.6 ("memory and CPU with the regular heartbeat") | Not reported in Phase 4 (write-only-on-change would make every heartbeat a write) | Contradiction noted in Phase 2 |
| 3.1 ("branding: logo, colors, wallpaper") | Name only in Phase 4 (Q3) | Needs Staff App work and asset delivery |

## 21. Open questions for the user

**Answered by the user on 2026-10-20: the recommended option for Q1 (a), Q2 (a) and Q5 (a); Q3 and Q4 stay deferred.** The plan assumes the **recommended** option.

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q1 | Device authentication ("proper auth in Phase 4") | (a) Keep the device secret, add rotation from the dashboard (D4). (b) Short-lived JWTs minted by an HTTP action (`customJwt`, RS256/ES256) with `set_auth_callback` in the agent | **(a).** It is Convex's documented pattern for services; (b) adds a token signer, JWKS handling and an unverified behaviour (expiry on an open socket) for no gain against an attacker who already has the device secret |
| Q2 | Member auth library | (a) Convex Auth 0.0.96 + own TOTP (D3). (b) Better Auth Convex component 0.12.5 with its two-factor plugin | **(a).** It is what the PRD names; TOTP is small and fully tested here. (b) changes Steps 3–4 |
| Q3 | Branding on devices (logo, colours, wallpaper) | (a) Later (Phase 6 polish). (b) Add to Phase 4 (agent caches the logo, Staff App shows it) | **(a).** Phase 4 is already the largest phase |
| Q4 | Installer uploads | (a) URL + hash only now; uploads with R2 later. (b) Allow small uploads (≤ 50 MB) to Convex file storage now | **(a).** 1 GB storage / 1 GB egress per month is used up by one installer on 20 PCs |
| Q5 | Offline sign-in default | (a) 3 days (PRD 13.6 #6). (b) 7 days | **(a)** |

## 22. Could not be verified

Each item says how it gets settled.

- `@noble/ed25519` signing inside a deployed Convex **mutation** (pure
  JS, should work; Step 8 deploy check).
- `env set` reading a value from stdin (Step 8 records it).
- `defineApp({ env })` exact form on 1.47 (Step 1).
- `@convex-dev/auth` `modifyAccountCredentials` / `invalidateSessions`
  names and contexts; `getAuthUserId` subject format `userId|sessionId`
  for tests (Steps 2, 3).
- Convex Auth sign-in rate limit counted per email or per IP.
- hash-wasm PHC output verifying in the Rust `argon2` crate (Step 5
  vectors).
- `react-router` 8 DOM API location (`react-router` vs
  `react-router/dom`) (Step 4).
- `convex-test` with Vitest 5 projects and the rate-limiter component
  (Steps 1, 12).
- `uqr` `encode()` API (Step 4).
- `yaml` package version (Step 10).
- `reqwest` 0.13.5 `read_timeout` (Step 14).
- raw.githubusercontent.com rate limits (cache + token handle it).
- Whether Convex dashboard logs show function arguments today (we never
  log them ourselves either way).
- Action timeout: docs say 10 minutes on one page and 30 on another;
  nothing here runs longer than 30 seconds.
- Nothing in this plan was compiled or run; every signature is a
  specification.

## 23. Sources

Convex
- https://docs.convex.dev/production/state/limits · https://docs.convex.dev/functions/runtimes · https://docs.convex.dev/functions/actions
- https://docs.convex.dev/database/pagination · https://docs.convex.dev/database/reading-data/indexes/ · https://docs.convex.dev/database/advanced/occ · https://docs.convex.dev/error#1
- https://docs.convex.dev/scheduling/scheduled-functions · https://docs.convex.dev/scheduling/cron-jobs
- https://docs.convex.dev/production/environment-variables · https://docs.convex.dev/database/schemas · https://docs.convex.dev/functions/validation
- https://docs.convex.dev/functions/error-handling/application-errors · https://docs.convex.dev/functions/http-actions · https://docs.convex.dev/search/text-search
- https://docs.convex.dev/testing/convex-test · https://docs.convex.dev/cli · https://docs.convex.dev/cli/local-deployments
- https://docs.convex.dev/client/react · https://docs.convex.dev/client/react/optimistic-updates · https://docs.convex.dev/api/modules/react
- https://docs.convex.dev/auth/overview · https://docs.convex.dev/auth/advanced/custom-jwt · https://docs.convex.dev/auth/functions-auth
- https://raw.githubusercontent.com/get-convex/convex-js/main/CHANGELOG.md · https://news.convex.dev/product-updates-volume-18/
- https://github.com/get-convex/rate-limiter · https://github.com/get-convex/migrations · https://github.com/get-convex/convex-helpers · https://stack.convex.dev/authorization

Convex Auth and alternatives
- https://labs.convex.dev/auth · https://labs.convex.dev/auth/setup/manual · https://labs.convex.dev/auth/config/passwords · https://labs.convex.dev/auth/advanced · https://labs.convex.dev/auth/security · https://labs.convex.dev/auth/api_reference/server
- https://raw.githubusercontent.com/get-convex/convex-auth/main/CHANGELOG.md · https://raw.githubusercontent.com/get-convex/convex-auth/main/src/providers/Password.ts
- https://labs.convex.dev/better-auth/supported-plugins · https://www.better-auth.com/docs/plugins/2fa

Rust client and crates
- https://crates.io/crates/convex · https://docs.rs/convex/0.10.4/convex/struct.ConvexClient.html · https://raw.githubusercontent.com/get-convex/convex-rs/main/CHANGELOG.md
- https://docs.rs/ed25519-dalek/3.0.0/ed25519_dalek/struct.VerifyingKey.html · https://github.com/dalek-cryptography/curve25519-dalek/blob/main/ed25519-dalek/CHANGELOG.md · https://rustsec.org/advisories/RUSTSEC-2022-0093.html
- https://docs.rs/crate/reqwest/0.13.5/source/Cargo.toml.orig · https://docs.rs/argon2/0.6.0/argon2/struct.Params.html

Cryptography
- https://www.rfc-editor.org/rfc/rfc8032 · https://www.rfc-editor.org/rfc/rfc7515.html · https://www.rfc-editor.org/rfc/rfc8785.html · https://www.rfc-editor.org/rfc/rfc6238
- https://github.com/paulmillr/noble-ed25519 · https://github.com/Daninet/hash-wasm/blob/master/lib/argon2.ts · https://github.com/C2SP/C2SP/blob/main/phc-strings.md
- https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html · https://theupdateframework.github.io/specification/latest/
- https://w3c.github.io/webcrypto/ · https://nodejs.org/api/crypto.html

Windows installs and winget
- https://learn.microsoft.com/en-us/windows/win32/msi/command-line-options · https://learn.microsoft.com/en-us/windows/win32/msi/error-codes
- https://learn.microsoft.com/en-us/windows/package-manager/winget/troubleshooting · https://learn.microsoft.com/windows/package-manager/winget/source
- https://github.com/microsoft/winget-pkgs/tree/master/doc/manifest/schema · https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api

Dashboard
- https://reactrouter.com/upgrading/v7 · https://reactrouter.com/start/modes · https://playwright.dev/docs/test-webserver · https://vitest.dev/config/environment
- https://developers.cloudflare.com/pages/configuration/headers/ · https://developers.cloudflare.com/pages/configuration/serving-pages/ · https://vercel.com/docs/project-configuration/vercel-json
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors · https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog · https://gsap.com/docs/v3/GSAP/gsap.matchMedia()
- https://pnpm.io/settings/dependency-resolution


