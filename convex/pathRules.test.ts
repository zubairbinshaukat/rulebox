import { describe, expect, test } from "vitest";
import { httpsUrlProblem, normalizeDesktop, normalizeInstall, normalizeWeb } from "./lib/appRules";
import { codeOf } from "../tests/convex/identity";
import { domainProblem, isForbiddenHost, webUrlProblem } from "./lib/hostRules";
import { programDenied } from "./lib/denyList";
import { argsProblem, exePathProblem, fileArgProblem, RESET_DENY, resetFoldersProblem } from "./lib/pathRules";
import resetVectorsRaw from "../crates/rulebox-policy/tests/vectors/reset-folders.json?raw";
import { DEFAULT_WEB_PERMISSIONS } from "./lib/validators";

// Path templates (plan 4.8), web address rules (Step 10 item 3), and the
// normalizers that apply them. Pure: no database.

const fixed = { portable: false } as const;

describe("exe path templates", () => {
  test("accepted", () => {
    for (const exe of [
      "{ProgramFiles}\\VideoLAN\\VLC\\vlc.exe",
      "{ProgramFilesX86}\\Notepad++\\notepad++.exe",
      "{SystemRoot}\\System32\\calc.exe",
      "{SystemRoot}\\System32\\notepad.exe",
      "{SystemRoot}\\System32\\mspaint.exe",
      "{ProgramFiles}\\Connect\\relay.exe", // "con" inside a longer name is fine
      "{ProgramFiles}\\Acme\\v1.2\\a.exe",
      "{ProgramFiles}\\7-Zip\\7zFM.EXE",
      "{ProgramFiles}\\A (b) & c+d_e-f.g\\x.exe",
    ]) {
      expect(exePathProblem(exe, fixed), exe).toBeNull();
    }
  });

  test("refused: absolute paths, traversal, scripts, depth, odd characters, wrong roots", () => {
    const bad: [string, string][] = [
      ["C:\\x.exe", "absolute path"],
      ["{ProgramFiles}\\..\\x.exe", "parent folder"],
      ["{ProgramFiles}\\.\\x.exe", "current folder"],
      ["{ProgramFiles}\\a\\b.bat", "script"],
      ["{ProgramFiles}\\a\\b.cmd", "script"],
      ["{ProgramFiles}\\a\\b", "no extension"],
      ["{ProgramFiles}\\1\\2\\3\\4\\5\\6\\7\\8\\x.exe", "9 components"],
      ["{ProgramFiles}\\", "no file"],
      ["{ProgramFiles}\\a\\\\x.exe", "empty component"],
      ["{ProgramFiles}\\a:b\\x.exe", "colon (stream or drive)"],
      ["{ProgramFiles}\\a|b\\x.exe", "pipe"],
      ["{ProgramFiles}\\a\\x.exe ", "trailing space after the extension"],
      ["{ProgramFiles}\\...\\x.exe", "dots only"],
      ["{ProgramFiles}\\ \\x.exe", "space only"],
      ["{ProgramFiles}\\" + "a".repeat(101) + "\\x.exe", "101-character component"],
      ["{SystemRoot}\\x.exe", "System32 required under SystemRoot"],
      ["{SystemRoot}\\SysWOW64\\x.exe", "only System32"],
      ["{LocalAppData}\\x\\y.exe", "user folder"],
      ["%ProgramFiles%\\x.exe", "environment variable"],
      ["\\\\server\\share\\x.exe", "UNC"],
      ["{RuleboxApps}\\other\\x.exe", "portable root for a non-portable app"],
      ["{programfiles}\\x.exe", "token is case-sensitive"],
    ];
    for (const [exe, why] of bad) expect(exePathProblem(exe, fixed), `${exe} (${why})`).not.toBeNull();
  });

  test("a component may not end in a dot or space, nor be a DOS device name (with or without an extension)", () => {
    for (const exe of [
      "{ProgramFiles}\\a.\\x.exe",
      "{ProgramFiles}\\a \\x.exe",
      "{ProgramFiles}\\a\\x.exe.",
      "{ProgramFiles}\\CON\\x.exe",
      "{ProgramFiles}\\nul.txt\\x.exe",
      "{ProgramFiles}\\Aux.old\\x.exe",
      "{ProgramFiles}\\a\\PRN.exe",
      "{ProgramFiles}\\a\\com1.exe",
      "{ProgramFiles}\\a\\LPT9\\x.exe",
      "{ProgramFiles}\\a\\lpt1.x.exe",
    ]) {
      expect(exePathProblem(exe, fixed), exe).not.toBeNull();
    }
    for (const exe of ["{ProgramFiles}\\com10\\x.exe", "{ProgramFiles}\\com0\\x.exe", "{ProgramFiles}\\console\\x.exe", "{ProgramFiles}\\lpt\\x.exe"]) {
      expect(exePathProblem(exe, fixed), exe).toBeNull();
    }
    expect(resetFoldersProblem(["{LocalAppData}\\CON"])).not.toBeNull();
    expect(resetFoldersProblem(["{LocalAppData}\\Acme."])).not.toBeNull();
    expect(resetFoldersProblem(["{LocalAppData}\\Acme\\nul.dat"])).not.toBeNull();
  });

  test("shells, script hosts, runtimes and living-off-the-land programs are refused wherever they are (PRD 7.3)", () => {
    for (const name of ["cmd", "powershell", "pwsh", "wscript", "cscript", "mshta", "rundll32", "regsvr32", "msiexec", "wmic", "bitsadmin", "certutil", "schtasks", "reg", "mmc", "explorer", "taskmgr", "python", "node", "java"]) {
      expect(exePathProblem(`{SystemRoot}\\System32\\${name}.exe`, fixed), name).toBe("program not allowed");
      expect(exePathProblem(`{ProgramFiles}\\Some App\\${name.toUpperCase()}.EXE`, fixed), `${name} in Program Files`).toBe("program not allowed");
      expect(exePathProblem(`{RuleboxApps}\\k17abc\\${name}.exe`, { portable: true, appId: "k17abc" }), `${name} portable`).toBe("program not allowed");
    }
    expect(programDenied("{SystemRoot}\\System32\\WScript.exe")).toBe(true);
    expect(programDenied("{SystemRoot}\\System32\\notepad.exe")).toBe(false);
    expect(programDenied("{ProgramFiles}\\cmd-tools\\viewer.exe")).toBe(false); // only the file name counts
  });

  test("a path longer than 260 characters after expansion is refused", () => {
    const long = (n: number) => `{ProgramFiles}\\${Array.from({ length: 4 }, () => "a".repeat(n)).join("\\")}\\x.exe`;
    expect(exePathProblem(long(50), fixed)).toBeNull();
    expect(exePathProblem(long(70), fixed)).toBe("path too long");
  });

  test("a portable app lives only in its own {RuleboxApps} folder", () => {
    const create = { portable: true } as const; // no id yet: the placeholder
    expect(exePathProblem("{RuleboxApps}\\{AppId}\\app.exe", create)).toBeNull();
    expect(exePathProblem("{RuleboxApps}\\other\\x.exe", create)).not.toBeNull();
    expect(exePathProblem("{ProgramFiles}\\x\\x.exe", create)).not.toBeNull();
    const stored = { portable: true, appId: "k17abc" } as const;
    expect(exePathProblem("{RuleboxApps}\\k17abc\\app.exe", stored)).toBeNull();
    expect(exePathProblem("{RuleboxApps}\\k17abc\\sub\\app.exe", stored)).toBeNull();
    // another app's folder, or the placeholder once the id is known
    expect(exePathProblem("{RuleboxApps}\\k99zzz\\app.exe", stored)).not.toBeNull();
    expect(exePathProblem("{RuleboxApps}\\{AppId}\\app.exe", stored)).not.toBeNull();
  });
});

describe("arguments and cleanup folders", () => {
  test("args: at most 16 of at most 200 characters, no control characters", () => {
    expect(argsProblem(Array.from({ length: 16 }, () => "a"))).toBeNull();
    expect(argsProblem(Array.from({ length: 17 }, () => "a"))).not.toBeNull();
    expect(argsProblem(["a".repeat(200)])).toBeNull();
    expect(argsProblem(["a".repeat(201)])).not.toBeNull();
    expect(argsProblem(["a\nb"])).not.toBeNull();
    expect(argsProblem(["a\u0000b"])).not.toBeNull();
  });

  test("fileArgTemplate: empty, or {file} exactly once", () => {
    expect(fileArgProblem([])).toBeNull();
    expect(fileArgProblem(["{file}"])).toBeNull();
    expect(fileArgProblem(["--open", "{file}"])).toBeNull();
    expect(fileArgProblem(["--open"])).not.toBeNull();
    expect(fileArgProblem(["{file}", "{file}"])).not.toBeNull();
    expect(fileArgProblem(["{file}{file}"])).not.toBeNull();
  });

  test("reset folders: Local/Roaming AppData, 1-6 components", () => {
    expect(resetFoldersProblem(["{LocalAppData}\\VideoLAN", "{RoamingAppData}\\vlc\\cache"])).toBeNull();
    expect(resetFoldersProblem(["{LocalAppData}\\a\\b\\c\\d\\e\\f"])).toBeNull();
    expect(resetFoldersProblem(["{LocalAppData}\\a\\b\\c\\d\\e\\f\\g"])).not.toBeNull();
    expect(resetFoldersProblem(["{LocalAppData}\\..\\x"])).not.toBeNull();
    expect(resetFoldersProblem(["{LocalAppData}\\"])).not.toBeNull();
    expect(resetFoldersProblem(["C:\\Users\\x"])).not.toBeNull();
    expect(resetFoldersProblem(["{ProgramFiles}\\x"])).not.toBeNull();
    expect(resetFoldersProblem(Array.from({ length: 21 }, (_, i) => `{LocalAppData}\\f${i}`))).not.toBeNull();
  });

  // (Step 16 review) The shared vectors also run against
  // `rulebox_policy::paths::reset_folder_parts`: both must agree on every one.
  const resetVectors = JSON.parse(resetVectorsRaw) as { deny: string[][]; accept: string[]; reject: [string, string][] };
  const kindOf: Record<string, string> = {
    "folder must start with {LocalAppData} or {RoamingAppData}": "root",
    "folder path not allowed": "path",
    "folder holds Windows or Rulebox data": "denied",
  };

  test("reset folders: the deny list is the shared one (Windows secrets and shell data, the Staff App's data)", () => {
    expect(RESET_DENY).toEqual(resetVectors.deny);
    expect(resetVectors.accept.length).toBeGreaterThanOrEqual(10);
    expect(resetVectors.reject.length).toBeGreaterThanOrEqual(20);
  });

  test.each(resetVectors.accept)("reset folders: accepts %s", (template) => {
    expect(resetFoldersProblem([template])).toBeNull();
  });

  test.each(resetVectors.reject)("reset folders: refuses %s (%s)", (template, kind) => {
    const problem = resetFoldersProblem([template]);
    expect(problem).not.toBeNull();
    expect(kindOf[problem!]).toBe(kind);
  });
});

describe("web addresses", () => {
  test("accepted", () => {
    for (const url of ["https://example.com", "https://docs.example.com/a/b?x=1#y", "https://example.com:8443/", "https://93.184.216.34/"]) {
      expect(webUrlProblem(url), url).toBeNull();
    }
  });

  test("refused: not https, credentials, private and local hosts, odd IP spellings", () => {
    const bad = [
      "http://example.com",
      "ftp://example.com",
      "//example.com",
      "example.com",
      "https://",
      "https://user:pw@example.com",
      "https://10.0.0.1",
      "https://127.0.0.1",
      "https://127.1",
      "https://0x7f.1",
      "https://2130706433",
      "https://169.254.169.254/latest/meta-data",
      "https://192.168.1.1",
      "https://172.16.0.1",
      "https://172.31.255.255",
      "https://100.64.0.1",
      "https://0.0.0.0",
      "https://224.0.0.1",
      "https://255.255.255.255",
      "https://[::1]",
      "https://[fd00::1]",
      "https://localhost",
      "https://LOCALHOST:8443",
      "https://app.localhost",
      "https://printer.local",
      "https://wiki.internal",
      "https://intranet",
      "https://" + "a".repeat(2_100) + ".com",
    ];
    for (const url of bad) expect(webUrlProblem(url), url).not.toBeNull();
    // 172.15 and 172.32 are public
    expect(webUrlProblem("https://172.15.0.1")).toBeNull();
    expect(webUrlProblem("https://172.32.0.1")).toBeNull();
  });

  test("isForbiddenHost is the same rule for redirects", () => {
    expect(isForbiddenHost("169.254.169.254")).toBe(true);
    expect(isForbiddenHost("metadata.google.internal")).toBe(true);
    expect(isForbiddenHost("example.com.")).toBe(false);
    expect(isForbiddenHost("localhost.")).toBe(true);
  });

  test("wildcard-DNS names, localhost.<anything> and 192.88.99.0/24 are refused; ordinary look-alikes are not", () => {
    for (const host of ["10.0.0.1.nip.io", "nip.io", "a.b.sslip.io", "127.0.0.1.xip.io", "x.traefik.me", "app.localtest.me", "foo.lvh.me", "localhost.example.com", "api.localhost.evil.net", "192.88.99.1", "192.88.99.255"]) {
      expect(isForbiddenHost(host), host).toBe(true);
      expect(webUrlProblem(`https://${host}/`), host).toBe("host");
    }
    for (const host of ["example.com", "mynip.io", "notlocalhost.example.com", "localhosting.example.com", "192.88.98.1", "192.88.100.1"]) {
      expect(isForbiddenHost(host), host).toBe(false);
    }
  });

  test("allowed domains: host or *.host, lower-case, no scheme or path", () => {
    for (const d of ["example.com", "*.example.com", "a-b.example.co.uk"]) expect(domainProblem(d), d).toBe(false);
    for (const d of ["Example.com", "https://example.com", "example.com/path", "*.*.example.com", "example", "*example.com", "-a.example.com", "a..com"]) {
      expect(domainProblem(d), d).toBe(true);
    }
  });

  test("normalizeWeb adds the URL's host first, de-duplicates, and caps the admin's own list at 20", () => {
    const w = normalizeWeb("https://Docs.Example.com/x", ["*.cdn.example.com", "docs.example.com", "api.example.com", "api.example.com"]);
    expect(w).toEqual({
      url: "https://Docs.Example.com/x",
      allowedDomains: ["docs.example.com", "*.cdn.example.com", "api.example.com"],
      permissions: { ...DEFAULT_WEB_PERMISSIONS, printing: true }, // a new site allows printing (Phase 5 Step 11)
    });
    const many = Array.from({ length: 21 }, (_, i) => `h${i}.example.com`);
    expect(() => normalizeWeb("https://example.com", many)).toThrow();
    expect(normalizeWeb("https://example.com", many.slice(0, 20)).allowedDomains).toHaveLength(21); // 20 + the host
    expect(() => normalizeWeb("http://example.com", [])).toThrow();
    expect(() => normalizeWeb("https://10.0.0.1", [])).toThrow();
    expect(() => normalizeWeb("https://localhost", [])).toThrow();
    expect(() => normalizeWeb("https://example.com", ["Bad.com"])).toThrow();
  });
});

const sha = "A".repeat(64);
const msi = { kind: "msi" as const, url: "https://example.com/a.msi", sha256: sha, sizeBytes: 0, silentArgs: [], successExitCodes: [0], removeWhenUnassigned: true };
const exe = { ...msi, kind: "exe" as const, url: "https://example.com/a.exe", silentArgs: ["/S"], removeWhenUnassigned: true };
const desktop = (over: Partial<Parameters<typeof normalizeDesktop>[0]>) => ({
  source: "msi" as const,
  exe: "{ProgramFiles}\\Acme\\a.exe",
  args: [],
  fileArgTemplate: [],
  resetFolders: [],
  install: msi,
  ...over,
});

function fieldOf(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    expect(codeOf(e)).toBe("invalid_argument");
    return (e as { data: { field?: string } }).data.field;
  }
  return undefined;
}

describe("desktop app normalization", () => {
  test("install: SHA-256 is 64 hex (lower-cased), the URL is https, sizes are bounded", () => {
    expect(normalizeInstall(msi, ["msi"]).sha256).toBe("a".repeat(64));
    expect(fieldOf(() => normalizeInstall({ ...msi, sha256: "a".repeat(63) }, ["msi"]))).toBe("install.sha256");
    expect(fieldOf(() => normalizeInstall({ ...msi, sha256: "g".repeat(64) }, ["msi"]))).toBe("install.sha256");
    expect(fieldOf(() => normalizeInstall({ ...msi, url: "http://example.com/a.msi" }, ["msi"]))).toBe("install.url");
    expect(fieldOf(() => normalizeInstall({ ...msi, url: "https://u:p@example.com/a.msi" }, ["msi"]))).toBe("install.url");
    expect(fieldOf(() => normalizeInstall({ ...msi, url: "file:///c:/a.msi" }, ["msi"]))).toBe("install.url");
    expect(fieldOf(() => normalizeInstall({ ...msi, sizeBytes: 4 * 1024 ** 3 + 1 }, ["msi"]))).toBe("install.sizeBytes");
    expect(normalizeInstall({ ...msi, sizeBytes: 4 * 1024 ** 3 }, ["msi"]).sizeBytes).toBe(4 * 1024 ** 3);
    expect(fieldOf(() => normalizeInstall({ ...msi, sizeBytes: -1 }, ["msi"]))).toBe("install.sizeBytes");
    // a LAN installer server is fine: only https is required of installers
    expect(httpsUrlProblem("https://10.0.0.5/setup.msi")).toBe(false);
  });

  test("install: exe needs silent switches, msi needs none; product code upper-cased; exit codes always include 0", () => {
    expect(fieldOf(() => normalizeInstall({ ...exe, silentArgs: [] }, ["exe"]))).toBe("install.silentArgs");
    expect(normalizeInstall({ ...msi, silentArgs: ["/x"] }, ["msi"]).silentArgs).toEqual([]);
    expect(normalizeInstall({ ...msi, productCode: "{23170f69-40c1-2702-2408-000001000000}" }, ["msi"]).productCode).toBe(
      "{23170F69-40C1-2702-2408-000001000000}",
    );
    expect(fieldOf(() => normalizeInstall({ ...msi, productCode: "23170F69" }, ["msi"]))).toBe("install.productCode");
    expect(normalizeInstall({ ...exe, productCode: "{23170F69-40C1-2702-2408-000001000000}" }, ["exe"]).productCode).toBeUndefined();
    expect(normalizeInstall({ ...msi, successExitCodes: [3010, 1641, 3010] }, ["msi"]).successExitCodes).toEqual([0, 1641, 3010]);
    expect(fieldOf(() => normalizeInstall({ ...msi, successExitCodes: [1.5] }, ["msi"]))).toBe("install.successExitCodes");
    // an exe installer cannot be uninstalled in Phase 4: the flag is forced off
    expect(normalizeInstall(exe, ["exe"]).removeWhenUnassigned).toBe(false);
    expect(fieldOf(() => normalizeInstall(msi, ["exe"]))).toBe("install.kind");
  });

  test("sources: preinstalled has no install; msi/exe/portable need a matching one; winget needs an id", () => {
    expect(normalizeDesktop(desktop({ source: "preinstalled", install: undefined })).install).toBeUndefined();
    expect(fieldOf(() => normalizeDesktop(desktop({ source: "preinstalled" })))).toBe("source");
    expect(fieldOf(() => normalizeDesktop(desktop({ source: "msi", install: undefined })))).toBe("install");
    expect(fieldOf(() => normalizeDesktop(desktop({ source: "exe" })))).toBe("install.kind"); // msi install on an exe source
    expect(fieldOf(() => normalizeDesktop(desktop({ source: "winget" })))).toBe("wingetId");
    expect(fieldOf(() => normalizeDesktop(desktop({ source: "winget", wingetId: "7zip/7zip" })))).toBe("wingetId");
    expect(fieldOf(() => normalizeDesktop(desktop({ source: "winget", wingetId: "7zip.7zip", wingetVersion: "../x" })))).toBe("wingetVersion");
    const ok = normalizeDesktop(desktop({ source: "winget", wingetId: "7zip.7zip", wingetVersion: "24.08" }));
    expect(ok).toMatchObject({ source: "winget", wingetId: "7zip.7zip", wingetVersion: "24.08" });
    expect(fieldOf(() => normalizeDesktop(desktop({ wingetId: "7zip.7zip" })))).toBe("source");
  });

  test("portable: the path must be in its own folder; {AppId} is only for create", () => {
    const portable = desktop({ source: "portable", exe: "{RuleboxApps}\\{AppId}\\tool.exe", install: { ...msi, kind: "portable", url: "https://example.com/tool.exe" } });
    expect(normalizeDesktop(portable).exe).toBe("{RuleboxApps}\\{AppId}\\tool.exe");
    expect(normalizeDesktop(portable, "k17abc").exe).toBe("{RuleboxApps}\\k17abc\\tool.exe");
    expect(fieldOf(() => normalizeDesktop({ ...portable, exe: "{RuleboxApps}\\other\\tool.exe" }))).toBe("exe");
    expect(fieldOf(() => normalizeDesktop({ ...portable, exe: "{ProgramFiles}\\tool.exe" }))).toBe("exe");
    expect(fieldOf(() => normalizeDesktop(desktop({ exe: "{RuleboxApps}\\k17abc\\tool.exe" }), "k17abc"))).toBe("exe");
    expect(fieldOf(() => normalizeDesktop(desktop({ exe: "C:\\x.exe" })))).toBe("exe");
    expect(fieldOf(() => normalizeDesktop(desktop({ exe: "{SystemRoot}\\System32\\cmd.exe" })))).toBe("exe");
    expect(fieldOf(() => normalizeDesktop(desktop({ exe: "{SystemRoot}\\System32\\wscript.exe", fileArgTemplate: ["{file}"] })))).toBe("exe");
  });

  test("arguments, file argument and cleanup folders are checked with the same rules", () => {
    expect(fieldOf(() => normalizeDesktop(desktop({ args: Array.from({ length: 17 }, () => "a") })))).toBe("args");
    expect(fieldOf(() => normalizeDesktop(desktop({ fileArgTemplate: ["--open"] })))).toBe("fileArgTemplate");
    expect(fieldOf(() => normalizeDesktop(desktop({ resetFolders: ["C:\\Users"] })))).toBe("resetFolders");
    const d = normalizeDesktop(desktop({ fileArgTemplate: ["{file}"], resetFolders: ["{LocalAppData}\\Acme", "{LocalAppData}\\Acme"] }));
    expect(d.resetFolders).toEqual(["{LocalAppData}\\Acme"]);
  });
});
