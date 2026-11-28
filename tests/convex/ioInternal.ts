// One call per INTERNAL function, for the I/O budget test (convex/ioBudgets.test.ts, Phase 4 Step 18
// item 9). Internal queries and mutations count their reads and writes through the same probe layer as the
// public ones (`lib/functions.ts`); internal actions count what the internal functions they call do.
// Kept outside convex/ so the Convex bundler never pushes it.
//
// Every case runs on the large-org fixture (`largeOrg.ts`) plus a second organization, and returns the call
// to measure after doing its own setup UNPROBED (rows the function needs that the fixture does not have).
// A function that cannot run here has an entry in `UNMEASURED` with the reason; its row in
// `convex/ioBudgets.ts` is marked ESTIMATE.
import { vi } from "vitest";
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { base64Encode, sha256HexSync } from "../../convex/lib/crypto";
import { snapshotGroupConfig } from "../../convex/lib/groupConfig";
import { requestPublish } from "../../convex/lib/publish";
import { recoveryHash } from "../../convex/lib/recoveryCodes";
import { MINUTE_MS } from "../../convex/lib/limits";
import { giveStepUp, makeOrg, asMember, type Member } from "./identity";
import { TEST_KEY } from "./keys";
import { seedLargeOrg, LARGE } from "./largeOrg";
import { addWifi, createKeys, MASTER_A, MASTER_B, sealKeyPair, setMaster } from "./phase5";
import { APPLY_REPORT, DRIVER_ROW, type Fixture } from "./matrixRows";
import { FEED_URL, healthyFeed, INSTALLER, INSTALLER_URL, stubFetch, TARGET, VENDOR_PUBKEY } from "./feeds";

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
/** The arguments of `wifi:insertDraft` (the first step of `wifi:createWithPassphrase`). */
const WIFI_DRAFT = (c: { f: { orgId: Id<"organizations"> }; actor: { type: "member"; id: string; label: string } }) => ({
  orgId: c.f.orgId,
  actor: c.actor,
  name: "Draft",
  ssid: "Draft",
  hidden: false,
  security: "wpa2Personal" as const,
  autoConnect: true,
});
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

const FAKE_WRAPPED = { wrapped: "AAAA", masterKeyId: "0123456789abcdef" };
const FAKE_SIGNING = { keyId: "1111111111111111", publicKey: base64Encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1)), ...FAKE_WRAPPED };
const FAKE_SEALING = { keyId: "2222222222222222", ...FAKE_WRAPPED };

/** `n` `orgKeys` rows of the fixture's organization wrapped by `masterKeyId` (alternating purposes). */
async function insertOrgKeyRows(c: InternalEnv, n: number, masterKeyId: string): Promise<Id<"orgKeys">[]> {
  return await c.f.t.run(async (ctx) => {
    const ids: Id<"orgKeys">[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        await ctx.db.insert("orgKeys", {
          orgId: c.f.orgId,
          purpose: i % 2 === 0 ? "signing" : "sealing",
          keyId: `${String(i).padStart(16, "0")}`,
          wrapped: "AAAA",
          masterKeyId,
          status: i < 2 ? "active" : "retired",
          createdAt: Date.now(),
        }),
      );
    }
    return ids;
  });
}

/**
 * The fixture's organization with its own keys (a master key is set), `profiles` Wi-Fi profiles with a real passphrase
 * assigned to its group, and 25 devices of that group that each registered a sealing key.
 */
async function sealingSetup(c: InternalEnv, profiles: number): Promise<{ deviceIds: Id<"devices">[]; profiles: { id: Id<"wifiProfiles">; revision: number }[] }> {
  setMaster(MASTER_A);
  await createKeys(c.f.t, c.f.orgId);
  const out: { id: Id<"wifiProfiles">; revision: number }[] = [];
  for (let i = 0; i < profiles; i++) out.push({ id: await addWifi(c.f.t, c.f.orgId, { groupIds: [c.f.groupId], ssid: `Net ${i}` }), revision: 1 });
  const kp = sealKeyPair();
  // Direct inserts: enrolling 25 PCs through the API would trip the enrollment rate limit.
  const deviceIds = await c.f.t.run(async (ctx) => {
    const ids: Id<"devices">[] = [];
    for (let i = 0; i < 25; i++) {
      ids.push(
        await ctx.db.insert("devices", {
          orgId: c.f.orgId,
          groupId: c.f.groupId,
          name: `Seal ${i}`,
          enrolledAt: Date.now() - i,
          enrollmentTokenId: c.f.tokenId,
          revision: 0,
          sealPublicKey: kp.publicB64,
          sealKeyId: kp.keyId,
        }),
      );
    }
    return ids;
  });
  return { deviceIds, profiles: out };
}

/** The fixture group with rings on, pilot version 2 ahead of early / everyone 1 (state `rolling`), and `pilots` PCs in its pilot ring that applied version 2. */
async function rollingRollout(c: InternalEnv, pilots: number): Promise<Id<"groupRollouts">> {
  return await c.f.t.run(async (ctx) => {
    const devices = await ctx.db.query("devices").withIndex("by_group", (q) => q.eq("groupId", c.f.groupId)).take(pilots);
    for (const d of devices) {
      await ctx.db.patch(d._id, { ring: "pilot" });
      await ctx.db.insert("deviceApplyReports", {
        orgId: c.f.orgId,
        deviceId: d._id,
        appliedVersion: 2,
        config: { groupId: c.f.groupId, version: 2, ring: "pilot" },
        state: "applied",
        layers: APPLY_REPORT.layers,
        wifi: [],
        printers: [],
        capabilities: [],
        contentHash: "a".repeat(64),
        updatedAt: Date.now(),
      });
    }
    return await ctx.db.insert("groupRollouts", {
      orgId: c.f.orgId,
      groupId: c.f.groupId,
      enabled: true,
      pointers: { pilot: 2, early: 1, everyone: 1 },
      autoPromote: { enabled: false, bakeHours: 24, maxFailurePct: 10 },
      autoRollback: true,
      state: "rolling",
      stageStartedAt: Date.now(),
      revision: 1,
    });
  });
}
/**
 * (Phase 6 Step 12) A Rulebox-managed program with a vendor feed that is due now (`appFeeds` row included), optionally assigned to the
 * fixture's group. Version 1.0.0; the feed's vectors say 2.1.0.
 */
async function managedFeedApp(c: InternalEnv, name: string, opts: { assigned: boolean }): Promise<{ appId: Id<"apps">; feedId: Id<"appFeeds"> }> {
  return await c.f.t.run(async (ctx) => {
    const orgId = c.f.orgId;
    const appId = await ctx.db.insert("apps", {
      orgId,
      name,
      kind: "desktop",
      desktop: {
        source: "exe",
        exe: "{ProgramFiles}\\Zahras\\zahras.exe",
        args: [],
        fileArgTemplate: [],
        resetFolders: [],
        install: { kind: "exe", url: "https://downloads.example.com/zahras-1.0.0.exe", sha256: "a".repeat(64), sizeBytes: 1000, silentArgs: ["/S"], successExitCodes: [0], removeWhenUnassigned: false },
        version: "1.0.0",
        update: { mode: "managed", feed: { kind: "tauri", url: FEED_URL, pubkey: VENDOR_PUBKEY, target: TARGET } },
      },
      archived: false,
      revision: 0,
      createdAt: Date.now(),
    });
    if (opts.assigned) await ctx.db.insert("appAssignments", { orgId, groupId: c.f.groupId, appId, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
    const feedId = await ctx.db.insert("appFeeds", { orgId, appId, nextCheckAt: Date.now() - 1000, status: "ok", failures: 0, revision: 0 });
    return { appId, feedId };
  });
}
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
  // Phase 5 Step 16b: the app is assigned to 10 groups (MAX_CATALOG_SNAPSHOT_GROUPS), so the icon change takes a configuration version of each.
  "apps:attachIcon": async (c) => {
    const storageId = await c.f.t.run(async (ctx) => {
      const groups = await ctx.db.query("groups").withIndex("by_org_name", (q) => q.eq("orgId", c.f.orgId)).take(10);
      for (const g of groups) {
        await ctx.db.insert("appAssignments", { orgId: c.f.orgId, groupId: g._id, appId: c.f.appId, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
      }
      return await ctx.storage.store(new Blob([new Uint8Array(32)], { type: "image/png" }));
    });
    return () => c.f.t.mutation(internal.apps.attachIcon, { orgId: c.f.orgId, actor: c.actor, appId: c.f.appId, storageId, sha256: "b".repeat(64), sizeBytes: 32 });
  },
  "apps:cachedWinget": async (c) => {
    await c.f.t.mutation(internal.apps.storeWinget, { packageId: "7zip.7zip", version: "", resolved: winget, now: Date.now() });
    return () => c.f.t.query(internal.apps.cachedWinget, { packageId: "7zip.7zip", version: "", now: Date.now() });
  },
  "apps:storeWinget": async (c) => () => c.f.t.mutation(internal.apps.storeWinget, { packageId: "7zip.7zip", version: "", resolved: winget, now: Date.now() }),

  // ---------------------------------------------------------------- Phase 6 Step 12: the vendor feed resolver
  // The worst batch: ten feeds are due (and an eleventh stays for the next hour).
  "feeds:tick": async (c) => {
    for (let i = 0; i < 11; i++) await managedFeedApp(c, `Feed app ${i}`, { assigned: false });
    return () => c.f.t.mutation(internal.feeds.tick, {});
  },
  "feeds:loadForCheck": async (c) => {
    const { feedId } = await managedFeedApp(c, "Feed app", { assigned: false });
    return () => c.f.t.query(internal.feeds.loadForCheck, { feedId });
  },
  "feeds:feedForApp": async (c) => {
    const { appId } = await managedFeedApp(c, "Feed app", { assigned: false });
    return () => c.f.t.query(internal.feeds.feedForApp, { orgId: c.f.orgId, appId });
  },
  // A NEW version of an app that the fixture's group assigns, with autoPublish: the publish path of `apps:update` (the worst case).
  "feeds:recordResult": async (c) => {
    const { feedId } = await managedFeedApp(c, "Feed app", { assigned: true });
    return () =>
      c.f.t.mutation(internal.feeds.recordResult, {
        feedId,
        feedRevision: 0,
        outcome: { kind: "new", version: "2.1.0", url: INSTALLER_URL, sha256: "e".repeat(64), sizeBytes: INSTALLER.length, etag: '"v-2.1.0"' },
      });
  },
  // The whole check against a stubbed vendor feed (the real vectors): load, fetch, download, verify, publish.
  "feeds:check": async (c) => {
    const { feedId } = await managedFeedApp(c, "Feed app", { assigned: true });
    vi.stubGlobal("fetch", stubFetch(healthyFeed()));
    return () => c.f.t.action(internal.feeds.check, { feedId });
  },

  // ---------------------------------------------------------------- device API
  "deviceApi:loadForVerify": async (c) => () =>
    c.f.t.query(internal.deviceApi.loadForVerify, { deviceId: c.f.deviceId, deviceSecret: c.f.deviceSecret, username: "maya", now: Date.now() }),
  "deviceApi:finishVerify": async (c) => () =>
    c.f.t.mutation(internal.deviceApi.finishVerify, { deviceId: c.f.deviceId, orgId: c.f.orgId, employeeId: c.f.employeeId, failed: true, contact: true }),
  "deviceApi:reserveAttempt": async (c) => () => c.f.t.mutation(internal.deviceApi.reserveAttempt, { deviceId: c.f.deviceId }),
  "devices:authorizeDevice": async (c) => () => c.f.t.query(internal.devices.authorizeDevice, { deviceId: c.f.deviceId, deviceSecret: c.f.deviceSecret }),

  // ---------------------------------------------------------------- Phase 5 Step 10: keys, sealing, security counters.
  // The master key is the test's own (RULEBOX_MASTER_KEY); `ioBudgets.test.ts` removes it after every case.
  // A Phase 4 organization (it has its registered key): only the sealing key is made. A new organization: both, a publish.
  "keys:createOrgKeys": [
    async (c) => {
      setMaster(MASTER_A);
      return () => c.f.t.action(internal.keys.createOrgKeys, { orgId: c.f.orgId });
    },
    async (c) => {
      setMaster(MASTER_A);
      const orgId = await makeOrg(c.f.t, "Fresh", { noKey: true });
      return () => c.f.t.action(internal.keys.createOrgKeys, { orgId });
    },
  ],
  "keys:storeOrgKeys": async (c) => {
    const orgId = await makeOrg(c.f.t, "Fresh", { noKey: true });
    return () => c.f.t.mutation(internal.keys.storeOrgKeys, { orgId, signing: FAKE_SIGNING, sealing: FAKE_SEALING });
  },
  "keys:storeMigratedKey": async (c) => () =>
    c.f.t.mutation(internal.keys.storeMigratedKey, {
      orgId: c.f.orgId,
      actor: c.actor,
      signing: { keyId: TEST_KEY.keyId, publicKey: TEST_KEY.publicKeyB64, wrapped: "AAAA", masterKeyId: "0123456789abcdef" },
      sealing: FAKE_SEALING,
    }),
  // A full batch (REWRAP_BATCH) of rows still wrapped by the old master key.
  "keys:rewrapBatch": async (c) => {
    await insertOrgKeyRows(c, 50, "aaaaaaaaaaaaaaaa");
    return () => c.f.t.query(internal.keys.rewrapBatch, { masterKeyId: "aaaaaaaaaaaaaaaa" });
  },
  "keys:storeRewrapped": async (c) => {
    const ids = await insertOrgKeyRows(c, 50, "aaaaaaaaaaaaaaaa");
    return () =>
      c.f.t.mutation(internal.keys.storeRewrapped, { updates: ids.map((id) => ({ id, from: "aaaaaaaaaaaaaaaa", wrapped: "BBBB", masterKeyId: "bbbbbbbbbbbbbbbb" })) });
  },
  // Real rows of five organizations (two keys each) are opened with master key A and wrapped again with master key B.
  "keys:rewrapAll": async (c) => {
    setMaster(MASTER_A);
    for (let i = 0; i < 5; i++) await createKeys(c.f.t, await makeOrg(c.f.t, `Rewrap ${i}`, { noKey: true }));
    setMaster(MASTER_A, MASTER_B);
    return () => c.f.t.action(internal.keys.rewrapAll, {});
  },
  // 25 devices (SEAL_DEVICES_PER_RUN) of one group, each with a sealing key; 2 Wi-Fi profiles with a passphrase are assigned to the group.
  // Phase 5 Step 13. A profile with a full batch of boxes; a secured profile in the fixture's group; the target lookup with a sealing key.
  "networks:purgeSealed": async (c) => {
    const profileId = await c.f.t.run(async (ctx) => {
      const id = await ctx.db.insert("wifiProfiles", { orgId: c.f.orgId, name: "Gone", ssid: "Gone", hidden: false, security: "wpa2Personal", autoConnect: true, groupIds: [], revision: 1, createdAt: Date.now() });
      for (let i = 0; i < 100; i++) {
        await ctx.db.insert("deviceSealedSecrets", { orgId: c.f.orgId, deviceId: c.f.deviceId, purpose: "wifi", targetId: id, targetRevision: 1, sealKeyId: `k${i}`, sealed: "AAAA", createdAt: Date.now() });
      }
      return id;
    });
    return () => c.f.t.mutation(internal.networks.purgeSealed, { profileId });
  },
  // Phase 5 Step 14b. A deleted driver with a full batch of results (one per PC row, so 100 rows of its own).
  "drivers:purgeResults": async (c) => {
    const driverId = await c.f.t.run(async (ctx) => {
      const id = await ctx.db.insert("drivers", DRIVER_ROW(c.f.orgId, "Gone driver", []));
      for (let i = 0; i < 100; i++) {
        await ctx.db.insert("driverResults", { orgId: c.f.orgId, deviceId: c.f.deviceId, driverId: id, state: "installed", driverRevision: 1, attempts: 0, updatedAt: Date.now() + i });
      }
      await ctx.db.delete(id);
      return id;
    });
    return () => c.f.t.mutation(internal.drivers.purgeResults, { driverId });
  },
  "wifi:target": async (c) => {
    setMaster(MASTER_A);
    await createKeys(c.f.t, c.f.orgId);
    return () => c.f.t.query(internal.wifi.target, { orgId: c.f.orgId, id: c.f.wifiId });
  },
  "wifi:storePassphrase": async (c) => () =>
    c.f.t.mutation(internal.wifi.storePassphrase, {
      orgId: c.f.orgId,
      actor: c.actor,
      by: c.f.targetMemberId,
      id: c.f.wifiId,
      expectedRevision: 1,
      atRest: { keyId: "0123456789abcdef", sealed: "AAAA" },
    }),
  // UI pass (enrollment plan 4.3): `wifi:createWithPassphrase`'s four internal functions. The draft is made unprobed by the cases that need one.
  "wifi:prepareCreate": async (c) => {
    setMaster(MASTER_A);
    await createKeys(c.f.t, c.f.orgId);
    return () => c.f.t.query(internal.wifi.prepareCreate, { orgId: c.f.orgId, groupIds: [c.f.groupId] });
  },
  "wifi:insertDraft": async (c) => () => c.f.t.mutation(internal.wifi.insertDraft, WIFI_DRAFT(c)),
  "wifi:finishCreate": async (c) => {
    const id = await c.f.t.mutation(internal.wifi.insertDraft, WIFI_DRAFT(c));
    return () =>
      c.f.t.mutation(internal.wifi.finishCreate, {
        orgId: c.f.orgId,
        actor: c.actor,
        by: c.f.targetMemberId,
        id,
        groupIds: [c.f.groupId],
        atRest: { keyId: "0123456789abcdef", sealed: "AAAA" },
      });
  },
  "wifi:discardDraft": async (c) => {
    const id = await c.f.t.mutation(internal.wifi.insertDraft, WIFI_DRAFT(c));
    return async () => {
      const deleted = await c.f.t.mutation(internal.wifi.discardDraft, { orgId: c.f.orgId, actor: c.actor, id });
      if (!deleted) throw new Error("wifi:discardDraft did not delete the draft"); // a refusal would measure the guard, not the function
      return deleted;
    };
  },
  "seal:jobs": async (c) => {
    const { deviceIds } = await sealingSetup(c, 2);
    return () => c.f.t.query(internal.seal.jobs, { orgId: c.f.orgId, deviceIds });
  },
  "seal:storeSealed": async (c) => {
    const { deviceIds, profiles } = await sealingSetup(c, 2);
    const kp = sealKeyPair();
    const rows = deviceIds.flatMap((deviceId) => profiles.map((p) => ({ deviceId, profileId: p.id, revision: p.revision, sealKeyId: kp.keyId, sealed: "AAAA" })));
    return () => c.f.t.mutation(internal.seal.storeSealed, { orgId: c.f.orgId, rows });
  },
  "seal:forDevices": async (c) => {
    const { deviceIds } = await sealingSetup(c, 2);
    return () => c.f.t.action(internal.seal.forDevices, { orgId: c.f.orgId, deviceIds });
  },
  // Yesterday's rows of 200 devices folded into one organization row, plus a full batch of expired device and organization rows.
  "security:rollup": [
    async (c) => {
      const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      await c.f.t.run(async (ctx) => {
        const devices = await ctx.db.query("devices").withIndex("by_org", (q) => q.eq("orgId", c.f.orgId)).take(200);
        const blocked = { appLocker: 3, appControl: 1, procWatch: 0, elevation: 2 };
        const permissionDenials = [{ appId: c.f.appId as string, kind: "camera", count: 2 }];
        for (const d of devices) {
          await ctx.db.insert("deviceSecurityDaily", { orgId: c.f.orgId, deviceId: d._id, day, blocked, permissionDenials, drift: 0, tamper: 0 });
          await ctx.db.insert("deviceSecurityDaily", { orgId: c.f.orgId, deviceId: d._id, day: "2020-01-01", blocked, permissionDenials, drift: 0, tamper: 0 });
        }
        for (let i = 0; i < 200; i++) {
          await ctx.db.insert("orgSecurityDaily", { orgId: c.f.orgId, day: `2019-01-${String((i % 28) + 1).padStart(2, "0")}`, blocked, permissionDenials: [], devicesReporting: 1 });
        }
      });
      return () => c.f.t.mutation(internal.security.rollup, { orgId: c.f.orgId, orgCreated: Date.now() });
    },
    // The start of the nightly walk: the first organization, nothing to fold.
    async (c) => () => c.f.t.mutation(internal.security.rollup, {}),
  ],

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
      // Phase 5 (Step 10): the PC's finding links (a full batch), 20 sealed Wi-Fi boxes, its apply report and its lock.
      const findingId = await ctx.db.insert("lockdownFindings", {
        orgId: c.f.orgId,
        fingerprint: "f".repeat(64),
        layer: "appLocker",
        fileName: "tool.exe",
        folderClass: "other",
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        deviceCount: 1,
        sampleDeviceId: c.f.deviceId,
        status: "new",
      });
      for (let i = 0; i < 100; i++) await ctx.db.insert("lockdownFindingDevices", { orgId: c.f.orgId, findingId, deviceId: c.f.deviceId, firstSeenAt: Date.now() - i });
      for (let i = 0; i < 20; i++) {
        await ctx.db.insert("deviceSealedSecrets", { orgId: c.f.orgId, deviceId: c.f.deviceId, purpose: "wifi", targetId: `profile-${i}`, targetRevision: 1, sealKeyId: "k", sealed: "A".repeat(600), createdAt: Date.now() });
      }
      const layer = { mode: "off", state: "off" };
      await ctx.db.insert("deviceApplyReports", {
        orgId: c.f.orgId,
        deviceId: c.f.deviceId,
        appliedVersion: 1,
        state: "applied",
        layers: { staff: layer, machine: layer, appLocker: layer, appControl: layer, procWatch: layer, boot: layer, performance: layer },
        wifi: [],
        printers: [],
        capabilities: [],
        contentHash: "a".repeat(64),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("deviceLocks", { orgId: c.f.orgId, deviceId: c.f.deviceId, lockId: "lock-1", message: "Locked", lockedAt: Date.now() });
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
  // A full page of PCs (100, each with an apply report naming the configuration of its group): the backfill makes up to 100 sync rows.
  "maintenance:backfillLockdownSync": async (c) => {
    await c.f.t.run(async (ctx) => {
      const layer = { mode: "audit", state: "ok" };
      const pcs = await ctx.db.query("devices").withIndex("by_org", (q) => q.eq("orgId", c.f.orgId)).take(100);
      for (const [i, d] of pcs.entries()) {
        if (d.groupId === undefined) continue;
        await ctx.db.insert("deviceApplyReports", {
          orgId: c.f.orgId,
          deviceId: d._id,
          appliedVersion: 7,
          config: { groupId: d.groupId, version: 1, ring: "everyone" },
          state: "applied",
          layers: { staff: layer, machine: layer, appLocker: layer, appControl: layer, procWatch: layer, boot: layer, performance: layer },
          wifi: [{ profileId: "k57f1d0c9j3x8m2p4q6r8s0t2v4w6y8z", revision: 3, state: "applied" }],
          printers: [],
          lkgVersion: 6,
          capabilities: ["lockdown/1", "wifi/1"],
          contentHash: i.toString(16).padStart(64, "0"),
          updatedAt: Date.now(),
        });
      }
    });
    return () => c.f.t.mutation(internal.maintenance.backfillLockdownSync, {});
  },
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
  // Phase 5 Step 16. A rolling rollout whose pilot ring is 100 PCs of the fixture's group, each with an `applied` report for the stage's version
  // (the worst the tick's evaluation reads is a full ring and a full report range; automatic promotion is off, so it decides nothing).
  "rollouts:evaluate": async (c) => {
    const rolloutId = await rollingRollout(c, 100);
    return () => c.f.t.mutation(internal.rollouts.evaluate, { rolloutId });
  },
  // One rolling rollout: one page is read and its evaluation scheduled.
  "rollouts:tick": async (c) => {
    await rollingRollout(c, 0);
    return () => c.f.t.mutation(internal.rollouts.tick, {});
  },
  // Every PC of the organization is waiting for a new document: one batch of PUBLISH_BATCH devices is built and signed.
  "publish:run": [
    async (c) => {
      await c.f.t.run((ctx) => requestPublish(ctx, c.f.orgId, { allDevices: true }));
      return () => c.f.t.mutation(internal.publish.run, { orgId: c.f.orgId });
    },
    // Phase 5 data on every PC: each group has a configuration version (with a Wi-Fi profile that has a passphrase), 2 live broadcasts,
    // every PC a sealing key and a current sealed box, every 10th PC a lock.
    async (c) => {
      setMaster(MASTER_A);
      await createKeys(c.f.t, c.f.orgId);
      const groups = await c.f.t.run((ctx) => ctx.db.query("groups").withIndex("by_org_name", (q) => q.eq("orgId", c.f.orgId)).take(50));
      const wifi = await addWifi(c.f.t, c.f.orgId, { groupIds: groups.map((g) => g._id) });
      const kp = sealKeyPair();
      const box = base64Encode(new TextEncoder().encode(JSON.stringify({ v: 1, keyId: kp.keyId, epk: "A".repeat(43) + "=", nonce: "B".repeat(32), ct: "C".repeat(120) })));
      await c.f.t.run(async (ctx) => {
        for (const g of groups) {
          await snapshotGroupConfig(ctx, g._id, "io");
          for (let i = 0; i < 2; i++) {
            await ctx.db.insert("broadcasts", {
              orgId: c.f.orgId,
              target: { kind: "group", id: g._id },
              style: "banner",
              title: `Notice ${i}`,
              body: "Please save your work before 17:00.",
              ackRequired: false,
              createdAt: Date.now() - i * 1000,
            });
          }
        }
        const devices = await ctx.db.query("devices").withIndex("by_org", (q) => q.eq("orgId", c.f.orgId)).take(300);
        let n = 0;
        for (const d of devices) {
          await ctx.db.patch(d._id, { sealPublicKey: kp.publicB64, sealKeyId: kp.keyId });
          await ctx.db.insert("deviceSealedSecrets", { orgId: c.f.orgId, deviceId: d._id, purpose: "wifi", targetId: wifi, targetRevision: 1, sealKeyId: kp.keyId, sealed: box, createdAt: Date.now() });
          if (n++ % 10 === 0) await ctx.db.insert("deviceLocks", { orgId: c.f.orgId, deviceId: d._id, lockId: `lock-${n}`, message: "This PC is locked.", lockedAt: Date.now() });
        }
        await requestPublish(ctx, c.f.orgId, { allDevices: true });
      });
      return () => c.f.t.mutation(internal.publish.run, { orgId: c.f.orgId });
    },
  ],
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
  // Phase 5 Step 20b. A full page (MAX_ORG_DRIVERS = 50) of the PC's driver results, all tagged with a group the PC has left.
  "stats:retagDriverResults": async (c) => {
    await c.f.t.run(async (ctx) => {
      const gone = (await ctx.db.query("groups").withIndex("by_org_name", (q) => q.eq("orgId", c.f.orgId)).first())!._id;
      for (let i = 0; i < 50; i++) {
        const driverId = await ctx.db.insert("drivers", DRIVER_ROW(c.f.orgId, `Retag ${i}`, []));
        await ctx.db.insert("driverResults", { orgId: c.f.orgId, deviceId: c.f.deviceId, driverId, state: "installed", driverRevision: 1, attempts: 0, groupId: gone, updatedAt: 1 });
      }
    });
    return () => c.f.t.mutation(internal.stats.retagDriverResults, { deviceId: c.f.deviceId, cursor: null });
  },
  // Phase 5 Step 20b: the scheduled group batches. `snapshotBatch`: 10 groups of the fixture without a configuration yet (each takes version 1).
  "groupBatches:snapshotBatch": async (c) => {
    const groupIds = await c.f.t.run(async (ctx) => (await ctx.db.query("groups").withIndex("by_org_name", (q) => q.eq("orgId", c.f.orgId)).take(10)).map((g) => g._id));
    return () => c.f.t.mutation(internal.groupBatches.snapshotBatch, { groupIds, reason: "Batch", by: c.f.targetMemberId });
  },
  // `allowBatch`: the same 10 groups get an exception for a finding.
  "groupBatches:allowBatch": async (c) => {
    const { groupIds, findingId } = await c.f.t.run(async (ctx) => {
      const groups = await ctx.db.query("groups").withIndex("by_org_name", (q) => q.eq("orgId", c.f.orgId)).take(10);
      const findingId = await ctx.db.insert("lockdownFindings", { orgId: c.f.orgId, fingerprint: "d".repeat(64), layer: "appLocker", fileName: "tool.exe", folderClass: "other", firstSeenAt: 1, lastSeenAt: 1, deviceCount: 1, sampleDeviceId: c.f.deviceId, status: "new" });
      return { groupIds: groups.map((g) => g._id), findingId };
    });
    return () =>
      c.f.t.mutation(internal.groupBatches.allowBatch, {
        orgId: c.f.orgId,
        groupIds,
        rule: { kind: "hash", sha256: "e".repeat(64), layers: ["appLocker", "procWatch"] },
        reason: "io",
        findingId,
        by: c.f.targetMemberId,
        now: Date.now(),
      });
  },
  // `cleanupDeletedGroup`: the first run of a deleted group that is in 50 Wi-Fi profiles, 100 printers and 50 drivers (the caps), with a rollout row;
  // then the steps with full batches of live broadcasts (50), exceptions (100) and 256-KiB-class configurations (10, small here).
  "groupBatches:cleanupDeletedGroup": [
    async (c) => {
      const gone = await c.f.t.run(async (ctx) => {
        const g = await ctx.db.insert("groups", { orgId: c.f.orgId, name: "Gone", revision: 0, createdAt: 1 });
        for (let i = 0; i < 50; i++) await ctx.db.insert("wifiProfiles", { orgId: c.f.orgId, name: `W${i}`, ssid: `W${i}`, hidden: false, security: "open", autoConnect: true, groupIds: [g], revision: 1, createdAt: 1 });
        for (let i = 0; i < 100; i++) await ctx.db.insert("printers", { orgId: c.f.orgId, name: `P${i}`, kind: "raw", address: "10.0.0.1", driver: "Generic / Text Only", groupIds: [g], defaultForGroupIds: [g], revision: 1, createdAt: 1 });
        for (let i = 0; i < 50; i++) await ctx.db.insert("drivers", DRIVER_ROW(c.f.orgId, `Gone ${i}`, [g]));
        await ctx.db.insert("groupRollouts", { orgId: c.f.orgId, groupId: g, enabled: false, pointers: { pilot: 1, early: 1, everyone: 1 }, autoPromote: { enabled: false, bakeHours: 24, maxFailurePct: 10 }, autoRollback: true, state: "idle", revision: 0 });
        await ctx.db.delete(g);
        return g;
      });
      return () => c.f.t.mutation(internal.groupBatches.cleanupDeletedGroup, { orgId: c.f.orgId, groupId: gone });
    },
    async (c) => {
      const gone = await c.f.t.run(async (ctx) => {
        const g = await ctx.db.insert("groups", { orgId: c.f.orgId, name: "Gone", revision: 0, createdAt: 1 });
        for (let i = 0; i < 50; i++) await ctx.db.insert("broadcasts", { orgId: c.f.orgId, target: { kind: "group", id: g }, style: "banner", title: "T", body: "B", ackRequired: false, createdAt: 10 + i });
        await ctx.db.delete(g);
        return g;
      });
      return () => c.f.t.mutation(internal.groupBatches.cleanupDeletedGroup, { orgId: c.f.orgId, groupId: gone, step: "broadcasts" });
    },
    async (c) => {
      const gone = await c.f.t.run(async (ctx) => {
        const g = await ctx.db.insert("groups", { orgId: c.f.orgId, name: "Gone", revision: 0, createdAt: 1 });
        for (let i = 0; i < 100; i++) await ctx.db.insert("lockdownExceptions", { orgId: c.f.orgId, groupId: g, rule: { kind: "hash", sha256: String(i).padStart(64, "0"), layers: ["appLocker"] }, reason: "", createdAt: 1 });
        await ctx.db.delete(g);
        return g;
      });
      return () => c.f.t.mutation(internal.groupBatches.cleanupDeletedGroup, { orgId: c.f.orgId, groupId: gone, step: "exceptions" });
    },
    async (c) => {
      const gone = await c.f.t.run(async (ctx) => {
        const g = await ctx.db.insert("groups", { orgId: c.f.orgId, name: "Gone", revision: 0, createdAt: 1 });
        for (let v = 1; v <= 10; v++) await ctx.db.insert("groupConfigs", { orgId: c.f.orgId, groupId: g, version: v, config: "x".repeat(20_000), contentHash: `h${v}`, createdAt: 1, reason: "x" });
        await ctx.db.delete(g);
        return g;
      });
      return () => c.f.t.mutation(internal.groupBatches.cleanupDeletedGroup, { orgId: c.f.orgId, groupId: gone, step: "configs" });
    },
  ],

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