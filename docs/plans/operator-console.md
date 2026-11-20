# Operator console: plan (2026-11-21)

Status: **plan only. Nothing here is built.** Build slot: after the Phase 6
pilot, as hosted phase H2 (after H1, "pooled data plane readiness").

> **For the implementing agent.** Read `CLAUDE.md` first, then
> `tenant-admin-panel-recommendation.md` and
> `post-phase-5-architecture-and-io.md` (called **5b** below). Those two files
> already decide the architecture. This file does not re-open them. It adds
> the product: what staff can configure, how that stays safe and simple, the
> data model, the platform API additions and the build steps. Where this file
> wants to change 5b, the change is listed in Section 3 ("Proposed changes")
> and needs the owner's yes before it is built.
>
> **Six rules override everything else in this file:**
>
> 1. **The console cannot touch tenant data and cannot publish.** No signing
>    key, no master key, no employee data, no file names, no audit contents.
>    Metadata only, through `/platform/v1/...` (5b rule 5, CR-2, CR-4).
> 2. **The data plane holds the truth it enforces. The console holds the
>    authoring.** If the console is down, every tenant keeps working and every
>    time limit (trial end, support access, deletion grace) still ends on time.
> 3. **Tenants read their entitlements from one small row they already read.**
>    No join, no extra query, no timer (Section 6.4).
> 4. **Console screens never read the data plane live.** They read the
>    console's own database. The data plane is touched by a nightly sync, by
>    small events, and when an operator saves a change (Section 10).
> 5. **No JSON, no raw numbers without a unit, no free-form HTML.** Every
>    setting is a typed form field built from the entitlement registry
>    (Section 6.2).
> 6. **Every change is a change request** with a preview, a reason, a history
>    row and (where possible) a one-click reverse (Section 6.8).

Research date for every price, limit and product fact: **2026-11-21**. Items
marked **(unverified)** could not be confirmed from a primary source. Every
I/O number is an **estimate** made with the formulas of 5b Section 1.2
(`read = bytes + 64`, `write = bytes + (indexes + 2) x 64`).

---

## 0. Summary

The operator console is the back office of the hosted Rulebox service. Two or
three Rulebox staff use it at `admin.<domain>`. Most of them are **not
technical**. They must be able to give and take features, change limits, run
trials, suspend and restore tenants, post announcements, edit e-mails, answer
support requests and watch costs, without being able to break a tenant or read
a tenant's data.

The plan in one paragraph: a **registry** in code describes every limit and
feature once (name in plain words, unit, safe range, risk, what happens when it
is taken away). The console builds all its forms from that registry. **Plans**
are named bundles of registry values. A tenant's **effective entitlements** are
worked out when an operator saves, and stored as one small row in the data
plane, so reading them costs the tenant nothing extra. Every edit is a **change
request**: it shows who is affected before saving, asks for a reason, can be
scheduled, may need a passkey touch or a second person, lands in the audit log
and can be reversed. The console keeps its own copy of tenant metadata
(refreshed nightly and by small events), so its lists, search and previews cost
the shared data plane about **6 MB of database I/O a month for 220 tenants
(about 0.6 % of the free 1 GB)**.

Five findings from the research that change details of 5b (all in Section 3):

- Convex **custom domains need the Pro plan**, so `admin.<domain>` can only
  serve the console's static files. The control-plane backend stays on its
  `*.convex.cloud` address. Cloudflare Access therefore protects the page, not
  the backend. The passkey sign-in inside the app stays the real lock.
- Convex plan limits are listed **per team**. A control-plane project in the
  same free team would eat the same 1 GB and 1 M calls as the tenants. Put it
  in a **separate Convex team**.
- Cloudflare Access cannot require a FIDO2 key for a normal web app by itself
  ("PIV and FIDO2 key authenticators only work with infrastructure
  applications"). The hardware factor is the console's own passkey.
- Resend's free plan is **100 e-mails a day, 3,000 a month**. One announcement
  to every tenant could use the whole day and block PIN-reset mail. Bulk mail
  needs a daily budget and a queue.
- Cloudflare's free WAF has **one rate-limit rule, by IP, 10-second window**.
  It protects the static sites only. Convex-side rate limits stay the control.

---

## 1. Goals and non-goals

### 1.1 Goals

| # | Goal | How it is checked |
|---|---|---|
| G1 | Non-technical staff can do every daily task without help from a developer | Usability test in Step K13: a non-technical person completes 12 set tasks alone |
| G2 | Everything commercial is configurable: plans, limits, features, trials, messages, e-mails | No task in Section 7 needs a code change or the command line |
| G3 | No single mistake hurts many tenants | Preview, risk tiers, second person, scheduling, reverse (Section 6) |
| G4 | No single compromise gives tenant data or a policy push (the sentence from the recommendation file) | Section 11; pen test before the first paying tenant |
| G5 | The console costs the shared data plane almost nothing | I/O budgets of Section 10 enforced by tests |
| G6 | Tenants keep working when the console is down | Rule 2; test in Step K2 |
| G7 | Every action is on the record, in words a person can read | Operator audit log, hash-chained, exported off the box |

### 1.2 Non-goals

- **Not a way into tenant data.** No "log in as customer". No list of a
  tenant's employees, devices by name, files or audit rows. Support looks at a
  tenant only through consented, time-boxed, read-only support access, in the
  customer dashboard, not in the console.
- **Not a publisher.** The console never changes a device's desired state. It
  cannot send a message to kiosk screens. Announcements go to dashboards and
  by e-mail only.
- **Not a billing system.** It records plan, trial and "paid until". Cards,
  invoices and tax belong to a payment provider chosen later (Q7).
- **Not a marketing tool.** Service messages only. No newsletters, no
  campaigns that need consent and unsubscribe handling.
- **Not a general internal-tool builder** (Retool-style). Fixed screens, fixed
  actions. Staff cannot write queries or scripts.
- **Not for self-hosters.** A self-hosted deployment has plan `custom`, no
  limits, and no platform API routes (`RULEBOX_HOSTED` unset).
- **No visual design here.** Colours, layout and styling come from a separate
  design pass. This plan only says what each screen must hold.

---

## 2. What is already decided (inherited, not re-opened)

| Decision | Source |
|---|---|
| Separate app, origin, Convex deployment and sign-in from the customer dashboard | Recommendation file rule 1; 5b CR-1 |
| Console holds no signing, sealing or master key; has no publish function | 5b rule 5, CR-2 |
| Reaches the data plane only through signed `/platform/v1/...` HTTP actions; never a deploy key | 5b 4.5 |
| Request signing: Ed25519, key id, timestamp within 60 s, nonce, operator id, body hash | 5b 4.5 |
| Passkeys only for operators; sessions at most 8 h, 15 min idle; step-up for dangerous actions | 5b CR-7, CR-8 |
| Two-person rule; break-glass credential; hash-chained audit log exported off the box | 5b CR-9, CR-11, CR-12 |
| Support access: consented by the tenant Owner, at most 60 min, read-only, in both audit logs | 5b CR-5 |
| Pooled tenants in one data plane; per-organization limits (`orgPlans.limits`); limits are a **copy** per tenant, never changed silently when a default changes | 5b 3.1 |
| Suspended and over-limit devices stay locked on their last signed document. Never unlock to save resources | 5b rule 4, 3.2 |
| Stay on the Convex free plan until there are real outside tenants; default ping 30 min, editable globally and per tenant; storage pool starts with one account | 5b owner decisions 2026-10-27 |
| Domains: site on the main domain, customer dashboard on `app.<domain>`, console on `admin.<domain>` (replaces `console.<domain>` in 5b 5.1) | Owner, 2026-11-21 |
| Cloudflare for DNS, Access in front of `admin.`, Turnstile, WAF and rate limits; site hosted on Cloudflare | Owner, 2026-11-21 |
| `apps/console/`: Vite + React + TS, reuses `packages/ui`, carries a clear "Operator" marker | Owner, 2026-11-21 |

What exists in the code today (2026-11-21): `orgPlans`, `platformSettings`
(global ping interval and plan defaults for the fixed plans `free`, `team`,
`custom`), `platformSecrets` / `platformFlags` / `platformAudit` (Resend
settings), and CLI-only operator functions in `convex/plans.ts` and
`convex/platform.ts`. **Not built yet:** the `/platform/v1` routes,
`organizations.publicId`, `orgUsageDaily`, hosted sign-up, the storage pool,
support access, and anything under `apps/console/`. Those that belong to phase
H1 are listed as prerequisites in Section 13.

---

## 3. Proposed changes to earlier plans (need the owner's yes)

Each row is a place where this plan differs from 5b or the recommendation
file, with the reason.

| # | Change | Was | Why |
|---|---|---|---|
| PC-1 | **Plans become data, not code.** A `planCatalog` table replaces the fixed `free` / `team` / `custom` union and `platformSettings.planDefaults` | 5b 3.1: three fixed plans | The owner wants plans and tiers configurable by staff. A fixed union needs a developer for every new tier. `free` and `custom` stay as two built-in rows that cannot be deleted |
| PC-2 | **Feature flags join limits** in the same per-tenant row (`orgPlans.features`), described by one registry | 5b: limits only | "Give and take features" needs booleans as well as numbers. One row keeps the read cost unchanged |
| PC-3 | **The console keeps a tenant directory** (metadata mirror), refreshed nightly and by events. Lists, search and previews run on it | 5b Step C3: proxied pages, "do not store tenant metadata longer than 24 h" | Every proxied list page costs data-plane I/O and function calls, and cannot be sorted or searched server-side across planes. The mirror holds only what `GET /tenants` may return, and no row is older than about 26 h. The spirit of the 24 h rule is kept; the letter is not |
| PC-4 | **Events from the data plane ("ping, then pull").** A small outbox in the data plane; a signed "there is news" call to the control plane; the control plane pulls | 5b: console learns state only when it asks | Trial ends, tenant self-deletes and support approvals happen without the console. Polling would break the "no polling loops" rule and cost calls |
| PC-5 | **Nonce only on writes.** `GET` routes rely on the signature and the 60 s window | 5b 4.5: nonce on every request | A nonce costs one insert (about 0.3 KB) per call. Replaying a metadata `GET` within 60 s gains nothing. Halves the writes of the API |
| PC-6 | **Roles are capability sets, not a ladder:** Owner, Support, Billing, Read-only | 5b CR-10: `viewer < support < admin < owner` | The owner asked for a billing role. Billing and support are side by side, not above and below. The old `admin` duties are split between Support and Billing, each behind risk tiers |
| PC-7 | **New platform API routes** (Section 10.2). 5b 4.5 says "exact list; nothing else exists" | 12 routes | Plans, notices, mail templates, events, directory, tenant create and contact need routes. Each new route is added to the deny-list leak test and the authorization table |
| PC-8 | **Control plane in its own Convex team** | 5b 5.1: "a separate Convex project" | Convex lists plan limits per team. A second project in the same free team shares the tenants' 1 GB and 1 M calls. A separate team also separates who can open which Convex dashboard. Community reports say an account may admin at most two free teams **(unverified)** |
| PC-9 | **Access is the outer door only; do not rely on it for the hardware key.** Access policy: named e-mails, country, short session. The passkey (user verification required) is checked by the console's own backend | 5b CR-6: "Cloudflare Access with SSO and a hardware key" | Cloudflare documents that FIDO2 authenticators in its independent MFA "only work with infrastructure applications". An identity provider that reports the MFA method could do it, but that adds a paid IdP |
| PC-10 | **Bulk e-mail has a daily budget and is queued in the data plane** | not planned | Resend free: 100 a day, 3,000 a month, no queue on their side. PIN-reset mail must never be starved |
| PC-11 | **Time limits end in the data plane by themselves** (trial, timed override, support access, deletion grace) using a scheduled function per item plus a daily safety sweep | 5b: operator edits only | Rule 2. A trial must not run on because the console was down |
| PC-12 | **Shorten `orgUsageDaily` in the data plane to 35 days;** the console keeps 90 days daily and monthly totals after that | 5b 2.8: 400 days in the data plane | Storage on the free plan is 0.5 GB and each index is a second copy. History belongs where it is read |
| PC-13 | **Single-operator period: a waiting time replaces the second person** (Section 6.14) | 5b Q8: two-person rule "waits" | A rule that is switched off protects nothing. A 24 h delay with an alert is weaker than a second person but better than none |

---

## 4. Users and roles

### 4.1 Who uses it

| Person | Typical tasks | Technical? |
|---|---|---|
| **Owner** (the founder) | Everything. Plans and prices, operators, keys, storage accounts, kill switch | Yes |
| **Support** | Find a tenant, see why something is blocked, extend a trial, raise a limit for a while, request support access, suspend for abuse, post a notice | No |
| **Billing** | Move a tenant to a plan, start and end trials, record "paid until", suspend for non-payment, send payment reminders | No |
| **Read-only** (an accountant, an auditor, a new hire in training) | Look, export lists, read the audit log | No |

Two or three humans at first. No shared accounts. Every operator has their own
passkeys (at least two, so a lost device is not a lock-out).

### 4.2 What each role may do

"Tier" is the risk tier of Section 6.9. "2P" means a second person must
approve.

| Area | Read-only | Support | Billing | Owner |
|---|---|---|---|---|
| See tenants, usage, plans, audit log | yes | yes | yes | yes |
| Notes and tags on a tenant | no | yes | yes | yes |
| Raise a limit or turn a feature on for one tenant (inside the plan's safe range, timed) | no | yes (Tier 1) | yes (Tier 1) | yes |
| Lower a limit, turn a feature off, permanent override | no | yes (Tier 2) | yes (Tier 2) | yes |
| Change a tenant's plan; start, extend, end a trial | no | extend only, up to 14 days | yes (Tier 2) | yes |
| Record "paid until", billing notes | no | no | yes | yes |
| Suspend / restore a tenant | no | yes, reasons "abuse", "security", "customer asked" (Tier 2) | yes, reason "non-payment" (Tier 2) | yes |
| Create a tenant for a customer | no | yes (Tier 2) | yes (Tier 2) | yes |
| Delete a tenant (starts the 30-day grace) | no | request only | request only | yes (Tier 3, 2P) |
| Create or edit a plan; roll a plan change out to its tenants | no | no | draft only | yes (Tier 3, 2P above 25 tenants) |
| Announcement to one tenant | no | yes (Tier 1) | yes (Tier 1) | yes |
| Announcement to many or all; maintenance mode | no | yes (Tier 2) | no | yes |
| Edit e-mail wording | no | draft only | draft only | yes (Tier 2; Tier 3 for security e-mails) |
| Send "contact the owner" e-mail to one tenant | no | yes | yes | yes |
| Request support access; end a session | no | yes (Tier 2) | no | yes |
| Saving mode (degrade level) | no | levels 1-2 | no | all (level 5: Tier 3, 2P) |
| Platform switches (sign-ups open, default plan, check-in time) | no | no | no | yes (Tier 2 or 3) |
| Storage accounts and their credentials | no | no | no | yes (Tier 3) |
| Operators, roles, passkeys, platform key rotation | no | no | no | yes (Tier 3, 2P) |
| Approve someone else's request | no | if marked "approver" | if marked "approver" | yes |

Rules:

- Roles are enforced on the server by the `operatorQuery / operatorMutation /
  operatorAction` wrappers (CR-3). The screen only hides what the server would
  refuse.
- "Approver" is a switch on an operator, set by the Owner. Nobody approves
  their own request.
- A role change, a new operator and a removed operator are Tier 3.
- The role list is short on purpose. Stripe's dashboard has more than twenty
  roles and warns that combined roles give "unintended authority". With three
  people, four roles are enough.

---

## 5. UX principles for non-technical staff

These are requirements, not taste. Each has a check. Visual design is out of
scope; the rules say what a screen must contain and how it must behave.

| # | Principle | What it means in the console | Check |
|---|---|---|---|
| U1 | **Plain words** | No field name from the database is ever shown. `maxDevices` is "PCs allowed". `pingIntervalMs` is "How often PCs check in". `degradeLevel` is "Saving mode". The vocabulary table (5.1) is the single source | A test fails when a registry entry has no label, help text or unit |
| U2 | **Human units** | Minutes, hours, days, GB. Never milliseconds or bytes. "No limit" is a switch, not the number 1,000,000,000 | Registry `unit` drives the control |
| U3 | **No JSON, no code, no free HTML** | Every value is edited with a typed control: number with stepper and range, switch, choice list, date picker, text with a length counter | No `textarea` bound to a structured value anywhere |
| U4 | **Presets before custom** | Each field offers named choices first ("Every 30 minutes (standard)"). "Custom" is the last choice. Common jobs are one-click recipes (6.13) | Recipes cover the 12 usability tasks |
| U5 | **Show who is affected before saving** | Every save opens a review step: what changes (before and after, in words), which tenants, how many would go over a limit, what the tenant will see, what it costs in I/O | No mutation without a preview object (6.10) |
| U6 | **Confirm in proportion to risk** | Tier 1: one button. Tier 2: reason + passkey touch. Tier 3: type the tenant's name, second person, optional delay | Section 6.9 |
| U7 | **Reverse, don't fear** | History on every tenant and plan with "Reverse this change". Things that cannot be reversed say so in the review step, in the first line | 6.12 |
| U8 | **Schedule instead of staying up late** | "Apply now" or "Apply on a date". Scheduled changes are listed, can be moved, cancelled or applied now | 6.11 |
| U9 | **Safe defaults** | New switches default to the safer side. New limits default to the plan's value. A timed grant defaults to 30 days, not forever | Registry `default` and `safeRange` |
| U10 | **Guardrails make danger slow** | Dangerous actions are never the primary button, never in a bulk menu, never reachable by one click from a list. Lowering is harder than raising. Deleting needs "suspended" first | Role and tier tests |
| U11 | **Explain every "no"** | A disabled control says why and who can do it: "Only the Owner can change this" or "Needs a second person: ask Sara" | No disabled control without a reason string |
| U12 | **Help next to the field** | One sentence under each field. "What happens to the customer?" expands to show the tenant's side, with the exact message they see | Registry `help` and `tenantEffect` required |
| U13 | **Search everything** | One search box: tenants (name, public id, e-mail domain), settings by plain name, recipes, help | Server-side search on the console's own database |
| U14 | **One tenant, one page** | Everything about a tenant is on its page: status, plan, limits with usage bars, features, trial, notices, support access, notes, history | Section 7 |
| U15 | **Status in a sentence** | The top of a tenant page reads like a person wrote it: "On the Team trial until 5 December. 12 of 50 PCs. Nothing needs attention." | Generated from state by rules, tested with fixtures |
| U16 | **Never confuse it with the customer dashboard** | A fixed "Operator console" label on every screen and in the browser tab title, plus the environment name ("Live" or "Practice"). Different host. Different sign-in. Exact look: design pass | Present in the shell component; e2e asserts it |
| U17 | **A safe place to learn** | "Practice" environment: the same console against a test data plane with made-up tenants. New staff train there. The environment name is always visible | Step K13 |
| U18 | **Errors that help** | "The customer changed something at the same time. Here is what is different now." Never a code alone | Error map reviewed in K13 |
| U19 | **Lists are server-side** | Sorting, search, filters and pages happen in the query (CLAUDE.md). Reuse the generic server table from Phase 4b, moved into `packages/ui` (the console must not import dashboard code, CR-1) | I/O budget rows |
| U20 | **Accessible and keyboard-friendly** | Labels, focus order, readable errors, no colour-only meaning. Staff with a screen reader can do every task | axe checks in e2e |

Borrowed from real tools: LaunchDarkly lets an environment "require a comment
before saving" and "require entering the name of the environment before
saving"; Unleash gives change requests the states draft, in review, approved,
scheduled, applied; Stripe recommends keeping a customer's entitlements in
your own database "for faster resolution"; Zendesk lets the customer's admin
grant support access for a set time and tells all admins when it is on.
Sources in Section 18.

### 5.1 Vocabulary (the start of the single source)

| In the database | Staff see | Unit / control |
|---|---|---|
| `orgPlans.plan` | Plan | choice |
| `limits.maxDevices` | PCs allowed | number, "No limit" switch |
| `limits.maxEmployees` | Staff accounts allowed | number |
| `limits.maxApps` | Apps allowed | number |
| `limits.maxGroups` | Groups allowed | number |
| `limits.maxMembers` | Dashboard users allowed | number |
| `limits.auditRetentionDays` | Activity history kept for | 30 / 90 / 365 days |
| `limits.storageQuotaBytes` | Installer storage | GB |
| `limits.maxUploadBytes` | Largest single upload | MB / GB |
| `limits.maxEnrollmentCodesActive` | Setup codes at one time | number |
| `limits.watchMode` | Live view of one PC | switch |
| `pingIntervalMs` | How often PCs check in | 5 / 15 / 30 / 60 min, custom |
| `status = suspended` | Paused | — |
| `status = pendingDeletion` | Being deleted (restorable until a date) | — |
| `degradeLevel` | Saving mode | Off, Watchful, Slow, Defer, Closed, Frozen |
| `deviceCredentials.state = overLimit` | PCs over the plan (kept locked, not updated) | — |
| `expectedRevision` conflict | "Someone changed this while you were editing" | — |

---

## 6. The configuration model

### 6.1 Four kinds of setting

| Kind | Example | Scope | Lives (truth) | Edited in |
|---|---|---|---|---|
| **Entitlement** | PCs allowed; Hosted installers on/off | per tenant, from a plan plus overrides | data plane, `orgPlans` | tenant page, plan page |
| **Platform switch** | Sign-ups open; default plan for new sign-ups; standard check-in time; saving mode; maintenance | whole service | data plane, `platformSettings` | Platform screen |
| **Content** | Announcements; e-mail wording; suspension messages | whole service or an audience | authoring in the control plane, published copy in the data plane | Messages, E-mails |
| **Console setting** | Operators, roles, approval rules, alert addresses, recipes | console only | control plane | Team, Settings |

The split rule (answers "console deployment or data plane?"):

> If the data plane must **enforce** it, or a tenant screen must **show** it,
> the published value lives in the data plane. Drafts, schedules, approvals,
> reasons, notes and history live in the control plane. Secrets a tenant flow
> needs (Resend key, storage credentials) live in the data plane, sealed, and
> are never readable by the console after saving.

Full table in Section 8.

### 6.2 The entitlement registry

One typed list in code, in the data plane (`convex/lib/entitlements.ts`), also
exported to `packages/types` so the console uses the same list. Adding a limit
or a feature is one registry entry plus the enforcement code. The console form
appears by itself.

Each entry has:

| Field | Purpose |
|---|---|
| `key` | stable id, e.g. `maxDevices`, `hostedInstallers` |
| `kind` | `limit` (number), `feature` (on/off), `level` (choice) |
| `label`, `help`, `tenantEffect` | plain words (U1, U12) |
| `unit`, `presets`, `min`, `max`, `allowUnlimited` | the control and its hard bounds |
| `safeRange` | values Support may grant without the Owner (Tier 1) |
| `defaultWhenMissing` | value for tenants whose row has no such field yet (so a new entry needs no backfill) |
| `risk` | tier when raised and when lowered (lowering is never below Tier 2) |
| `onRevoke` | what taking it away does: `freeze` (existing set-up keeps working, cannot be changed) or `withdraw` (removed from devices at the next publish) or `blockNew` (limits: nothing is deleted, creating more is refused) |
| `neverWithdraw` | true for anything that keeps a PC locked. **Lockdown is never an entitlement** (5b rule 4) |
| `enforcedIn` | the function that enforces it (for the authorization and I/O tests) |
| `ioNote` | one line on the I/O effect, shown in the review step for cost-relevant entries (check-in time, history kept, live view) |

Starter list. Limits exist today. The feature entries are **proposals for the
registry, not a packaging decision** (Q3):

| Key | Kind | On revoke |
|---|---|---|
| `maxDevices`, `maxEmployees`, `maxApps`, `maxGroups`, `maxMembers`, `maxEnrollmentCodesActive` | limit | `blockNew`; PCs over the limit become "over the plan" (5b 3.2) |
| `storageQuotaBytes`, `maxUploadBytes` | limit | `blockNew` |
| `auditRetentionDays` | level | history beyond the new value is pruned after a 7-day warning window |
| `pingInterval` | level | applies at each PC's next check-in |
| `watchMode`, `checkNow` | feature | `withdraw` (dashboard only) |
| `hostedInstallers` (upload installers) | feature | `freeze`: installed apps stay, no new uploads |
| `serverManagedUpdates` (update feeds, Phase 6) | feature | `freeze`: apps stay on their current version |
| `rolloutRings` | feature | `freeze` |
| `wifiPrinterProfiles` | feature | `freeze` |
| `deviceLockAndMessages` (lost-device lock, broadcasts) | feature | `blockNew`; **an active device lock is never lifted by a plan change** |
| `auditExport` | feature | `withdraw` |
| `supportLevel` | level (community / e-mail / priority) | console-side label only |

Rules for "give and take":

- Taking a feature away **never deletes the tenant's set-up**. It is kept and
  shown as "Not in your plan". Giving it back restores it.
- Taking away never unlocks, never uninstalls an app from a PC, never lifts a
  lock.
- The dashboard hides or locks the feature and says "Not in your plan.
  Contact us." The server refuses the call with `plan_limit` either way. The
  screen is a courtesy; the server is the rule.

### 6.3 Plans

A plan is a named bundle: one value for every registry entry, plus a name,
a short description, "shown to customers" yes/no, and a state.

| State | Meaning |
|---|---|
| Draft | being edited in the console; not in the data plane |
| Live | published to the data plane; can be given to tenants |
| Retired | no new tenants; tenants on it keep it ("grandfathered") |

- Two built-in plans cannot be deleted: `free` (the sign-up default) and
  `custom` (self-host and hand-made deals).
- Editing a live plan creates a **new version**. Saving it changes what **new**
  tenants on that plan get. Existing tenants are **not** changed (5b 3.1).
- "Apply to existing tenants" is a separate, explicit action (a rollout,
  6.11) with its own preview: "214 tenants are on Team. 197 follow the plan.
  17 have their own values and are skipped. 3 would go over the new limit."
- A rollout that only raises values is Tier 2. One that lowers anything is
  Tier 3.
- "Duplicate plan" is the way to make a new tier. Start from a plan that
  works.
- At most 20 plans. More is a sign that overrides are being used as plans.

### 6.4 How a tenant reads its entitlements (the cheap part)

**Resolved at write time, read as one row.** When an operator saves, the data
plane works out the final value of every entry (plan value, then that
tenant's overrides) and stores the result in the tenant's `orgPlans` row:
`limits` (as today), `features` (new), `planKey`, `planVersion`, `trial`,
`overrides` (keys and expiry only), `notice`. About 0.9 KB.

| Reader | What it reads | Extra cost because of this plan |
|---|---|---|
| Dashboard shell (`account:me` / `settings:plan`) | the `orgPlans` row it already reads | none (row grows by about 0.3 KB) |
| Create mutations (add PC, employee, app...) | `orgPlans` + `orgStats`, as today | none |
| A feature check in a member function | the same `orgPlans` row, loaded once per call by the wrapper | none when the wrapper already loaded it; else 1 read, about 1 KB |
| Device ping | **never** reads `orgPlans` (5b 3.2). It reads `deviceCredentials.state` and the interval already pushed to `deviceLiveness` | none |
| Publisher | reads `orgPlans` once per publish **run**, not per device | about 1 KB per run |
| Agent | nothing. Features reach a PC only as part of its signed document | none |

Why this is cheap and safe:

- The row changes only when an operator acts or a time limit ends. So the
  live queries that read it re-run only then. Nothing ticks (5b rule 2).
- No query ever joins plan + override + default. That work is done once, by
  the writer.
- A missing field means `defaultWhenMissing`. New registry entries need no
  migration write to every tenant.
- Stripe gives the same advice for its Entitlements product: "We recommend
  you persist these entitlements internally for faster resolution."

Cost of one change to one tenant: about **5.5 KB and 4 writes** in the data
plane (Section 10.3), plus one re-run of that tenant's open dashboards.

### 6.5 Overrides (one tenant differs from its plan)

- An override is one registry key, a value, a **reason** (required) and an
  **end date** (default 30 days; "no end date" is Tier 2).
- The tenant page shows overridden fields with a marker and the reason:
  "5 extra PCs until 20 December: waiting for their order (Sara)".
- When an override ends, the plan value returns. The data plane does this
  itself (PC-11). If the tenant then uses more than the limit, the normal
  over-limit rules apply, and a warning e-mail goes out 7 days and 1 day
  before.
- At most 20 overrides per tenant. A tenant that needs more gets the `custom`
  plan.
- Reasons and who granted them live in the control plane. The data plane
  stores only key and expiry.

### 6.6 Trials

A trial is "this plan until this date, then that plan".

- Start: recipe "Start a 14-day Team trial". Length presets 7 / 14 / 30 days.
- The data plane stores `trial { planKey, endsAt, thenPlanKey }` and schedules
  the end itself.
- E-mails 7 days and 1 day before the end (templates, Section 7.8). The
  dashboard shows a banner with the days left (worked out in the browser from
  `endsAt`; nothing is written daily).
- Extend: one click, up to 14 days for Support, any length for Billing and
  Owner. One trial per tenant per plan unless the Owner says otherwise.
- Convert: "Trial went well: keep the plan" removes the end date.
- At the end, the tenant falls back to `thenPlanKey` (default `free`). PCs
  over the free limit become "over the plan": locked as they are, not updated.
  The review step says this in words before a trial is started.

### 6.7 Upgrades and downgrades

- Upgrade: applies at once. Over-limit marks are cleared by the existing
  `plans:applyLimits` job.
- Downgrade: Tier 2. The review step lists what the tenant would lose and what
  would go over ("They use 12 PCs; the new plan allows 5; 7 PCs would stop
  getting updates"). Default is "apply at the end of the paid period" when a
  "paid until" date exists, else "apply now".
- Until a payment provider exists, upgrades start from the tenant's "Contact
  us" e-mail (5b 3.4). With a provider, its webhook creates the change request
  (Q7).

### 6.8 Every change is a change request

One object in the control plane, the same for a limit, a plan, a suspension, a
notice or an e-mail template.

```
Draft -> (Waiting for approval) -> (Scheduled) -> Applying -> Applied
                |                       |             |
             Rejected               Cancelled       Failed -> retry or cancel
                                    Needs review (the target changed meanwhile)
Applied -> Reversed (by a new change request that points back at it)
```

A change request holds: what kind, the target, the typed "before" and "after",
a sentence that describes it, the preview that was shown, the reason, who
asked, who approved, when to apply, the result, and a link to the audit rows.
It never holds a secret (credentials are sealed in the browser and sent
straight through; the request keeps only "credentials replaced").

Delivery to the data plane is **exactly once in effect**: every write carries
the change id, and the data plane remembers applied ids for 7 days, so a retry
after a timeout cannot apply twice. Every write also carries
`expectedRevision`; if the tenant's row moved, see 6.11.

### 6.9 Risk tiers

| Tier | Examples | What the operator must do |
|---|---|---|
| 0 Look | open a tenant, export a list | nothing (viewing a tenant is still logged) |
| 1 Routine | add a note; raise a limit inside the safe range for up to 30 days; extend a trial by up to 14 days; notice to one tenant; send a test e-mail | review step, one confirm |
| 2 Careful | lower a limit; feature off; plan change; suspend; restore; create a tenant; notice to many; edit an e-mail; request support access; saving mode 1-4; platform switches | review step + reason + passkey touch (step-up no older than 5 minutes) |
| 3 Dangerous | delete a tenant; plan rollout that lowers anything or touches more than 25 tenants; any bulk action over 25 tenants; edit a security e-mail (PIN reset, sign-in code, invite); storage credentials; operators and roles; key rotation; saving mode 5; maintenance mode | all of Tier 2 + type the name + a second person approves (or the waiting time of 6.14) |

The tier comes from the registry and the action type, worked out on the
server. A request is always treated at the highest tier of anything in it.
"Lowering" is decided by comparing before and after, not by what the operator
says.

### 6.10 The preview ("who is affected")

Every review step shows a preview object made on the server:

| Part | Example |
|---|---|
| The change in words | "PCs allowed: 50 -> 20" |
| Who | "1 tenant: Acme Dental" or "214 tenants on Team (17 skipped: they have their own value)" |
| What breaks | "Acme Dental uses 32 PCs. 12 would be over the plan: they stay locked and stop getting updates." |
| What the customer sees | the exact banner text and e-mail (rendered with their plan name and dates) |
| Cost | for cost-relevant entries: "Checking in every 5 minutes instead of 30 costs about 6 MB more I/O per PC per month. For this tenant: about 190 MB, 19 % of the monthly allowance." (constants from `io-model.mjs`) |
| Can it be reversed? | "Yes, from History" or "No: sent e-mails cannot be recalled" |
| Who else must agree | "Needs a second person" |

Where the numbers come from, to protect the data plane's budget:

- **One tenant:** one live `GET /platform/v1/tenants/:id` (about 1.8 KB), so
  the preview is exact.
- **Many tenants:** the console's own directory (PC-3), which is at most a day
  old. The preview says "counts as of last night". The data plane re-checks
  each tenant when it applies, and the result report shows the real numbers.

### 6.11 Scheduling and rollouts

- Any Tier 1-3 change can be "Apply now" or "Apply on <date and time>". Times
  are shown in the operator's time zone with the tenant's time zone beside it
  when known.
- Scheduled changes are run by the **control plane's** scheduler (one
  scheduled function per change; no polling). Time limits that must hold even
  if the console is down are the data plane's job (PC-11).
- Just before applying, the control plane fetches the target again. If the
  fields this change touches are unchanged, it applies. If they changed, the
  request goes to **Needs review** and the requester is told. (Unleash does
  the same: a scheduled change is suspended when its target was updated.)
- Approval is given for the content. Editing a waiting request cancels its
  approvals.
- **Rollouts** (one change to many tenants) run in the data plane in batches
  of 50 tenants, starting with a **canary**: the first 5 tenants, then a
  pause of 10 minutes (or until the operator clicks "Continue"). A rollout can
  be paused and can be reversed for the tenants already done. Tenants with
  their own value for a key are skipped for that key.
- Blackout rule: no scheduled Tier 3 change applies while saving mode is 3 or
  higher.

### 6.12 Undo

| Kind of change | Reverse |
|---|---|
| Limit, feature, plan, trial, override, platform switch, saving mode | "Reverse this change" makes a new request with before and after swapped. Same tier as the original direction would have (reversing a raise is a lowering) |
| Suspend | Restore |
| Delete (grace period) | Restore, for 30 days. After the purge: **cannot be undone** |
| Notice | Withdraw (disappears from dashboards at once) |
| E-mail template | Restore an earlier version (every save is a version) |
| E-mail already sent | **Cannot be undone.** A queued bulk send can be stopped; the count already sent is shown |
| Storage credentials | Add the old ones again (the console never has them) |
| Operator removed | Invite again (new passkeys) |

Also: after any Tier 1 save, an "Undo" action stays on screen for 30 seconds
and in History for 30 days. A reverse is refused with an explanation when the
target has changed since (the operator sees both versions and decides).

### 6.13 Recipes (presets for whole jobs)

A recipe is a named, typed list of steps with a few blanks. It ends in the
same review step as a hand-made change. Recipes are defined in code at first;
the Owner can save any applied change as a recipe ("Save as recipe") with
which blanks stay open.

Starter set:

| Recipe | Blanks | Tier |
|---|---|---|
| Start a trial | plan, days | 2 |
| Extend the trial | days | 1 (up to 14) |
| Keep the plan after the trial | — | 2 |
| Upgrade / move to a plan | plan, when | 2 |
| Extra PCs for a while | how many, until | 1 inside safe range |
| More storage for a while | GB, until | 1 inside safe range |
| Real-time check-in for a week (troubleshooting) | until | 2 (shows the cost) |
| Pause for non-payment | paid-until date | 2 |
| Pause for abuse | reason shown to the customer | 2 |
| Restore | — | 2 |
| Close an account (start deletion) | — | 3 |
| Planned maintenance notice | start, end, text | 2 |
| Incident notice now | text | 2 |
| Pause new sign-ups | until | 2 |
| Welcome a sales-led customer (create tenant + trial + welcome e-mail) | name, owner e-mail, plan | 2 |

### 6.14 Approvals (the two-person rule)

- A Tier 3 request waits in **Approvals**. Approvers get an e-mail and an
  item in the console. The approver sees the same preview, must touch their
  passkey, and can approve or reject with a comment.
- Not the requester. Not the same passkey. Requests expire after 24 hours
  (CR-9). One approval is enough.
- The approver's review step is rebuilt at approval time, so they approve
  today's numbers, not yesterday's.
- **While there is only one operator:** a Tier 3 request waits **24 hours**
  instead. An alert goes to the Owner's second address at once. The Owner can
  cancel it during the wait. Exceptions that apply at once because waiting
  causes harm: saving mode 5 (the kill switch) and suspending a tenant for
  abuse. Deleting a tenant always waits.
- Break-glass use (CR-11) is logged, alarms every operator, and puts a banner
  on the console until the Owner reviews it.

---

## 7. Screens: what each one lets staff do

Paths are for the build; names are what staff see. "Reads" is always the
console's own database unless it says "live".

| # | Screen (path) | What staff see | What they can configure | Min role |
|---|---|---|---|---|
| 7.1 | **Home** (`/`) | Things that need attention, as sentences: trials ending this week, tenants over their plan, approvals waiting, scheduled changes today, failed sends, storage almost full, usage against the monthly allowance, saving mode, numbers that are out of date | nothing; each item links to the place to act | Read-only |
| 7.2 | **Tenants** (`/tenants`) | Server-side table: name, plan, status, PCs (used / allowed), last active day, estimated I/O (7 days), flags (trial, over the plan, paused). Search by name, public id, e-mail domain. Saved filters: "Trials ending", "Over the plan", "Paused", "No activity for 45 days", "Heaviest" | bulk actions limited to: add a tag, send a notice, export the list. Nothing dangerous in bulk | Read-only |
| 7.3 | **Tenant** (`/tenants/:id`) | One page (U14): the status sentence; plan and trial; every limit with a usage bar; every feature with on/off and "from the plan" or "own value"; check-in time; notices; "paid until"; support access; notes and tags; contact owner; history with Reverse; scheduled changes. A "Refresh" control does the one live read | limits, features, overrides with end dates, plan, trial, pause / restore, close account, notice to this tenant, notes, tags, billing fields, support access request | Read-only to look; see 4.2 |
| 7.4 | **Plans** (`/plans`, `/plans/:key`) | The plan list with tenant counts. A plan page: every registry entry grouped ("Sizes", "Features", "Service"), versions, which tenants are on it | create (by duplicating), edit a draft, publish a new version, retire, set the sign-up default, "Compare two plans", "Apply to existing tenants" (rollout) | Owner (Billing: drafts) |
| 7.5 | **Changes** (`/changes`) | Everything waiting, scheduled, running, failed and done. Filter by person, tenant, kind | approve, reject, move, cancel, apply now, retry, reverse | Read-only to look |
| 7.6 | **Messages** (`/messages`) | Notices: live, scheduled, ended. Who sees each. Maintenance state | write a notice from a template; audience (everyone, a plan, a status, one tenant, a list of up to 200); kind (info, maintenance, incident, action needed); start and end; link from a fixed list (status page, help, contact); preview as the customer sees it; withdraw. Maintenance mode (dashboards read-only except security actions) with a start, an end and a message | Support |
| 7.7 | **E-mails** (`/emails`) | Every e-mail the service sends, grouped: Account (welcome, invite, sign-in code, PIN reset), Plan (trial ending, trial ended, plan changed, limit reached, over the plan), Status (paused, restored, deletion scheduled, inactive warnings), Support (access requested, access ended), Announcement. Versions. Sends per day against the Resend allowance. Bounces | edit wording with a block editor (subject, greeting, paragraphs, one button, sign-off). Insert blanks from a menu (customer name, plan name, date, days left, link). Preview with sample data. "Send a test to me". Publish. Restore a version. Sender name and reply-to address. Pause all bulk mail | Owner (others: drafts and tests) |
| 7.8 | **Usage** (`/usage`) | Meters against the month: database I/O, function calls, database storage, open connections, e-mails, installer storage, Access seats. Real numbers typed in by the Owner from Convex's Usage page, with their age; estimates beside them. Forecast ("at this rate: 80 % on the 22nd"). Heaviest tenants. "What if": move the check-in time and see the estimated monthly cost | saving mode for everyone, for free tenants, or for one tenant; standard check-in time; per-tenant check-in time; alert thresholds (50 / 80 %); enter this month's real numbers | Read-only to look; Owner to change |
| 7.9 | **Support access** (`/support`) | Requests: waiting for the customer, active (with time left), ended, refused | request access (reason from a list, ticket reference, 15 / 30 / 60 min); end a session now; see what was requested and by whom | Support |
| 7.10 | **Storage** (`/storage`) | Installer storage accounts: provider, space used and total, tenants on it, state, errors in the last day | add an account with a guided form and a **test connection** run by the data plane; replace credentials; stop new uploads ("drain"); disable; set the "full" threshold | Owner |
| 7.11 | **Platform** (`/platform`) | The service-wide switches, each with help text and its last change | sign-ups open / paused (with the message shown); default plan for new sign-ups; standard check-in time; inactive-tenant schedule (warn 45 / 60, pause 75, delete 90 days); deletion grace (30 days); sign-up abuse limits (per hour); the upgrade contact address; legal links | Owner |
| 7.12 | **Team** (`/team`) | Operators, roles, "approver" switch, passkeys (count and last use), last sign-in, sessions | invite, change role, remove (runs the offboarding checklist, CR-19), end sessions, require a new passkey | Owner |
| 7.13 | **Activity** (`/activity`) | The operator audit log in sentences: who, what, to whom, why, linked change. Chain check ("unbroken since ...") and the time of the last off-box copy. Filters; export | nothing (append-only) | Read-only |
| 7.14 | **Settings** (`/settings`) | Console settings | approval rules (the "more than 25 tenants" number, waiting time), alert addresses, recipes, platform key rotation status and the rotate wizard, data-plane connection health and clock difference, registry version match | Owner |
| 7.15 | **Help** (`/help`, and beside every field) | Short how-to pages bundled with the app (offline rule: no CDN). Glossary. "What does the customer see?" pages | nothing | Read-only |
| 7.16 | **Sign-in and step-up** | Passkey sign-in; "touch your key to confirm"; lost-passkey instructions | own passkeys (add a second, remove one) | — |

Details that matter:

- **7.3 Tenant, pause.** The review step says, in the first lines: "Their PCs
  stay locked and keep working as they are. They stop receiving changes. The
  dashboard becomes read-only except security actions. Their data is kept."
  The reason is chosen from a list; each reason has its own customer message
  and e-mail.
- **7.3 Tenant, close.** Only from "Paused". Tier 3. Shows the purge date.
  A "legal hold" switch (Owner) blocks the purge. The customer's Owner can
  restore from their dashboard during the grace period (5b 5.6).
- **7.3 Contact owner.** The console never sees the owner's e-mail address
  (the API returns the domain only). "Contact owner" sends a chosen template
  through the data plane, with reply-to set to the support address.
- **7.6 Notices** are read by dashboards from one tiny row (Section 9.2). Start
  and end times are checked in the browser, so nothing is written when a
  notice begins or ends. "Dismissed" is remembered in the browser.
- **7.7 Security e-mails** (PIN reset, sign-in code, invite) have a locked
  structure: the wording can change, the link or code block cannot be removed
  or moved, and no other link can be added. Editing them is Tier 3, because a
  changed link is a phishing tool.
- **7.8 Usage** real numbers are typed by hand until Convex offers a usage API
  (**unverified** whether one exists). Home shows "Real numbers are 9 days
  old" when they age.
- **Create a tenant** (from 7.2): name, the owner's e-mail, plan, optional
  trial. The data plane creates the organization and its keys and e-mails the
  invite. The console keeps the e-mail's domain and a hash, not the address.

---

## 8. Where each setting lives

| Setting | Authoring (control plane) | Published truth (data plane) | Read by tenants via |
|---|---|---|---|
| Registry (labels, bounds, risk) | — (code, shared package) | code | — |
| Plan catalogue | `planDrafts`, versions, change requests | `planCatalog` (live versions only) | sign-up; "your plan" name |
| A tenant's entitlements | change requests, override reasons, notes | `orgPlans` (resolved) | the row they already read |
| Trial, timed override | change requests | `orgPlans.trial`, `orgPlans.overrides[].expiresAt`; ended by the data plane | same row |
| Tenant status (active / paused / being deleted) | change requests, reason codes | `orgPlans.status`, `suspendedReason`, `deleteAfter` | same row |
| "Paid until", billing notes, tags, operator notes | `tenantAccounts`, `tenantNotes` | — | never |
| Platform switches | change requests | `platformSettings` (one small row) | sign-up, pings (through pushed values) |
| Saving mode | change requests | `platformSettings.degrade`, `orgPlans.degradeLevel` | existing paths (5b 2.12) |
| Notices | `notices` (drafts, schedule, audience) | `platformBanner` (one row, at most 3 live notices), `orgPlans.notice` | dashboard shell query |
| E-mail wording | `mailTemplateDrafts`, versions | `mailTemplates` (live version per key) | — (server sends) |
| Resend key, sender address, dashboard origin | never stored; typed once, sealed in the browser | `platformSecrets` (exists) | — |
| Storage accounts | display copy of non-secret fields | `storageAccounts` with sealed credentials (5b 6.3) | — |
| Support access | request record (mirror) | request, consent and the time-boxed membership | Settings -> Support in the dashboard |
| Operators, roles, passkeys, sessions, approvals, recipes, alert addresses | control plane only | — (the data plane sees only an operator id on each request) | never |
| Operator audit log | `operatorAudit` + off-box copies | tenant-visible rows in the tenant's own `auditLog` ("Rulebox support changed your plan") | Activity screen in the dashboard |
| Tenant directory and usage history | `tenantDirectory`, `tenantUsageDaily` (copies) | `orgPlans`, `orgStats`, `orgUsageDaily` | — |
| Real Convex usage numbers | `deploymentUsage` (typed in) | — | — |

---

## 9. Data model

### 9.1 Control plane (`convex-console/schema.ts`)

All tables are small. Lists that can grow use indexes and pagination (CLAUDE.md
rules apply to this deployment too; it has its own `ioBudgets.ts`).

| Table | Size | Main fields | Indexes |
|---|---|---|---|
| `operators` | tiny | `email`, `name`, `role`, `approver`, `state`, `accessSubject` | `by_email` |
| `operatorPasskeys` | tiny | `operatorId`, credential id, public key, counter, `label`, `lastUsedAt` (day resolution) | `by_operator`, `by_credential` |
| `operatorInvites` | tiny | code hash, role, `expiresAt` | `by_hash` |
| `operatorSessions` | tiny | `operatorId`, token hash, `accessSubject`, `expiresAt`, `idleUntil`, `stepUpAt` | `by_hash`, `by_operator` |
| `changes` | grows slowly | kind, target, `before`, `after`, `summary`, `preview`, `reason`, `tier`, `state`, `requestedBy`, `runAt`, `scheduledFnId`, `appliedAt`, `result`, `reverses` | `by_state_run [state, runAt]`, `by_target_created [target, createdAt]`, `by_requester_created` |
| `approvals` | grows slowly | `changeId`, `operatorId`, decision, comment, `at` | `by_change` |
| `operatorAudit` | grows | `seq`, `at`, `operatorId`, action, target, sentence, `changeId`, `prevHash`, `hash` | `by_seq`, `by_target_seq`, `by_operator_seq` |
| `auditExports` | tiny | `fromSeq`, `toSeq`, `hash`, `at`, result | `by_to_seq` |
| `planDrafts` | tiny | `planKey`, `version`, `state`, name, description, values, `publishedAt` | `by_key_version` |
| `recipes` | tiny | name, steps, open blanks, tier | `by_name` |
| `tenantDirectory` | 1 per tenant | `orgPublicId`, `name`, `planKey`, `status`, flags (trial end, over the plan), counts, `lastActivityDay`, `io7d`, `calls7d`, `storageBytes`, owner e-mail **domain**, `syncedAt`, `revision` | `by_public_id`, `by_status_name`, `by_plan_name`, `by_io7d`, `by_trial_end`, `by_activity`; search index on `name` |
| `tenantUsageDaily` | 1 per tenant per day, 90 days; then monthly rows | `orgPublicId`, `day`, estimated I/O, calls, counts | `by_tenant_day`, `by_day_io` |
| `tenantNotes` | grows slowly | `orgPublicId`, text (at most 2,000), author, `at`, pinned | `by_tenant_at` |
| `tenantAccounts` | 1 per tenant that needs it | `orgPublicId`, `paidUntil`, billing notes, tags, legal hold | `by_public_id`, `by_paid_until` |
| `notices` | tiny | audience, kind, title, body, link key, `startsAt`, `endsAt`, `state` | `by_state_start` |
| `mailTemplateDrafts` | tiny | `key`, `version`, subject, blocks, `state` | `by_key_version` |
| `mailCampaigns` | tiny | template, audience, counts (queued, sent, failed), `state` | `by_state` |
| `supportRequests` | grows slowly | `orgPublicId`, `operatorId`, reason, minutes, `state`, times | `by_state`, `by_tenant` |
| `deploymentUsage` | tiny | month, the typed-in real numbers, `enteredAt`, `enteredBy` | `by_month` |
| `syncState` | 1 row | last directory day, last event sequence, last error, data-plane clock difference | — |
| `consoleSettings` | 1 row | approval thresholds, waiting time, alert addresses | — |

What the control plane must never store (test-enforced): any tenant member's
e-mail address beyond the domain (exception: the hash kept for a tenant the
console created), employee or device names, audit contents, file names, any
credential in the clear, any signing key except its own platform signing key
(in the environment, not in a table).

Rough size at 1,000 tenants: directory 1,000 x 0.6 KB; usage 1,000 x 90 x
0.25 KB = 23 MB plus two index copies, about 70 MB. Inside the 0.5 GB free
storage. Its I/O is dominated by the nightly sync: about 0.5 MB a day.

### 9.2 Data plane additions (`convex/schema.ts`)

| Table / field | Change | Size and write rate |
|---|---|---|
| `orgPlans` | add `publicId` and `name` (copies, so the directory never reads the big `organizations` row), `planKey` (replaces the `plan` union, widen then narrow), `planVersion`, `features`, `trial`, `overrides` (at most 20 `{ key, expiresAt? }`), `notice`, `expiryFnId`. New indexes `by_public_id`, `by_plan [planKey]` | about 0.9 KB; written only by operator actions and time limits |
| `planCatalog` (new, PC-1) | `planKey`, `version`, name, description, `public`, `state`, values (limits + features + levels), `revision` | at most 20 live rows, about 1 KB each; written on publish |
| `platformSettings` | drop `planDefaults` (moved to `planCatalog`); add `signups { open, message }`, `defaultPlanKey`, `maintenance { state, message, until }`, `degrade`, `inactive { warn1, warn2, pause, delete }`, `mailBudgetPerDay`, `registryVersion` | one row, about 0.4 KB |
| `platformBanner` (new) | key `"global"`, `notices` (at most 3: id, kind, title up to 80, body up to 300, link key, `startsAt`, `endsAt`, audience `{ plans?, statuses? }`), `revision` | one row, at most 1.5 KB; written when a global notice changes |
| `mailTemplates` (new) | `key`, `version`, subject, blocks, `updatedAt` | about 25 rows, about 1.2 KB each |
| `mailQueue` (new) | `templateKey`, `orgId`, `campaignId`, `state`, `notBefore` | one row per queued bulk e-mail; deleted when sent |
| `mailDaily` (new) | `day`, `sent`, `bulkSent`, `failed` | one row per day; one small write per e-mail sent |
| `platformOutbox` (new, PC-4) | `seq`, `at`, `kind`, `orgPublicId`, small payload (no personal data) | one row per event, about 0.25 KB; pruned after 14 days |
| `platformApplied` (new) | `changeId`, `at`, result summary | one row per applied write, pruned after 7 days; doubles as the nonce record for writes (PC-5) |
| `platformAudit` | widen `action` and `actor` to cover every platform write (actor = `operator:<id>`) | one row per platform write |
| `supportAccess` (5b C6) | request, consent, expiry, the temporary membership id | tiny |
| `orgUsageDaily` | add the counts the directory needs (`devices`, `onlineDevices` at rollup time, `employees`, `apps`, `members`, `storageBytes`, `overLimit`); retention 35 days (PC-12) | written nightly by the existing `usage:rollup` |

Dashboard shell query change: read `platformBanner` once (one extra read of
about 1 KB per run) and return the notices that match the tenant's plan and
status, plus `orgPlans.notice`. The row changes only when an operator changes
a notice, so the query re-runs only then.

---

## 10. Platform API: additions and I/O

### 10.1 Rules for every route (in addition to 5b 4.5)

- Signed as in 5b 4.5. Writes carry `changeId` (idempotency) and
  `expectedRevision`. Reads carry no nonce (PC-5).
- Every write records the operator id, the change id and a sentence in
  `platformAudit`, and a tenant-visible row in the tenant's `auditLog` when it
  concerns one tenant.
- Every route is in the authorization table and the deny-list leak test
  (5b 4.3). A route that returns a field on the deny-list fails CI.
- No route can publish, read or write a device document, or return a member's
  e-mail address.
- Inputs are validated against the **registry in the data plane**, not the
  console's copy. A value outside `min`..`max` is refused there, whatever the
  console sent. The console is not trusted to be right.
- Each route has a row in `convex/ioBudgets.ts` and a budget test.

### 10.2 Routes

Existing in 5b 4.5 and kept: tenants list (now used only by repair tools),
tenant detail, suspend, restore, delete, support-request, usage, degrade,
storage accounts. Changed or new:

| Route | Does | Tier | Replaces / new |
|---|---|---|---|
| `GET /platform/v1/health` | registry version and hash, server time, API version | 0 | new |
| `GET /platform/v1/directory?day&cursor&limit<=100` | one page of that day's `orgUsageDaily` rows and nothing else (each row already has the counts, plan key and status) | 0 | new (PC-3) |
| `GET /platform/v1/events?after&limit<=100` | outbox rows after a sequence number | 0 | new (PC-4) |
| `GET /platform/v1/tenants/:id` | live row: `orgPlans` + `orgStats` + presence shards | 0 | kept, without the 30-day usage (the console has it) |
| `POST /platform/v1/tenants` `{ name, ownerEmail, planKey, trial? }` | creates organization, keys, plan row, owner invite e-mail | 2 | new |
| `POST /platform/v1/tenants/:id/entitlements` `{ planKey?, overrides?, trial?, pingInterval?, note }` | resolves and writes `orgPlans`; schedules expiries; runs `applyLimits` | 1-2 | replaces `.../plan` |
| `POST /platform/v1/tenants/:id/notice` | sets or clears `orgPlans.notice` | 1 | new |
| `POST /platform/v1/tenants/:id/contact` `{ templateKey, fields }` | queues one e-mail to the tenant's owners | 1 | new |
| `PUT /platform/v1/plans/:key` | publishes a plan version to `planCatalog` | 3 | replaces `plan-defaults` |
| `POST /platform/v1/plans/:key/rollout` `{ keys, mode, cursor }` | applies a plan version to its tenants, 50 per call, skipping overridden keys; returns the next cursor and per-tenant results | 2-3 | new |
| `PUT /platform/v1/settings` | platform switches | 2-3 | new (absorbs global ping interval) |
| `PUT /platform/v1/banner` | the global notices row | 2 | new |
| `PUT /platform/v1/mail/templates/:key` | publishes an e-mail version; the data plane re-checks required blanks and the locked structure | 2-3 | new |
| `POST /platform/v1/mail/campaigns` `{ templateKey, audience }` | queues a service e-mail to an audience; returns the count and the days it will take under the daily budget | 2 | new |
| `GET /platform/v1/mail/status` | today's and this month's counts, queue length, bounce count, "mail ready" flag | 0 | new |
| `PUT /platform/v1/secrets/:name` `{ sealed }` | stores a platform secret sealed to the data plane's public key | 3 | new (today: CLI only) |
| `POST /platform/v1/storage/accounts/:id/test` | writes, reads and deletes a probe object; returns pass or the failing step | 2 | new |

Events in the outbox: tenant created (sign-up), tenant self-deleted or
restored by its Owner, trial ended, override ended, auto-paused for
inactivity, went over the plan, support access approved / refused / ended,
storage account full or failing, mail quota reached, platform API 401 burst.
After writing an outbox row, the data plane sends one signed "news up to seq
N" call to the control plane's HTTP action. It carries no data. A forged call
can only cause a pull. If the call fails, the nightly sync catches up.

### 10.3 I/O estimates (data plane, per call)

Sizes: `orgPlans` 0.9 KB, `orgStats` 0.45 KB, presence shard 0.15 KB,
`auditLog` row 0.45 KB, `orgUsageDaily` 0.3 KB, index entry 64 B.

| Call | Reads | Writes | Estimated I/O | Re-runs it causes |
|---|---|---|---|---|
| Signature check, read route | 0 documents | 0 | about 0 | — |
| Signature check, write route | `platformApplied` lookup | 1 insert | about 0.5 KB | — |
| `GET tenants/:id` | 6 | 0 | about 1.9 KB | — |
| `GET directory` (100 tenants) | 100 | 0 | about 36 KB | — |
| `GET events` (per event) | 1 | 0 | about 0.3 KB | — |
| Outbox write (at the source) | 0 | 1 | about 0.5 KB | — |
| `entitlements` for one tenant | `orgPlans`, `planCatalog` row | `orgPlans`, `auditLog`, `platformAudit`, applied id | 2 KB read + 3.5 KB written = **about 5.5 KB** | that tenant's open dashboards: shell query, about 2 KB each |
| ... when it lowers PCs below use | + up to 100 `deviceCredentials` per run | up to 100 | + about 0.7 KB per PC over | none on devices until their next ping |
| Suspend / restore | as above + every `deviceCredentials` row | every row | about 5 KB + 0.7 KB per PC | as above |
| Plan publish | 1 | 2 | about 3 KB | none (existing tenants unchanged) |
| Rollout, per tenant changed | 1 | 2 | about 2.9 KB | one shell re-run per open dashboard of that tenant |
| Global notice | 1 | 2 | about 3.5 KB | **every open dashboard**: about 2 KB each |
| Tenant notice | 1 | 2 | about 3 KB | that tenant's open dashboards |
| E-mail template publish | 1 | 2 | about 3 KB | — |
| One e-mail sent | template, owners (at most 3 members) | `mailDaily`, queue delete | about 3 KB | — |
| Trial or override ends (data plane, by itself) | `orgPlans`, `planCatalog` | `orgPlans`, `auditLog`, outbox | about 4.5 KB | that tenant's dashboards |

Monthly total for the console on the data plane, 220 tenants (the free-plan
capacity of 5b):

| Source | Per month | I/O |
|---|---|---|
| Nightly directory | 30 x 220 rows x 0.36 KB | 2.4 MB |
| Extra bytes in `usage:rollup` rows | 30 x 220 x 0.15 KB | 1.0 MB |
| Events (about 3 per tenant) | 660 x 0.8 KB | 0.5 MB |
| Tenant pages opened ("Refresh", previews) | 600 x 1.9 KB | 1.1 MB |
| Operator changes | 200 x 5.5 KB | 1.1 MB |
| Notices (4 a month, 30 dashboards open) | 4 x (3.5 + 60) KB | 0.3 MB |
| **Total** | | **about 6.4 MB (0.6 % of 1 GB)** |

Function calls: about 1,500 API requests a month, each one HTTP action plus one
or two internal functions, so about **4,500 calls (0.45 % of 1 M)**. The
extra `platformBanner` read adds about 1 KB to each dashboard shell run and no
calls.

At 1,000 tenants the same list gives about 25 MB a month. The nightly
directory grows in a straight line with tenants; if it ever matters, sync only
tenants whose row changed (the rollup already "writes only on change").

All numbers are estimates until measured with the 5b 1.6 procedure. Step K2
adds these flows to that measurement.

### 10.4 Control-plane I/O (its own allowance)

- Console screens subscribe only to control-plane rows. They change when an
  operator acts or the nightly sync runs. No screen subscribes to a table
  that the sync rewrites in bulk while it is open: the sync patches a
  directory row **only when a shown field changed**.
- Tenants table: page of 50 from an index (about 30 KB per page). Search uses
  the search index on `name`, plus exact match on public id and e-mail domain.
- Operator session check on every call: one small read (about 0.3 KB).
  `lastUsedAt` and idle time are written at most once per 5 minutes per
  session, not per call.
- Expected: well under 100 MB and 100,000 calls a month for three operators.

---

## 11. Security model

Everything in 5b 5.3 (CR-1 to CR-20) and 5.5 stands. This section adds what
the bigger feature set needs and what the research changed.

### 11.1 Layers

| Layer | Control | Note |
|---|---|---|
| Outer door | Cloudflare Access on `admin.<domain>`: only named e-mail addresses, allowed countries, 8-hour session | Protects the page. Not the backend (below) |
| Sign-in | Passkey (WebAuthn), user verification required, no passwords. The Access identity must match the operator's e-mail | The real lock. Reuse the WebAuthn verification already written for the dashboard (`convex/passkeys.ts`) by moving the shared part into a package; do not import from `convex/` (CR-1) |
| Session | 8 h at most, 15 min idle, bound to the Access subject; ends when Access ends | — |
| Step-up | A fresh passkey touch (5 minutes) for Tier 2 and 3 | — |
| Second person | Tier 3 (6.14) | — |
| Server checks | Role, tier, step-up age, approval, rate limit, in the wrapper of every function | The screen is never the check |
| Data-plane checks | Signature, time window, change id, revision, registry bounds, route allow-list | The data plane does not trust the console |
| Record | Hash-chained operator audit, copied hourly to write-only storage; tenant-visible rows in the tenant's log | — |

### 11.2 The backend is public: say it plainly

Convex custom domains need the Pro plan, so the control-plane functions are
reachable at `https://<name>.convex.cloud` by anyone who knows the address.
Access does not sit in front of them. Therefore:

- No control-plane function returns anything without a valid operator session
  (CR-3). The sign-in functions answer the same way for unknown and known
  e-mails and are rate-limited.
- Sign-in requires proof of the Access session: the page fetches its Access
  token from a tiny Worker route on `admin.<domain>` (behind Access) and sends
  it with the passkey assertion. The backend verifies the token's signature
  against the team's keys, the `aud` tag, the issuer, expiry and e-mail, as
  Cloudflare's documentation requires. Keys rotate every six weeks; fetch them
  by key id and cache for a short time.
- The control-plane deployment has no public HTTP action except the "news"
  receiver (PC-4), which accepts only a signed, data-free message.
- The page's CSP `connect-src` lists exactly the control-plane address and
  nothing else. The page never talks to the data plane.

### 11.3 New risks from "everything configurable", and their controls

| Risk | Control |
|---|---|
| An operator (or stolen session) edits the PIN-reset e-mail to point at a fake site | Security e-mails have a locked structure; links come only from the data plane's own origin setting; Tier 3; the data plane re-validates on publish |
| Free text in notices or e-mails carries a script or a deceptive link | Plain text only. Links are chosen from a fixed list. Dashboards render notices as text. Length limits. No HTML anywhere |
| Operator-entered text is shown inside the customer dashboard (suspension reason, notice) | Rendered as text; reasons come from a list with at most 200 characters of extra text |
| Mass change by mistake | Preview, canary, pause, reverse, second person above 25 tenants |
| "Create tenant" used to spam invites | Rate limit (10 a day per operator), Tier 2, counts against the mail budget |
| "Contact owner" used to phish customers | Templates only, fixed reply-to, every send is in both logs |
| Console copy of tenant metadata leaks | It is metadata only (9.1 deny-list), no addresses, no names of people or PCs |
| Replay or double-apply of a write | Change id remembered 7 days, 60 s window, `expectedRevision` |
| Platform signing key leaks | Nothing it can call reads data or publishes. Rotation as 5b 4.5. Alerts on 401 bursts. Registry bounds limit the damage of a forged entitlement change |
| An attacker raises a tenant's limits for free service | Loud: tenant-visible audit row, outbox event, daily "changes" digest to the Owner |
| An attacker pauses or deletes tenants | Deletion needs a second person and has a 30-day grace. Pause is reversible. More than 5 pauses in an hour raises an alarm and needs the Owner |
| Sole operator | Waiting time and alerts (6.14) |
| Operator leaves | Offboarding checklist (CR-19) as a guided flow on the Team screen; it ends by removing the person from the Access policy (a manual step in Cloudflare, ticked off in the flow) |
| Owner-recovery ("we lost access to our account") used to take over a tenant | **Not a console feature in the first version** (Q8). It is the one request that could lead to a policy push |

### 11.4 Tests that keep it true

- Role x tier matrix for every control-plane function (signed out, each role,
  no step-up, stale step-up, own approval, expired approval).
- Leak test: every platform route's answer and every control-plane table
  against the deny-list.
- Registry bounds: the data plane refuses out-of-range values even with a
  valid signature.
- Idempotency: the same change id twice writes once.
- Hash chain: editing or deleting an audit row is detected.
- Template lock: a security e-mail without its link block is refused by the
  data plane.
- CSP header test on the built site; no `dangerouslySetInnerHTML` (lint).
- Independent penetration test before the first paying tenant (CR-18).

---

## 12. Cloudflare setup

| Item | Setting | Plan needed / cost |
|---|---|---|
| DNS | `<domain>` (site), `app.<domain>` (dashboard), `admin.<domain>` (console), all proxied. `admin.` has no public DNS hint beyond the record itself; nothing links to it | Free |
| Console hosting | Static files on Cloudflare (Workers static assets or Pages). Cloudflare states "Requests to static assets are free and unlimited". One small Worker route `/_access/assertion` returns the Access token to the page | Free. Worker requests: free tier (**limits unverified**) |
| Access application | Self-hosted app for `admin.<domain>`, all paths. Policy "Operators": Allow, Include = the operators' e-mail addresses, Require = country in the allowed list. Session 8 hours. A second, empty-by-default policy "Break-glass" with purpose justification | Zero Trust Free: $0 for up to 50 users. Pay-as-you-go: $7 per user per month |
| Access login method | One-time PIN to the operator's e-mail, or a Google / GitHub login. Whichever is chosen, it is only the outer door (PC-9) | Free |
| Device posture, mTLS | Optional later. Access policies support posture checks and client certificates; which plans include them is **unverified** | check before relying on it |
| Access token check | Backend verifies `Cf-Access-Jwt-Assertion` against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, checks `aud`, issuer, expiry | — |
| Offboarding | Remove the e-mail from the policy and "Revoke" the user's sessions in Zero Trust | — |
| Security headers | CSP, `frame-ancestors 'none'`, `X-Content-Type-Options`, Referrer-Policy, Permissions-Policy on every console response (headers file or the Worker; exact mechanism to confirm in K1) | Free |
| Turnstile | On hosted sign-up at `app.<domain>` (5b 3.6). Not on the console (Access is in front) | Free: up to 20 widgets, 10 hostnames each, unlimited challenges |
| WAF rate limiting | One rule on the free plan, counted by IP, 10-second window. Use it on the sign-up page path of `app.<domain>` | Free: 1 rule. Pro: 2 rules, up to 1-minute windows |
| What Cloudflare does **not** protect | Convex addresses (`*.convex.cloud`, `*.convex.site`) are not behind Cloudflare without a custom domain (Convex Pro). Sign-up, the platform API and the control plane rely on their own signatures, sessions and Convex-side rate limits | — |
| Cache | No caching of the console's HTML; hashed assets cached | Free |
| Robots | `X-Robots-Tag: noindex` on `admin.` | Free |

Note for phase H1 (outside this plan): 5b 3.6 takes the client IP for sign-up
limits from `CF-Connecting-IP`. That header exists only if the request passes
through Cloudflare. Without a Convex custom domain, route sign-up through a
Worker on `app.<domain>` that forwards to the Convex HTTP action with a shared
secret, or the per-IP limit has no IP to count.

---

## 13. Build steps

Prerequisites from phase H1 (5b 8.1) that must exist first:
`organizations.publicId`, `orgUsageDaily` and `usage:rollup`, hosted sign-up,
per-organization keys (Phase 5 Step 10), the degrade ladder, `applyLimits`
and the `overLimit` / `suspended` device states.

One step = one commit, made only when the owner says so. Every step ends with:
typecheck and lint for the touched packages, `convex-test` suites green, I/O
budget rows added and their test green, and for UI steps a look at the running
screen (screenshot) before saying it is done. Steps map to 5b's C1-C9 where
noted.

| Step | What | Verify | Done when | Do not |
|---|---|---|---|---|
| **K0 Spike (3 days)** | Prove the unknowns: second Convex project in the same repo (`convex-console/` with its own config and deploy key) in a **separate team**; Access in front of a static page; fetching the Access token through the Worker route; verifying it in a Convex function; one signed call between two test deployments; the "news" call back | A written result per unknown in this file's Section 17 | Each item is "works" or has a chosen fallback | Touch the dev or live deployment |
| **K1 Skeleton and sign-in** (C1) | Control-plane schema (operators, passkeys, sessions, invites, audit), wrappers with role / tier / step-up / audit, lint rule against raw functions, first-owner invite by CLI, `apps/console/` shell with the "Operator console" label and environment name, `pnpm dev:console`, security headers | Role matrix test; Playwright with a virtual authenticator signs in; header test | An owner signs in locally with a passkey; every function is behind a wrapper | Add a password; import anything from `apps/dashboard` or `convex/` |
| **K2 Platform API core and sync** (C2) | Request signing both ways with shared test vectors; `health`, `directory`, `events`, `tenants/:id`; outbox and the "news" call; `platformApplied`; nightly sync into `tenantDirectory` / `tenantUsageDaily` (writes only on change) | Vector tests in both planes; replay, skew, unknown key, expired key; leak test; budget test; "console off" test: a trial still ends | The directory fills from a seeded test data plane; killing the control plane changes nothing for tenants | Use a deploy key; add a route outside Section 10.2 |
| **K3 Tenants (look only)** (C3) | Tenants table (server-side sort, search, filters, saved filters), tenant page with the status sentence, usage bars, "Refresh", notes and tags; generic server table moved to `packages/ui` | Table budget test (page of 50); fixtures for every status sentence; screenshot | Support can find any tenant and read its state without help | Show a database field name |
| **K4 Change engine** | `changes` with its states, preview objects, review step, risk tiers on the server, step-up, History with Reverse, idempotent delivery, "Needs review" on conflict. First real change: limits and features for one tenant through the registry-built form | Tier matrix; idempotency; conflict; reverse; registry test (every entry has label, help, unit, bounds); out-of-range refused by the data plane | Changing "PCs allowed" for one tenant shows a correct preview, applies, appears in the tenant's dashboard live and can be reversed | Build any form by hand that the registry can build |
| **K5 Plans, trials, schedule** (C4 part) | `planCatalog` migration (widen, backfill, narrow) replacing the fixed plan union; plan editor with versions; duplicate, publish, retire; overrides with end dates; trials; scheduling; rollouts with canary and pause; recipes | Migration test on a copy; trial end and override end with the console stopped; rollout skips overridden keys; canary pause | A new tier is created, given to a tenant as a 14-day trial and ends by itself, all without code | Change existing tenants when a plan is edited |
| **K6 Lifecycle and approvals** (C4 rest, C8 part) | Create tenant, pause with reasons, restore, close with grace and legal hold; Approvals screen; the single-operator waiting time; alarms on pause bursts | Two-person tests (own request, expired, edited after approval); e2e: pause makes the tenant dashboard read-only, PCs stay locked (simulated); purge cannot run under legal hold | Billing can pause a tenant for non-payment and restore it alone; nobody can delete alone | Allow delete from "active" |
| **K7 Messages and maintenance** | `platformBanner`, tenant notice, dashboard banner component and shell-query change, Messages screen with audience and preview, maintenance mode | Shell query budget (one extra read); notice start and end cause no writes; text-only rendering test; screenshot of the dashboard banner | A scheduled maintenance notice appears and disappears on time in a test tenant's dashboard | Send anything to kiosk screens |
| **K8 E-mails** | `mailTemplates` with the existing hard-coded e-mails moved in as defaults; block editor; blanks menu; preview; test send from the control plane's own Resend key; locked security templates; daily budget, queue and priority for account e-mails; campaigns; contact owner; mail status | Locked-structure refusal; budget test: 150 queued bulk e-mails never delay a PIN reset; version restore | Staff reword the trial-ending e-mail and send themselves a test without a developer | Allow HTML; send bulk mail outside the queue |
| **K9 Usage and saving mode** (C5) | Usage screen, typed-in real numbers with age, forecast, heaviest tenants, "what if" for check-in time, saving mode controls, alert thresholds, Home | Simulated fleet: a level change reaches `nextPingInMs`; forecast fixtures | The Owner sees at a glance how much of the month is used and what to do | Read `orgUsageDaily` live from a console screen |
| **K10 Support access** (C6) | Request from the console; consent screen in the customer dashboard (Settings -> Support); time-boxed read-only membership; end now; both logs; outbox events | Expiry with the console stopped; no write possible in a support session; both audit logs have the rows | A support session can be asked for, granted, used and ended, and the customer sees every step | Add any "view as customer" inside the console |
| **K11 Storage** (C7, with 5b S2) | Storage screen, guided add with sealed credentials and test connection, drain, disable, replace credentials | Credentials never appear in any control-plane table, log or change record (test greps fixtures) | The Owner adds a second account without the command line | Store or echo a credential |
| **K12 Team, audit copies, offboarding** (C8) | Team screen, invites, roles, approver switch, offboarding flow, hourly audit copy to write-only storage, chain check on Activity, alerts (sign-in, failed sign-in, step-up, role change, support session), break-glass | Chain tamper test; export restore test; offboarding e2e | Removing an operator ends their sessions and walks the Owner through every rotation | Let the console hold a Cloudflare API token |
| **K13 Help, Practice, usability** | Help pages and glossary; Practice environment with made-up tenants; the 12-task usability test with one non-technical person; fix what they trip on; error-message review | Test script and results recorded in `docs/plans/operator-console-usability.md` | The tester completes all 12 tasks alone | Skip the test because "it is obvious" |
| **K14 Hardening** (C9) | CSP tightening, dependency and secret scanning in CI, runbooks (`docs/ops/`), red-team checklist, pen-test preparation | CI checks; checklist run | Ready for the external test | Launch to a paying tenant before the pen test |

The 12 usability tasks (K13): find a tenant by a partial name; say why its
new PC was refused; give it 5 more PCs for 30 days; start a 14-day trial;
extend it by a week; move it to a plan from next month; pause it for
non-payment and restore it; post a maintenance notice for next Sunday; reword
the trial-ending e-mail and send a test; ask for support access; find who
changed a limit last week and reverse it; tell from Home whether anything
needs attention today.

Effort: 5b estimated 3-4 weeks for C1-C9. The added change engine, plans as
data, messages, e-mails and the usability pass make it about **6-8 focused
weeks** (plus or minus 50 %).

---

## 14. Edge cases

| # | Case | Rule |
|---|---|---|
| E1 | Two operators edit the same tenant | `expectedRevision`. The second sees what changed and can re-apply on top |
| E2 | The customer changes something while a scheduled change waits | Applies if the touched fields are unchanged; else "Needs review" |
| E3 | Console down when a trial should end | The data plane ends it (PC-11). The event waits in the outbox |
| E4 | Data plane down when a change should apply | Retry with backoff, no faster than every 30 s, for 1 hour; then "Failed" with a retry button. The same change id makes retries safe |
| E5 | The call timed out but was applied | The retry gets "already applied" with the first result |
| E6 | Clocks differ between planes | 60 s window; Settings shows the difference; an alert above 20 s |
| E7 | A plan is retired while tenants are on it | They keep it. It cannot be given to new tenants. It cannot be deleted while any tenant has it |
| E8 | The sign-up default plan is retired | Refused: choose a new default first |
| E9 | A registry entry is added | Missing means `defaultWhenMissing`. Plans show it as "new: review" until someone sets it |
| E10 | A registry entry is removed | Widen then narrow: stop reading, deploy, strip from rows in batches, remove |
| E11 | The console's registry copy is older than the data plane's | `health` hash differs: the console goes read-only for entitlements and says "Update needed" |
| E12 | Trial ends while the tenant has more PCs than the fallback plan | Newest PCs become "over the plan" (5b 3.2). Warned 7 and 1 days before. Nothing unlocks |
| E13 | An override ends on the day the plan changes | Order: expiry first, then the plan change resolves against current overrides. Both are in History |
| E14 | A timed grant is reversed after it already ended | Reverse says "Nothing to reverse: it ended on <date>" |
| E15 | Downgrade below current use of staff accounts or apps | Nothing is deleted. Creating more is refused. The tenant sees which numbers are over |
| E16 | A feature is taken away while it is in use | By `onRevoke`: frozen set-ups stay; a device lock is never lifted |
| E17 | Suspended tenant asks for support access | Allowed. The consent screen is one of the actions a paused dashboard keeps |
| E18 | Tenant deletes itself during a scheduled change | The change is cancelled with a note; the event explains why |
| E19 | Restore after 29 days | Works. The purge job checks status again right before deleting |
| E20 | Purge of a tenant with a legal hold | Refused until the hold is lifted (Tier 3) |
| E21 | Notice scheduled across a time-zone change | Stored in UTC; shown in the viewer's time zone |
| E22 | Three global notices already live | A fourth is refused: withdraw one first (keeps the row small and the screen calm) |
| E23 | Daily mail budget used up | Bulk waits for tomorrow. Account e-mails (PIN reset, sign-in code, invite) still go; if Resend itself refuses, the lock screen says "e-mail is not available right now" and Home shows an alert |
| E24 | Resend key missing or invalid | Existing "mail ready" flag is false; mail features show "not set up"; nothing is queued forever (queue rows expire after 7 days) |
| E25 | A template draft uses a blank that the e-mail cannot fill | Refused at save with the name of the blank |
| E26 | Rollout meets a tenant whose row changed since the preview | Re-checked per tenant at apply time. The result report lists skipped tenants with reasons |
| E27 | Rollout interrupted | Resumes from its cursor. Tenants already done are not touched again (change id + tenant) |
| E28 | The only approver is on holiday | The request expires after 24 h and can be asked again. The Owner can always approve. No "skip approval" switch exists |
| E29 | An operator loses every passkey | The Owner removes and re-invites them. If the Owner loses theirs: break-glass (CR-11) |
| E30 | An operator's role is lowered while they have a request waiting | The request is re-checked against the new role when it applies; it fails if they could no longer ask for it |
| E31 | Access session ends mid-task | The next call fails; the page asks to sign in again; the unsaved form is kept in memory only |
| E32 | Directory is a day old and a tenant was created an hour ago | The "tenant created" event adds it within seconds. If events are broken, search by public id does a live look-up |
| E33 | Self-hosted deployment | No platform routes, no banner row read, plan `custom`. The registry still describes limits, all at "no limit" |
| E34 | Practice environment mistaken for live | The environment name is on every screen and in every review step ("You are changing LIVE") |
| E35 | Free-plan cap is hit on the data plane | Writes may fail for everyone (5b). The console shows the data plane's errors as they are and offers saving mode; changes queue as "Failed, retry" |
| E36 | A tenant's name contains another tenant's name | "Type the name to confirm" also shows and checks the public id |

---

## 15. Risks

| Risk | Impact | Handling |
|---|---|---|
| "Everything configurable" grows into a second product | Late, hard to test | The registry is the only way to add a setting. Fixed screens. No scripting. Step order puts daily tasks first |
| Staff still find it hard | The owner ends up doing every change | K13 usability test is a release gate, not a nice-to-have. Recipes cover the common jobs |
| Plans-as-data migration breaks limits for existing tenants | Wrong limits enforced | Widen, backfill, narrow; a test compares every tenant's resolved values before and after; done before any outside tenant if possible |
| The mirror drifts from the truth | Wrong previews | Exact live read for single-tenant changes; apply-time re-check for bulk; nightly full sync; "as of" time on every number |
| Control plane on a free Convex team hits a cap | Console stops; tenants unaffected | Tiny by design; own budget tests; alert at 50 % |
| Convex free team limit (two per account, unverified) blocks the separate team | Shared allowance with tenants | Ask Convex support, or use a second account owned by the company, or accept the shared team with strict budgets |
| Access free tier or features change | Outer door weakens | The passkey sign-in does not depend on Access |
| Resend free limits | Late e-mails | Budget and queue; paid plan when tenants pass about 150 |
| Operator audit copy storage fails silently | Gap in the record | Home alert when the last copy is older than 2 hours |
| A second person is not available at launch | Tier 3 by one person | Waiting time (6.14); hire or appoint an approver before the first paying tenant (5b Q8) |
| Scope overlap with phase H1 | Double work or gaps | H1 owns sign-up, usage rollup, degrade, export. This plan owns the console and the routes in 10.2. K2 starts only when the H1 list in Section 13 is done |
| Estimates are not measurements | Budget surprise | Measure these flows with the 5b 1.6 procedure in K2 |

---

## 16. Open questions for the owner

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q1 | Plans as data (PC-1), or keep the three fixed plans? | (a) `planCatalog`, staff create tiers; (b) keep `free` / `team` / `custom` and only edit their numbers | **(a)**. It is the core of "everything configurable". Cost: one migration, done before outside tenants exist |
| Q2 | Console keeps a tenant directory (PC-3)? | (a) mirror, nightly + events, metadata only; (b) every list and search goes to the data plane live | **(a)**. About 6 MB a month instead of a cost per click, and it makes search, sorting and "who is affected" possible |
| Q3 | Which features are plan features? | (a) the starter list in 6.2; (b) limits only at first, features later; (c) another list | **(b) for launch, with the registry ready for (a)**. Sizes are easy to explain and enforce today. Decide packaging when there are paying customers. Never gate lockdown |
| Q4 | Roles (PC-6) | (a) Owner, Support, Billing, Read-only; (b) keep the ladder with `admin` | **(a)** |
| Q5 | Second person while you are alone | (a) 24 h waiting time with alert (PC-13); (b) no Tier 3 rule until there are two operators; (c) appoint a trusted second approver now | **(c) if someone exists, else (a)** |
| Q6 | Separate Convex team for the control plane (PC-8) | (a) separate team; (b) same team, second project | **(a)**. Confirm the free-team limit with Convex first (K0) |
| Q7 | Payment provider and timing | (a) none at launch: "Contact us" + "paid until" in the console; (b) Stripe (its Entitlements feature maps to our registry keys by `lookup_key`); (c) a merchant of record that handles tax (Paddle, Lemon Squeezy) | **(a) now.** Choose between (b) and (c) by where the company is registered and where customers are; card data never touches Rulebox either way. Provider availability per country is **unverified** |
| Q8 | Owner recovery ("we lost our account") in the console | (a) not in the console; a written manual procedure by the Owner; (b) a Tier 3 flow: second person, 72 h wait, e-mail to every member of the tenant with a cancel link | **(a) first.** It is the one flow that could hand someone a tenant. Build (b) only when volume demands it |
| Q9 | Announcements by e-mail | (a) service messages only (maintenance, incidents, plan and account notices); (b) also product news | **(a)**. News needs consent and unsubscribe handling |
| Q10 | Access login method | (a) one-time PIN by e-mail; (b) Google login; (c) GitHub login | **(a)** or the provider the operators already use with strong sign-in. It is the outer door only |
| Q11 | Practice environment | (a) a permanent test data plane with made-up tenants; (b) none | **(a)**. Non-technical staff need a place to try things |
| Q12 | Default length of a timed grant and of a trial | 30 days / 14 days, or other | **30 and 14** |
| Q13 | Resend plan | (a) free (100 a day) with the budget and queue; (b) paid from launch | **(a)** until about 150 tenants; the Usage screen shows when |
| Q14 | Languages for notices and e-mails | (a) English only; (b) per-tenant language | **(a)**, with the template key built so a language can be added |

---

## 17. Could not be verified (K0 resolves most)

- That Convex plan limits are counted per team across projects (the limits
  page presents them that way; confirm on the Usage page).
- The limit on free Convex teams per account (community reports say two).
- Running two Convex projects from one repository folder layout
  (`convex-console/` with its own configuration and deploy key).
- Whether Convex offers an API for a deployment's usage numbers.
- Whether an HTTP action can read the caller's IP without a proxy in front.
- Cloudflare: which plans include device posture, client certificates,
  purpose justification and temporary authentication for Access; Workers free
  request limits; the exact way to set response headers for static assets.
- Whether the Access token cookie can be read by page script (the plan
  assumes not and uses a Worker route).
- Resend: restricted "sending only" API keys per domain; webhook events for
  bounces on the free plan; paid tier prices (sources disagree).
- Payment provider availability in the company's country.
- LaunchDarkly: whether a requester may approve their own request, and how
  scheduled changes combine with approvals (their pages did not say).
- Flagsmith's precedence between environment, segment and identity overrides
  (the page fetched did not state it).
- Every I/O number in Section 10 (estimates from the 5b formulas).
- Retool and Intercom were not researched from primary sources; nothing in
  this plan depends on them.

---

## 18. Sources (research date 2026-11-21)

Convex

- Limits by plan, free-plan hard caps, concurrency, sessions, deployments per
  team: https://docs.convex.dev/production/state/limits
- Custom domains ("Custom domains require a Convex Pro plan"; `CONVEX_CLOUD_URL`,
  `CONVEX_SITE_URL`): https://docs.convex.dev/production/custom-domains
- HTTP actions (served on `*.convex.site`, 20 MiB form bodies, 100 MiB
  responses, CORS): https://docs.convex.dev/functions/http-actions
- Pricing: https://www.convex.dev/pricing and https://www.convex.dev/plans
  (search extracts)
- Teams: https://docs.convex.dev/dashboard/teams ; community report on the
  free-team limit: https://discord-questions.convex.dev/m/1452057023351881769
- Management API deploy keys (why the console does not use one):
  https://docs.convex.dev/management-api/create-deploy-key

Cloudflare

- Zero Trust plans (Free up to 50 users; pay-as-you-go $7 per user per month):
  https://www.cloudflare.com/plans/sase-zero-trust.md (search extract of the
  official plans page)
- Access policies (selectors: e-mails, country, IP, posture, certificate,
  service token): https://developers.cloudflare.com/cloudflare-one/access-controls/policies/
- MFA requirements ("PIV and FIDO2 key authenticators only work with
  infrastructure applications"):
  https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/
- Validating the Access token (header, certs address, `aud`, six-week key
  rotation):
  https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- Session durations and revoking a user:
  https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/
- Temporary authentication and purpose justification:
  https://developers.cloudflare.com/cloudflare-one/access-controls/policies/temporary-auth/
- WAF rate limiting rules by plan:
  https://developers.cloudflare.com/waf/rate-limiting-rules/
- Turnstile plans: https://developers.cloudflare.com/turnstile/plans/
- Static assets billing ("free and unlimited"):
  https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/

Entitlements, flags, approvals

- Stripe Entitlements (features with `lookup_key`, the active-entitlement
  summary webhook, "persist these entitlements internally for faster
  resolution"): https://docs.stripe.com/billing/entitlements
- Stripe dashboard roles (Support Specialist, View only, Analyst and others;
  warning on combined roles):
  https://docs.stripe.com/get-started/account/teams/roles
- Unleash change requests (four-eyes principle, states, scheduling, suspended
  on conflict): https://docs.getunleash.io/reference/change-requests
- LaunchDarkly approvals: https://launchdarkly.com/docs/home/releases/approvals
- LaunchDarkly scheduled changes:
  https://launchdarkly.com/docs/home/releases/scheduled-changes
- LaunchDarkly environment settings ("Require comments", "Require
  confirmation", critical environments):
  https://launchdarkly.com/docs/home/account/environment/settings
- Flagsmith identity overrides:
  https://docs.flagsmith.com/basic-features/managing-identities

Support access

- Zendesk account assumption (customer-granted, timed, revocable, admins
  notified): https://support.zendesk.com/hc/en-us/articles/4408824477082 and
  https://support.zendesk.com/hc/en-us/articles/115001753608

E-mail

- Resend quotas (free: 100 a day, 3,000 a month; 10 requests a second;
  bounce under 4 %, spam under 0.08 %):
  https://resend.com/docs/knowledge-base/account-quotas-and-limits
- Resend pricing: https://resend.com/pricing

Repository

- `CLAUDE.md`; `docs/prd.md` (10, 11.1, 21);
  `docs/plans/tenant-admin-panel-recommendation.md`;
  `docs/plans/post-phase-5-architecture-and-io.md` (2, 3, 4.5, 5, 6, 8);
  `convex/schema.ts` (`orgPlans`, `platformSettings`, `platformSecrets`,
  `platformFlags`, `platformAudit`); `convex/plans.ts`; `convex/platform.ts`;
  `convex/lib/plans.ts`; `convex/lib/validators.ts`; `convex/passkeys.ts`;
  `apps/dashboard/src/components/ServerTable.tsx`.
