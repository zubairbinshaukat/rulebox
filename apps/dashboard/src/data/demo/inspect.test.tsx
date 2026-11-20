import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { demoApi } from "./hooks";
import { resetDemo } from "./store";
import { AppError } from "../../lib/errors";

// The demo twin of `apps:inspectInstaller` (Phase 6 Step 13): a technology from words in the address, no network.
describe("demo useInspectInstaller", () => {
  const run = (url: string) => renderHook(() => demoApi.useInspectInstaller()).result.current({ url });

  it("answers the plan 4.7 switches for the technology the address names", async () => {
    resetDemo();
    expect(await run("https://dl.example.com/tool-inno-setup.exe")).toMatchObject({ tech: "inno", kind: "exe", silentArgs: ["/SP-", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], successExitCodes: [0] });
    expect(await run("https://dl.example.com/tool-burn.exe")).toMatchObject({ tech: "burn", successExitCodes: [0, 3010, 1641] });
    expect(await run("https://dl.example.com/tool-script.exe")).toMatchObject({ tech: "installshield_script", needsAnswerFile: true, silentArgs: ["/s", "/f1{AnswerFile}"] });
    expect(await run("https://dl.example.com/tool.msi")).toMatchObject({ tech: "msi", kind: "msi" });
    expect(await run("https://dl.example.com/tool.exe")).toMatchObject({ tech: "exe", confidence: "low", silentArgs: [] });
  });

  it("refuses like the server: a bad address, no Range support, not an installer, a host that fails", async () => {
    resetDemo();
    const refusal = async (url: string) => {
      try {
        await run(url);
      } catch (e) {
        return e instanceof AppError ? { code: e.code, detail: e.detail } : e;
      }
      return null;
    };
    expect(await refusal("http://dl.example.com/a.exe")).toMatchObject({ code: "invalid_argument" });
    expect(await refusal("https://dl.example.com/norange.exe")).toEqual({ code: "invalid_argument", detail: "inspect_unsupported" });
    expect(await refusal("https://dl.example.com/files.zip")).toEqual({ code: "invalid_argument", detail: "inspect_not_installer" });
    expect(await refusal("https://fail.example.com/a.exe")).toEqual({ code: "invalid_argument", detail: "inspect_failed" });
  });
});
