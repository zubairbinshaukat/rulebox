import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  cleanNotes,
  createGithubReleasesState,
  DEFAULT_RELEASES_REPO,
  listGithubReleases,
  LIST_TTL_MS,
  MIN_GAP_MS,
  NOTES_MAX_CHARS,
  parseChecksums,
  releasesRepo,
  SHA_CACHE_MAX,
  TRANSIENT_TTL_MS,
  type GithubRelease,
  type GithubReleasesResult,
} from "./lib/githubReleases";
import { fetchPublic } from "./lib/safeFetch";
import { MAX_RELEASE_BYTES, normalizeRelease } from "./lib/releaseRules";

// The GitHub releases picker (UI pass, settings plan section 5): the pure parsing of the releases API, the caches and the
// `fetchPublic` extension it needs (`ifNoneMatch`, `not_modified`, answer headers). No test touches the network: `fetch` is injected.

const REPO = DEFAULT_RELEASES_REPO;
const API = `https://api.github.com/repos/${REPO}/releases?per_page=10`;
const dl = (tag: string, name: string, repo = REPO) => `https://github.com/${repo}/releases/download/${tag}/${name}`;
const hex = (c: string) => c.repeat(64);

type Reply = { status?: number; body?: string | null; headers?: Record<string, string>; throws?: boolean; hang?: boolean };
type Call = { url: string; headers: Record<string, string> };

/** A fetch that answers from `routes` (exact URL; a function answers per call) and records every call. */
function host(routes: Record<string, Reply | ((n: number) => Reply)>) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
    const n = (counts.get(url) ?? 0) + 1;
    counts.set(url, n);
    const route = routes[url];
    const r = typeof route === "function" ? route(n) : route;
    if (r === undefined) return new Response("not found", { status: 404 });
    if (r.throws) throw new TypeError("network down");
    if (r.hang) {
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    const status = r.status ?? 200;
    return new Response(r.body !== undefined ? r.body : status === 304 ? null : "", { status, headers: r.headers });
  }) as typeof fetch;
  return { f, calls, count: (url: string) => counts.get(url) ?? 0 };
}

type AssetOpts = { id?: number; updated?: string; size?: number; state?: string; digest?: string | null; url?: string };
const asset = (name: string, tag: string, o: AssetOpts = {}) => ({
  id: o.id ?? 1,
  name,
  state: o.state ?? "uploaded",
  size: o.size ?? 38_000_000,
  updated_at: o.updated ?? "2026-12-01T10:00:00Z",
  browser_download_url: o.url ?? dl(tag, name),
  ...(o.digest === undefined ? {} : { digest: o.digest }),
});

type ReleaseOpts = {
  tag?: string;
  name?: string | null;
  body?: unknown;
  draft?: boolean;
  prerelease?: boolean;
  published?: string;
  html?: string;
  assets?: unknown[];
  unsigned?: boolean;
  msiVersion?: string;
  idBase?: number;
  digest?: string | null;
};

/** A release with one MSI and a `SHA256SUMS` (the shape `release.yml` publishes). */
function release(version: string, o: ReleaseOpts = {}) {
  const tag = o.tag ?? `v${version}`;
  const msi = `Rulebox-${o.msiVersion ?? version}-x64${o.unsigned === true ? "-unsigned" : ""}.msi`;
  return {
    tag_name: tag,
    name: o.name === undefined ? `Rulebox ${version}` : o.name,
    body: o.body ?? "Fixes things.",
    draft: o.draft ?? false,
    prerelease: o.prerelease ?? false,
    published_at: o.published ?? "2026-12-01T10:00:00Z",
    html_url: o.html ?? `https://github.com/${REPO}/releases/tag/${tag}`,
    assets: o.assets ?? [
      asset(msi, tag, { id: (o.idBase ?? 100) + 1, digest: o.digest }),
      asset("SHA256SUMS", tag, { id: (o.idBase ?? 100) + 2, size: 100 }),
    ],
  };
}

const sums = (tag: string, text: string): Record<string, Reply> => ({ [dl(tag, "SHA256SUMS")]: { body: text } });
const line = (sha: string, name: string) => `${sha}  ${name}\n`;
const json = (x: unknown, headers: Record<string, string> = {}): Reply => ({ body: JSON.stringify(x), headers: { "content-type": "application/json", ...headers } });

let clock = 1_800_000_000_000;
const now = () => clock;
const advance = (ms: number) => {
  clock += ms;
};
let state = createGithubReleasesState();
const list = (f: typeof fetch, o: { refresh?: boolean; token?: string; repo?: string } = {}) => listGithubReleases({ fetch: f, now, state, ...o });
const releasesOf = (r: GithubReleasesResult): GithubRelease[] => {
  if (r.status !== "ok") throw new Error(`not ok: ${JSON.stringify(r)}`);
  return r.releases;
};

beforeEach(() => {
  state = createGithubReleasesState();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("parsing the releases API", () => {
  test("a release with one MSI and a SHA256SUMS: version of the tag, title, signed, size, hash, notes, page; the request is a public GET", async () => {
    const h = host({
      [API]: json([release("0.3.0", { body: "Hello\r\n<!-- hidden -->\r\nWorld" })]),
      ...sums("v0.3.0", line(hex("3"), "Rulebox-0.3.0-x64.msi")),
    });
    const r = await list(h.f);
    expect(r).toMatchObject({ status: "ok", repoUrl: `https://github.com/${REPO}`, checkedAt: clock, stale: false });
    expect(releasesOf(r)).toEqual([
      {
        tag: "v0.3.0",
        title: "Rulebox 0.3.0",
        version: "0.3.0",
        prerelease: false,
        publishedAt: Date.parse("2026-12-01T10:00:00Z"),
        pageUrl: `https://github.com/${REPO}/releases/tag/v0.3.0`,
        notes: "Hello\n\nWorld",
        notesTruncated: false,
        signed: true,
        msi: { name: "Rulebox-0.3.0-x64.msi", url: dl("v0.3.0", "Rulebox-0.3.0-x64.msi"), sizeBytes: 38_000_000, sha256: hex("3") },
        problem: null,
      },
    ]);
    expect(h.calls[0]!.headers).toMatchObject({ accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "rulebox-dashboard" });
    expect(h.calls[0]!.headers.authorization).toBeUndefined();
    expect(h.calls[0]!.headers["if-none-match"]).toBeUndefined();
    // What the picker offers is what `ruleboxRelease:set` accepts.
    const msi = releasesOf(r)[0]!.msi!;
    expect(() => normalizeRelease({ version: "0.3.0", url: msi.url, sha256: msi.sha256, sizeBytes: msi.sizeBytes })).not.toThrow();
  });

  test("an unsigned MSI, a release name that is empty or null, a pre-release", async () => {
    const h = host({
      [API]: json([release("0.4.0", { unsigned: true, name: "   " }), release("0.4.1", { tag: "v0.4.1-rc1", name: null, prerelease: true, idBase: 200 })]),
      ...sums("v0.4.0", line(hex("4"), "Rulebox-0.4.0-x64-unsigned.msi")),
      ...sums("v0.4.1-rc1", line(hex("5"), "Rulebox-0.4.1-x64.msi")),
    });
    const [rc, stable] = [releasesOf(await list(h.f)).find((x) => x.tag === "v0.4.1-rc1")!, releasesOf(await list(h.f)).find((x) => x.tag === "v0.4.0")!];
    expect(stable).toMatchObject({ signed: false, title: "Rulebox 0.4.0", problem: null, msi: { name: "Rulebox-0.4.0-x64-unsigned.msi" } });
    expect(rc).toMatchObject({ prerelease: true, version: "0.4.1", title: "Rulebox 0.4.1-rc1", signed: true, problem: null });
  });

  test("not Rulebox releases are skipped: drafts, tags that are not vX.Y.Z[-suffix], non-objects", async () => {
    const h = host({
      [API]: json([
        release("9.9.9", { draft: true }),
        release("1.2.3", { tag: "nightly" }),
        release("1.2.3", { tag: "v1.2" }),
        release("1.2.3", { tag: "release-1.2.3" }),
        release("1.2.3", { tag: "v1.2.3 " }),
        null,
        "x",
        5,
        release("1.0.0"),
      ]),
      ...sums("v1.0.0", line(hex("a"), "Rulebox-1.0.0-x64.msi")),
    });
    expect(releasesOf(await list(h.f)).map((x) => x.tag)).toEqual(["v1.0.0"]);
  });

  test("at most 10 releases, newest first (by publish date, whatever the order of the answer)", async () => {
    const many = Array.from({ length: 12 }, (_, i) => release(`1.0.${i}`, { published: `2026-11-${String(10 + (i % 6) * 3)}T0${i % 10}:00:00Z`, idBase: 1000 + i * 10 }));
    const h = host({ [API]: json(many) }); // the sums are not found (404): only the order and the count matter here
    const r = releasesOf(await list(h.f));
    expect(r).toHaveLength(10);
    expect(r.map((x) => x.tag).sort()).toEqual(many.slice(0, 10).map((x) => x.tag_name).sort()); // the first 10 of the answer
    expect(r.every((x) => x.problem === "checksums_unreadable")).toBe(true);
    for (let i = 1; i < r.length; i++) expect(r[i - 1]!.publishedAt).toBeGreaterThanOrEqual(r[i]!.publishedAt);
  });

  test("every problem has its own reason and no MSI", async () => {
    const T = (v: string) => `v${v}`;
    const msiOf = (v: string, id: number, o: AssetOpts = {}) => asset(`Rulebox-${v}-x64.msi`, T(v), { id, ...o });
    const sumsOf = (v: string, id: number) => asset("SHA256SUMS", T(v), { id, size: 100 });
    const releases = [
      release("2.0.0", { assets: [sumsOf("2.0.0", 1)] }), // no_msi
      release("2.0.1", { assets: [msiOf("2.0.1", 2), asset("Rulebox-2.0.1-x64-unsigned.msi", T("2.0.1"), { id: 3 }), sumsOf("2.0.1", 4)] }), // two_msis
      release("2.0.2", { msiVersion: "2.0.3" }), // version_mismatch
      release("2.0.3", { assets: [msiOf("2.0.3", 5)] }), // no_checksums
      release("2.0.4", { assets: [msiOf("2.0.4", 6), sumsOf("2.0.4", 7)] }), // checksums_unreadable (the file answers 500)
      release("2.0.5", { assets: [msiOf("2.0.5", 8), sumsOf("2.0.5", 9)] }), // not_in_checksums
      release("2.0.6", { assets: [msiOf("2.0.6", 10, { digest: `sha256:${hex("b")}` }), sumsOf("2.0.6", 11)] }), // hash_mismatch
      release("2.0.7", { assets: [msiOf("2.0.7", 12, { size: MAX_RELEASE_BYTES + 1 }), sumsOf("2.0.7", 13)] }), // too_large
      release("2.0.8", { assets: [msiOf("2.0.8", 14, { url: "https://evil.example.com/Rulebox-2.0.8-x64.msi" }), sumsOf("2.0.8", 15)] }), // invalid: address
      release("2.0.9", { html: "https://evil.example.com/page", assets: [msiOf("2.0.9", 16), sumsOf("2.0.9", 17)] }), // invalid: page
      release("2.1.0", { assets: [msiOf("2.1.0", 18, { size: 0 }), sumsOf("2.1.0", 19)] }), // invalid: size
      release("2.1.1", { assets: [msiOf("2.1.1", 20, { state: "starter" }), sumsOf("2.1.1", 21)] }), // no_msi: not uploaded yet
      release("2.1.2", { assets: [msiOf("2.1.2", 22), sumsOf("2.1.2", 23)] }), // fine
    ];
    // 13 releases: the API answers 10, so ask in two lists
    const first = releases.slice(0, 10);
    const second = releases.slice(10);
    const routes: Record<string, Reply> = {
      ...sums("v2.0.4", ""),
      [dl("v2.0.4", "SHA256SUMS")]: { status: 500 },
      ...sums("v2.0.5", line(hex("1"), "Rulebox-2.0.4-x64.msi")),
      ...sums("v2.0.6", line(hex("a"), "Rulebox-2.0.6-x64.msi")),
      ...sums("v2.0.7", line(hex("1"), "Rulebox-2.0.7-x64.msi")),
      ...sums("v2.0.8", line(hex("1"), "Rulebox-2.0.8-x64.msi")),
      ...sums("v2.0.9", line(hex("1"), "Rulebox-2.0.9-x64.msi")),
      ...sums("v2.1.0", line(hex("1"), "Rulebox-2.1.0-x64.msi")),
      ...sums("v2.1.1", line(hex("1"), "Rulebox-2.1.1-x64.msi")),
      ...sums("v2.1.2", line(hex("1"), "Rulebox-2.1.2-x64.msi")),
    };
    const h1 = host({ [API]: json(first), ...routes });
    const h2 = host({ [API]: json(second), ...routes });
    const got = new Map<string, GithubRelease>();
    for (const x of releasesOf(await list(h1.f))) got.set(x.version, x);
    state = createGithubReleasesState();
    for (const x of releasesOf(await list(h2.f))) got.set(x.version, x);
    const problems = Object.fromEntries([...got].map(([v, x]) => [v, x.problem]));
    expect(problems).toEqual({
      "2.0.0": "no_msi",
      "2.0.1": "two_msis",
      "2.0.2": "version_mismatch",
      "2.0.3": "no_checksums",
      "2.0.4": "checksums_unreadable",
      "2.0.5": "not_in_checksums",
      "2.0.6": "hash_mismatch",
      "2.0.7": "too_large",
      "2.0.8": "invalid",
      "2.0.9": "invalid",
      "2.1.0": "invalid",
      "2.1.1": "no_msi",
      "2.1.2": null,
    });
    for (const x of got.values()) expect(x.msi === null, x.version).toBe(x.problem !== null);
    // A bad page address never reaches the screen: the link is rebuilt from the repository and the tag.
    expect(got.get("2.0.9")!.pageUrl).toBe(`https://github.com/${REPO}/releases/tag/v2.0.9`);
  });
});

describe("SHA256SUMS", () => {
  const one = async (text: string, name = "Rulebox-3.0.0-x64.msi") => {
    const h = host({ [API]: json([release("3.0.0")]), ...sums("v3.0.0", text) });
    state = createGithubReleasesState();
    const [r] = releasesOf(await list(h.f));
    return { problem: r!.problem, sha: r!.msi?.sha256, name };
  };

  test("the text form, the binary form (*name) and CRLF are read; the name must match exactly", async () => {
    expect(await one(line(hex("a"), "Rulebox-3.0.0-x64.msi"))).toMatchObject({ problem: null, sha: hex("a") });
    expect(await one(`${hex("b")} *Rulebox-3.0.0-x64.msi\n`)).toMatchObject({ problem: null, sha: hex("b") });
    expect(await one(`${hex("c")}  Rulebox-3.0.0-x64.msi\r\n`)).toMatchObject({ problem: null, sha: hex("c") });
    expect(await one(line(hex("1"), "Rulebox-3.0.0-x64-unsigned.msi") + line(hex("d"), "Rulebox-3.0.0-x64.msi"))).toMatchObject({ problem: null, sha: hex("d") });
    // The website's `endsWith` would accept these; the picker does not.
    expect(await one(line(hex("e"), "dist/Rulebox-3.0.0-x64.msi"))).toMatchObject({ problem: "not_in_checksums" });
    expect(await one(line(hex("e"), "xRulebox-3.0.0-x64.msi"))).toMatchObject({ problem: "not_in_checksums" });
    expect(await one(line(hex("e"), "Rulebox-3.0.0-x64.msi.sig"))).toMatchObject({ problem: "not_in_checksums" });
    expect(await one("")).toMatchObject({ problem: "not_in_checksums" });
  });

  test("upper-case hex and other shapes are not hashes; a name listed twice: the same hash is fine, two hashes are ambiguous", async () => {
    expect(await one(line("A".repeat(64), "Rulebox-3.0.0-x64.msi"))).toMatchObject({ problem: "not_in_checksums" });
    expect(await one(`${hex("a")} Rulebox-3.0.0-x64.msi\n`)).toMatchObject({ problem: "not_in_checksums" }); // one space only
    expect(await one(`# comment\n\n${hex("a")}\n${line(hex("f"), "Rulebox-3.0.0-x64.msi")}`)).toMatchObject({ problem: null, sha: hex("f") });
    expect(await one(line(hex("a"), "Rulebox-3.0.0-x64.msi") + line(hex("a"), "Rulebox-3.0.0-x64.msi"))).toMatchObject({ problem: null, sha: hex("a") });
    expect(await one(line(hex("a"), "Rulebox-3.0.0-x64.msi") + line(hex("b"), "Rulebox-3.0.0-x64.msi"))).toMatchObject({ problem: "checksums_unreadable" });
  });

  test("parseChecksums (pure)", () => {
    const m = parseChecksums(`${hex("a")}  one.msi\n${hex("b")} *two.msi\r\nnot a line\n${hex("a")}  one.msi\n${hex("c")}  dup\n${hex("d")}  dup\n`);
    expect([...m]).toEqual([
      ["one.msi", hex("a")],
      ["two.msi", hex("b")],
      ["dup", null],
    ]);
  });

  test("GitHub's own digest must agree when it is given; another algorithm or none is ignored", async () => {
    const h = (digest: string | null | undefined) =>
      host({ [API]: json([release("3.0.0", { digest })]), ...sums("v3.0.0", line(hex("a"), "Rulebox-3.0.0-x64.msi")) });
    for (const [digest, problem] of [
      [`sha256:${hex("a")}`, null],
      [`sha256:${"A".repeat(64)}`, null],
      [`sha256:${hex("b")}`, "hash_mismatch"],
      [`sha512:${"b".repeat(128)}`, null],
      [null, null],
      [undefined, null],
    ] as const) {
      state = createGithubReleasesState();
      expect(releasesOf(await list(h(digest).f))[0]!.problem, String(digest)).toBe(problem);
    }
  });

  test("the file is read after redirects to the GitHub asset host only; any other final host, too large or not text is unreadable", async () => {
    const asset302 = (to: string): Reply => ({ status: 302, headers: { location: to } });
    const ok = "https://release-assets.githubusercontent.com/abc";
    const h = host({ [API]: json([release("3.0.0")]), [dl("v3.0.0", "SHA256SUMS")]: asset302(ok), [ok]: { body: line(hex("a"), "Rulebox-3.0.0-x64.msi") } });
    expect(releasesOf(await list(h.f))[0]!.problem).toBeNull();
    for (const target of ["https://evil.example.com/x", "http://release-assets.githubusercontent.com/x", "https://127.0.0.1/x"]) {
      state = createGithubReleasesState();
      const bad = host({ [API]: json([release("3.0.0")]), [dl("v3.0.0", "SHA256SUMS")]: asset302(target), [target]: { body: line(hex("a"), "Rulebox-3.0.0-x64.msi") } });
      expect(releasesOf(await list(bad.f))[0]!.problem, target).toBe("checksums_unreadable");
      expect(bad.count(target) <= 1, target).toBe(true);
    }
    state = createGithubReleasesState();
    const big = host({ [API]: json([release("3.0.0")]), ...sums("v3.0.0", "x".repeat(17 * 1024)) });
    expect(releasesOf(await list(big.f))[0]!.problem).toBe("checksums_unreadable");
    state = createGithubReleasesState();
    const binary = host({ [API]: json([release("3.0.0")]), [dl("v3.0.0", "SHA256SUMS")]: { body: "ÿþ" } });
    // Valid UTF-8 for these code points: still no hash line.
    expect(releasesOf(await list(binary.f))[0]!.problem).toBe("not_in_checksums");
  });
});

describe("notes and titles", () => {
  test("cleanNotes: \\r and HTML comments removed (also an unterminated one), control characters dropped, cut at 4,000 characters", () => {
    expect(cleanNotes("a\r\nb<!-- x\ny -->c<!-- never closed")).toEqual({ notes: "a\nbc", truncated: false });
    expect(cleanNotes("a\u0000b\u0007c\td")).toEqual({ notes: "abc\td", truncated: false });
    expect(cleanNotes(undefined)).toEqual({ notes: "", truncated: false });
    expect(cleanNotes(42)).toEqual({ notes: "", truncated: false });
    const long = cleanNotes("x".repeat(NOTES_MAX_CHARS + 500));
    expect(long.truncated).toBe(true);
    expect(long.notes).toHaveLength(NOTES_MAX_CHARS);
    expect(cleanNotes("x".repeat(NOTES_MAX_CHARS))).toMatchObject({ truncated: false });
    // Never half of a surrogate pair at the cut.
    const emoji = cleanNotes("x".repeat(NOTES_MAX_CHARS - 1) + "\u{1F600}\u{1F600}");
    expect(emoji.truncated).toBe(true);
    expect(emoji.notes).toHaveLength(NOTES_MAX_CHARS - 1);
    // HTML in the notes stays text for the screen to render as text.
    expect(cleanNotes("<script>alert(1)</script>").notes).toBe("<script>alert(1)</script>");
  });

  test("a very long release name is cut at 120 characters", async () => {
    const h = host({ [API]: json([release("3.0.0", { name: "N".repeat(500) })]), ...sums("v3.0.0", line(hex("a"), "Rulebox-3.0.0-x64.msi")) });
    expect(releasesOf(await list(h.f))[0]!.title).toHaveLength(120);
  });
});

describe("caching", () => {
  const route = (extra: Record<string, Reply | ((n: number) => Reply)> = {}) =>
    host({ [API]: (n) => json([release("3.0.0")], { etag: '"v1"', "x-n": String(n) }), ...sums("v3.0.0", line(hex("a"), "Rulebox-3.0.0-x64.msi")), ...extra });

  test("a fresh list answers without a network call; after the TTL it asks again", async () => {
    const h = route();
    const first = await list(h.f);
    expect(h.calls).toHaveLength(2); // the list and its one SHA256SUMS
    advance(LIST_TTL_MS - 1);
    expect(await list(h.f)).toEqual(first);
    expect(h.calls).toHaveLength(2);
    advance(2);
    const again = await list(h.f);
    expect(again).toMatchObject({ status: "ok", stale: false, checkedAt: clock });
    expect(h.count(API)).toBe(2);
    expect(h.calls.at(-1)!.headers["if-none-match"]).toBe('"v1"');
  });

  test("refresh sends the ETag; a 304 keeps the list, only checkedAt moves, and the checksum file is not read again", async () => {
    const h = host({ [API]: (n) => (n === 1 ? json([release("3.0.0")], { etag: 'W/"abc"' }) : { status: 304 }), ...sums("v3.0.0", line(hex("a"), "Rulebox-3.0.0-x64.msi")) });
    const first = await list(h.f);
    const t1 = clock;
    advance(MIN_GAP_MS + 1_000);
    const second = await list(h.f, { refresh: true });
    expect(h.calls.filter((c) => c.url === API).map((c) => c.headers["if-none-match"])).toEqual([undefined, 'W/"abc"']);
    expect(second).toMatchObject({ status: "ok", stale: false, checkedAt: clock });
    expect(clock).toBeGreaterThan(t1);
    expect(releasesOf(second)).toEqual(releasesOf(first));
    expect(h.calls).toHaveLength(3);
  });

  test("at least 30 seconds between two calls to GitHub, even for refresh: the cached list answers", async () => {
    const h = route();
    await list(h.f);
    advance(10_000);
    const r = await list(h.f, { refresh: true });
    expect(r).toMatchObject({ status: "ok", stale: false, checkedAt: clock - 10_000 });
    expect(h.count(API)).toBe(1);
    advance(MIN_GAP_MS);
    await list(h.f, { refresh: true });
    expect(h.count(API)).toBe(2);
  });

  test("an answer that is not an ETag we can send back is not kept", async () => {
    const h = host({ [API]: json([release("3.0.0")], { etag: 'bad etag\\"' }), ...sums("v3.0.0", line(hex("a"), "Rulebox-3.0.0-x64.msi")) });
    await list(h.f);
    advance(MIN_GAP_MS + 1);
    await list(h.f, { refresh: true });
    expect(h.calls.filter((c) => c.url === API).every((c) => c.headers["if-none-match"] === undefined)).toBe(true);
  });

  test("two calls at the same time make one call upstream", async () => {
    const h = route();
    const [a, b] = await Promise.all([list(h.f), list(h.f, { refresh: true })]);
    expect(a).toEqual(b);
    expect(h.count(API)).toBe(1);
  });

  test("the checksum cache key is the asset id and its updated_at: a replaced file is read again, an unchanged one is not", async () => {
    let updated = "2026-12-01T10:00:00Z";
    let body = line(hex("a"), "Rulebox-3.0.0-x64.msi");
    const h = host({
      [API]: () => json([{ ...release("3.0.0"), assets: [asset("Rulebox-3.0.0-x64.msi", "v3.0.0", { id: 1 }), asset("SHA256SUMS", "v3.0.0", { id: 2, updated })] }]),
      [dl("v3.0.0", "SHA256SUMS")]: () => ({ body }),
    });
    expect(releasesOf(await list(h.f))[0]!.msi!.sha256).toBe(hex("a"));
    advance(LIST_TTL_MS + 1);
    await list(h.f);
    expect(h.count(dl("v3.0.0", "SHA256SUMS"))).toBe(1); // same key: from the cache
    // A tag re-run replaces the file: the key changes, so the new hash is read.
    updated = "2026-12-02T10:00:00Z";
    body = line(hex("b"), "Rulebox-3.0.0-x64.msi");
    advance(LIST_TTL_MS + 1);
    expect(releasesOf(await list(h.f))[0]!.msi!.sha256).toBe(hex("b"));
    expect(h.count(dl("v3.0.0", "SHA256SUMS"))).toBe(2);
  });

  test("the checksum cache holds at most 50 entries, the oldest dropped", async () => {
    for (let round = 0; round < 6; round++) {
      const releases = Array.from({ length: 10 }, (_, i) => release(`4.${round}.${i}`, { idBase: 10_000 + round * 1000 + i * 10 }));
      const routes: Record<string, Reply> = {};
      for (let i = 0; i < 10; i++) Object.assign(routes, sums(`v4.${round}.${i}`, line(hex("a"), `Rulebox-4.${round}.${i}-x64.msi`)));
      await list(host({ [API]: json(releases), ...routes }).f);
      advance(LIST_TTL_MS + MIN_GAP_MS);
    }
    expect(state.sums.size).toBe(SHA_CACHE_MAX);
    expect([...state.sums.keys()]).not.toContain("10002:2026-12-01T10:00:00Z"); // round 0 is gone
    expect([...state.sums.keys()]).toContain("15092:2026-12-01T10:00:00Z"); // the newest is kept
  });

  test("a checksum file that could not be fetched is a temporary problem: not remembered, the list is trusted for a minute, no 304 reuse", async () => {
    let sumsStatus = 503;
    const h = host({
      [API]: (n) => json([release("3.0.0")], { etag: `"e${n}"` }),
      [dl("v3.0.0", "SHA256SUMS")]: () => (sumsStatus === 200 ? { body: line(hex("a"), "Rulebox-3.0.0-x64.msi") } : { status: sumsStatus }),
    });
    expect(releasesOf(await list(h.f))[0]!.problem).toBe("checksums_unreadable");
    advance(TRANSIENT_TTL_MS + 1);
    sumsStatus = 200;
    const again = await list(h.f); // older than a minute: asks again, without an ETag, and reads the file again
    expect(releasesOf(again)[0]!.problem).toBeNull();
    expect(h.calls.filter((c) => c.url === API).every((c) => c.headers["if-none-match"] === undefined)).toBe(true);
    // A good list is kept for the full TTL.
    advance(LIST_TTL_MS - 1);
    await list(h.f);
    expect(h.count(API)).toBe(2);
  });
});

describe("GitHub says no", () => {
  const seeded = async () => {
    let mode: "ok" | Reply = "ok";
    const h = host({
      [API]: () => (mode === "ok" ? json([release("3.0.0")]) : mode),
      ...sums("v3.0.0", line(hex("a"), "Rulebox-3.0.0-x64.msi")),
    });
    return { h, set: (m: "ok" | Reply) => (mode = m) };
  };

  test("404 -> not_found; another status, bad JSON, a body that is not a list, a network error -> unreachable", async () => {
    for (const [reply, expected] of [
      [{ status: 404 }, "not_found"],
      [{ status: 500 }, "unreachable"],
      [{ status: 403 }, "unreachable"], // no rate-limit headers: not a limit
      [{ body: "<html>" }, "unreachable"],
      [{ body: "{}" }, "unreachable"],
      [{ throws: true }, "unreachable"],
    ] as [Reply, string][]) {
      state = createGithubReleasesState();
      const h = host({ [API]: reply });
      expect(await list(h.f), JSON.stringify(reply)).toEqual({ status: "unavailable", reason: expected });
    }
  });

  test("a call that never answers is unreachable after the deadline", async () => {
    vi.useFakeTimers();
    const h = host({ [API]: { hang: true } });
    const pending = list(h.f);
    await vi.advanceTimersByTimeAsync(8_001);
    expect(await pending).toEqual({ status: "unavailable", reason: "unreachable" });
  });

  test("a rate limit (x-ratelimit-remaining 0 + reset) answers rate_limited with retryAt and blocks every call until then", async () => {
    const resetAt = Math.floor(clock / 1000) + 900;
    const h = host({ [API]: { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) } } });
    expect(await list(h.f)).toEqual({ status: "unavailable", reason: "rate_limited", retryAt: resetAt * 1000 });
    advance(MIN_GAP_MS + 1);
    expect(await list(h.f, { refresh: true })).toEqual({ status: "unavailable", reason: "rate_limited", retryAt: resetAt * 1000 });
    expect(h.count(API)).toBe(1); // blocked: nothing went upstream
    clock = resetAt * 1000 + 1;
    await list(h.f, { refresh: true });
    expect(h.count(API)).toBe(2);
  });

  test("retry-after (the secondary limit) and a 429 do the same; a reset in the past still waits the minimum gap; a huge value is capped at an hour", async () => {
    const a = host({ [API]: { status: 403, headers: { "retry-after": "120" } } });
    expect(await list(a.f)).toEqual({ status: "unavailable", reason: "rate_limited", retryAt: clock + 120_000 });
    state = createGithubReleasesState();
    const b = host({ [API]: { status: 429 } });
    expect(await list(b.f)).toMatchObject({ status: "unavailable", reason: "rate_limited", retryAt: clock + 60_000 });
    state = createGithubReleasesState();
    const c = host({ [API]: { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" } } });
    expect(await list(c.f)).toEqual({ status: "unavailable", reason: "rate_limited", retryAt: clock + MIN_GAP_MS });
    state = createGithubReleasesState();
    const d = host({ [API]: { status: 429, headers: { "retry-after": "9999999" } } });
    expect(await list(d.f)).toEqual({ status: "unavailable", reason: "rate_limited", retryAt: clock + 3_600_000 });
  });

  test("with a cached list, a failure answers that list as stale instead (also while rate limited)", async () => {
    const { h, set } = await seeded();
    const first = await list(h.f);
    advance(MIN_GAP_MS + 1);
    set({ status: 500 });
    const stale = await list(h.f, { refresh: true });
    expect(stale).toMatchObject({ status: "ok", stale: true, checkedAt: (first as { checkedAt: number }).checkedAt });
    expect(releasesOf(stale)).toEqual(releasesOf(first));
    // Within the gap after a failure the cached list is still stale, with no call.
    const calls = h.count(API);
    expect(await list(h.f, { refresh: true })).toMatchObject({ status: "ok", stale: true });
    expect(h.count(API)).toBe(calls);
    // Rate limited: the same list, stale.
    advance(MIN_GAP_MS + 1);
    set({ status: 429, headers: { "retry-after": "600" } });
    expect(await list(h.f, { refresh: true })).toMatchObject({ status: "ok", stale: true });
    advance(MIN_GAP_MS + 1);
    expect(await list(h.f, { refresh: true })).toMatchObject({ status: "ok", stale: true });
    expect(h.count(API)).toBe(calls + 1);
    // Recovered: fresh again.
    advance(600_000);
    set("ok");
    expect(await list(h.f, { refresh: true })).toMatchObject({ status: "ok", stale: false, checkedAt: clock });
  });

  test("a failed call without a cached list is remembered for the minimum gap (no hammering), then tried again", async () => {
    const h = host({ [API]: { status: 500 } });
    expect(await list(h.f)).toEqual({ status: "unavailable", reason: "unreachable" });
    advance(5_000);
    expect(await list(h.f, { refresh: true })).toEqual({ status: "unavailable", reason: "unreachable" });
    expect(h.count(API)).toBe(1);
    advance(MIN_GAP_MS);
    await list(h.f, { refresh: true });
    expect(h.count(API)).toBe(2);
  });

  test("the failure is logged without headers or the token", async () => {
    const warn = vi.mocked(console.warn);
    await list(host({ [API]: { status: 500, headers: { "set-cookie": "secret=1" } } }).f, { token: "tok-SECRET" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/SECRET|secret|cookie/);
  });
});

describe("the token and the repository", () => {
  test("the token goes to api.github.com only: not to the checksum download, not to a redirect target; no token, no header", async () => {
    const target = "https://release-assets.githubusercontent.com/abc";
    const h = host({
      [API]: json([release("3.0.0")]),
      [dl("v3.0.0", "SHA256SUMS")]: { status: 302, headers: { location: target } },
      [target]: { body: line(hex("a"), "Rulebox-3.0.0-x64.msi") },
    });
    await list(h.f, { token: "tok-123" });
    expect(h.calls.map((c) => [new URL(c.url).hostname, c.headers.authorization])).toEqual([
      ["api.github.com", "Bearer tok-123"],
      ["github.com", undefined],
      ["release-assets.githubusercontent.com", undefined],
    ]);
    state = createGithubReleasesState();
    const none = host({ [API]: json([]) });
    await list(none.f, { token: "" });
    expect(none.calls[0]!.headers.authorization).toBeUndefined();
  });

  test("releasesRepo: the default, a valid owner/name from the environment, anything else falls back", () => {
    expect(releasesRepo(undefined)).toBe(DEFAULT_RELEASES_REPO);
    expect(releasesRepo("")).toBe(DEFAULT_RELEASES_REPO);
    expect(releasesRepo(" acme/rulebox.fork_2 ")).toBe("acme/rulebox.fork_2");
    for (const bad of ["acme", "acme/", "/x", "a/b/c", "a b/c", "acme/..", "acme/.", "-/x/../y", "x".repeat(40) + "/r", "a/" + "r".repeat(101), "https://github.com/a/b"]) {
      expect(releasesRepo(bad), bad).toBe(DEFAULT_RELEASES_REPO);
    }
  });

  test("another repository is read, cached apart, and its address prefix applies", async () => {
    const other = "acme/rulebox";
    const OTHER_API = `https://api.github.com/repos/${other}/releases?per_page=10`;
    const rel = release("3.0.0", { html: `https://github.com/${other}/releases/tag/v3.0.0`, assets: [asset("Rulebox-3.0.0-x64.msi", "v3.0.0", { id: 1, url: dl("v3.0.0", "Rulebox-3.0.0-x64.msi", other) }), asset("SHA256SUMS", "v3.0.0", { id: 2, url: dl("v3.0.0", "SHA256SUMS", other) })] });
    const h = host({ [OTHER_API]: json([rel]), [dl("v3.0.0", "SHA256SUMS", other)]: { body: line(hex("a"), "Rulebox-3.0.0-x64.msi") } });
    const r = await list(h.f, { repo: other });
    expect(r).toMatchObject({ status: "ok", repoUrl: `https://github.com/${other}` });
    expect(releasesOf(r)[0]).toMatchObject({ problem: null, pageUrl: `https://github.com/${other}/releases/tag/v3.0.0` });
    // Another repo's cache is not reused for the default one.
    const d = host({ [API]: json([]) });
    expect(await list(d.f)).toMatchObject({ status: "ok", releases: [] });
    expect(d.count(API)).toBe(1);
    // GitHub spells the repository in its own case: that is the same repository.
    state = createGithubReleasesState();
    const cased = host({ [API]: json([{ ...release("3.0.0"), html_url: `https://github.com/${REPO.toUpperCase()}/releases/tag/v3.0.0` }]), ...sums("v3.0.0", line(hex("a"), "Rulebox-3.0.0-x64.msi")) });
    expect(releasesOf(await list(cased.f))[0]!.problem).toBeNull();
  });
});

describe("fetchPublic: ifNoneMatch, not_modified and the answer headers", () => {
  const URL1 = "https://api.github.com/x";

  test("ifNoneMatch is sent as If-None-Match; a 304 is not_modified with the headers; success and error statuses carry their headers", async () => {
    const seen: Record<string, string>[] = [];
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seen.push(Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)));
      return new Response(null, { status: 304, headers: { etag: '"x"' } });
    }) as typeof fetch;
    const r = await fetchPublic(URL1, { fetch: f, maxBytes: 100, ifNoneMatch: '"x"' });
    expect(r).toMatchObject({ ok: false, reason: "not_modified", status: 304 });
    expect((r as { headers: Headers }).headers.get("etag")).toBe('"x"');
    expect(seen[0]).toMatchObject({ "if-none-match": '"x"', accept: "*/*" });

    // Without the option nothing is sent, and a 304 stays what it was: a redirect-class answer with no Location = a failure.
    const plain = await fetchPublic(URL1, { fetch: f, maxBytes: 100 });
    expect(plain).toEqual({ ok: false, reason: "status" });
    expect(seen[1]!["if-none-match"]).toBeUndefined();

    const ok = (async () => new Response("hi", { status: 200, headers: { etag: '"y"', "content-type": "text/plain" } })) as typeof fetch;
    const good = await fetchPublic(URL1, { fetch: ok, maxBytes: 100, ifNoneMatch: '"x"' });
    expect(good).toMatchObject({ ok: true, contentType: "text/plain" });
    expect((good as { headers: Headers }).headers.get("etag")).toBe('"y"');

    const limited = (async () => new Response("no", { status: 403, headers: { "x-ratelimit-remaining": "0" } })) as typeof fetch;
    const bad = await fetchPublic(URL1, { fetch: limited, maxBytes: 100 });
    expect(bad).toMatchObject({ ok: false, reason: "status", status: 403 });
    expect((bad as { headers: Headers }).headers.get("x-ratelimit-remaining")).toBe("0");

    // A failure that read no answer has no headers.
    expect(await fetchPublic("http://api.github.com/x", { fetch: f, maxBytes: 100 })).toEqual({ ok: false, reason: "blocked" });
  });

  test("the header is sent on every hop of a redirect chain", async () => {
    const seen: string[] = [];
    const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`${String(u)} ${(init?.headers as Record<string, string>)["if-none-match"]}`);
      return String(u) === URL1 ? new Response(null, { status: 301, headers: { location: "https://api.github.com/y" } }) : new Response(null, { status: 304 });
    }) as typeof fetch;
    expect(await fetchPublic(URL1, { fetch: f, maxBytes: 100, ifNoneMatch: '"x"' })).toMatchObject({ ok: false, reason: "not_modified" });
    expect(seen).toEqual([`${URL1} "x"`, 'https://api.github.com/y "x"']);
  });
});
