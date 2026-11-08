// One call per INTERNAL function, for the I/O budget test (convex/ioBudgets.test.ts, Phase 4 Step 18
// item 9). Internal queries and mutations count their reads and writes through the same probe layer as the
// public ones (`lib/functions.ts`); internal actions count what the internal functions they call do.
// Kept outside convex/ so the Convex bundler never pushes it.
//
// Every case runs on the large-org fixture (`largeOrg.ts`) plus a second organization, and returns the call
// to measure after doing its own setup UNPROBED (rows the function needs that the fixture does not have).
// A function that cannot run here has an entry in `UNMEASURED` with the reason; its row in
// `convex/ioBudgets.ts` is marked ESTIMATE.
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { base64Encode, sha256HexSync } from "../../convex/lib/crypto";
import { requestPublish } from "../../convex/lib/publish";
import { recoveryHash } from "../../convex/lib/recoveryCodes";
import { MINUTE_MS } from "../../convex/lib/limits";
import { giveStepUp, makeOrg, asMember, type Member } from "./identity";
import { seedLargeOrg, LARGE } from "./largeOrg";
import type { Fixture } from "./matrixRows";

declare const process: { env: Record<string, string | undefined> };

export type InternalEnv = {
  f: Fixture;
  /** An admin of the fixture's organization with a PIN and a fresh step-up row. */
  u: Member;
  /** A second admin session of the same person is NOT created; use `moreSessions` when a case needs them. */
  actor: { type: "member"; id: string; label: string };
  /** An `E2E io` organization with large-org rows and an owner (for the `testing:*` functions), made on first use. */
  e2e: () => Promise<{ orgId: Id<"organizations">; owner: Member }>;
};
export type InternalCase = (c: InternalEnv) => Promise<() => Promise<unknown>>;

/** The app's Argon2id parameters, any salt / hash: what `employees:isAppPhc` and `testing:storeKnownPin` accept. */
export const PHC = "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const HEX = (s: string) => sha256HexSync(s);
const MAIL = { to: "ana@acme.test", subject: "Hello", text: "Body" };

/** The master key + mail settings, as `platform:setSecret` stores them (fetch is stubbed by the test). */
async function mailOn(c: InternalEnv): Promise<void> {
  process.env.RULEBOX_PLATFORM_KEY = base64Encode(Uint8Array.from({ length: 32 }, (_, i) => i));
  const t = c.f.t;
  await t.action(internal.platform.setSecret, { name: "resendApiKey", value: "re_TestKeyNotReal_0123456789" });
  await t.action(internal.platform.setSecret, { name: "resendFrom", value: "Rulebox <no-reply@rulebox.test>" });
  await t.action(internal.platform.setSecret, { name: "dashboardOrigin", value: "https://dashboard.rulebox.test" });
}

/** `n` other sessions of the person, each with a step-up row (what a PIN change or reset has to sign out). */
async function moreSessions(c: InternalEnv, n: number): Promise<void> {
  await c.f.t.run(async (ctx) => {
    for (let i = 0; i < n; i++) {
      const sessionId = await ctx.db.insert("authSessions", { userId: c.u.userId, expirationTime: Date.now() + 3_600_000 });
      await ctx.db.insert("stepUpSessions", { sessionId, userId: c.u.userId, verifiedAt: Date.now(), lastActiveAt: Date.now(), method: "actionPin" });
    }
  });
}

async function passkeyOf(c: InternalEnv, credentialId = "cred-io-1"): Promise<Id<"passkeys">> {
  return await c.f.t.run((ctx) =>
    ctx.db.insert("passkeys", {
      userId: c.u.userId,
      credentialId,
      credentialPublicKey: "AAAA",
      counter: 0,
      transports: ["internal"],
      name: "Key",
      aaguid: "00000000-0000-0000-0000-000000000000",
      deviceType: "multiDevice",
      backedUp: true,
      createdAt: Date.now(),
    }),
  );
}

const winget = {
  packageId: "7zip.7zip",
  version: "24.08",
  install: {
    kind: "msi" as const,
    url: "https://example.com/7z.msi",
    sha256: "a".repeat(64),
    sizeBytes: 1_000_000,
    silentArgs: [],
    successExitCodes: [0],
    removeWhenUnassigned: false,
  },
};

const OLD = 400 * 24 * 60 * MINUTE_MS;

export const INTERNAL_CALLS: Record<string, InternalCase | InternalCase[]> = {
  // ---------------------------------------------------------------- account
  "account:authorize": async (c) => () =>
    c.u.as.query(internal.account.authorize, { minRole: "viewer", orgId: c.f.orgId, now: Date.now(), stepUp: "unlocked" }),
  "account:checkJoinInvite": async (c) => () => c.f.t.query(internal.account.checkJoinInvite, { tokenHash: "0".repeat(64), email: "inv@acme.test" }),
  "account:consumeResetCode": async (c) => {
    await c.f.t.run((ctx) =>
      ctx.db.insert("invites", { orgId: c.f.orgId, email: c.u.email, role: "viewer", kind: "passwordReset", tokenHash: HEX("reset-io"), expiresAt: Date.now() + 3_600_000 }),
    );
    return () => c.f.t.mutation(internal.account.consumeResetCode, { tokenHash: HEX("reset-io"), email: c.u.email });
  },
  "account:auditPasswordReset": async (c) => () =>
    c.f.t.mutation(internal.account.auditPasswordReset, { orgId: c.f.orgId, memberId: c.u.memberId, email: c.u.email }),
  "account:deliverPinReset": async (c) => {
    await mailOn(c);
    return () => c.f.t.action(internal.account.deliverPinReset, { userId: c.u.userId });
  },
  "account:createPinReset": async (c) => () => c.f.t.mutation(internal.account.createPinReset, { userId: c.u.userId, tokenHash: HEX("pin-io"), now: Date.now() }),
  "account:pinResetCaller": async (c) => () => c.u.as.query(internal.account.pinResetCaller, { now: Date.now() }),
  "account:finishPinReset": async (c) => {
    await c.f.t.run((ctx) =>
      ctx.db.insert("pinResets", { userId: c.u.userId, tokenHash: HEX("pin-io"), createdAt: Date.now(), expiresAt: Date.now() + 30 * MINUTE_MS }),
    );
    await moreSessions(c, 10);
    return () =>
      c.f.t.mutation(internal.account.finishPinReset, { userId: c.u.userId, sessionId: c.u.sessionId, tokenHash: HEX("pin-io"), hash: PHC, now: Date.now() });
  },
  "account:signOutStepUp": async (c) => {
    await moreSessions(c, 10);
    return () => c.f.t.mutation(internal.account.signOutStepUp, { userId: c.u.userId });
  },
  "account:passwordAccountOf": async (c) => () => c.f.t.query(internal.account.passwordAccountOf, { userId: c.u.userId }),
  "account:finishPasswordChange": async (c) => {
    await moreSessions(c, 10);
    return () => c.f.t.mutation(internal.account.finishPasswordChange, { userId: c.u.userId, sessionId: c.u.sessionId });
  },

  // ---------------------------------------------------------------- apps
  // A full batch: APP_PURGE_BATCH install results and grants of the app.
  "apps:purgeApp": async (c) => {
    await c.f.t.run(async (ctx) => {
      const employees = await ctx.db.query("employees").withIndex("by_org_username", (q) => q.eq("orgId", c.f.orgId)).take(100);
      for (const e of employees) await ctx.db.insert("employeeApps", { orgId: c.f.orgId, employeeId: e._id, appId: c.f.appId });
      for (let i = 0; i < 100; i++) {
        await ctx.db.insert("installResults", { orgId: c.f.orgId, deviceId: c.f.deviceId, appId: c.f.appId, state: "failed", appRevision: 0, attempts: 1, updatedAt: Date.now() - i });
      }
    });
    return () => c.f.t.mutation(internal.apps.purgeApp, { appId: c.f.appId });
  },
  "apps:iconTarget": async (c) => () => c.f.t.query(internal.apps.iconTarget, { orgId: c.f.orgId, appId: c.f.appId }),
  "apps:attachIcon": async (c) => {
    const storageId = await c.f.t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(32)], { type: "image/png" })));
    return () => c.f.t.mutation(internal.apps.attachIcon, { orgId: c.f.orgId, actor: c.actor, appId: c.f.appId, storageId, sha256: "b".repeat(64), sizeBytes: 32 });
  },
  "apps:cachedWinget": async (c) => {
    await c.f.t.mutation(internal.apps.storeWinget, { packageId: "7zip.7zip", version: "", resolved: winget, now: Date.now() });
    return () => c.f.t.query(internal.apps.cachedWinget, { packageId: "7zip.7zip", version: "", now: Date.now() });
  },
  "apps:storeWinget": async (c) => () => c.f.t.mutation(internal.apps.storeWinget, { packageId: "7zip.7zip", version: "", resolved: winget, now: Date.now() }),

  // ---------------------------------------------------------------- device API
  "deviceApi:loadForVerify": async (c) => () =>
    c.f.t.query(internal.deviceApi.loadForVerify, { deviceId: c.f.deviceId, deviceSecret: c.f.deviceSecret, username: "maya", now: Date.now() }),
  "deviceApi:finishVerify": async (c) => () =>
    c.f.t.mutation(internal.deviceApi.finishVerify, { deviceId: c.f.deviceId, orgId: c.f.orgId, employeeId: c.f.employeeId, failed: true, contact: true }),
  "deviceApi:reserveAttempt": async (c) => () => c.f.t.mutation(internal.deviceApi.reserveAttempt, { deviceId: c.f.deviceId }),
  "devices:authorizeDevice": async (c) => () => c.f.t.query(internal.devices.authorizeDevice, { deviceId: c.f.deviceId, deviceSecret: c.f.deviceSecret }),

  // ---------------------------------------------------------------- employees
  "employees:createPrecheck": async (c) => () =>
    c.f.t.query(internal.employees.createPrecheck, { orgId: c.f.orgId, username: "newbie", groupIds: [c.f.groupId], appIds: [c.f.appId] }),
  "employees:storeNew": async (c) => () =>
    c.f.t.mutation(internal.employees.storeNew, { orgId: c.f.orgId, actor: c.actor, name: "New Hire", username: "newbie", groupIds: [c.f.groupId], appIds: [c.f.appId], phc: PHC }),
  "employees:passwordTarget": async (c) => () => c.f.t.query(internal.employees.passwordTarget, { orgId: c.f.orgId, employeeId: c.f.employeeId }),
  "employees:storePassword": async (c) => () =>
    c.f.t.mutation(internal.employees.storePassword, { orgId: c.f.orgId, actor: c.actor, employeeId: c.f.employeeId, username: "maya", phc: PHC }),
  // A full batch (ROSTER_RESYNC_BATCH) of removals that waited for a signing key.
  "employees:resyncRoster": async (c) => {
    await c.f.t.run(async (ctx) => {
      for (let i = 0; i < 50; i++) await ctx.db.insert("rosterPending", { orgId: c.f.orgId, groupId: c.f.groupId, employeeId: `gone-${i}` });
    });
    return () => c.f.t.mutation(internal.employees.resyncRoster, { orgId: c.f.orgId });
  },

  // ---------------------------------------------------------------- enrollment codes, fleet, mail
  "enrollmentCodes:storeCode": async (c) => () =>
    c.f.t.mutation(internal.enrollmentCodes.storeCode, { orgId: c.f.orgId, actor: c.actor, groupId: c.f.groupId, uses: 1, ttlMinutes: 60, tokenHash: HEX("code-io") }),
  // A full batch of the PC's install results (the other four tables are empty for a PC that never had a document).
  "fleet:purgeDevice": async (c) => {
    await c.f.t.run(async (ctx) => {
      for (let i = 0; i < 100; i++) {
        await ctx.db.insert("installResults", { orgId: c.f.orgId, deviceId: c.f.deviceId, appId: c.f.appId, state: "failed", appRevision: 0, attempts: 1, updatedAt: Date.now() - i });
      }
    });
    return () => c.f.t.mutation(internal.fleet.purgeDevice, { deviceId: c.f.deviceId });
  },
  "mail:send": async (c) => {
    await mailOn(c);
    return () => c.f.t.action(internal.mail.send, MAIL);
  },

  // ---------------------------------------------------------------- maintenance (one run = one batch)
  // A full backlog (more than MAINTENANCE_BATCH expired rows), so the run deletes a whole batch.
  "maintenance:daily": async (c) => {
    await c.f.t.run(async (ctx) => {
      for (let i = 0; i < 520; i++) await ctx.db.insert("authSessions", { userId: c.u.userId, expirationTime: 1 });
    });
    return () => c.f.t.mutation(internal.maintenance.daily, { stage: "sessions", now: Date.now() + OLD });
  },
  "maintenance:pruneAudit": async (c) => () => c.f.t.mutation(internal.maintenance.pruneAudit, { now: Date.now() + OLD }),
  "maintenance:migratePlans": async (c) => () => c.f.t.mutation(internal.maintenance.migratePlans, {}),
  "maintenance:migrateDevices": async (c) => () => c.f.t.mutation(internal.maintenance.migrateDevices, {}),
  "maintenance:narrowDevices": async (c) => () => c.f.t.mutation(internal.maintenance.narrowDevices, {}),
  "maintenance:dropDesiredStates": async (c) => () => c.f.t.mutation(internal.maintenance.dropDesiredStates, {}),
  "maintenance:dropTotpTables": async (c) => {
    await c.f.t.run(async (ctx) => {
      for (let i = 0; i < 100; i++) {
        await ctx.db.insert("memberSecrets", { userId: c.u.userId, recoveryHashes: [], lastTotpStep: 0, totpFailures: 0, totpLockedUntil: 0 });
        await ctx.db.insert("mfaSessions", { sessionId: c.u.sessionId, userId: c.u.userId, verifiedAt: Date.now() });
      }
    });
    return () => c.f.t.mutation(internal.maintenance.dropTotpTables, {});
  },

  // ---------------------------------------------------------------- members, plans
  "members:storeInvite": async (c) => () =>
    c.f.t.mutation(internal.members.storeInvite, { orgId: c.f.orgId, actor: c.actor, callerRole: "owner", email: "new@acme.test", role: "viewer", tokenHash: HEX("invite-io") }),
  "members:storeResetCode": async (c) => () =>
    c.f.t.mutation(internal.members.storeResetCode, { orgId: c.f.orgId, actor: c.actor, memberId: c.f.targetMemberId, tokenHash: HEX("reset-code-io") }),
  "plans:show": async (c) => () => c.f.t.query(internal.plans.show, { orgId: c.f.orgId }),
  "plans:setGlobalPingInterval": async (c) => () => c.f.t.mutation(internal.plans.setGlobalPingInterval, { pingIntervalMs: 3_600_000 }),
  "plans:setOrgPingInterval": async (c) => () => c.f.t.mutation(internal.plans.setOrgPingInterval, { orgId: c.f.orgId, pingIntervalMs: 300_000 }),
  "plans:setLimits": async (c) => () => c.f.t.mutation(internal.plans.setLimits, { orgId: c.f.orgId, limits: { maxGroups: 10 }, note: "io" }),
  "plans:setPlanDefaults": async (c) => () => c.f.t.mutation(internal.plans.setPlanDefaults, { plan: "free", limits: { maxApps: 30 } }),

  // ---------------------------------------------------------------- platform
  "platform:setSecret": async (c) => {
    process.env.RULEBOX_PLATFORM_KEY = base64Encode(Uint8Array.from({ length: 32 }, (_, i) => i));
    return () => c.f.t.action(internal.platform.setSecret, { name: "resendApiKey", value: "re_TestKeyNotReal_0123456789" });
  },
  "platform:storeSecret": async (c) => {
    await mailOn(c);
    const row = await c.f.t.run((ctx) => ctx.db.query("platformSecrets").take(1));
    const sealed = row[0]!;
    return () => c.f.t.mutation(internal.platform.storeSecret, { name: sealed.name as "resendApiKey", ciphertext: sealed.ciphertext, iv: sealed.iv });
  },
  "platform:clearSecret": async (c) => {
    await mailOn(c);
    return () => c.f.t.mutation(internal.platform.clearSecret, { name: "resendFrom" });
  },
  "platform:mailInputs": async (c) => {
    await mailOn(c);
    return () => c.f.t.query(internal.platform.mailInputs, {});
  },
  "platform:setMailFlag": async (c) => {
    await mailOn(c);
    const inputs = await c.f.t.query(internal.platform.mailInputs, {});
    return () => c.f.t.mutation(internal.platform.setMailFlag, { ready: true, stamps: inputs.map((s) => s?.updatedAt ?? null) });
  },
  "platform:refreshMailFlag": async (c) => {
    await mailOn(c);
    return () => c.f.t.action(internal.platform.refreshMailFlag, {});
  },
  "platform:readSecret": async (c) => {
    await mailOn(c);
    return () => c.f.t.query(internal.platform.readSecret, { name: "resendApiKey" });
  },
  "platform:checkSecrets": async (c) => {
    await mailOn(c);
    return () => c.f.t.action(internal.platform.checkSecrets, {});
  },
  "platform:status": async (c) => {
    await mailOn(c);
    return () => c.f.t.query(internal.platform.status, {});
  },

  // ---------------------------------------------------------------- presence, publish, settings, setup
  // Every online PC of the fixture is overdue: one batch of devices goes offline.
  "presence:sweep": async (c) => () => c.f.t.mutation(internal.presence.sweep, { now: Date.now() + OLD }),
  "presence:applyPingInterval": async (c) => {
    await c.f.t.mutation(internal.plans.setOrgPingInterval, { orgId: c.f.orgId, pingIntervalMs: 300_000 });
    return () => c.f.t.mutation(internal.presence.applyPingInterval, { orgId: c.f.orgId });
  },
  // Every PC of the organization is waiting for a new document: one batch of PUBLISH_BATCH devices is built and signed.
  "publish:run": async (c) => {
    await c.f.t.run((ctx) => requestPublish(ctx, c.f.orgId, { allDevices: true }));
    return () => c.f.t.mutation(internal.publish.run, { orgId: c.f.orgId });
  },
  "settings:storeExitPin": async (c) => () => c.f.t.mutation(internal.settings.storeExitPin, { orgId: c.f.orgId, actor: c.actor, phc: PHC }),
  "setup:createOwnerInvite": async (c) => () =>
    c.f.t.action(internal.setup.createOwnerInvite, { orgName: "Io Org", email: "io-owner@acme.test", allowAdditionalOrg: true }),
  "setup:storeOwnerInvite": async (c) => () =>
    c.f.t.mutation(internal.setup.storeOwnerInvite, { orgName: "Io Org", email: "io-owner@acme.test", allowAdditionalOrg: true, tokenHash: HEX("owner-invite-io") }),

  // ---------------------------------------------------------------- stats
  // One stage page each; the devices page (200) and the employees page (1,000) are the two heavy ones.
  "stats:reconcile": [
    async (c) => () => c.f.t.mutation(internal.stats.reconcile, { orgId: c.f.orgId, stage: "devices" }),
    async (c) => () => c.f.t.mutation(internal.stats.reconcile, { orgId: c.f.orgId, stage: "employees" }),
  ],
  "stats:reconcileAll": async (c) => () => c.f.t.mutation(internal.stats.reconcileAll, {}),
  "stats:retagDevice": async (c) => () => c.f.t.mutation(internal.stats.retagDevice, { deviceId: c.f.deviceId, cursor: "" }),

  // ---------------------------------------------------------------- step-up
  "stepUp:storeRecoveryCodes": async (c) => () =>
    c.f.t.mutation(internal.stepUp.storeRecoveryCodes, {
      userId: c.u.userId,
      orgId: c.f.orgId,
      actor: c.actor,
      hashes: Array.from({ length: 10 }, (_, i) => HEX(`recovery-${i}`)),
    }),
  "stepUp:authorizeChange": async (c) => () => c.f.t.query(internal.stepUp.authorizeChange, { userId: c.u.userId, sessionId: c.u.sessionId, now: Date.now() }),
  "stepUp:storeActionPin": async (c) => {
    await moreSessions(c, 10);
    return () => c.f.t.mutation(internal.stepUp.storeActionPin, { userId: c.u.userId, sessionId: c.u.sessionId, orgId: c.f.orgId, actor: c.actor, hash: PHC });
  },
  "stepUp:beginPinAttempt": async (c) => () => c.f.t.mutation(internal.stepUp.beginPinAttempt, { userId: c.u.userId, now: Date.now() }),
  "stepUp:finishPinSuccess": async (c) => () =>
    c.f.t.mutation(internal.stepUp.finishPinSuccess, {
      userId: c.u.userId,
      sessionId: c.u.sessionId,
      now: Date.now(),
      reservedAt: Date.now(),
      hashChecked: "not-a-real-hash",
    }),
  "stepUp:noticePinFailures": async (c) => () =>
    c.f.t.mutation(internal.stepUp.noticePinFailures, { userId: c.u.userId, orgId: c.f.orgId, actor: c.actor, lockoutMs: 0, failures: 3 }),
  "stepUp:recoveryReset": async (c) => {
    await c.f.t.run(async (ctx) => {
      const factors = (await ctx.db.query("stepUpFactors").withIndex("by_user", (q) => q.eq("userId", c.u.userId)).first())!;
      await ctx.db.patch(factors._id, { recoveryHashes: [recoveryHash("ABCD-EFGH"), ...Array.from({ length: 9 }, (_, i) => HEX(`recovery-${i}`))] });
    });
    await moreSessions(c, 10);
    return () =>
      c.f.t.mutation(internal.stepUp.recoveryReset, {
        userId: c.u.userId,
        sessionId: c.u.sessionId,
        orgId: c.f.orgId,
        actor: c.actor,
        code: "ABCD-EFGH",
        hash: PHC,
        now: Date.now(),
      });
  },
  "stepUp:createChallenge": async (c) => {
    await passkeyOf(c);
    return () =>
      c.f.t.mutation(internal.stepUp.createChallenge, {
        userId: c.u.userId,
        sessionId: c.u.sessionId,
        purpose: "verify",
        challengeHash: HEX("challenge-io"),
        webauthnUserIdCandidate: "AAAAAAAAAAAAAAAAAAAAAA",
        now: Date.now(),
      });
  },
  "stepUp:consumeChallenge": async (c) => {
    await passkeyOf(c);
    await c.f.t.mutation(internal.stepUp.createChallenge, {
      userId: c.u.userId,
      sessionId: c.u.sessionId,
      purpose: "verify",
      challengeHash: HEX("challenge-io"),
      webauthnUserIdCandidate: "AAAAAAAAAAAAAAAAAAAAAA",
      now: Date.now(),
    });
    return () =>
      c.f.t.mutation(internal.stepUp.consumeChallenge, {
        userId: c.u.userId,
        sessionId: c.u.sessionId,
        purpose: "verify",
        challengeHash: HEX("challenge-io"),
        credentialId: "cred-io-1",
        now: Date.now(),
      });
  },
  "stepUp:storePasskey": async (c) => () =>
    c.f.t.mutation(internal.stepUp.storePasskey, {
      userId: c.u.userId,
      sessionId: c.u.sessionId,
      orgId: c.f.orgId,
      actor: c.actor,
      credentialId: "cred-io-new",
      credentialPublicKey: "AAAA",
      counter: 0,
      transports: ["internal"],
      name: "Laptop",
      aaguid: "00000000-0000-0000-0000-000000000000",
      deviceType: "multiDevice",
      backedUp: true,
    }),
  "stepUp:finishPasskeySuccess": async (c) => {
    const passkeyId = await passkeyOf(c);
    return () => c.f.t.mutation(internal.stepUp.finishPasskeySuccess, { userId: c.u.userId, sessionId: c.u.sessionId, passkeyId, newCounter: 1, now: Date.now() });
  },
  "stepUp:flagClone": async (c) => {
    const passkeyId = await passkeyOf(c);
    await moreSessions(c, 10);
    return () => c.f.t.mutation(internal.stepUp.flagClone, { userId: c.u.userId, passkeyId, orgId: c.f.orgId, actor: c.actor });
  },

  // ---------------------------------------------------------------- testing:* (TEST-ONLY seed helpers; RULEBOX_ALLOW_TEST_SEED=1 for the run)
  "testing:seedE2E": async (c) => () => c.f.t.action(internal.testing.seedE2E, { runId: "io" }),
  "testing:registerSeedKey": async (c) => { const e = await c.e2e(); return () => c.f.t.mutation(internal.testing.registerSeedKey, { orgId: e.orgId }); },
  "testing:setKnownPin": async (c) => { const e = await c.e2e(); return () => c.f.t.action(internal.testing.setKnownPin, { orgId: e.orgId, email: e.owner.email, pin: "482913" }); },
  "testing:storeKnownPin": async (c) => { const e = await c.e2e(); return () => c.f.t.mutation(internal.testing.storeKnownPin, { orgId: e.orgId, email: e.owner.email, hash: PHC }); },
  "testing:seedDevice": async (c) => { const e = await c.e2e(); return () => c.f.t.mutation(internal.testing.seedDevice, { orgId: e.orgId, secret: "x".repeat(24) }); },
  "testing:seedFleet": async (c) => () => c.f.t.mutation(internal.testing.seedFleet, { count: 200, runId: "io" }),
  "testing:simulateEdit": async (c) => { const e = await c.e2e(); return () => c.f.t.mutation(internal.testing.simulateEdit, { orgId: e.orgId }); },
  "testing:deleteOrg": async (c) => { const e = await c.e2e(); return () => c.f.t.mutation(internal.testing.deleteOrg, { orgId: e.orgId }); },
};

/** Functions the test does not run, with the reason (their budget row says ESTIMATE). */
export const UNMEASURED: Record<string, string> = {};

/** The environment of one case: an admin with a PIN and a fresh step-up row; the `E2E io` organization on demand. */
export async function internalEnv(f: Fixture): Promise<InternalEnv> {
  const u = await asMember(f.t, { role: "admin", orgId: f.orgId });
  await giveStepUp(f.t, u);
  let e2e: Awaited<ReturnType<InternalEnv["e2e"]>> | null = null;
  return {
    f,
    u,
    actor: { type: "member", id: u.memberId, label: u.email },
    e2e: async () => {
      if (e2e === null) {
        const orgId = await makeOrg(f.t, "E2E io");
        await seedLargeOrg(f.t, orgId, LARGE);
        e2e = { orgId, owner: await asMember(f.t, { role: "owner", orgId, email: "e2e-owner@example.test" }) };
      }
      return e2e;
    },
  };
}