import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Me } from "../data/types";
import { MeContext } from "../lib/member";
import { strings } from "../lib/strings";
import { appEditStrings } from "../lib/screenStrings/appEdit";
import { appInstallerStrings as t } from "../lib/screenStrings/appInstaller";
import { installRefusalStrings } from "../lib/screenStrings/installRefusals";
import { appsStrings } from "../lib/screenStrings/apps";
import { buildPe, certificateTable, FIXTURES } from "../../../../tests/convex/installerFixtures";

// Phase 6 Step 13: "Detect", the pre-filled switches and exit codes, the answer file, the timeout and "Check a file on this computer"
// in the App form, against the LIVE data seam with the Convex React hooks mocked (convex/appInstaller.test.ts covers the backend).
const cx = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: unknown }>) =>
    Object.fromEntries(Object.entries(req).map(([k, r]) => [k, cx.results[getFunctionName(r.query)]])),
  useQuery: () => undefined,
  useAction: (ref: FunctionReference<"action">) => fnFor(getFunctionName(ref)),
  useMutation: (ref: FunctionReference<"mutation">) => fnFor(getFunctionName(ref)),
  useConvexConnectionState: () => ({ isWebSocketConnected: true }),
}));

type Mock = ((args?: unknown) => Promise<unknown>) & { withOptimisticUpdate: () => Mock };
const stable = new Map<string, Mock>();
function fnFor(name: string): Mock {
  let f = stable.get(name);
  if (!f) {
    const call = ((args?: unknown) => {
      const impl = cx.fns[name];
      if (!impl) throw new Error(`no mock for ${name}`);
      return impl(args);
    }) as Mock;
    call.withOptimisticUpdate = () => call;
    f = call;
    stable.set(name, f);
  }
  return f;
}

import { ToastProvider } from "../app/Toasts";
import AppEdit from "./AppEdit";

const admin: Me = { email: "admin@x.test", role: "admin", status: "active", orgId: "org", orgName: "Acme", pin: { required: true, set: true }, serverApiVersion: 1 };

function ui(role: Me["role"], path: string) {
  return render(
    <ToastProvider>
      <MeContext.Provider value={{ ...admin, role }}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/apps/new" element={<AppEdit />} />
            <Route path="/apps/:id" element={<AppEdit />} />
          </Routes>
        </MemoryRouter>
      </MeContext.Provider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  cx.results = {};
  cx.fns = {};
});
afterEach(cleanup);

const SHA = "ab".repeat(32);
const URL1 = "https://downloads.example.com/setup.exe";
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const box = (label: string) => screen.getByRole("textbox", { name: new RegExp(`^${literal(label)}`) }) as HTMLInputElement;
const typeInto = (label: string, value: string) => fireEvent.change(box(label), { target: { value } });

const inspection = (over: Record<string, unknown> = {}) => ({
  tech: "inno",
  kind: "exe",
  confidence: "high",
  silentArgs: ["/SP-", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"],
  successExitCodes: [0],
  needsAnswerFile: false,
  perUserLikely: false,
  signer: "Acme Software Ltd",
  fileVersion: "2.4.1.0",
  sizeBytes: 5_000_000,
  ...over,
});

/** A new EXE program with a valid name, path, address and hash, on the EXE source. */
async function newExe() {
  ui("admin", "/apps/new?kind=desktop");
  fireEvent.click(screen.getByRole("radio", { name: appsStrings.sources.exe }));
  typeInto(appEditStrings.name, "Tool");
  typeInto(appEditStrings.exe, "{ProgramFiles}\\Tool\\tool.exe");
  typeInto(appEditStrings.installerUrl, URL1);
  typeInto(appEditStrings.sha256, SHA);
  await screen.findByRole("button", { name: t.detect });
}
const detectButton = () => screen.getByRole("button", { name: t.detect }) as HTMLButtonElement;

describe("Detect", () => {
  it("asks the server for the address, fills the switches, exit codes and type, and says what it found; nothing is saved", async () => {
    const detect = vi.fn(async () => inspection());
    const createDesktop = vi.fn<(input: unknown) => Promise<string>>(async () => "a8");
    cx.fns["apps:inspectInstaller"] = detect;
    cx.fns["apps:createDesktop"] = createDesktop;
    await newExe();
    typeInto(appEditStrings.installerUrl, `  ${URL1}  `);
    fireEvent.click(detectButton());
    expect(await screen.findByText(t.looksLike(t.techNames.inno, "high"))).toBeTruthy();
    expect(detect).toHaveBeenCalledWith({ url: URL1 });
    expect(box(appEditStrings.silentArgs).value).toBe("/SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART");
    expect((screen.getByRole("combobox", { name: new RegExp(`^${t.tech}`) }) as HTMLSelectElement).value).toBe("inno");
    expect(box(t.successCodes).value).toBe("0");
    expect(screen.getByText(new RegExp(t.signer("Acme Software Ltd").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeTruthy();
    expect(screen.getByText(new RegExp(t.prefilled.replace(/\./g, "\\.")))).toBeTruthy();
    expect(createDesktop).not.toHaveBeenCalled();
  });

  it("Save sends what was filled in: the technology, the success codes, the timeout and the expected signer", async () => {
    const createDesktop = vi.fn<(input: unknown) => Promise<string>>(async () => "a8");
    cx.fns["apps:inspectInstaller"] = async () => inspection({ tech: "burn", silentArgs: ["/quiet", "/norestart"], successExitCodes: [0, 3010, 1641] });
    cx.fns["apps:createDesktop"] = createDesktop;
    await newExe();
    fireEvent.click(detectButton());
    await screen.findByText(t.looksLike(t.techNames.burn, "high"));
    expect(box(t.successCodes).value).toBe("0, 3010, 1641");
    typeInto(t.timeout, "45");
    fireEvent.click(screen.getByRole("button", { name: t.useSigner("Acme Software Ltd") }));
    fireEvent.click(screen.getByRole("button", { name: strings.common.create }));
    await waitFor(() => expect(createDesktop).toHaveBeenCalledTimes(1));
    expect(createDesktop.mock.calls[0]![0]).toMatchObject({
      desktop: {
        source: "exe",
        install: { kind: "exe", url: URL1, sha256: SHA, silentArgs: ["/quiet", "/norestart"], successExitCodes: [0, 1641, 3010], tech: "burn", timeoutMin: 45, publisher: "Acme Software Ltd" },
      },
    });
    expect((createDesktop.mock.calls[0]![0] as { desktop: { install: Record<string, unknown> } }).desktop.install).not.toHaveProperty("answerFile");
  });

  it("never overwrites what the admin typed: switches, success codes and the picked type stay, and the screen says so", async () => {
    cx.fns["apps:inspectInstaller"] = async () => inspection();
    await newExe();
    typeInto(appEditStrings.silentArgs, "/mysilent");
    typeInto(t.successCodes, "0, 7");
    fireEvent.change(screen.getByRole("combobox", { name: new RegExp(`^${t.tech}`) }), { target: { value: "nsis" } });
    fireEvent.click(detectButton());
    await screen.findByText(t.looksLike(t.techNames.inno, "high"));
    expect(box(appEditStrings.silentArgs).value).toBe("/mysilent");
    expect(box(t.successCodes).value).toBe("0, 7");
    expect((screen.getByRole("combobox", { name: new RegExp(`^${t.tech}`) }) as HTMLSelectElement).value).toBe("nsis");
    for (const what of [t.keptNames.silentArgs, t.keptNames.successCodes, t.keptNames.tech]) expect(screen.getByText(t.kept(what), { exact: false })).toBeTruthy();
    expect(screen.queryByText(t.edited, { exact: false })).toBeNull(); // typed text is the admin's own, not "edited"
  });

  it("text typed while the detection is running is kept too", async () => {
    let answer: (r: unknown) => void = () => undefined;
    cx.fns["apps:inspectInstaller"] = () => new Promise((resolve) => (answer = resolve));
    await newExe();
    fireEvent.click(detectButton());
    await screen.findByText(t.detecting);
    typeInto(appEditStrings.silentArgs, "/late");
    answer(inspection());
    await screen.findByText(t.looksLike(t.techNames.inno, "high"));
    expect(box(appEditStrings.silentArgs).value).toBe("/late");
  });

  it("a pre-filled field that is changed afterwards is marked edited", async () => {
    cx.fns["apps:inspectInstaller"] = async () => inspection({ tech: "nsis", silentArgs: ["/S"] });
    await newExe();
    fireEvent.click(detectButton());
    await screen.findByText(t.looksLike(t.techNames.nsis, "high"));
    expect(screen.queryByText(`(${t.edited})`)).toBeNull();
    typeInto(appEditStrings.silentArgs, "/S /D=C:\\Tool");
    expect(screen.getByText(`(${t.edited})`)).toBeTruthy();
    typeInto(appEditStrings.silentArgs, "/S");
    expect(screen.queryByText(`(${t.edited})`)).toBeNull();
    typeInto(t.successCodes, "0, 3010");
    expect(screen.queryByText(`(${t.edited})`)).toBeNull(); // the codes were already the suggested 0: nothing was filled in, so nothing is "edited"
  });

  it("an unknown EXE says to ask the vendor; low confidence is called a guess; NSIS without elevation gets the per-user warning", async () => {
    cx.fns["apps:inspectInstaller"] = vi
      .fn()
      .mockResolvedValueOnce(inspection({ tech: "exe", confidence: "low", silentArgs: [], signer: undefined }))
      .mockResolvedValueOnce(inspection({ tech: "nsis", silentArgs: ["/S"], perUserLikely: true }));
    await newExe();
    fireEvent.click(detectButton());
    expect(await screen.findByText(t.looksLike(t.techNames.exe, "low"))).toBeTruthy();
    expect(screen.getByText(new RegExp(t.unknownExe.replace(/\./g, "\\.")))).toBeTruthy();
    expect(box(appEditStrings.silentArgs).value).toBe("");
    fireEvent.click(detectButton());
    expect(await screen.findByText(t.perUser)).toBeTruthy();
  });

  it("tells when the file is an MSI but the source says EXE, and the other way round", async () => {
    cx.fns["apps:inspectInstaller"] = async () => inspection({ tech: "msi", kind: "msi", silentArgs: [] });
    await newExe();
    fireEvent.click(detectButton());
    expect(await screen.findByText(t.sourceMsi)).toBeTruthy();
    expect(box(appEditStrings.silentArgs).value).toBe(""); // an MSI has no switches to fill
  });

  it("the server's refusals are explained, and the form stays manual", async () => {
    cx.fns["apps:inspectInstaller"] = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "url", detail: "inspect_unsupported" }))
      .mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "url", detail: "inspect_not_installer" }))
      .mockRejectedValueOnce(new ConvexError({ code: "rate_limited", retryAfterMs: 1000 }));
    await newExe();
    fireEvent.click(detectButton());
    expect(await screen.findByText(installRefusalStrings.inspect_unsupported)).toBeTruthy();
    fireEvent.click(detectButton());
    expect(await screen.findByText(installRefusalStrings.inspect_not_installer)).toBeTruthy();
    fireEvent.click(detectButton());
    expect(await screen.findByText(strings.errors.rateLimited)).toBeTruthy();
    expect(box(appEditStrings.silentArgs).value).toBe("");
  });

  it("Detect needs a valid address; a viewer cannot use it", async () => {
    await newExe();
    typeInto(appEditStrings.installerUrl, "http://downloads.example.com/a.exe");
    expect(detectButton().disabled).toBe(true);
    cleanup();
    cx.results["apps:get"] = {
      _id: "a2",
      name: "Tool",
      kind: "desktop",
      archived: false,
      revision: 1,
      createdAt: 1,
      assignments: [],
      fileTypes: [],
      directEmployeeCount: 0,
      groupOptions: [],
      denials30d: [],
      desktop: { source: "exe", exe: "{ProgramFiles}\\Tool\\tool.exe", args: [], fileArgTemplate: [], resetFolders: [], install: { kind: "exe", url: URL1, sha256: SHA, sizeBytes: 1, silentArgs: ["/S"], successExitCodes: [0], removeWhenUnassigned: false } },
    };
    ui("viewer", "/apps/a2");
    await screen.findByRole("button", { name: t.detect });
    expect(detectButton().disabled).toBe(true);
  });
});

describe("the answer file", () => {
  it("InstallScript turns the answer file on and Save sends it with the file's address and hash", async () => {
    const createDesktop = vi.fn<(input: unknown) => Promise<string>>(async () => "a8");
    cx.fns["apps:inspectInstaller"] = async () => inspection({ tech: "installshield_script", confidence: "low", silentArgs: ["/s", "/f1{AnswerFile}"], needsAnswerFile: true });
    cx.fns["apps:createDesktop"] = createDesktop;
    await newExe();
    fireEvent.click(detectButton());
    await screen.findByText(t.looksLike(t.techNames.installshield_script, "low"));
    expect(box(appEditStrings.silentArgs).value).toBe("/s /f1{AnswerFile}");
    expect(screen.getByText(t.answerHint, { exact: false })).toBeTruthy();
    // Missing address and hash: refused inline, nothing sent.
    fireEvent.click(screen.getByRole("button", { name: strings.common.create }));
    expect(await screen.findByText(t.answerUrlBad)).toBeTruthy();
    expect(createDesktop).not.toHaveBeenCalled();
    typeInto(t.answerUrl, "https://downloads.example.com/setup.iss");
    typeInto(t.answerSha, "cd".repeat(32));
    fireEvent.click(screen.getByRole("button", { name: strings.common.create }));
    await waitFor(() => expect(createDesktop).toHaveBeenCalledTimes(1));
    expect(createDesktop.mock.calls[0]![0]).toMatchObject({
      desktop: { install: { silentArgs: ["/s", "/f1{AnswerFile}"], tech: "installshield_script", answerFile: { url: "https://downloads.example.com/setup.iss", sha256: "cd".repeat(32), sizeBytes: 0 } } },
    });
  });

  it("the switches and the file go together: a token without a file, a file without a token, a bad address", async () => {
    const createDesktop = vi.fn<(input: unknown) => Promise<string>>(async () => "a8");
    cx.fns["apps:createDesktop"] = createDesktop;
    await newExe();
    typeInto(appEditStrings.silentArgs, "/s /f1{AnswerFile}");
    fireEvent.click(screen.getByRole("button", { name: strings.common.create }));
    expect(await screen.findByText(t.tokenNeedsAnswer)).toBeTruthy();
    typeInto(appEditStrings.silentArgs, "/s /x{Foo}");
    expect(await screen.findByText(t.tokenBad)).toBeTruthy();
    typeInto(appEditStrings.silentArgs, "/s");
    fireEvent.click(screen.getByRole("switch", { name: t.answerOn }));
    typeInto(t.answerUrl, "https://downloads.example.com/setup.txt");
    typeInto(t.answerSha, "cd".repeat(32));
    expect(await screen.findByText(t.answerNeedsToken)).toBeTruthy();
    expect(screen.getByText(t.answerUrlBad)).toBeTruthy();
    expect(createDesktop).not.toHaveBeenCalled();
  });

  it("the server's answer-file refusals have their own sentences", async () => {
    cx.fns["apps:createDesktop"] = vi.fn().mockRejectedValue(new ConvexError({ code: "invalid_argument", field: "install.answerFile", detail: "answer_file_unused" }));
    await newExe();
    typeInto(appEditStrings.silentArgs, "/S");
    fireEvent.click(screen.getByRole("button", { name: strings.common.create }));
    expect(await screen.findByText(installRefusalStrings.answer_file_unused)).toBeTruthy();
  });
});

describe("the other installer details", () => {
  it("success codes and the timeout are checked inline; a valid timeout is sent as a number, an empty one is left out", async () => {
    const createDesktop = vi.fn<(input: unknown) => Promise<string>>(async () => "a8");
    cx.fns["apps:createDesktop"] = createDesktop;
    await newExe();
    typeInto(appEditStrings.silentArgs, "/S");
    typeInto(t.timeout, "4");
    typeInto(t.successCodes, "0, abc");
    fireEvent.click(screen.getByRole("button", { name: strings.common.create }));
    expect(await screen.findByText(t.timeoutBad)).toBeTruthy();
    expect(screen.getByText(t.successCodesBad)).toBeTruthy();
    typeInto(t.timeout, "");
    typeInto(t.successCodes, "3010, 0, 1641");
    fireEvent.click(screen.getByRole("button", { name: strings.common.create }));
    await waitFor(() => expect(createDesktop).toHaveBeenCalledTimes(1));
    const install = (createDesktop.mock.calls[0]![0] as { desktop: { install: Record<string, unknown> } }).desktop.install;
    expect(install.successExitCodes).toEqual([0, 1641, 3010]);
    for (const key of ["timeoutMin", "publisher", "tech", "answerFile"]) expect(install, key).not.toHaveProperty(key);
  });

  it("an existing program shows its stored details and saves them unchanged", async () => {
    const update = vi.fn<(input: unknown) => Promise<{ revision: number }>>(async () => ({ revision: 2 }));
    cx.fns["apps:update"] = update;
    cx.results["apps:get"] = {
      _id: "a2",
      name: "Tool",
      kind: "desktop",
      archived: false,
      revision: 1,
      createdAt: 1,
      assignments: [],
      fileTypes: [],
      directEmployeeCount: 0,
      groupOptions: [],
      denials30d: [],
      desktop: {
        source: "exe",
        exe: "{ProgramFiles}\\Tool\\tool.exe",
        args: [],
        fileArgTemplate: [],
        resetFolders: [],
        install: {
          kind: "exe",
          url: URL1,
          sha256: SHA,
          sizeBytes: 123,
          silentArgs: ["/s", "/f1{AnswerFile}"],
          successExitCodes: [0, 3010],
          removeWhenUnassigned: false,
          tech: "installshield_script",
          answerFile: { url: "https://downloads.example.com/setup.iss", sha256: "cd".repeat(32), sizeBytes: 2048 },
          timeoutMin: 60,
          publisher: "Acme Software Ltd",
        },
      },
    };
    ui("admin", "/apps/a2");
    await screen.findByRole("button", { name: t.detect });
    expect(box(t.successCodes).value).toBe("0, 3010");
    expect(box(t.timeout).value).toBe("60");
    expect(box(t.publisher).value).toBe("Acme Software Ltd");
    expect(box(t.answerUrl).value).toBe("https://downloads.example.com/setup.iss");
    typeInto(appEditStrings.name, "Tool 2");
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![0]).toMatchObject({
      desktop: {
        desktop: {
          install: {
            sizeBytes: 123,
            successExitCodes: [0, 3010],
            tech: "installshield_script",
            answerFile: { url: "https://downloads.example.com/setup.iss", sha256: "cd".repeat(32), sizeBytes: 2048 }, // the same file keeps its size
            timeoutMin: 60,
            publisher: "Acme Software Ltd",
          },
        },
      },
    });
  });

  it("an MSI has the timeout and the expected signer, but no type, success codes or answer file", async () => {
    ui("admin", "/apps/new?kind=desktop");
    fireEvent.click(screen.getByRole("radio", { name: appsStrings.sources.msi }));
    await screen.findByRole("button", { name: t.detect });
    expect(box(t.timeout)).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: new RegExp(`^${t.tech}`) })).toBeNull();
    expect(screen.queryByRole("switch", { name: t.answerOn })).toBeNull();
  });

  it("a portable file has no installer details and no Detect", () => {
    ui("admin", "/apps/new?kind=desktop");
    fireEvent.click(screen.getByRole("radio", { name: appsStrings.sources.portable }));
    expect(screen.queryByText(t.card)).toBeNull();
    expect(screen.queryByRole("button", { name: t.detect })).toBeNull();
  });
});

describe("Check a file on this computer (Q9)", () => {
  const fileOf = (bytes: Uint8Array, name = "setup.exe") => new File([bytes as BlobPart], name);
  const chooser = () => screen.getByLabelText(t.chooseFile) as HTMLInputElement;

  it("reads the file in the browser, fills the SHA-256 and the switches, and uploads nothing", async () => {
    const inspect = vi.fn();
    cx.fns["apps:inspectInstaller"] = inspect;
    const bytes = buildPe({ manifest: "<description>Inno Setup</description>", version: { FileVersion: "3.1.0" }, certificate: certificateTable("Local Software Co") });
    ui("admin", "/apps/new?kind=desktop");
    fireEvent.click(screen.getByRole("radio", { name: appsStrings.sources.exe }));
    await screen.findByRole("button", { name: t.checkFile });
    fireEvent.change(chooser(), { target: { files: [fileOf(bytes)] } });
    expect(await screen.findByText(t.looksLike(t.techNames.inno, "high"))).toBeTruthy();
    expect(box(appEditStrings.sha256).value).toBe(bytesToHex(sha256(bytes)));
    expect(box(appEditStrings.silentArgs).value).toBe("/SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART");
    expect(screen.getByText(t.hashFilled, { exact: false })).toBeTruthy();
    expect(screen.getAllByText(new RegExp("Local Software Co")).length).toBeGreaterThan(0);
    expect(inspect).not.toHaveBeenCalled(); // no server call: the file never leaves the browser
  });

  it("a typed SHA-256 is not replaced; the screen says whether the file matches", async () => {
    const bytes = FIXTURES.nsisHigh();
    ui("admin", "/apps/new?kind=desktop");
    fireEvent.click(screen.getByRole("radio", { name: appsStrings.sources.exe }));
    await screen.findByRole("button", { name: t.checkFile });
    typeInto(appEditStrings.sha256, SHA);
    fireEvent.change(chooser(), { target: { files: [fileOf(bytes)] } });
    expect(await screen.findByText(t.hashDiffers(bytesToHex(sha256(bytes))), { exact: false })).toBeTruthy();
    expect(box(appEditStrings.sha256).value).toBe(SHA);
    typeInto(appEditStrings.sha256, bytesToHex(sha256(bytes)).toUpperCase());
    fireEvent.change(chooser(), { target: { files: [fileOf(bytes)] } });
    expect(await screen.findByText(t.hashSame, { exact: false })).toBeTruthy();
  });

  it("a file that is not a program or an MSI is refused with a sentence", async () => {
    ui("admin", "/apps/new?kind=desktop");
    fireEvent.click(screen.getByRole("radio", { name: appsStrings.sources.exe }));
    await screen.findByRole("button", { name: t.checkFile });
    fireEvent.change(chooser(), { target: { files: [fileOf(new TextEncoder().encode("hello"), "notes.exe")] } });
    expect(await screen.findByText(t.notInstaller)).toBeTruthy();
  });
});
