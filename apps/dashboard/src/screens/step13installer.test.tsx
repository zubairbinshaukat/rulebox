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
import { appAddStrings as a } from "../lib/screenStrings/appAdd";
import { settleApp } from "./apps/testKit";
import { installRefusalStrings } from "../lib/screenStrings/installRefusals";
import { appsStrings } from "../lib/screenStrings/apps";
import { buildPe, certificateTable, FIXTURES } from "../../../../tests/convex/installerFixtures";

// The installer from a link (UI pass, add-app plan sections 3.1 and 5): the automatic check (`apps:fingerprintInstaller`), the silent mode picked by
// itself, the "Installs silently" lines, the install command under Advanced and the file on this computer, against the LIVE data seam with the Convex
// React hooks mocked (convex/appInstaller.test.ts and convex/installerFingerprint.test.ts cover the backend).
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

async function ui(role: Me["role"], path: string) {
  const result = render(
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
  await settleApp();
  return result;
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

const fingerprint = (over: Record<string, unknown> = {}) => ({ sha256: SHA, sizeBytes: 5_000_000, inspection: inspection(), ...over });
const linkBox = () => screen.getByPlaceholderText(a.installer.linkPlaceholder) as HTMLInputElement;
const addButton = (name: string) => screen.getByRole("button", { name: a.review.add(name) }) as HTMLButtonElement;

/** The own-installer page with a link typed and checked by leaving the box. */
async function checked(answer: ReturnType<typeof fingerprint> | (() => Promise<unknown>), link = URL1) {
  cx.fns["apps:fingerprintInstaller"] = typeof answer === "function" ? answer : async () => answer;
  await ui("admin", "/apps/new?kind=desktop&source=installer");
  fireEvent.change(linkBox(), { target: { value: link } });
  fireEvent.blur(linkBox());
}
const openAdvanced = () => fireEvent.click(screen.getByText(a.advanced));

describe("the installer link is checked by itself", () => {
  it("a link is downloaded and read once; the type, switches and name are filled in; Add sends them with the size and the hash", async () => {
    const check = vi.fn(async () => fingerprint({ inspection: inspection({ productName: "Zahras POS" }) }));
    const createDesktop = vi.fn<(input: unknown) => Promise<string>>(async () => "a8");
    cx.fns["apps:createDesktop"] = createDesktop;
    await checked(check);
    expect(await screen.findByText(a.installer.found("Zahras POS", "2.4.1.0", a.silent.techName.inno, "4.8 MB"))).toBeTruthy();
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith({ url: URL1 });
    // leaving the box again does not download it again
    fireEvent.blur(linkBox());
    expect(check).toHaveBeenCalledTimes(1);
    expect(screen.getByText(a.silent.silent)).toBeTruthy();
    expect(screen.getByText(a.lines.checked)).toBeTruthy();
    expect(box(appEditStrings.name).value).toBe("Zahras POS");
    // The program to start is asked for, as a folder and the rest of the path.
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(`^${a.program.label}`) }), { target: { value: "Zahras\\pos.exe" } });
    fireEvent.click(addButton("Zahras POS"));
    await waitFor(() => expect(createDesktop).toHaveBeenCalledTimes(1));
    expect(createDesktop.mock.calls[0]![0]).toMatchObject({
      name: "Zahras POS",
      desktop: {
        source: "exe",
        exe: "{ProgramFiles}\\Zahras\\pos.exe",
        install: { kind: "exe", url: URL1, sha256: SHA, sizeBytes: 5_000_000, silentArgs: ["/SP-", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], successExitCodes: [0], tech: "inno" },
      },
    });
  });

  it("the install command is under Advanced: switches, type and success codes are there, filled in, never asked up front", async () => {
    await checked(fingerprint({ inspection: inspection({ tech: "burn", silentArgs: ["/quiet", "/norestart"], successExitCodes: [0, 3010, 1641] }) }));
    await screen.findByText(a.silent.silent);
    expect(screen.getByText(a.advanced).closest("details")!.open).toBe(false);
    openAdvanced();
    expect(box(t.silentArgs).value).toBe("/quiet /norestart");
    expect(box(t.successCodes).value).toBe("0, 3010, 1641");
    expect(screen.getByText(t.techOptions.burn)).toBeTruthy();
  });

  it("own switches are theirs: the line says so, '(edited)' shows and 'Use automatic' brings the computed ones back", async () => {
    await checked(fingerprint());
    await screen.findByText(a.silent.silent);
    openAdvanced();
    typeInto(t.silentArgs, "/VERYSILENT /DIR=x");
    expect(screen.getByText(a.silent.own)).toBeTruthy();
    expect(screen.getByText(`(${t.edited})`, { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.useAutomatic }));
    expect(box(t.silentArgs).value).toBe("/SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART");
    expect(screen.getByText(a.silent.silent)).toBeTruthy();
  });

  it("a plain program nobody recognised blocks Add with a reason; a common switch unblocks it (and is the admin's own)", async () => {
    await checked(fingerprint({ inspection: inspection({ tech: "exe", confidence: "low", silentArgs: [], signer: undefined, productName: "Setup" }) }));
    expect(await screen.findByText(a.silent.unknownTitle)).toBeTruthy();
    expect(screen.getByText(a.review.blocked.unknown)).toBeTruthy();
    expect(addButton("Setup").disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "/S" }));
    expect(screen.getByText(a.silent.own)).toBeTruthy();
    expect(screen.queryByText(a.review.blocked.unknown)).toBeNull();
  });

  it("a low-confidence type is called a best guess, and NSIS without elevation carries the per-user warning", async () => {
    await checked(fingerprint({ inspection: inspection({ tech: "advanced_installer", confidence: "low", silentArgs: ["/exenoui", "/qn", "/norestart"] }) }));
    expect(await screen.findByText(a.silent.guess)).toBeTruthy();
    expect(screen.getByText(a.silent.guessWarning)).toBeTruthy();
    cleanup();
    await checked(fingerprint({ inspection: inspection({ tech: "nsis", silentArgs: ["/S"], perUserLikely: true }) }));
    expect(await screen.findByText(a.silent.perUserWarning)).toBeTruthy();
  });

  it("an MSI shows no switches at all and is saved as an MSI", async () => {
    const createDesktop = vi.fn<(input: unknown) => Promise<string>>(async () => "a8");
    cx.fns["apps:createDesktop"] = createDesktop;
    await checked(fingerprint({ inspection: inspection({ tech: "msi", kind: "msi", silentArgs: [], signer: undefined, productName: "Tool" }) }), "https://downloads.example.com/tool.msi");
    await screen.findByText(a.silent.silent);
    openAdvanced();
    expect(screen.queryByRole("textbox", { name: new RegExp(`^${t.silentArgs}`) })).toBeNull();
    expect(screen.getAllByText(a.lines.remove).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(`^${a.program.label}`) }), { target: { value: "Tool\\tool.exe" } });
    fireEvent.click(addButton("Tool"));
    await waitFor(() => expect(createDesktop).toHaveBeenCalledTimes(1));
    expect(createDesktop.mock.calls[0]![0]).toMatchObject({ desktop: { source: "msi", install: { kind: "msi", silentArgs: [], removeWhenUnassigned: true } } });
  });

  it("an InstallShield script installer waits for its answer file, which has its own fields under Advanced", async () => {
    const createDesktop = vi.fn<(input: unknown) => Promise<string>>(async () => "a8");
    cx.fns["apps:createDesktop"] = createDesktop;
    await checked(fingerprint({ inspection: inspection({ tech: "installshield_script", confidence: "low", silentArgs: ["/s", "/f1{AnswerFile}"], needsAnswerFile: true, productName: "Old Tool" }) }));
    expect(await screen.findByText(a.answer.needed)).toBeTruthy();
    expect(addButton("Old Tool").disabled).toBe(true);
    expect(screen.getByText(a.review.blocked.needsAnswer)).toBeTruthy();
    openAdvanced();
    typeInto(t.answerUrl, "https://downloads.example.com/setup.iss");
    typeInto(t.answerSha, "cd".repeat(32));
    expect(addButton("Old Tool").disabled).toBe(false);
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(`^${a.program.label}`) }), { target: { value: "Old\\old.exe" } });
    fireEvent.click(addButton("Old Tool"));
    await waitFor(() => expect(createDesktop).toHaveBeenCalledTimes(1));
    expect(createDesktop.mock.calls[0]![0]).toMatchObject({ desktop: { install: { tech: "installshield_script", answerFile: { url: "https://downloads.example.com/setup.iss", sha256: "cd".repeat(32) } } } });
  });

  it("the switches and the file go together: a token without a file, and a bad answer address, are refused inline", async () => {
    await checked(fingerprint({ inspection: inspection({ tech: "exe", confidence: "low", silentArgs: ["/s"], signer: undefined, productName: "Tool" }) }));
    await screen.findByText(a.silent.guess);
    openAdvanced();
    typeInto(t.silentArgs, "/s /f1{AnswerFile}");
    fireEvent.change(screen.getByRole("textbox", { name: new RegExp(`^${a.program.label}`) }), { target: { value: "Tool\\tool.exe" } });
    fireEvent.click(addButton("Tool"));
    expect(await screen.findByText(t.tokenNeedsAnswer)).toBeTruthy();
  });

  it("every refusal of the check has its own sentence; a file too big to download falls back to the type and the file on this computer", async () => {
    const refuse = (detail: string) => async () => {
      throw new ConvexError({ code: "invalid_argument", field: "url", detail });
    };
    await checked(refuse("fingerprint_blocked"));
    expect(await screen.findByText(a.installer.blocked)).toBeTruthy();
    cleanup();
    await checked(refuse("fingerprint_failed"));
    expect(await screen.findByText(a.installer.failed)).toBeTruthy();
    cleanup();
    await checked(refuse("fingerprint_not_installer"));
    expect(await screen.findByText(a.installer.notInstaller)).toBeTruthy();
    cleanup();
    const ranges = vi.fn(async () => inspection({ productName: "Big Tool" }));
    cx.fns["apps:inspectInstaller"] = ranges;
    await checked(refuse("fingerprint_too_large"));
    expect(await screen.findByText(a.installer.tooBig)).toBeTruthy();
    await waitFor(() => expect(ranges).toHaveBeenCalledWith({ url: URL1 }));
    expect(screen.getByText(a.review.blocked.noFile)).toBeTruthy();
    expect(addButton("Big Tool").disabled).toBe(true);
  });

  it("changing the link forgets the old result: the hash it filled in goes, the name stays", async () => {
    const check = vi.fn(async () => fingerprint({ inspection: inspection({ productName: "Zahras POS" }) }));
    await checked(check);
    await screen.findByText(a.silent.silent);
    fireEvent.change(linkBox(), { target: { value: "https://downloads.example.com/other.exe" } });
    expect(screen.queryByText(a.silent.silent)).toBeNull();
    expect(screen.getByText(a.review.blocked.noLink)).toBeTruthy();
  });

  it("a viewer cannot check or add", async () => {
    cx.fns["apps:fingerprintInstaller"] = vi.fn();
    await ui("viewer", "/apps/new?kind=desktop&source=installer");
    expect(linkBox().disabled).toBe(true);
    expect(screen.getByText(a.review.viewer)).toBeTruthy();
  });
});

describe("the file on this computer", () => {
  const fileOf = (bytes: Uint8Array, name = "setup.exe") => new File([bytes as BlobPart], name);
  const chooser = () => screen.getByLabelText(a.installer.chooseFile) as HTMLInputElement;
  const start = async () => {
    cx.fns["apps:fingerprintInstaller"] = vi.fn();
    await ui("admin", "/apps/new?kind=desktop&source=installer");
  };

  it("is read in the browser: the hash and the type come from the file, and nothing is uploaded", async () => {
    const inspect = vi.fn();
    cx.fns["apps:inspectInstaller"] = inspect;
    const bytes = buildPe({ manifest: "<description>Inno Setup</description>", version: { FileVersion: "3.1.0" }, certificate: certificateTable("Local Software Co") });
    await start();
    fireEvent.change(chooser(), { target: { files: [fileOf(bytes)] } });
    expect(await screen.findByText(a.silent.silent)).toBeTruthy();
    openAdvanced();
    expect(box(t.silentArgs).value).toBe("/SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART");
    fireEvent.click(screen.getByRole("button", { name: t.change }));
    expect(box(a.installer.hashAdvanced).value).toBe(bytesToHex(sha256(bytes)));
    expect(inspect).not.toHaveBeenCalled(); // no server call: the file never leaves the browser
  });

  it("a file that is not the one at the link changes nothing and says so", async () => {
    cx.fns["apps:fingerprintInstaller"] = async () => fingerprint();
    await ui("admin", "/apps/new?kind=desktop&source=installer");
    fireEvent.change(linkBox(), { target: { value: URL1 } });
    fireEvent.blur(linkBox());
    await screen.findByText(a.silent.silent);
    fireEvent.change(chooser(), { target: { files: [fileOf(FIXTURES.nsisHigh())] } });
    expect(await screen.findByText(a.installer.differs)).toBeTruthy();
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: t.change }));
    expect(box(a.installer.hashAdvanced).value).toBe(SHA);
  });

  it("a file that is not a program or an MSI is refused with a sentence", async () => {
    await start();
    fireEvent.change(chooser(), { target: { files: [fileOf(new TextEncoder().encode("hello"), "notes.exe")] } });
    expect(await screen.findByText(a.installer.notInstaller)).toBeTruthy();
  });
});

describe("an existing program (the Details tab)", () => {
  const stored = (over: Record<string, unknown> = {}) => ({
    _id: "a1",
    name: "Tool",
    kind: "desktop",
    archived: false,
    revision: 4,
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
      fileArgTemplate: ["{file}"],
      resetFolders: [],
      install: { kind: "exe", url: URL1, sha256: SHA, sizeBytes: 5000, silentArgs: ["/S"], successExitCodes: [0], removeWhenUnassigned: false, tech: "nsis", timeoutMin: 45, publisher: "Acme Software Ltd" },
    },
    ...over,
  });

  it("shows 'Installs silently' for the stored switches, keeps every stored detail under Advanced and saves them unchanged", async () => {
    const update = vi.fn<(input: unknown) => Promise<{ revision: number }>>(async () => ({ revision: 5 }));
    cx.fns["apps:update"] = update;
    cx.results["apps:get"] = stored();
    await ui("admin", "/apps/a1");
    expect(screen.getByText(a.silent.silent)).toBeTruthy();
    openAdvanced();
    expect(box(t.silentArgs).value).toBe("/S");
    expect(box(t.timeout).value).toBe("45");
    expect(box(t.publisher).value).toBe("Acme Software Ltd");
    typeInto(appEditStrings.name, "Tool 2");
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect((update.mock.calls[0]![0] as { desktop: { desktop: { install: unknown } } }).desktop.desktop.install).toMatchObject({
      silentArgs: ["/S"],
      tech: "nsis",
      timeoutMin: 45,
      publisher: "Acme Software Ltd",
      sizeBytes: 5000,
    });
  });

  it("switches that are not the type's own are shown as the admin's own", async () => {
    cx.results["apps:get"] = stored({ desktop: { ...stored().desktop, install: { ...stored().desktop.install, silentArgs: ["/silent", "/x"] } } });
    await ui("admin", "/apps/a1");
    expect(screen.getByText(a.silent.own)).toBeTruthy();
  });

  it("an MSI has no switches, type or success codes, but the timeout and the expected signer; a portable file has no installer details", async () => {
    cx.results["apps:get"] = stored({ desktop: { ...stored().desktop, source: "msi", install: { ...stored().desktop.install, kind: "msi", silentArgs: [], tech: undefined, removeWhenUnassigned: true } } });
    await ui("admin", "/apps/a1");
    openAdvanced();
    expect(screen.queryByRole("textbox", { name: new RegExp(`^${t.silentArgs}`) })).toBeNull();
    expect(box(t.timeout)).toBeTruthy();
    cleanup();
    cx.results["apps:get"] = stored({ desktop: { ...stored().desktop, source: "portable", exe: "{RuleboxApps}\\{AppId}\\app.exe", install: { ...stored().desktop.install, kind: "portable", silentArgs: [], tech: undefined } } });
    await ui("admin", "/apps/a1");
    expect(screen.getByText(a.silent.none)).toBeTruthy();
    openAdvanced();
    expect(screen.queryByRole("textbox", { name: new RegExp(`^${t.timeout}`) })).toBeNull();
  });
});

void installRefusalStrings;
void appsStrings;
