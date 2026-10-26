# Operator console for tenants: recommendation (2026-10-27)

Status: **recommendation, not a plan.** Nothing here is built. It needs one decision from the
owner (Section 7) before it becomes a phase. It does not change Phase 4: the schema already
carries `orgId` everywhere and Section 4.6 of the Phase 4 plan lists what a second organization
still needs.

No web application is "not penetratable", and a document that says so is wrong. The goal is
narrower and testable: **no single compromise (one stolen password, one XSS bug, one operator
laptop, one leaked key) gives anyone a tenant's data or the ability to push a policy to a
tenant's devices.** Everything below serves that sentence.

## 1. The decision under it: how tenants are separated

| Model | Isolation | Cost and effort | Verdict |
|---|---|---|---|
| **A. One Convex deployment per tenant ("silo")** | A bug in authorization can only ever expose the one tenant it ran in. No query path crosses tenants. The same code and schema as self-hosting (MIT). | A deployment per tenant to provision, upgrade and monitor; Convex plan limits per deployment apply (check pricing). | **Recommended for any paid or hosted offer.** |
| B. One deployment, many organizations (`orgId` rows) | Isolation is only as good as every `assertInOrg` call and index. One missed check leaks across tenants. | Cheapest to run; the Phase 4 schema is already ready for it. | Acceptable for a free tier, only with the authorization test table of Phase 4 Section 4.6 enforced in CI. |

Provisioning in model A: Convex documents a Management API that creates **deploy keys** for an
existing deployment (`POST /deployments/:name/create_deploy_key`) and scripting through the CLI
with `CONVEX_DEPLOY_KEY`. A call that creates a project and its deployment is mentioned by users
and appears to be in beta; **this is not verified end to end and must be tested in a spike before
the plan relies on it** (sources at the end).

## 2. Shape: a control plane that cannot touch tenant data

```
Operator browser ──► Cloudflare Access / Tailscale ──► Operator Console (own origin)
                          (SSO + hardware key + device posture)        │
                                                                       ▼
                                                   Control-plane Convex deployment
                                                   (tenants, plans, usage, operator audit)
                                                                       │ least-privilege deploy keys
                                       ┌───────────────────────────────┼───────────────────────┐
                                       ▼                               ▼                       ▼
                               Tenant A deployment             Tenant B deployment      Tenant C ...
                               (own members, devices,          (own signing seed)
                                own signing seed)
```

Rules that make this safe:

1. **Separate app, separate origin, separate deployment, separate auth.** The tenant dashboard
   contains no operator code, no operator routes and no shared cookies or sessions. The console
   never imports tenant dashboard code.
2. **The console cannot sign or publish policies.** Each tenant's Ed25519 policy seed lives only
   in that tenant's deployment environment (Phase 4 Section 4.5). The console holds no signing key
   and has no function that publishes desired state. A fully compromised console can suspend or
   delete tenants (noisy, reversible within the soft-delete window) but cannot run code on any
   tenant's devices. This is the most important rule of the whole design.
3. **The console sees metadata only:** tenant name, plan, status, device and employee counts,
   usage, agent versions, health, last activity. Never employee records, files, passwords, audit
   contents or document names.
4. **Support access is consented, time-boxed and read-only.** A tenant owner switches on "allow
   Rulebox support" for 1 hour; that creates a viewer-role member in their deployment that expires
   by itself. Every use is written to the tenant's own audit log and to the operator audit log. No
   standing access, no "impersonate" that acts as a tenant user.
5. **Deploy keys are per deployment, least privilege, stored encrypted** (envelope encryption
   with a key held outside the database), never shown in the UI, never logged, rotated on a schedule
   and on every operator offboarding.
6. **A revoked or suspended tenant's devices stay locked** (the existing rule: never unlock
   remotely). Suspension is a state change, not a deletion.

## 3. Who can sign in, and how

| Layer | Control |
|---|---|
| Network | Console is unreachable without Cloudflare Access (or Tailscale): SSO, **hardware security key required**, device posture or client certificate (mTLS), country and IP allowlist. Cloudflare documents posture checks and mTLS for Access; requiring FIDO2 keys specifically must be confirmed in their Access authentication docs (not found in one official guide). |
| Application | Second, independent login: **passkeys only (WebAuthn), no passwords.** Sessions at most 8 hours, 15 minutes idle. A stolen Access session alone is not enough. |
| Step-up | Re-authenticate with the passkey for: suspend, delete, restore, rotate a key, grant or end support access, change an operator. |
| Two-person rule | Delete tenant, rotate the control-plane encryption key, add or remove an operator, break-glass use: a second operator approves in the console. |
| Roles | `viewer` (metadata), `support` (can request consented access), `admin` (lifecycle), `owner` (operators and keys). Two or three humans in total; no shared accounts. |
| Break-glass | One sealed offline credential, stored apart, alarmed on use, rotated after any use. |

## 4. Hardening checklist for the build

- Strict CSP (no inline scripts, no third-party scripts, no CDN), `frame-ancestors 'none'`,
  `X-Content-Type-Options`, Referrer-Policy, Permissions-Policy; no `dangerouslySetInnerHTML`; every
  input validated on the server with typed validators; output encoded; no user-supplied URLs fetched
  by the server without an allowlist (SSRF).
- Every function behind a wrapper that checks the operator role, the step-up freshness and writes an
  audit row; a lint rule forbids raw `query/mutation/action` (same pattern as Phase 4).
- Operator audit log: append-only, hash-chained, **copied off the box** to storage the console
  cannot rewrite; alerts on every sign-in, step-up, failed login, role change and support session.
- Rate limits and lockouts on every endpoint; generic errors; no enumeration.
- Supply chain: pinned versions, `minimumReleaseAge`, lockfile review, dependency and secret
  scanning in CI, protected branches, signed commits, deploys only from the protected branch by CI.
- Data lifecycle: 30-day soft delete, tested restore, tenant data export, backups of the control
  plane, a written incident runbook and a tested kill switch (suspend all tenants' syncing).
- `security.txt`, a disclosure address, and **an independent penetration test before the first
  paying tenant**, repeated after every major change. Automated tests cannot replace it.

## 5. What this does not protect against (say it out loud)

- Physical access to a kiosk PC (BIOS, safe mode, boot media): Phase 5 documents residual risk.
- A malicious or coerced operator with the two-person approvals: limited by the metadata-only view,
  the missing signing key and the off-box audit log, not eliminated.
- A zero-day in Convex, Cloudflare or the browser. Mitigated by silo isolation and the layers above,
  not removed.
- A tenant owner losing their own credentials: recovery is a deliberate, audited, consented process.

## 6. When to build it

Not in v1 (self-hosted, one organization per deployment, Decision D1 of Phase 4). Suggested
slot: **after the Phase 6 pilot**, as its own phase ("hosted offer"), starting with a one-week spike
to prove automated provisioning and upgrades of a tenant deployment. Until then, the only work that
helps is keeping Phase 4's multi-organization rules and tests intact.

## 7a. Decision taken (2026-10-27)

The owner chose **hosted service**. The silo model (A) stays the recommendation; operators and the
first-tenant count are still open. Consequences are listed in "What hosting changes" below.

## 7. Decision needed from the owner

1. Will Rulebox be offered as a **hosted service** (you run the tenants), or only self-hosted?
   If only self-hosted, this console is not needed and each customer is simply their own deployment.
2. If hosted: model A (silo per tenant, recommended) or model B (shared deployment, free tier only)?
3. Who are the first operators (people count decides the two-person rule and break-glass design)?

## Sources

- Convex Management API, create deploy key: https://docs.convex.dev/management-api/create-deploy-key
- Convex platform APIs: https://docs.convex.dev/platform-apis
- Convex deploy key types: https://docs.convex.dev/cli/deploy-key-types
- Cloudflare Access (posture, mTLS): https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/configure/modes/device-information-only/

## What hosting changes (added after the decision)

Code that must stay true now (Phase 4 and 6 hooks):

1. **A device must find its tenant.** The agent talks to one Convex deployment, and `VITE_CONVEX_URL` is a
   build-time value in the dashboard. Hosted needs (a) a tenant locator inside the enrollment code (or a
   small resolver in the control plane that maps code prefix to deployment URL) and (b) a dashboard that reads its
   deployment URL at run time from the host name (`acme.app.example`), not from the build. Decide this
   before Phase 4 Step 6 (enrollment codes) is written.
2. **Owner bootstrap must be callable by the control plane.** `setup:createOwnerInvite` is internal and CLI-only
   today; provisioning runs it with that tenant's deploy key (`npx convex run`), then emails the invite link.
3. **Per-tenant configuration lives in the tenant deployment** (signing seed, rate limits, quotas), set by the
   provisioning script, never by hand.
4. **Upgrades roll out tenant by tenant** (canary tenants first). Schema migrations follow the widen-then-narrow rule
   of Phase 4 Section 11 because a fleet of deployments will briefly run different versions.

Work that is new (not in any phase yet):

| Area | What it needs |
|---|---|
| Billing | Plans, usage metering (devices), invoices, dunning, suspend-on-non-payment that keeps devices locked. Use an existing provider; never store card data. |
| Legal | Terms, privacy policy, data processing agreement, sub-processor list (Convex, Cloudflare, the file host), data residency statement, deletion and export on request. Needs a lawyer, not code. |
| Operations | Status page, uptime monitoring and alerts, on-call, backup and restore drills, incident runbook, per-tenant cost dashboard. |
| Onboarding | Self-serve or sales-assisted sign-up, tenant provisioning (spike first), welcome flow, custom domain or subdomain per tenant. |
| Installer hosting | Customers upload installers: the Tigris plan in the project notes becomes a hosted-service component with per-tenant quotas and malware scanning. |
| Security | Independent penetration test before the first paying tenant, a disclosure address, secrets manager, operator offboarding procedure. |
| Cost | A paid Convex plan per tenant deployment is likely (limits and pricing **unverified**; check before pricing the product). The free-tier heartbeat scaling work of Phase 4 stays useful for small tenants. |
| Licensing | The code is MIT; a hosted offer competes with anyone who self-hosts it. Decide what is the product (convenience, support, SLA) and whether the Rulebox name and logo need trademark protection. |
## Decision update (2026-10-27, later): pooled first, separate control plane

Replaces the "silo per tenant is recommended" parts above for the first launch.

1. **Tenants are organizations inside ONE shared Convex deployment ("data plane").** Free sign-up gets
   `maxDevices = 2` by default; enrollment refuses a new PC at the limit and the dashboard shows "contact us to upgrade".
   The operator changes the default or one tenant's limit from the console. A device finds its tenant with no locator:
   there is one URL. (The "device finds its tenant" question of the previous section is closed.)
   Large paying customers can move to their own deployment later; the code is the same.
2. **The operator console is a separate app AND a separate Convex deployment ("control plane").** It holds operator
   accounts (passkey only), plans, the default limits, the file-storage pool settings and the operator audit log.
   It reaches the data plane only through a small authenticated platform API in the data plane that can: list tenant
   metadata and counts, set `plan` / `maxDevices`, suspend or restore a tenant. It has no function that reads employee
   data, files or audit contents, and it holds no policy signing key.
3. **Per-organization signing keys.** In a shared deployment one environment seed would sign for every tenant. Phase 4
   leaves this open; it must be solved (master key in the environment encrypting each organization's seed, or an external
   key service) before the first outside tenant.
4. **Free sign-up abuse controls:** email verification, rate limits, captcha, one free organization per verified email,
   cleanup of inactive free tenants after a warning.
5. **File-storage cloud pool** (customers' installers and uploads, free tiers pooled across accounts, per-tenant quota,
   automatic switch when an account is full) is configured from the console and planned together with it. The note
   in the project memory (Tigris) is the starting point; the plan must also cover credentials handling, malware scanning
   and deletion.
6. **Database I/O is the scarce resource** (the free plan gives about 1 GB, about 3 GB with referrals; figures to be
   verified). A dedicated post-Phase-5 planning pass owns it: per-device and per-day I/O budget, cost of live
   subscriptions (every change re-reads what each open dashboard watches), heartbeat and status write policy,
   rate-limiter and audit writes, pagination and what each screen subscribes to.
