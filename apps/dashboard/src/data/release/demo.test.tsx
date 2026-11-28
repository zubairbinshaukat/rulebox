import { afterEach, describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { db, resetDemo, setSession } from "../demo/store";
import { demoReleaseApi } from "./demo";
import { demoGithubReleaseList } from "./demoReleases";
import { resetGithubReleasesClient } from "./githubRunner";

const RELEASE = { version: "0.1.1", url: "https://dl.example.com/a.msi", sha256: "a".repeat(64), sizeBytes: 31_000_000 };

function signInAs(email: string) {
  const m = db().members.find((x) => x.email === email)!;
  const now = Date.now();
  setSession({ memberId: m._id, createdAt: now, stepUp: { verifiedAt: now, lastActiveAt: now, method: "actionPin" } });
}

describe("demo Rulebox release (twin of convex/ruleboxRelease.ts)", () => {
  it("none set, then a release: revision bump, one audit entry, an unchanged save writes nothing, null clears", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const get = renderHook(() => demoReleaseApi.useRelease());
    await waitFor(() => expect(get.result.current.status).toBe("ready"), { timeout: 4000 });
    const revision = db().org.revision;
    expect(get.result.current).toEqual({ status: "ready", data: { revision, release: null } });

    const set = renderHook(() => demoReleaseApi.useSetRelease()).result.current;
    const audits = () => db().audit.filter((a) => a.action === "org.ruleboxReleaseChanged").length;
    await expect(set({ expectedRevision: revision, release: { ...RELEASE, sha256: "A".repeat(64) } })).resolves.toEqual({ revision: revision + 1 });
    expect(db().org.ruleboxRelease).toEqual(RELEASE);
    expect(audits()).toBe(1);
    await expect(set({ expectedRevision: revision + 1, release: RELEASE })).resolves.toEqual({ revision: revision + 1 });
    expect(audits()).toBe(1);
    await expect(set({ expectedRevision: revision + 1, release: null })).resolves.toEqual({ revision: revision + 2 });
    expect(db().org.ruleboxRelease).toBeUndefined();
    expect(audits()).toBe(2);
  });

  it("refuses what the server refuses: a stale revision, a bad field (named), a role below Owner", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const set = renderHook(() => demoReleaseApi.useSetRelease()).result.current;
    const revision = db().org.revision;
    expect(await set({ expectedRevision: revision + 5, release: RELEASE }).catch((e) => e)).toMatchObject({ code: "stale_edit" });
    for (const [over, field] of [
      [{ version: "banana" }, "release.version"],
      [{ url: "http://dl.example.com/a.msi" }, "release.url"],
      [{ sha256: "abc" }, "release.sha256"],
      [{ sizeBytes: 0 }, "release.sizeBytes"],
    ] as const) {
      expect(await set({ expectedRevision: revision, release: { ...RELEASE, ...over } }).catch((e) => e), field).toMatchObject({ code: "invalid_argument", field });
    }
    expect(db().org.ruleboxRelease).toBeUndefined();

    signInAs("sam.okafor@demo.rulebox.test");
    expect(await set({ expectedRevision: revision, release: RELEASE }).catch((e) => e)).toMatchObject({ code: "forbidden" });
  });
});

describe("demo GitHub releases (twin of ruleboxRelease:githubReleases)", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));
  const open = (enabled = true) => renderHook(() => demoReleaseApi.useGithubReleases(enabled));

  it("an owner gets a fake list after a short wait: newest first, one unsigned, one pre-release, one that cannot be used", async () => {
    resetDemo();
    resetGithubReleasesClient();
    signInAs("owner@demo.rulebox.test");
    const r = open();
    expect(r.result.current.state).toEqual({ status: "loading" });
    await waitFor(() => expect(r.result.current.state.status).toBe("ready"), { timeout: 4000 });
    const state = r.result.current.state;
    if (state.status !== "ready" || state.data.status !== "ok") throw new Error("expected an ok list");
    expect(state.data).toMatchObject({ repoUrl: "https://github.com/zubairbinshaukat/rulebox", stale: false });
    const rows = state.data.releases;
    expect(rows.map((x) => x.tag)).toEqual(["v0.3.0", "v0.3.0-rc1", "v0.2.1", "v0.2.0"]);
    expect(rows.map((x) => x.publishedAt)).toEqual([...rows.map((x) => x.publishedAt)].sort((a, b) => b - a));
    expect(rows[0]).toMatchObject({ version: "0.3.0", signed: false, prerelease: false, problem: null, msi: { sha256: "3".repeat(64), name: "Rulebox-0.3.0-x64-unsigned.msi" } });
    expect(rows[0]!.notes).toMatch(/^## What's new/m);
    expect(rows[1]).toMatchObject({ prerelease: true, version: "0.3.0" });
    expect(rows[3]).toMatchObject({ problem: "no_checksums", msi: null });
    for (const x of rows) expect(x.pageUrl).toMatch(/^https:\/\/github\.com\/zubairbinshaukat\/rulebox\/releases\//);
    for (const x of rows) if (x.msi !== null) expect(x.msi.url).toMatch(/^https:\/\/github\.com\/zubairbinshaukat\/rulebox\/releases\/download\//);
    // The same rules as the server: every usable release is one `set` accepts.
    const set = renderHook(() => demoReleaseApi.useSetRelease()).result.current;
    const pick = rows[0]!.msi!;
    await expect(set({ expectedRevision: db().org.revision, release: { version: rows[0]!.version, url: pick.url, sha256: pick.sha256, sizeBytes: pick.sizeBytes } })).resolves.toMatchObject({ revision: expect.any(Number) });
  });

  it("only an owner: not enabled stays idle, and a call by anyone else is refused like the server does", async () => {
    resetDemo();
    resetGithubReleasesClient();
    signInAs("sam.okafor@demo.rulebox.test");
    expect(open(false).result.current.state).toEqual({ status: "idle" });
    const r = open(true);
    await waitFor(() => expect(r.result.current.state.status).toBe("error"), { timeout: 4000 });
    expect(r.result.current.state).toMatchObject({ status: "error", error: { code: "forbidden" } });
  });

  it("?demoReleases= shows the other states: empty, unavailable, rate limited with a time, stale", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const answer = async (variant: string) => {
      resetGithubReleasesClient();
      window.history.replaceState(null, "", `/?tab=updates&demoReleases=${variant}`);
      const r = open();
      await waitFor(() => expect(r.result.current.state.status).toBe("ready"), { timeout: 4000 });
      const s = r.result.current.state;
      r.unmount();
      return s.status === "ready" ? s.data : null;
    };
    expect(await answer("empty")).toMatchObject({ status: "ok", releases: [], stale: false });
    expect(await answer("unavailable")).toEqual({ status: "unavailable", reason: "unreachable" });
    const rate = await answer("rate");
    expect(rate).toMatchObject({ status: "unavailable", reason: "rate_limited" });
    expect(rate!.status === "unavailable" && rate!.retryAt! > Date.now()).toBe(true);
    expect(await answer("stale")).toMatchObject({ status: "ok", stale: true });
    // An unknown value is the normal list.
    expect(await answer("whatever")).toMatchObject({ status: "ok", stale: false });
  });

  it("the fixtures are what the picker rules expect: every release without a problem has an installer, with a 64-digit hash", () => {
    for (const x of demoGithubReleaseList()) {
      expect(x.msi === null, x.tag).toBe(x.problem !== null);
      if (x.msi !== null) expect(x.msi.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
