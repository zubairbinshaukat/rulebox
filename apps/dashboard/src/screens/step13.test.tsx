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

// Phase 5 Step 13 screens (Networks, WifiEdit with the password dialog) against the LIVE data seam with the Convex React
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

describe("Networks list (networks:list)", () => {
  it("lists each network with its SSID, security, group chips and password status, and never a password", () => {
    cx.results["networks:list"] = {
      wifi: [
        { ...shop, groupCount: 7, groups: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ _id: `g${n}`, name: `Group ${n}` })), passphrase: "LEAKED-SECRET-123", sealed: { ct: "LEAKED-BOX" } },
        { ...shop, _id: "w2", name: "Back office", ssid: "Acme-Office", hidden: true, security: "wpa2Personal", hasPassphrase: false, passphraseSetAt: null, groupCount: 0, groups: [] },
        { ...shop, _id: "w3", name: "Guests", ssid: "Acme-Guest", security: "open", hasPassphrase: false, passphraseSetAt: null, groupCount: 1, groups: [{ _id: "g9", name: "Lobby" }] },
      ],
      printers: [],
      approvedDrivers: [],
    };
    ui(<Networks />, "admin", "/networks");
    expect((cx.queried.find((q) => q.name === "networks:list")!.args)).toEqual({});
    const list = screen.getByRole("list", { name: s.wifiSection });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByRole("link", { name: "Shop floor" }).getAttribute("href")).toBe("/networks/wifi/w1");
    expect(within(rows[0]!).getByText("Acme-Staff")).toBeTruthy();
    expect(within(rows[0]!).getByText(/WPA2\/WPA3/)).toBeTruthy();
    // 4 chips and "+3 more" (groupCount 7), password status as a date, never the value
    expect(within(rows[0]!).getAllByRole("link").filter((l) => l.getAttribute("href")?.startsWith("/groups/"))).toHaveLength(4);
    expect(within(rows[0]!).getByText(s.moreGroups(3))).toBeTruthy();
    expect(within(rows[0]!).getByText(/Password set/)).toBeTruthy();
    expect(within(rows[1]!).getByText(s.hidden)).toBeTruthy();
    expect(within(rows[1]!).getByText(s.passphraseNone)).toBeTruthy();
    expect(within(rows[1]!).getByText(s.noGroups)).toBeTruthy();
    expect(within(rows[2]!).getByText(s.passphraseNotNeeded)).toBeTruthy();
    expect(pageText()).not.toContain("LEAKED");
    // an admin can add and edit
    expect(screen.getAllByRole("link", { name: s.newWifi }).length).toBeGreaterThan(0);
    expect(within(rows[0]!).getByRole("link", { name: `${s.edit} Shop floor` })).toBeTruthy();
  });

  it("a viewer sees the list read-only: no New, no Edit", () => {
    cx.results["networks:list"] = { wifi: [shop], printers: [], approvedDrivers: [] };
    ui(<Networks />, "viewer", "/networks");
    expect(screen.getByText(s.readOnly)).toBeTruthy();
    expect(screen.queryByRole("link", { name: s.newWifi })).toBeNull();
    expect(screen.queryByRole("link", { name: `${s.edit} Shop floor` })).toBeNull();
    expect(screen.getByRole("link", { name: "Shop floor" })).toBeTruthy();
  });

  it("an empty organization gets the empty state with the add action (admins only)", () => {
    cx.results["networks:list"] = { wifi: [], printers: [], approvedDrivers: [] };
    ui(<Networks />, "admin", "/networks");
    expect(screen.getByText(s.emptyTitle)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: s.newWifi })).toHaveLength(2);
    cleanup();
    ui(<Networks />, "viewer", "/networks");
    expect(screen.getByText(s.emptyTitle)).toBeTruthy();
    expect(screen.queryByRole("link", { name: s.newWifi })).toBeNull();
  });

  it("shows a skeleton while loading and the region error with Try again when the query fails", () => {
    ui(<Networks />, "admin", "/networks");
    expect(screen.getByLabelText(s.loadingList)).toBeTruthy();
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

  it("has no password field; asks for a name and an SSID before it calls the server", async () => {
    const save = vi.fn(async () => ({ id: "w9", revision: 1 }));
    cx.fns["networks:saveWifi"] = save;
    ui(<WifiEdit />, "admin", "/networks/wifi/new");
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.getByText(s.noPassphraseInForm)).toBeTruthy();
    expect(screen.getByText(s.securityHelp.wpa2Wpa3Personal)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: s.create }));
    expect(await screen.findByText(s.nameProblem(60))).toBeTruthy();
    expect(screen.getByText(s.ssidProblems.empty)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("counts the SSID in bytes (accents take more than one), refuses control characters and too long names", async () => {
    const save = vi.fn(async () => ({ id: "w9", revision: 1 }));
    cx.fns["networks:saveWifi"] = save;
    ui(<WifiEdit />, "admin", "/networks/wifi/new");
    type(s.name, "Shop");
    type(s.ssid, "Café");
    expect(screen.getByTestId("ssid-bytes").textContent).toBe(s.ssidBytes(5));
    type(s.ssid, "é".repeat(17)); // 17 characters, 34 bytes
    expect(screen.getByTestId("ssid-bytes").textContent).toBe(s.ssidBytesOver(34));
    fireEvent.click(screen.getByRole("button", { name: s.create }));
    expect(await screen.findByText(s.ssidProblems.tooLong)).toBeTruthy();
    type(s.ssid, "bad\u0007name");
    expect(screen.getByText(s.ssidProblems.control)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    type(s.ssid, "é".repeat(16)); // exactly 32 bytes is fine
    fireEvent.click(screen.getByRole("button", { name: s.create }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });

  it("creates the network without an id or a password and opens it (secured: the toast says to set the password)", async () => {
    const save = vi.fn(async () => ({ id: "w9", revision: 1 }));
    cx.fns["networks:saveWifi"] = save;
    ui(<WifiEdit />, "admin", "/networks/wifi/new");
    type(s.name, "  Guests ");
    type(s.ssid, "Acme Guests");
    fireEvent.change(screen.getByLabelText(s.security), { target: { value: "wpa3Personal" } });
    fireEvent.click(screen.getByRole("switch", { name: s.hiddenLabel }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Group 2" }));
    fireEvent.click(screen.getByRole("button", { name: s.create }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({ name: "Guests", ssid: "Acme Guests", hidden: true, security: "wpa3Personal", autoConnect: true, groupIds: ["g2"] });
    expect(await screen.findByText(s.created("Guests"))).toBeTruthy();
    await waitFor(() => expect(where()).toBe("/networks/wifi/w9"));
  });

  it("refuses a save that touches more than 10 groups, in words, before calling the server", async () => {
    const save = vi.fn(async () => ({ id: "w9", revision: 1 }));
    cx.fns["networks:saveWifi"] = save;
    ui(<WifiEdit />, "admin", "/networks/wifi/new");
    type(s.name, "Shop");
    type(s.ssid, "Acme");
    for (let i = 1; i <= 11; i++) fireEvent.click(screen.getByRole("checkbox", { name: `Group ${i}` }));
    expect(screen.getByText(s.groupsTouched(11, 10))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: s.create }));
    expect(await screen.findByText(s.groupsOver(10))).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("says in words when the server refuses too many groups or too many networks", async () => {
    cx.fns["networks:saveWifi"] = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "too_large", detail: "wifi" }))
      .mockRejectedValueOnce(new ConvexError({ code: "too_large", detail: "groups" }))
      .mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "ssid", detail: "characters" }));
    ui(<WifiEdit />, "admin", "/networks/wifi/new");
    type(s.name, "Shop");
    type(s.ssid, "Acme");
    fireEvent.click(screen.getByRole("button", { name: s.create }));
    expect(await screen.findByText(/at most 50 Wi-Fi networks/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: s.create }));
    expect(await screen.findByText(/can touch at most 10 groups/)).toBeTruthy();
    // a server refusal about the SSID goes under the field, in our words
    fireEvent.click(screen.getByRole("button", { name: s.create }));
    expect(await screen.findByText(s.ssidServerRefused)).toBeTruthy();
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

  it("asks networks:wifiDetail for the id and shows the form, the password status and the apply counts", () => {
    ui(<WifiEdit />, "admin", "/networks/wifi/w1");
    expect(cx.queried.find((q) => q.name === "networks:wifiDetail")!.args).toEqual({ id: "w1" });
    expect((screen.getByLabelText(s.name) as HTMLInputElement).value).toBe("Shop floor");
    expect((screen.getByLabelText(s.ssid) as HTMLInputElement).value).toBe("Acme-Staff");
    expect((screen.getByRole("checkbox", { name: "Group 1" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Group 3" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/^Set on /)).toBeTruthy();
    const card = screen.getByRole("heading", { name: s.countsTitle }).closest("section")!;
    for (const [label, n] of [[s.applied, "7"], [s.waiting, "2"], [s.failed, "1"], [s.unsupported, "0"]] as const) {
      expect(within(card).getByText(label).nextElementSibling!.textContent).toBe(n);
    }
    expect(within(card).getByText(s.countsSampled(10))).toBeTruthy();
    expect(pageText()).not.toMatch(/LEAK/);
  });

  it("says when the counts were cut, and when no PC has reported yet", () => {
    cx.results["networks:wifiDetail"] = { ...shop, counts: { ...counts, sampled: 400, capped: true } };
    ui(<WifiEdit />, "admin", "/networks/wifi/w1");
    expect(screen.getByText(s.countsCapped(400))).toBeTruthy();
    cleanup();
    cx.results["networks:wifiDetail"] = { ...shop, counts: { ...counts, applied: 0, failed: 0, waiting: 0, sampled: 0 } };
    ui(<WifiEdit />, "admin", "/networks/wifi/w1");
    expect(screen.getByText(s.countsNone)).toBeTruthy();
  });

  it("saves with expectedRevision, then sends the revision the server returned; a stale edit offers Reload", async () => {
    const save = vi.fn().mockResolvedValueOnce({ id: "w1", revision: 4 }).mockRejectedValueOnce(new ConvexError({ code: "stale_edit" }));
    cx.fns["networks:saveWifi"] = save;
    ui(<WifiEdit />, "admin", "/networks/wifi/w1");
    type(s.name, "Shop floor 2");
    fireEvent.click(screen.getByRole("checkbox", { name: "Group 3" }));
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({ id: "w1", expectedRevision: 3, name: "Shop floor 2", ssid: "Acme-Staff", hidden: false, security: "wpa2Wpa3Personal", autoConnect: true, groupIds: ["g1", "g2", "g3"] });
    expect(await screen.findByText(s.saved)).toBeTruthy();
    type(s.name, "Shop floor 3");
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![0]).toMatchObject({ expectedRevision: 4 });
    expect(await screen.findByText(strings.common.staleTitle)).toBeTruthy();
    expect(screen.getByRole("button", { name: strings.common.reload })).toBeTruthy();
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

  it("a viewer sees the details, the status and the counts but no form, no Replace and no Remove", () => {
    ui(<WifiEdit />, "viewer", "/networks/wifi/w1");
    expect(screen.getByText(s.readOnly)).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.common.saveChanges })).toBeNull();
    expect(screen.queryByRole("button", { name: s.replacePassphrase })).toBeNull();
    expect(screen.queryByRole("button", { name: s.remove })).toBeNull();
    expect(screen.getAllByText("Acme-Staff").length).toBeGreaterThan(0); // header chip and the details list
    expect(screen.getByText(/^Set on /)).toBeTruthy();
    expect(screen.getByRole("heading", { name: s.countsTitle })).toBeTruthy();
  });

  it("an open network has no password to set; a secured one without a password says PCs wait for it", () => {
    cx.results["networks:wifiDetail"] = { ...shop, security: "open", hasPassphrase: false, passphraseSetAt: null };
    ui(<WifiEdit />, "admin", "/networks/wifi/w1");
    expect(screen.getByText(s.passphraseOpen)).toBeTruthy();
    expect(screen.queryByRole("button", { name: s.setPassphrase })).toBeNull();
    expect(screen.queryByRole("button", { name: s.replacePassphrase })).toBeNull();
    cleanup();
    cx.results["networks:wifiDetail"] = { ...shop, hasPassphrase: false, passphraseSetAt: null };
    ui(<WifiEdit />, "admin", "/networks/wifi/w1");
    expect(screen.getByText(s.passphraseNotSet)).toBeTruthy();
    expect(screen.getByRole("button", { name: s.setPassphrase })).toBeTruthy();
  });
});

describe("Replace password dialog (wifi:setPassphrase)", () => {
  const SECRET = "tr0ub4dor&3-horse-staple";

  beforeEach(() => {
    cx.results["groups:list"] = GROUPS;
    cx.results["networks:wifiDetail"] = shop;
  });

  async function openDialog() {
    ui(<WifiEdit />, "admin", "/networks/wifi/w1");
    fireEvent.click(screen.getByRole("button", { name: s.replacePassphrase }));
    return await screen.findByRole("dialog");
  }

  it("is a masked input with a show/hide toggle and checks the rule before it calls the server", async () => {
    const set = vi.fn(async () => ({ revision: 4 }));
    cx.fns["wifi:setPassphrase"] = set;
    const dialog = await openDialog();
    const field = within(dialog).getByLabelText(s.passphraseField) as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.click(within(dialog).getByRole("button", { name: strings.auth.showPassword }));
    expect(field.type).toBe("text");
    fireEvent.change(field, { target: { value: "short" } });
    fireEvent.click(within(dialog).getByRole("button", { name: s.replacePassphrase }));
    expect(await within(dialog).findByText(s.passphraseProblems.length)).toBeTruthy();
    fireEvent.change(field, { target: { value: "pässwörd-123" } });
    expect(within(dialog).getByText(s.passphraseProblems.chars)).toBeTruthy();
    fireEvent.change(field, { target: { value: "x".repeat(64) } }); // 64 characters that are not all hex: too long
    expect(within(dialog).getByText(s.passphraseProblems.length)).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "a".repeat(63) } }); // 63 printable characters
    expect(within(dialog).queryByText(s.passphraseProblems.length)).toBeNull();
  });

  it("sends the password only to the action, with the profile's revision; then closes and forgets it: not in the DOM, not in a toast", async () => {
    const set = vi.fn(async () => ({ revision: 4 }));
    const save = vi.fn<(a: unknown) => Promise<{ id: string; revision: number }>>(async () => ({ id: "w1", revision: 5 }));
    cx.fns["wifi:setPassphrase"] = set;
    cx.fns["networks:saveWifi"] = save;
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText(s.passphraseField), { target: { value: SECRET } });
    fireEvent.click(within(dialog).getByRole("button", { name: s.replacePassphrase }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith({ id: "w1", passphrase: SECRET, expectedRevision: 3 });
    expect(await screen.findByText(s.passphraseSaved)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(pageText()).not.toContain(SECRET);
    expect(Array.from(document.querySelectorAll("input")).every((i) => !i.value.includes(SECRET))).toBe(true);
    // the next save of the profile uses the revision the action returned, and carries no password
    fireEvent.click(screen.getByRole("button", { name: strings.common.saveChanges }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({ expectedRevision: 4 });
    expect(JSON.stringify(save.mock.calls[0]![0])).not.toContain(SECRET);
    // opening the dialog again starts empty
    fireEvent.click(screen.getByRole("button", { name: s.replacePassphrase }));
    const again = await screen.findByRole("dialog");
    expect((within(again).getByLabelText(s.passphraseField) as HTMLInputElement).value).toBe("");
  });

  it("closing with Cancel drops what was typed", async () => {
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText(s.passphraseField), { target: { value: SECRET } });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.common.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(pageText()).not.toContain(SECRET);
  });

  it("a server refusal is shown in our words under the field, never the typed text; other errors keep the dialog open", async () => {
    cx.fns["wifi:setPassphrase"] = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ code: "invalid_argument", field: "passphrase", detail: "length" }))
      .mockRejectedValueOnce(new ConvexError({ code: "not_ready", detail: "sealing_key" }))
      .mockRejectedValueOnce(new ConvexError({ code: "stale_edit" }));
    const dialog = await openDialog();
    const field = within(dialog).getByLabelText(s.passphraseField);
    fireEvent.change(field, { target: { value: SECRET } });
    const submit = () => fireEvent.click(within(dialog).getByRole("button", { name: s.replacePassphrase }));
    submit();
    expect(await within(dialog).findByText(s.passphraseServerRefused)).toBeTruthy();
    submit();
    expect(await within(dialog).findByText(/encryption key isn't set up/)).toBeTruthy();
    submit();
    expect(await within(dialog).findByText(strings.common.staleTitle)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    // the typed text is only ever the input's value: no sentence, notice or toast repeats it
    expect(pageText()).not.toContain(SECRET);
    expect((within(dialog).getByLabelText(s.passphraseField) as HTMLInputElement).value).toBe(SECRET);
  });

  it("an unset password offers Set, not Replace", async () => {
    cx.results["networks:wifiDetail"] = { ...shop, hasPassphrase: false, passphraseSetAt: null };
    ui(<WifiEdit />, "admin", "/networks/wifi/w1");
    fireEvent.click(screen.getByRole("button", { name: s.setPassphrase }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: s.passphraseTitleSet })).toBeTruthy();
  });
});
