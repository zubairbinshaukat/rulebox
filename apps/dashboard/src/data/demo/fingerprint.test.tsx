import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { demoApi } from "./hooks";
import { DEMO_WINGET_IDS, demoFingerprint, demoResolveWinget } from "./wingetFixtures";
import { db, resetDemo, setSession } from "./store";
import { AppError } from "../../lib/errors";
import * as validate from "../../lib/validate";
import { GALLERY } from "../../screens/apps/gallery/catalog";

// The demo twins of the Add app flow's server calls (UI pass add-app.md section 8): `apps:fingerprintInstaller`, `apps:byWinget` and
// `apps:resolveWinget` for every package of the popular-apps gallery. No network.

function signInAs(email: string) {
  const m = db().members.find((x) => x.email === email)!;
  const now = Date.now();
  setSession({ memberId: m._id, createdAt: now, stepUp: { verifiedAt: now, lastActiveAt: now, method: "actionPin" } });
}

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e instanceof AppError ? { code: e.code, field: e.field, detail: e.detail } : e;
  }
  return null;
}

describe("demo useFingerprintInstaller", () => {
  it("answers through the seam (a hash, a size and the technology the address names)", async () => {
    resetDemo();
    const a = await renderHook(() => demoApi.useFingerprintInstaller()).result.current({ url: "https://dl.example.com/tool-inno-setup.exe" });
    expect(a).toMatchObject({ sizeBytes: 48_234_496, inspection: { tech: "inno", kind: "exe", silentArgs: ["/SP-", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], successExitCodes: [0] } });
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.inspection).not.toHaveProperty("sizeBytes"); // like the server: the size is on the result
    expect(a).toEqual(demoFingerprint("https://dl.example.com/tool-inno-setup.exe"));
  });

  it("the same address gives the same hash, another address another one; the technology follows the address", () => {
    const a = demoFingerprint("https://dl.example.com/tool-inno-setup.exe");
    expect(demoFingerprint("https://dl.example.com/tool-inno-setup.exe").sha256).toBe(a.sha256);
    expect(demoFingerprint("https://dl.example.com/other-inno-setup.exe").sha256).not.toBe(a.sha256);
    expect(demoFingerprint("https://dl.example.com/tool.msi")).toMatchObject({ inspection: { tech: "msi", kind: "msi" } });
    expect(demoFingerprint("https://dl.example.com/tool.exe")).toMatchObject({ inspection: { tech: "exe", confidence: "low", silentArgs: [] } });
  });

  it("refuses like the server: a bad address, too large, blocked, failed, not an installer (also through the seam)", async () => {
    resetDemo();
    const refusalOf = (url: string) => {
      try {
        demoFingerprint(url);
      } catch (e) {
        return e instanceof AppError ? { code: e.code, field: e.field, detail: e.detail } : e;
      }
      return null;
    };
    expect(refusalOf("http://dl.example.com/a.exe")).toMatchObject({ code: "invalid_argument", field: "url" });
    expect(refusalOf("https://dl.example.com/big-setup.exe")).toEqual({ code: "invalid_argument", field: "url", detail: "fingerprint_too_large" });
    expect(refusalOf("https://192.168.1.4/a.exe")).toEqual({ code: "invalid_argument", field: "url", detail: "fingerprint_blocked" });
    expect(refusalOf("https://fail.example.com/a.exe")).toEqual({ code: "invalid_argument", field: "url", detail: "fingerprint_failed" });
    expect(refusalOf("https://dl.example.com/files.zip")).toEqual({ code: "invalid_argument", field: "url", detail: "fingerprint_not_installer" });
    expect(await refusal(renderHook(() => demoApi.useFingerprintInstaller()).result.current({ url: "https://dl.example.com/big.exe" }))).toEqual({ code: "invalid_argument", field: "url", detail: "fingerprint_too_large" });
  });
});
describe("demo useAppByWinget", () => {
  it("answers the demo app that has the package id, else null; archived apps are answered too", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const vlc = db().apps.find((a) => a.desktop?.wingetId === "VideoLAN.VLC")!;
    const found = renderHook(() => demoApi.useAppByWinget("VideoLAN.VLC"));
    await waitFor(() => expect(found.result.current.status).toBe("ready"), { timeout: 4000 });
    expect(found.result.current).toEqual({ status: "ready", data: { _id: vlc._id, name: vlc.name, archived: false } });
    const none = renderHook(() => demoApi.useAppByWinget("Notepad++.Notepad++"));
    await waitFor(() => expect(none.result.current.status).toBe("ready"), { timeout: 4000 });
    expect(none.result.current).toEqual({ status: "ready", data: null });
    vlc.archived = true;
    const archived = renderHook(() => demoApi.useAppByWinget(" VideoLAN.VLC "));
    await waitFor(() => expect(archived.result.current.status).toBe("ready"), { timeout: 4000 });
    expect(archived.result.current).toMatchObject({ data: { _id: vlc._id, archived: true } });
  });

  it("an id that is not a winget id answers null; `skip` stays loading", async () => {
    resetDemo();
    signInAs("owner@demo.rulebox.test");
    const bad = renderHook(() => demoApi.useAppByWinget("no dot"));
    await waitFor(() => expect(bad.result.current.status).toBe("ready"), { timeout: 4000 });
    expect(bad.result.current).toEqual({ status: "ready", data: null });
    const skipped = renderHook(() => demoApi.useAppByWinget("skip"));
    await new Promise((r) => setTimeout(r, 600));
    expect(skipped.result.current).toEqual({ status: "loading" });
  });
});

describe("demo apps:resolveWinget knows every gallery package", () => {
  const galleryIds = GALLERY.flatMap((a) => (a.source === "winget" && a.wingetId !== undefined ? [a.wingetId] : []));

  it("every desktop entry of the gallery that comes from winget resolves, with a valid install spec", () => {
    expect(galleryIds.length).toBeGreaterThanOrEqual(15);
    for (const id of galleryIds) {
      const r = demoResolveWinget(id);
      expect(r.packageId, id).toBe(id);
      expect(r.version, id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/);
      expect(r.install.sha256, id).toMatch(/^[0-9a-f]{64}$/);
      expect(r.install.url.startsWith("https://"), id).toBe(true);
      expect(validate.installerUrl(r.install.url), id).toBeNull();
      expect(r.install.successExitCodes, id).toEqual([0]);
      // msi needs no switches; an exe needs some (the server refuses an exe without a silent switch)
      if (r.install.kind === "msi") expect(r.install.silentArgs, id).toEqual([]);
      else expect(r.install.silentArgs.length, id).toBeGreaterThan(0);
      if (r.defaultInstallLocation !== undefined) expect(r.defaultInstallLocation.startsWith("{ProgramFiles"), id).toBe(true);
    }
    // nothing of the gallery is missing from the table
    expect(galleryIds.map((g) => g.toLowerCase()).filter((id) => !DEMO_WINGET_IDS.includes(id))).toEqual([]);
  });

  it("is case-insensitive, honours a named version and keeps the plus of Notepad++", () => {
    expect(demoResolveWinget("videolan.vlc")).toMatchObject({ packageId: "videolan.vlc", name: "VLC media player" });
    expect(demoResolveWinget("Notepad++.Notepad++", "8.7.1")).toMatchObject({ packageId: "Notepad++.Notepad++", version: "8.7.1", install: { kind: "exe", silentArgs: ["/S"] } });
  });

  it("Teams, Slack and Spotify are refused like the live server (winget_unsupported); an unknown package too", () => {
    for (const id of ["Microsoft.Teams", "SlackTechnologies.Slack", "Spotify.Spotify", "Unknown.Package"]) {
      let thrown: unknown;
      try {
        demoResolveWinget(id);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, id).toBeInstanceOf(AppError);
      expect((thrown as AppError).code, id).toBe("winget_unsupported");
      expect((thrown as AppError).detail, id).toBeTruthy();
    }
    expect(() => demoResolveWinget("offline.app")).toThrow();
    expect(() => demoResolveWinget("../etc.passwd")).toThrow();
  });

  it("the hook answers the same through the seam", async () => {
    resetDemo();
    const r = await renderHook(() => demoApi.useResolveWinget()).result.current({ packageId: "Google.Chrome" });
    expect(r).toMatchObject({ packageId: "Google.Chrome", name: "Google Chrome", install: { kind: "msi" } });
  });
});

describe("demoFingerprint is pure", () => {
  it("does not need the store", () => {
    expect(demoFingerprint("https://dl.example.com/x-nsis.exe").inspection).toMatchObject({ tech: "nsis", perUserLikely: true });
  });
});
