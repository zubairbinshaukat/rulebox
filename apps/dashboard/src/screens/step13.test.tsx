import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { ReactNode } from "react";
import type { Me } from "../data/types";
import { MeContext } from "../lib/member";
import { strings } from "../lib/strings";
import { pickOption } from "../test/select";
import { networksStrings as n } from "./networks/strings";
import { wifiStrings as s } from "./networks/wifiStrings";

// Phase 5 Step 13 screens (Networks cards, WifiEdit with the password in the form; UI pass 2026-11-28) against the LIVE data seam with the Convex React
// hooks mocked: queries answer from `cx.results`, writes call `cx.fns` (convex/networks.test.ts covers the backend).
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
import WifiEdit from "./WifiEdit";

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
            <Route path="/networks/wifi/new" element={node} />
            <Route path="/networks/wifi/:id" element={node} />
          </Routes>
        </MemoryRouter>
      </MeContext.Provider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  cx.results = {};
  cx.queried = [];
  cx.fns = {};
});
afterEach(cleanup);

const groupRow = (id: string, name: string) => ({ _id: id, name, revision: 0, createdAt: 1, devices: { count: 0, more: false }, employees: { count: 0, more: false } });
const GROUPS = Array.from({ length: 12 }, (_, i) => groupRow(`g${i + 1}`, `Group ${i + 1}`));

const counts = { applied: 7, failed: 1, waiting: 2, unsupported: 0, sampled: 10, capped: false };
const shop = {
  _id: "w1",
  name: "Shop floor",
  ssid: "Acme-Staff",
  hidden: false,
  security: "wpa2Wpa3Personal",
  autoConnect: true,
  hasPassphrase: true,
  passphraseSetAt: Date.UTC(2026, 9, 12, 12),
  revision: 3,
  groupCount: 2,
  groups: [{ _id: "g1", name: "Group 1" }, { _id: "g2", name: "Group 2" }],
  groupIds: ["g1", "g2"],
  counts,
};
const where = () => screen.getByTestId("where").textContent;
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const pageText = () => document.body.textContent ?? "";


const SECRET = "tr0ub4dor&3-horse-staple";
const submit = () => fireEvent.click(screen.getByRole("button", { name: s.create }));

describe("Networks page: Wi-Fi cards (networks:list)", () => {
  it("shows each network as a card with its name, a status pill and two group chips, and never a password", () => {
    cx.results["networks:list"] = {
      wifi: [
        { ...shop, groupCount: 7, groups: [1, 2, 3, 4, 5, 6, 7].map((k) => ({ _id: `g${k}`, name: `Group ${k}` })), passphrase: "LEAKED-SECRET-123", sealed: { ct: "LEAKED-BOX" } },
        { ...shop, _id: "w2", name: "Back office", ssid: "Acme-Office", hidden: true, security: "wpa2Personal", hasPassphrase: false, passphraseSetAt: null, groupCount: 0, groups: [] },
        { ...shop, _id: "w3", name: "Guests", ssid: "Guests", security: "open", hasPassphrase: false, passphraseSetAt: null, groupCount: 1, groups: [{ _id: "g9", name: "Lobby" }] },
      ],
      printers: [],
      drivers: [], addedDrivers: [], approvedDrivers: [],
    };
    ui(<Networks />, "admin", "/networks");
    expect(cx.queried.find((q) => q.name === "networks:list")!.args).toEqual({});
    const rows = within(screen.getByRole("list", { name: n.wifiSection })).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    // the whole card is the link to the network
    expect(within(rows[0]!).getByRole("link", { name: "Shop floor" }).getAttribute("href")).toBe("/networks/wifi/w1");
    expect(within(rows[0]!).getByText("Acme-Staff")).toBeTruthy();
    expect(within(rows[0]!).getByText(n.passwordSet)).toBeTruthy();
    // 2 chips and "+5" (groupCount 7)
    expect(within(rows[0]!).getByText("Group 1")).toBeTruthy();
    expect(within(rows[0]!).getByText("Group 2")).toBeTruthy();
    expect(within(rows[0]!).queryByText("Group 3")).toBeNull();
    expect(within(rows[0]!).getByText(n.moreChip(5))).toBeTruthy();
    // no password yet: a warning pill and "not on any PCs"; hidden networks say so
    expect(within(rows[1]!).getByText(n.needsPassword)).toBeTruthy();
    expect(within(rows[1]!).getByText(n.hidden)).toBeTruthy();
    expect(within(rows[1]!).getByText(n.notOnPcs)).toBeTruthy();
    // an open network, whose Wi-Fi name is the card's own name, has no second line
    expect(within(rows[2]!).getByText(n.openNetwork)).toBeTruthy();
    expect(within(rows[2]!).queryByText("Guests", { selector: ".net-rec__sub *" })).toBeNull();
    expect(pageText()).not.toContain("LEAKED");
    // an admin can add: the header button and the small one of the section
    expect(screen.getByRole("link", { name: n.addWifi }).getAttribute("href")).toBe("/networks/wifi/new");
    expect(screen.getByRole("link", { name: n.addWifiShort })).toBeTruthy();
  });

  it("a viewer sees the cards read-only: no Add anywhere", () => {
    cx.results["networks:list"] = { wifi: [shop], printers: [], drivers: [], addedDrivers: [], approvedDrivers: [] };
    ui(<Networks />, "viewer", "/networks");
    expect(screen.getByText(n.readOnly)).toBeTruthy();
    expect(screen.queryByRole("link", { name: n.addWifi })).toBeNull();
    expect(screen.queryByRole("link", { name: n.addWifiShort })).toBeNull();
    expect(screen.getByRole("link", { name: "Shop floor" })).toBeTruthy();
  });

  it("an empty organization gets one compact row per section with the add action (admins only)", () => {
    cx.results["networks:list"] = { wifi: [], printers: [], drivers: [], addedDrivers: [], approvedDrivers: [] };
    ui(<Networks />, "admin", "/networks");
    expect(screen.getByText(n.emptyWifi)).toBeTruthy();
    expect(screen.getByText(n.emptyPrinters)).toBeTruthy();
    expect(screen.getByText(n.emptyDrivers)).toBeTruthy();
    expect(screen.getByRole("link", { name: n.addWifi })).toBeTruthy();
    expect(screen.getByRole("link", { name: n.addWifiShort })).toBeTruthy();
    cleanup();
    ui(<Networks />, "viewer", "/networks");
    expect(screen.getByText(n.emptyWifi)).toBeTruthy();
    expect(screen.queryByRole("link", { name: n.addWifi })).toBeNull();
    expect(screen.queryByRole("link", { name: n.addWifiShort })).toBeNull();
  });

  it("shows a skeleton while loading and the region error with Try again when the query fails", () => {
    ui(<Networks />, "admin", "/networks");
    expect(screen.getByLabelText(n.loadingList)).toBeTruthy();
    cleanup();
    cx.results["networks:list"] = new Error("boom");
    ui(<Networks />, "admin", "/networks");
    expect(screen.getByRole("alert").textContent).toContain(strings.common.regionFailed);
  });
});

describe("New Wi-Fi network (/networks/wifi/new)", () => {
  beforeEach(() => {
    cx.results["groups:list"] = GROUPS;
  });

  it("asks for the Wi-Fi name and the password up front, and checks them before it calls the server", async () => {
    const create = vi.fn(async () => ({ id: "w9", revision: 2 }));
    cx.fns["wifi:createWithPassphrase"] = create;
    ui(<WifiEdit />, "admin", "/networks/wifi/new");
    expect(screen.getByLabelText(s.ssid)).toBeTruthy();
    expect((screen.getByLabelText(s.password) as HTMLInputElement).type).toBe("password");
    expect(screen.getByRole("checkbox", { name: s.openNetwork })).toBeTruthy();
    submit();
    expect(await screen.findByText(s.ssidProblems.empty)).toBeTruthy();
    expect(screen.getByText(s.passphraseProblems.empty)).toBeTruthy();
    type(s.ssid, "Acme");
    type(s.password, "short");
    expect(screen.getByText(s.passphraseProblems.length)).toBeTruthy();
    type(s.password, "pässwörd-123");
    expect(screen.getByText(s.passphraseProblems.chars)).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it("counts the Wi-Fi name in bytes only when it gets long (accents take more than one), refuses control characters and too long names", async () => {
    const create = vi.fn(async () => ({ id: "w9", revision: 2 }));
    cx.fns["wifi:createWithPassphrase"] = create;
    ui(<WifiEdit />, "admin", "/networks/wifi/new");
    type(s.password, SECRET);
    type(s.ssid, "Café");
    expect(screen.queryByTestId("ssid-bytes")).toBeNull();
    type(s.ssid, "é".repeat(13)); // 26 bytes: the counter appears
    expect(screen.getByTestId("ssid-bytes").textContent).toBe(s.ssidBytes(26));
    type(s.ssid, "é".repeat(17)); // 17 characters, 34 bytes
    expect(screen.getByTestId("ssid-bytes").textContent).toBe(s.ssidBytesOver(34));
    submit();
    expect(await screen.findByText(s.ssidProblems.tooLong)).toBeTruthy();
    type(s.ssid, "bad\u0007name");
    expect(screen.getByText(s.ssidProblems.control)).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    type(s.ssid, "é".repeat(16)); // exactly 32 bytes is fine
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });

  it("creates a secured network with its password in ONE call, no separate save, and opens it; the name follows the Wi-Fi name", async () => {
    const create = vi.fn(async () => ({ id: "w9", revision: 2 }));
    const save = vi.fn(async () => ({ id: "w9", revision: 1 }));
    cx.fns["wifi:createWithPassphrase"] = create;
    cx.fns["networks:saveWifi"] = save;
    ui(<WifiEdit />, "admin", "/networks/wifi/new");
    type(s.ssid, "  Acme Guests ");
    // the name in Rulebox is the Wi-Fi name, trimmed, until it is edited
    expect((screen.getByLabelText(s.nameInRulebox) as HTMLInputElement).value).toBe("Acme Guests");
    type(s.password, SECRET);
    pickOption(s.securityType, /^WPA3 only/);
    fireEvent.click(screen.getByRole("switch", { name: s.hiddenLabel }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Group 2" }));
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith({ name: "Acme Guests", ssid: "  Acme Guests ", hidden: true, security: "wpa3Personal", autoConnect: true, groupIds: ["g2"], passphrase: SECRET });
    expect(save).not.toHaveBeenCalled();
    expect(await screen.findByText(s.created("Acme Guests"))).toBeTruthy();
    await waitFor(() => expect(where()).toBe("/networks/wifi/w9"));
    expect(pageText()).not.toContain(SECRET);
  });

  it("an edited name stops following the Wi-Fi name; an open network is a plain save without a password field", async () => {
    const create = vi.fn(async () => ({ id: "w9", revision: 2 }));
    const save = vi.fn(async () => ({ id: "w9", revision: 1 }));
    cx.fns["wifi:createWithPassphrase"] = create;
    cx.fns["networks:saveWifi"] = save;
    ui(<WifiEdit />, "admin", "/networks/wifi/new");
    type(s.ssid, "Lobby");
    type(s.nameInRulebox, "Lobby guests");
    type(s.ssid, "Lobby 2");
    expect((screen.getByLabelText(s.nameInRulebox) as HTMLInputElement).value).toBe("Lobby guests");
    fireEvent.click(screen.getByRole("checkbox", { name: s.openNetwork }));
    expect(screen.queryByLabelText(s.password)).toBeNull();
    expect(screen.getByText(s.openInfo)).toBeTruthy();
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({ name: "Lobby guests", ssid: "Lobby 2", hidden: false, security: "open", autoConnect: true, groupIds: [] });
    expect(create).not.toHaveBeenCalled();
  });

  it("starts with the group ticked when the organization has exactly one", () => {
    cx.results["groups:list"] = [groupRow("g1", "Everyone")];
    ui(<WifiEdit />, "admin", "/networks/wifi/new");
    expect((screen.getByRole("checkbox", { name: "Everyone" }) as HTMLInputElement).checked).toBe(true);
  });

  it("a save in more than 10 groups goes to the server (the server batches them); the form allows up to 100", async () => {
    const create = vi.fn(async () => ({ id: "w9", revision: 2 }));
    cx.fns["wifi:createWithPassphrase"] = create;
    ui(<WifiEdit />, "admin", "/networks/wifi/new");
    type(s.ssid, "Acme");
    type(s.password, SECRET);
    for (let i = 1; i <= 11; i++) fireEvent.click(screen.getByRole("checkbox", { name: `Group ${i}` }));
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect((create.mock.calls[0] as unknown as [{ groupIds: string[] }])[0].groupIds).toHaveLength(11);
    expect(n.groupsOver(100)).toBe("Pick at most 100 groups.");
  });

  it("says in words what the server refuses: too many networks, the Wi-Fi name, the password (under its field), the missing key", async () => {
    cx.fns["wifi:createWithPassphrase"] = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "too_large", detail: "wifi" }))
      .mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "ssid", detail: "characters" }))
      .mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "passphrase", detail: "length" }))
      .mockRejectedValueOnce(new ConvexError({ code: "not_ready", detail: "sealing_key" }));
    ui(<WifiEdit />, "admin", "/networks/wifi/new");
    type(s.ssid, "Acme");
    type(s.password, SECRET);
    submit();
    expect(await screen.findByText(/at most 50 Wi-Fi networks/)).toBeTruthy();
    submit();
    expect(await screen.findByText(s.ssidServerRefused)).toBeTruthy();
    submit();
    expect(await screen.findByText(s.passphraseServerRefused)).toBeTruthy();
    submit();
    expect(await screen.findByText(/encryption key isn't set up/)).toBeTruthy();
    // the typed password stays in its field and is shown nowhere else
    expect((screen.getByLabelText(s.password) as HTMLInputElement).value).toBe(SECRET);
    expect(pageText()).not.toContain(SECRET);
  });

  it("a viewer gets the read-only notice instead of the form", () => {
    ui(<WifiEdit />, "viewer", "/networks/wifi/new");
    expect(screen.getByText(strings.app.readOnly)).toBeTruthy();
    expect(screen.queryByRole("button", { name: s.create })).toBeNull();
  });
});

describe("Wi-Fi network (/networks/wifi/:id)", () => {
  beforeEach(() => {
    cx.results["groups:list"] = GROUPS;
    cx.results["networks:wifiDetail"] = shop;
  });

  it("asks networks:wifiDetail for the id and shows the form, the saved password's status and the apply counts", () => {
    ui(<WifiEdit />, "admin", "/networks/wifi/w1");
    expect(cx.queried.find((q) => q.name === "networks:wifiDetail")!.args).toEqual({ id: "w1" });
    expect((screen.getByLabelText(s.ssid) as HTMLInputElement).value).toBe("Acme-Staff");
    expect((screen.getByLabelText(s.nameInRulebox) as HTMLInputElement).value).toBe("Shop floor");
    expect((screen.getByRole("checkbox", { name: "Group 1" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Group 3" }) as HTMLInputElement).checked).toBe(false);
    // a saved password shows its status and Change, not a field
    expect(screen.getByText(/^Set on /)).toBeTruthy();
    expect(screen.getByRole("button", { name: s.change })).toBeTruthy();
    expect(screen.queryByLabelText(s.password)).toBeNull();
    const card = screen.getByRole("heading", { name: n.countsTitle }).closest("section")!;
    for (const [label, count] of [[s.applied, "7"], [s.waiting, "2"], [s.failed, "1"], [s.unsupported, "0"]] as const) {
      expect(within(card).getByText(label).nextElementSibling!.textContent).toBe(count);
    }
    expect(within(card).getByText(n.countsSampled(10))).toBeTruthy();
    expect(pageText()).not.toMatch(/LEAK/);
  });

  it("says when the counts were cut, and when no PC has reported yet", () => {
    cx.results["networks:wifiDetail"] = { ...shop, counts: { ...counts, sampled: 400, capped: true } };
    ui(<WifiEdit />, "admin", "/networks/wifi/w1");
    expect(screen.getByText(n.countsCapped(400))).toBeTruthy();
    cleanup();
    cx.results["networks:wifiDetail"] = { ...shop, counts: { ...counts, applied: 0, failed: 0, waiting: 0, sampled: 0 } };
    ui(<WifiEdit />, "admin", "/networks/wifi/w1");
    expect(screen.getByText(n.countsNone)).toBeTruthy();
  });

  it("saves with expectedRevision and no password call, then sends the revision the server returned; a stale edit offers Reload", async () => {
    const save = vi.fn().mockResolvedValueOnce({ id: "w1", revision: 4 }).mockRejectedValueOnce(new ConvexError({ code: "stale_edit" }));
    const set = vi.fn(async () => ({ revision: 9 }));
    cx.fns["networks:saveWifi"] = save;
    cx.fns["wifi:setPassphrase"] = set;
    ui(<WifiEdit />, "admin", "/networks/wifi/w1");
    type(s.nameInRulebox, "Shop floor 2");
    fireEvent.click(screen.getByRole("checkbox", { name: "Group 3" }));
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({ id: "w1", expectedRevision: 3, name: "Shop floor 2", ssid: "Acme-Staff", hidden: false, security: "wpa2Wpa3Personal", autoConnect: true, groupIds: ["g1", "g2", "g3"] });
    expect(await screen.findByText(s.saved)).toBeTruthy();
    type(s.nameInRulebox, "Shop floor 3");
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![0]).toMatchObject({ expectedRevision: 4 });
    expect(await screen.findByText(strings.common.staleTitle)).toBeTruthy();
    expect(screen.getByRole("button", { name: strings.common.reload })).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
  });

  it("Change opens the password field; only the password changed means only the password call, with the profile's revision, and the typed text is forgotten", async () => {
    const set = vi.fn(async () => ({ revision: 4 }));
    const save = vi.fn<(a: unknown) => Promise<{ id: string; revision: number }>>(async () => ({ id: "w1", revision: 5 }));
    cx.fns["wifi:setPassphrase"] = set;
    cx.fns["networks:saveWifi"] = save;
    ui(<WifiEdit />, "admin", "/networks/wifi/w1");
    fireEvent.click(screen.getByRole("button", { name: s.change }));
    const field = screen.getByLabelText(s.password) as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(screen.getByText(s.keepEmpty)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.auth.showPassword }));
    expect(field.type).toBe("text");
    type(s.password, "short");
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    expect(await screen.findByText(s.passphraseProblems.length)).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
    type(s.password, SECRET);
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith({ id: "w1", passphrase: SECRET, expectedRevision: 3 });
    expect(save).not.toHaveBeenCalled();
    expect(await screen.findByText(s.saved)).toBeTruthy();
    // the typed text is gone: not in a field, not on the page
    expect(pageText()).not.toContain(SECRET);
    expect(Array.from(document.querySelectorAll("input")).every((i) => !i.value.includes(SECRET))).toBe(true);
    // the next save of the profile uses the revision the action returned
    type(s.nameInRulebox, "Renamed");
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({ expectedRevision: 4 });
    expect(JSON.stringify(save.mock.calls[0]![0])).not.toContain(SECRET);
  });

  it("profile and password changed: two calls in order; when the password fails the network is saved, the text stays and Try again sends only the password", async () => {
    const calls: string[] = [];
    const save = vi.fn(async () => {
      calls.push("save");
      return { id: "w1", revision: 4 };
    });
    const set = vi
      .fn()
      .mockImplementationOnce(async () => {
        calls.push("set");
        throw new ConvexError({ code: "invalid_argument", field: "passphrase", detail: "length" });
      })
      .mockImplementationOnce(async () => {
        calls.push("set");
        return { revision: 5 };
      });
    cx.fns["networks:saveWifi"] = save;
    cx.fns["wifi:setPassphrase"] = set;
    ui(<WifiEdit />, "admin", "/networks/wifi/w1");
    type(s.nameInRulebox, "Shop floor 2");
    fireEvent.click(screen.getByRole("button", { name: s.change }));
    type(s.password, SECRET);
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(["save", "set"]);
    expect(set).toHaveBeenLastCalledWith({ id: "w1", passphrase: SECRET, expectedRevision: 4 });
    expect(await screen.findByText(s.savedNoPassword)).toBeTruthy(); // the toast
    expect(await screen.findByText(s.passphraseServerRefused)).toBeTruthy();
    expect((screen.getByLabelText(s.password) as HTMLInputElement).value).toBe(SECRET);
    expect(pageText()).not.toContain(SECRET);
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenLastCalledWith({ id: "w1", passphrase: SECRET, expectedRevision: 4 });
  });

  it("other password refusals are said in words: the missing key, a stale edit", async () => {
    cx.fns["wifi:setPassphrase"] = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "not_ready", detail: "sealing_key" }))
      .mockRejectedValueOnce(new ConvexError({ code: "stale_edit" }));
    ui(<WifiEdit />, "admin", "/networks/wifi/w1");
    fireEvent.click(screen.getByRole("button", { name: s.change }));
    type(s.password, SECRET);
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    expect(await screen.findByText(/encryption key isn't set up/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    expect(await screen.findByText(strings.common.staleTitle)).toBeTruthy();
    expect(pageText()).not.toContain(SECRET);
  });

  it("ticking 'no password' on a secured network says the saved one is deleted and saves it as open, without a password call", async () => {
    const save = vi.fn(async () => ({ id: "w1", revision: 4 }));
    const set = vi.fn(async () => ({ revision: 9 }));
    cx.fns["networks:saveWifi"] = save;
    cx.fns["wifi:setPassphrase"] = set;
    ui(<WifiEdit />, "admin", "/networks/wifi/w1");
    fireEvent.click(screen.getByRole("checkbox", { name: s.openNetwork }));
    expect(screen.getByText(s.openDeletes)).toBeTruthy();
    expect(screen.queryByRole("button", { name: s.change })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: "w1", security: "open", expectedRevision: 3 }));
    expect(set).not.toHaveBeenCalled();
  });

  it("a secured network without a password says PCs wait for it and shows the field at once; an open one has none", () => {
    cx.results["networks:wifiDetail"] = { ...shop, hasPassphrase: false, passphraseSetAt: null };
    ui(<WifiEdit />, "admin", "/networks/wifi/w1");
    expect(screen.getByText(s.passwordMissing)).toBeTruthy();
    expect(screen.getByLabelText(s.password)).toBeTruthy();
    cleanup();
    cx.results["networks:wifiDetail"] = { ...shop, security: "open", hasPassphrase: false, passphraseSetAt: null };
    ui(<WifiEdit />, "admin", "/networks/wifi/w1");
    expect(screen.queryByLabelText(s.password)).toBeNull();
    expect((screen.getByRole("checkbox", { name: s.openNetwork }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText(s.passwordMissing)).toBeNull();
  });

  it("deleting asks for the name, says the PCs remove the network, then goes back to the list", async () => {
    const del = vi.fn(async () => null);
    cx.fns["networks:deleteWifi"] = del;
    ui(<WifiEdit />, "admin", "/networks/wifi/w1");
    fireEvent.click(screen.getAllByRole("button", { name: s.remove })[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(s.deleteBody)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: s.remove }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Shop floor" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(del).toHaveBeenCalledWith({ id: "w1" }));
    expect(await screen.findByText(s.deleted("Shop floor"))).toBeTruthy();
    await waitFor(() => expect(where()).toBe("/networks"));
  });

  it("a viewer sees the details, the password status and the counts but no form, no Change and no Remove", () => {
    ui(<WifiEdit />, "viewer", "/networks/wifi/w1");
    expect(screen.getByText(n.readOnly)).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.common.saveChanges })).toBeNull();
    expect(screen.queryByRole("button", { name: s.change })).toBeNull();
    expect(screen.queryByRole("button", { name: s.remove })).toBeNull();
    expect(screen.getAllByText("Acme-Staff").length).toBeGreaterThan(0); // header chip and the details list
    expect(screen.getByText(/^Set on /)).toBeTruthy();
    expect(screen.getByRole("heading", { name: n.countsTitle })).toBeTruthy();
  });
});