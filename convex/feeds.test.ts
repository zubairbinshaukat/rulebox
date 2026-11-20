import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { probe } from "../tests/convex/devices";
import { asMember, expectCode, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import {
  FEED_URL,
  healthyFeed,
  INSTALLER,
  INSTALLER_URL,
  latestJson,
  LATEST,
  OTHER_PUBKEY,
  SIGNATURE,
  stubFetch,
  TARGET,
  VENDOR_PUBKEY,
  zeroStream,
  type StubbedFetch,
} from "../tests/convex/feeds";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import crons from "./crons";
import { auditPolicy } from "./lib/audit";
import { sha256HexOfBytes } from "./lib/crypto";
import { checkFeed, type FeedCheckInput } from "./lib/feed/resolve";
import { blake2b512, parsePublicKey, parseSignature, verifyPrehashed } from "./lib/feed/minisign";
import { FEED_BACKOFF_MS, FEED_CHECK_INTERVAL_MS, FEED_JITTER_MS, FEED_TICK_BATCH } from "./lib/feed/limits";
import { parseLatestJson, platformKeys } from "./lib/feed/tauri";

// The vendor feed resolver (Phase 6 Step 12, plan 4.5): the minisign check on a vector made with `tauri signer`, the parsing of
// `latest.json`, every refusal of `checkFeed` against a stub `fetch` (nothing touches the network), and the scheduled path through the
// database: the claim, the result, publishing, Approve / Dismiss, Check now and what is written (and what is not).

beforeEach(() => {
  vi.useFakeTimers();
  auditPolicy.strict = true;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  auditPolicy.strict = false;
});

const HOUR = 3_600_000;
const SHA = sha256HexOfBytes(INSTALLER);
const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

// ---------------------------------------------------------------- minisign

describe("minisign (a vector made with `tauri signer sign`)", () => {
  const digest = blake2b512(INSTALLER);

  test("the committed signature verifies with the vendor key, over BLAKE2b-512 of the file", () => {
    expect(INSTALLER.length).toBe(1365);
    expect(verifyPrehashed(VENDOR_PUBKEY, SIGNATURE, digest)).toBe(true);
    expect(LATEST.platforms["windows-x86_64-nsis"]!.signature).toBe(SIGNATURE);
  });

  test("the encoding: base64 of the .pub / .sig file text, algorithm Ed / ED, 8 byte key id", () => {
    const key = parsePublicKey(VENDOR_PUBKEY)!;
    const sig = parseSignature(SIGNATURE)!;
    expect(key.key).toHaveLength(32);
    expect(Array.from(key.keyId)).toEqual(Array.from(sig.keyId));
    expect(sig.signature).toHaveLength(64);
    expect(sig.globalSignature).toHaveLength(64);
    expect(sig.trustedComment).toMatch(/^timestamp:\d+\tfile:installer-2\.1\.0\.bin$/);
  });

  test("a changed file, another key, a changed trusted comment and garbage all fail", () => {
    const changed = INSTALLER.slice();
    changed[100] = changed[100]! ^ 1;
    expect(verifyPrehashed(VENDOR_PUBKEY, SIGNATURE, blake2b512(changed))).toBe(false);
    expect(verifyPrehashed(OTHER_PUBKEY, SIGNATURE, digest)).toBe(false);
    // The trusted comment is covered by the global signature.
    const lines = atob(SIGNATURE).split("\n");
    lines[2] = lines[2]!.replace("timestamp:", "timestamp:9");
    expect(verifyPrehashed(VENDOR_PUBKEY, btoa(lines.join("\n")), digest)).toBe(false);
    for (const bad of ["", "AAAA", btoa("not a signature"), SIGNATURE.slice(0, 100), btoa(atob(SIGNATURE).split("\n").slice(0, 2).join("\n"))]) {
      expect(verifyPrehashed(VENDOR_PUBKEY, bad, digest), bad).toBe(false);
    }
    for (const bad of ["", "AAAA", btoa("untrusted comment: x\nAAAA")]) expect(verifyPrehashed(bad, SIGNATURE, digest), bad).toBe(false);
    expect(verifyPrehashed(VENDOR_PUBKEY, SIGNATURE, digest.slice(0, 32))).toBe(false);
  });

  test("the legacy form (a signature over the whole file, algorithm Ed) is refused", () => {
    const lines = atob(SIGNATURE).split("\n");
    const raw = Uint8Array.from(atob(lines[1]!), (c) => c.charCodeAt(0));
    raw[1] = 0x64; // "ED" -> "Ed"
    lines[1] = btoa(String.fromCharCode(...raw));
    expect(parseSignature(btoa(lines.join("\n")))).toBeNull();
  });
});

// ---------------------------------------------------------------- latest.json

describe("latest.json", () => {
  test("platform lookup: -nsis first, then the plain target; an MSI program asks for -msi first; a target with a type is the only one", () => {
    expect(platformKeys("windows-x86_64", "exe")).toEqual(["windows-x86_64-nsis", "windows-x86_64"]);
    expect(platformKeys("windows-x86_64", "msi")).toEqual(["windows-x86_64-msi", "windows-x86_64"]);
    expect(platformKeys("windows-x86_64-msi", "exe")).toEqual(["windows-x86_64-msi"]);
    const both = JSON.parse(latestJson("2.1.0"));
    both.platforms["windows-x86_64"] = { url: "https://updates.example.com/plain.exe", signature: "x" };
    expect(parseLatestJson(JSON.stringify(both), TARGET, "exe")).toMatchObject({ ok: true, release: { url: INSTALLER_URL } });
    const plainOnly = latestJson("2.1.0", { key: "windows-x86_64", url: "https://updates.example.com/plain.exe" });
    expect(parseLatestJson(plainOnly, TARGET, "exe")).toMatchObject({ ok: true, release: { url: "https://updates.example.com/plain.exe" } });
  });

  test("a leading v is dropped; everything else that is not an ordered version, a platform, an https URL or a signature is refused", () => {
    expect(parseLatestJson(latestJson("v2.1.0"), TARGET, "exe")).toMatchObject({ ok: true, release: { version: "2.1.0" } });
    const refuse = (text: string, reason: string) => expect(parseLatestJson(text, TARGET, "exe"), text.slice(0, 80)).toEqual({ ok: false, reason });
    refuse("not json", "not_json");
    refuse("[]", "shape");
    refuse(JSON.stringify({ version: 2, platforms: {} }), "shape");
    refuse(JSON.stringify({ version: "1.0.0" }), "shape");
    refuse(latestJson("latest"), "version");
    refuse(latestJson("1.0.0+build"), "version");
    refuse(latestJson("2.1.0", { key: "linux-x86_64" }), "platform_missing");
    refuse(latestJson("2.1.0", { url: "http://updates.example.com/a.exe" }), "platform_invalid");
    refuse(latestJson("2.1.0", { url: "not a url" }), "platform_invalid");
    refuse(latestJson("2.1.0", { signature: "" }), "platform_invalid");
    refuse(latestJson("2.1.0", { signature: "A".repeat(3000) }), "platform_invalid");
    refuse(JSON.stringify({ version: "1.0.0", platforms: { "windows-x86_64-nsis": "oops" } }), "platform_invalid");
  });
});

// ---------------------------------------------------------------- checkFeed (no database)

describe("checkFeed: what a check does with the feed", () => {
  const input = (over: Partial<FeedCheckInput> = {}): FeedCheckInput => ({
    feed: { url: FEED_URL, pubkey: VENDOR_PUBKEY, target: TARGET },
    installKind: "exe",
    appVersion: "1.0.0",
    ...over,
  });
  const run = (routes: Record<string, (r: { url: string; headers: Record<string, string> }) => Response | Promise<Response>>, over: Partial<FeedCheckInput> = {}, opts = {}) => {
    const fetch = stubFetch(routes);
    return { fetch, done: checkFeed(input(over), { fetch, ...opts }) };
  };

  test("a new version: the installer is downloaded, hashed and verified; the outcome carries the SHA-256, the size and the etag", async () => {
    const { done, fetch } = run(healthyFeed());
    expect(await done).toEqual({ kind: "new", version: "2.1.0", url: INSTALLER_URL, sha256: SHA, sizeBytes: INSTALLER.length, etag: '"v-2.1.0"' });
    expect(fetch.urls()).toEqual([FEED_URL, INSTALLER_URL]);
  });

  test("304: nothing is read or downloaded after it, and the stored etag was sent", async () => {
    const { done, fetch } = run(healthyFeed(), { etag: '"v-2.1.0"' });
    expect(await done).toEqual({ kind: "not_modified" });
    expect(fetch.urls()).toEqual([FEED_URL]);
    expect(fetch.headersOf(FEED_URL)[0]!["if-none-match"]).toBe('"v-2.1.0"');
  });

  test("the same version, an already seen one and a lower one are never downloaded", async () => {
    for (const [over, kind] of [
      [{ appVersion: "2.1.0" }, "current"],
      [{ appVersion: "2.1" }, "current"], // 2.1 equals 2.1.0
      [{ seenVersion: "2.1.0" }, "current"], // dismissed or rolled back from
      [{ seenVersion: "3.0.0" }, "current"],
      [{ appVersion: "2.2.0" }, "downgrade"],
    ] as const) {
      const { done, fetch } = run(healthyFeed(), over);
      expect(await done, JSON.stringify(over)).toMatchObject({ kind, version: "2.1.0" });
      expect(fetch.urls(), JSON.stringify(over)).toEqual([FEED_URL]);
    }
  });

  test("a bad signature (changed file, another key, a signature of another file) publishes nothing", async () => {
    const changed = INSTALLER.slice();
    changed[5] = changed[5]! ^ 1;
    expect(await run({ ...healthyFeed(), [INSTALLER_URL]: () => new Response(changed) }).done).toMatchObject({ kind: "failed", status: "bad_signature" });
    expect(await run(healthyFeed(), { feed: { url: FEED_URL, pubkey: OTHER_PUBKEY, target: TARGET } }).done).toMatchObject({ kind: "failed", status: "bad_signature" });
    expect(await run(healthyFeed(), { feed: { url: FEED_URL, pubkey: "RWTestKeyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", target: TARGET } }).done).toMatchObject({ kind: "failed", status: "bad_signature" });
    expect(await run({ ...healthyFeed(), [FEED_URL]: () => new Response(latestJson("2.1.0", { signature: btoa("garbage") })) }).done).toMatchObject({ status: "bad_signature" });
  });

  test("a missing platform key, bad JSON, a bad version and an app without an ordered version are a bad feed", async () => {
    const feed = (body: string) => ({ ...healthyFeed(), [FEED_URL]: () => new Response(body, { headers: { etag: '"x"' } }) });
    expect(await run(feed(latestJson("2.1.0", { key: "linux-x86_64" }))).done).toMatchObject({ kind: "failed", status: "bad_feed", etag: '"x"' });
    expect(await run(feed("<html>")).done).toMatchObject({ kind: "failed", status: "bad_feed" });
    expect(await run(feed(latestJson("soon"))).done).toMatchObject({ kind: "failed", status: "bad_feed" });
    // Our own state: no etag is kept, so a fix is seen at the next check.
    expect(await run(feed(latestJson("2.1.0")), { appVersion: "v1" }).done).toEqual({ kind: "failed", status: "bad_feed" });
    expect(await run(feed(latestJson("2.1.0")), { appVersion: undefined }).done).toEqual({ kind: "failed", status: "bad_feed" });
  });

  test("an empty installer file is not a release", async () => {
    expect(await run({ ...healthyFeed(), [INSTALLER_URL]: () => new Response(new Uint8Array(0)) }).done).toMatchObject({ kind: "failed", status: "bad_feed" });
  });

  test("a redirect to http (or to a private address) is refused and never followed; an https redirect is followed", async () => {
    const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });
    const toHttp = run({ [FEED_URL]: redirect("http://updates.example.com/latest.json"), "http://updates.example.com/latest.json": () => new Response(latestJson()) });
    expect(await toHttp.done).toMatchObject({ kind: "failed", status: "bad_feed" });
    expect(toHttp.fetch.urls()).toEqual([FEED_URL]);
    const toPrivate = run({ [FEED_URL]: redirect("https://127.0.0.1/latest.json") });
    expect(await toPrivate.done).toMatchObject({ status: "bad_feed" });
    expect(toPrivate.fetch.urls()).toEqual([FEED_URL]);
    // The installer's own redirect gets the same test.
    const installerToHttp = run({ ...healthyFeed(), [INSTALLER_URL]: redirect("http://cdn.example.com/a.exe") });
    expect(await installerToHttp.done).toMatchObject({ status: "bad_feed" });
    const ok = run({ ...healthyFeed(), [INSTALLER_URL]: redirect("https://cdn.example.com/a.exe"), "https://cdn.example.com/a.exe": () => new Response(INSTALLER) });
    expect(await ok.done).toMatchObject({ kind: "new" });
    // A runtime that followed the redirect itself (we asked for "manual") is not trusted: that body came from an address we never checked.
    const followed = run({
      [FEED_URL]: () => {
        const res = new Response(latestJson());
        Object.defineProperty(res, "redirected", { value: true });
        return res;
      },
    });
    expect(await followed.done).toMatchObject({ status: "bad_feed" });
  });

  test("addresses that are not public https are never fetched", async () => {
    for (const url of ["http://updates.example.com/latest.json", "https://localhost/latest.json", "https://10.0.0.5/latest.json", "https://updates.example.com:8443/latest.json", "https://user:pw@updates.example.com/latest.json", "ftp://x/y"]) {
      const fetch = stubFetch({});
      expect(await checkFeed(input({ feed: { url, pubkey: VENDOR_PUBKEY, target: TARGET } }), { fetch }), url).toMatchObject({ kind: "failed", status: "bad_feed" });
      expect(fetch.urls(), url).toEqual([]);
    }
  });

  test("latest.json over 64 KiB (declared or not) is refused; the installer over the cap is too_large (declared or streamed)", async () => {
    const big = "x".repeat(65 * 1024);
    expect(await run({ [FEED_URL]: () => new Response(big, { headers: { "content-length": String(big.length) } }) }).done).toMatchObject({ status: "bad_feed" });
    expect(await run({ [FEED_URL]: () => new Response(big) }).done).toMatchObject({ status: "bad_feed" });
    const declared = run({ ...healthyFeed(), [INSTALLER_URL]: () => new Response(null, { headers: { "content-length": String(600 * 1024 * 1024) } }) });
    expect(await declared.done).toMatchObject({ kind: "failed", status: "too_large", etag: '"v-2.1.0"' });
    // Streamed: reading stops at the cap, nothing is held.
    const small = run({ ...healthyFeed(), [INSTALLER_URL]: () => zeroStream(10 * 1024 * 1024) }, {}, { maxInstallerBytes: 3 * 1024 * 1024 });
    expect(await small.done).toMatchObject({ kind: "failed", status: "too_large" });
    const exact = run({ ...healthyFeed(), [INSTALLER_URL]: () => new Response(INSTALLER) }, {}, { maxInstallerBytes: INSTALLER.length });
    expect(await exact.done).toMatchObject({ kind: "new" });
    const one = run({ ...healthyFeed(), [INSTALLER_URL]: () => new Response(INSTALLER) }, {}, { maxInstallerBytes: INSTALLER.length - 1 });
    expect(await one.done).toMatchObject({ status: "too_large" });
  });

  test("network errors and HTTP errors are unreachable, and no etag is kept after a failed download", async () => {
    expect(await run({}).done).toEqual({ kind: "failed", status: "unreachable" });
    expect(await run({ [FEED_URL]: () => new Response("no", { status: 503 }) }).done).toEqual({ kind: "failed", status: "unreachable" });
    expect(await run({ [FEED_URL]: () => new Response("no", { status: 404 }) }).done).toEqual({ kind: "failed", status: "unreachable" });
    expect(await run({ ...healthyFeed(), [INSTALLER_URL]: () => new Response("busy", { status: 503 }) }).done).toEqual({ kind: "failed", status: "unreachable" });
    expect(await run({ ...healthyFeed(), [INSTALLER_URL]: () => Promise.reject(new TypeError("reset")) }).done).toEqual({ kind: "failed", status: "unreachable" });
  });

  test("a request that never answers is cut off at its deadline (latest.json and the installer have their own)", async () => {
    // A fetch that stays pending until its signal aborts.
    const pending = (routes: string[]): StubbedFetch => {
      const f = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
        if (!routes.includes(String(url))) return Promise.reject(new TypeError("unexpected"));
        return new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
      }) as unknown as StubbedFetch;
      return f;
    };
    const first = checkFeed(input(), { fetch: pending([FEED_URL]), jsonTimeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    expect(await first).toEqual({ kind: "failed", status: "unreachable" });
    const healthy = stubFetch(healthyFeed());
    const mixed = vi.fn((url: RequestInfo | URL, init?: RequestInit) => (String(url) === FEED_URL ? healthy(url, init) : pending([INSTALLER_URL])(url, init))) as unknown as typeof fetch;
    const second = checkFeed(input(), { fetch: mixed, downloadTimeoutMs: 200 });
    await vi.advanceTimersByTimeAsync(250);
    expect(await second).toEqual({ kind: "failed", status: "unreachable" });
  });
});

// ---------------------------------------------------------------- the database path

async function admin(t: T, orgId: Id<"organizations">) {
  const m = await asMember(t, { role: "admin", orgId });
  await giveStepUp(t, m);
  return m;
}

async function setup() {
  const t = await setupAuth();
  const orgId = await makeOrg(t);
  const a = await admin(t, orgId);
  const b = await admin(t, orgId);
  return { t, orgId, a, b };
}
type Env = Awaited<ReturnType<typeof setup>>;

const V1 = { kind: "exe" as const, url: "https://downloads.example.com/zahras-1.0.0.exe", sha256: "ab".repeat(32), sizeBytes: 1000, silentArgs: ["/S"], successExitCodes: [0], removeWhenUnassigned: false };
const FEED = { kind: "tauri" as const, url: FEED_URL, pubkey: VENDOR_PUBKEY, target: TARGET };
const spec = (update: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  source: "exe" as const,
  exe: "{ProgramFiles}\\Zahras\\zahras.exe",
  args: [],
  fileArgTemplate: [],
  resetFolders: [],
  install: V1,
  version: "1.0.0",
  update: { mode: "managed" as const, feed: FEED, ...update },
  ...over,
});

/** A Managed program "Zahras POS" at 1.0.0 with the vendor feed (its `appFeeds` row is due now). */
async function managedApp(s: Env, update: Record<string, unknown> = {}, name = "Zahras POS"): Promise<Id<"apps">> {
  return await s.a.as.mutation(api.apps.createDesktop, { name, desktop: spec(update) as never });
}
const appRow = (s: Env, id: Id<"apps">) => s.t.run((ctx) => ctx.db.get(id));
const feedRow = (s: Env, id: Id<"apps">) => s.t.run((ctx) => ctx.db.query("appFeeds").withIndex("by_app", (q) => q.eq("appId", id)).unique());
const feedIdOf = async (s: Env, id: Id<"apps">) => (await feedRow(s, id))!._id;
const audits = (s: Env) => s.t.run(async (ctx) => (await ctx.db.query("auditLog").take(200)).map((r) => ({ action: r.action, actorType: r.actorType, summary: r.summary })));
const useFeed = (routes: ReturnType<typeof healthyFeed>) => {
  const f = stubFetch(routes);
  vi.stubGlobal("fetch", f);
  return f;
};
const check = (s: Env, feedId: Id<"appFeeds">) => s.t.action(internal.feeds.check, { feedId });

describe("feeds:check: a new version", () => {
  test("is published like an admin edit: new installer, previous kept, revision up, audited as the system, nothing stored", async () => {
    const s = await setup();
    const id = await managedApp(s);
    const before = (await appRow(s, id))!;
    const fetch = useFeed(healthyFeed());
    expect(await check(s, await feedIdOf(s, id))).toEqual({ result: "published", status: "ok", version: "2.1.0" });
    const app = (await appRow(s, id))!;
    expect(app.revision).toBe(before.revision + 1);
    expect(app.desktop).toMatchObject({
      version: "2.1.0",
      install: { kind: "exe", url: INSTALLER_URL, sha256: SHA, sizeBytes: INSTALLER.length, silentArgs: ["/S"], successExitCodes: [0] },
      previous: { version: "1.0.0", url: V1.url, sha256: V1.sha256, sizeBytes: 1000 },
      update: { mode: "managed", feed: FEED },
    });
    expect(await feedRow(s, id)).toMatchObject({ status: "ok", failures: 0, etag: '"v-2.1.0"', seenVersion: "2.1.0" });
    expect((await feedRow(s, id))!.pending).toBeUndefined();
    expect(await audits(s)).toContainEqual({ action: "app.updated", actorType: "system", summary: "Updated Zahras POS from 1.0.0 to 2.1.0 (vendor feed)" });
    expect(fetch.urls()).toEqual([FEED_URL, INSTALLER_URL]);
    // The installer itself is never stored (only its hash and size).
    expect(await s.t.run((ctx) => ctx.db.system.query("_storage").take(5))).toEqual([]);
  });

  test("an MSI product code is dropped with the old installer (it belongs to one version)", async () => {
    const s = await setup();
    const id = await s.a.as.mutation(api.apps.createDesktop, {
      name: "Msi app",
      desktop: spec({}, { source: "msi", install: { ...V1, kind: "msi", silentArgs: [], productCode: "{12345678-1234-1234-1234-123456789ABC}" } }) as never,
    });
    expect((await appRow(s, id))!.desktop!.install!.productCode).toBeDefined();
    useFeed({ ...healthyFeed(), [FEED_URL]: () => new Response(latestJson("2.1.0", { key: "windows-x86_64-msi" })) });
    // The program's target is the plain "windows-x86_64": an MSI program asks for -msi first.
    expect(await check(s, await feedIdOf(s, id))).toMatchObject({ result: "published" });
    expect((await appRow(s, id))!.desktop!.install!.productCode).toBeUndefined();
  });

  test("with autoPublish off it is only offered (pending); Approve publishes it, a second Approve of the same revision is stale_edit", async () => {
    const s = await setup();
    const id = await managedApp(s, { autoPublish: false });
    useFeed(healthyFeed());
    expect(await check(s, await feedIdOf(s, id))).toEqual({ result: "pending", status: "ok", version: "2.1.0" });
    const app = (await appRow(s, id))!;
    expect(app.desktop!.version).toBe("1.0.0");
    expect(app.revision).toBe(0);
    expect(await feedRow(s, id)).toMatchObject({ seenVersion: "2.1.0", pending: { version: "2.1.0", url: INSTALLER_URL, sha256: SHA, sizeBytes: INSTALLER.length } });
    // The offer shows on the app page without its address or hash.
    const view = await s.a.as.query(api.apps.get, { appId: id });
    expect(view.feedStatus).toMatchObject({ pending: { version: "2.1.0" } });
    expect(Object.keys(view.feedStatus!.pending!).sort()).toEqual(["foundAt", "version"]);

    const { revision } = await s.a.as.mutation(api.feeds.approve, { appId: id, expectedRevision: app.revision });
    expect(revision).toBe(1);
    await expectCode(s.b.as.mutation(api.feeds.approve, { appId: id, expectedRevision: app.revision }), "stale_edit");
    const after = (await appRow(s, id))!;
    expect(after.desktop).toMatchObject({ version: "2.1.0", install: { sha256: SHA }, previous: { version: "1.0.0" } });
    expect((await feedRow(s, id))!.pending).toBeUndefined();
    expect(await audits(s)).toContainEqual({ action: "app.updated", actorType: "member", summary: "Approved the update of Zahras POS from 1.0.0 to 2.1.0" });
    // Nothing pending any more: another Approve is refused.
    await expect(s.a.as.mutation(api.feeds.approve, { appId: id, expectedRevision: revision })).rejects.toMatchObject({ data: { code: "invalid_argument", field: "pending" } });
  });

  test("Dismiss clears the offer and it is not offered again; a newer version is", async () => {
    const s = await setup();
    const id = await managedApp(s, { autoPublish: false });
    const feedId = await feedIdOf(s, id);
    useFeed(healthyFeed());
    await check(s, feedId);
    await s.a.as.mutation(api.feeds.dismiss, { appId: id, expectedRevision: 0 });
    expect((await feedRow(s, id))!.pending).toBeUndefined();
    expect(await audits(s)).toContainEqual({ action: "app.updated", actorType: "member", summary: "Dismissed the update of Zahras POS to 2.1.0" });
    useFeed({ ...healthyFeed(), [FEED_URL]: () => new Response(latestJson("2.1.0"), { headers: { etag: '"other"' } }) });
    expect(await check(s, feedId)).toMatchObject({ result: "unchanged" });
    expect((await feedRow(s, id))!.pending).toBeUndefined();
    // 2.2.0 needs its own signature in real life; here the version in the JSON is what matters for the offer.
    useFeed({ ...healthyFeed(), [FEED_URL]: () => new Response(latestJson("2.2.0")) });
    expect(await check(s, feedId)).toMatchObject({ result: "pending", version: "2.2.0" });
    await expectCode(s.a.as.mutation(api.feeds.dismiss, { appId: id, expectedRevision: 5 }), "stale_edit");
  });

  test("a rollback is not undone by the next check (seenVersion), a newer feed version still is published", async () => {
    const s = await setup();
    const id = await managedApp(s);
    const feedId = await feedIdOf(s, id);
    useFeed(healthyFeed());
    await check(s, feedId);
    const published = (await appRow(s, id))!;
    await s.a.as.mutation(api.apps.rollbackVersion, { appId: id, expectedRevision: published.revision });
    const back = (await appRow(s, id))!;
    expect(back.desktop).toMatchObject({ version: "1.0.0", install: { sha256: V1.sha256 } });
    const fetch = useFeed({ ...healthyFeed(), [FEED_URL]: () => new Response(latestJson("2.1.0")) });
    expect(await check(s, feedId)).toMatchObject({ result: "unchanged", status: "ok" });
    expect(fetch.urls()).toEqual([FEED_URL]); // not even downloaded
    expect((await appRow(s, id))!.revision).toBe(back.revision);
  });
});

describe("feeds:check: what is written (and what is not)", () => {
  test("304 writes nothing; the same version again writes nothing", async () => {
    const s = await setup();
    const id = await managedApp(s);
    const feedId = await feedIdOf(s, id);
    useFeed(healthyFeed());
    await check(s, feedId);
    await drain(s.t);
    // The server answers 304 to the stored etag.
    const first = await probe(() => check(s, feedId));
    expect(first.result).toMatchObject({ result: "unchanged" });
    expect(first.io.writes).toBe(0);
    expect(first.io.reads).toBeLessThanOrEqual(4);
    // A server that ignores If-None-Match and sends the same file and etag again.
    useFeed({ ...healthyFeed(), [FEED_URL]: () => new Response(latestJson("2.1.0"), { headers: { etag: '"v-2.1.0"' } }) });
    const second = await probe(() => check(s, feedId));
    expect(second.result).toMatchObject({ result: "unchanged", status: "ok" });
    expect(second.io.writes).toBe(0);
  });

  test("a lower version is ignored and shown (downgrade); the app does not change", async () => {
    const s = await setup();
    const id = await managedApp(s, {}, "Low");
    // Published 3.0.0 by hand first.
    await s.a.as.mutation(api.apps.update, { appId: id, expectedRevision: 0, desktop: { name: "Low", desktop: spec({}, { version: "3.0.0" }) as never } });
    const before = (await appRow(s, id))!;
    useFeed(healthyFeed());
    expect(await check(s, await feedIdOf(s, id))).toEqual({ result: "unchanged", status: "downgrade" });
    expect(await feedRow(s, id)).toMatchObject({ status: "downgrade", failures: 0 });
    expect(await appRow(s, id)).toEqual(before);
    const view = await s.a.as.query(api.apps.get, { appId: id });
    expect(view.feedStatus!.status).toBe("downgrade");
  });

  test("a bad signature publishes nothing, is audited once and shows as bad_signature", async () => {
    const s = await setup();
    const id = await managedApp(s);
    const before = (await appRow(s, id))!;
    const feedId = await feedIdOf(s, id);
    const changed = INSTALLER.slice();
    changed[9] = changed[9]! ^ 1;
    useFeed({ ...healthyFeed(), [INSTALLER_URL]: () => new Response(changed) });
    expect(await check(s, feedId)).toEqual({ result: "failed", status: "bad_signature" });
    // The etag of that file is kept: the next check gets a 304 and does not download (or audit) it again.
    expect(await check(s, feedId)).toEqual({ result: "unchanged", status: "bad_signature" });
    expect(await appRow(s, id)).toEqual(before);
    expect(await feedRow(s, id)).toMatchObject({ status: "bad_signature", failures: 1 });
    const rejected = (await audits(s)).filter((a) => a.action === "app.feedRejected");
    expect(rejected).toEqual([{ action: "app.feedRejected", actorType: "system", summary: "Refused an update of Zahras POS: its signature did not match the vendor key" }]);
    // Fixing the key (a feed setting) starts clean.
    await s.a.as.mutation(api.apps.update, { appId: id, expectedRevision: 0, desktop: { name: "Zahras POS", desktop: spec({ feed: { ...FEED, pubkey: OTHER_PUBKEY } }) as never } });
    expect(await feedRow(s, id)).toMatchObject({ status: "ok", failures: 0 });
  });

  test("a feed that is too large, bad or unreachable changes nothing in the app; unreachable backs off 1 h, 4 h, then 24 h and recovers", async () => {
    const s = await setup();
    const id = await managedApp(s);
    const before = (await appRow(s, id))!;
    const feedId = await feedIdOf(s, id);
    useFeed({ ...healthyFeed(), [INSTALLER_URL]: () => new Response(null, { headers: { "content-length": String(600 * 1024 * 1024) } }) });
    expect(await check(s, feedId)).toEqual({ result: "failed", status: "too_large" });
    useFeed({ ...healthyFeed(), [FEED_URL]: () => new Response("{}") });
    expect(await check(s, feedId)).toEqual({ result: "failed", status: "bad_feed" });
    expect((await feedRow(s, id))!.failures).toBe(1); // a different failure starts the count again

    useFeed({});
    const expectNext = async (failures: number, gap: number) => {
      expect(await check(s, feedId)).toEqual({ result: "failed", status: "unreachable" });
      const row = (await feedRow(s, id))!;
      expect({ failures: row.failures, next: row.nextCheckAt }).toEqual({ failures, next: Date.now() + gap });
    };
    await expectNext(1, FEED_BACKOFF_MS[0]);
    await expectNext(2, FEED_BACKOFF_MS[1]);
    await expectNext(3, FEED_BACKOFF_MS[2]);
    await expectNext(4, FEED_BACKOFF_MS[2]);
    expect(FEED_BACKOFF_MS).toEqual([HOUR, 4 * HOUR, 24 * HOUR]);
    expect(await appRow(s, id)).toEqual(before);
    // The feed comes back (with a version the app already has): everything is "ok" again.
    useFeed({ ...healthyFeed(), [FEED_URL]: () => new Response(latestJson("1.0.0"), { headers: { etag: '"v1"' } }) });
    expect(await check(s, feedId)).toEqual({ result: "unchanged", status: "ok" });
    expect(await feedRow(s, id)).toMatchObject({ status: "ok", failures: 0, etag: '"v1"', seenVersion: "1.0.0" });
  });

  test("a 304 after a run of unreachable checks brings the feed back to ok; after bad_signature it does not", async () => {
    const s = await setup();
    const id = await managedApp(s);
    const feedId = await feedIdOf(s, id);
    await s.t.run(async (ctx) => ctx.db.patch(feedId, { etag: '"v-2.1.0"', status: "unreachable", failures: 3 }));
    useFeed(healthyFeed());
    expect(await check(s, feedId)).toEqual({ result: "unchanged", status: "ok" });
    expect(await feedRow(s, id)).toMatchObject({ status: "ok", failures: 0 });
    await s.t.run(async (ctx) => ctx.db.patch(feedId, { status: "bad_signature", failures: 1 }));
    expect(await check(s, feedId)).toMatchObject({ result: "unchanged", status: "bad_signature" });
    expect(await feedRow(s, id)).toMatchObject({ status: "bad_signature", failures: 1 });
  });

  test("a result that belongs to older feed settings is dropped (the admin changed the feed during the check)", async () => {
    const s = await setup();
    const id = await managedApp(s);
    const feedId = await feedIdOf(s, id);
    const routes = healthyFeed();
    useFeed({
      ...routes,
      [FEED_URL]: async (req) => {
        // While latest.json is being read, an admin saves a new feed address.
        await s.a.as.mutation(api.apps.update, { appId: id, expectedRevision: 0, desktop: { name: "Zahras POS", desktop: spec({ feed: { ...FEED, url: "https://other.example.com/latest.json" } }) as never } });
        return routes[FEED_URL]!(req);
      },
    });
    expect(await check(s, feedId)).toEqual({ result: "skipped" });
    const app = (await appRow(s, id))!;
    expect(app.desktop!.version).toBe("1.0.0");
    expect(app.revision).toBe(1); // the admin's own save only
    expect(await feedRow(s, id)).toMatchObject({ revision: 1, status: "ok" });
  });

  test("an app that stopped being Managed, or a feed row that is gone, is skipped without any fetch", async () => {
    const s = await setup();
    const id = await managedApp(s);
    const feedId = await feedIdOf(s, id);
    await s.a.as.mutation(api.apps.update, { appId: id, expectedRevision: 0, desktop: { name: "Zahras POS", desktop: spec({}, { update: undefined, version: undefined }) as never } });
    const fetch = useFeed(healthyFeed());
    expect(await check(s, feedId)).toEqual({ result: "skipped" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("feeds:tick: the one cron", () => {
  test("nothing due reads ZERO documents; a feed that is not due yet is not touched", async () => {
    const s = await setup();
    const idle = await probe(() => s.t.mutation(internal.feeds.tick, {}));
    expect(idle.result).toEqual({ claimed: 0 });
    expect(idle.io.reads).toBe(0);
    expect(idle.io.writes).toBe(0);
    const id = await managedApp(s);
    const feedId = await feedIdOf(s, id);
    await s.t.run((ctx) => ctx.db.patch(feedId, { nextCheckAt: Date.now() + HOUR }));
    const early = await probe(() => s.t.mutation(internal.feeds.tick, {}));
    expect(early.result).toEqual({ claimed: 0 });
    expect(early.io.reads).toBe(0);
  });

  test("it claims a due feed BEFORE the check runs, so a second tick cannot check it again", async () => {
    const s = await setup();
    const id = await managedApp(s);
    const fetch = useFeed(healthyFeed());
    const now = Date.now();
    expect(await s.t.mutation(internal.feeds.tick, { now })).toEqual({ claimed: 1 });
    const claimed = (await feedRow(s, id))!;
    expect(claimed.lastCheckedAt).toBe(now);
    expect(claimed.nextCheckAt).toBeGreaterThanOrEqual(now + FEED_CHECK_INTERVAL_MS);
    expect(claimed.nextCheckAt).toBeLessThan(now + FEED_CHECK_INTERVAL_MS + FEED_JITTER_MS);
    // The second tick (before the first one's check has even run) finds nothing due.
    expect(await s.t.mutation(internal.feeds.tick, { now: now + 1 })).toEqual({ claimed: 0 });
    await drain(s.t);
    expect(fetch.urls().filter((u) => u === FEED_URL)).toHaveLength(1);
    expect((await appRow(s, id))!.desktop!.version).toBe("2.1.0");
    // A day later it is due again.
    expect(await s.t.mutation(internal.feeds.tick, { now: now + FEED_CHECK_INTERVAL_MS + FEED_JITTER_MS })).toEqual({ claimed: 1 });
  });

  test("eleven due feeds: ten are checked, the eleventh waits for the next tick", async () => {
    const s = await setup();
    const ids: Id<"apps">[] = [];
    for (let i = 0; i < FEED_TICK_BATCH + 1; i++) {
      // Each app is its own program (distinct names), all with the same vendor feed.
      ids.push(await s.a.as.mutation(api.apps.createDesktop, { name: `App ${i}`, desktop: spec({}, { exe: `{ProgramFiles}\\App${i}\\app.exe` }) as never }));
    }
    // Spread the due times so that "the first ten" is well defined.
    for (const [i, id] of ids.entries()) {
      const feedId = await feedIdOf(s, id);
      await s.t.run((ctx) => ctx.db.patch(feedId, { nextCheckAt: 1000 + i }));
    }
    const fetch = useFeed(healthyFeed());
    expect(await s.t.mutation(internal.feeds.tick, { now: 5000 })).toEqual({ claimed: 10 });
    await drain(s.t);
    expect(fetch.urls().filter((u) => u === FEED_URL)).toHaveLength(10);
    const left = await s.t.run((ctx) => ctx.db.query("appFeeds").withIndex("by_next_check", (q) => q.lte("nextCheckAt", 5000)).take(5));
    expect(left).toHaveLength(1);
    expect(left[0]!.appId).toBe(ids[10]);
    expect(await s.t.mutation(internal.feeds.tick, { now: 5001 })).toEqual({ claimed: 1 });
  });

  test("paused feeds are skipped (Pause pushes the check ten years out; a paused row that is somehow due is pushed out again)", async () => {
    const s = await setup();
    const id = await managedApp(s);
    const fetch = useFeed(healthyFeed());
    const pausedId = await feedIdOf(s, id);
    await s.a.as.mutation(api.feeds.setPaused, { appId: id, paused: true });
    expect(await feedRow(s, id)).toMatchObject({ status: "paused" });
    expect(await s.t.mutation(internal.feeds.tick, { now: Date.now() + 365 * 24 * HOUR })).toEqual({ claimed: 0 });
    await s.t.run((ctx) => ctx.db.patch(pausedId, { nextCheckAt: 1 }));
    expect(await s.t.mutation(internal.feeds.tick, { now: Date.now() })).toEqual({ claimed: 0 });
    expect((await feedRow(s, id))!.nextCheckAt).toBeGreaterThan(Date.now() + 365 * 24 * HOUR);
    await drain(s.t);
    expect(fetch).not.toHaveBeenCalled();
    // A paused feed is never checked, not even by a check that was already scheduled.
    expect(await check(s, await feedIdOf(s, id))).toEqual({ result: "skipped" });
    // Resume: due at once, status ok.
    await s.a.as.mutation(api.feeds.setPaused, { appId: id, paused: false });
    expect(await feedRow(s, id)).toMatchObject({ status: "ok", failures: 0 });
    expect(await s.t.mutation(internal.feeds.tick, { now: Date.now() + 1 })).toEqual({ claimed: 1 });
  });

  test("exactly one feed cron exists, hourly", () => {
    const jobs = (crons as unknown as { crons: Record<string, { schedule: Record<string, unknown> }> }).crons;
    expect(Object.keys(jobs).filter((n) => /feed/i.test(n))).toEqual(["feed tick"]);
    expect(jobs["feed tick"]!.schedule).toMatchObject({ type: "interval", hours: 1 });
  });
});

describe("feeds:checkNow and the admin mutations", () => {
  test("Check now runs the check at once, publishes, stamps lastCheckedAt, and is limited to one per five minutes per app", async () => {
    const s = await setup();
    const id = await managedApp(s);
    useFeed(healthyFeed());
    const at = Date.now();
    expect(await s.a.as.action(api.feeds.checkNow, { appId: id })).toEqual({ result: "published", status: "ok", version: "2.1.0" });
    expect((await feedRow(s, id))!.lastCheckedAt).toBe(at);
    await expectCode(s.a.as.action(api.feeds.checkNow, { appId: id }), "rate_limited");
    // Another app is not affected by this app's limit.
    const other = await managedApp(s, {}, "Other POS");
    expect(await s.b.as.action(api.feeds.checkNow, { appId: other })).toMatchObject({ result: "published" });
  });

  test("Check now and the others refuse an app without a feed; Check now refuses a paused feed", async () => {
    const s = await setup();
    const plain = await s.a.as.mutation(api.apps.createDesktop, { name: "Plain", desktop: { source: "preinstalled", exe: "{ProgramFiles}\\Plain\\plain.exe", args: [], fileArgTemplate: [], resetFolders: [] } as never });
    const noFeed = await s.a.as.mutation(api.apps.createDesktop, { name: "Hand", desktop: spec({ feed: undefined }) as never });
    const ask = (call: () => Promise<unknown>) => call().then(() => null, (e: { data: { code: string; field?: string } }) => e.data);
    for (const appId of [plain, noFeed]) {
      expect(await ask(() => s.a.as.action(api.feeds.checkNow, { appId })), "checkNow").toMatchObject({ code: "invalid_argument", field: "appId" });
      expect(await ask(() => s.a.as.mutation(api.feeds.approve, { appId, expectedRevision: 0 })), "approve").toMatchObject({ code: "invalid_argument", field: "appId" });
      expect(await ask(() => s.a.as.mutation(api.feeds.dismiss, { appId, expectedRevision: 0 })), "dismiss").toMatchObject({ code: "invalid_argument", field: "appId" });
      expect(await ask(() => s.a.as.mutation(api.feeds.setPaused, { appId, paused: true })), "setPaused").toMatchObject({ code: "invalid_argument", field: "appId" });
    }
    const id = await managedApp(s);
    await s.a.as.mutation(api.feeds.setPaused, { appId: id, paused: true });
    expect(await ask(() => s.a.as.action(api.feeds.checkNow, { appId: id }))).toMatchObject({ code: "conflict" });
  });

  test("a viewer and another organization's admin cannot use them; pausing the same state again writes nothing", async () => {
    const s = await setup();
    const id = await managedApp(s);
    const viewer = await asMember(s.t, { role: "viewer", orgId: s.orgId });
    await giveStepUp(s.t, viewer);
    await expectCode(viewer.as.mutation(api.feeds.setPaused, { appId: id, paused: true }), "forbidden");
    await expectCode(viewer.as.action(api.feeds.checkNow, { appId: id }), "forbidden");
    const otherOrg = await makeOrg(s.t, "Other");
    const foreign = await admin(s.t, otherOrg);
    await expectCode(foreign.as.mutation(api.feeds.approve, { appId: id, expectedRevision: 0 }), "not_found");
    await expectCode(foreign.as.action(api.feeds.checkNow, { appId: id }), "not_found");
    const again = await probe(() => s.a.as.mutation(api.feeds.setPaused, { appId: id, paused: false }));
    expect(again.io.writes).toBe(0);
  });

  test("an offer that the app has caught up with (published by hand) cannot be approved", async () => {
    const s = await setup();
    const id = await managedApp(s, { autoPublish: false });
    useFeed(healthyFeed());
    await check(s, await feedIdOf(s, id));
    const cur = (await appRow(s, id))!;
    await s.a.as.mutation(api.apps.update, { appId: id, expectedRevision: cur.revision, desktop: { name: "Zahras POS", desktop: spec({ autoPublish: false }, { version: "2.5.0" }) as never } });
    const next = (await appRow(s, id))!;
    await expect(s.a.as.mutation(api.feeds.approve, { appId: id, expectedRevision: next.revision })).rejects.toMatchObject({ data: { code: "invalid_argument", field: "pending" } });
  });

  test("the feed's address and key never appear in the app page's feed status or in a device document", async () => {
    const s = await setup();
    const id = await managedApp(s);
    useFeed(healthyFeed());
    await check(s, await feedIdOf(s, id));
    const view = await s.a.as.query(api.apps.get, { appId: id });
    const text = JSON.stringify(view.feedStatus);
    for (const secret of [FEED_URL, VENDOR_PUBKEY, "latest.json", '"v-2.1.0"', SHA, INSTALLER_URL]) expect(text, secret).not.toContain(secret);
  });
});
