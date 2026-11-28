import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { ReactNode } from "react";
import type { Me } from "../data/types";
import { MeContext } from "../lib/member";
import { formatBytes } from "../lib/format";
import { strings } from "../lib/strings";
import { pickOption, selectedText } from "../test/select";
import { driverStrings as s } from "./networks/driverStrings";
import { printerStrings as ps } from "./networks/printerStrings";
import { networksStrings as n } from "./networks/strings";

// Phase 5 Step 14b screens (the Drivers section of Networks with the printer driver names in its Advanced, DriverEdit with "Check the file", the
// delivered tag of the printer picker; UI pass 2026-11-28) against the LIVE data seam with the Convex React hooks mocked, like step14.test.tsx.
const cx = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  queried: [] as { name: string; args: unknown }[],
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
}));

// The file check and the zip reader are lazy chunks (they need a real file): their answers are canned here.
const lazy = vi.hoisted(() => ({
  check: vi.fn(),
  inspectZip: vi.fn(),
  models: vi.fn(),
}));
vi.mock("../lib/apps/localInstaller", () => ({ checkLocalFile: lazy.check }));
vi.mock("../lib/drivers/zipInspect", () => {
  class ZipError extends Error {
    constructor(readonly problem: string) {
      super(problem);
    }
  }
  return { ZipError, inspectDriverZip: lazy.inspectZip, modelsOfInfPath: lazy.models };
});

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQueries: (req: Record<string, { query: FunctionReference<"query">; args: unknown }>) =>
    Object.fromEntries(
      Object.entries(req).map(([k, r]) => {
        cx.queried.push({ name: getFunctionName(r.query), args: r.args });
        return [k, cx.results[getFunctionName(r.query)]];
      }),
    ),
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
import DriverEdit from "./DriverEdit";
import Networks from "./Networks";
import PrinterEdit from "./PrinterEdit";

const admin: Me = {
  email: "admin@x.test",
  role: "admin",
  status: "active",
  orgId: "org",
  orgName: "Acme",
  pin: { required: true, set: true },
  serverApiVersion: 1,
};

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname}</output>;
}

function ui(node: ReactNode, role: Me["role"], path: string) {
  return render(
    <ToastProvider>
      <MeContext.Provider value={{ ...admin, role }}>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/networks" element={node} />
            <Route path="/networks/drivers/new" element={node} />
            <Route path="/networks/drivers/:id" element={node} />
            <Route path="/networks/printers/new" element={node} />
          </Routes>
        </MemoryRouter>
      </MeContext.Provider>
    </ToastProvider>,
  );
}

const groupRow = (id: string, name: string) => ({ _id: id, name, revision: 0, createdAt: 1, devices: { count: 0, more: false }, employees: { count: 0, more: false } });
const GROUPS = Array.from({ length: 12 }, (_, i) => groupRow(`g${i + 1}`, `Group ${i + 1}`));
const INBOX = ["Microsoft IPP Class Driver", "Microsoft PCL6 Class Driver", "Microsoft PS Class Driver", "Generic / Text Only"];
const SHA = "ab".repeat(32);

const counts = { installed: 5, failed: 1, pending: 2, removed: 0, unsupported: 0, restartNeeded: 3, sampled: 8, capped: false };
const brother = {
  _id: "d1",
  name: "Brother laser",
  kind: "inf",
  deviceClass: "printer",
  sizeBytes: 18_000_000,
  revision: 2,
  provides: ["Brother HL-L2350DW series"],
  groupCount: 2,
  groups: [{ _id: "g1", name: "Group 1" }, { _id: "g2", name: "Group 2" }],
};
const detail = {
  ...brother,
  url: "https://dl.example.test/brother.zip",
  sha256: SHA,
  inf: "Drivers\\brhl.inf",
  silentArgs: [],
  successExitCodes: [],
  groupIds: ["g1", "g2"],
  counts,
};
const list = (over: object = {}) => ({ wifi: [], printers: [], drivers: [], approvedDrivers: INBOX, addedDrivers: [], ...over });

beforeEach(() => {
  cx.results = { "groups:list": GROUPS, "networks:list": list() };
  cx.queried = [];
  cx.fns = {};
});
afterEach(cleanup);

const where = () => screen.getByTestId("where").textContent;
// Optional fields carry " (optional)" after their label.
const L = (label: string) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( \\(optional\\))?$`);

const by = (label: string) => screen.getByLabelText(L(label));
const type = (label: string, value: string) => fireEvent.change(by(label), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole("button", { name: s.create }));
const fileInput = () => screen.getByLabelText(s.chooseFile) as HTMLInputElement;
const file = (name: string) => new File(["x"], name);
const pick = (name: string) => fireEvent.change(fileInput(), { target: { files: [file(name)] } });
const exeCheck = {
  inspection: { tech: "nsis", kind: "exe", confidence: "high", silentArgs: ["/S"], successExitCodes: [0, 3010], needsAnswerFile: false, perUserLikely: false },
  sha256: SHA,
  sizeBytes: 12_000_000,
};

beforeEach(() => {
  lazy.check.mockReset();
  lazy.inspectZip.mockReset();
  lazy.models.mockReset();
});

describe("Drivers on the Networks page", () => {
  it("shows each driver as a card with its kind of device and group chips, not what it provides; an admin can add", () => {
    cx.results["networks:list"] = list({
      drivers: [brother, { ...brother, _id: "d2", name: "Scanner", kind: "exe", deviceClass: "scanner", provides: [], groupCount: 0, groups: [] }],
    });
    ui(<Networks />, "admin", "/networks");
    const rows = within(screen.getByRole("list", { name: n.driversSection })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole("link", { name: "Brother laser" }).getAttribute("href")).toBe("/networks/drivers/d1");
    expect(within(rows[0]!).getByText(n.driverClassCard.printer)).toBeTruthy();
    expect(rows[0]!.textContent).not.toContain("Brother HL-L2350DW series");
    expect(within(rows[0]!).getByText("Group 1")).toBeTruthy();
    expect(within(rows[1]!).getByText(n.driverClassCard.scanner)).toBeTruthy();
    expect(within(rows[1]!).getByText(n.notOnPcs)).toBeTruthy();
    expect(screen.getByRole("link", { name: n.addDriverShort }).getAttribute("href")).toBe("/networks/drivers/new");
  });

  it("an organization without drivers gets one compact row that says most setups don't need one; a viewer gets no Add", () => {
    ui(<Networks />, "admin", "/networks");
    expect(screen.getByText(n.emptyDrivers)).toBeTruthy();
    expect(screen.getByText(n.emptyDriversSub)).toBeTruthy();
    expect(screen.getByRole("link", { name: n.addDriverShort })).toBeTruthy();
    cleanup();
    cx.results["networks:list"] = list({ drivers: [brother] });
    ui(<Networks />, "viewer", "/networks");
    expect(screen.queryByRole("link", { name: n.addDriverShort })).toBeNull();
    expect(screen.getByRole("link", { name: "Brother laser" })).toBeTruthy();
  });
});

describe("Printer driver names (inside the Drivers section's Advanced)", () => {
  const box = () => screen.getByText(n.approvedTitle).closest("details")!;

  it("shows the built-in drivers, the added names as chips and the delivered names; an admin adds and removes, then saves once", async () => {
    const set = vi.fn(async () => ({ addedDrivers: ["HP Universal", "Canon UFR II"] }));
    cx.fns["networks:setApprovedPrinterDrivers"] = set;
    cx.results["networks:list"] = list({ addedDrivers: ["HP Universal"], drivers: [brother] });
    ui(<Networks />, "admin", "/networks");
    // closed until asked for
    expect(box().hasAttribute("open")).toBe(false);
    for (const name of INBOX) expect(within(box()).getByText(name)).toBeTruthy();
    expect(within(box()).getByText("HP Universal")).toBeTruthy();
    expect(within(box()).getByText(n.driverDeliveredLine("Brother HL-L2350DW series"))).toBeTruthy();
    expect((within(box()).getByRole("button", { name: n.approvedSave }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(box()).getByLabelText(n.approvedField), { target: { value: " Canon UFR II " } });
    fireEvent.click(within(box()).getByRole("button", { name: n.approvedAdd }));
    expect(within(box()).getByText("Canon UFR II")).toBeTruthy();
    fireEvent.click(within(box()).getByRole("button", { name: n.approvedSave }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith({ names: ["HP Universal", "Canon UFR II"] });
    expect(await screen.findByText(n.approvedSaved)).toBeTruthy();
  });

  it("removes a name before saving; refuses a duplicate, a built-in name, an empty name and more than 20 names in words (and opens by itself to say so)", async () => {
    const set = vi.fn(async () => ({ addedDrivers: [] }));
    cx.fns["networks:setApprovedPrinterDrivers"] = set;
    cx.results["networks:list"] = list({ addedDrivers: ["HP Universal"] });
    ui(<Networks />, "admin", "/networks");
    const field = () => within(box()).getByLabelText(n.approvedField);
    const add = () => fireEvent.click(within(box()).getByRole("button", { name: n.approvedAdd }));
    add();
    expect(within(box()).getByText(n.approvedProblems.empty)).toBeTruthy();
    expect(box().hasAttribute("open")).toBe(true);
    fireEvent.change(field(), { target: { value: "hp universal" } });
    add();
    expect(within(box()).getByText(n.approvedDuplicate)).toBeTruthy();
    fireEvent.change(field(), { target: { value: "generic / text only" } });
    add();
    expect(within(box()).getByText(n.approvedBuiltInName)).toBeTruthy();
    fireEvent.change(field(), { target: { value: "x".repeat(101) } });
    add();
    expect(within(box()).getByText(n.approvedProblems.length)).toBeTruthy();
    // 19 more names reach the limit of 20; the 21st is refused.
    for (let i = 0; i < 19; i++) {
      fireEvent.change(field(), { target: { value: `Driver ${i}` } });
      add();
    }
    fireEvent.change(field(), { target: { value: "One too many" } });
    add();
    expect(within(box()).getByText(n.approvedLimit)).toBeTruthy();

    fireEvent.click(within(box()).getByRole("button", { name: n.approvedRemove("HP Universal") }));
    expect(within(box()).queryByText("HP Universal")).toBeNull();
    expect(set).not.toHaveBeenCalled();
  });

  it("says what the server refuses; a viewer sees the lists without the field, the remove buttons or Save", async () => {
    cx.fns["networks:setApprovedPrinterDrivers"] = vi.fn().mockRejectedValue(new ConvexError({ code: "too_large", detail: "names" }));
    cx.results["networks:list"] = list({ addedDrivers: ["HP Universal"] });
    ui(<Networks />, "admin", "/networks");
    fireEvent.click(within(box()).getByRole("button", { name: n.approvedRemove("HP Universal") }));
    fireEvent.click(within(box()).getByRole("button", { name: n.approvedSave }));
    expect(await screen.findByText(/at most 20 driver names/)).toBeTruthy();
    cleanup();
    ui(<Networks />, "viewer", "/networks");
    expect(screen.getByText("HP Universal")).toBeTruthy();
    expect(screen.queryByLabelText(L(n.approvedField))).toBeNull();
    expect(screen.queryByRole("button", { name: n.approvedSave })).toBeNull();
    expect(screen.queryByRole("button", { name: n.approvedRemove("HP Universal") })).toBeNull();
  });
});

describe("New driver (/networks/drivers/new)", () => {
  it("asks for the link, the name and the fingerprint in words before it calls the server; the errors in Advanced open it", async () => {
    const save = vi.fn(async () => ({ id: "d9", revision: 1 }));
    cx.fns["drivers:save"] = save;
    ui(<DriverEdit />, "admin", "/networks/drivers/new");
    // the long explanations are in (i) tips, not in the form
    expect(screen.queryByText(s.urlInfo)).toBeNull();
    expect(screen.getByRole("button", { name: `About ${s.url}` })).toBeTruthy();
    expect(document.querySelector("details.net-adv")!.hasAttribute("open")).toBe(false);
    submit();
    expect(await screen.findByText(s.nameProblems.empty)).toBeTruthy();
    expect(screen.getByText(s.urlProblems.empty)).toBeTruthy();
    expect(screen.getByText(s.shaProblems.empty)).toBeTruthy();
    expect(screen.getByText(s.checkNeeded)).toBeTruthy();
    expect(screen.getByText(s.infProblems.empty)).toBeTruthy();
    expect(document.querySelector("details.net-adv")!.hasAttribute("open")).toBe(true);
    expect(save).not.toHaveBeenCalled();
    type(s.name, "Zebra");
    type(s.url, "http://dl.example.test/z.zip");
    expect(screen.getByText(s.urlProblems.scheme)).toBeTruthy();
    type(s.sha, "abc");
    expect(screen.getByText(s.shaProblems.format)).toBeTruthy();
    type(s.inf, "..\\z.inf");
    expect(screen.getByText(s.infProblems.path)).toBeTruthy();
    type(s.inf, "z.txt");
    expect(screen.getByText(s.infProblems.extension)).toBeTruthy();
    type(s.inf, "/z.inf");
    expect(screen.getByText(s.infProblems.path)).toBeTruthy();
    type(s.size, "99999999999");
    expect(screen.getByText(s.sizeProblems.range)).toBeTruthy();
    type(s.size, "12x");
    expect(screen.getByText(s.sizeProblems.number)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("the link fills the file type and the name; a name typed by hand is kept", () => {
    ui(<DriverEdit />, "admin", "/networks/drivers/new");
    type(s.url, "https://dl.example.test/Brother_HL-L2350DW.zip");
    expect((by(s.name) as HTMLInputElement).value).toBe("Brother HL-L2350DW");
    expect(selectedText(L(s.fileType))).toBe(s.kindNames.inf);
    type(s.url, "https://dl.example.test/zebra-setup.exe");
    expect((by(s.name) as HTMLInputElement).value).toBe("zebra setup");
    expect(selectedText(L(s.fileType))).toBe(s.kindNames.exe);
    expect(by(s.args)).toBeTruthy();
    type(s.name, "My Zebra");
    type(s.url, "https://dl.example.test/other.msi");
    expect((by(s.name) as HTMLInputElement).value).toBe("My Zebra");
    expect(selectedText(L(s.fileType))).toBe(s.kindNames.msi);
    expect(screen.queryByLabelText(L(s.args))).toBeNull();
  });

  it("an INF package sends the INF path and a lower-case hash and no installer arguments; the form follows the file type", async () => {
    const save = vi.fn(async () => ({ id: "d9", revision: 1 }));
    cx.fns["drivers:save"] = save;
    ui(<DriverEdit />, "admin", "/networks/drivers/new");
    expect(screen.queryByLabelText(L(s.args))).toBeNull();
    expect(screen.queryByLabelText(L(s.codes))).toBeNull();
    type(s.name, " Zebra labels ");
    type(s.url, "https://dl.example.test/z.zip");
    type(s.sha, SHA.toUpperCase());
    type(s.size, "1234");
    type(s.inf, "zebra\\zd.inf");
    type(s.provides, "ZDesigner ZD420\n\n  ZDesigner ZD620 ");
    fireEvent.click(screen.getByRole("checkbox", { name: "Group 2" }));
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({
      name: "Zebra labels",
      kind: "inf",
      deviceClass: "printer",
      url: "https://dl.example.test/z.zip",
      sha256: SHA,
      sizeBytes: 1234,
      inf: "zebra\\zd.inf",
      silentArgs: [],
      successExitCodes: [],
      provides: ["ZDesigner ZD420", "ZDesigner ZD620"],
      groupIds: ["g2"],
    });
    expect(await screen.findByText(s.created("Zebra labels"))).toBeTruthy();
    await waitFor(() => expect(where()).toBe("/networks/drivers/d9"));
  });

  it("a vendor .exe needs silent switches (one per line) and takes success codes; an .msi needs neither; the device type is Advanced", async () => {
    const save = vi.fn(async () => ({ id: "d9", revision: 1 }));
    cx.fns["drivers:save"] = save;
    ui(<DriverEdit />, "admin", "/networks/drivers/new");
    pickOption(L(s.fileType), /^Vendor installer \(\.exe\)/);
    expect(screen.queryByLabelText(L(s.inf))).toBeNull();
    pickOption(L(s.deviceType), "Scanner");
    type(s.name, "Scanner");
    type(s.url, "https://dl.example.test/setup.exe");
    type(s.sha, SHA);
    submit();
    expect(await screen.findByText(s.argsProblems.required)).toBeTruthy();
    type(s.args, "/S\n  /norestart  \n");
    type(s.codes, "0, x");
    expect(screen.getByText(s.codesProblems.number)).toBeTruthy();
    type(s.codes, "0, 3010");
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ kind: "exe", deviceClass: "scanner", silentArgs: ["/S", "/norestart"], successExitCodes: [0, 3010], sizeBytes: 0 }));
    expect((save.mock.calls[0] as unknown[])[0]).not.toHaveProperty("inf");

    cleanup();
    save.mockClear();
    ui(<DriverEdit />, "admin", "/networks/drivers/new");
    type(s.name, "Vendor msi");
    type(s.url, "https://dl.example.test/a.msi");
    type(s.sha, SHA);
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ kind: "msi", silentArgs: [], successExitCodes: [] }));
  });

  it("a save in more than 10 groups goes to the server; says in words what the server refuses", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "name", detail: "taken" }))
      .mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "sha256", detail: "format" }))
      .mockRejectedValueOnce(new ConvexError({ code: "too_large", detail: "drivers" }));
    cx.fns["drivers:save"] = save;
    ui(<DriverEdit />, "admin", "/networks/drivers/new");
    type(s.name, "Zebra");
    type(s.url, "https://dl.example.test/z.zip");
    type(s.sha, SHA);
    type(s.inf, "z.inf");
    for (let i = 1; i <= 11; i++) fireEvent.click(screen.getByRole("checkbox", { name: `Group ${i}` }));
    submit();
    expect(await screen.findByText(s.nameTaken)).toBeTruthy();
    expect((save.mock.calls[0] as unknown as [{ groupIds: string[] }])[0].groupIds).toHaveLength(11);
    submit();
    expect(await screen.findByText(s.shaProblems.format)).toBeTruthy();
    submit();
    expect(await screen.findByText(/at most 50 drivers/)).toBeTruthy();
  });

  it("a viewer gets the read-only notice instead of the form", () => {
    ui(<DriverEdit />, "viewer", "/networks/drivers/new");
    expect(screen.getByText(strings.app.readOnly)).toBeTruthy();
    expect(screen.queryByRole("button", { name: s.create })).toBeNull();
  });
});

describe("Check the file (nothing is uploaded)", () => {
  it("a vendor installer picked on this computer fills the fingerprint, size, type, switches and codes, and names the driver after the file", async () => {
    lazy.check.mockResolvedValue(exeCheck);
    const save = vi.fn(async () => ({ id: "d9", revision: 1 }));
    cx.fns["drivers:save"] = save;
    ui(<DriverEdit />, "admin", "/networks/drivers/new");
    type(s.url, "https://dl.example.test/get");
    pick("Zebra_Setup.exe");
    expect(await screen.findByText(s.summary(s.kindShort.exe, 0, formatBytes(12_000_000), "checked"))).toBeTruthy();
    expect((by(s.sha) as HTMLInputElement).value).toBe(SHA);
    expect((by(s.size) as HTMLInputElement).value).toBe("12000000");
    expect((by(s.args) as HTMLTextAreaElement).value).toBe("/S");
    expect((by(s.codes) as HTMLInputElement).value).toBe("3010");
    expect((by(s.name) as HTMLInputElement).value).toBe("Zebra Setup");
    expect(selectedText(L(s.fileType))).toBe(s.kindNames.exe);
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ kind: "exe", sha256: SHA, sizeBytes: 12_000_000, silentArgs: ["/S"], successExitCodes: [3010] }));
    expect(lazy.inspectZip).not.toHaveBeenCalled();
  });

  it("a zip with one driver file fills the INF path and offers the printer models it adds as ticked chips", async () => {
    lazy.check.mockResolvedValue({ inspection: null, sha256: SHA, sizeBytes: 14_000_000 });
    lazy.inspectZip.mockResolvedValue({ entryCount: 9, infs: [{ path: "Drivers/brhl.inf", models: ["Brother HL-L2350DW series", "Brother HL-L2370DW series"] }], moreInfs: false });
    const save = vi.fn(async () => ({ id: "d9", revision: 1 }));
    cx.fns["drivers:save"] = save;
    ui(<DriverEdit />, "admin", "/networks/drivers/new");
    type(s.url, "https://dl.example.test/brother.zip");
    pick("brother.zip");
    expect(await screen.findByText(s.summary(s.kindShort.inf, 2, formatBytes(14_000_000), "checked"))).toBeTruthy();
    expect((by(s.inf) as HTMLInputElement).value).toBe("Drivers/brhl.inf");
    expect(screen.queryByLabelText(L(s.infPick))).toBeNull(); // one file: nothing to choose
    const chip = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
    expect(chip("Brother HL-L2350DW series").checked).toBe(true);
    expect(chip("Brother HL-L2370DW series").checked).toBe(true);
    expect((by(s.provides) as HTMLTextAreaElement).value).toBe("Brother HL-L2350DW series\nBrother HL-L2370DW series");
    fireEvent.click(chip("Brother HL-L2370DW series")); // untick one
    expect((by(s.provides) as HTMLTextAreaElement).value).toBe("Brother HL-L2350DW series");
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ kind: "inf", inf: "Drivers/brhl.inf", provides: ["Brother HL-L2350DW series"], sha256: SHA, sizeBytes: 14_000_000 }));
  });

  it("a zip with several driver files asks which one; picking another reads its models", async () => {
    lazy.check.mockResolvedValue({ inspection: null, sha256: SHA, sizeBytes: 5_000_000 });
    lazy.inspectZip.mockResolvedValue({
      entryCount: 30,
      infs: [
        { path: "a.inf", models: ["Model A"] },
        { path: "x/b.inf", models: null },
      ],
      moreInfs: false,
    });
    lazy.models.mockResolvedValue(["Model B1", "Model B2"]);
    ui(<DriverEdit />, "admin", "/networks/drivers/new");
    type(s.url, "https://dl.example.test/pack.zip");
    pick("pack.zip");
    await screen.findByLabelText(L(s.infPick));
    expect(selectedText(L(s.infPick))).toBe("a.inf");
    expect(screen.getByRole("checkbox", { name: "Model A" })).toBeTruthy();
    pickOption(L(s.infPick), /^x\/b\.inf/);
    await screen.findByRole("checkbox", { name: "Model B1" });
    expect(lazy.models).toHaveBeenCalledWith(expect.any(File), "x/b.inf");
    expect((by(s.inf) as HTMLInputElement).value).toBe("x/b.inf");
    expect((by(s.provides) as HTMLTextAreaElement).value).toBe("Model B1\nModel B2");
    expect(screen.queryByRole("checkbox", { name: "Model A" })).toBeNull();
  });

  it("a zip that cannot be read says so and leaves the manual fields; a zip without an INF says so", async () => {
    const { ZipError } = await import("../lib/drivers/zipInspect");
    lazy.check.mockResolvedValue({ inspection: null, sha256: SHA, sizeBytes: 1000 });
    lazy.inspectZip.mockRejectedValueOnce(new (ZipError as unknown as new (p: string) => Error)("encrypted"));
    ui(<DriverEdit />, "admin", "/networks/drivers/new");
    pick("locked.zip");
    expect(await screen.findByText(s.zipUnreadable)).toBeTruthy();
    // the fingerprint is still there, the INF path is for the admin to type
    expect((by(s.sha) as HTMLInputElement).value).toBe(SHA);
    expect((by(s.inf) as HTMLInputElement).value).toBe("");
    lazy.inspectZip.mockResolvedValueOnce({ entryCount: 3, infs: [], moreInfs: false });
    pick("empty.zip");
    expect(await screen.findByText(s.noInf)).toBeTruthy();
  });

  it("a file that is not a zip, a program or an installer fails in words (the zip reader refuses it)", async () => {
    const { ZipError } = await import("../lib/drivers/zipInspect");
    lazy.check.mockResolvedValue({ inspection: null, sha256: SHA, sizeBytes: 10 });
    lazy.inspectZip.mockRejectedValueOnce(new (ZipError as unknown as new (p: string) => Error)("not_zip"));
    ui(<DriverEdit />, "admin", "/networks/drivers/new");
    pick("notes.txt");
    expect(await screen.findByText(s.zipUnreadable)).toBeTruthy();
  });

  it("'Detect from the link' fills the switches of an installer; it is not offered for a zip link; a refusal is said in words", async () => {
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ tech: "inno", kind: "exe", confidence: "high", silentArgs: ["/VERYSILENT", "/NORESTART"], successExitCodes: [0], needsAnswerFile: false, perUserLikely: false, sizeBytes: 9_000_000 })
      .mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "url", detail: "inspect_unsupported" }));
    cx.fns["apps:inspectInstaller"] = inspect;
    ui(<DriverEdit />, "admin", "/networks/drivers/new");
    const detect = () => screen.getByRole("button", { name: s.detect }) as HTMLButtonElement;
    expect(detect().disabled).toBe(true);
    type(s.url, "https://dl.example.test/setup.exe");
    expect(detect().disabled).toBe(false);
    fireEvent.click(detect());
    await waitFor(() => expect((by(s.args) as HTMLTextAreaElement).value).toBe("/VERYSILENT\n/NORESTART"));
    expect(inspect).toHaveBeenCalledWith({ url: "https://dl.example.test/setup.exe" });
    expect((by(s.size) as HTMLInputElement).value).toBe("9000000");
    expect(selectedText(L(s.fileType))).toBe(s.kindNames.exe);
    fireEvent.click(detect());
    expect(await screen.findByText(/doesn't allow partial downloads/)).toBeTruthy();
    type(s.url, "https://dl.example.test/pack.zip");
    expect(screen.queryByRole("button", { name: s.detect })).toBeNull();
  });
});

describe("Driver (/networks/drivers/:id)", () => {
  beforeEach(() => {
    cx.results["drivers:detail"] = detail;
  });

  it("asks drivers:detail for the id and shows the form with what was saved, and the install counts, including restart needed", () => {
    ui(<DriverEdit />, "admin", "/networks/drivers/d1");
    expect(cx.queried.find((q) => q.name === "drivers:detail")!.args).toEqual({ id: "d1" });
    expect((by(s.name) as HTMLInputElement).value).toBe("Brother laser");
    expect((by(s.url) as HTMLInputElement).value).toBe("https://dl.example.test/brother.zip");
    expect((by(s.inf) as HTMLInputElement).value).toBe("Drivers\\brhl.inf");
    expect((by(s.sha) as HTMLInputElement).value).toBe(SHA);
    expect((by(s.provides) as HTMLTextAreaElement).value).toBe("Brother HL-L2350DW series");
    expect((screen.getByRole("checkbox", { name: "Group 1" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Group 3" }) as HTMLInputElement).checked).toBe(false);
    // what is saved is summarised up front
    expect(screen.getByText(s.summary(s.kindShort.inf, 0, formatBytes(18_000_000), "saved"))).toBeTruthy();
    const card = screen.getByRole("heading", { name: s.countsTitle }).closest("section")!;
    expect(within(card).getByText(s.installed).nextElementSibling!.textContent).toBe("5");
    expect(within(card).getByText(s.failed).nextElementSibling!.textContent).toBe("1");
    expect(within(card).getByText(s.pending).nextElementSibling!.textContent).toBe("2");
    expect(within(card).getByText(s.restart).nextElementSibling!.textContent).toBe("3");
  });

  it("saves with the id and the revision it holds, and sends the next one after a save", async () => {
    const save = vi.fn(async () => ({ id: "d1", revision: 3 }));
    cx.fns["drivers:save"] = save;
    ui(<DriverEdit />, "admin", "/networks/drivers/d1");
    type(s.name, "Brother laser 2");
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ id: "d1", expectedRevision: 2, name: "Brother laser 2", groupIds: ["g1", "g2"], sizeBytes: 18_000_000 }));
    expect(await screen.findByText(s.saved)).toBeTruthy();
    type(s.name, "Brother laser 3");
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 3 }));
  });

  it("the stale-edit answer offers a reload", async () => {
    cx.fns["drivers:save"] = vi.fn().mockRejectedValue(new ConvexError({ code: "stale_edit" }));
    ui(<DriverEdit />, "admin", "/networks/drivers/d1");
    type(s.name, "Changed");
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    expect(await screen.findByText(strings.common.staleTitle)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.common.reload }));
    await waitFor(() => expect((by(s.name) as HTMLInputElement).value).toBe("Brother laser"));
  });

  it("retry calls drivers:retry with the id and says so", async () => {
    const retry = vi.fn(async () => null);
    cx.fns["drivers:retry"] = retry;
    ui(<DriverEdit />, "admin", "/networks/drivers/d1");
    fireEvent.click(screen.getByRole("button", { name: s.retry }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith({ id: "d1" }));
    expect(await screen.findByText(s.retried)).toBeTruthy();
  });

  it("delete explains that zip drivers are removed from the PCs, needs the name typed, then leaves for the list", async () => {
    const del = vi.fn(async () => null);
    cx.fns["drivers:remove"] = del;
    ui(<DriverEdit />, "admin", "/networks/drivers/d1");
    fireEvent.click(screen.getAllByRole("button", { name: s.remove })[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/vendor installer is left in place/)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: s.remove });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Brother laser" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(del).toHaveBeenCalledWith({ id: "d1" }));
    await waitFor(() => expect(where()).toBe("/networks"));
  });

  it("a viewer sees the driver read-only, without retry or remove", () => {
    ui(<DriverEdit />, "viewer", "/networks/drivers/d1");
    expect(screen.getByText("https://dl.example.test/brother.zip")).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.common.saveChanges })).toBeNull();
    expect(screen.queryByRole("button", { name: s.retry })).toBeNull();
    expect(screen.queryByRole("button", { name: s.remove })).toBeNull();
  });
});

describe("Printer driver picker (Step 14b)", () => {
  it("tags a name that a Drivers entry delivers", () => {
    cx.results["networks:list"] = list({ approvedDrivers: [...INBOX, "Brother HL-L2350DW series", "HP Universal"], drivers: [brother], addedDrivers: ["HP Universal"] });
    ui(<PrinterEdit />, "admin", "/networks/printers/new");
    fireEvent.click(screen.getByLabelText(L(ps.driver)));
    const options = within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent ?? "");
    expect(options.some((o) => o.includes("Brother HL-L2350DW series") && o.includes(ps.driverDelivered))).toBe(true);
    expect(options.some((o) => o.includes("HP Universal") && !o.includes(ps.driverDelivered))).toBe(true);
  });
});