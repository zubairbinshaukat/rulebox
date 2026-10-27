import { describe, expect, it } from "vitest";
import raw from "../../../../crates/rulebox-ipc/tests/vectors/hotkeys.json?raw";
import * as v from "./validate";

// The shared vectors: `rulebox_ipc::hotkey::parse` (Rust, the source of truth),
// convex/lib/hotkey.ts and this port must agree on every one.
const vectors = JSON.parse(raw) as { accept: [string, string][]; reject: [string, v.HotkeyProblem][] };

describe("hotkey = rulebox_ipc::hotkey::parse (crates/rulebox-ipc/tests/vectors/hotkeys.json)", () => {
  it("the vector file is not empty", () => {
    expect(vectors.accept.length).toBeGreaterThanOrEqual(10);
    expect(vectors.reject.length).toBeGreaterThanOrEqual(10);
  });
  it.each(vectors.accept)("accepts %j as %s", (text, canonical) => {
    expect(v.parseHotkey(text)).toEqual({ ok: true, canonical });
    expect(v.parseHotkey(canonical)).toEqual({ ok: true, canonical });
  });
  it.each(vectors.reject)("refuses %j (%s)", (text, reason) => {
    const r = v.parseHotkey(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });
  it("the default is canonical", () => {
    expect(v.parseHotkey(v.DEFAULT_HOTKEY)).toEqual({ ok: true, canonical: v.DEFAULT_HOTKEY });
  });
  it("names the token that is not a key", () => {
    expect(v.parseHotkey("Ctrl+Esc")).toEqual({ ok: false, reason: "UnknownToken", token: "Esc" });
  });
});

describe("exit PIN = exitPinProblem of convex/lib/orgSettings.ts (Section 4.10)", () => {
  it.each([
    ["12345", "6 to 12 digits"],
    ["1234567890123", "6 to 12 digits"],
    ["12a456", "6 to 12 digits"],
    ["", "6 to 12 digits"],
    ["111111", "all digits the same"],
    ["123456", "sequence"],
    ["987654", "sequence"],
    ["0123456789", "sequence"],
  ])("refuses %j (%s)", (pin, problem) => {
    expect(v.exitPinProblem(pin)).toBe(problem);
    expect(v.exitPin(pin)).toBeTruthy();
  });
  it.each(["246813", "890123", "121212", "135790"])("accepts %j (the server has no wrap-around or pattern rule)", (pin) => {
    expect(v.exitPinProblem(pin)).toBeNull();
    expect(v.exitPin(pin)).toBeNull();
  });
});

describe("names, usernames, passwords", () => {
  it("names are trimmed, bounded and free of control characters", () => {
    expect(v.name("  ", 60)).toBeTruthy();
    expect(v.name("a".repeat(61), 60)).toBeTruthy();
    expect(v.name("ok\nname", 60)).toBeTruthy();
    expect(v.name("  Front desk  ", 60)).toBeNull();
    // Group names: 64 like MAX_GROUP_NAME; descriptions may span lines (length only).
    expect(v.name("g".repeat(64), v.NAME_MAX.group)).toBeNull();
    expect(v.name("g".repeat(65), v.NAME_MAX.group)).toBeTruthy();
    expect(v.description("line one\nline two", 300)).toBeNull();
    expect(v.description("d".repeat(301), 300)).toBeTruthy();
  });
  it("usernames: 1–64 of letters, digits, . _ -", () => {
    expect(v.username("Maya")).toBeNull();
    expect(v.normalizeUsername(" Maya ")).toBe("maya");
    expect(v.username("maya smith")).toBeTruthy();
    expect(v.username("a".repeat(65))).toBeTruthy();
  });
  it("employee password: 8–256 and not the username", () => {
    expect(v.employeePassword("1234567", "maya")).toBeTruthy();
    expect(v.employeePassword("Maya.smith", "maya.smith")).toBeTruthy();
    expect(v.employeePassword("correct horse", "maya")).toBeNull();
  });
  it("member password: 12+ with a letter and a digit", () => {
    expect(v.memberPassword("short1")).toBeTruthy();
    expect(v.memberPassword("onlylettersxx")).toBeTruthy();
    expect(v.memberPassword("letters-and-1-digit")).toBeNull();
  });
  it("email", () => {
    expect(v.email("a@b.co")).toBeNull();
    expect(v.email("a@b")).toBeTruthy();
    expect(v.email("a@@b.co")).toBeTruthy();
  });
  it("quota: empty = default, 0..2000", () => {
    expect(v.quota("")).toBeNull();
    expect(v.quota("0")).toBeNull();
    expect(v.quota("2001")).toBeTruthy();
    expect(v.quota("1.5")).toBeTruthy();
  });
});

describe("apps", () => {
  it("web URL rules (Step 10)", () => {
    expect(v.webUrl("https://pos.example.com")).toBeNull();
    expect(v.webUrl("http://pos.example.com")).toBeTruthy();
    expect(v.webUrl("https://10.0.0.1")).toBeTruthy();
    expect(v.webUrl("https://192.168.1.10/app")).toBeTruthy();
    expect(v.webUrl("https://localhost")).toBeTruthy();
  });
  it("allowed domains", () => {
    expect(v.domains(["example.com", "*.cdn.example.com"])).toBeNull();
    expect(v.domains(["https://example.com"])).toBeTruthy();
    expect(v.domains(["Example.com"])).toBeTruthy();
    expect(v.domains(Array.from({ length: 21 }, (_, i) => `a${i}.example.com`))).toBeTruthy();
  });
  it("exe path templates (Section 4.8)", () => {
    expect(v.exePath("{ProgramFiles}\\VideoLAN\\VLC\\vlc.exe", false)).toBeNull();
    expect(v.exePath("C:\\x.exe", false)).toBeTruthy();
    expect(v.exePath("{ProgramFiles}\\..\\x.exe", false)).toBeTruthy();
    expect(v.exePath("{ProgramFiles}\\a\\b.bat", false)).toBeTruthy();
    expect(v.exePath("{ProgramFiles}\\1\\2\\3\\4\\5\\6\\7\\8\\x.exe", false)).toBeTruthy();
    expect(v.exePath("{RuleboxApps}\\{AppId}\\labels.exe", true)).toBeNull();
    expect(v.exePath("{ProgramFiles}\\labels.exe", true)).toBeTruthy();
  });
  it("sha256, file argument, silent args, reset folders", () => {
    expect(v.sha256("a".repeat(64))).toBeNull();
    expect(v.sha256("a".repeat(63))).toBeTruthy();
    expect(v.fileArgTemplate(["--open", "{file}"])).toBeNull();
    expect(v.fileArgTemplate(["{file}", "{file}"])).toBeTruthy();
    expect(v.fileArgTemplate([])).toBeNull();
    expect(v.silentArgs([])).toBeTruthy();
    expect(v.resetFolders(["{LocalAppData}\\Vendor\\App"])).toBeNull();
    expect(v.resetFolders(["C:\\Users\\x"])).toBeTruthy();
    expect(v.splitArgs('/S "/D=C:\\Program Files\\X"')).toEqual(["/S", "/D=C:\\Program Files\\X"]);
  });
  it("file types: format and the deny-list", () => {
    expect(v.extension("PDF")).toBeNull();
    expect(v.normalizeExtension("PDF")).toBe(".pdf");
    expect(v.extension(".exe")).toBeTruthy();
    expect(v.extension(".ps1")).toBeTruthy();
    expect(v.extension(".toolongextension")).toBeTruthy();
  });
});

describe("MFA codes", () => {
  it("TOTP and recovery codes", () => {
    expect(v.totpCode("123 456")).toBeNull();
    expect(v.totpCode("12345")).toBeTruthy();
    expect(v.normalizeRecoveryCode("abcd efgh")).toBe("ABCD-EFGH");
    expect(v.recoveryCode("abcd-efgh")).toBeNull();
    expect(v.recoveryCode("abc")).toBeTruthy();
  });
});
