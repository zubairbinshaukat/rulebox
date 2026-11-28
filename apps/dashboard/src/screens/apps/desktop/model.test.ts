import { describe, expect, it } from "vitest";
import { appAddStrings as t } from "../../../lib/screenStrings/appAdd";
import { initialValues, type FormValues } from "../appForm";
import { automaticOf, blankDesktopDetail, companyFolder, exeFolderOf, friendlyPath, linesOf, nameFromUrl, wingetFill } from "./model";

const base = (over: Partial<FormValues> = {}): FormValues => ({ ...initialValues(blankDesktopDetail(), "desktop"), ...over });
const install = { kind: "exe" as const, url: "https://x.example.com/a.exe", sha256: "ab".repeat(32), sizeBytes: 1, silentArgs: ["/S"], successExitCodes: [0], removeWhenUnassigned: false };

describe("linesOf", () => {
  it("a winget exe: installs silently, checked, from winget, stays installed, keeps the version", () => {
    const resolved = { packageId: "A.B", version: "1.2", install };
    const { lines, silent } = linesOf(base({ source: "winget", resolved, silentArgs: "/S", version: "1.2", removeWhenUnassigned: false }), null);
    expect(silent.state).toBe("silent");
    expect(lines.map((l) => l.label)).toEqual([t.silent.silent, t.lines.checked, t.lines.wingetFrom("1.2"), t.lines.keep, t.lines.version("1.2")]);
  });
  it("an MSI that is removed on unassign", () => {
    const { lines } = linesOf(base({ source: "msi", sha256: "ab".repeat(32), removeWhenUnassigned: true }), null);
    expect(lines.map((l) => l.id)).toEqual(["silent", "checked", "removal"]);
    expect(lines.find((l) => l.id === "removal")!.label).toBe(t.lines.remove);
  });
  it("a plain exe with no switches has no silent line (the page shows the warning card)", () => {
    const { lines, silent } = linesOf(base({ source: "exe", sha256: "ab".repeat(32) }), null);
    expect(silent.state).toBe("unknown");
    expect(lines.some((l) => l.id === "silent")).toBe(false);
  });
  it("an already installed program has nothing but its silent line", () => {
    const { lines } = linesOf(base({ source: "preinstalled", version: "1" }), null);
    expect(lines.map((l) => l.id)).toEqual(["silent"]);
  });
});

describe("automaticOf", () => {
  it("is the stored technology's table when nothing was checked", () => {
    expect(automaticOf(base({ source: "exe", tech: "inno" }), null).silentArgs).toBe("/SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART");
    expect(automaticOf(base({ source: "exe", tech: "" }), null).silentArgs).toBe("");
  });
});

describe("text rules", () => {
  it("exeFolderOf keeps only folders under the three roots", () => {
    expect(exeFolderOf("{ProgramFiles}\\VideoLAN\\VLC")).toBe("{ProgramFiles}\\VideoLAN\\VLC\\");
    expect(exeFolderOf("%ProgramFiles%\\7-Zip")).toBeNull();
    expect(exeFolderOf(undefined)).toBeNull();
  });
  it("nameFromUrl, companyFolder and friendlyPath", () => {
    expect(nameFromUrl("https://dl.example.com/zahras-pos-setup.exe")).toBe("Zahras pos");
    expect(nameFromUrl("https://dl.example.com/setup.exe")).toBe("");
    expect(companyFolder("Acme Software Ltd")).toBe("Acme Software");
    expect(companyFolder("A/B")).toBeNull();
    expect(friendlyPath("{ProgramFiles}\\VideoLAN\\VLC\\vlc.exe")).toBe("Program Files\\VideoLAN\\VLC\\vlc.exe");
  });
  it("wingetFill takes the entry's name and path before winget's", () => {
    const patch = wingetFill({ packageId: "A.B", version: "1", name: "Winget Name", publisher: "Pub", defaultInstallLocation: "{ProgramFiles}\\Other", install }, { key: "k", name: "Entry", exe: "{ProgramFiles}\\E\\e.exe", hue: 40 } as never, base());
    expect(patch).toMatchObject({ name: "Entry", exe: "{ProgramFiles}\\E\\e.exe", hue: 40, publisher: "Pub", version: "1" });
    expect(wingetFill({ packageId: "A.B", version: "1", defaultInstallLocation: "{ProgramFiles}\\Other", install }, undefined, base({ name: "Mine" }))).toMatchObject({ name: "Mine", exe: "{ProgramFiles}\\Other\\" });
  });
});
