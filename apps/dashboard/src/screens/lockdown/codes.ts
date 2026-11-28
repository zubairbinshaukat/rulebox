import type { SecurityPosture } from "../../data/types";

/**
 * The fixed codes a PC reports about its lockdown (plan 4.6, 4.11; `apps/agent/src/lockdown/*`), as plain sentences.
 * A code that is not listed here (a newer agent) is shown as "Code: <code>": codes are fixed words, never a path or a
 * command line (the server stores nothing else, `convex/lib/lockdownReports.ts`).
 */

/** Why a PC refused a whole lockdown policy (plan 4.6). Nothing was changed on the PC. */
export const REFUSALS: Record<string, string> = {
  would_block_rulebox: "The policy would stop Rulebox itself from starting. Nothing was changed.",
  would_block_exit: "The policy would block the administrator exit. Nothing was changed.",
  would_block_admin: "The policy would lock administrators out of this PC. Nothing was changed.",
  would_block_input_device: "The policy would block a keyboard, mouse or touch screen. Rulebox never does that. Nothing was changed.",
  managed_networks_empty: "Managed networks only is on, but this group has no Wi-Fi network. Add one, or turn the setting off.",
  would_disconnect: "The policy would cut this PC off from its current network, and then Rulebox could not reach it. Nothing was changed.",
  admin_signin_unverified: "Hiding administrator accounts is not confirmed as safe on this PC yet. Turn that setting off for now.",
  lockout_threshold_too_low: "The account lockout threshold is too low. Use 5 wrong passwords or more.",
  journal_unknown_target: "This PC has changes from a newer Rulebox version. Update the agent on this PC.",
  journal_unreadable: "This PC cannot read its record of changes. Run Rulebox recovery on the PC.",
  policy_rejected: "The PC could not accept the policy. It may be too large or not signed with a key the PC trusts.",
  allowlist_level_with_user_install: "The strict safety list cannot be used while an assigned app is installed for one user only.",
  section_unknown_value: "The policy has a setting this agent does not know. Update the agent on this PC.",
  lkg_failed: "The PC could not go back to its last working policy. Program blocking is in trial run until the next restart.",
};

/** The refusal codes of plan 4.6 (one test per code keeps the sentences from going missing). */
export const REFUSAL_CODES: readonly string[] = Object.keys(REFUSALS);

/** Notes a layer reports beside its state (plan 4.11 `detail`). */
export const LAYER_DETAILS: Record<string, string> = {
  // every layer
  section_unknown_value: "This agent does not know one of the settings. It kept the last one. Update the agent.",
  restart_needed: "Restart the PC to finish.",
  state_not_saved: "The PC could not save its record of this change. It will try again.",
  fighting: "Something else on the PC keeps changing these settings back, for example a company policy. Rulebox stopped retrying for now.",
  access_denied: "Windows refused the change. It will be tried again.",
  restore_incomplete: "Some changes could not be undone yet. The PC keeps trying. Rulebox recovery on the PC can finish it.",
  audit_first: "This PC has not had a trial run yet, so it reports only for 24 hours before it blocks.",
  // employee restrictions
  no_staff_account: "The employee account does not exist on this PC yet.",
  staff_hive_busy: "The employee profile was in use. It will be tried again.",
  staff_value_unreadable: "One employee setting could not be read.",
  accessibility_flags_unreadable: "The accessibility shortcut settings could not be read.",
  // PC restrictions and USB
  admin_signin_unverified: "Administrator accounts are not hidden: that is not confirmed as safe on this PC yet.",
  admin_list_unreadable: "The list of administrator accounts could not be read.",
  lockout_threshold_too_low: "The account lockout threshold is too low. It was not applied.",
  lockout_window_too_long: "The lockout counting time is longer than the lockout itself. It was not applied.",
  device_list_unreadable: "The list of USB devices could not be read.",
  device_list_full: "Too many USB devices are plugged in to check them all.",
  usb_retroactive_skipped: "Devices that were already plugged in were left alone.",
  usb_combo_unsplit: "A combined USB device could not be split, so it stays allowed.",
  printer_list_unreadable: "The list of printers could not be read.",
  printer_security_unreadable: "The security of a printer could not be read.",
  // employee program list, Windows safety list, Rulebox program check
  applocker_not_on_this_edition: "This Windows edition has no employee program list (AppLocker).",
  applocker_foreign_policy: "This PC already has program rules that Rulebox did not make. Rulebox left them alone.",
  applocker_unreadable: "The employee program list on this PC could not be read.",
  app_id_service_missing: "The Windows service the employee program list needs is missing.",
  app_id_service_unreadable: "The Windows service the employee program list needs could not be checked.",
  accounts_unreadable: "The accounts on this PC could not be read.",
  windows_scan_failed: "The Windows folder could not be checked for folders employees can write to.",
  windows_folder_unknown: "The Windows folder could not be found.",
  path_roots_unreadable: "The program folders of this PC could not be read.",
  catalogue_folder_writable: "An assigned program is in a folder employees can write to, so its folder is not allowed.",
  exception_invalid: "One exception is not valid and was skipped.",
  exception_path_writable: "One folder exception points to a folder employees can write to. It was skipped.",
  writable_path_rule: "A rule would allow a folder employees can write to. It was refused.",
  restrictive_rule_not_staff: "A rule would restrict an account other than the employee account. It was refused.",
  os_too_old_for_app_control: "This Windows version is too old for the Windows safety list.",
  os_info_unreadable: "The Windows version could not be read.",
  appcontrol_not_built: "This Rulebox build has no Windows safety list.",
  policy_not_embedded: "This Rulebox build has no Windows safety list.",
  allowlist_level_with_user_install: "The strict safety list cannot be used while an assigned app is installed for one user only.",
  snapshot_fallback: "The Rulebox program check uses a slower method on this PC. Programs are still blocked.",
  blocked_by_guard: "The Rulebox program check is switched off on this test PC.",
  watch_thread_failed: "The Rulebox program check stopped. It restarts with Rulebox.",
  // start-up and tamper protection
  bitlocker_protects_os_volume: "Automatic recovery was left on because BitLocker protects this PC.",
  posture_unreadable: "The start-up protection of this PC could not be read.",
  service_acl: "The protection of the Rulebox service was repaired.",
  service_privileges: "The rights of the Rulebox service were repaired.",
  install_acl: "The protection of the Rulebox program folder was repaired.",
  state_acl: "The protection of the Rulebox data folder was repaired.",
  acl_readback_differs: "A folder protection did not stay as set. It will be repaired again.",
  acl_unreadable: "A folder protection could not be read.",
  // last working policy
  crash_loop: "The Staff App kept crashing with the new policy, so the PC went back to the last working one.",
  no_ui_alive: "The Staff App did not start with the new policy, so the PC went back to the last working one.",
  lkg_unverifiable: "The last working policy could not be checked, so it was not used.",
  lkg_unreadable: "The last working policy could not be read.",
  // performance (Step 18)
  no_printing_ignored: "The print service was kept on because printers are assigned to this group.",
  startup_entry_kept: "One start-up program was kept.",
  startup_entries_capped: "This PC has more than 64 start-up programs. The rest stay.",
  tuning_value_protected: "Windows refused one tuning setting. This is harmless.",
  service_unreadable: "One Windows service could not be read.",
  startup_entries_unreadable: "The start-up programs could not be read.",
  machine_value_unreadable: "One PC setting could not be read.",
  service_not_in_profile: "One Windows service is not part of the kiosk profile and was left alone.",
  // The performance layer says "restart needed" without a code of its own (Step 20a): this is its note.
  performance_restart_pending: "A Windows service was switched off for speed. It stops after the PC restarts. Rulebox never restarts the PC on its own.",
  // Wi-Fi (Step 20a): the PC's network layer and a network's own result
  wifi_filters_error: "The list of allowed Wi-Fi networks could not be set, or could not be put back. Check the Wi-Fi of this PC.",
  connect_failed: "The network was added to this PC, but the PC could not connect to it. Check the password and the signal.",
};

/** A layer's state (plan 4.11). */
export const LAYER_STATES: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" | "accent" }> = {
  ok: { label: "Working", tone: "success" },
  partial: { label: "Partly applied", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  unsupported: { label: "Not supported", tone: "neutral" },
  restartPending: { label: "Restart needed", tone: "accent" },
  auditFirst: { label: "Trial run first", tone: "accent" },
  off: { label: "Off", tone: "neutral" },
};

/** A layer's mode as the PC reports it. */
export const LAYER_MODE_LABELS: Record<string, string> = { off: "Off", audit: "Trial run", enforce: "Block", on: "On" };

const unknown = (code: string) => `Code: ${code}`;

/** The sentence for a refusal code; an unknown code is shown as it is. */
export function refusalText(code: string | null | undefined): string | null {
  if (code === null || code === undefined || code === "") return null;
  return REFUSALS[code] ?? unknown(code);
}

/** The sentence for a layer detail code; an unknown code is shown as it is. */
export function layerDetailText(code: string | null | undefined): string | null {
  if (code === null || code === undefined || code === "") return null;
  return LAYER_DETAILS[code] ?? REFUSALS[code] ?? unknown(code);
}

/** The note under a layer: its own code, else the fixed sentence for a layer that says "restart needed" without one. */
export function layerNoteOf(name: string, l: { state: string; detail?: string }): string | null {
  if (l.detail === undefined && name === "performance" && l.state === "restartPending") return LAYER_DETAILS.performance_restart_pending!;
  return layerDetailText(l.detail);
}

export function layerStateOf(state: string): { label: string; tone: "success" | "warning" | "danger" | "neutral" | "accent" } {
  return LAYER_STATES[state] ?? { label: state, tone: "neutral" };
}

export type ProtectionGap = "secureBoot" | "bitLocker" | "autoRecovery" | "safeMode";

/**
 * What is missing for the green "protected" state (plan 4.16): Secure Boot on, BitLocker on, auto-recovery off, Safe Mode agent
 * registered. Automatic recovery that is still on does not count while BitLocker is on: the agent leaves it on there by design.
 */
export function protectionGaps(p: SecurityPosture): ProtectionGap[] {
  const out: ProtectionGap[] = [];
  if (p.secureBoot !== "on") out.push("secureBoot");
  if (p.bitLocker !== "on") out.push("bitLocker");
  if (p.autoRecovery !== "off" && p.bitLocker !== "on") out.push("autoRecovery");
  if (p.safeModeAgent !== true) out.push("safeMode");
  return out;
}
