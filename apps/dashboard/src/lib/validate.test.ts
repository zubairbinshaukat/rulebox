import { describe, expect, it } from "vitest";
import * as v from "./validate";

describe("hotkey (port of rulebox_ipc::hotkey::parse, same examples as the Rust tests)", () => {
  it.each([
    ["Ctrl+Shift+F12", "Ctrl+Shift+F12"],
    [" ctrl + shift + f12 ", "Ctrl+Shift+F12"],
    ["shift+CTRL+F12", "Ctrl+Shift+F12"],
    ["Ctrl+Alt+Shift+R", "Ctrl+Alt+Shift+R"],
    ["Ctrl+0", "Ctrl+0"],
    ["Alt+9", "Alt+9"],
    ["Alt+F1", "Alt+F1"],
    ["Ctrl+Alt+Z", "Ctrl+Alt+Z"],
    ["shift+alt+ctrl+r", "Ctrl+Alt+Shift+R"],
  ])("accepts %s", (text, canonical) => {
    expect(v.parseHotkey(text)).toEqual({ ok: true, canonical });
  });
  it.each(["", "   ", "Shift+A", "Ctrl", "Ctrl+Shift", "Ctrl+A+B", "Ctrl+Ctrl+A", "Ctrl+Del", "Alt+Tab", "Ctrl+F13", "Ctrl+F0", "Ctrl+F01", "Ctrl+Esc", "Ctrl+", "Ctrl+Alt+Del", "Ctrl+10", "Ctrl+\u00e9", "Win+L"])(
    "refuses %j",
    (text) => {
      expect(v.parseHotkey(text).ok).toBe(false);
      expect(v.hotkey(text)).toBeTruthy();
    },
  );
});

describe("exit PIN (Section 4.10)", () => {
  it.each(["12345", "1234567890123", "111111", "123456", "987654", "12a456", ""])("refuses %j", (pin) => {
    expect(v.exitPin(pin)).toBeTruthy();
  });
  it("accepts 246813", () => {
    expect(v.exitPin("246813")).toBeNull();
  });
});

describe("names, usernames, passwords", () => {
  it("names are trimmed, bounded and free of control characters", () => {
    expect(v.name("  ", 60)).toBeTruthy();
    expect(v.name("a".repeat(61), 60)).toBeTruthy();
    expect(v.name("ok\nname", 60)).toBeTruthy();
    expect(v.name("  Front desk  ", 60)).toBeNull();
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
