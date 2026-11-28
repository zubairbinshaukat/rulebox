import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { ReactNode } from "react";
import type { Me } from "../data/types";
import { MeContext } from "../lib/member";
import { strings } from "../lib/strings";
import { pickOption, selectedText } from "../test/select";
import { printerStrings as s } from "./networks/printerStrings";
import { networksStrings as n } from "./networks/strings";

// Phase 5 Step 14 screens (the Printers section of Networks, PrinterEdit with one address field; UI pass 2026-11-28) against the LIVE data seam with the Convex React hooks
// mocked: queries answer from `cx.results`, writes call `cx.fns` (convex/networks.printers.test.ts covers the backend).
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
            <Route path="/networks/printers/new" element={node} />
            <Route path="/networks/printers/:id" element={node} />
          </Routes>
        </MemoryRouter>
      </MeContext.Provider>
    </ToastProvider>,
  );
}

const groupRow = (id: string, name: string) => ({ _id: id, name, revision: 0, createdAt: 1, devices: { count: 0, more: false }, employees: { count: 0, more: false } });
const GROUPS = Array.from({ length: 12 }, (_, i) => groupRow(`g${i + 1}`, `Group ${i + 1}`));
const DRIVERS = ["Microsoft IPP Class Driver", "Microsoft PCL6 Class Driver", "Microsoft PS Class Driver", "Generic / Text Only", "HP Universal Printing PCL 6"];

beforeEach(() => {
  cx.results = { "groups:list": GROUPS, "networks:list": { wifi: [], printers: [], drivers: [], addedDrivers: [], approvedDrivers: DRIVERS } };
  cx.queried = [];
  cx.fns = {};
});
afterEach(cleanup);

const counts = { applied: 6, failed: 1, waiting: 0, unsupported: 0, sampled: 7, capped: false };
const front = {
  _id: "p1",
  name: "Front desk",
  kind: "ipp",
  address: "ipp://10.0.0.20:631/ipp/print",
  port: null,
  queue: null,
  driver: "Microsoft IPP Class Driver",
  revision: 2,
  groupCount: 2,
  defaultGroupCount: 1,
  groups: [{ _id: "g1", name: "Group 1" }, { _id: "g2", name: "Group 2" }],
  groupIds: ["g1", "g2"],
  defaultForGroupIds: ["g1"],
  counts,
};
const where = () => screen.getByTestId("where").textContent;
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

const listOf = (over: object = {}) => ({ wifi: [], printers: [], drivers: [], addedDrivers: [], approvedDrivers: DRIVERS, ...over });

const submit = () => fireEvent.click(screen.getByRole("button", { name: s.create }));
const savePrinter = () => fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));

describe("Printers on the Networks page", () => {
  it("shows each printer as a card: name, 'Network printer' and its host only, the Default pill and two group chips", () => {
    cx.results["networks:list"] = {
      wifi: [],
      drivers: [], addedDrivers: [], approvedDrivers: DRIVERS,
      printers: [
        { ...front, groupCount: 6, groups: [1, 2, 3, 4, 5, 6].map((k) => ({ _id: `g${k}`, name: `Group ${k}` })) },
        { ...front, _id: "p2", name: "Labels", kind: "raw", address: "10.0.0.31", port: 9101, driver: "Generic / Text Only", groupCount: 0, defaultGroupCount: 0, groups: [] },
        { ...front, _id: "p3", name: "Laser", kind: "share", address: "\\\\print01\\hp", groupCount: 1, defaultGroupCount: 0, groups: [{ _id: "g9", name: "Lobby" }] },
      ],
    };
    ui(<Networks />, "admin", "/networks");
    const rows = within(screen.getByRole("list", { name: n.printersSection })).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByRole("link", { name: "Front desk" }).getAttribute("href")).toBe("/networks/printers/p1");
    // the host, not the address with its port, path or queue
    expect(rows[0]!.textContent).toContain("Network printer · 10.0.0.20");
    expect(rows[0]!.textContent).not.toContain("ipp://");
    expect(rows[0]!.textContent).not.toContain("Microsoft");
    expect(within(rows[0]!).getByText(n.defaultPill)).toBeTruthy();
    expect(within(rows[0]!).getByText("Group 2")).toBeTruthy();
    expect(within(rows[0]!).queryByText("Group 3")).toBeNull();
    expect(within(rows[0]!).getByText(n.moreChip(4))).toBeTruthy();
    expect(rows[1]!.textContent).not.toContain("9101");
    expect(within(rows[1]!).queryByText(n.defaultPill)).toBeNull();
    expect(within(rows[1]!).getByText(n.notOnPcs)).toBeTruthy();
    expect(rows[2]!.textContent).toContain("Shared printer · print01");
    expect(screen.getByRole("link", { name: n.addPrinterShort }).getAttribute("href")).toBe("/networks/printers/new");
  });

  it("an organization without printers gets one compact row with Add; a viewer gets no Add", () => {
    ui(<Networks />, "admin", "/networks");
    expect(screen.getByText(n.emptyPrinters)).toBeTruthy();
    expect(screen.getByRole("link", { name: n.addPrinterShort })).toBeTruthy();
    cleanup();
    cx.results["networks:list"] = { wifi: [], drivers: [], addedDrivers: [], approvedDrivers: DRIVERS, printers: [front] };
    ui(<Networks />, "viewer", "/networks");
    expect(screen.queryByRole("link", { name: n.addPrinterShort })).toBeNull();
    expect(screen.getByRole("link", { name: "Front desk" })).toBeTruthy();
  });
});

describe("New printer (/networks/printers/new): one address field", () => {
  it("asks for an address and a name in words, and checks the address before it calls the server", async () => {
    const save = vi.fn(async () => ({ id: "p9", revision: 1 }));
    cx.fns["networks:savePrinter"] = save;
    ui(<PrinterEdit />, "admin", "/networks/printers/new");
    submit();
    expect(await screen.findByText(s.addressProblems.empty)).toBeTruthy();
    expect(screen.getByText(s.nameProblems.empty)).toBeTruthy();
    type(s.name, "Front desk");
    type(s.address, "!!!");
    expect(screen.getByText(s.addressNone)).toBeTruthy();
    type(s.address, "ipp://user:pw@10.0.0.1/ipp/print");
    expect(screen.getByText(s.addressProblems.credentials)).toBeTruthy();
    type(s.address, "\\\\print01");
    expect(screen.getByText(s.addressProblems.share)).toBeTruthy();
    type(s.address, `${"h".repeat(49)}:9100`); // a raw host longer than 48 characters
    expect(screen.getByText(s.addressProblems.length)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("reads the connection from the address and says so under the field", () => {
    ui(<PrinterEdit />, "admin", "/networks/printers/new");
    expect(screen.queryByText(/^Connects as/)).toBeNull();
    for (const [text, line] of [
      ["10.0.0.20", s.connectsAs("Network printer (IPP)")],
      ["10.0.0.31:9101", s.connectsAs("Network printer, port 9101")],
      ["10.0.0.32:9100", s.connectsAs("Network printer, port 9100")],
      ["lpr://10.0.0.32/lp", s.connectsAs("Network printer, queue lp")],
      ["\\\\print01\\hp", s.connectsAs("Shared by a server")],
      ["http://10.0.0.5:631/ipp/print", s.connectsAs("Network printer (IPP)")],
    ] as const) {
      type(s.address, text);
      expect(screen.getByText(line), text).toBeTruthy();
    }
  });

  it("sends what the address means, with the driver Automatic picked by the kind; the call carries only what applies", async () => {
    const save = vi.fn(async () => ({ id: "p9", revision: 1 }));
    cx.fns["networks:savePrinter"] = save;
    const make = async (address: string, expected: object) => {
      save.mockClear();
      ui(<PrinterEdit />, "admin", "/networks/printers/new");
      type(s.address, address);
      type(s.name, " Labels ");
      fireEvent.click(screen.getByRole("checkbox", { name: "Group 2" }));
      submit();
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      expect(save).toHaveBeenCalledWith({ name: "Labels", groupIds: ["g2"], defaultForGroupIds: [], ...expected });
      cleanup();
    };
    await make("10.0.0.20", { kind: "ipp", address: "ipp://10.0.0.20/ipp/print", driver: "Microsoft IPP Class Driver" });
    await make("10.0.0.31:9101", { kind: "raw", address: "10.0.0.31", port: 9101, driver: "Microsoft PCL6 Class Driver" });
    await make("lpr://10.0.0.32/lp", { kind: "lpr", address: "10.0.0.32", queue: "lp", driver: "Microsoft PCL6 Class Driver" });
    await make("\\\\print01\\hp", { kind: "share", address: "\\\\print01\\hp", driver: "Microsoft PCL6 Class Driver" });
  });

  it("opens the printer after it is added; 'Make it the default printer' makes it the default in every picked group", async () => {
    const save = vi.fn(async () => ({ id: "p9", revision: 1 }));
    cx.fns["networks:savePrinter"] = save;
    ui(<PrinterEdit />, "admin", "/networks/printers/new");
    type(s.address, "10.0.0.20");
    type(s.name, "Front desk");
    fireEvent.click(screen.getByRole("checkbox", { name: "Group 1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Group 2" }));
    fireEvent.click(screen.getByRole("switch", { name: s.makeDefault }));
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ groupIds: ["g1", "g2"], defaultForGroupIds: ["g1", "g2"] }));
    expect(await screen.findByText(s.created("Front desk"))).toBeTruthy();
    await waitFor(() => expect(where()).toBe("/networks/printers/p9"));
  });

  it("starts with the group ticked when the organization has exactly one", () => {
    cx.results["groups:list"] = [groupRow("g1", "Everyone")];
    ui(<PrinterEdit />, "admin", "/networks/printers/new");
    expect((screen.getByRole("checkbox", { name: "Everyone" }) as HTMLInputElement).checked).toBe(true);
  });

  it("Advanced: a picked connection type stops the guessing and brings its own fields (port for raw, queue for LPR, with the queue error shown)", async () => {
    const save = vi.fn(async () => ({ id: "p9", revision: 1 }));
    cx.fns["networks:savePrinter"] = save;
    ui(<PrinterEdit />, "admin", "/networks/printers/new");
    expect(selectedText(s.connectionType)).toBe(s.automatic);
    expect(screen.queryByLabelText(s.port)).toBeNull();
    expect(screen.queryByLabelText(s.queue)).toBeNull();
    type(s.address, "10.0.0.31");
    type(s.name, "Labels");
    pickOption(s.connectionType, /^Network printer \(port\)/);
    // the same host, now as a raw printer: the address is no longer read, the port has its own field
    expect((screen.getByLabelText(s.address) as HTMLInputElement).value).toBe("10.0.0.31");
    type(s.port, "70000");
    submit();
    expect(await screen.findByText(s.portProblems.range)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    type(s.port, "9101");
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ kind: "raw", address: "10.0.0.31", port: 9101, driver: "Microsoft PCL6 Class Driver" }));

    cleanup();
    save.mockClear();
    ui(<PrinterEdit />, "admin", "/networks/printers/new");
    type(s.address, "10.0.0.32");
    type(s.name, "Laser");
    pickOption(s.connectionType, /^Network printer \(LPR\)/);
    submit();
    expect(await screen.findByText(s.queueProblems.required)).toBeTruthy();
    type(s.queue, "lp");
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ kind: "lpr", queue: "lp", address: "10.0.0.32" }));
    expect((save.mock.calls[0] as unknown[])[0]).not.toHaveProperty("port");
  });

  it("the driver is Automatic unless another is picked from the approved list (delivered names are tagged)", async () => {
    const save = vi.fn(async () => ({ id: "p9", revision: 1 }));
    cx.fns["networks:savePrinter"] = save;
    cx.results["networks:list"] = listOf({ approvedDrivers: [...DRIVERS, "Brother HL-L2350DW series"], drivers: [{ _id: "d1", name: "Brother", provides: ["Brother HL-L2350DW series"] }] });
    ui(<PrinterEdit />, "admin", "/networks/printers/new");
    expect(selectedText(s.driver)).toBe(s.driverAuto);
    fireEvent.click(screen.getByLabelText(s.driver));
    const options = within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent ?? "");
    expect(options[0]).toContain(s.driverAuto);
    for (const name of DRIVERS) expect(options.some((o) => o.includes(name))).toBe(true);
    expect(options.some((o) => o.includes("Brother HL-L2350DW series") && o.includes(s.driverDelivered))).toBe(true);
    expect(options[options.length - 1]).toContain(s.driverOther);
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: /^HP Universal Printing PCL 6/ }));
    type(s.address, "10.0.0.20");
    type(s.name, "Front desk");
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ driver: "HP Universal Printing PCL 6" }));
  });

  it("'Another driver…' adds the typed name to the approved list FIRST, then saves the printer with it; a bad name is refused in words", async () => {
    const calls: string[] = [];
    const approve = vi.fn(async (a: unknown) => {
      calls.push("approve");
      return { addedDrivers: (a as { names: string[] }).names };
    });
    const save = vi.fn(async () => {
      calls.push("save");
      return { id: "p9", revision: 1 };
    });
    cx.fns["networks:setApprovedPrinterDrivers"] = approve;
    cx.fns["networks:savePrinter"] = save;
    cx.results["networks:list"] = listOf({ addedDrivers: ["HP Universal"], approvedDrivers: [...DRIVERS, "HP Universal"] });
    ui(<PrinterEdit />, "admin", "/networks/printers/new");
    type(s.address, "10.0.0.20");
    type(s.name, "Front desk");
    pickOption(s.driver, s.driverOther);
    submit();
    expect(await screen.findByText(n.approvedProblems.empty)).toBeTruthy();
    expect(approve).not.toHaveBeenCalled();
    type(s.driverOtherName, "Canon UFR II");
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(approve).toHaveBeenCalledWith({ names: ["HP Universal", "Canon UFR II"] });
    expect(calls).toEqual(["approve", "save"]);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ driver: "Canon UFR II" }));
  });

  it("'Another driver…' with a name that is already approved does not add it again", async () => {
    const approve = vi.fn(async () => ({ addedDrivers: [] }));
    const save = vi.fn(async () => ({ id: "p9", revision: 1 }));
    cx.fns["networks:setApprovedPrinterDrivers"] = approve;
    cx.fns["networks:savePrinter"] = save;
    ui(<PrinterEdit />, "admin", "/networks/printers/new");
    type(s.address, "10.0.0.20");
    type(s.name, "Front desk");
    pickOption(s.driver, s.driverOther);
    type(s.driverOtherName, "hp universal printing pcl 6");
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(approve).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ driver: "HP Universal Printing PCL 6" }));
  });

  it("a save in more than 10 groups goes to the server; says in words what the server refuses, the driver error even when Advanced is closed", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "driver", detail: "not_approved" }))
      .mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "name", detail: "taken" }))
      .mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "defaultForGroupIds", detail: "taken" }))
      .mockRejectedValueOnce(new ConvexError({ code: "too_large", detail: "printers" }));
    cx.fns["networks:savePrinter"] = save;
    ui(<PrinterEdit />, "admin", "/networks/printers/new");
    type(s.name, "Front desk");
    type(s.address, "ipp://10.0.0.1/ipp/print");
    for (let i = 1; i <= 11; i++) fireEvent.click(screen.getByRole("checkbox", { name: `Group ${i}` }));
    submit();
    expect(await screen.findByText(s.driverRefused)).toBeTruthy();
    expect((save.mock.calls[0] as unknown as [{ groupIds: string[] }])[0].groupIds).toHaveLength(11);
    // the Advanced box opened by itself, so the error is not hidden
    expect(document.querySelector("details.net-adv")!.hasAttribute("open")).toBe(true);
    submit();
    expect(await screen.findByText(s.nameTaken)).toBeTruthy();
    submit();
    expect(await screen.findByText(s.defaultTaken)).toBeTruthy();
    submit();
    expect(await screen.findByText(/at most 100 printers/)).toBeTruthy();
  });

  it("a viewer gets the read-only notice instead of the form", () => {
    ui(<PrinterEdit />, "viewer", "/networks/printers/new");
    expect(screen.getByText(strings.app.readOnly)).toBeTruthy();
    expect(screen.queryByRole("button", { name: s.create })).toBeNull();
  });
});

describe("Printer (/networks/printers/:id)", () => {
  beforeEach(() => {
    cx.results["networks:printerDetail"] = front;
  });

  it("asks networks:printerDetail for the id and shows the address as one field, the detected connection, the defaults and the apply counts", () => {
    ui(<PrinterEdit />, "admin", "/networks/printers/p1");
    expect(cx.queried.find((q) => q.name === "networks:printerDetail")!.args).toEqual({ id: "p1" });
    expect((screen.getByLabelText(s.name) as HTMLInputElement).value).toBe("Front desk");
    expect((screen.getByLabelText(s.address) as HTMLInputElement).value).toBe("ipp://10.0.0.20:631/ipp/print");
    expect(screen.getByText(s.connectsAs("Network printer (IPP)"))).toBeTruthy();
    expect(selectedText(s.driver)).toBe(s.driverAuto);
    expect((screen.getByRole("checkbox", { name: "Group 1" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Group 3" }) as HTMLInputElement).checked).toBe(false);
    // it is the default in one of its two groups: the switch is on, the details are under Advanced
    expect((screen.getByRole("switch", { name: s.makeDefault })).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(s.defaultSome)).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: s.defaultIn("Group 1") }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: s.defaultIn("Group 2") }) as HTMLInputElement).checked).toBe(false);
    const card = screen.getByRole("heading", { name: n.countsTitle }).closest("section")!;
    expect(within(card).getByText(s.applied).nextElementSibling!.textContent).toBe("6");
    expect(within(card).getByText(s.failed).nextElementSibling!.textContent).toBe("1");
    expect(within(card).getByText(n.countsSampled(7))).toBeTruthy();
  });

  it("shows a raw printer's port and a printer on another driver the way it was saved, and saves it unchanged", async () => {
    cx.results["networks:printerDetail"] = { ...front, kind: "raw", address: "10.0.0.31", port: 9101, driver: "Generic / Text Only", defaultForGroupIds: [] };
    const save = vi.fn(async () => ({ id: "p1", revision: 3 }));
    cx.fns["networks:savePrinter"] = save;
    ui(<PrinterEdit />, "admin", "/networks/printers/p1");
    expect((screen.getByLabelText(s.address) as HTMLInputElement).value).toBe("10.0.0.31:9101");
    expect(selectedText(s.driver)).toBe("Generic / Text Only");
    savePrinter();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p1", expectedRevision: 2, kind: "raw", address: "10.0.0.31", port: 9101, driver: "Generic / Text Only", defaultForGroupIds: [] }),
    );
  });

  it("a driver that is no longer on the approved list stays selected and is marked", () => {
    cx.results["networks:printerDetail"] = { ...front, driver: "Old Vendor Driver" };
    ui(<PrinterEdit />, "admin", "/networks/printers/p1");
    expect(selectedText(s.driver)).toBe("Old Vendor Driver");
    fireEvent.click(screen.getByLabelText(s.driver));
    expect(within(screen.getByRole("listbox")).getByRole("option", { name: new RegExp(`^Old Vendor Driver.*${s.driverNotListed}`) })).toBeTruthy();
  });

  it("saves with the id and the revision it holds, and sends the next revision after a save; leaving a group drops its default", async () => {
    const save = vi.fn(async () => ({ id: "p1", revision: 3 }));
    cx.fns["networks:savePrinter"] = save;
    ui(<PrinterEdit />, "admin", "/networks/printers/p1");
    fireEvent.click(screen.getByRole("checkbox", { name: "Group 1" })); // leave the group it is the default of
    expect(screen.queryByRole("checkbox", { name: s.defaultIn("Group 1") })).toBeNull();
    type(s.name, "Front desk 2");
    savePrinter();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ id: "p1", expectedRevision: 2, name: "Front desk 2", groupIds: ["g2"], defaultForGroupIds: [] }));
    expect(await screen.findByText(s.saved)).toBeTruthy();
    type(s.name, "Front desk 3");
    savePrinter();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 3 }));
  });

  it("the per-group defaults under Advanced edit where it is the default", async () => {
    const save = vi.fn(async () => ({ id: "p1", revision: 3 }));
    cx.fns["networks:savePrinter"] = save;
    ui(<PrinterEdit />, "admin", "/networks/printers/p1");
    fireEvent.click(screen.getByRole("checkbox", { name: s.defaultIn("Group 2") }));
    savePrinter();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultForGroupIds: ["g1", "g2"] }));
  });

  it("the stale-edit answer offers a reload; a viewer sees the printer read-only", async () => {
    cx.fns["networks:savePrinter"] = vi.fn().mockRejectedValue(new ConvexError({ code: "stale_edit" }));
    ui(<PrinterEdit />, "admin", "/networks/printers/p1");
    type(s.name, "Changed");
    savePrinter();
    expect(await screen.findByRole("button", { name: strings.common.reload })).toBeTruthy();
    cleanup();
    ui(<PrinterEdit />, "viewer", "/networks/printers/p1");
    expect(screen.getByText(n.readOnly)).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.common.saveChanges })).toBeNull();
    expect(screen.queryByRole("button", { name: s.remove })).toBeNull();
  });

  it("removes the printer after the name is typed, then goes back to the list", async () => {
    const del = vi.fn(async () => null);
    cx.fns["networks:deletePrinter"] = del;
    ui(<PrinterEdit />, "admin", "/networks/printers/p1");
    fireEvent.click(screen.getAllByRole("button", { name: s.remove })[0]!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Front desk" } });
    fireEvent.click(within(dialog).getByRole("button", { name: s.remove }));
    await waitFor(() => expect(del).toHaveBeenCalledWith({ id: "p1" }));
    await waitFor(() => expect(where()).toBe("/networks"));
  });
});