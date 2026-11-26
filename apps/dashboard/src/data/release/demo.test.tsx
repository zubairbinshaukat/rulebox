import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { db, resetDemo, setSession } from "../demo/store";
import { demoReleaseApi } from "./demo";

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
