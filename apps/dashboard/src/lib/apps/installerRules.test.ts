import { describe, expect, it } from "vitest";
import type { InstallerInspection } from "../../data/types";
import { answerUrlProblem, formatExitCodes, parseExitCodes, silentArgTokenProblem, timeoutProblem } from "./installerRules";
import { prefillFrom } from "./installerPrefill";
import { joinArgs } from "../validate";

const found = (over: Partial<InstallerInspection> = {}): InstallerInspection => ({
  tech: "inno",
  kind: "exe",
  confidence: "high",
  silentArgs: ["/SP-", "/VERYSILENT"],
  successExitCodes: [0, 3010],
  needsAnswerFile: false,
  perUserLikely: false,
  ...over,
});
const blank = { silentArgs: "", successCodes: "0", tech: "" as const, answerOn: false };

describe("installer rules (mirror convex/lib/appRules.ts)", () => {
  it("success codes: whole numbers, 0 always counts, sorted, at most 16", () => {
    expect(parseExitCodes("")).toEqual([0]);
    expect(parseExitCodes("3010, 1641 0;7")).toEqual([0, 7, 1641, 3010]);
    expect(parseExitCodes("-1")).toEqual([-1, 0]);
    for (const bad of ["a", "1.5", "0,x", "99999999999", Array.from({ length: 17 }, (_, i) => i + 1).join(",")]) expect(parseExitCodes(bad), bad).toBeNull();
    expect(formatExitCodes([0, 3010, 3010])).toBe("0, 3010");
  });

  it("timeout: empty, or a whole number of minutes from 5 to 120", () => {
    for (const ok of ["", " ", "5", "120", "30"]) expect(timeoutProblem(ok), ok).toBe(false);
    for (const bad of ["4", "121", "0", "-5", "30.5", "abc", "1e2"]) expect(timeoutProblem(bad), bad).toBe(true);
  });

  it("answer file address: https and a .iss path (a query string does not hide the extension)", () => {
    expect(answerUrlProblem("https://dl.example.com/a.iss")).toBeNull();
    expect(answerUrlProblem("https://dl.example.com/A.ISS?x=1")).toBeNull();
    expect(answerUrlProblem("https://dl.example.com/a.txt")).toBe("iss");
    expect(answerUrlProblem("https://dl.example.com/dl?f=a.iss")).toBe("iss");
    expect(answerUrlProblem("http://dl.example.com/a.iss")).toBe("https");
    expect(answerUrlProblem("nonsense")).toBe("https");
  });

  it("tokens in the switches: only {AnswerFile} and {LogFile}, whole", () => {
    expect(silentArgTokenProblem(["/s", "/f1{AnswerFile}", "/f2{LogFile}"])).toBe(false);
    for (const bad of ["{file}", "{answerfile}", "{AnswerFile", "}", "/x{Foo}", "{{AnswerFile}}"]) expect(silentArgTokenProblem([bad]), bad).toBe(true);
  });
});

describe("prefillFrom: a detection never overwrites typed text", () => {
  it("fills empty fields", () => {
    const r = prefillFrom(blank, found(), joinArgs);
    expect(r.patch).toEqual({ silentArgs: "/SP- /VERYSILENT", successCodes: "0, 3010", tech: "inno" });
    expect(r.kept).toEqual([]);
    expect(r.prefilled).toEqual({ silentArgs: "/SP- /VERYSILENT", successCodes: "0, 3010" });
  });

  it("keeps what was typed and lists it; the same text typed is not a difference", () => {
    const r = prefillFrom({ silentArgs: "/mine", successCodes: "0, 7", tech: "nsis", answerOn: false }, found(), joinArgs);
    expect(r.patch).toEqual({});
    expect(r.kept).toEqual(["silentArgs", "successCodes", "tech"]);
    expect(r.prefilled).toEqual({});
    const same = prefillFrom({ silentArgs: "/SP- /VERYSILENT", successCodes: "0, 3010", tech: "inno", answerOn: false }, found(), joinArgs);
    expect(same.patch).toEqual({});
    expect(same.kept).toEqual([]);
  });

  it("an MSI fills no switches; a plain EXE sets no type and suggests nothing", () => {
    const msi = prefillFrom(blank, found({ tech: "msi", kind: "msi", silentArgs: [], successExitCodes: [0] }), joinArgs);
    expect(msi.patch).toEqual({});
    const plain = prefillFrom(blank, found({ tech: "exe", silentArgs: [], successExitCodes: [0] }), joinArgs);
    expect(plain.patch).toEqual({});
    expect(plain.prefilled).toEqual({});
  });

  it("InstallScript turns the answer file on", () => {
    const r = prefillFrom(blank, found({ tech: "installshield_script", silentArgs: ["/s", "/f1{AnswerFile}"], needsAnswerFile: true }), joinArgs);
    expect(r.patch).toMatchObject({ silentArgs: "/s /f1{AnswerFile}", tech: "installshield_script", answerOn: true });
  });
});
