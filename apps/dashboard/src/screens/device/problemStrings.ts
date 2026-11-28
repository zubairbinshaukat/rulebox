import type { LayerName } from "../../data/types";

/**
 * The words of the device page's "Needs attention" list (UI pass 2026-11, `docs/plans/ui-pass/device-detail.md` section 5).
 * `problems.ts` decides WHAT is wrong; every title, "what to do" sentence and button label is here.
 *
 * Codes the agent reports (kiosk errors, compatibility blockers and warnings, lockdown layer notes) are looked up in ONE
 * registry per source, so a new agent code is one entry: `KIOSK_ERRORS`, `COMPAT_RULES`, `LOCKDOWN_RULES`. A code that is
 * not listed gets the generic title of its source; the raw code never appears in a title or a sentence, only in the
 * "Technical details" list for support.
 *
 * `COMPAT_RULES` is new (richer than `lib/screenStrings/device.ts` `COMPAT_CODES`, which is private and goes away with the old
 * page in plan step 11); the lockdown sentences come from `screens/lockdown/codes.ts`.
 */

/** What a registry entry's button does. `problems.ts` turns it into an action for the viewer's role (some are admin or owner only). */
export type FixKind = "groupLockdown" | "networks" | "update" | "adminExit";

export type RuleSeverity = "danger" | "warning" | "info";

export interface Rule {
  title: string;
  /** What to do. Missing = use the source's own sentence (lockdown: `codes.ts`). */
  body?: string;
  /** Missing = the source's default (blocker: danger; warning: warning; lockdown layer: danger when failed, warning when partial). */
  severity?: RuleSeverity;
  fix?: FixKind;
}

const UPDATE_RULEBOX = "Update Rulebox on this PC.";
const TRIES_AGAIN = "Rulebox tries again by itself. If this stays, restart the PC.";

/** Errors the kiosk reports (`report.kioskError`). A compatibility blocker code is also accepted there (see `COMPAT_RULES`). */
export const KIOSK_ERRORS: Record<string, Rule> = {
  staff_account_conflict: {
    title: "A Windows account already uses the staff name",
    body: "Rename or remove that account on the PC. Rulebox then tries again by itself.",
  },
  password_policy: {
    title: "Windows password rules blocked the staff account",
    body: "Rulebox tries again by itself. If this stays, check the password rules of this PC.",
  },
  access_denied: { title: "Windows refused a change", body: TRIES_AGAIN },
  platform_error: { title: "Windows refused a change", body: TRIES_AGAIN },
  state_not_saved: { title: "Windows refused a change", body: TRIES_AGAIN },
  guard_blocked: {
    title: "Kiosk mode is switched off on this test PC",
    body: "This PC is protected from lockdown on purpose. Use a different PC to test kiosk mode.",
  },
  desired_state_invalid: { title: "The PC could not read its settings", body: UPDATE_RULEBOX, fix: "update" },
  catalog_invalid: { title: "The PC could not read its settings", body: UPDATE_RULEBOX, fix: "update" },
};

/** `admin_exit_pin_invalid` and its siblings: the administrator exit settings the PC was sent are not valid. */
export const ADMIN_EXIT_ERROR: Rule = {
  title: "The administrator exit settings are not valid",
  body: "Check the administrator exit in Settings and save it again.",
  fix: "adminExit",
};

export const KIOSK_ERROR_FALLBACK: Rule = {
  title: "The kiosk reported a problem",
  body: "Rulebox tries again by itself. If this stays, contact support and give them the technical details.",
};

/** Compatibility blockers (`compat.blockers`, always danger) and warnings (`compat.warnings`, severity as listed). */
export const COMPAT_RULES: Record<string, Rule> = {
  os_too_old: { title: "Windows is too old for Rulebox", body: "Rulebox needs Windows 10 22H2 or newer. Update Windows on this PC." },
  s_mode: { title: "Windows is in S mode", body: "Switch out of S mode in the Windows settings. Rulebox can then continue." },
  managed_device: {
    title: "The PC is joined to a company domain",
    body: "Rulebox cannot take over a PC that a company domain manages. Use a PC that is not joined.",
  },
  no_other_admin: {
    title: "There is no other administrator account",
    body: "Create a second administrator account in Windows, so you can always get back in.",
  },
  legal_notice: {
    title: "Windows shows a notice before sign-in",
    body: "Remove the sign-in notice in the Windows settings. It would get in the way of the kiosk.",
  },
  shell_binary_missing: { title: "Rulebox files are missing on this PC", body: "Run Rulebox Setup on the PC again." },
  webview2_too_old: { title: "The WebView2 Runtime is too old", body: "Rulebox Setup installs it. Run Setup on the PC again." },
  webview2_missing: {
    title: "The WebView2 Runtime is missing",
    body: "Rulebox Setup installs it. Run Setup on the PC again.",
    severity: "warning",
  },
  low_disk: {
    title: "This PC is almost out of disk space",
    body: "Less than 2 GB is free. App installs and updates can fail. Free up some space.",
    severity: "warning",
  },
  protected_print_on: {
    title: "Windows protected print mode is on",
    body: "Printers with third-party drivers would be removed. Turn it off in the Windows settings.",
    severity: "warning",
  },
  low_ram: {
    title: "This PC has little memory",
    body: "Under 3 GB. Rulebox runs in Lite mode to stay fast, but a bigger PC is better.",
    severity: "info",
  },
  arm64_untested: {
    title: "ARM64 Windows is not tested yet",
    body: "Rulebox may not work fully on this kind of PC.",
    severity: "info",
  },
};

export const COMPAT_BLOCKER_FALLBACK: Rule = {
  title: "This PC does not meet a requirement",
  body: "Rulebox cannot continue until it is fixed. Contact support and give them the technical details.",
};
export const COMPAT_WARNING_FALLBACK: Rule = {
  title: "This PC has a warning",
  body: "Contact support and give them the technical details if it worries you.",
  severity: "info",
};

/**
 * Notes a lockdown layer reports (`apply.layers.<name>.detail`) when its state is `failed` or `partial`. Without `body` the sentence
 * of `screens/lockdown/codes.ts` is used. A harmless note (the PC chose to keep something on) is `info`, so it does not raise an alarm.
 */
export const LOCKDOWN_RULES: Record<string, Rule> = {
  // The hideAdminTiles slot (plan section 5): an agent after the fix applies everything else and reports the machine layer as partial.
  admin_signin_unverified: {
    title: "Admin accounts stay visible on this PC",
    body: 'Until "Other user" sign-in is confirmed on this PC, Rulebox does not hide administrator accounts. Everything else is applied. To stop this message, turn off "Hide administrator accounts" for the group.',
    severity: "warning",
    fix: "groupLockdown",
  },
  fighting: { title: "Something keeps changing the settings back", body: "Often a company policy. Rulebox stopped retrying for now. Check the policies on this PC." },
  access_denied: { title: "Windows refused a change", body: "Rulebox will try again." },
  state_not_saved: { title: "The PC could not save a change", body: "Rulebox will try again." },
  restore_incomplete: { title: "Some changes could not be undone yet", body: "The PC keeps trying. Rulebox recovery on the PC can finish it." },
  applocker_foreign_policy: {
    title: "This PC already has its own program rules",
    body: "Rulebox left them alone, so its program rules are not applied here.",
  },
  wifi_filters_error: { title: "The allowed Wi-Fi networks could not be set", body: "Check the Wi-Fi of this PC." },
  section_unknown_value: { title: "This PC does not know a newer setting", body: UPDATE_RULEBOX, fix: "update" },
  no_printing_ignored: { title: "The print service was kept on", severity: "info" },
  startup_entry_kept: { title: "A start-up program was kept", severity: "info" },
  startup_entries_capped: { title: "This PC has many start-up programs", severity: "info" },
  tuning_value_protected: { title: "Windows kept one tuning setting", severity: "info" },
  service_not_in_profile: { title: "A Windows service was left alone", severity: "info" },
  snapshot_fallback: { title: "The program watch uses a slower check", severity: "info" },
  usb_retroactive_skipped: { title: "USB devices that were already plugged in were left alone", severity: "info" },
  usb_combo_unsplit: { title: "A combined USB device stays allowed", severity: "info" },
  exception_invalid: { title: "One exception was skipped", severity: "info" },
};

export const LAYER_GENERIC = {
  failedTitle: "Part of the lockdown could not be applied",
  partialTitle: "Part of the lockdown is only partly applied",
  unknownBody: "The PC reported a problem with this part of the lockdown. Support can read the technical details.",
};

/** Plain names of the seven lockdown layers (only used in the technical details of a problem). */
export const LAYER_LABELS: Record<LayerName, string> = {
  staff: "Employee restrictions",
  machine: "PC restrictions",
  appLocker: "Program rules",
  appControl: "Windows app control",
  procWatch: "Program watch",
  boot: "Start-up and tamper protection",
  performance: "Speed settings",
};

export const problemStrings = {
  // ---- states that replace or lead the list
  revoked: {
    title: "This PC is disconnected from Rulebox",
    body: "It gets no changes and keeps its last settings. Remove it, or enroll it again.",
    action: "Remove this PC",
  },
  locked: { title: "This PC is locked", body: "Nobody can sign in until you unlock it.", action: "Unlock this PC" },
  suspended: { title: "Your organization is suspended", body: "PCs keep their last settings and get no changes." },
  neverSeen: {
    title: "Waiting for this PC to connect",
    body: "Run the Rulebox installer on the PC with an enrollment code.",
    action: "Create a code",
  },
  untrusted: {
    title: "This PC can't accept new settings",
    body: "It doesn't trust your organization's signing key. Enroll it again with a new code.",
    action: "Create a code",
    trustNone: "None",
    trustCommand: "rulebox-agent trust-key",
  },
  kioskFailed: {
    title: "Kiosk mode could not be turned on",
    body: "Rulebox tries again by itself. If this stays, restart the PC.",
  },
  lockdownRefused: {
    title: "This PC did not apply the lockdown settings",
    fallbackBody: "The PC kept its last working settings. Support can read the technical details.",
  },
  rolledBack: {
    title: "This PC went back to its last working settings",
    body: "The Staff App did not start with the new ones. It will not try that version again. Check the group's latest change.",
  },
  tooOld: {
    title: "Update Rulebox on this PC",
    body: "This PC runs a Rulebox version from before lockdown.",
    askOwner: "Ask the owner.",
  },
  staffAppUnhealthy: {
    title: "The Staff App is not running well",
    body: "Rulebox restarts it by itself. If this stays, restart the PC.",
  },
  staffAppFailed: {
    title: "The Staff App has stopped",
    body: "Rulebox restarts it by itself. If this stays, restart the PC.",
  },
  kioskOff: {
    title: "Kiosk mode is off",
    body: "This PC shows a normal Windows desktop. Turn kiosk mode back on after maintenance.",
    action: "Turn kiosk mode on",
  },
  noGroup: { title: "This PC is not in a group", body: "No employee can sign in until it is in one.", action: "Choose a group" },
  overLimit: {
    title: "Over your plan's PC limit",
    body: "This PC keeps its last settings and gets no changes. Remove PCs you no longer use.",
    action: "Open devices",
  },
  failedInstalls: {
    body: "See which ones and try again.",
    action: "See apps",
    one: (appName: string) => `${appName} could not be installed`,
    oneUnnamed: "An app could not be installed",
    many: (count: number, more: boolean) => `${more ? `${count}+` : count} apps could not be installed`,
  },
  network: {
    body: "See which ones and why.",
    action: "See details",
    wifiOne: "Wi-Fi could not be set up",
    wifiMany: (count: number) => `${count} Wi-Fi networks could not be set up`,
    printerOne: "A printer could not be set up",
    printerMany: (count: number) => `${count} printers could not be set up`,
    both: "Wi-Fi and printers could not be set up",
  },
  offline: {
    title: (days: number) => `Offline for ${days} ${days === 1 ? "day" : "days"}`,
    body: "Check that the PC is on and connected. Changes reach it when it is back.",
  },
  outOfSupport: {
    title: "Windows needs an update",
    body: "This Windows version no longer gets security fixes. Update Windows on this PC.",
  },
  restart: {
    title: "Restart needed",
    body: "Restart the PC when nobody is using it. Rulebox never restarts it by itself.",
  },
  usbOpen: {
    title: (time: string) => `USB devices are allowed until ${time}`,
    body: "It ends by itself.",
    action: "End now",
  },
  physical: {
    title: "Someone with the PC in hand could get around Rulebox",
    body: (secureBoot: boolean, bitLocker: boolean) =>
      secureBoot || bitLocker
        ? `Turn on ${[secureBoot ? "Secure Boot" : null, bitLocker ? "BitLocker" : null].filter(Boolean).join(" and ")} on this PC.`
        : "The Protection tab shows what is missing.",
    action: "See details",
  },

  // ---- buttons and labels shared by several problems
  openGroupLockdown: "Open group lockdown",
  openNetworks: "Open networks",
  openUpdates: "Update Rulebox",
  openAdminExit: "Open administrator exit",
  askOwner: "Ask the owner.",
  techCode: "Problem code",
  techLayers: "Part of the lockdown",
  techKeys: "Signing keys it trusts",
  techOnPc: "On the PC, as administrator",
} as const;
