import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice, probe } from "../tests/convex/devices";
import { asMember, expectCode, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auditPolicy } from "./lib/audit";
import { buildDeviceDoc, contentHashOf, type BuildInput } from "./lib/desired";
import { resetGithubReleasesState } from "./lib/githubReleases";
import { DEFAULT_ORG_SETTINGS } from "./lib/validators";
import { MAX_RELEASE_BYTES, normalizeRelease } from "./ruleboxRelease";

declare const process: { env: Record<string, string | undefined> };

// Phase 6 Step 20 (plan 4.17): the owner names the Rulebox build the PCs update to; it reaches every device as the signed
// agent-only key `ruleboxRelease`. The agent's side is `apps/agent/src/selfupdate.rs`.

beforeEach(() => {
  vi.useFakeTimers();
  auditPolicy.strict = true;
  resetGithubReleasesState();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.RULEBOX_RELEASES_REPO;
  auditPolicy.strict = false;
});

const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

const SHA = "a".repeat(64);
const RELEASE = { version: "0.1.1", url: "https://github.com/rulebox/rulebox/releases/download/v0.1.1/Rulebox-0.1.1-x64.msi", sha256: SHA, sizeBytes: 31_000_000 };

async function setup() {
  const t = await setupAuth();
  const orgId = await makeOrg(t);
  const groupId = await t.run((ctx) => ctx.db.insert("groups", { orgId, name: "Sales", revision: 0, createdAt: Date.now() }));
  const d = await enrollDevice(t, orgId, { groupId });
  const owner = await asMember(t, { role: "owner", orgId });
  await giveStepUp(t, owner);
  await drain(t);
  return { t, orgId, deviceId: d.deviceId, owner };
}

async function docOf(t: T, deviceId: Id<"devices">): Promise<Record<string, unknown>> {
  const head = await t.run((ctx) => ctx.db.query("desiredHeads").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique());
  const body = await t.run((ctx) => ctx.db.get(head!.bodyId));
  return (JSON.parse(body!.payload) as { doc: Record<string, unknown> }).doc;
}

async function audits(t: T, orgId: Id<"organizations">) {
  const rows = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(100));
  return rows.filter((r) => r.action === "org.ruleboxReleaseChanged").map((r) => r.summary);
}

const BASE: BuildInput = {
  org: { _id: "o1", name: "Acme" },
  settings: DEFAULT_ORG_SETTINGS,
  pinHash: null,
  group: null,
  assignments: [],
  apps: [],
  employees: [],
  employeeApps: [],
  fileHandlers: [],
  device: { _id: "d1", kioskEnabled: true },
};

describe("the document key (pure)", () => {
  test("a document without a release is the old document, byte for byte; the key comes last, in the agent's field order", () => {
    const plain = buildDeviceDoc(BASE, 3);
    expect(plain).not.toHaveProperty("ruleboxRelease");
    expect(JSON.stringify(buildDeviceDoc({ ...BASE, ruleboxRelease: undefined }, 3))).toBe(JSON.stringify(plain));
    const withRelease = buildDeviceDoc({ ...BASE, display: { group: "lite" }, ruleboxRelease: { ...RELEASE } }, 3);
    expect(Object.keys(withRelease).at(-1)).toBe("ruleboxRelease");
    expect(JSON.stringify(withRelease.ruleboxRelease)).toBe(
      `{"version":"0.1.1","url":"${RELEASE.url}","sha256":"${SHA}","sizeBytes":31000000}`,
    );
    // The content hash sees it: a changed release is a new version of every document.
    expect(contentHashOf(withRelease)).not.toBe(contentHashOf(buildDeviceDoc({ ...BASE, display: { group: "lite" } }, 3)));
  });

  test("normalizeRelease trims the version, lower-cases the hash and refuses what the agent would", () => {
    expect(normalizeRelease({ ...RELEASE, version: " 0.1.1 ", sha256: SHA.toUpperCase() })).toEqual(RELEASE);
    const bad = (over: Partial<typeof RELEASE>) => () => normalizeRelease({ ...RELEASE, ...over });
    for (const version of ["", "banana", "x".repeat(41), "1..2", "0.1.1 beta"]) expect(bad({ version }), version).toThrow();
    for (const url of ["http://x.test/a.msi", "ftp://x.test/a.msi", "https://user:pw@x.test/a.msi", "", "not a url"]) expect(bad({ url }), url).toThrow();
    for (const sha256 of ["", "abc", "g".repeat(64), "a".repeat(63), "a".repeat(65)]) expect(bad({ sha256 }), sha256).toThrow();
    for (const sizeBytes of [0, -1, 1.5, MAX_RELEASE_BYTES + 1, Number.NaN]) expect(bad({ sizeBytes }), String(sizeBytes)).toThrow();
    expect(normalizeRelease({ ...RELEASE, sizeBytes: MAX_RELEASE_BYTES }).sizeBytes).toBe(MAX_RELEASE_BYTES);
    // A pre-release is a valid, ordered version.
    expect(normalizeRelease({ ...RELEASE, version: "0.2.0-rc.1" }).version).toBe("0.2.0-rc.1");
  });
});

describe("ruleboxRelease:get", () => {
  test("none set: release null and the revision; after a save: the release, lower-cased, and the revision to send back", async () => {
    const { t, orgId, owner } = await setup();
    expect(await owner.as.query(api.ruleboxRelease.get, {})).toEqual({ revision: 0, release: null });
    await owner.as.mutation(api.ruleboxRelease.set, { expectedRevision: 0, release: { ...RELEASE, sha256: SHA.toUpperCase() } });
    expect(await owner.as.query(api.ruleboxRelease.get, {})).toEqual({ revision: 1, release: RELEASE });
    // Every role reads it; the screen decides who may change it.
    for (const role of ["admin", "viewer"] as const) {
      const other = await asMember(t, { role, orgId });
      expect(await other.as.query(api.ruleboxRelease.get, {})).toEqual({ revision: 1, release: RELEASE });
    }
    await owner.as.mutation(api.ruleboxRelease.set, { expectedRevision: 1, release: null });
    expect(await owner.as.query(api.ruleboxRelease.get, {})).toEqual({ revision: 2, release: null });
  });

  test("one small read: the organization row, no write", async () => {
    const { owner } = await setup();
    const { io } = await probe(() => owner.as.query(api.ruleboxRelease.get, {}));
    expect(io.writes).toBe(0);
    expect(io.reads).toBeLessThanOrEqual(4);
  });
});

describe("ruleboxRelease:set", () => {
  test("saves, bumps the organization's revision, audits and republishes every PC with the key", async () => {
    const { t, orgId, deviceId, owner } = await setup();
    expect(await docOf(t, deviceId)).not.toHaveProperty("ruleboxRelease");
    const r = await owner.as.mutation(api.ruleboxRelease.set, { expectedRevision: 0, release: RELEASE });
    expect(r).toEqual({ revision: 1 });
    await drain(t);
    expect(await docOf(t, deviceId)).toMatchObject({ ruleboxRelease: RELEASE });
    expect(await audits(t, orgId)).toEqual(["Set the Rulebox release to version 0.1.1"]);
    const org = await t.run((ctx) => ctx.db.get(orgId));
    expect(org?.phase6Settings?.ruleboxRelease).toEqual(RELEASE);
    expect(org?.revision).toBe(1);
    // The Phase 4 / 5 settings are untouched.
    expect(org?.settings).toEqual(DEFAULT_ORG_SETTINGS);

    // A newer one replaces it and says what it replaced.
    const next = { ...RELEASE, version: "0.1.2", sha256: "b".repeat(64) };
    expect(await owner.as.mutation(api.ruleboxRelease.set, { expectedRevision: 1, release: next })).toEqual({ revision: 2 });
    await drain(t);
    expect(await docOf(t, deviceId)).toMatchObject({ ruleboxRelease: next });
    expect((await audits(t, orgId)).at(-1)).toBe("Set the Rulebox release to version 0.1.2 (was 0.1.1)");
  });

  test("the same release again: no write, no audit, no publish; null clears it and the key goes", async () => {
    const { t, orgId, deviceId, owner } = await setup();
    await owner.as.mutation(api.ruleboxRelease.set, { expectedRevision: 0, release: RELEASE });
    await drain(t);
    const { result, io } = await probe(() => owner.as.mutation(api.ruleboxRelease.set, { expectedRevision: 1, release: { ...RELEASE, sha256: SHA.toUpperCase() } }));
    expect(result).toEqual({ revision: 1 });
    expect(io.writes).toBe(0);
    expect(await audits(t, orgId)).toHaveLength(1);

    expect(await owner.as.mutation(api.ruleboxRelease.set, { expectedRevision: 1, release: null })).toEqual({ revision: 2 });
    await drain(t);
    expect(await docOf(t, deviceId)).not.toHaveProperty("ruleboxRelease");
    const org = await t.run((ctx) => ctx.db.get(orgId));
    expect(org?.phase6Settings).toEqual({});
    expect(await audits(t, orgId)).toHaveLength(2);
    expect((await audits(t, orgId)).at(-1)).toBe("Cleared the Rulebox release: PCs no longer update Rulebox");
    // Clearing what is not set is no change either.
    const again = await probe(() => owner.as.mutation(api.ruleboxRelease.set, { expectedRevision: 2, release: null }));
    expect(again.result).toEqual({ revision: 2 });
    expect(again.io.writes).toBe(0);
  });

  test("values the agent would refuse are refused here, with the field named", async () => {
    const { owner } = await setup();
    const call = (over: Record<string, unknown>) => owner.as.mutation(api.ruleboxRelease.set, { expectedRevision: 0, release: { ...RELEASE, ...over } });
    await expectCode(call({ version: "banana" }), "invalid_argument");
    await expectCode(call({ url: "http://insecure.test/a.msi" }), "invalid_argument");
    await expectCode(call({ sha256: "abc" }), "invalid_argument");
    await expectCode(call({ sizeBytes: 0 }), "invalid_argument");
    await expectCode(call({ sizeBytes: MAX_RELEASE_BYTES + 1 }), "invalid_argument");
  });

  test("a stale edit is refused; only the owner may set it", async () => {
    const { t, orgId, owner } = await setup();
    await owner.as.mutation(api.ruleboxRelease.set, { expectedRevision: 0, release: RELEASE });
    await expectCode(owner.as.mutation(api.ruleboxRelease.set, { expectedRevision: 0, release: null }), "stale_edit");
    for (const role of ["admin", "viewer"] as const) {
      const other = await asMember(t, { role, orgId });
      await giveStepUp(t, other);
      await expectCode(other.as.mutation(api.ruleboxRelease.set, { expectedRevision: 1, release: null }), "forbidden");
    }
  });

  test("a step-up that is not fresh is refused (every PC installs this as SYSTEM)", async () => {
    const { t, orgId } = await setup();
    const stale = await asMember(t, { role: "owner", orgId });
    await giveStepUp(t, stale, { verifiedAgoMs: 6 * 60_000, activeAgoMs: 0 });
    await expectCode(stale.as.mutation(api.ruleboxRelease.set, { expectedRevision: 0, release: RELEASE }), "step_up_required");
  });

  test("the cost is the budget's: at most 4 writes (organization, audit, publish queue and its run)", async () => {
    const { owner } = await setup();
    const { io } = await probe(() => owner.as.mutation(api.ruleboxRelease.set, { expectedRevision: 0, release: RELEASE }));
    expect(io.writes).toBeLessThanOrEqual(4);
    expect(io.reads).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------- ruleboxRelease:githubReleases (UI pass, settings plan 5.2)

const GH_REPO = "zubairbinshaukat/rulebox";
const GH_API = `https://api.github.com/repos/${GH_REPO}/releases?per_page=10`;
const GH_MSI = "Rulebox-0.3.0-x64.msi";
const GH_BASE = `https://github.com/${GH_REPO}/releases/download/v0.3.0`;

/** A GitHub that has one release (v0.3.0) and records every request. No test touches the network. */
function stubGithub(api: string = GH_API, repo: string = GH_REPO) {
  const urls: string[] = [];
  const base = `https://github.com/${repo}/releases/download/v0.3.0`;
  const release = {
    tag_name: "v0.3.0",
    name: "Rulebox 0.3.0",
    body: "Fixes printing.",
    draft: false,
    prerelease: false,
    published_at: "2026-12-01T10:00:00Z",
    html_url: `https://github.com/${repo}/releases/tag/v0.3.0`,
    assets: [
      { id: 1, name: GH_MSI, state: "uploaded", size: 38_000_000, updated_at: "2026-12-01T10:00:00Z", browser_download_url: `${base}/${GH_MSI}` },
      { id: 2, name: "SHA256SUMS", state: "uploaded", size: 100, updated_at: "2026-12-01T10:00:00Z", browser_download_url: `${base}/SHA256SUMS` },
    ],
  };
  const f = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url === api) return new Response(JSON.stringify([release]), { status: 200, headers: { "content-type": "application/json" } });
    if (url === `${base}/SHA256SUMS`) return new Response(`${"c".repeat(64)}  ${GH_MSI}\n`, { status: 200 });
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", f);
  return { urls, f };
}

describe("ruleboxRelease:githubReleases", () => {
  test("the owner gets the releases with the installer address, size and hash; a picked release passes ruleboxRelease:set unchanged", async () => {
    const { owner, t } = await setup();
    const gh = stubGithub();
    const r = await owner.as.action(api.ruleboxRelease.githubReleases, {});
    expect(r).toMatchObject({ status: "ok", repoUrl: `https://github.com/${GH_REPO}`, stale: false });
    if (r.status !== "ok") throw new Error("not ok");
    expect(r.releases).toHaveLength(1);
    const msi = r.releases[0]!.msi!;
    expect(r.releases[0]).toMatchObject({ tag: "v0.3.0", version: "0.3.0", problem: null, signed: true });
    expect(msi).toEqual({ name: GH_MSI, url: `${GH_BASE}/${GH_MSI}`, sizeBytes: 38_000_000, sha256: "c".repeat(64) });
    expect(gh.urls).toEqual([GH_API, `${GH_BASE}/SHA256SUMS`]);

    expect(await owner.as.mutation(api.ruleboxRelease.set, { expectedRevision: 0, release: { version: r.releases[0]!.version, url: msi.url, sha256: msi.sha256, sizeBytes: msi.sizeBytes } })).toEqual({ revision: 1 });
    await drain(t);
    expect(await owner.as.query(api.ruleboxRelease.get, {})).toEqual({ revision: 1, release: { version: "0.3.0", url: msi.url, sha256: msi.sha256, sizeBytes: 38_000_000 } });
  });

  test("the answer is cached in memory: a second call, and a call of another owner, make no request; refresh respects the gap", async () => {
    const { owner } = await setup();
    const gh = stubGithub();
    await owner.as.action(api.ruleboxRelease.githubReleases, {});
    await owner.as.action(api.ruleboxRelease.githubReleases, {});
    await owner.as.action(api.ruleboxRelease.githubReleases, { refresh: true }); // within the 30 s minimum gap
    expect(gh.urls).toHaveLength(2);
  });

  test("it never writes: the database is untouched (no organization change, no audit entry, no publish)", async () => {
    const { t, orgId, owner } = await setup();
    stubGithub();
    const before = await t.run(async (ctx) => ({ org: await ctx.db.get(orgId), audit: (await ctx.db.query("auditLog").collect()).length }));
    const { io } = await probe(() => owner.as.action(api.ruleboxRelease.githubReleases, {}));
    expect(io.writes).toBe(0);
    expect(io.reads).toBeLessThanOrEqual(4 + 20);
    const after = await t.run(async (ctx) => ({ org: await ctx.db.get(orgId), audit: (await ctx.db.query("auditLog").collect()).length }));
    expect(after).toEqual(before);
  });

  test("only an owner may ask, and a locked session is refused: GitHub is not called", async () => {
    const { t, orgId } = await setup();
    const gh = stubGithub();
    for (const role of ["admin", "viewer"] as const) {
      const other = await asMember(t, { role, orgId });
      await giveStepUp(t, other);
      await expectCode(other.as.action(api.ruleboxRelease.githubReleases, {}), "forbidden");
    }
    const locked = await asMember(t, { role: "owner", orgId });
    await giveStepUp(t, locked, { verifiedAgoMs: 20 * 60_000 });
    await expectCode(locked.as.action(api.ruleboxRelease.githubReleases, {}), "step_up_required");
    // An owner whose confirmation is 6 minutes old (not fresh) may still ask: it is not a major action.
    const stale = await asMember(t, { role: "owner", orgId });
    await giveStepUp(t, stale, { verifiedAgoMs: 6 * 60_000, activeAgoMs: 0 });
    expect(await stale.as.action(api.ruleboxRelease.githubReleases, {})).toMatchObject({ status: "ok" });
    expect(gh.urls).toHaveLength(2); // only that one call went out
  });

  test("GitHub failing is an answer, not an error: unavailable, with no code thrown", async () => {
    const { owner } = await setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await owner.as.action(api.ruleboxRelease.githubReleases, {})).toEqual({ status: "unavailable", reason: "unreachable" });
  });

  test("RULEBOX_RELEASES_REPO changes the repository; a bad value falls back to the default", async () => {
    const { owner } = await setup();
    process.env.RULEBOX_RELEASES_REPO = "acme/rulebox-fork";
    const gh = stubGithub(`https://api.github.com/repos/acme/rulebox-fork/releases?per_page=10`, "acme/rulebox-fork");
    expect(await owner.as.action(api.ruleboxRelease.githubReleases, {})).toMatchObject({ status: "ok", repoUrl: "https://github.com/acme/rulebox-fork" });
    expect(gh.urls[0]).toBe("https://api.github.com/repos/acme/rulebox-fork/releases?per_page=10");
    resetGithubReleasesState();
    process.env.RULEBOX_RELEASES_REPO = "../evil";
    const gh2 = stubGithub();
    await owner.as.action(api.ruleboxRelease.githubReleases, {});
    expect(gh2.urls[0]).toBe(GH_API);
  });

  test("GITHUB_TOKEN goes to the API only", async () => {
    const { owner } = await setup();
    const seen: [string, string | undefined][] = [];
    stubGithub();
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push([new URL(String(input)).hostname, (init?.headers as Record<string, string>).authorization]);
      return inner(input, init);
    }) as typeof fetch);
    process.env.GITHUB_TOKEN = "tok-xyz";
    try {
      await owner.as.action(api.ruleboxRelease.githubReleases, {});
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
    expect(seen).toEqual([
      ["api.github.com", "Bearer tok-xyz"],
      ["github.com", undefined],
    ]);
  });
});
