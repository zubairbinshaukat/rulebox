import { describe, expect, it } from "vitest";
import { appAddStrings } from "../screenStrings/appAdd";
import { COMMON_SWITCHES, silentStatus, switchesEdited, wingetRefusalKind, type SilentInput } from "./silentMode";

const t = appAddStrings.silent;
const base: SilentInput = { source: "exe", kind: "exe", tech: "", silentArgs: "", autoArgs: "" };
const status = (over: Partial<SilentInput>) => silentStatus({ ...base, ...over });

describe("silentStatus: every row of the plan's table (section 5)", () => {
  it("MSI (detected, or winget msi/wix): silent, no switches to show", () => {
    for (const over of [{ source: "msi", kind: "msi" }, { source: "winget", kind: "msi" }, { source: "exe", kind: "msi" }] as Partial<SilentInput>[]) {
      const s = status({ ...over, silentArgs: "", autoArgs: "" });
      expect(s).toMatchObject({ state: "silent", tone: "success", label: t.silent, blocksAdd: false, perUser: false });
      expect(s.info).toBe(t.info.msi);
    }
  });

  it("winget exe/inno/nullsoft/burn with switches (the manifest's or the defaults): silent, the winget text", () => {
    const s = status({ source: "winget", kind: "exe", silentArgs: "/S /allusers", autoArgs: "/S /allusers" });
    expect(s).toMatchObject({ state: "silent", tone: "success", label: t.silent, blocksAdd: false });
    expect(s.info).toContain(t.info.winget);
    // Not resolved yet (nothing filled in): never "unknown", never blocking.
    expect(status({ source: "winget", kind: undefined })).toMatchObject({ state: "silent", blocksAdd: false });
  });

  it("winget refusals map to a plain reason (msix, user-only, no silent install)", () => {
    expect(wingetRefusalKind("it only offers per-user, ARM or non-installer packages (no machine-wide x64 msi or exe)")).toBe("msixOrUser");
    expect(wingetRefusalKind("this package has no silent install")).toBe("noSilent");
    expect(wingetRefusalKind("its silent install switches are not usable (too many, too long or with control characters)")).toBe("noSilent");
    expect(wingetRefusalKind("package not found (ids are case-sensitive, like VideoLAN.VLC)")).toBe("other");
    expect(wingetRefusalKind(undefined)).toBe("other");
  });

  it("NSIS (high or medium): /S, silent", () => {
    for (const confidence of ["high", "medium"] as const) {
      const s = status({ tech: "nsis", confidence, silentArgs: "/S", autoArgs: "/S" });
      expect(s).toMatchObject({ state: "silent", tone: "success", label: t.silent, perUser: false });
      expect(s.info).toContain(t.info.nsis);
    }
  });

  it("NSIS that asks for no elevation: silent plus the per-user warning", () => {
    const s = status({ tech: "nsis", confidence: "medium", perUserLikely: true, silentArgs: "/S", autoArgs: "/S" });
    expect(s).toMatchObject({ state: "silent", label: t.silent, perUser: true, blocksAdd: false });
  });

  it("Inno Setup (high or medium): silent", () => {
    const args = "/SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART";
    const s = status({ tech: "inno", confidence: "high", silentArgs: args, autoArgs: args });
    expect(s).toMatchObject({ state: "silent", tone: "success" });
    expect(s.info).toContain(t.info.inno);
  });

  it("WiX Burn: high is silent, low is a best guess", () => {
    const args = "/quiet /norestart";
    const high = status({ tech: "burn", confidence: "high", silentArgs: args, autoArgs: args });
    expect(high).toMatchObject({ state: "silent", label: t.silent });
    expect(high.info).toContain(t.info.burn);
    const low = status({ tech: "burn", confidence: "low", silentArgs: args, autoArgs: args });
    expect(low).toMatchObject({ state: "guess", tone: "warning", label: t.guess, info: t.info.guess, blocksAdd: false });
  });

  it("InstallShield with MSI inside and Advanced Installer (low): best guess, never blocking", () => {
    expect(status({ tech: "installshield_msi", confidence: "low", silentArgs: "/s /v/qn", autoArgs: "/s /v/qn" })).toMatchObject({ state: "guess", tone: "warning", blocksAdd: false });
    expect(status({ tech: "advanced_installer", confidence: "low", silentArgs: "/exenoui /qn /norestart", autoArgs: "/exenoui /qn /norestart" })).toMatchObject({ state: "guess", tone: "warning" });
  });

  it("InstallShield InstallScript: blocks Add until the answer file is given", () => {
    const args = "/s /f1{AnswerFile}";
    const waiting = status({ tech: "installshield_script", confidence: "low", needsAnswerFile: true, silentArgs: args, autoArgs: args });
    expect(waiting).toMatchObject({ state: "needs_answer", tone: "warning", label: t.needsAnswer, blocksAdd: true });
    const noTech = status({ needsAnswerFile: true, silentArgs: args, autoArgs: args });
    expect(noTech).toMatchObject({ state: "needs_answer", blocksAdd: true });
    const given = status({ tech: "installshield_script", needsAnswerFile: true, answerReady: true, silentArgs: args, autoArgs: args });
    expect(given).toMatchObject({ state: "silent", blocksAdd: false });
  });

  it("a plain EXE nobody recognised: unknown, Add blocked, never a guessed switch", () => {
    const s = status({ confidence: "low" });
    expect(s).toMatchObject({ state: "unknown", tone: "warning", label: t.unknownTitle, info: t.info.unknown, blocksAdd: true });
  });

  it("a plain EXE with switches the admin typed: own switches", () => {
    const s = status({ silentArgs: "/quiet", autoArgs: "" });
    expect(s).toMatchObject({ state: "own", tone: "neutral", label: t.own, info: t.info.own, blocksAdd: false });
  });

  it("the admin changed the automatic switches: own; typing the automatic ones back (spaces aside) restores the line", () => {
    const auto = "/S";
    expect(status({ tech: "nsis", confidence: "high", silentArgs: "/S /D=C:\\x", autoArgs: auto }).state).toBe("own");
    expect(status({ tech: "nsis", confidence: "high", silentArgs: "  /S ", autoArgs: auto }).state).toBe("silent");
    expect(switchesEdited("/S /D=C:\\x", auto)).toBe(true);
    expect(switchesEdited("/S", auto)).toBe(false);
    expect(switchesEdited("", auto)).toBe(false);
  });

  it("an answer file does not hide own switches", () => {
    expect(status({ tech: "installshield_script", needsAnswerFile: true, answerReady: true, silentArgs: "/s /f1{AnswerFile} /x", autoArgs: "/s /f1{AnswerFile}" }).state).toBe("own");
  });

  it("portable and already-on-the-PCs need no install", () => {
    expect(status({ source: "portable", kind: "portable" })).toMatchObject({ state: "none", tone: "neutral", label: t.none, info: t.info.portable, blocksAdd: false });
    expect(status({ source: "preinstalled", kind: undefined })).toMatchObject({ state: "preinstalled", tone: "neutral", label: t.preinstalled, info: t.info.preinstalled, blocksAdd: false });
  });

  it("only unknown and needs_answer block Add", () => {
    const blocking = new Set(["unknown", "needs_answer"]);
    const cases: Partial<SilentInput>[] = [
      { source: "msi", kind: "msi" },
      { source: "winget", kind: "exe", silentArgs: "/S", autoArgs: "/S" },
      { tech: "inno", silentArgs: "/VERYSILENT", autoArgs: "/VERYSILENT" },
      { silentArgs: "/x" },
      { silentArgs: "" },
      { needsAnswerFile: true, silentArgs: "/s /f1{AnswerFile}", autoArgs: "/s /f1{AnswerFile}" },
      { source: "portable", kind: "portable" },
      { source: "preinstalled" },
    ];
    for (const c of cases) {
      const s = status(c);
      expect(s.blocksAdd, JSON.stringify(c)).toBe(blocking.has(s.state));
    }
  });

  it("offers the common switches for the unknown case", () => {
    expect(COMMON_SWITCHES).toEqual(["/S", "/silent", "/quiet", "/VERYSILENT"]);
  });
});
