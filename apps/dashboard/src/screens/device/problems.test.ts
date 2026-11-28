import { describe, expect, it } from "vitest";
import type { ApplyReport, DeviceLiveness, DevicePage, DeviceReport, LayerName, Role } from "../../data/types";
import { formatTime } from "../../lib/format";
import { REFUSAL_CODES, REFUSALS } from "../lockdown/codes";
import { OFFLINE_PROBLEM_AFTER_MS, deviceProblems, problemBadge, splitProblems, type Problem } from "./problems";
import { COMPAT_RULES, KIOSK_ERRORS, LOCKDOWN_RULES, problemStrings as s } from "./problemStrings";

// The "Needs attention" model (device-detail.md section 5): one test per row of the table, plus ordering, de-duplication and roles.

const NOW = Date.UTC(2026, 10, 28, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ok = (mode = "on") => ({ mode, state: "ok" });
const layers = (over: Partial<ApplyReport["layers"]> = {}): ApplyReport["layers"] => ({
  staff: ok(),
  machine: ok(),
  appLocker: ok("audit"),
  appControl: ok("audit"),
  procWatch: ok("audit"),
  boot: ok(),
  performance: ok(),
  ...over,
});
const applyReport = (over: Omit<Partial<ApplyReport>, "layers"> & { layers?: Partial<ApplyReport["layers"]> } = {}): ApplyReport => ({
  state: "applied",
  refusal: null,
  appliedVersion: 8,
  lkgVersion: 8,
  configVersion: 8,
  updatedAt: NOW - 2 * HOUR,
  ...over,
  layers: layers(over.layers),
});

const cleanReport = (over: Partial<DeviceReport> = {}): DeviceReport => ({
  agentVersion: "0.4.1",
  kioskPhase: "applied",
  shellHealth: "healthy",
  trustedKeyIds: ["a1b2c3d4e5f60718"],
  outOfSupport: false,
  updatedAt: NOW - HOUR,
  compat: { os: {} as never, blockers: [], warnings: [], liteMode: false },
  ...over,
});

/** A healthy, online PC in a group: no problem at all. */
const page = (over: Partial<DevicePage> = {}): DevicePage => ({
  _id: "d1",
  name: "OFFICE-SCANNER",
  revision: 1,
  revoked: false,
  kioskEnabled: true,
  enrolledAt: NOW - 30 * DAY,
  group: { _id: "g1", name: "Back office" },
  displayMode: "auto",
  groupDisplayMode: "auto",
  presence: { online: true, since: NOW - 40 * DAY },
  report: cleanReport(),
  outOfSupport: false,
  latestVersion: 8,
  planState: "ok",
  flags: { noGroup: false, revoked: false, rotateCredential: false },
  lock: null,
  ring: "everyone",
  usbAllowUntil: null,
  protection: null,
  lockdownCapable: true,
  apply: applyReport(),
  failedInstalls: { count: 0, more: false, names: [] },
  network: { wifiFailed: 0, printersFailed: 0 },
  ...over,
});

const withReport = (over: Partial<DeviceReport>, rest: Partial<DevicePage> = {}) => page({ report: cleanReport(over), ...rest });
const compat = (blockers: string[], warnings: string[]): DeviceReport["compat"] => ({ os: {} as never, blockers, warnings, liteMode: false });

const seen: DeviceLiveness = { lastContactAt: NOW - 60_000, online: true, fastUntil: null };
const never: DeviceLiveness = { lastContactAt: null, online: false, fastUntil: null };

const problems = (p: DevicePage, role: Role = "admin", live: DeviceLiveness | null = seen) => deviceProblems(p, live, NOW, role);
const one = (p: DevicePage, id: string, role: Role = "admin", live: DeviceLiveness | null = seen): Problem => {
  const hit = problems(p, role, live).find((x) => x.id === id);
  if (!hit) throw new Error(`no problem ${id} in ${problems(p, role, live).map((x) => x.id).join(", ")}`);
  return hit;
};
const ids = (p: DevicePage, role: Role = "admin", live: DeviceLiveness | null = seen) => problems(p, role, live).map((x) => x.id);
const layerState = (name: LayerName, state: string, detail?: string, mode = "on"): Partial<ApplyReport["layers"]> => ({ [name]: detail === undefined ? { mode, state } : { mode, state, detail } });

describe("deviceProblems", () => {
  it("a healthy PC has nothing that needs attention", () => {
    expect(problems(page())).toEqual([]);
    expect(problems(page(), "viewer")).toEqual([]);
  });

  it("a PC that has not reported anything yet (an older agent: no fields) raises nothing by itself", () => {
    const old = page({ report: { outOfSupport: false, updatedAt: NOW, agentVersion: "0.3.0" }, apply: null, lockdownCapable: false, protection: null });
    expect(ids(old)).toEqual(["tooOld"]);
    expect(ids(page({ report: null, apply: null, lockdownCapable: null }), "admin", null)).toEqual([]);
  });

  describe("revoked", () => {
    const revoked = page({
      revoked: true,
      flags: { noGroup: true, revoked: true, rotateCredential: false },
      kioskEnabled: false,
      lock: { lockId: "l", message: "m", lockedAt: 1 },
      report: cleanReport({ kioskError: "s_mode" }),
    });

    it("replaces the whole list with one danger problem; the admin goes to Remove", () => {
      const list = problems(revoked);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: "revoked",
        severity: "danger",
        title: s.revoked.title,
        action: { kind: "tab", tab: "settings", focus: "remove" },
      });
    });

    it("a viewer sees it without a button", () => {
      expect(problems(revoked, "viewer")[0]!.action).toBeUndefined();
    });
  });

  describe("locked", () => {
    const locked = page({ lock: { lockId: "l1", message: "Back in 5", lockedAt: NOW } });
    it("is a danger problem with Unlock for an admin (a run action)", () => {
      expect(one(locked, "locked")).toMatchObject({ severity: "danger", title: s.locked.title, action: { kind: "run", run: "unlock" } });
      expect(problems(locked)[0]!.id).toBe("locked");
    });
    it("a viewer gets no button", () => {
      expect(one(locked, "locked", "viewer").action).toBeUndefined();
    });
  });

  it("suspended: a danger problem without a button", () => {
    expect(one(page({ planState: "suspended" }), "suspended")).toMatchObject({ severity: "danger", title: s.suspended.title });
    expect(one(page({ planState: "suspended" }), "suspended").action).toBeUndefined();
  });

  describe("never seen", () => {
    const fresh = page({ report: null, apply: null, lockdownCapable: null, presence: { online: false, since: null } });
    it("a PC with no report and no contact: an info problem with the enrollment link for an admin", () => {
      expect(one(fresh, "neverSeen", "admin", never)).toMatchObject({ severity: "info", title: s.neverSeen.title, action: { kind: "link", to: "/enrollment" } });
    });
    it("a viewer gets no enrollment link", () => {
      expect(one(fresh, "neverSeen", "viewer", never).action).toBeUndefined();
    });
    it("a liveness query that failed or is loading says nothing; a PC that called in is not new", () => {
      expect(ids(fresh, "admin", null)).toEqual([]);
      expect(ids(fresh, "admin", seen)).toEqual([]);
    });
  });

  describe("untrusted signing key", () => {
    const code = { kioskError: "desired_state_untrusted", kioskPhase: "failed" as const };
    it("the kiosk error, an empty key list, or both are ONE danger problem", () => {
      for (const over of [code, { trustedKeyIds: [] }, { ...code, trustedKeyIds: [] }]) {
        const list = problems(withReport(over)).filter((x) => x.id === "untrusted");
        expect(list, JSON.stringify(over)).toHaveLength(1);
      }
      expect(problems(withReport({ ...code, trustedKeyIds: [] })).map((x) => x.id)).toEqual(["untrusted"]);
    });
    it("plain words and the enrollment link; the code, the keys and the command are in the technical details only", () => {
      const p = one(withReport({ ...code, trustedKeyIds: [] }), "untrusted");
      expect(p).toMatchObject({ severity: "danger", title: s.untrusted.title, action: { kind: "link", to: "/enrollment" } });
      expect(`${p.title} ${p.body}`).not.toMatch(/desired_state_untrusted|trust-key/);
      expect(p.tech).toEqual([
        { label: s.techCode, value: "desired_state_untrusted" },
        { label: s.techKeys, value: s.untrusted.trustNone },
        { label: s.techOnPc, value: "rulebox-agent trust-key" },
      ]);
    });
    it("an older agent that does not report its keys raises nothing; a viewer gets no enrollment link", () => {
      expect(ids(withReport({ trustedKeyIds: undefined }))).toEqual([]);
      expect(one(withReport({ trustedKeyIds: [] }), "untrusted", "viewer").action).toBeUndefined();
    });
  });

  describe("kiosk errors", () => {
    it.each(Object.keys(KIOSK_ERRORS))("%s has its own plain title; the code is only in the technical details", (code) => {
      const p = one(withReport({ kioskError: code }), `kioskError:${code}`, "owner");
      expect(p).toMatchObject({ severity: "danger", title: KIOSK_ERRORS[code]!.title });
      expect(`${p.title} ${p.body}`).not.toContain(code);
      expect(p.tech).toEqual([{ label: s.techCode, value: code }]);
    });
    it("the administrator exit codes link to Settings for an admin only", () => {
      const p = withReport({ kioskError: "admin_exit_hotkey_invalid" });
      expect(one(p, "kioskError:admin_exit_hotkey_invalid")).toMatchObject({ title: "The administrator exit settings are not valid", action: { kind: "link", to: "/settings?tab=adminExit" } });
      expect(one(p, "kioskError:admin_exit_hotkey_invalid", "viewer").action).toBeUndefined();
    });
    it("a code about the PC's settings points the owner to the update, others to the owner", () => {
      const p = withReport({ kioskError: "desired_state_invalid" });
      expect(one(p, "kioskError:desired_state_invalid", "owner")).toMatchObject({ action: { kind: "link", to: "/settings?tab=updates" } });
      const admin = one(p, "kioskError:desired_state_invalid", "admin");
      expect(admin.action).toBeUndefined();
      expect(admin.body).toContain(s.askOwner);
    });
    it("a code nobody knows gets the generic title, with the raw code in the technical details only", () => {
      const p = one(withReport({ kioskError: "brand_new_code" }), "kioskError:brand_new_code");
      expect(p.title).toBe("The kiosk reported a problem");
      expect(`${p.title} ${p.body}`).not.toContain("brand_new_code");
      expect(p.tech).toEqual([{ label: s.techCode, value: "brand_new_code" }]);
    });
    it("a compatibility blocker the kiosk repeats is the same problem as the blocker", () => {
      const p = withReport({ kioskError: "s_mode", compat: compat(["s_mode"], []) });
      expect(problems(p).map((x) => x.id)).toEqual(["compat:s_mode"]);
    });
    it("a failed kiosk without a code is its own problem; with a code the code's problem is enough", () => {
      expect(one(withReport({ kioskPhase: "failed" }), "kioskFailed")).toMatchObject({ severity: "danger", title: s.kioskFailed.title });
      expect(ids(withReport({ kioskPhase: "failed", kioskError: "access_denied" }))).toEqual(["kioskError:access_denied"]);
    });
  });

  describe("the PC did not apply the lockdown", () => {
    const refused = (refusal: string | null, over: Partial<DevicePage> = {}) => page({ apply: applyReport({ state: "refused", refusal }), ...over });
    it("names the refusal in the sentence of codes.ts", () => {
      const p = one(refused("would_block_exit"), "lockdownRefused");
      expect(p).toMatchObject({ severity: "danger", title: s.lockdownRefused.title, body: REFUSALS.would_block_exit });
      expect(p.tech).toEqual([{ label: s.techCode, value: "would_block_exit" }]);
    });
    it("managed_networks_empty goes to the networks", () => {
      expect(one(refused("managed_networks_empty"), "lockdownRefused").action).toEqual({ kind: "link", to: "/networks", label: s.openNetworks });
    });
    it.each(["admin_signin_unverified", "lockout_threshold_too_low", "would_block_rulebox", "would_block_admin", "would_block_input_device", "would_disconnect"])(
      "%s opens the group's lockdown",
      (code) => {
        expect(one(refused(code), "lockdownRefused").action).toEqual({ kind: "link", to: "/groups/g1/lockdown", label: s.openGroupLockdown });
      },
    );
    it("a PC without a group has nowhere to go", () => {
      expect(one(refused("would_block_exit", { group: null }), "lockdownRefused").action).toBeUndefined();
    });
    it("a newer Rulebox on the PC: the owner gets the update link, others are told to ask the owner", () => {
      expect(one(refused("journal_unknown_target"), "lockdownRefused", "owner").action).toMatchObject({ to: "/settings?tab=updates" });
      const asAdmin = one(refused("section_unknown_value"), "lockdownRefused", "admin");
      expect(asAdmin.action).toBeUndefined();
      expect(asAdmin.body.endsWith(s.askOwner)).toBe(true);
    });
    it("every refusal code of the plan has a plain sentence and no raw code in the title", () => {
      for (const code of REFUSAL_CODES) {
        const p = one(refused(code), "lockdownRefused", "owner");
        expect(p.body, code).toBe(REFUSALS[code]);
        expect(p.title).not.toContain(code);
      }
    });
    it("a refusal code nobody knows keeps the generic words and the code in the technical details", () => {
      const p = one(refused("brand_new_refusal"), "lockdownRefused");
      expect(p.body).toBe(s.lockdownRefused.fallbackBody);
      expect(`${p.title} ${p.body}`).not.toContain("brand_new_refusal");
      expect(p.tech).toEqual([{ label: s.techCode, value: "brand_new_refusal" }]);
    });
  });

  it("rolled back: a danger problem that opens the group's lockdown", () => {
    const p = one(page({ apply: applyReport({ state: "rolledBack", refusal: "crash_loop" }) }), "rolledBack");
    expect(p).toMatchObject({ severity: "danger", title: s.rolledBack.title, action: { kind: "link", to: "/groups/g1/lockdown" } });
    expect(p.tech).toEqual([{ label: s.techCode, value: "crash_loop" }]);
  });

  describe("layers that failed or are only partly applied", () => {
    it("a failed layer is danger, a partial one is warning", () => {
      const failed = page({ apply: applyReport({ state: "failed", layers: layerState("appLocker", "failed", "applocker_foreign_policy", "enforce") }) });
      expect(one(failed, "layer:applocker_foreign_policy")).toMatchObject({ severity: "danger", title: LOCKDOWN_RULES.applocker_foreign_policy!.title });
      const partial = page({ apply: applyReport({ state: "partial", layers: layerState("machine", "partial", "fighting") }) });
      expect(one(partial, "layer:fighting")).toMatchObject({ severity: "warning", title: LOCKDOWN_RULES.fighting!.title });
    });
    it("one problem per code, however many layers report it; the layers are named in the technical details", () => {
      const p = page({
        apply: applyReport({ state: "partial", layers: { ...layerState("machine", "partial", "access_denied"), ...layerState("boot", "failed", "access_denied") } }),
      });
      const list = problems(p).filter((x) => x.id === "layer:access_denied");
      expect(list).toHaveLength(1);
      expect(list[0]!.severity).toBe("danger");
      expect(list[0]!.tech).toEqual([
        { label: s.techCode, value: "access_denied" },
        { label: s.techLayers, value: "PC restrictions, Start-up and tamper protection" },
      ]);
    });
    it("a harmless note (the PC chose to keep something) is only good to know", () => {
      const p = page({ apply: applyReport({ state: "partial", layers: layerState("performance", "partial", "no_printing_ignored") }) });
      expect(one(p, "layer:no_printing_ignored").severity).toBe("info");
    });
    it("a code that is in codes.ts but not in the registry: the generic title with the sentence of codes.ts", () => {
      const p = one(page({ apply: applyReport({ state: "partial", layers: layerState("boot", "partial", "acl_unreadable") }) }), "layer:acl_unreadable");
      expect(p.title).toBe("Part of the lockdown is only partly applied");
      expect(p.body).toBe("A folder protection could not be read.");
    });
    it("a code nobody knows: the generic title and sentence, the raw code only in the technical details", () => {
      const p = one(page({ apply: applyReport({ state: "failed", layers: layerState("procWatch", "failed", "brand_new_note") }) }), "layer:brand_new_note");
      expect(p.title).toBe("Part of the lockdown could not be applied");
      expect(`${p.title} ${p.body}`).not.toContain("brand_new_note");
      expect(p.tech).toContainEqual({ label: s.techCode, value: "brand_new_note" });
    });
    it("a failed layer without a code is one problem for that layer", () => {
      const p = page({ apply: applyReport({ state: "failed", layers: { ...layerState("appLocker", "failed"), ...layerState("appControl", "failed") } }) });
      expect(ids(p)).toEqual(["layer:none:appLocker", "layer:none:appControl"]);
    });
    it("states that are not problems say nothing: unsupported, audit first, off", () => {
      const p = page({
        apply: applyReport({ layers: { ...layerState("appLocker", "unsupported", "applocker_not_on_this_edition"), ...layerState("appControl", "auditFirst", "audit_first"), ...layerState("boot", "off", undefined, "off") } }),
      });
      expect(problems(p)).toEqual([]);
    });
    it("the layer note that needs the update points the owner there", () => {
      const p = page({ apply: applyReport({ state: "partial", layers: layerState("staff", "partial", "section_unknown_value") }) });
      expect(one(p, "layer:section_unknown_value", "owner").action).toMatchObject({ to: "/settings?tab=updates" });
      expect(one(p, "layer:section_unknown_value", "admin").body).toContain(s.askOwner);
    });
  });

  describe("the hideAdminTiles slot", () => {
    // The agent since 2026-11-28: the policy is applied and the machine layer is ok, with a note.
    const skipped = page({ apply: applyReport({ state: "applied", layers: layerState("machine", "ok", "admin_tiles_skipped") }) });
    it("an ok machine layer with admin_tiles_skipped is ONE warning with the plain words and a link to the group's lockdown", () => {
      expect(one(skipped, "layer:admin_tiles_skipped")).toMatchObject({
        severity: "warning",
        title: "Admin accounts stay visible on this PC",
        action: { kind: "link", to: "/groups/g1/lockdown", label: s.openGroupLockdown },
      });
      expect(one(skipped, "layer:admin_tiles_skipped").body).toContain("until sign-in as another user is confirmed");
      expect(one(skipped, "layer:admin_tiles_skipped").body).toContain('turn off "Hide administrator accounts" for the group');
      expect(problems(skipped)).toHaveLength(1);
    });
    it("the note counts whatever the layer's state is (a partial layer too), still ONE warning", () => {
      const partial = page({ apply: applyReport({ state: "partial", layers: layerState("machine", "partial", "admin_tiles_skipped") }) });
      expect(ids(partial)).toEqual(["layer:admin_tiles_skipped"]);
    });
    it("an ok layer with any other note, and an ok layer without one, raise nothing", () => {
      expect(problems(page({ apply: applyReport({ layers: layerState("machine", "ok", "snapshot_fallback") }) }))).toEqual([]);
      expect(problems(page({ apply: applyReport({ layers: layerState("machine", "ok") }) }))).toEqual([]);
    });
    it("a viewer sees the new warning too", () => {
      expect(one(skipped, "layer:admin_tiles_skipped", "viewer").action).toMatchObject({ to: "/groups/g1/lockdown" });
    });
    const slot = page({ apply: applyReport({ state: "partial", layers: layerState("machine", "partial", "admin_signin_unverified") }) });
    it("an older agent: a partial machine layer with admin_signin_unverified is ONE warning with its own words and a link to the group's lockdown", () => {
      expect(one(slot, "layer:admin_signin_unverified")).toMatchObject({
        severity: "warning",
        title: "Admin accounts stay visible on this PC",
        action: { kind: "link", to: "/groups/g1/lockdown", label: s.openGroupLockdown },
      });
      expect(one(slot, "layer:admin_signin_unverified").body).toContain('turn off "Hide administrator accounts" for the group');
      expect(problems(slot)).toHaveLength(1);
    });
    it("the old agent that refuses the whole policy keeps the refusal problem with the same button", () => {
      const old = page({ apply: applyReport({ state: "refused", refusal: "admin_signin_unverified" }) });
      expect(ids(old)).toEqual(["lockdownRefused"]);
      expect(one(old, "lockdownRefused").action).toMatchObject({ to: "/groups/g1/lockdown" });
    });
    it("a viewer sees it too (the link is not admin-only)", () => {
      expect(one(slot, "layer:admin_signin_unverified", "viewer").action).toMatchObject({ to: "/groups/g1/lockdown" });
    });
  });

  describe("an agent from before lockdown", () => {
    it("the owner gets the update link", () => {
      expect(one(page({ lockdownCapable: false }), "tooOld", "owner")).toMatchObject({
        severity: "warning",
        title: s.tooOld.title,
        action: { kind: "link", to: "/settings?tab=updates" },
      });
    });
    it("others are told to ask the owner", () => {
      for (const role of ["admin", "viewer"] as const) {
        const p = one(page({ lockdownCapable: false }), "tooOld", role);
        expect(p.action).toBeUndefined();
        expect(p.body).toBe(`${s.tooOld.body} ${s.askOwner}`);
      }
    });
    it("null (no report yet) is not too old", () => {
      expect(ids(page({ lockdownCapable: null }))).toEqual([]);
    });
  });

  it("the Staff App: unhealthy is a warning, failed is danger; healthy and the other states say nothing", () => {
    expect(one(withReport({ shellHealth: "unhealthy" }), "staffApp")).toMatchObject({ severity: "warning", title: s.staffAppUnhealthy.title });
    expect(one(withReport({ shellHealth: "failed" }), "staffApp")).toMatchObject({ severity: "danger", title: s.staffAppFailed.title });
    for (const h of ["healthy", "starting", "notRunning", "unknown"] as const) expect(ids(withReport({ shellHealth: h })), h).toEqual([]);
  });

  describe("kiosk mode is off", () => {
    const off = page({ kioskEnabled: false });
    it("a warning; an admin turns it on with one click (a run action)", () => {
      expect(one(off, "kioskOff")).toMatchObject({ severity: "warning", title: s.kioskOff.title, action: { kind: "run", run: "kioskOn" } });
    });
    it("a viewer gets no button", () => {
      expect(one(off, "kioskOff", "viewer").action).toBeUndefined();
    });
  });

  describe("no group", () => {
    const loose = page({ group: null, flags: { noGroup: true, revoked: false, rotateCredential: false } });
    it("a warning; an admin is taken to the group picker", () => {
      expect(one(loose, "noGroup")).toMatchObject({ severity: "warning", title: s.noGroup.title, action: { kind: "tab", tab: "settings", focus: "group" } });
    });
    it("a viewer gets no button", () => {
      expect(one(loose, "noGroup", "viewer").action).toBeUndefined();
    });
  });

  it("over the plan's PC limit: a warning with a link to the devices", () => {
    expect(one(page({ planState: "overLimit" }), "overLimit")).toMatchObject({ severity: "warning", title: s.overLimit.title, action: { kind: "link", to: "/devices" } });
    expect(ids(page({ planState: "ok" }))).toEqual([]);
  });

  describe("failed installs", () => {
    const failed = (count: number, names: string[], more = false) => page({ failedInstalls: { count, more, names } });
    it("one app is named", () => {
      expect(one(failed(1, ["Zoom"]), "failedInstalls")).toMatchObject({
        severity: "warning",
        title: "Zoom could not be installed",
        action: { kind: "tab", tab: "apps" },
      });
    });
    it("several are counted, with a plus when there may be more", () => {
      expect(one(failed(3, ["Zoom", "Teams"]), "failedInstalls").title).toBe("3 apps could not be installed");
      expect(one(failed(10, ["Zoom", "Teams"], true), "failedInstalls").title).toBe("10+ apps could not be installed");
    });
    it("a viewer gets the same button (it only opens a tab)", () => {
      expect(one(failed(1, ["Zoom"]), "failedInstalls", "viewer").action).toMatchObject({ kind: "tab", tab: "apps" });
    });
  });

  describe("Wi-Fi and printers", () => {
    const net = (wifiFailed: number, printersFailed: number) => page({ network: { wifiFailed, printersFailed } });
    it("names what failed and opens the Network tab", () => {
      expect(one(net(1, 0), "network")).toMatchObject({ severity: "warning", title: "Wi-Fi could not be set up", action: { kind: "tab", tab: "network" } });
      expect(one(net(2, 0), "network").title).toBe("2 Wi-Fi networks could not be set up");
      expect(one(net(0, 1), "network").title).toBe("A printer could not be set up");
      expect(one(net(0, 3), "network").title).toBe("3 printers could not be set up");
      expect(one(net(1, 2), "network").title).toBe("Wi-Fi and printers could not be set up");
    });
  });

  describe("compatibility", () => {
    it.each(["os_too_old", "s_mode", "managed_device", "no_other_admin", "legal_notice", "shell_binary_missing", "webview2_too_old"])("blocker %s is a danger problem in plain words", (code) => {
      const p = one(withReport({ compat: compat([code], []) }), `compat:${code}`);
      expect(p).toMatchObject({ severity: "danger", title: COMPAT_RULES[code]!.title, body: COMPAT_RULES[code]!.body });
      expect(`${p.title} ${p.body}`).not.toContain(code);
      expect(p.tech).toEqual([{ label: s.techCode, value: code }]);
    });
    it.each([
      ["low_disk", "warning"],
      ["protected_print_on", "warning"],
      ["webview2_missing", "warning"],
      ["low_ram", "info"],
      ["arm64_untested", "info"],
    ])("warning %s is %s", (code, severity) => {
      expect(one(withReport({ compat: compat([], [code]) }), `compat:${code}`)).toMatchObject({ severity, title: COMPAT_RULES[code]!.title });
    });
    it("a blocker or warning nobody knows: the generic title, the raw code only in the technical details", () => {
      const b = one(withReport({ compat: compat(["mystery_blocker"], []) }), "compat:mystery_blocker");
      expect(b).toMatchObject({ severity: "danger", title: "This PC does not meet a requirement", tech: [{ label: s.techCode, value: "mystery_blocker" }] });
      expect(`${b.title} ${b.body}`).not.toContain("mystery_blocker");
      const w = one(withReport({ compat: compat([], ["mystery_warning"]) }), "compat:mystery_warning");
      expect(w).toMatchObject({ severity: "info", title: "This PC has a warning" });
    });
    it("no blockers and no warnings: nothing (the empty list says it)", () => {
      expect(ids(withReport({ compat: compat([], []) }))).toEqual([]);
      expect(ids(withReport({ compat: undefined }))).toEqual([]);
    });
  });

  describe("offline", () => {
    const offline = (since: number) => page({ presence: { online: false, since } });
    it("only after more than 24 hours, counted in days", () => {
      expect(ids(offline(NOW - 23 * HOUR))).toEqual([]);
      expect(ids(offline(NOW - OFFLINE_PROBLEM_AFTER_MS))).toEqual([]);
      expect(one(offline(NOW - 25 * HOUR), "offline")).toMatchObject({ severity: "warning", title: "Offline for 1 day" });
      expect(one(offline(NOW - 3 * DAY - HOUR), "offline").title).toBe("Offline for 3 days");
    });
    it("online, or a PC whose offline start is unknown, raises nothing", () => {
      expect(ids(page({ presence: { online: true, since: NOW - 9 * DAY } }))).toEqual([]);
      expect(ids(page({ presence: { online: false, since: null } }))).toEqual([]);
    });
  });

  it("out of support: a warning", () => {
    expect(one(page({ outOfSupport: true }), "outOfSupport")).toMatchObject({ severity: "warning", title: s.outOfSupport.title });
  });

  describe("restart needed", () => {
    it("the report's flag, a layer that needs a restart, or the note restart_needed: one info problem", () => {
      expect(one(withReport({ restartPending: true }), "restart")).toMatchObject({ severity: "info", title: s.restart.title });
      expect(ids(page({ apply: applyReport({ state: "partial", layers: layerState("appControl", "restartPending", "restart_needed", "audit") }) }))).toEqual(["restart"]);
      expect(ids(page({ apply: applyReport({ state: "partial", layers: layerState("performance", "restartPending") }) }))).toEqual(["restart"]);
      expect(ids(page({ apply: applyReport({ state: "partial", layers: layerState("machine", "partial", "restart_needed") }) }))).toEqual(["restart"]);
    });
  });

  describe("a USB window", () => {
    const until = NOW + 2 * HOUR;
    it("is info with its end time; an admin can end it now", () => {
      const p = one(page({ usbAllowUntil: until }), "usbOpen");
      expect(p).toMatchObject({ severity: "info", title: `USB devices are allowed until ${formatTime(until)}`, action: { kind: "run", run: "endUsb" } });
    });
    it("a viewer gets no button; a window that has ended raises nothing", () => {
      expect(one(page({ usbAllowUntil: until }), "usbOpen", "viewer").action).toBeUndefined();
      expect(ids(page({ usbAllowUntil: NOW - 1 }))).toEqual([]);
    });
  });

  describe("physical protection", () => {
    it("gaps are good to know, with what to turn on", () => {
      const p = one(page({ protection: { secureBoot: "off", bitLocker: "off", autoRecovery: "off", safeModeAgent: true } }), "physical");
      expect(p).toMatchObject({ severity: "info", body: "Turn on Secure Boot and BitLocker on this PC.", action: { kind: "tab", tab: "protection" } });
      expect(one(page({ protection: { secureBoot: "on", bitLocker: "off", autoRecovery: "off", safeModeAgent: true } }), "physical").body).toBe("Turn on BitLocker on this PC.");
      expect(one(page({ protection: { secureBoot: "on", bitLocker: "on", autoRecovery: "off", safeModeAgent: false } }), "physical").body).toBe(s.physical.body(false, false));
    });
    it("a fully protected PC, and a PC that has not reported its protection, raise nothing", () => {
      expect(ids(page({ protection: { secureBoot: "on", bitLocker: "on", autoRecovery: "off", safeModeAgent: true } }))).toEqual([]);
      expect(ids(page({ protection: null }))).toEqual([]);
    });
  });
});

describe("order, roles and the badge", () => {
  const everything = page({
    lock: { lockId: "l", message: "m", lockedAt: NOW },
    planState: "overLimit",
    kioskEnabled: false,
    group: null,
    flags: { noGroup: true, revoked: false, rotateCredential: false },
    outOfSupport: true,
    lockdownCapable: false,
    usbAllowUntil: NOW + HOUR,
    protection: { secureBoot: "off" },
    presence: { online: false, since: NOW - 4 * DAY },
    failedInstalls: { count: 2, more: false, names: ["Zoom", "Teams"] },
    network: { wifiFailed: 1, printersFailed: 1 },
    apply: applyReport({ state: "refused", refusal: "managed_networks_empty" }),
    report: cleanReport({ kioskPhase: "failed", kioskError: "desired_state_untrusted", shellHealth: "failed", restartPending: true, compat: compat(["s_mode"], ["low_disk", "low_ram"]) }),
  });

  it("danger first, then warning, then info; inside a severity the order of the plan's table", () => {
    const list = problems(everything);
    expect(list.map((x) => x.severity)).toEqual([...list.map((x) => x.severity)].sort((a, b) => ["danger", "warning", "info"].indexOf(a) - ["danger", "warning", "info"].indexOf(b)));
    expect(list.map((x) => x.id)).toEqual([
      // danger
      "locked",
      "untrusted",
      "lockdownRefused",
      "staffApp",
      "compat:s_mode",
      // warning
      "tooOld",
      "kioskOff",
      "noGroup",
      "overLimit",
      "failedInstalls",
      "network",
      "compat:low_disk",
      "offline",
      "outOfSupport",
      // info
      "compat:low_ram",
      "restart",
      "usbOpen",
      "physical",
    ]);
  });

  it("ids are unique", () => {
    const list = problems(everything);
    expect(new Set(list.map((x) => x.id)).size).toBe(list.length);
  });

  it("a viewer gets no run action and no admin-only link (enrollment, administrator exit, updates)", () => {
    const withAdminExit = page({ ...everything, report: cleanReport({ kioskError: "admin_exit_pin_invalid" }), apply: applyReport({ state: "refused", refusal: "journal_unknown_target" }) });
    for (const p of [everything, withAdminExit, page({ report: null, apply: null, lockdownCapable: null }), page({ revoked: true, flags: { noGroup: false, revoked: true, rotateCredential: false } })]) {
      for (const problem of problems(p, "viewer", never)) {
        expect(problem.action?.kind, problem.id).not.toBe("run");
        if (problem.action?.kind === "link") expect(problem.action.to, problem.id).not.toMatch(/^\/(enrollment|settings)/);
        if (problem.action?.kind === "tab") expect(problem.action.focus, problem.id).toBeUndefined();
      }
    }
  });

  it("an admin gets the run actions but not the owner's update link; the owner gets it", () => {
    const old = page({ lockdownCapable: false });
    expect(one(everything, "kioskOff", "admin").action?.kind).toBe("run");
    expect(one(old, "tooOld", "admin").action).toBeUndefined();
    expect(one(old, "tooOld", "owner").action).toMatchObject({ to: "/settings?tab=updates" });
  });

  it("splits what is shown up front from what is good to know, and counts the badge", () => {
    const list = problems(everything);
    const { attention, goodToKnow } = splitProblems(list);
    expect(attention.every((x) => x.severity !== "info")).toBe(true);
    expect(goodToKnow.map((x) => x.id)).toEqual(["compat:low_ram", "restart", "usbOpen", "physical"]);
    expect(problemBadge(list)).toEqual({ count: attention.length, danger: true });
    expect(problemBadge(problems(page({ outOfSupport: true })))).toEqual({ count: 1, danger: false });
    expect(problemBadge([])).toEqual({ count: 0, danger: false });
  });

  it("every registry entry is complete: a title, and a body unless the sentence comes from codes.ts", () => {
    for (const [code, rule] of Object.entries({ ...KIOSK_ERRORS, ...COMPAT_RULES })) {
      expect(rule.title, code).toBeTruthy();
      expect(rule.body, code).toBeTruthy();
    }
    for (const [code, rule] of Object.entries(LOCKDOWN_RULES)) expect(rule.title, code).toBeTruthy();
  });
});
