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

// Phase 5 Step 14 screens (the Printers card of Networks, PrinterEdit) against the LIVE data seam with the Convex React hooks
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

describe("Printers on the Networks list", () => {
  it("lists each printer with its kind, address, driver, default badge and group chips; an admin can add and edit", () => {
    cx.results["networks:list"] = {
      wifi: [],
      drivers: [], addedDrivers: [], approvedDrivers: DRIVERS,
      printers: [
        { ...front, groupCount: 6, groups: [1, 2, 3, 4, 5, 6].map((n) => ({ _id: `g${n}`, name: `Group ${n}` })) },
        { ...front, _id: "p2", name: "Labels", kind: "raw", address: "10.0.0.31", port: 9101, driver: "Generic / Text Only", groupCount: 0, defaultGroupCount: 0, groups: [] },
        { ...front, _id: "p3", name: "Laser", kind: "lpr", address: "10.0.0.32", queue: "lp", groupCount: 1, defaultGroupCount: 0, groups: [{ _id: "g9", name: "Lobby" }] },
      ],
    };
    ui(<Networks />, "admin", "/networks");
    const rows = within(screen.getByRole("list", { name: s.printersSection })).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByRole("link", { name: "Front desk" }).getAttribute("href")).toBe("/networks/printers/p1");
    expect(within(rows[0]!).getByText("ipp://10.0.0.20:631/ipp/print")).toBeTruthy();
    expect(within(rows[0]!).getByText(s.defaultBadge(1))).toBeTruthy();
    expect(within(rows[0]!).getAllByRole("link").filter((l) => l.getAttribute("href")?.startsWith("/groups/"))).toHaveLength(4);
    expect(within(rows[0]!).getByText(s.moreGroups(2))).toBeTruthy();
    expect(within(rows[1]!).getByText(":9101")).toBeTruthy();
    expect(within(rows[1]!).getByText(s.noGroups)).toBeTruthy();
    expect(within(rows[2]!).getByText("/ lp")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: s.newPrinter }).length).toBeGreaterThan(0);
    expect(within(rows[0]!).getByRole("link", { name: `${s.edit} Front desk` })).toBeTruthy();
  });

  it("an organization without printers gets the empty state with the add action; a viewer gets neither Add nor Edit", () => {
    ui(<Networks />, "admin", "/networks");
    expect(screen.getByText(s.emptyPrintersTitle)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: s.newPrinter })).toHaveLength(2);
    cleanup();
    cx.results["networks:list"] = { wifi: [], drivers: [], addedDrivers: [], approvedDrivers: DRIVERS, printers: [front] };
    ui(<Networks />, "viewer", "/networks");
    expect(screen.queryByRole("link", { name: s.newPrinter })).toBeNull();
    expect(screen.queryByRole("link", { name: `${s.edit} Front desk` })).toBeNull();
    expect(screen.getByRole("link", { name: "Front desk" })).toBeTruthy();
  });
});

describe("New printer (/networks/printers/new)", () => {
  it("asks for a name and an address before it calls the server, in words", async () => {
    const save = vi.fn(async () => ({ id: "p9", revision: 1 }));
    cx.fns["networks:savePrinter"] = save;
    ui(<PrinterEdit />, "admin", "/networks/printers/new");
    expect(screen.getByText(s.driverHint)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: s.createPrinter }));
    expect(await screen.findByText(s.printerNameProblems.empty)).toBeTruthy();
    expect(screen.getByText(s.addressProblems.empty)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    type(s.name, "Front desk");
    type(s.addressLabel.ipp, "http://10.0.0.1/ipp/print");
    expect(screen.getByText(s.addressProblems.scheme)).toBeTruthy();
    type(s.addressLabel.ipp, "ipp://user:pw@10.0.0.1/ipp/print");
    expect(screen.getByText(s.addressProblems.credentials)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("the form follows the kind: a port for raw, a queue for LPR, a shared name for a share; the call carries only what applies", async () => {
    const save = vi.fn(async () => ({ id: "p9", revision: 1 }));
    cx.fns["networks:savePrinter"] = save;
    ui(<PrinterEdit />, "admin", "/networks/printers/new");
    expect(screen.queryByLabelText(s.port)).toBeNull();
    expect(screen.queryByLabelText(s.queue)).toBeNull();
    fireEvent.change(screen.getByLabelText(s.kindLabel), { target: { value: "raw" } });
    type(s.name, " Labels ");
    type(s.addressLabel.raw, "10.0.0.31");
    type(s.port, "70000");
    fireEvent.click(screen.getByRole("button", { name: s.createPrinter }));
    expect(await screen.findByText(s.portProblems.range)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    type(s.port, "9101");
    fireEvent.change(screen.getByLabelText(s.driverLabel), { target: { value: "Generic / Text Only" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Group 2" }));
    fireEvent.click(screen.getByRole("checkbox", { name: s.defaultIn("Group 2") }));
    fireEvent.click(screen.getByRole("button", { name: s.createPrinter }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({
      name: "Labels",
      kind: "raw",
      address: "10.0.0.31",
      port: 9101,
      driver: "Generic / Text Only",
      groupIds: ["g2"],
      defaultForGroupIds: ["g2"],
    });
    expect(await screen.findByText(s.printerCreated("Labels"))).toBeTruthy();
    await waitFor(() => expect(where()).toBe("/networks/printers/p9"));

    cleanup();
    save.mockClear();
    ui(<PrinterEdit />, "admin", "/networks/printers/new");
    fireEvent.change(screen.getByLabelText(s.kindLabel), { target: { value: "lpr" } });
    type(s.name, "Laser");
    type(s.addressLabel.lpr, "10.0.0.32");
    fireEvent.click(screen.getByRole("button", { name: s.createPrinter }));
    expect(await screen.findByText(s.queueProblems.required)).toBeTruthy();
    type(s.queue, "lp");
    fireEvent.click(screen.getByRole("button", { name: s.createPrinter }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ kind: "lpr", queue: "lp", address: "10.0.0.32" }));
    expect((save.mock.calls[0] as unknown[])[0]).not.toHaveProperty("port");

    cleanup();
    save.mockClear();
    ui(<PrinterEdit />, "admin", "/networks/printers/new");
    fireEvent.change(screen.getByLabelText(s.kindLabel), { target: { value: "share" } });
    type(s.name, "Shared");
    type(s.addressLabel.share, "print01\\hp");
    fireEvent.click(screen.getByRole("button", { name: s.createPrinter }));
    expect(await screen.findByText(s.addressProblems.share)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    type(s.addressLabel.share, "\\\\print01\\hp");
    fireEvent.click(screen.getByRole("button", { name: s.createPrinter }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ kind: "share", address: "\\\\print01\\hp" }));
  });

  it("offers the approved drivers only (the inbox ones and what the organization added), with the 'already on the PC' note", () => {
    ui(<PrinterEdit />, "admin", "/networks/printers/new");
    const options = within(screen.getByLabelText(s.driverLabel)).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(DRIVERS);
    expect(screen.getByText(/delivered by a Drivers entry/)).toBeTruthy();
  });

  it("refuses a save that touches more than 10 groups before calling the server; says in words what the server refuses", async () => {
    const save = vi.fn().mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "driver", detail: "not_approved" }))
      .mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "name", detail: "taken" }))
      .mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "defaultForGroupIds", detail: "taken" }))
      .mockRejectedValueOnce(new ConvexError({ code: "too_large", detail: "printers" }));
    cx.fns["networks:savePrinter"] = save;
    ui(<PrinterEdit />, "admin", "/networks/printers/new");
    type(s.name, "Front desk");
    type(s.addressLabel.ipp, "ipp://10.0.0.1/ipp/print");
    for (let i = 1; i <= 11; i++) fireEvent.click(screen.getByRole("checkbox", { name: `Group ${i}` }));
    expect(screen.getByText(s.groupsTouched(11, 10))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: s.createPrinter }));
    expect(await screen.findByText(s.groupsOver(10))).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Group 11" }));
    fireEvent.click(screen.getByRole("button", { name: s.createPrinter }));
    expect(await screen.findByText(s.driverRefused)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: s.createPrinter }));
    expect(await screen.findByText(s.nameTaken)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: s.createPrinter }));
    expect(await screen.findByText(s.defaultTaken)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: s.createPrinter }));
    expect(await screen.findByText(/at most 100 printers/)).toBeTruthy();
  });

  it("a viewer gets the read-only notice instead of the form", () => {
    ui(<PrinterEdit />, "viewer", "/networks/printers/new");
    expect(screen.getByText(strings.app.readOnly)).toBeTruthy();
    expect(screen.queryByRole("button", { name: s.createPrinter })).toBeNull();
  });
});

describe("Printer (/networks/printers/:id)", () => {
  beforeEach(() => {
    cx.results["networks:printerDetail"] = front;
  });

  it("asks networks:printerDetail for the id and shows the form, the defaults and the apply counts", () => {
    ui(<PrinterEdit />, "admin", "/networks/printers/p1");
    expect(cx.queried.find((q) => q.name === "networks:printerDetail")!.args).toEqual({ id: "p1" });
    expect((screen.getByLabelText(s.name) as HTMLInputElement).value).toBe("Front desk");
    expect((screen.getByLabelText(s.addressLabel.ipp) as HTMLInputElement).value).toBe("ipp://10.0.0.20:631/ipp/print");
    expect((screen.getByRole("checkbox", { name: "Group 1" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Group 3" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: s.defaultIn("Group 1") }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: s.defaultIn("Group 2") }) as HTMLInputElement).checked).toBe(false);
    const card = screen.getByRole("heading", { name: s.countsTitle }).closest("section")!;
    expect(within(card).getByText(s.printerApplied).nextElementSibling!.textContent).toBe("6");
    expect(within(card).getByText(s.printerFailed).nextElementSibling!.textContent).toBe("1");
    expect(within(card).getByText(s.countsSampled(7))).toBeTruthy();
  });

  it("a driver that is no longer on the approved list stays selectable and is marked", () => {
    cx.results["networks:printerDetail"] = { ...front, driver: "Old Vendor Driver" };
    ui(<PrinterEdit />, "admin", "/networks/printers/p1");
    expect((screen.getByLabelText(s.driverLabel) as HTMLSelectElement).value).toBe("Old Vendor Driver");
    expect(screen.getByRole("option", { name: `Old Vendor Driver (${s.driverNotListed})` })).toBeTruthy();
  });

  it("saves with the id and the revision it holds, and sends the next revision after a save; leaving a group drops its default", async () => {
    const save = vi.fn(async () => ({ id: "p1", revision: 3 }));
    cx.fns["networks:savePrinter"] = save;
    ui(<PrinterEdit />, "admin", "/networks/printers/p1");
    fireEvent.click(screen.getByRole("checkbox", { name: "Group 1" })); // leave the group it is the default of
    expect(screen.queryByRole("checkbox", { name: s.defaultIn("Group 1") })).toBeNull();
    type(s.name, "Front desk 2");
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "p1", expectedRevision: 2, name: "Front desk 2", groupIds: ["g2"], defaultForGroupIds: [] }),
    );
    expect(await screen.findByText(s.printerSaved)).toBeTruthy();
    type(s.name, "Front desk 3");
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 3 }));
  });

  it("the stale-edit answer offers a reload; a viewer sees the printer read-only", async () => {
    cx.fns["networks:savePrinter"] = vi.fn().mockRejectedValue(new ConvexError({ code: "stale_edit" }));
    ui(<PrinterEdit />, "admin", "/networks/printers/p1");
    type(s.name, "Changed");
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    expect(await screen.findByRole("button", { name: strings.common.reload })).toBeTruthy();
    cleanup();
    ui(<PrinterEdit />, "viewer", "/networks/printers/p1");
    expect(screen.getByText(s.readOnly)).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.common.saveChanges })).toBeNull();
    expect(screen.queryByRole("button", { name: s.removePrinter })).toBeNull();
  });

  it("removes the printer after the name is typed, then goes back to the list", async () => {
    const del = vi.fn(async () => null);
    cx.fns["networks:deletePrinter"] = del;
    ui(<PrinterEdit />, "admin", "/networks/printers/p1");
    fireEvent.click(screen.getAllByRole("button", { name: s.removePrinter })[0]!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Front desk" } });
    fireEvent.click(within(dialog).getByRole("button", { name: s.removePrinter }));
    await waitFor(() => expect(del).toHaveBeenCalledWith({ id: "p1" }));
    await waitFor(() => expect(where()).toBe("/networks"));
  });
});
