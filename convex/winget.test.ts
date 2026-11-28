import { describe, expect, test } from "vitest";
import { codeOf } from "../tests/convex/identity";
import { wingetIdProblem } from "./lib/appRules";
import {
  compareVersions,
  installerManifestUrl,
  localeManifestUrl,
  locationHint,
  parseLocale,
  parseManifest,
  pickInstaller,
  resolveWinget,
  splitSwitches,
  versionListUrl,
  versionsFromListing,
} from "./lib/winget";
import git from "./testdata/winget/Git.Git.installer.yaml?raw";
import sevenZip from "./testdata/winget/7zip.7zip.installer.yaml?raw";
import sevenZipLocale from "./testdata/winget/7zip.7zip.locale.en-US.yaml?raw";
import spotify from "./testdata/winget/Spotify.Spotify.installer.yaml?raw";

// Winget manifest handling (plan 4.8, Step 10 item 4) on the three committed
// fixtures in convex/testdata/winget/ (shape of winget-pkgs; made-up hashes).
// No test touches the network: `resolveWinget` gets a stub `fetch`.

const pick = (yaml: string) => pickInstaller(parseManifest(yaml));

describe("pickInstaller on the fixtures", () => {
  test("7zip.7zip: the machine-wide x64 MSI wins, with its product code", () => {
    const r = pick(sevenZip);
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.install).toEqual({
      kind: "msi",
      url: "https://www.7-zip.org/a/7z2408-x64.msi",
      sha256: "b".repeat(63) + "4",
      sizeBytes: 0,
      silentArgs: [],
      productCode: "{23170F69-40C1-2702-2408-000001000000}",
      successExitCodes: [0],
      removeWhenUnassigned: true,
    });
  });

  test("Git.Git: an Inno exe with no Silent switch gets the default one; success codes and install location come along", () => {
    const r = pick(git);
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.install).toMatchObject({
      kind: "exe",
      url: "https://github.com/git-for-windows/git/releases/download/v2.47.0.windows.1/Git-2.47.0-64-bit.exe",
      silentArgs: ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"],
      successExitCodes: [0, 1641, 3010],
      removeWhenUnassigned: false,
    });
    expect(r.install.sha256).toBe("c".repeat(63) + "2");
    expect(r.defaultInstallLocation).toBe("{ProgramFiles}\\Git"); // `%ProgramFiles%` as a path template
  });

  test("Spotify.Spotify: only per-user entries -> refused with a reason", () => {
    const r = pick(spotify);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/per-user/);
  });
});

describe("pickInstaller rules", () => {
  const base = (installers: string, header = "") => `PackageIdentifier: A.B\nPackageVersion: 1.0\n${header}Installers:\n${installers}`;
  const entry = (lines: Record<string, string>) =>
    "  - " +
    Object.entries({
      InstallerUrl: "https://example.com/a.exe",
      InstallerSha256: "ab".repeat(32),
      ...lines,
    })
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n    ") +
    "\n";

  test("preference: machine scope, then x64, then msi, in that order", () => {
    // machine-scope exe beats a scope-less msi
    const a = pick(base(entry({ Architecture: "x64", InstallerType: "msi", InstallerUrl: "https://example.com/none.msi" }) + entry({ Architecture: "x64", InstallerType: "nullsoft", Scope: "machine", InstallerUrl: "https://example.com/machine.exe" })));
    expect(a.ok && a.install.url).toBe("https://example.com/machine.exe");
    // x64 beats x86 and neutral at equal scope
    const b = pick(base(entry({ Architecture: "x86", InstallerType: "msi", InstallerUrl: "https://example.com/x86.msi" }) + entry({ Architecture: "neutral", InstallerType: "msi", InstallerUrl: "https://example.com/neutral.msi" }) + entry({ Architecture: "x64", InstallerType: "nullsoft", InstallerUrl: "https://example.com/x64.exe" })));
    expect(b.ok && b.install.url).toBe("https://example.com/x64.exe");
    // msi/wix beat other types at equal scope and architecture
    const c = pick(base(entry({ Architecture: "x64", InstallerType: "nullsoft", InstallerUrl: "https://example.com/n.exe" }) + entry({ Architecture: "x64", InstallerType: "wix", InstallerUrl: "https://example.com/w.msi" })));
    expect(c.ok && c.install.url).toBe("https://example.com/w.msi");
    // otherwise manifest order
    const d = pick(base(entry({ Architecture: "x64", InstallerType: "nullsoft", InstallerUrl: "https://example.com/first.exe" }) + entry({ Architecture: "x64", InstallerType: "nullsoft", InstallerUrl: "https://example.com/second.exe" })));
    expect(d.ok && d.install.url).toBe("https://example.com/first.exe");
  });

  test("dropped: user scope (entry or manifest level), ARM, unsupported types", () => {
    expect(pick(base(entry({ InstallerType: "nullsoft", Scope: "user" }))).ok).toBe(false);
    expect(pick(base(entry({ InstallerType: "nullsoft" }), "Scope: user\n")).ok).toBe(false);
    expect(pick(base(entry({ InstallerType: "nullsoft", Architecture: "arm64" }))).ok).toBe(false);
    expect(pick(base(entry({ InstallerType: "nullsoft", Architecture: "arm" }))).ok).toBe(false);
    for (const type of ["msix", "appx", "zip", "portable", "pwa"]) expect(pick(base(entry({ InstallerType: type })) ).ok, type).toBe(false);
    // entry-level scope machine overrides manifest-level user
    expect(pick(base(entry({ InstallerType: "nullsoft", Scope: "machine" }), "Scope: user\n")).ok).toBe(true);
    // manifest-level InstallerType is inherited
    expect(pick(base(entry({}), "InstallerType: nullsoft\n")).ok).toBe(true);
  });

  test("silent switches: manifest value, then the type default, plain exe refused", () => {
    const custom = pick(base(entry({ InstallerType: "inno", InstallerSwitches: "\n      Silent: /VERYSILENT /DIR=\"C:\\Program Files\\X Y\"" })));
    expect(custom.ok && custom.install.silentArgs).toEqual(["/VERYSILENT", "/DIR=C:\\Program Files\\X Y"]);
    const nsis = pick(base(entry({ InstallerType: "nullsoft" })));
    expect(nsis.ok && nsis.install.silentArgs).toEqual(["/S"]);
    const burn = pick(base(entry({ InstallerType: "burn" })));
    expect(burn.ok && burn.install.silentArgs).toEqual(["/quiet", "/norestart"]);
    const plain = pick(base(entry({ InstallerType: "exe" })));
    expect(plain).toEqual({ ok: false, reason: "this package has no silent install" });
    const plainOk = pick(base(entry({ InstallerType: "exe", InstallerSwitches: "\n      Silent: /quiet" })));
    expect(plainOk.ok && plainOk.install.silentArgs).toEqual(["/quiet"]);
    // a manifest-level switch is inherited
    const inherited = pick(base(entry({ InstallerType: "exe" }), "InstallerSwitches:\n  Silent: -s\n"));
    expect(inherited.ok && inherited.install.silentArgs).toEqual(["-s"]);
  });

  test("silent switches that apps:createDesktop would refuse (more than 16, over 200 characters) are not offered at Resolve time", () => {
    const many = Array.from({ length: 17 }, (_, i) => `/a${i}`).join(" ");
    const tooMany = pick(base(entry({ InstallerType: "inno", InstallerSwitches: `\n      Silent: ${many}` })));
    expect(tooMany).toEqual({ ok: false, reason: expect.stringMatching(/silent install switches are not usable/) });
    const tooLong = pick(base(entry({ InstallerType: "inno", InstallerSwitches: `\n      Silent: /D=${"x".repeat(201)}` })));
    expect(tooLong.ok).toBe(false);
    const sixteen = pick(base(entry({ InstallerType: "inno", InstallerSwitches: `\n      Silent: ${many.replace(" /a16", "")}` })));
    expect(sixteen.ok && sixteen.install.silentArgs).toHaveLength(16);
    // another entry with usable switches still wins
    const other = pick(base(entry({ InstallerType: "inno", InstallerSwitches: `\n      Silent: ${many}` }) + entry({ InstallerType: "nullsoft", InstallerUrl: "https://example.com/nsis.exe", Architecture: "x86" })));
    expect(other.ok && other.install.url).toBe("https://example.com/nsis.exe");
  });

  test("a plain exe without a silent switch is skipped when another entry works", () => {
    const r = pick(base(entry({ InstallerType: "exe", InstallerUrl: "https://example.com/plain.exe" }) + entry({ InstallerType: "nullsoft", InstallerUrl: "https://example.com/nsis.exe", Architecture: "x86" })));
    expect(r.ok && r.install.url).toBe("https://example.com/nsis.exe");
  });

  test("product code: entry, then manifest, then AppsAndFeaturesEntries; bad ones dropped", () => {
    const g = (n: number) => `{23170F69-40C1-2702-2408-00000100000${n}}`;
    const e = pick(base(entry({ InstallerType: "msi", ProductCode: `'${g(1)}'` }), `ProductCode: '${g(2)}'\n`));
    expect(e.ok && e.install.productCode).toBe(g(1));
    const m = pick(base(entry({ InstallerType: "msi" }), `ProductCode: '${g(2)}'\n`));
    expect(m.ok && m.install.productCode).toBe(g(2));
    const a = pick(base(entry({ InstallerType: "wix", AppsAndFeaturesEntries: `\n      - ProductCode: '${g(3).toLowerCase()}'` })));
    expect(a.ok && a.install.productCode).toBe(g(3));
    const bad = pick(base(entry({ InstallerType: "msi", ProductCode: "not-a-guid" })));
    expect(bad.ok && bad.install.productCode).toBeUndefined();
  });

  test("success exit codes: 0 plus the manifest's, de-duplicated and sorted; junk ignored", () => {
    const r = pick(base(entry({ InstallerType: "msi", InstallerSuccessCodes: "\n      - 3010\n      - 0\n      - 1641\n      - abc\n      - 2.5\n      - 3010" })));
    expect(r.ok && r.install.successExitCodes).toEqual([0, 1641, 3010]);
  });

  test("the installer must be https with a 64-hex SHA-256", () => {
    const http = pick(base(entry({ InstallerType: "nullsoft", InstallerUrl: "http://example.com/a.exe" })));
    expect(http).toEqual({ ok: false, reason: "its installer is not downloaded over https" });
    const noSha = pick(base(entry({ InstallerType: "nullsoft", InstallerSha256: "abc" })));
    expect(noSha).toEqual({ ok: false, reason: "its installer has no SHA-256" });
    // an http entry does not block a good one
    const mixed = pick(base(entry({ InstallerType: "msi", InstallerUrl: "http://example.com/a.msi" }) + entry({ InstallerType: "nullsoft", InstallerUrl: "https://example.com/ok.exe" })));
    expect(mixed.ok && mixed.install.url).toBe("https://example.com/ok.exe");
  });

  test("nothing usable: no installers, not an object, garbage", () => {
    expect(pickInstaller(null).ok).toBe(false);
    expect(pickInstaller("text").ok).toBe(false);
    expect(pickInstaller({ Installers: [] }).ok).toBe(false);
    expect(pickInstaller({ Installers: ["x", 3] }).ok).toBe(false);
    expect(pickInstaller(parseManifest("::: not yaml :::\n\t- [")).ok).toBe(false);
  });
});

describe("parsing and ordering", () => {
  test("YAML alias bombs and invalid documents do not throw", () => {
    const bomb = "a: &a [x,x,x,x,x,x,x,x,x,x]\n" + "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\n".repeat(1) + "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\n" + "d: [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c,*c,*c,*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]\n";
    expect(() => parseManifest(bomb)).not.toThrow();
    expect(parseManifest("{ unterminated")).toBeNull();
  });

  test("locale manifest: name and publisher, control characters refused", () => {
    expect(parseLocale(sevenZipLocale)).toEqual({ name: "7-Zip", publisher: "Igor Pavlov" });
    expect(parseLocale("PackageName: \"a\\x07b\"\nPublisher: P")).toEqual({ name: undefined, publisher: "P" });
    expect(parseLocale("::: nope")).toEqual({});
  });

  test("install location hints become path-template starts", () => {
    expect(locationHint("%ProgramFiles%\\Git")).toBe("{ProgramFiles}\\Git");
    expect(locationHint("%ProgramFiles(x86)%\\Notepad++")).toBe("{ProgramFilesX86}\\Notepad++");
    expect(locationHint("%SystemRoot%\\System32")).toBe("{SystemRoot}\\System32");
    expect(locationHint("D:\\Tools\\X")).toBe("D:\\Tools\\X");
    expect(locationHint(undefined)).toBeUndefined();
  });

  test("splitSwitches keeps quoted parts together", () => {
    expect(splitSwitches('/S /D="C:\\Program Files\\X"')).toEqual(["/S", "/D=C:\\Program Files\\X"]);    expect(splitSwitches("/S  /NORESTART")).toEqual(["/S", "/NORESTART"]);
    expect(splitSwitches('"a b" c')).toEqual(["a b", "c"]);
  });

  test("versions sort numerically, newest first", () => {
    const listing = ["1.9", "1.10", "1.2.3", "2.0-beta", "2.0", "10.0", "9.9", "latest", "Insiders"].map((name) => ({ name, type: "dir" }));
    listing.push({ name: "3.0", type: "file" });
    expect(versionsFromListing(listing)).toEqual(["10.0", "9.9", "2.0", "2.0-beta", "1.10", "1.9", "1.2.3"]);
    expect(compareVersions("1.0", "1.0.1")).toBeLessThan(0);
    expect(compareVersions("1.10", "1.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0", "2.0")).toBe(0);
    expect(versionsFromListing({ message: "Not Found" })).toEqual([]);
  });

  test("addresses: first letter lower-case, dots become folders", () => {
    expect(installerManifestUrl("7zip.7zip", "24.08")).toBe("https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests/7/7zip/7zip/24.08/7zip.7zip.installer.yaml");
    expect(installerManifestUrl("VideoLAN.VLC", "3.0.21")).toBe("https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests/v/VideoLAN/VLC/3.0.21/VideoLAN.VLC.installer.yaml");
    expect(localeManifestUrl("VideoLAN.VLC", "3.0.21")).toContain("VideoLAN.VLC.locale.en-US.yaml");
    expect(versionListUrl("Microsoft.VisualStudioCode")).toBe("https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/m/Microsoft/VisualStudioCode");
  });

  test("a plus in the id is a plain path character: the addresses keep it and still stay inside the repository", () => {
    expect(wingetIdProblem("Notepad++.Notepad++")).toBe(false);
    expect(installerManifestUrl("Notepad++.Notepad++", "8.8.9")).toBe("https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests/n/Notepad++/Notepad++/8.8.9/Notepad++.Notepad++.installer.yaml");
    expect(localeManifestUrl("Notepad++.Notepad++", "8.8.9")).toBe("https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests/n/Notepad++/Notepad++/8.8.9/Notepad++.Notepad++.locale.en-US.yaml");
    expect(versionListUrl("Notepad++.Notepad++")).toBe("https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/n/Notepad++/Notepad++");
    // the URL parser keeps the plus and does not turn it into a space or another path
    for (const url of [installerManifestUrl("Notepad++.Notepad++", "8.8.9"), versionListUrl("Notepad++.Notepad++")]) {
      expect(new URL(url).pathname).toContain("/Notepad++/Notepad++");
    }
    // only the plus is new: everything that changes a path stays refused
    for (const id of ["+a.b", "a.+b", "a+/b.c", "a.b%2B", "a.b;c", "a.b c"]) expect(wingetIdProblem(id), id).toBe(true);
  });
});

// ---------------------------------------------------------------- resolveWinget with a stub fetch

type Reply = { status?: number; body?: string; headers?: Record<string, string> };

/** A fetch that answers from `routes` (exact URL) and records every call. */
function stub(routes: Record<string, Reply | (() => Reply)>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
    const route = routes[url];
    const r = typeof route === "function" ? route() : route;
    if (r === undefined) return new Response("not found", { status: 404 });
    return new Response(r.body ?? "", { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { f, calls };
}

const listing = (...versions: string[]) => JSON.stringify(versions.map((name) => ({ name, type: "dir" })));
const API = "https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/7/7zip/7zip";

async function codeOfCall(p: Promise<unknown>): Promise<{ code: string | null; detail?: string }> {
  try {
    await p;
  } catch (e) {
    return { code: codeOf(e), detail: (e as { data?: { detail?: string } }).data?.detail };
  }
  return { code: null };
}

describe("resolveWinget (stub fetch)", () => {
  test("latest version: list, fetch the newest manifest and the locale; the token goes only to the API host", async () => {
    const { f, calls } = stub({
      [API]: { body: listing("23.01", "24.08", "9.20", "Insiders") },
      [installerManifestUrl("7zip.7zip", "24.08")]: { body: sevenZip },
      [localeManifestUrl("7zip.7zip", "24.08")]: { body: sevenZipLocale },
    });
    const r = await resolveWinget("7zip.7zip", undefined, { fetch: f, githubToken: "tok-123" });
    expect(r).toMatchObject({
      packageId: "7zip.7zip",
      version: "24.08",
      name: "7-Zip",
      publisher: "Igor Pavlov",
      install: { kind: "msi", productCode: "{23170F69-40C1-2702-2408-000001000000}" },
    });
    expect(calls.map((c) => c.url)).toEqual([API, installerManifestUrl("7zip.7zip", "24.08"), localeManifestUrl("7zip.7zip", "24.08")]);
    expect(calls[0]!.headers.authorization).toBe("Bearer tok-123");
    expect(calls.slice(1).every((c) => c.headers.authorization === undefined)).toBe(true);
    // no token: no header at all
    const { f: f2, calls: calls2 } = stub({ [API]: { body: listing("24.08") }, [installerManifestUrl("7zip.7zip", "24.08")]: { body: sevenZip } });
    await resolveWinget("7zip.7zip", undefined, { fetch: f2 });
    expect(calls2[0]!.headers.authorization).toBeUndefined();
  });

  test("a named version skips the listing; a missing locale manifest is not an error", async () => {
    const { f, calls } = stub({ [installerManifestUrl("7zip.7zip", "24.08")]: { body: sevenZip } });
    const r = await resolveWinget("7zip.7zip", "24.08", { fetch: f });
    expect(r.name).toBeUndefined();
    expect(calls.map((c) => c.url)).not.toContain(API);
  });

  test("the newest folder without a manifest falls back to the next one (at most three tries)", async () => {
    const { f, calls } = stub({
      [API]: { body: listing("4.0", "3.0", "2.0", "1.0") },
      [installerManifestUrl("7zip.7zip", "2.0")]: { body: sevenZip.replace('"24.08"', "2.0") },
    });
    const r = await resolveWinget("7zip.7zip", undefined, { fetch: f });
    expect(r.version).toBe("2.0");
    expect(calls.filter((c) => c.url.endsWith(".installer.yaml")).map((c) => c.url.split("/").at(-2))).toEqual(["4.0", "3.0", "2.0"]);
    const { f: f2 } = stub({ [API]: { body: listing("4.0", "3.0", "2.0", "1.0") }, [installerManifestUrl("7zip.7zip", "1.0")]: { body: sevenZip } });
    expect((await codeOfCall(resolveWinget("7zip.7zip", undefined, { fetch: f2 }))).code).toBe("winget_unsupported");
  });

  test("errors: unreachable / rate limited -> winget_unreachable (with the GITHUB_TOKEN hint); unknown package, nothing usable -> winget_unsupported", async () => {
    const rateLimited = stub({ [API]: { status: 403, body: "{}" } });
    const r1 = await codeOfCall(resolveWinget("7zip.7zip", undefined, { fetch: rateLimited.f }));
    expect(r1.code).toBe("winget_unreachable");
    expect(r1.detail).toMatch(/GITHUB_TOKEN/);
    expect((await codeOfCall(resolveWinget("7zip.7zip", undefined, { fetch: stub({ [API]: { status: 503 } }).f }))).code).toBe("winget_unreachable");
    const throwing = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    expect((await codeOfCall(resolveWinget("7zip.7zip", undefined, { fetch: throwing }))).code).toBe("winget_unreachable");
    expect((await codeOfCall(resolveWinget("7zip.7zip", undefined, { fetch: stub({ [API]: { body: "<html>" } }).f }))).code).toBe("winget_unreachable");
    // manifest fetch fails with a server error (not 404)
    const mid = stub({ [API]: { body: listing("24.08") }, [installerManifestUrl("7zip.7zip", "24.08")]: { status: 500 } });
    expect((await codeOfCall(resolveWinget("7zip.7zip", undefined, { fetch: mid.f }))).code).toBe("winget_unreachable");

    const missing = await codeOfCall(resolveWinget("7zip.7zip", undefined, { fetch: stub({}).f }));
    expect(missing.code).toBe("winget_unsupported");
    expect(missing.detail).toMatch(/not found/);

    const sp = stub({
      ["https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/s/Spotify/Spotify"]: { body: listing("1.2.52.442") },
      [installerManifestUrl("Spotify.Spotify", "1.2.52.442")]: { body: spotify },
    });
    const refused = await codeOfCall(resolveWinget("Spotify.Spotify", undefined, { fetch: sp.f }));
    expect(refused.code).toBe("winget_unsupported");
    expect(refused.detail).toMatch(/per-user/);
  });

  test("a manifest for another package, an oversized manifest, and a redirect off GitHub are refused", async () => {
    const other = stub({ [API]: { body: listing("24.08") }, [installerManifestUrl("7zip.7zip", "24.08")]: { body: sevenZip.replace("PackageIdentifier: 7zip.7zip", "PackageIdentifier: Evil.App") } });
    expect((await codeOfCall(resolveWinget("7zip.7zip", undefined, { fetch: other.f }))).detail).toMatch(/another package/);
    // the repository is case-sensitive but the identity check is not
    const caseOnly = stub({ [API]: { body: listing("24.08") }, [installerManifestUrl("7zip.7zip", "24.08")]: { body: sevenZip.replace("PackageIdentifier: 7zip.7zip", "PackageIdentifier: 7Zip.7Zip") } });
    await expect(resolveWinget("7zip.7zip", undefined, { fetch: caseOnly.f })).resolves.toMatchObject({ packageId: "7zip.7zip" });

    const huge = stub({ [API]: { body: listing("24.08") }, [installerManifestUrl("7zip.7zip", "24.08")]: { body: "#".repeat(600 * 1024) } });
    expect((await codeOfCall(resolveWinget("7zip.7zip", undefined, { fetch: huge.f }))).detail).toMatch(/too large/);

    const redirect = stub({
      [API]: { body: listing("24.08") },
      [installerManifestUrl("7zip.7zip", "24.08")]: { status: 302, headers: { location: "https://evil.example.com/m.yaml" } },
      "https://evil.example.com/m.yaml": { body: sevenZip },
    });
    // the redirect target is a public https host, but it is not GitHub: not accepted
    expect((await codeOfCall(resolveWinget("7zip.7zip", undefined, { fetch: redirect.f }))).code).toBe("winget_unreachable");
  });

  test("input that would change the URL path is refused before any request", async () => {
    const { f, calls } = stub({});
    for (const id of ["7zip/7zip", "../x.y", "a.b/../c", "a.b?x=1", "no-dot", "a.b c", "a..b", ""]) {
      expect((await codeOfCall(resolveWinget(id, undefined, { fetch: f }))).code, id).toBe("invalid_argument");
    }
    for (const version of ["../1", "1/2", "1 2", "", "a".repeat(65)]) {
      expect((await codeOfCall(resolveWinget("7zip.7zip", version, { fetch: f }))).code, version).toBe("invalid_argument");
    }
    expect(calls).toHaveLength(0);
  });
});
