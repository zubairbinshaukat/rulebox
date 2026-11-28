import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { ReactNode } from "react";
import {
  DEFAULT_LOCKDOWN_SETTINGS,
  type ApplyReport,
  type DevicePage,
  type ExceptionRow,
  type FindingRow,
  type LayerState,
  type LockdownSettings,
  type LockdownView,
  type LockdownWarnings,
  type Me,
} from "../data/types";
import { LAYER_DETAILS, REFUSAL_CODES, REFUSALS, layerDetailText, layerNoteOf, layerStateOf, protectionGaps, refusalText } from "./lockdown/codes";
import { allowKinds, changedLayers, folderProblem, lockoutDraftOf, lockoutProblems, sameSettings, settingsOf } from "./lockdown/rules";
import { MeContext } from "../lib/member";
import { optionLabels, pickOption } from "../test/select";
import { groupStrings } from "../lib/screenStrings/group";
import { strings } from "../lib/strings";
import { deviceLockdownStrings as ds } from "./lockdown/deviceStrings";
import { EVERYONE, findingsStrings as fs, lockdownErrorMessage, lockdownStrings as s } from "./lockdown/strings";
import { overviewLockdownStrings } from "./overview/strings";

// Phase 5 Step 19 screens (group lockdown, findings, the device page's Protection / Lockdown / USB cards, the overview warnings)
// against the LIVE data seam with the Convex React hooks mocked, like step16.test.tsx.
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
import Findings from "./Findings";
import GroupDetail from "./GroupDetail";
import Lockdown from "./Lockdown";
import Overview from "./Overview";
import { LockdownCard, ProtectionCard, UsbAllowCard } from "./lockdown/DeviceCards";

const admin: Me = {
  email: "admin@x.test",
  role: "admin",
  status: "active",
  orgId: "org",
  orgName: "Acme Pharmacy",
  pin: { required: true, set: true },
  serverApiVersion: 1,
};

function ui(node: ReactNode, role: Me["role"] = "admin", path = "/groups/g1/lockdown") {
  return render(
    <ToastProvider>
      <MeContext.Provider value={{ ...admin, role }}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/groups/:id/lockdown" element={node} />
            <Route path="/groups/:id" element={node} />
            <Route path="*" element={node} />
          </Routes>
        </MemoryRouter>
      </MeContext.Provider>
    </ToastProvider>,
  );
}

const NOW = Date.now();
const DAY = 86_400_000;
const D = DEFAULT_LOCKDOWN_SETTINGS;

const exception = (over: Partial<ExceptionRow> = {}): ExceptionRow => ({
  _id: "e1",
  rule: { kind: "publisher", subject: "Contoso Ltd", product: "Tool", fileName: "tool.exe", hashStart: null, path: null },
  appName: null,
  reason: "Needed by sales",
  createdAt: NOW - DAY,
  ...over,
});

const view = (over: Partial<LockdownView> = {}): LockdownView => ({
  groupName: "Pharmacy counter",
  settings: D,
  revision: 3,
  auditSince: NOW - 2 * DAY,
  exceptions: [],
  exceptionsTruncated: false,
  openFindings: 0,
  openFindingsMore: false,
  ...over,
});

const finding = (over: Partial<FindingRow> = {}): FindingRow => ({
  _id: "f1",
  layer: "appLocker",
  fileName: "tool.exe",
  folderClass: "userProfile",
  signer: "Contoso Ltd",
  product: "Tool",
  hasHash: true,
  deviceCount: 3,
  firstSeenAt: NOW - 3 * DAY,
  lastSeenAt: NOW - 3_600_000,
  status: "new",
  ...over,
});
const page = (rows: FindingRow[], isDone = true, continueCursor = "") => ({ page: rows, isDone, continueCursor });

const layer = (mode: string, state = "ok", detail?: string): LayerState => (detail === undefined ? { mode, state } : { mode, state, detail });
const apply = (over: Partial<Omit<ApplyReport, "layers">> & { layers?: Partial<ApplyReport["layers"]> } = {}): ApplyReport => ({
  state: "applied",
  refusal: null,
  appliedVersion: 8,
  lkgVersion: 7,
  configVersion: 5,
  updatedAt: NOW - 60_000,
  ...over,
  layers: { staff: layer("on"), machine: layer("on"), appLocker: layer("audit"), appControl: layer("audit"), procWatch: layer("audit"), boot: layer("on"), performance: layer("on"), ...over.layers },
});
/** What the device page's lockdown cards read of a PC (they get it from `fleet:page`, `useDevicePage`). */
type CardPc = Pick<DevicePage, "_id" | "revoked" | "usbAllowUntil" | "protection" | "lockdownCapable" | "apply" | "report">;
/** Renders one of the device page's lockdown cards over that PC. */
const cardOf = (node: (d: CardPc) => ReactNode, over: Partial<CardPc> = {}, role: Me["role"] = "admin") => {
  const d: CardPc = { _id: "d1", revoked: false, usbAllowUntil: null, protection: null, lockdownCapable: true, apply: null, report: null, ...over };
  return ui(node(d), role, "/devices/d1");
};const byLabel = (within_: HTMLElement, label: string) => within(within_).getByLabelText(label, { exact: false });
const card = (title: string) => screen.getByRole("region", { name: title });
const lastArgs = (name: string) => [...cx.queried].reverse().find((q) => q.name === name)?.args;

beforeEach(() => {
  cx.results = { "lockdown:groupView": view(), "lockdown:findings": page([]), "lockdown:allowOptions": { groups: [{ _id: "g1", name: "Front desk" }, { _id: "g2", name: "Back office" }], apps: [{ _id: "a1", name: "Label Designer" }] } };
  cx.queried = [];
  cx.fns = {};
});
afterEach(cleanup);

describe("the rules of the lockdown screens", () => {
  it("account lockout: a threshold under 5 and a window longer than the lock are wrong; off sends null", () => {
    expect(lockoutProblems({ on: true, threshold: "4", duration: "15", window: "15" })).toEqual({ threshold: true, duration: false, window: false });
    expect(lockoutProblems({ on: true, threshold: "10", duration: "15", window: "16" })).toEqual({ threshold: false, duration: false, window: true });
    expect(lockoutProblems({ on: true, threshold: "ten", duration: "0", window: "1" })).toEqual({ threshold: true, duration: true, window: false });
    expect(lockoutProblems({ on: false, threshold: "", duration: "", window: "" })).toEqual({ threshold: false, duration: false, window: false });
    expect(lockoutDraftOf(D)).toEqual({ on: true, threshold: "10", duration: "15", window: "15" });
    expect(settingsOf(D, { on: false, threshold: "", duration: "", window: "" }).machine.accountLockout).toBeNull();
    expect(settingsOf(D, { on: true, threshold: " 7 ", duration: "30", window: "20" }).machine.accountLockout).toEqual({ threshold: 7, durationMin: 30, windowMin: 20 });
  });

  it("settings are compared whatever the order of their keys", () => {
    const shuffled = Object.fromEntries(Object.entries(D).reverse()) as unknown as LockdownSettings;
    expect(Object.keys(shuffled)[0]).toBe("wifiManagedOnly");
    expect(sameSettings(D, shuffled)).toBe(true);
    expect(sameSettings(D, { ...D, accessibilityTools: true })).toBe(false);
    expect(changedLayers(D, { ...D, appLocker: { mode: "enforce" } })).toEqual([{ layer: "appLocker", from: "audit", to: "enforce" }]);
  });

  it("a finding is allowed by publisher first, then the exact file, a folder only for admin-only folders, App Control never", () => {
    expect(allowKinds(finding())).toEqual(["publisher", "hash"]);
    expect(allowKinds(finding({ signer: null }))).toEqual(["hash"]);
    expect(allowKinds(finding({ signer: null, hasHash: false }))).toEqual([]);
    expect(allowKinds(finding({ folderClass: "programFiles" }))).toEqual(["publisher", "hash", "path"]);
    expect(allowKinds(finding({ folderClass: "rulebox", signer: null, hasHash: false }))).toEqual(["path"]);
    for (const folderClass of ["userProfile", "userTemp", "removable", "network", "windows", "other"]) expect(allowKinds(finding({ folderClass }))).not.toContain("path");
    expect(allowKinds(finding({ layer: "appControl", folderClass: "programFiles" }))).toEqual([]);
  });

  it("a folder exception must be under an admin-only root", () => {
    for (const ok of ["{ProgramFiles}\\Acme", "{ProgramFilesX86}\\Acme\\Tools", "{RuleboxApps}\\app1"]) expect(folderProblem(ok), ok).toBe(false);
    for (const bad of ["", "C:\\Users\\maya", "{LocalAppData}\\Acme", "{SystemRoot}\\System32", "{ProgramFiles}\\", "{ProgramFiles}\\..\\Users", "{ProgramFiles}\\a*"]) expect(folderProblem(bad), bad).toBe(true);
  });

  it("physical protection is complete only with Secure Boot, BitLocker, no automatic recovery and the Safe Mode registration", () => {
    expect(protectionGaps({ secureBoot: "on", bitLocker: "on", autoRecovery: "off", safeModeAgent: true })).toEqual([]);
    // With BitLocker on the agent leaves automatic recovery on by design: not a gap.
    expect(protectionGaps({ secureBoot: "on", bitLocker: "on", autoRecovery: "on", safeModeAgent: true })).toEqual([]);
    expect(protectionGaps({ secureBoot: "off", bitLocker: "suspended", autoRecovery: "on", safeModeAgent: false })).toEqual(["secureBoot", "bitLocker", "autoRecovery", "safeMode"]);
    expect(protectionGaps({})).toEqual(["secureBoot", "bitLocker", "autoRecovery", "safeMode"]);
  });
});

describe("codes a PC reports, as sentences", () => {
  it("covers the refusal codes of plan 4.6", () => {
    for (const code of ["would_block_rulebox", "would_block_exit", "managed_networks_empty", "would_disconnect", "would_block_admin", "admin_signin_unverified", "lockout_threshold_too_low", "journal_unknown_target", "would_block_input_device"]) {
      expect(REFUSAL_CODES, code).toContain(code);
    }
  });

  it.each(REFUSAL_CODES)("refusal %s has its own plain sentence", (code) => {
    const text = refusalText(code)!;
    expect(text).toBe(REFUSALS[code]);
    expect(text).not.toContain(code);
    expect(text.endsWith(".")).toBe(true);
    // No path, no command line, no jargon codes in the sentence.
    expect(text).not.toMatch(/[\\/]|_/);
  });

  it("would_block_input_device says keyboards, mice and touch screens are never blocked", () => {
    expect(refusalText("would_block_input_device")).toMatch(/keyboard, mouse or touch screen/);
  });

  it.each([
    "no_printing_ignored",
    "startup_entry_kept",
    "startup_entries_capped",
    "tuning_value_protected",
    "service_unreadable",
    "startup_entries_unreadable",
    "machine_value_unreadable",
    "service_not_in_profile",
    "wifi_filters_error",
    "connect_failed",
  ])("layer or item detail %s has a sentence", (code) => {
    expect(LAYER_DETAILS[code]).toBeTruthy();
    expect(layerDetailText(code)).not.toContain(code);
    expect(layerDetailText(code)!.endsWith(".")).toBe(true);
  });

  it("the print service stays on with printers, and a performance restart has its own note", () => {
    expect(LAYER_DETAILS.no_printing_ignored).toMatch(/print service was kept on/);
    expect(layerNoteOf("performance", { state: "restartPending" })).toBe(LAYER_DETAILS.performance_restart_pending);
    // Another layer, or a layer with its own code, keeps that code's sentence.
    expect(layerNoteOf("appControl", { state: "restartPending", detail: "restart_needed" })).toBe(LAYER_DETAILS.restart_needed);
    expect(layerNoteOf("performance", { state: "ok" })).toBeNull();
  });

  it("an unknown code is shown as it is; no code is no text; unknown states keep their word", () => {
    expect(refusalText("something_new")).toBe("Code: something_new");
    expect(layerDetailText("something_new")).toBe("Code: something_new");
    expect(refusalText(null)).toBeNull();
    expect(layerDetailText(undefined)).toBeNull();
    expect(layerStateOf("restartPending").label).toBe("Restart needed");
    expect(layerStateOf("novel")).toEqual({ label: "novel", tone: "neutral" });
  });

  it("the lockdown functions' refusals have their own sentences", () => {
    const conflict = (detail: string) => new ConvexError({ code: "conflict", detail });
    expect(lockdownErrorMessage(conflict("managed_networks_empty"))).toBe(s.managedEmpty);
    for (const detail of ["no_signer", "no_hash", "app_control_finding", "path_not_admin_only", "already_allowed"]) expect(lockdownErrorMessage(conflict(detail)), detail).toBe(fs.errors[detail]);
    expect(lockdownErrorMessage(new ConvexError({ code: "too_large", detail: "groups" }))).toBe(fs.tooManyGroups);
    expect(lockdownErrorMessage(new ConvexError({ code: "too_large", detail: "exceptions" }))).toBe(fs.tooManyExceptions);
    expect(lockdownErrorMessage(new ConvexError({ code: "invalid_argument", field: "accountLockout.threshold" }))).toBe(s.badLockout);
    expect(lockdownErrorMessage(new ConvexError({ code: "invalid_argument", field: "folder" }))).toBe(fs.folderProblem);
    expect(lockdownErrorMessage(new ConvexError({ code: "forbidden" }))).toBeNull();
  });

});

describe("the group lockdown screen", () => {
  it("subscribes to one query and shows the group's settings", () => {
    ui(<Lockdown />);
    expect(screen.getByRole("heading", { name: s.titleFor("Pharmacy counter") })).toBeTruthy();
    expect(new Set(cx.queried.map((q) => q.name))).toEqual(new Set(["lockdown:groupView"]));
    expect(lastArgs("lockdown:groupView")).toEqual({ groupId: "g1" });
    for (const title of [s.rulesTitle, s.usbTitle, s.staffTitle, s.machineTitle, s.inputTitle, s.bootTitle, s.perfTitle, s.netTitle, s.exceptionsTitle]) expect(card(title)).toBeTruthy();
    expect((byLabel(card(s.rulesTitle), s.appLocker) as HTMLSelectElement).value).toBe("audit");
    // Every mode says what it does, and App Control says whom it applies to.
    expect(within(card(s.rulesTitle)).getAllByText(EVERYONE, { exact: false }).length).toBeGreaterThan(0);
    expect(within(card(s.perfTitle)).getByText(/print service stays on whenever this group has printers/)).toBeTruthy();
  });

  it("USB: five kinds, the retroactive box, and the fixed line; nothing can target keyboards, mice or hubs", () => {
    cx.results["lockdown:groupView"] = view({ settings: { ...D, usb: { storage: "block", printers: "block", imaging: "block", phones: "block", other: "allow", retroactive: true } } });
    ui(<Lockdown />);
    const usb = card(s.usbTitle);
    // The line is there whatever is blocked.
    expect(within(usb).getByText("Keyboards, mice and touch screens always work.")).toBeTruthy();
    const selects = within(usb).getAllByRole("combobox");
    expect(selects).toHaveLength(5);
    expect((byLabel(usb, s.usb.storage) as HTMLSelectElement).value).toBe("block");
    expect([...(byLabel(usb, s.usb.storage) as HTMLSelectElement).options].map((o) => o.value)).toEqual(["allow", "readOnly", "block"]);
    for (const key of ["printers", "imaging", "phones", "other"] as const) {
      expect([...(byLabel(usb, s.usb[key]) as HTMLSelectElement).options].map((o) => o.value)).toEqual(["allow", "block"]);
    }
    expect(within(usb).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(usb).queryAllByRole("switch")).toHaveLength(0);
    // No control is labelled for input devices or hubs.
    for (const control of [...selects, ...within(usb).getAllByRole("checkbox")]) {
      const label = (control as HTMLInputElement).labels?.[0]?.textContent ?? "";
      expect(label).not.toMatch(/keyboard|mouse|mice|touch|hub|bluetooth|HID/i);
    }
  });

  it("USB: blocking other devices shows the warning", () => {
    ui(<Lockdown />);
    const usb = card(s.usbTitle);
    expect(within(usb).queryByText(s.usbOtherWarning)).toBeNull();
    fireEvent.change(byLabel(usb, s.usb.other), { target: { value: "block" } });
    expect(within(usb).getByText(s.usbOtherWarning)).toBeTruthy();
    expect(within(usb).getByText("Keyboards, mice and touch screens always work.")).toBeTruthy();
  });

  it("a plain change saves at once with the revision the form started from", async () => {
    const save = vi.fn<(a: unknown) => Promise<{ revision: number }>>(async () => ({ revision: 4 }));
    cx.fns["lockdown:update"] = save;
    ui(<Lockdown />);
    const button = screen.getByRole("button", { name: s.save }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(within(card(s.inputTitle)).getByRole("switch", { name: s.accessibilityTools }));
    fireEvent.change(byLabel(card(s.usbTitle), s.usb.storage), { target: { value: "readOnly" } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toEqual({ groupId: "g1", expectedRevision: 3, settings: { ...D, accessibilityTools: true, usb: { ...D.usb, storage: "readOnly" } } });
    expect(await screen.findByText(s.saved)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("switching to Enforce asks first: the open findings count and the App Control sentence", async () => {
    const save = vi.fn<(a: unknown) => Promise<{ revision: number }>>(async () => ({ revision: 4 }));
    cx.fns["lockdown:update"] = save;
    cx.results["lockdown:groupView"] = view({ openFindings: 12 });
    ui(<Lockdown />);
    expect(screen.getByText(s.findingsNew(12, false))).toBeTruthy();
    expect(screen.getByRole("link", { name: s.findingsOpen }).getAttribute("href")).toBe("/lockdown/findings");
    fireEvent.change(within(card(s.rulesTitle)).getByLabelText(s.appControl), { target: { value: "enforce" } });
    fireEvent.click(screen.getByRole("button", { name: s.save }));
    const dialog = await screen.findByRole("dialog");
    expect(save).not.toHaveBeenCalled();
    expect(within(dialog).getByText(s.enforceFindings(12, false))).toBeTruthy();
    expect(within(dialog).getByText("App Control applies to everyone on this PC, including administrators.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: s.enforceConfirm }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect((save.mock.calls[0]![0] as { settings: LockdownSettings }).settings.appControl).toEqual({ mode: "enforce", level: "recommendedBlocks" });
  });

  it("Enforce for AppLocker alone does not show the App Control sentence; more than 50 findings says so", async () => {
    cx.fns["lockdown:update"] = vi.fn(async () => ({ revision: 4 }));
    cx.results["lockdown:groupView"] = view({ openFindings: 50, openFindingsMore: true });
    ui(<Lockdown />);
    expect(screen.getByText("Audit findings: 50+ new")).toBeTruthy();
    fireEvent.change(byLabel(card(s.rulesTitle), s.appLocker), { target: { value: "enforce" } });
    fireEvent.click(screen.getByRole("button", { name: s.save }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(s.enforceFindings(50, true))).toBeTruthy();
    expect(within(dialog).queryByText(s.enforceAppControl)).toBeNull();
  });

  it("managed networks only asks first, and the server's refusal reads in words", async () => {
    cx.fns["lockdown:update"] = vi.fn().mockRejectedValue(new ConvexError({ code: "conflict", detail: "managed_networks_empty" }));
    ui(<Lockdown />);
    fireEvent.click(within(card(s.netTitle)).getByRole("switch", { name: s.wifiManagedOnly }));
    fireEvent.click(screen.getByRole("button", { name: s.save }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(s.managedConfirm)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: s.enforceConfirm }));
    expect(await screen.findByText(s.managedEmpty)).toBeTruthy();
  });

  it("'I understand this PC may go offline' shows only while managed networks only is on; ticked it is sent, not ticked it is left out (Step 20b)", async () => {
    const save = vi.fn<(args?: unknown) => Promise<unknown>>(async () => ({ revision: 4 }));
    cx.fns["lockdown:update"] = save;
    ui(<Lockdown />);
    const net = () => within(card(s.netTitle));
    expect(net().queryByRole("checkbox", { name: /I understand this PC may go offline/ })).toBeNull();
    fireEvent.click(net().getByRole("switch", { name: s.wifiManagedOnly }));
    const box = net().getByRole("checkbox", { name: /I understand this PC may go offline/ }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect((net().getByRole("checkbox", { name: /I understand this PC may go offline/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: s.save }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: s.enforceConfirm }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({ settings: { wifiManagedOnly: true, wifiManagedOnlyConfirmed: true } });
  });

  it("not ticked, or ticked and then managed networks only switched off again: the key is not sent", async () => {
    const save = vi.fn<(args?: unknown) => Promise<unknown>>(async () => ({ revision: 4 }));
    cx.fns["lockdown:update"] = save;
    ui(<Lockdown />);
    const net = () => within(card(s.netTitle));
    fireEvent.click(net().getByRole("switch", { name: s.wifiManagedOnly }));
    fireEvent.click(screen.getByRole("button", { name: s.save }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: s.enforceConfirm }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect((save.mock.calls[0]![0] as { settings: LockdownSettings }).settings).not.toHaveProperty("wifiManagedOnlyConfirmed");
    cleanup();
    save.mockClear();
    ui(<Lockdown />);
    fireEvent.click(net().getByRole("switch", { name: s.wifiManagedOnly }));
    fireEvent.click(net().getByRole("checkbox", { name: /I understand this PC may go offline/ }));
    fireEvent.click(net().getByRole("switch", { name: s.wifiManagedOnly }));
    expect(net().queryByRole("checkbox", { name: /I understand this PC may go offline/ })).toBeNull();
    fireEvent.click(within(card(s.inputTitle)).getByRole("switch", { name: s.accessibilityTools }));
    fireEvent.click(screen.getByRole("button", { name: s.save }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect((save.mock.calls[0]![0] as { settings: LockdownSettings }).settings).not.toHaveProperty("wifiManagedOnlyConfirmed");
  });
  it("a stale edit offers Reload, which brings the saved values back", async () => {
    cx.fns["lockdown:update"] = vi.fn().mockRejectedValue(new ConvexError({ code: "stale_edit" }));
    ui(<Lockdown />);
    const tools = () => within(card(s.inputTitle)).getByRole("switch", { name: s.accessibilityTools });
    fireEvent.click(tools());
    fireEvent.click(screen.getByRole("button", { name: s.save }));
    expect(await screen.findByText(strings.common.staleTitle)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.common.reload }));
    expect(tools().getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(strings.common.staleTitle)).toBeNull();
  });

  it("a wrong lockout number stops the save and is shown at its field", () => {
    const save = vi.fn(async () => ({ revision: 4 }));
    cx.fns["lockdown:update"] = save;
    ui(<Lockdown />);
    fireEvent.change(byLabel(card(s.machineTitle), s.lockoutThreshold), { target: { value: "3" } });
    fireEvent.click(within(card(s.inputTitle)).getByRole("switch", { name: s.accessibilityTools }));
    fireEvent.click(screen.getByRole("button", { name: s.save }));
    expect(screen.getByText(s.lockoutProblems.threshold)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("after 7 days of audit it suggests Enforce", () => {
    cx.results["lockdown:groupView"] = view({ auditSince: NOW - 9 * DAY });
    ui(<Lockdown />);
    expect(screen.getByText(s.auditLong(9))).toBeTruthy();
  });

  it("exceptions: a hash rule is marked Breaks on update; Remove asks, then calls the server", async () => {
    const remove = vi.fn<(a: unknown) => Promise<null>>(async () => null);
    cx.fns["lockdown:removeException"] = remove;
    cx.results["lockdown:groupView"] = view({
      exceptions: [exception(), exception({ _id: "e2", rule: { kind: "hash", subject: null, product: null, fileName: null, hashStart: "9f2c41d07ab3", path: null }, reason: "" })],
    });
    ui(<Lockdown />);
    const list = within(card(s.exceptionsTitle)).getByRole("list");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("tool.exe signed by Contoso Ltd")).toBeTruthy();
    expect(within(rows[0]!).queryByText(s.breaksOnUpdate)).toBeNull();
    expect(within(rows[1]!).getByText(s.breaksOnUpdate)).toBeTruthy();
    fireEvent.click(within(rows[1]!).getByRole("button", { name: s.removeException }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: s.removeException }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ exceptionId: "e2" }));
  });

  it("a viewer reads: every control is disabled, no Save, no Remove", () => {
    cx.results["lockdown:groupView"] = view({ exceptions: [exception()], openFindings: 2 });
    ui(<Lockdown />, "viewer");
    expect(screen.getByText(s.readOnly)).toBeTruthy();
    const controls = [...screen.getAllByRole("combobox"), ...screen.getAllByRole("switch"), ...screen.getAllByRole("checkbox"), ...screen.getAllByRole("textbox")];
    expect(controls.length).toBeGreaterThan(30);
    for (const c of controls) expect((c as HTMLInputElement).disabled, c.getAttribute("aria-label") ?? c.id).toBe(true);
    expect(screen.queryByRole("button", { name: s.save })).toBeNull();
    expect(screen.queryByRole("button", { name: s.discard })).toBeNull();
    expect(screen.queryByRole("button", { name: s.removeException })).toBeNull();
    // The findings link is still there to read.
    expect(screen.getByRole("link", { name: s.findingsOpen })).toBeTruthy();
  });

  it("the group page links to it, for admins and viewers alike", () => {
    cx.results["groups:get"] = { group: { _id: "g1", name: "Sales", revision: 0, devices: { count: 0, more: false }, employees: { count: 0, more: false } }, apps: [] };
    ui(<GroupDetail />, "viewer", "/groups/g1");
    expect(screen.getByRole("link", { name: groupStrings.lockdown }).getAttribute("href")).toBe("/groups/g1/lockdown");
  });
});

describe("the findings screen", () => {
  const rows = [
    finding(),
    finding({ _id: "f2", fileName: "notes.exe", signer: null, product: null, folderClass: "removable", hasHash: false, deviceCount: 1 }),
    finding({ _id: "f3", fileName: "driver-tool.exe", layer: "appControl", folderClass: "programFiles" }),
  ];

  it("lists one row per program without a path, and asks the server for the open ones, last seen first", () => {
    cx.results["lockdown:findings"] = page(rows);
    ui(<Findings />, "admin", "/lockdown/findings");
    expect(lastArgs("lockdown:findings")).toEqual({ status: "new", paginationOpts: { numItems: 10, cursor: null }, sort: { key: "seen", dir: "desc" } });
    const table = screen.getByRole("table");
    expect(within(table).getByText("tool.exe")).toBeTruthy();
    expect(within(table).getAllByText("Contoso Ltd")).toHaveLength(2);
    expect(within(table).getByText(fs.unsigned)).toBeTruthy();
    expect(within(table).getByText(fs.folders.removable!)).toBeTruthy();
    expect(within(table).getByText(fs.layers.appControl)).toBeTruthy();
    expect(within(table).getAllByText(fs.pcs(3))).toHaveLength(2);
    expect(table.textContent).not.toMatch(/[A-Z]:\\|\\Users\\/);
  });

  it("pagination: Next asks for the next page with the server's cursor; the status tab starts over", () => {
    cx.results["lockdown:findings"] = page(rows, false, "cursor-2");
    ui(<Findings />, "admin", "/lockdown/findings");
    fireEvent.click(screen.getByRole("button", { name: strings.pager.next }));
    expect(lastArgs("lockdown:findings")).toEqual({ status: "new", paginationOpts: { numItems: 10, cursor: "cursor-2" }, sort: { key: "seen", dir: "desc" } });
    fireEvent.click(screen.getByRole("radio", { name: fs.statuses.ignored }));
    expect(lastArgs("lockdown:findings")).toEqual({ status: "ignored", paginationOpts: { numItems: 10, cursor: null }, sort: { key: "seen", dir: "desc" } });
  });

  it("the status in the URL is used; an unknown one falls back to open", () => {
    ui(<Findings />, "admin", "/lockdown/findings?status=allowed");
    expect((lastArgs("lockdown:findings") as { status: string }).status).toBe("allowed");
    cleanup();
    cx.queried = [];
    ui(<Findings />, "admin", "/lockdown/findings?status=nope");
    expect((lastArgs("lockdown:findings") as { status: string }).status).toBe("new");
  });

  it("an empty list says so", () => {
    ui(<Findings />, "admin", "/lockdown/findings");
    expect(screen.getByText(fs.emptyTitle.new)).toBeTruthy();
  });

  it("a viewer sees the rows and no actions", () => {
    cx.results["lockdown:findings"] = page(rows);
    ui(<Findings />, "viewer", "/lockdown/findings");
    expect(screen.getByText("tool.exe")).toBeTruthy();
    expect(screen.queryByRole("button", { name: fs.allow })).toBeNull();
    expect(screen.queryByRole("button", { name: fs.ignore })).toBeNull();
    expect(cx.queried.some((q) => q.name === "lockdown:allowOptions")).toBe(false);
  });

  it("Ignore asks, then calls the server", async () => {
    const ignore = vi.fn<(a: unknown) => Promise<null>>(async () => null);
    cx.fns["lockdown:ignore"] = ignore;
    cx.results["lockdown:findings"] = page(rows);
    ui(<Findings />, "admin", "/lockdown/findings");
    fireEvent.click(screen.getAllByRole("button", { name: fs.ignore })[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(fs.ignoreTitle("tool.exe"))).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: fs.ignore }));
    await waitFor(() => expect(ignore).toHaveBeenCalledWith({ findingId: "f1" }));
    expect(await screen.findByText(fs.ignored)).toBeTruthy();
  });

  it("App Control findings cannot be allowed", () => {
    cx.results["lockdown:findings"] = page(rows);
    ui(<Findings />, "admin", "/lockdown/findings");
    const buttons = screen.getAllByRole("button", { name: fs.allow }) as HTMLButtonElement[];
    expect(buttons.map((b) => b.disabled)).toEqual([false, true, true]);
  });

  const openAllow = (f: FindingRow) => {
    cx.results["lockdown:findings"] = page([f]);
    ui(<Findings />, "admin", "/lockdown/findings");
    expect(cx.queried.some((q) => q.name === "lockdown:allowOptions")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: fs.allow }));
    return screen.getByRole("dialog");
  };

  it("Allow for app: a signed program is offered the publisher rule first; the pickers load only now", async () => {
    const allow = vi.fn<(a: unknown) => Promise<{ added: number }>>(async () => ({ added: 2 }));
    cx.fns["lockdown:allow"] = allow;
    const dialog = openAllow(finding());
    expect(cx.queried.some((q) => q.name === "lockdown:allowOptions")).toBe(true);
    const kind = byLabel(dialog, fs.ruleKind) as HTMLSelectElement;
    expect(kind.value).toBe("publisher");
    expect([...kind.options].map((o) => [o.value, o.disabled])).toEqual([["publisher", false], ["hash", false], ["path", true]]);
    expect(within(dialog).getByText(fs.kindHelp.publisher("Contoso Ltd"))).toBeTruthy();
    expect(within(dialog).getByText(fs.kindUnavailable.path, { exact: false })).toBeTruthy();
    // No group chosen: said, not sent.
    fireEvent.click(within(dialog).getByRole("button", { name: fs.allowConfirm }));
    expect(within(dialog).getByText(fs.groupsProblem)).toBeTruthy();
    expect(allow).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Front desk" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Back office" }));
    fireEvent.change(byLabel(dialog, fs.app), { target: { value: "a1" } });
    fireEvent.change(byLabel(dialog, fs.reason), { target: { value: " Needed by sales " } });
    fireEvent.click(within(dialog).getByRole("button", { name: fs.allowConfirm }));
    await waitFor(() => expect(allow).toHaveBeenCalledTimes(1));
    expect(allow.mock.calls[0]![0]).toEqual({ findingId: "f1", kind: "publisher", groupIds: ["g1", "g2"], appId: "a1", reason: "Needed by sales" });
    expect(await screen.findByText(fs.allowed(2))).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Allow for app: an unsigned program gets the exact-file rule, marked as breaking on update", async () => {
    const allow = vi.fn<(a: unknown) => Promise<{ added: number }>>(async () => ({ added: 1 }));
    cx.fns["lockdown:allow"] = allow;
    const dialog = openAllow(finding({ signer: null }));
    expect((byLabel(dialog, fs.ruleKind) as HTMLSelectElement).value).toBe("hash");
    expect(within(dialog).getByText(/Breaks on update/)).toBeTruthy();
    expect(within(dialog).getByText(fs.kindUnavailable.publisher, { exact: false })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Front desk" }));
    fireEvent.click(within(dialog).getByRole("button", { name: fs.allowConfirm }));
    await waitFor(() => expect(allow).toHaveBeenCalledWith({ findingId: "f1", kind: "hash", groupIds: ["g1"] }));
  });

  it("Allow for app: a folder rule only under an admin-only folder, with the folder checked", async () => {
    const allow = vi.fn<(a: unknown) => Promise<{ added: number }>>(async () => ({ added: 1 }));
    cx.fns["lockdown:allow"] = allow;
    const dialog = openAllow(finding({ signer: null, hasHash: false, folderClass: "programFiles" }));
    expect((byLabel(dialog, fs.ruleKind) as HTMLSelectElement).value).toBe("path");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Front desk" }));
    fireEvent.change(byLabel(dialog, fs.folder), { target: { value: "C:\\Users\\maya" } });
    fireEvent.click(within(dialog).getByRole("button", { name: fs.allowConfirm }));
    expect(within(dialog).getByText(fs.folderProblem)).toBeTruthy();
    expect(allow).not.toHaveBeenCalled();
    fireEvent.change(byLabel(dialog, fs.folder), { target: { value: "{ProgramFiles}\\Acme" } });
    fireEvent.click(within(dialog).getByRole("button", { name: fs.allowConfirm }));
    await waitFor(() => expect(allow).toHaveBeenCalledWith({ findingId: "f1", kind: "path", folder: "{ProgramFiles}\\Acme", groupIds: ["g1"] }));
  });

  it("Allow for app: the server's refusal reads in words and the dialog stays open", async () => {
    cx.fns["lockdown:allow"] = vi.fn().mockRejectedValue(new ConvexError({ code: "too_large", detail: "exceptions" }));
    const dialog = openAllow(finding());
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Front desk" }));
    fireEvent.click(within(dialog).getByRole("button", { name: fs.allowConfirm }));
    expect(await within(dialog).findByText(fs.tooManyExceptions)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("the device page cards", () => {
  it("read the page, not a query of their own: the Protection tab subscribes to nothing", () => {
    cardOf((d) => (
      <>
        <ProtectionCard d={d} />
        <LockdownCard d={d} />
        <UsbAllowCard d={d} />
      </>
    ));
    expect(cx.queried).toEqual([]);
  });

  it("an older server without the lockdown fields shows empty cards, not an error", () => {
    cardOf(
      (d) => (
        <>
          <ProtectionCard d={d} />
          <LockdownCard d={d} />
          <UsbAllowCard d={d} />
        </>
      ),
      { lockdownCapable: null },
    );
    // Protection and Lockdown both say "has not sent this yet".
    expect(screen.getAllByText(ds.protectionNone)).toHaveLength(2);
    expect(screen.getByText(ds.usbOff)).toBeTruthy();
  });

  it("Protection: green only when everything is in place; TPM and service protection are technical details", () => {
    cardOf((d) => <ProtectionCard d={d} />, { protection: { secureBoot: "on", bitLocker: "on", autoRecovery: "off", safeModeAgent: true, tpm: "ready", serviceAcl: "ok" } });
    expect(screen.getByText(ds.protectionOk)).toBeTruthy();
    expect(screen.queryByText(ds.protectionMissing)).toBeNull();
    // Four plain rows; the rest is in the (closed) technical details.
    expect(within(screen.getByRole("list", { name: ds.protectionTitle })).getAllByRole("listitem")).toHaveLength(4);
    expect((screen.getByText(ds.tpm).closest("details") as HTMLDetailsElement).open).toBe(false);
  });

  it("Protection: says in plain words what to turn on, and that Rulebox never does it", () => {
    cardOf((d) => <ProtectionCard d={d} />, { protection: { secureBoot: "on", bitLocker: "off", autoRecovery: "on", safeModeAgent: false, serviceAcl: "drift", aclDrift: 2 } });
    expect(screen.getByText(ds.protectionMissing)).toBeTruthy();
    expect(screen.getByText(ds.turnOn([ds.bitLocker]), { exact: false })).toBeTruthy();
    expect(screen.getByText(ds.never, { exact: false })).toBeTruthy();
    expect(screen.getByText(ds.values.drift!)).toBeTruthy();
    expect(screen.queryByText(ds.protectionOk)).toBeNull();
  });

  it("Protection: only Safe Mode or automatic recovery missing lists what is missing", () => {
    cardOf((d) => <ProtectionCard d={d} />, { protection: { secureBoot: "on", bitLocker: "off", autoRecovery: "on", safeModeAgent: true } });
    cleanup();
    cardOf((d) => <ProtectionCard d={d} />, { protection: { secureBoot: "on", bitLocker: "on", autoRecovery: "off", safeModeAgent: false } });
    expect(screen.getByText(ds.missingList([ds.missing.safeMode]), { exact: false })).toBeTruthy();
  });

  it("Protection: nothing reported yet says so", () => {
    cardOf((d) => <ProtectionCard d={d} />, { protection: null });
    expect(screen.getByText(ds.protectionNone)).toBeTruthy();
  });

  it("Lockdown: a refusal is shown in plain words, never as a code (the code is a technical detail)", () => {
    cardOf((d) => <LockdownCard d={d} />, { apply: apply({ state: "refused", refusal: "would_block_input_device" }) });
    expect(screen.getByText(ds.states.refused)).toBeTruthy();
    expect(screen.getByText(ds.refusedTitle)).toBeTruthy();
    expect(screen.getByText(REFUSALS.would_block_input_device!)).toBeTruthy();
    const code = screen.getByText("would_block_input_device");
    expect(code.closest("details")).toBeTruthy();
  });

  it("Lockdown: every layer by its plain name with its mode, state and note; the versions are technical details", () => {
    cardOf((d) => <LockdownCard d={d} />, {
      apply: apply({
        state: "partial",
        layers: {
          appLocker: layer("enforce", "auditFirst", "audit_first"),
          appControl: layer("audit", "restartPending", "restart_needed"),
          procWatch: layer("enforce", "ok", "snapshot_fallback"),
          machine: layer("on", "partial", "fighting"),
          performance: layer("on", "partial", "no_printing_ignored"),
          boot: layer("on", "failed", "brand_new_code"),
        },
      }),
    });
    const list = screen.getByRole("list", { name: ds.layerList });
    expect(within(list).getAllByRole("listitem")).toHaveLength(7);
    for (const label of Object.values(ds.layers)) expect(within(list).getByText(label)).toBeTruthy();
    for (const state of [ds.auditFirst, "Restart needed", "Working", "Partly applied", "Failed"]) expect(within(list).getAllByText(state).length).toBeGreaterThan(0);
    // The mode words of the group lockdown page.
    for (const mode of [ds.modes.off, ds.modes.audit, ds.modes.enforce, ds.modes.on]) expect(mode).toBeTruthy();
    expect(within(list).getAllByText(ds.modes.enforce!).length).toBe(2);
    expect(within(list).getByText(ds.modes.audit!)).toBeTruthy();
    expect(within(list).getAllByText(ds.modes.on!).length).toBe(4);
    expect(within(list).getByText(LAYER_DETAILS.no_printing_ignored!, { exact: false })).toBeTruthy();
    expect(within(list).getByText(LAYER_DETAILS.snapshot_fallback!, { exact: false })).toBeTruthy();
    expect(within(list).getByText(/Code: brand_new_code/)).toBeTruthy();
    // Settings version and last working settings: under Technical details, plain numbers.
    const tech = screen.getByText(ds.configVersion).closest("details") as HTMLDetailsElement;
    expect(tech.open).toBe(false);
    expect(screen.getByText(ds.configVersion).parentElement!.textContent).toContain("5");
    expect(screen.getByText(ds.lkg).parentElement!.textContent).toContain("7");
    expect(screen.queryByText(ds.version(5))).toBeNull();
  });

  it("Lockdown: a Home PC says its program list is not available; the compatibility report names what cannot be used; a rolled back PC says why", () => {
    cardOf((d) => <LockdownCard d={d} />, { apply: apply({ state: "rolledBack", refusal: "crash_loop", layers: { appLocker: layer("audit", "unsupported", "applocker_not_on_this_edition") } }) });
    expect(screen.getByText(ds.reducedTitle)).toBeTruthy();
    expect(screen.getByText(ds.reducedHome)).toBeTruthy();
    expect(screen.getByText(ds.rolledBackTitle)).toBeTruthy();
    cleanup();
    const compat = { os: {}, blockers: [], warnings: [], liteMode: false, protection: "reduced", layers: { appLocker: false, appControl: true } } as unknown as NonNullable<DevicePage["report"]>["compat"];
    cardOf((d) => <LockdownCard d={d} />, { apply: apply(), report: { updatedAt: 1, compat } as DevicePage["report"] });
    expect(screen.getByText(ds.reducedDetail([ds.layerAppLocker]))).toBeTruthy();
  });

  it("Lockdown: an agent from before lockdown is named; no report yet says so", () => {
    cardOf((d) => <LockdownCard d={d} />, { lockdownCapable: false });
    expect(screen.getByText(ds.tooOld)).toBeTruthy();
    cleanup();
    cardOf((d) => <LockdownCard d={d} />, { lockdownCapable: null });
    expect(screen.getByText(ds.noReport)).toBeTruthy();
  });

  it("Allow USB: at most 8 hours, sent as whole hours; the fixed line is in the (i)", async () => {
    const allowUsb = vi.fn<(a: unknown) => Promise<{ until: number | null }>>(async () => ({ until: NOW + 4 * 3_600_000 }));
    cx.fns["fleet:allowUsb"] = allowUsb;
    cardOf((d) => <UsbAllowCard d={d} />);
    expect(screen.getByText(ds.usbOff)).toBeTruthy();
    expect(optionLabels(ds.usbHours)).toEqual(["1 hour", "2 hours", "4 hours", "8 hours"]);
    pickOption(ds.usbHours, "4 hours");
    fireEvent.click(screen.getByRole("button", { name: ds.usbAllow }));
    await waitFor(() => expect(allowUsb).toHaveBeenCalledWith({ deviceId: "d1", hours: 4 }));
    expect(await screen.findByText(ds.usbStarted(4))).toBeTruthy();
    expect(ds.usbInfo).toContain("Keyboards, mice and touch screens always work.");
  });

  it("Allow USB: an open window shows until when and End now sends 0 hours", async () => {
    const allowUsb = vi.fn<(a: unknown) => Promise<{ until: number | null }>>(async () => ({ until: null }));
    cx.fns["fleet:allowUsb"] = allowUsb;
    cardOf((d) => <UsbAllowCard d={d} />, { usbAllowUntil: Date.now() + 2 * 3_600_000 });
    expect(screen.getByText(/USB devices are allowed until/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: ds.usbAllow })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: ds.usbEnd }));
    await waitFor(() => expect(allowUsb).toHaveBeenCalledWith({ deviceId: "d1", hours: 0 }));
  });

  it("Allow USB: a window that has run out reads as off", () => {
    cardOf((d) => <UsbAllowCard d={d} />, { usbAllowUntil: Date.now() - 60_000 });
    expect(screen.getByText(ds.usbOff)).toBeTruthy();
    expect(screen.getByRole("button", { name: ds.usbAllow })).toBeTruthy();
  });

  it("Allow USB: a viewer and a revoked PC get no button", () => {
    cardOf((d) => <UsbAllowCard d={d} />, {}, "viewer");
    expect(screen.queryByRole("button", { name: ds.usbAllow })).toBeNull();
    cleanup();
    cardOf((d) => <UsbAllowCard d={d} />, { revoked: true });
    expect(screen.queryByRole("button", { name: ds.usbAllow })).toBeNull();
  });
});

describe("the overview warnings", () => {
  const overview = (lockdown?: LockdownWarnings) => ({
    counts: { deviceCount: 3, employeeCount: 2, appCount: 1, groupCount: 1, noGroupDeviceCount: 0, outOfSupportCount: 0, failedInstallCount: 0 },
    onlineCount: 1,
    plan: { name: "team", status: "active", limits: { maxDevices: 100, maxEmployees: 100, maxApps: 100, maxGroups: 50, maxMembers: 10, auditRetentionDays: 365, storageQuotaBytes: 1, maxUploadBytes: 1, watchMode: true, maxEnrollmentCodesActive: 20 } },
    signing: "active",
    publishFailedAt: null,
    rosterPending: false,
    recentAudit: [],
    ...(lockdown ? { lockdown } : {}),
  });
  const none: LockdownWarnings = { auditOverdue: [], auditOverdueMore: false, halted: [], haltedMore: false, notApplied: [], notAppliedMore: false };

  it("nothing to warn about: no lockdown line", () => {
    cx.results["overview:get"] = overview(none);
    ui(<Overview />, "admin", "/");
    expect(screen.getByText(strings.overview.attentionNone)).toBeTruthy();
    expect(screen.getByText(strings.overview.leadCalm)).toBeTruthy();
  });

  it("an older server without the field shows no warning and does not crash", () => {
    cx.results["overview:get"] = overview();
    ui(<Overview />, "admin", "/");
    expect(screen.getByText(strings.overview.attentionNone)).toBeTruthy();
  });

  it("groups too long in audit, paused rollouts and PCs that did not apply the policy, each with a link", async () => {
    cx.results["overview:get"] = overview({
      auditOverdue: [{ groupId: "g1", name: "Sales", since: NOW - 20 * DAY }, { groupId: "g2", name: "Office", since: NOW - 30 * DAY }],
      auditOverdueMore: true,
      halted: [{ groupId: "g3", name: "Warehouse" }],
      haltedMore: false,
      notApplied: [{ deviceId: "d9", name: "Desk 9", state: "refused", refusal: "would_block_exit" }],
      notAppliedMore: false,
    });
    ui(<Overview />, "admin", "/");
    const o = overviewLockdownStrings;
    // The lines are a chunk of their own: they arrive a moment after the page.
    expect(await screen.findByText(o.auditTitle(["Sales", "Office"], true))).toBeTruthy();
    expect(screen.getByText("Trial run for more than 14 days: Sales, Office and more")).toBeTruthy();
    expect(screen.getByText(o.haltedTitle(["Warehouse"], false))).toBeTruthy();
    expect(screen.getByText(o.notAppliedTitle(["Desk 9"], false))).toBeTruthy();
    expect(screen.getByRole("link", { name: o.auditAction }).getAttribute("href")).toBe("/groups/g1/lockdown");
    expect(screen.getByRole("link", { name: o.haltedAction }).getAttribute("href")).toBe("/groups/g3/rollout");
    expect(screen.getByRole("link", { name: o.notAppliedAction }).getAttribute("href")).toBe("/devices/d9");
    // Three kinds of warnings count as three things that need attention; the empty state is gone.
    expect(screen.getByText(strings.overview.leadAttention(3))).toBeTruthy();
    expect(screen.queryByText(strings.overview.attentionNone)).toBeNull();
    expect(document.body.textContent).not.toContain("would_block_exit");
  });
});
