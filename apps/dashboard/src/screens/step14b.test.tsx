import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { ReactNode } from "react";
import type { Me } from "../data/types";
import { MeContext } from "../lib/member";
import { strings } from "../lib/strings";
import { networksStrings as s } from "./networks/strings";

// Phase 5 Step 14b screens (the Drivers and Approved printer drivers cards of Networks, DriverEdit, the delivered tag of the printer
// picker) against the LIVE data seam with the Convex React hooks mocked, like step14.test.tsx.
const cx = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  queried: [] as { name: string; args: unknown }[],
  fns: {} as Record<string, (args?: unknown) => Promise<unknown>>,
}));

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
const submit = () => fireEvent.click(screen.getByRole("button", { name: s.createDriver }));

describe("Drivers on the Networks list", () => {
  it("lists each driver with kind, class, the names it provides and group chips; an admin can add and edit", () => {
    cx.results["networks:list"] = list({
      drivers: [brother, { ...brother, _id: "d2", name: "Scanner", kind: "exe", deviceClass: "scanner", provides: [], groupCount: 0, groups: [] }],
    });
    ui(<Networks />, "admin", "/networks");
    const rows = within(screen.getByRole("list", { name: s.driversSection })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole("link", { name: "Brother laser" }).getAttribute("href")).toBe("/networks/drivers/d1");
    expect(within(rows[0]!).getByText(s.driverKindShort.inf)).toBeTruthy();
    expect(within(rows[0]!).getByText(s.driverClassShort.printer)).toBeTruthy();
    expect(within(rows[0]!).getByText(s.driverProvidesLine("Brother HL-L2350DW series"))).toBeTruthy();
    expect(within(rows[1]!).getByText(s.driverKindShort.exe)).toBeTruthy();
    expect(within(rows[1]!).getByText(s.noGroups)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: s.newDriver }).length).toBeGreaterThan(0);
    expect(within(rows[0]!).getByRole("link", { name: `${s.edit} Brother laser` })).toBeTruthy();
  });

  it("an organization without drivers gets the empty state with the add action; a viewer gets neither Add nor Edit", () => {
    ui(<Networks />, "admin", "/networks");
    expect(screen.getByText(s.emptyDriversTitle)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: s.newDriver })).toHaveLength(2);
    cleanup();
    cx.results["networks:list"] = list({ drivers: [brother] });
    ui(<Networks />, "viewer", "/networks");
    expect(screen.queryByRole("link", { name: s.newDriver })).toBeNull();
    expect(screen.queryByRole("link", { name: `${s.edit} Brother laser` })).toBeNull();
    expect(screen.getByRole("link", { name: "Brother laser" })).toBeTruthy();
  });
});

describe("Approved printer drivers card", () => {
  it("shows the built-in drivers, the added names as chips and the delivered names; an admin adds and removes, then saves once", async () => {
    const set = vi.fn(async () => ({ addedDrivers: ["HP Universal", "Canon UFR II"] }));
    cx.fns["networks:setApprovedPrinterDrivers"] = set;
    cx.results["networks:list"] = list({ addedDrivers: ["HP Universal"], drivers: [brother] });
    ui(<Networks />, "admin", "/networks");
    const card = screen.getByRole("heading", { name: s.approvedTitle }).closest("section")!;
    for (const n of INBOX) expect(within(card).getByText(n)).toBeTruthy();
    expect(within(card).getByText("HP Universal")).toBeTruthy();
    expect(within(card).getByText(s.driverDeliveredLine("Brother HL-L2350DW series"))).toBeTruthy();
    expect((within(card).getByRole("button", { name: s.approvedSave }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(card).getByLabelText(s.approvedField), { target: { value: " Canon UFR II " } });
    fireEvent.click(within(card).getByRole("button", { name: s.approvedAdd }));
    expect(within(card).getByText("Canon UFR II")).toBeTruthy();
    expect(within(card).getByText(s.approvedUnsaved)).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: s.approvedSave }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith({ names: ["HP Universal", "Canon UFR II"] });
    expect(await screen.findByText(s.approvedSaved)).toBeTruthy();
  });

  it("removes a name before saving; refuses a duplicate, a built-in name, an empty name and more than 20 names in words", async () => {
    const set = vi.fn(async () => ({ addedDrivers: [] }));
    cx.fns["networks:setApprovedPrinterDrivers"] = set;
    cx.results["networks:list"] = list({ addedDrivers: ["HP Universal"] });
    ui(<Networks />, "admin", "/networks");
    const card = screen.getByRole("heading", { name: s.approvedTitle }).closest("section")!;
    const field = () => within(card).getByLabelText(s.approvedField);
    const add = () => fireEvent.click(within(card).getByRole("button", { name: s.approvedAdd }));
    add();
    expect(within(card).getByText(s.approvedProblems.empty)).toBeTruthy();
    fireEvent.change(field(), { target: { value: "hp universal" } });
    add();
    expect(within(card).getByText(s.approvedDuplicate)).toBeTruthy();
    fireEvent.change(field(), { target: { value: "generic / text only" } });
    add();
    expect(within(card).getByText(s.approvedBuiltInName)).toBeTruthy();
    fireEvent.change(field(), { target: { value: "x".repeat(101) } });
    add();
    expect(within(card).getByText(s.approvedProblems.length)).toBeTruthy();
    // 19 more names reach the limit of 20; the 21st is refused.
    for (let i = 0; i < 19; i++) {
      fireEvent.change(field(), { target: { value: `Driver ${i}` } });
      add();
    }
    fireEvent.change(field(), { target: { value: "One too many" } });
    add();
    expect(within(card).getByText(s.approvedLimit)).toBeTruthy();

    fireEvent.click(within(card).getByRole("button", { name: s.approvedRemove("HP Universal") }));
    expect(within(card).queryByText("HP Universal")).toBeNull();
    expect(set).not.toHaveBeenCalled();
  });

  it("says what the server refuses; a viewer sees the lists without the field, the remove buttons or Save", async () => {
    cx.fns["networks:setApprovedPrinterDrivers"] = vi.fn().mockRejectedValue(new ConvexError({ code: "too_large", detail: "names" }));
    cx.results["networks:list"] = list({ addedDrivers: ["HP Universal"] });
    ui(<Networks />, "admin", "/networks");
    const card = screen.getByRole("heading", { name: s.approvedTitle }).closest("section")!;
    fireEvent.click(within(card).getByRole("button", { name: s.approvedRemove("HP Universal") }));
    fireEvent.click(within(card).getByRole("button", { name: s.approvedSave }));
    expect(await screen.findByText(/at most 20 driver names/)).toBeTruthy();
    cleanup();
    ui(<Networks />, "viewer", "/networks");
    expect(screen.getByText("HP Universal")).toBeTruthy();
    expect(screen.queryByLabelText(L(s.approvedField))).toBeNull();
    expect(screen.queryByRole("button", { name: s.approvedSave })).toBeNull();
    expect(screen.queryByRole("button", { name: s.approvedRemove("HP Universal") })).toBeNull();
  });
});

describe("New driver (/networks/drivers/new)", () => {
  it("asks for the required fields in words before it calls the server, with the plain-English rules on the form", async () => {
    const save = vi.fn(async () => ({ id: "d9", revision: 1 }));
    cx.fns["drivers:save"] = save;
    ui(<DriverEdit />, "admin", "/networks/drivers/new");
    expect(screen.getByText(s.driverRules)).toBeTruthy();
    expect(screen.getByText(s.driverUrlHint)).toBeTruthy();
    expect(screen.getByText(s.driverClassHint)).toBeTruthy();
    submit();
    expect(await screen.findByText(s.driverNameProblems.empty)).toBeTruthy();
    expect(screen.getByText(s.driverUrlProblems.empty)).toBeTruthy();
    expect(screen.getByText(s.driverShaProblems.empty)).toBeTruthy();
    expect(screen.getByText(s.driverInfProblems.empty)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    type(s.name, "Zebra");
    type(s.driverUrl, "http://dl.example.test/z.zip");
    expect(screen.getByText(s.driverUrlProblems.scheme)).toBeTruthy();
    type(s.driverSha, "abc");
    expect(screen.getByText(s.driverShaProblems.format)).toBeTruthy();
    type(s.driverInf, "..\\z.inf");
    expect(screen.getByText(s.driverInfProblems.path)).toBeTruthy();
    type(s.driverInf, "z.txt");
    expect(screen.getByText(s.driverInfProblems.extension)).toBeTruthy();
    type(s.driverInf, "/z.inf");
    expect(screen.getByText(s.driverInfProblems.path)).toBeTruthy();
    type(s.driverSize, "99999999999");
    expect(screen.getByText(s.driverSizeProblems.range)).toBeTruthy();
    type(s.driverSize, "12x");
    expect(screen.getByText(s.driverSizeProblems.number)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("an INF package sends the INF path and a lower-case hash and no installer arguments; the form follows the kind", async () => {
    const save = vi.fn(async () => ({ id: "d9", revision: 1 }));
    cx.fns["drivers:save"] = save;
    ui(<DriverEdit />, "admin", "/networks/drivers/new");
    expect(screen.queryByLabelText(L(s.driverArgs))).toBeNull();
    expect(screen.queryByLabelText(L(s.driverCodes))).toBeNull();
    type(s.name, " Zebra labels ");
    type(s.driverUrl, "https://dl.example.test/z.zip");
    type(s.driverSha, SHA.toUpperCase());
    type(s.driverSize, "1234");
    type(s.driverInf, "zebra\\zd.inf");
    type(s.driverProvides, "ZDesigner ZD420\n\n  ZDesigner ZD620 ");
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
    expect(await screen.findByText(s.driverCreated("Zebra labels"))).toBeTruthy();
    await waitFor(() => expect(where()).toBe("/networks/drivers/d9"));
  });

  it("a vendor .exe needs silent arguments (one per line) and takes success codes; an .msi needs neither (and has no success codes either)", async () => {
    const save = vi.fn(async () => ({ id: "d9", revision: 1 }));
    cx.fns["drivers:save"] = save;
    ui(<DriverEdit />, "admin", "/networks/drivers/new");
    fireEvent.change(screen.getByLabelText(L(s.driverKind)), { target: { value: "exe" } });
    expect(screen.queryByLabelText(L(s.driverInf))).toBeNull();
    fireEvent.change(screen.getByLabelText(L(s.driverClassLabel)), { target: { value: "scanner" } });
    type(s.name, "Scanner");
    type(s.driverUrl, "https://dl.example.test/setup.exe");
    type(s.driverSha, SHA);
    submit();
    expect(await screen.findByText(s.driverArgsProblems.required)).toBeTruthy();
    type(s.driverArgs, "/S\n  /norestart  \n");
    type(s.driverCodes, "0, x");
    expect(screen.getByText(s.driverCodesProblems.number)).toBeTruthy();
    type(s.driverCodes, "0, 3010");
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ kind: "exe", deviceClass: "scanner", silentArgs: ["/S", "/norestart"], successExitCodes: [0, 3010], sizeBytes: 0 }));
    expect((save.mock.calls[0] as unknown[])[0]).not.toHaveProperty("inf");

    cleanup();
    save.mockClear();
    ui(<DriverEdit />, "admin", "/networks/drivers/new");
    fireEvent.change(screen.getByLabelText(L(s.driverKind)), { target: { value: "msi" } });
    expect(screen.queryByLabelText(L(s.driverArgs))).toBeNull();
    expect(screen.queryByLabelText(L(s.driverCodes))).toBeNull();
    type(s.name, "Vendor msi");
    type(s.driverUrl, "https://dl.example.test/a.msi");
    type(s.driverSha, SHA);
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
    type(s.driverUrl, "https://dl.example.test/z.zip");
    type(s.driverSha, SHA);
    type(s.driverInf, "z.inf");
    for (let i = 1; i <= 11; i++) fireEvent.click(screen.getByRole("checkbox", { name: `Group ${i}` }));
    expect(screen.queryByText(/groups touched/)).toBeNull();
    submit();
    expect(await screen.findByText(s.driverNameTaken)).toBeTruthy();
    expect((save.mock.calls[0] as unknown as [{ groupIds: string[] }])[0].groupIds).toHaveLength(11);
    submit();
    expect(await screen.findByText(s.driverShaProblems.format)).toBeTruthy();
    submit();
    expect(await screen.findByText(/at most 50 drivers/)).toBeTruthy();
  });

  it("a viewer gets the read-only notice instead of the form", () => {
    ui(<DriverEdit />, "viewer", "/networks/drivers/new");
    expect(screen.getByText(strings.app.readOnly)).toBeTruthy();
    expect(screen.queryByRole("button", { name: s.createDriver })).toBeNull();
  });
});

describe("Driver (/networks/drivers/:id)", () => {
  beforeEach(() => {
    cx.results["drivers:detail"] = detail;
  });

  it("asks drivers:detail for the id and shows the form and the install counts, including restart needed", () => {
    ui(<DriverEdit />, "admin", "/networks/drivers/d1");
    expect(cx.queried.find((q) => q.name === "drivers:detail")!.args).toEqual({ id: "d1" });
    expect((screen.getByLabelText(L(s.name)) as HTMLInputElement).value).toBe("Brother laser");
    expect((screen.getByLabelText(L(s.driverInf)) as HTMLInputElement).value).toBe("Drivers\\brhl.inf");
    expect((screen.getByLabelText(L(s.driverSha)) as HTMLInputElement).value).toBe(SHA);
    expect((screen.getByLabelText(L(s.driverProvides)) as HTMLTextAreaElement).value).toBe("Brother HL-L2350DW series");
    expect((screen.getByRole("checkbox", { name: "Group 1" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Group 3" }) as HTMLInputElement).checked).toBe(false);
    const card = screen.getByRole("heading", { name: s.driverCountsTitle }).closest("section")!;
    expect(within(card).getByText(s.driverInstalled).nextElementSibling!.textContent).toBe("5");
    expect(within(card).getByText(s.driverFailed).nextElementSibling!.textContent).toBe("1");
    expect(within(card).getByText(s.driverPending).nextElementSibling!.textContent).toBe("2");
    expect(within(card).getByText(s.driverRestart).nextElementSibling!.textContent).toBe("3");
  });

  it("saves with the id and the revision it holds, and sends the next one after a save", async () => {
    const save = vi.fn(async () => ({ id: "d1", revision: 3 }));
    cx.fns["drivers:save"] = save;
    ui(<DriverEdit />, "admin", "/networks/drivers/d1");
    type(s.name, "Brother laser 2");
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ id: "d1", expectedRevision: 2, name: "Brother laser 2", groupIds: ["g1", "g2"], sizeBytes: 18_000_000 }));
    expect(await screen.findByText(s.driverSaved)).toBeTruthy();
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
    await waitFor(() => expect((screen.getByLabelText(L(s.name)) as HTMLInputElement).value).toBe("Brother laser"));
  });

  it("retry calls drivers:retry with the id and says so", async () => {
    const retry = vi.fn(async () => null);
    cx.fns["drivers:retry"] = retry;
    ui(<DriverEdit />, "admin", "/networks/drivers/d1");
    fireEvent.click(screen.getByRole("button", { name: s.retryDriver }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith({ id: "d1" }));
    expect(await screen.findByText(s.driverRetried)).toBeTruthy();
  });

  it("delete explains that zip drivers are removed from the PCs, needs the name typed, then leaves for the list", async () => {
    const del = vi.fn(async () => null);
    cx.fns["drivers:remove"] = del;
    ui(<DriverEdit />, "admin", "/networks/drivers/d1");
    fireEvent.click(screen.getAllByRole("button", { name: s.removeDriver })[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/vendor installer is left in place/)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: s.removeDriver });
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
    expect(screen.queryByRole("button", { name: s.retryDriver })).toBeNull();
    expect(screen.queryByRole("button", { name: s.removeDriver })).toBeNull();
  });
});

describe("Printer driver picker (Step 14b)", () => {
  it("tags a name that a Drivers entry delivers and explains where drivers come from", () => {
    cx.results["networks:list"] = list({ approvedDrivers: [...INBOX, "Brother HL-L2350DW series", "HP Universal"], drivers: [brother], addedDrivers: ["HP Universal"] });
    ui(<PrinterEdit />, "admin", "/networks/printers/new");
    const options = within(screen.getByLabelText(L(s.driverLabel))).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual([...INBOX, `Brother HL-L2350DW series (${s.driverDelivered})`, "HP Universal"]);
    expect(screen.getByText(s.driverHint)).toBeTruthy();
    expect(screen.getByText(/delivered by a Drivers entry assigned to the same groups/)).toBeTruthy();
  });
});
