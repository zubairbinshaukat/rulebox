import { beforeEach, describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { demoApi, demoAppsApi } from "./hooks";
import { db, resetDemo, setSession } from "./store";
import type { DbApp } from "../fixtures/seed";
import { errorCodeOf, toAppError } from "../../lib/errors";

// The demo twin of convex/feeds.ts (Phase 6 Step 12): Approve, Dismiss, Check now, Pause, the feed status of the app page and the
// `updateFlag` of the Apps list. The demo seed has no Managed program, so each test adds one.

function signInAs(email: string) {
  const m = db().members.find((x) => x.email === email)!;
  const now = Date.now();
  setSession({ memberId: m._id, createdAt: now, stepUp: { verifiedAt: now, lastActiveAt: now, method: "actionPin" } });
}

const install = { kind: "exe" as const, url: "https://dl.example.test/pos-1.0.0.exe", sha256: "ab".repeat(32), sizeBytes: 1000, silentArgs: ["/S"], successExitCodes: [0], removeWhenUnassigned: false };
const feed = { kind: "tauri" as const, url: "https://updates.example.test/latest.json", pubkey: "RWTestKey", target: "windows-x86_64-nsis" };

function addManaged(autoPublish: boolean): DbApp {
  const app: DbApp = {
    _id: `app_feed_${autoPublish}`,
    name: "Feed POS",
    kind: "desktop",
    desktop: {
      source: "exe",
      exe: "{ProgramFiles}\\Pos\\pos.exe",
      args: [],
      fileArgTemplate: [],
      resetFolders: [],
      install,
      version: "1.0.0",
      update: { mode: "managed", feed, autoPublish, applyWhen: "boot_or_signed_out", rollbackOnFail: true },
    },
    archived: false,
    revision: 3,
    createdAt: Date.now(),
  };
  db().apps.push(app);
  return app;
}

const rowOf = async (id: string) => {
  const { result } = renderHook(() => demoAppsApi.useAppsScreen({ archived: false, numItems: 50, cursor: null, search: "Feed POS" }));
  await waitFor(() => expect(result.current.status).toBe("ready"), { timeout: 4000 });
  const r = result.current;
  return r.status === "ready" ? r.items.find((x) => x._id === id) : undefined;
};
const statusOf = async (id: string) => {
  const { result } = renderHook(() => demoApi.useAppDetail(id));
  await waitFor(() => expect(result.current.status).toBe("ready"), { timeout: 4000 });
  const r = result.current;
  return r.status === "ready" ? r.data : undefined;
};
const hooks = () => ({
  approve: renderHook(() => demoApi.useApproveFeedUpdate()).result.current,
  dismiss: renderHook(() => demoApi.useDismissFeedUpdate()).result.current,
  check: renderHook(() => demoApi.useCheckFeedNow()).result.current,
  pause: renderHook(() => demoApi.useSetFeedPaused()).result.current,
});

beforeEach(() => {
  resetDemo();
  signInAs("owner@demo.rulebox.test");
});

describe("demo vendor feed", () => {
  it("a Managed program with a feed shows a working status; Check now with auto-publish publishes the next version once, with the old one kept", async () => {
    const app = addManaged(true);
    expect((await statusOf(app._id))?.feedStatus).toMatchObject({ status: "ok", failures: 0, seenVersion: "1.0.0" });
    const { check } = hooks();
    expect(await check({ appId: app._id })).toEqual({ result: "published", status: "ok", version: "1.0.1" });
    expect(app.desktop).toMatchObject({ version: "1.0.1", previous: { version: "1.0.0", url: install.url } });
    expect(app.revision).toBe(4);
    expect(db().audit.some((a) => a.action === "app.updated" && a.summary.includes("(vendor feed)"))).toBe(true);
    // One per five minutes per app.
    await expect(check({ appId: app._id })).rejects.toSatisfy((e) => errorCodeOf(e) === "rate_limited");
    app.feed!.lastCheckNowAt = 0;
    expect(await check({ appId: app._id })).toEqual({ result: "unchanged", status: "ok" });
  });

  it("with auto-publish off a check only offers it: the list says 'available', Approve publishes (stale_edit on an old revision), and the mark goes", async () => {
    const app = addManaged(false);
    const { check, approve } = hooks();
    expect(await check({ appId: app._id })).toEqual({ result: "pending", status: "ok", version: "1.0.1" });
    expect(app.desktop!.version).toBe("1.0.0");
    expect((await statusOf(app._id))?.feedStatus?.pending).toMatchObject({ version: "1.0.1" });
    expect((await rowOf(app._id))?.updateFlag).toBe("available");
    await expect(approve({ appId: app._id, expectedRevision: 2 })).rejects.toSatisfy((e) => errorCodeOf(e) === "stale_edit");
    expect(await approve({ appId: app._id, expectedRevision: 3 })).toEqual({ revision: 4 });
    expect(app.desktop).toMatchObject({ version: "1.0.1", previous: { version: "1.0.0" } });
    expect((await rowOf(app._id))?.updateFlag).toBeUndefined();
    await expect(approve({ appId: app._id, expectedRevision: 4 })).rejects.toSatisfy((e) => toAppError(e)?.field === "pending");
  });

  it("Dismiss clears the offer and it is not offered again", async () => {
    const app = addManaged(false);
    const { check, dismiss } = hooks();
    await check({ appId: app._id });
    expect(await dismiss({ appId: app._id, expectedRevision: 3 })).toEqual({ revision: 3 });
    expect(app.feed!.pending).toBeUndefined();
    app.feed!.lastCheckNowAt = 0;
    expect(await check({ appId: app._id })).toEqual({ result: "unchanged", status: "ok" });
    expect(app.desktop!.version).toBe("1.0.0");
  });

  it("Pause stops Check now (conflict) and Resume brings it back; the same state again changes nothing", async () => {
    const app = addManaged(false);
    const { check, pause } = hooks();
    await pause({ appId: app._id, paused: true });
    expect((await statusOf(app._id))?.feedStatus?.status).toBe("paused");
    await expect(check({ appId: app._id })).rejects.toSatisfy((e) => errorCodeOf(e) === "conflict" && toAppError(e)?.detail === "paused");
    const before = db().audit.length;
    await pause({ appId: app._id, paused: true });
    expect(db().audit.length).toBe(before);
    await pause({ appId: app._id, paused: false });
    expect((await statusOf(app._id))?.feedStatus?.status).toBe("ok");
  });

  it("an app without a feed is refused, and changing the feed settings starts a clean row", async () => {
    const plain = db().apps.find((a) => a.kind === "desktop" && !a.desktop?.update)!;
    const { check } = hooks();
    await expect(check({ appId: plain._id })).rejects.toSatisfy((e) => toAppError(e)?.field === "appId");
    expect((await statusOf(plain._id))?.feedStatus).toBeUndefined();

    const app = addManaged(false);
    await check({ appId: app._id });
    const update = renderHook(() => demoApi.useUpdateApp()).result.current;
    await update({
      appId: app._id,
      expectedRevision: 3,
      desktop: { name: app.name, desktop: { ...app.desktop!, update: { ...app.desktop!.update!, feed: { ...feed, pubkey: "RWOther" } } } },
    });
    expect(app.feed).toBeUndefined();
    expect((await rowOf(app._id))?.updateFlag).toBeUndefined();
  });
});
