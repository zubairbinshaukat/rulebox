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
  type LockdownSync,
  type LockdownView,
  type LockdownWarnings,
  type Me,
} from "../data/types";
import { LAYER_DETAILS, REFUSAL_CODES, REFUSALS, layerDetailText, layerNoteOf, layerStateOf, protectionGaps, refusalText } from "./lockdown/codes";
import { allowKinds, changedLayers, folderProblem, lockoutDraftOf, lockoutProblems, sameSettings, settingsOf } from "./lockdown/rules";
import { MeContext } from "../lib/member";
import { applyPreset } from "./lockdown/presets";
import { optionLabels, pickOption, selectedText } from "../test/select";
import { groupStrings } from "../lib/screenStrings/group";
import { strings } from "../lib/strings";
import { deviceLockdownStrings as ds } from "./lockdown/deviceStrings";
import { findingsStrings as fs, lockdownErrorMessage, lockdownStrings as s } from "./lockdown/strings";
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

/** lockdown:groupSync: 2 of 5 PCs have the newest settings, one could not apply them, two wait. */
const sync = (over: Partial<LockdownSync> = {}): LockdownSync => ({
  total: 5,
  totalMore: false,
  upToDate: 2,
  problems: 1,
  problemPcs: [{ deviceId: "d3", name: "COUNTER-03", state: "failed" }],
  reduced: 0,
  adminTilesPending: 0,
  newestVersion: 8,
  ringsOn: false,
  rolloutState: "idle",
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
};
const card = (title: string) => screen.getByRole("region", { name: title });
const lastArgs = (name: string) => [...cx.queried].reverse().find((q) => q.name === name)?.args;

beforeEach(() => {
  cx.results = { "lockdown:groupView": view(), "lockdown:groupSync": sync(), "lockdown:findings": page([]), "lockdown:allowOptions": { groups: [{ _id: "g1", name: "Front desk" }, { _id: "g2", name: "Back office" }], apps: [{ _id: "a1", name: "Label Designer" }] } };
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
    "admin_tiles_skipped",
  ])("layer or item detail %s has a sentence", (code) => {
    expect(LAYER_DETAILS[code]).toBeTruthy();
    expect(layerDetailText(code)).not.toContain(code);
    expect(layerDetailText(code)!.endsWith(".")).toBe(true);
  });

  it("a PC that skipped the hidden admin accounts says so in plain words on its machine layer", () => {
    expect(layerNoteOf("machine", { state: "ok", detail: "admin_tiles_skipped" })).toMatch(/^Admin accounts stay visible on this PC until sign-in as another user is confirmed/);
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
  const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;
  const checkedOf = (names: string[]) => names.filter((n) => radio(n).checked);
  const LEVELS = [s.presets.basic.name, s.presets.standard.name, s.presets.strict.name];
  const MODES = [s.modes.off, s.modes.audit, s.modes.enforce];
  /** Advanced is closed at first: its summary opens it. */
  const openAdvanced = async () => {
    fireEvent.click(document.querySelector(".lk-adv > summary")!);
    await screen.findByRole("region", { name: s.checksTitle });
  };
  const group = (title: string) => screen.getByRole("region", { name: title });
  const saveButton = () => screen.getByRole("button", { name: s.save }) as HTMLButtonElement;
  const switchOf = (label: string) => screen.getByRole("switch", { name: label });

  it("subscribes to the form's query and the PCs counter, and shows the cards of the page", () => {
    ui(<Lockdown />);
    expect(screen.getByRole("heading", { name: s.titleFor("Pharmacy counter") })).toBeTruthy();
    expect(new Set(cx.queried.map((q) => q.name))).toEqual(new Set(["lockdown:groupView", "lockdown:groupSync"]));
    expect(lastArgs("lockdown:groupView")).toEqual({ groupId: "g1" });
    expect(lastArgs("lockdown:groupSync")).toEqual({ groupId: "g1" });
    for (const title of [s.syncTitle, s.levelTitle, s.modeTitle, s.reviewTitle, s.exceptionsTitle]) expect(card(title)).toBeTruthy();
    // The defaults read Standard, in trial run.
    expect(checkedOf(LEVELS)).toEqual([s.presets.standard.name]);
    expect(checkedOf(MODES)).toEqual([s.modes.audit]);
    expect(screen.getByText(s.presets.standard.badge)).toBeTruthy();
    expect(screen.getByText(s.modeHelp.audit)).toBeTruthy();
    // No save bar, no helper paragraphs about layers, no Windows feature names outside the (i) tips.
    expect(screen.queryByRole("region", { name: s.saveBarLabel })).toBeNull();
    expect(document.body.textContent).not.toMatch(/AppLocker|App Control|Process watch|Enforce/);
  });

  it("Advanced is closed at first, opens from its summary and holds every individual setting", async () => {
    ui(<Lockdown />);
    expect(screen.queryByRole("region", { name: s.staffTitle })).toBeNull();
    await openAdvanced();
    for (const title of [s.checksTitle, s.staffTitle, s.machineTitle, s.lockoutTitle, s.usbTitle, s.inputTitle, s.bootTitle, s.perfTitle, s.netTitle]) expect(group(title)).toBeTruthy();
    expect(selectedText(s.appLocker)).toContain(s.modes.audit);
    expect(selectedText(s.appControlLevel)).toContain(s.levels.recommendedBlocks);
    expect(within(group(s.staffTitle)).getAllByRole("switch")).toHaveLength(10);
    expect(within(group(s.machineTitle)).getAllByRole("switch")).toHaveLength(7);
    // The tags say whom a group touches.
    expect(within(group(s.staffTitle)).getByText(s.tags.staff)).toBeTruthy();
    expect(within(group(s.machineTitle)).getByText(s.tags.everyone)).toBeTruthy();
    // The Speed and Wi-Fi settings are in no protection level and show no "Changed" mark.
    expect(within(group(s.perfTitle)).getAllByRole("switch")).toHaveLength(3);
    expect(screen.queryByText(s.changed)).toBeNull();
  });

  it("USB (Advanced): five kinds, the retroactive box, the fixed line; nothing can target keyboards, mice or hubs", async () => {
    cx.results["lockdown:groupView"] = view({ settings: { ...D, usb: { storage: "block", printers: "block", imaging: "block", phones: "block", other: "allow", retroactive: true } } });
    ui(<Lockdown />);
    await openAdvanced();
    const usb = group(s.usbTitle);
    expect(within(usb).getByText(s.usbAlways)).toBeTruthy();
    expect(selectedText(s.usb.storage)).toContain(s.storageModes.block);
    expect(optionLabels(s.usb.storage)).toEqual([s.storageModes.allow, s.storageModes.readOnly, s.storageModes.block]);
    for (const key of ["printers", "imaging", "phones", "other"] as const) expect(optionLabels(s.usb[key])).toEqual([s.usbModes.allow, s.usbModes.block]);
    expect(within(usb).getAllByRole("checkbox")).toHaveLength(1);
    for (const control of [...within(usb).getAllByRole("button", { name: /^USB|Scanners|Phones|Other/ }), ...within(usb).getAllByRole("checkbox")]) {
      const label = control.getAttribute("aria-label") ?? (control as HTMLInputElement).labels?.[0]?.textContent ?? control.textContent ?? "";
      expect(label).not.toMatch(/keyboard|mouse|mice|touch|hub|bluetooth|HID/i);
    }
  });

  it("USB: blocking other devices shows the warning, and it stays visible", async () => {
    ui(<Lockdown />);
    await openAdvanced();
    expect(screen.queryByText(s.usbOtherWarning)).toBeNull();
    pickOption(s.usb.other, s.usbModes.block);
    expect(within(group(s.usbTitle)).getByText(s.usbOtherWarning)).toBeTruthy();
    expect(within(group(s.usbTitle)).getByText(s.usbAlways)).toBeTruthy();
  });

  it("a plain change saves with the revision the form started from; the bar names it, then goes away", async () => {
    const save = vi.fn<(a: unknown) => Promise<{ revision: number }>>(async () => ({ revision: 4 }));
    cx.fns["lockdown:update"] = save;
    ui(<Lockdown />);
    await openAdvanced();
    fireEvent.click(switchOf(s.accessibilityTools));
    pickOption(s.usb.storage, s.storageModes.readOnly);
    const bar = screen.getByRole("region", { name: s.saveBarLabel });
    expect(within(bar).getByText(s.unsaved(2))).toBeTruthy();
    fireEvent.click(within(bar).getByRole("button", { name: s.save }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toEqual({ groupId: "g1", expectedRevision: 3, settings: { ...D, accessibilityTools: true, usb: { ...D.usb, storage: "readOnly" } } });
    expect(await screen.findByText(s.saved)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("region", { name: s.saveBarLabel })).toBeNull();
    // The PCs card now says it is sending.
    expect(screen.getByText(s.sending(2, 5))).toBeTruthy();
  });

  it("with rollout rings on the toast says the first PCs get it first", async () => {
    cx.fns["lockdown:update"] = vi.fn(async () => ({ revision: 4 }));
    cx.results["lockdown:groupSync"] = sync({ ringsOn: true });
    ui(<Lockdown />);
    await openAdvanced();
    fireEvent.click(switchOf(s.accessibilityTools));
    fireEvent.click(saveButton());
    expect(await screen.findByText(s.savedRings)).toBeTruthy();
  });

  it("the bar's (i) lists what changed, and Undo changes brings the saved values back", async () => {
    ui(<Lockdown />);
    await openAdvanced();
    fireEvent.click(switchOf(s.accessibilityTools));
    fireEvent.click(screen.getByRole("button", { name: s.changesInfoLabel }));
    expect(within(screen.getByRole("tooltip")).getByText(s.accessibilityTools)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: s.discard }));
    expect(switchOf(s.accessibilityTools).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("region", { name: s.saveBarLabel })).toBeNull();
  });

  it("protection level: Strict sets its fields and keeps the rest; it saves as one change set", async () => {
    const save = vi.fn<(a: unknown) => Promise<{ revision: number }>>(async () => ({ revision: 4 }));
    cx.fns["lockdown:update"] = save;
    ui(<Lockdown />);
    fireEvent.click(radio(s.presets.strict.name));
    expect(checkedOf(LEVELS)).toEqual([s.presets.strict.name]);
    expect(screen.getByRole("region", { name: s.saveBarLabel })).toBeTruthy();
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect((save.mock.calls[0]![0] as { settings: LockdownSettings }).settings).toEqual(applyPreset(D, "strict"));
    // The modes and the fields outside the levels were not touched.
    expect((save.mock.calls[0]![0] as { settings: LockdownSettings }).settings.appLocker).toEqual(D.appLocker);
    expect((save.mock.calls[0]![0] as { settings: LockdownSettings }).settings.machine.hideAdminTiles).toBe(D.machine.hideAdminTiles);
  });

  it("a setup made by hand reads Custom with the nearest level: Reset and the 'Changed' marks", () => {
    cx.results["lockdown:groupView"] = view({ settings: { ...D, accessibilityTools: true, usb: { ...D.usb, storage: "readOnly" } } });
    ui(<Lockdown />);
    expect(checkedOf(LEVELS)).toEqual([]);
    expect(screen.getByText(s.custom("Standard", 2))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: s.customShow }));
    expect(group(s.inputTitle)).toBeTruthy();
    expect(screen.getAllByText(s.changed)).toHaveLength(2);
    expect(screen.getByText(s.changedCount(2))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: s.customReset("Standard") }));
    expect(checkedOf(LEVELS)).toEqual([s.presets.standard.name]);
    expect(screen.queryByText(s.changed)).toBeNull();
  });

  it("program blocking: Block asks first, with the waiting programs and the safety-list sentence, then sets all three checks", async () => {
    const save = vi.fn<(a: unknown) => Promise<{ revision: number }>>(async () => ({ revision: 4 }));
    cx.fns["lockdown:update"] = save;
    cx.results["lockdown:groupView"] = view({ openFindings: 12 });
    ui(<Lockdown />);
    expect(within(card(s.reviewTitle)).getByText("12")).toBeTruthy();
    expect(within(card(s.reviewTitle)).getByRole("link", { name: s.reviewOpen }).getAttribute("href")).toBe("/lockdown/findings?group=g1");
    fireEvent.click(radio(s.modes.enforce));
    fireEvent.click(saveButton());
    const dialog = await screen.findByRole("dialog");
    expect(save).not.toHaveBeenCalled();
    expect(within(dialog).getByText(s.enforceTitle)).toBeTruthy();
    expect(within(dialog).getByText(s.enforceFindings(12, false))).toBeTruthy();
    expect(within(dialog).getByText(s.enforceAppControl)).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: s.enforceReview }).getAttribute("href")).toBe("/lockdown/findings?group=g1");
    fireEvent.click(within(dialog).getByRole("button", { name: s.enforceConfirm }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const sent = (save.mock.calls[0]![0] as { settings: LockdownSettings }).settings;
    expect([sent.appLocker.mode, sent.appControl.mode, sent.procWatch.mode]).toEqual(["enforce", "enforce", "enforce"]);
    expect(sent.appControl.level).toBe("recommendedBlocks");
  });

  it("Block for the employee program list alone (Advanced) leaves the safety-list sentence out; more than 50 programs says so", async () => {
    cx.fns["lockdown:update"] = vi.fn(async () => ({ revision: 4 }));
    cx.results["lockdown:groupView"] = view({ openFindings: 50, openFindingsMore: true });
    ui(<Lockdown />);
    expect(within(card(s.reviewTitle)).getByText("50+")).toBeTruthy();
    await openAdvanced();
    pickOption(s.appLocker, new RegExp(`^${s.modes.enforce}`));
    fireEvent.click(saveButton());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(s.enforceFindings(50, true))).toBeTruthy();
    expect(within(dialog).queryByText(s.enforceAppControl)).toBeNull();
  });

  it("mixed program checks: no card is checked, a line says so, and its button opens Advanced", () => {
    cx.results["lockdown:groupView"] = view({ settings: { ...D, appLocker: { mode: "enforce" } } });
    ui(<Lockdown />);
    expect(checkedOf(MODES)).toEqual([]);
    expect(screen.getByText(s.mixed, { exact: false })).toBeTruthy();
    expect(screen.queryByRole("region", { name: s.checksTitle })).toBeNull();
    fireEvent.click(within(card(s.modeTitle)).getByRole("button", { name: s.advanced }));
    expect(selectedText(s.appLocker)).toContain(s.modes.enforce);
    // Picking a mode brings all three together again.
    fireEvent.click(radio(s.modes.audit));
    expect(selectedText(s.appLocker)).toContain(s.modes.audit);
  });

  it("the trial run says how long it has run, and suggests Block after a week", () => {
    cx.results["lockdown:groupView"] = view({ auditSince: NOW - 3 * DAY });
    ui(<Lockdown />);
    expect(screen.getByText(s.trialDays(3))).toBeTruthy();
    cleanup();
    cx.results["lockdown:groupView"] = view({ auditSince: NOW - 9 * DAY });
    ui(<Lockdown />);
    expect(screen.getByText(s.trialLong(9))).toBeTruthy();
  });

  it("managed Wi-Fi asks first, and the server's refusal reads in words", async () => {
    cx.fns["lockdown:update"] = vi.fn().mockRejectedValue(new ConvexError({ code: "conflict", detail: "managed_networks_empty" }));
    ui(<Lockdown />);
    await openAdvanced();
    fireEvent.click(switchOf(s.wifiManagedOnly));
    fireEvent.click(saveButton());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(s.managedConfirm)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: s.enforceConfirm }));
    expect(await screen.findByText(s.managedEmpty)).toBeTruthy();
  });

  it("'Apply even if a PC goes offline' shows only while the Wi-Fi switch is on; ticked it is sent, not ticked it is left out", async () => {
    const save = vi.fn<(args?: unknown) => Promise<unknown>>(async () => ({ revision: 4 }));
    cx.fns["lockdown:update"] = save;
    ui(<Lockdown />);
    await openAdvanced();
    const net = () => within(group(s.netTitle));
    expect(net().queryByRole("checkbox", { name: s.wifiManagedOnlyConfirm })).toBeNull();
    fireEvent.click(switchOf(s.wifiManagedOnly));
    const box = net().getByRole("checkbox", { name: s.wifiManagedOnlyConfirm }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect((net().getByRole("checkbox", { name: s.wifiManagedOnlyConfirm }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(saveButton());
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: s.enforceConfirm }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({ settings: { wifiManagedOnly: true, wifiManagedOnlyConfirmed: true } });
  });

  it("not ticked, or ticked and then Wi-Fi switched off again: the key is not sent", async () => {
    const save = vi.fn<(args?: unknown) => Promise<unknown>>(async () => ({ revision: 4 }));
    cx.fns["lockdown:update"] = save;
    ui(<Lockdown />);
    await openAdvanced();
    fireEvent.click(switchOf(s.wifiManagedOnly));
    fireEvent.click(saveButton());
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: s.enforceConfirm }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect((save.mock.calls[0]![0] as { settings: LockdownSettings }).settings).not.toHaveProperty("wifiManagedOnlyConfirmed");
    cleanup();
    save.mockClear();
    ui(<Lockdown />);
    await openAdvanced();
    fireEvent.click(switchOf(s.wifiManagedOnly));
    fireEvent.click(screen.getByRole("checkbox", { name: s.wifiManagedOnlyConfirm }));
    fireEvent.click(switchOf(s.wifiManagedOnly));
    expect(screen.queryByRole("checkbox", { name: s.wifiManagedOnlyConfirm })).toBeNull();
    fireEvent.click(switchOf(s.accessibilityTools));
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect((save.mock.calls[0]![0] as { settings: LockdownSettings }).settings).not.toHaveProperty("wifiManagedOnlyConfirmed");
  });

  it("a stale edit offers Reload, which brings the saved values back", async () => {
    cx.fns["lockdown:update"] = vi.fn().mockRejectedValue(new ConvexError({ code: "stale_edit" }));
    ui(<Lockdown />);
    await openAdvanced();
    fireEvent.click(switchOf(s.accessibilityTools));
    fireEvent.click(saveButton());
    expect(await screen.findByText(strings.common.staleTitle)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.common.reload }));
    await openAdvanced();
    expect(switchOf(s.accessibilityTools).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(strings.common.staleTitle)).toBeNull();
  });

  it("a wrong lockout number opens Advanced, shows the error at its field and sends nothing", async () => {
    const save = vi.fn(async () => ({ revision: 4 }));
    cx.fns["lockdown:update"] = save;
    ui(<Lockdown />);
    await openAdvanced();
    fireEvent.change(screen.getByLabelText(s.lockoutThreshold), { target: { value: "3" } });
    // Close Advanced by hand: the failed Save opens it again and focuses the wrong field.
    fireEvent.click(document.querySelector(".lk-adv > summary")!);
    expect(screen.queryByLabelText(s.lockoutThreshold)).toBeNull();
    fireEvent.click(saveButton());
    expect(await screen.findByText(s.lockoutProblems.threshold)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(s.lockoutThreshold)));
  });

  it("Your PCs: how many have the newest settings, who could not apply them, and what is waiting", () => {
    ui(<Lockdown />);
    const sc = card(s.syncTitle);
    expect(within(sc).getByText(s.upToDate(2, 5, false))).toBeTruthy();
    const bar = within(sc).getByRole("progressbar", { name: s.syncBar });
    expect(bar.getAttribute("aria-valuenow")).toBe("2");
    expect(bar.getAttribute("aria-valuemax")).toBe("5");
    expect(within(sc).getByText(s.problems(1), { exact: false })).toBeTruthy();
    expect(within(sc).getByRole("link", { name: "COUNTER-03" }).getAttribute("href")).toBe("/devices/d3");
    expect(within(sc).getByText(s.waiting(2))).toBeTruthy();
  });

  it("Your PCs: all up to date, nothing sent yet, no PCs, more than 200, rings, Home PCs and the admin-accounts warning", () => {
    const text = (over: Partial<LockdownSync>) => {
      cleanup();
      cx.results["lockdown:groupSync"] = sync(over);
      ui(<Lockdown />);
      return card(s.syncTitle);
    };
    expect(within(text({ total: 8, upToDate: 8, problems: 0, problemPcs: [] })).getByText(s.allUpToDate(8))).toBeTruthy();
    expect(within(text({ newestVersion: null, upToDate: 0, problems: 0, problemPcs: [] })).getByText(s.notSent)).toBeTruthy();
    const empty = text({ total: 0, upToDate: 0, problems: 0, problemPcs: [] });
    expect(within(empty).getByText(s.noPcs)).toBeTruthy();
    expect(within(empty).getByRole("link", { name: s.noPcsAction }).getAttribute("href")).toBe("/enrollment");
    expect(within(text({ total: 200, totalMore: true, upToDate: 150, problems: 0, problemPcs: [] })).getByText(s.upToDate(150, 200, true))).toBeTruthy();
    const rings = text({ ringsOn: true });
    expect(within(rings).getByText(s.ringsOn, { exact: false })).toBeTruthy();
    expect(within(rings).getByRole("link", { name: s.ringsAction }).getAttribute("href")).toBe("/groups/g1/rollout");
    expect(within(text({ ringsOn: true, rolloutState: "halted" })).getByText(s.ringsHalted, { exact: false })).toBeTruthy();
    expect(within(text({ reduced: 2 })).getByText(s.reduced(2))).toBeTruthy();
    expect(within(text({ adminTilesPending: 2 })).getByText(s.adminTilesPending(2))).toBeTruthy();
  });

  it("the admin-accounts warning also sits under 'Hide administrator accounts' while that switch is on", async () => {
    cx.results["lockdown:groupSync"] = sync({ adminTilesPending: 2 });
    // The switch is off for a new group (owner 2026-11-28), so this group has it on.
    cx.results["lockdown:groupView"] = view({ settings: { ...D, machine: { ...D.machine, hideAdminTiles: true } } });
    ui(<Lockdown />);
    await openAdvanced();
    const machine = group(s.machineTitle);
    expect(within(machine).getByText(s.adminTilesPending(2))).toBeTruthy();
    fireEvent.click(within(machine).getByRole("switch", { name: s.machine.hideAdminTiles[0] }));
    expect(within(machine).queryByText(s.adminTilesPending(2))).toBeNull();
  });

  it("a Home PC's note and the strict list's warning stay visible, not in a tooltip", async () => {
    cx.results["lockdown:groupView"] = view({ settings: { ...D, appControl: { mode: "audit", level: "allowlist" } } });
    ui(<Lockdown />);
    await openAdvanced();
    expect(within(group(s.checksTitle)).getByText(s.levelHelp.allowlist)).toBeTruthy();
    expect(screen.getAllByText(s.changed).length).toBeGreaterThan(0);
  });

  it("extra allowed programs: a hash rule is marked 'Allow again after updates'; Remove asks, then calls the server", async () => {
    const remove = vi.fn<(a: unknown) => Promise<null>>(async () => null);
    cx.fns["lockdown:removeException"] = remove;
    cx.results["lockdown:groupView"] = view({
      exceptions: [exception(), exception({ _id: "e2", rule: { kind: "hash", subject: null, product: null, fileName: null, hashStart: "9f2c41d07ab3", path: null }, reason: "" })],
    });
    ui(<Lockdown />);
    const list = within(card(s.exceptionsTitle)).getByRole("list");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("tool.exe from Contoso Ltd")).toBeTruthy();
    expect(within(rows[0]!).queryByText(s.breaksOnUpdate)).toBeNull();
    expect(within(rows[1]!).getByText(s.breaksOnUpdate)).toBeTruthy();
    // The fingerprint is not in the row, only in its hover text.
    expect(rows[1]!.textContent).not.toContain("9f2c41d07ab3");
    expect(rows[1]!.getAttribute("title")).toContain("9f2c41d07ab3");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: new RegExp(`^${s.removeException}`) }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: s.removeException }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ exceptionId: "e2" }));
  });

  it("a viewer reads: every control is disabled, no save bar, no Remove, and the PCs and the review link are there", async () => {
    cx.results["lockdown:groupView"] = view({ exceptions: [exception()], openFindings: 2 });
    ui(<Lockdown />, "viewer");
    expect(screen.getByText(s.readOnly)).toBeTruthy();
    await openAdvanced();
    const controls = [...screen.getAllByRole("radio"), ...screen.getAllByRole("switch"), ...screen.getAllByRole("checkbox"), ...screen.getAllByRole("textbox")];
    expect(controls.length).toBeGreaterThan(25);
    for (const c of controls) expect((c as HTMLInputElement).disabled, c.getAttribute("aria-label") ?? c.id).toBe(true);
    for (const trigger of screen.getAllByRole("button", { name: /USB|Scanners|Phones|Other USB|list|check|strength/i })) {
      if (trigger.getAttribute("aria-haspopup")) expect((trigger as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.queryByRole("region", { name: s.saveBarLabel })).toBeNull();
    expect(screen.queryByRole("button", { name: s.save })).toBeNull();
    expect(screen.queryByRole("button", { name: new RegExp(`^${s.removeException}`) })).toBeNull();
    expect(within(card(s.syncTitle)).getByText(s.upToDate(2, 5, false))).toBeTruthy();
    expect(screen.getByRole("link", { name: s.reviewOpen })).toBeTruthy();
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
  const named = (verb: string) => new RegExp(`^${verb}`);

  it("lists one row per program without a path, and asks the server for the open ones, last seen first", () => {
    cx.results["lockdown:findings"] = page(rows);
    ui(<Findings />, "admin", "/lockdown/findings");
    expect(lastArgs("lockdown:findings")).toEqual({ status: "new", paginationOpts: { numItems: 10, cursor: null }, sort: { key: "seen", dir: "desc" } });
    const table = screen.getByRole("table");
    expect(within(table).getByText("tool.exe")).toBeTruthy();
    // Who made it is under the name; no column for the publisher or the rule.
    expect(within(table).getAllByText("Contoso Ltd")).toHaveLength(2);
    expect(within(table).getByText(fs.unsigned)).toBeTruthy();
    expect(within(table).getAllByText(fs.folders.removable!).length).toBeGreaterThan(0);
    expect(within(table).getAllByText(fs.pcs(3))).toHaveLength(2);
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([fs.colProgram, fs.colWhere, fs.colDevices, expect.stringContaining(fs.colSeen), fs.colActions].map((x) => x));
    expect(within(table).queryByText(fs.layers.appControl)).toBeNull();
    expect(table.textContent).not.toMatch(/[A-Z]:\\|\\Users\\/);
  });

  it("the status is three tabs; Next asks for the next page with the server's cursor and a tab starts over", () => {
    cx.results["lockdown:findings"] = page(rows, false, "cursor-2");
    ui(<Findings />, "admin", "/lockdown/findings");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([fs.statuses.new, fs.statuses.allowed, fs.statuses.ignored]);
    fireEvent.click(screen.getByRole("button", { name: strings.pager.next }));
    expect(lastArgs("lockdown:findings")).toEqual({ status: "new", paginationOpts: { numItems: 10, cursor: "cursor-2" }, sort: { key: "seen", dir: "desc" } });
    fireEvent.click(screen.getByRole("tab", { name: fs.statuses.ignored }));
    expect(lastArgs("lockdown:findings")).toEqual({ status: "ignored", paginationOpts: { numItems: 10, cursor: null }, sort: { key: "seen", dir: "desc" } });
  });

  it("the status in the URL is used; an unknown one falls back to open", () => {
    ui(<Findings />, "admin", "/lockdown/findings?status=allowed");
    expect((lastArgs("lockdown:findings") as { status: string }).status).toBe("allowed");
    expect(screen.getByRole("tab", { name: fs.statuses.allowed }).getAttribute("aria-selected")).toBe("true");
    cleanup();
    cx.queried = [];
    ui(<Findings />, "admin", "/lockdown/findings?status=nope");
    expect((lastArgs("lockdown:findings") as { status: string }).status).toBe("new");
  });

  it("an empty list says so; the steps of a review are on the side", () => {
    ui(<Findings />, "admin", "/lockdown/findings");
    expect(screen.getByText(fs.emptyTitle.new)).toBeTruthy();
    expect(within(screen.getByRole("region", { name: fs.howTitle })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(fs.howSteps);
  });

  it("with ?group= the title links back to that group's lockdown page", () => {
    ui(<Findings />, "admin", "/lockdown/findings?group=g1");
    expect(screen.getByRole("link", { name: fs.backToLockdown }).getAttribute("href")).toBe("/groups/g1/lockdown");
  });

  it("a viewer sees the rows and no actions", () => {
    cx.results["lockdown:findings"] = page(rows);
    ui(<Findings />, "viewer", "/lockdown/findings");
    expect(screen.getByText("tool.exe")).toBeTruthy();
    expect(screen.queryByRole("button", { name: named(fs.allow) })).toBeNull();
    expect(screen.queryByRole("button", { name: named(fs.ignore) })).toBeNull();
    expect(cx.queried.some((q) => q.name === "lockdown:allowOptions")).toBe(false);
  });

  it("Ignore asks, then calls the server", async () => {
    const ignore = vi.fn<(a: unknown) => Promise<null>>(async () => null);
    cx.fns["lockdown:ignore"] = ignore;
    cx.results["lockdown:findings"] = page(rows);
    ui(<Findings />, "admin", "/lockdown/findings");
    fireEvent.click(screen.getAllByRole("button", { name: named(fs.ignore) })[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(fs.ignoreTitle("tool.exe"))).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: fs.ignore }));
    await waitFor(() => expect(ignore).toHaveBeenCalledWith({ findingId: "f1" }));
    expect(await screen.findByText(fs.ignored)).toBeTruthy();
  });

  it("Windows safety list programs can only be ignored, and the name says why", () => {
    cx.results["lockdown:findings"] = page(rows);
    ui(<Findings />, "admin", "/lockdown/findings");
    const allows = screen.getAllByRole("button", { name: named(fs.allow) }) as HTMLButtonElement[];
    // tool.exe can be allowed; notes.exe has no way to be recognised (disabled); driver-tool.exe has no Allow at all.
    expect(allows.map((b) => [b.getAttribute("aria-label"), b.disabled])).toEqual([[`${fs.allow}: tool.exe`, false], [`${fs.allow}: notes.exe`, true]]);
    expect(screen.getAllByRole("button", { name: named(fs.ignore) })).toHaveLength(3);
    expect(screen.getByText(fs.appControlNote)).toBeTruthy();
  });

  it("Ignored rows can be allowed again, not ignored again; Allowed rows have no action", () => {
    cx.results["lockdown:findings"] = page([finding({ status: "ignored" })]);
    ui(<Findings />, "admin", "/lockdown/findings?status=ignored");
    expect(screen.getByRole("button", { name: named(fs.allow) })).toBeTruthy();
    expect(screen.queryByRole("button", { name: named(fs.ignore) })).toBeNull();
    cleanup();
    cx.results["lockdown:findings"] = page([finding({ status: "allowed" })]);
    ui(<Findings />, "admin", "/lockdown/findings?status=allowed");
    expect(screen.queryByRole("button", { name: named(fs.allow) })).toBeNull();
  });

  const openAllow = (f: FindingRow, path = "/lockdown/findings") => {
    cx.results["lockdown:findings"] = page([f]);
    ui(<Findings />, "admin", path);
    expect(cx.queried.some((q) => q.name === "lockdown:allowOptions")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: named(fs.allow) }));
    return screen.getByRole("dialog");
  };
  const openAllowAdvanced = (dialog: HTMLElement) => fireEvent.click(dialog.querySelector(".lk-allow__adv > summary")!);

  it("Allow: the way to recognise the program is picked for you and said in one sentence; the group comes from ?group=", async () => {
    const allow = vi.fn<(a: unknown) => Promise<{ added: number }>>(async () => ({ added: 1 }));
    cx.fns["lockdown:allow"] = allow;
    const dialog = openAllow(finding(), "/lockdown/findings?group=g2");
    expect(cx.queried.some((q) => q.name === "lockdown:allowOptions")).toBe(true);
    expect(within(dialog).getByText(fs.recognisedBy.publisher("Contoso Ltd"))).toBeTruthy();
    // The kind is not asked: it is under Advanced.
    expect(within(dialog).queryByLabelText(fs.ruleKind)).toBeNull();
    expect((within(dialog).getByRole("checkbox", { name: "Back office" }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole("checkbox", { name: "Front desk" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: fs.allowConfirm }));
    await waitFor(() => expect(allow).toHaveBeenCalledWith({ findingId: "f1", kind: "publisher", groupIds: ["g2"] }));
    expect(await screen.findByText(fs.allowed(1))).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Allow: without a group in the address nothing is chosen, and the groups, the app and the note are sent", async () => {
    const allow = vi.fn<(a: unknown) => Promise<{ added: number }>>(async () => ({ added: 2 }));
    cx.fns["lockdown:allow"] = allow;
    const dialog = openAllow(finding());
    fireEvent.click(within(dialog).getByRole("button", { name: fs.allowConfirm }));
    expect(within(dialog).getByText(fs.groupsProblem)).toBeTruthy();
    expect(allow).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Front desk" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Back office" }));
    openAllowAdvanced(dialog);
    pickOption(new RegExp(fs.app), "Label Designer");
    fireEvent.change(screen.getByLabelText(new RegExp(fs.reason)), { target: { value: " Needed by sales " } });
    fireEvent.click(within(dialog).getByRole("button", { name: fs.allowConfirm }));
    await waitFor(() => expect(allow).toHaveBeenCalledTimes(1));
    expect(allow.mock.calls[0]![0]).toEqual({ findingId: "f1", kind: "publisher", groupIds: ["g1", "g2"], appId: "a1", reason: "Needed by sales" });
  });

  it("Allow: the only group is chosen for you and the picker is hidden", async () => {
    const allow = vi.fn<(a: unknown) => Promise<{ added: number }>>(async () => ({ added: 1 }));
    cx.fns["lockdown:allow"] = allow;
    cx.results["lockdown:allowOptions"] = { groups: [{ _id: "g1", name: "Front desk" }], apps: [] };
    const dialog = openAllow(finding());
    expect(within(dialog).getByText(fs.groupsOne("Front desk"))).toBeTruthy();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: fs.allowConfirm }));
    await waitFor(() => expect(allow).toHaveBeenCalledWith({ findingId: "f1", kind: "publisher", groupIds: ["g1"] }));
  });

  it("Allow: more than eight groups get a box to find one", () => {
    cx.results["lockdown:allowOptions"] = { groups: Array.from({ length: 9 }, (_, i) => ({ _id: `g${i + 1}`, name: `Shop ${i + 1}` })), apps: [] };
    const dialog = openAllow(finding());
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(9);
    fireEvent.change(within(dialog).getByLabelText(fs.groupsFilter), { target: { value: "shop 7" } });
    expect(within(dialog).getAllByRole("checkbox").map((c) => (c as HTMLInputElement).labels?.[0]?.textContent)).toEqual(["Shop 7"]);
  });

  it("Allow: an unsigned program is recognised by its exact version, with a warning; Advanced lists the kinds and why one is out", async () => {
    const allow = vi.fn<(a: unknown) => Promise<{ added: number }>>(async () => ({ added: 1 }));
    cx.fns["lockdown:allow"] = allow;
    const dialog = openAllow(finding({ signer: null }), "/lockdown/findings?group=g1");
    expect(within(dialog).getByText(fs.recognisedBy.hash)).toBeTruthy();
    openAllowAdvanced(dialog);
    expect(selectedText(new RegExp(fs.ruleKind))).toContain(fs.kinds.hash);
    fireEvent.click(screen.getByLabelText(new RegExp(fs.ruleKind)));
    const publisher = within(screen.getByRole("listbox")).getByRole("option", { name: new RegExp(fs.kinds.publisher.split(" (")[0]!) });
    expect(publisher.getAttribute("aria-disabled")).toBe("true");
    expect(publisher.textContent).toContain(fs.kindUnavailable.publisher);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    fireEvent.click(within(dialog).getByRole("button", { name: fs.allowConfirm }));
    await waitFor(() => expect(allow).toHaveBeenCalledWith({ findingId: "f1", kind: "hash", groupIds: ["g1"] }));
  });

  it("Allow: a folder rule only under an admin-only folder; Advanced opens by itself with the folder prefilled and checked", async () => {
    const allow = vi.fn<(a: unknown) => Promise<{ added: number }>>(async () => ({ added: 1 }));
    cx.fns["lockdown:allow"] = allow;
    const dialog = openAllow(finding({ signer: null, hasHash: false, folderClass: "programFiles" }), "/lockdown/findings?group=g1");
    expect(within(dialog).getByText(fs.recognisedBy.path)).toBeTruthy();
    const folder = screen.getByLabelText(new RegExp(fs.folder)) as HTMLInputElement;
    expect(folder.value).toBe("{ProgramFiles}\\");
    fireEvent.click(within(dialog).getByRole("button", { name: fs.allowConfirm }));
    expect(within(dialog).getByText(fs.folderProblem)).toBeTruthy();
    expect(allow).not.toHaveBeenCalled();
    fireEvent.change(folder, { target: { value: "C:\\Users\\maya" } });
    fireEvent.click(within(dialog).getByRole("button", { name: fs.allowConfirm }));
    expect(allow).not.toHaveBeenCalled();
    fireEvent.change(folder, { target: { value: "{ProgramFiles}\\Acme" } });
    fireEvent.click(within(dialog).getByRole("button", { name: fs.allowConfirm }));
    await waitFor(() => expect(allow).toHaveBeenCalledWith({ findingId: "f1", kind: "path", folder: "{ProgramFiles}\\Acme", groupIds: ["g1"] }));
  });

  it("Allow: the server's refusal reads in words and the dialog stays open", async () => {
    cx.fns["lockdown:allow"] = vi.fn().mockRejectedValue(new ConvexError({ code: "too_large", detail: "exceptions" }));
    const dialog = openAllow(finding(), "/lockdown/findings?group=g1");
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
