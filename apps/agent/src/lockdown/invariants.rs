//! The safety invariants I1 to I10 of plan 4.6: `validate(doc, facts)` runs before
//! any write (4.11 step 2). A refusal writes nothing, keeps the previous applied state
//! and carries a fixed code.
//!
//! Every check looks at **generated output** (the rows L1 would write, the USB deny
//! tables, whatever a later layer compiled and put into [`Generated`]), not at what
//! the document says it intends. Layers added by Steps 5 to 12 fill [`Generated`]
//! with their own output; the checks here are what keep working when they do.
//!
//! I8 (unknown journal target) is checked by `apply` before this runs; I9
//! (`audit_first`) is informational, not a refusal, and belongs to the layers that have
//! an `enforce` mode.

use rulebox_policy::AgentDoc;
use rulebox_win32::autologon::FORBIDDEN_WINLOGON_VALUES;

use super::staff;
use super::usb::{self, DenyTables};

/// Why a document is refused. Nothing was written in any of these cases.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// I1, I2: a generated rule could stop the agent, the launcher, the Staff App or
    /// the WebView2 runtime from starting.
    WouldBlockRulebox,
    /// I3, I4: the hidden admin exit or Shift at startup would stop working.
    WouldBlockExit,
    /// I5: `wifiManagedOnly` with no managed network.
    ManagedNetworksEmpty,
    /// I5: `wifiManagedOnly` would cut the link the PC is using now.
    WouldDisconnect,
    /// I6: an administrator (or `rulebox-agent recover`) would be blocked.
    WouldBlockAdmin,
    /// I7: `hideAdminTiles` before E-71 (an administrator can still sign in) passed.
    AdminSigninUnverified,
    /// I7: an account lockout threshold under 5.
    LockoutThresholdTooLow,
    /// I8: the journal holds a target this build cannot restore.
    JournalUnknownTarget,
    /// I10: a deny list or document could block a keyboard, mouse, touch input, hub,
    /// composite parent, Bluetooth or built-in device.
    WouldBlockInputDevice,
}

impl Refusal {
    /// Every refusal, in the order of the invariants.
    pub const ALL: [Refusal; 9] = [
        Refusal::WouldBlockRulebox,
        Refusal::WouldBlockExit,
        Refusal::ManagedNetworksEmpty,
        Refusal::WouldDisconnect,
        Refusal::WouldBlockAdmin,
        Refusal::AdminSigninUnverified,
        Refusal::LockoutThresholdTooLow,
        Refusal::JournalUnknownTarget,
        Refusal::WouldBlockInputDevice,
    ];

    /// The fixed code of the apply report and the `device.lockdownRefused` audit entry.
    pub const fn code(self) -> &'static str {
        match self {
            Refusal::WouldBlockRulebox => "would_block_rulebox",
            Refusal::WouldBlockExit => "would_block_exit",
            Refusal::ManagedNetworksEmpty => "managed_networks_empty",
            Refusal::WouldDisconnect => "would_disconnect",
            Refusal::WouldBlockAdmin => "would_block_admin",
            Refusal::AdminSigninUnverified => "admin_signin_unverified",
            Refusal::LockoutThresholdTooLow => "lockout_threshold_too_low",
            Refusal::JournalUnknownTarget => "journal_unknown_target",
            Refusal::WouldBlockInputDevice => "would_block_input_device",
        }
    }

    /// The invariant of plan 4.6 the code belongs to.
    pub const fn invariant(self) -> &'static str {
        match self {
            Refusal::WouldBlockRulebox => "I1/I2",
            Refusal::WouldBlockExit => "I3/I4",
            Refusal::ManagedNetworksEmpty | Refusal::WouldDisconnect => "I5",
            Refusal::WouldBlockAdmin => "I6",
            Refusal::AdminSigninUnverified | Refusal::LockoutThresholdTooLow => "I7",
            Refusal::JournalUnknownTarget => "I8",
            Refusal::WouldBlockInputDevice => "I10",
        }
    }
}

/// What the layers generated for this document, as the checks need it. Empty until a
/// layer fills its part (the Staff layer's rows and the USB tables are generated here
/// from the document, so they need no entry).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Generated {
    /// Folders and files the compiled deny rules (AppLocker, App Control, process
    /// watchdog) would stop programs in.
    pub blocked_paths: Vec<String>,
    /// Hotkeys the keyboard hook swallows (`Win+...`).
    pub hooked_hotkeys: Vec<String>,
    /// Winlogon value names a layer would write.
    pub winlogon_writes: Vec<String>,
    /// A layer's rules leave out the allow-all for Administrators or the Windows and
    /// Rulebox folders that `recover` needs.
    pub blocks_administrators: bool,
    /// A USB deny list a layer built itself (Step 5's machine layer). It is checked in
    /// addition to the one generated from the document.
    pub usb: Option<DenyTables>,
}

/// Read-only machine facts (plan 4.6) and the agent-config flag of E-71.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Facts {
    /// E-71 passed: an administrator can sign in with the admin tiles hidden
    /// (`agent-config.json` `adminSigninVerified`, set by the user after the VM run).
    pub admin_signin_verified: bool,
    /// The Wi-Fi network the PC is connected to now; `None` = wired or unknown.
    pub current_ssid: Option<String>,
    /// The Rulebox install folder (with `versions\`) and the WebView2 runtime folder.
    pub protected_paths: Vec<String>,
    /// (Step 6) The folder of every desktop app in the device catalogue (the xe template,
    /// expanded). llowlist App Control is refused while one is outside Program Files and the
    /// Windows folder (llowlist_level_with_user_install, edge case 48).
    pub catalogue_exe_folders: Vec<String>,
    /// (Step 17) The install folder and the agent's `state` folder, whose ACLs the tamper
    /// protection checks and repairs (plan 4.16). `None`: not known, the folder check is skipped.
    pub rulebox_folders: Option<super::tamper::RuleboxFolders>,
    pub generated: Generated,
}

/// The lowest account lockout threshold a document may set (plan 4.6, I7).
pub const MIN_LOCKOUT_THRESHOLD: u32 = 5;

fn path_key(path: &str) -> String {
    path.replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase()
}

/// True when one path is the other or inside it.
fn overlaps(a: &str, b: &str) -> bool {
    let (a, b) = (path_key(a), path_key(b));
    let inside = |inner: &str, outer: &str| inner == outer || (inner.starts_with(outer) && inner.as_bytes().get(outer.len()) == Some(&b'\\'));
    !a.is_empty() && !b.is_empty() && (inside(&a, &b) || inside(&b, &a))
}

/// I1 and I2.
fn check_rulebox(facts: &Facts) -> Result<(), Refusal> {
    let hit = facts
        .generated
        .blocked_paths
        .iter()
        .any(|blocked| facts.protected_paths.iter().any(|protected| overlaps(blocked, protected)));
    if hit {
        Err(Refusal::WouldBlockRulebox)
    } else {
        Ok(())
    }
}

/// I3 and I4: the hook handles Windows-key combinations only; no layer writes a
/// Winlogon value that Shift at startup or the shell depends on. The Staff rows L1 is
/// about to write are included in the second check.
fn check_exit(doc: &AgentDoc, facts: &Facts) -> Result<(), Refusal> {
    let wrong_hotkey = facts.generated.hooked_hotkeys.iter().any(|hotkey| {
        let key = hotkey.trim().to_ascii_lowercase();
        !(key.starts_with("win+") || key.starts_with("windows+"))
    });
    let forbidden = |name: &str| FORBIDDEN_WINLOGON_VALUES.iter().any(|item| item.eq_ignore_ascii_case(name));
    let layer_names = facts.generated.winlogon_writes.iter().map(String::as_str);
    let staff_names = staff::planned_rows(doc.lockdown.as_ref()).into_iter().map(|row| row.name);
    if wrong_hotkey || layer_names.chain(staff_names).any(forbidden) {
        Err(Refusal::WouldBlockExit)
    } else {
        Ok(())
    }
}

/// I5.
fn check_network(doc: &AgentDoc, facts: &Facts) -> Result<(), Refusal> {
    if !doc.wifi_managed_only {
        return Ok(());
    }
    if doc.wifi.is_empty() {
        return Err(Refusal::ManagedNetworksEmpty);
    }
    // (Step 20) The administrator confirmed "this PC will go offline until it sees a managed
    // network" (plan 4.15, edge case 34): the second refusal is lifted, never the first.
    if doc.wifi_managed_only_confirmed {
        return Ok(());
    }
    if let Some(current) = &facts.current_ssid {
        if !doc.wifi.iter().any(|profile| profile.ssid == *current) {
            return Err(Refusal::WouldDisconnect);
        }
    }
    Ok(())
}

/// I7.
fn check_admin_signin(doc: &AgentDoc, facts: &Facts) -> Result<(), Refusal> {
    let Some(lockdown) = &doc.lockdown else {
        return Ok(());
    };
    if lockdown.machine.hide_admin_tiles && !facts.admin_signin_verified {
        return Err(Refusal::AdminSigninUnverified);
    }
    if lockdown.machine.account_lockout.is_some_and(|lockout| lockout.threshold < MIN_LOCKOUT_THRESHOLD) {
        return Err(Refusal::LockoutThresholdTooLow);
    }
    Ok(())
}

/// I10: the USB deny tables generated from the document, and any a layer built, never
/// reach the never-block set, by class GUID or by compatible ID; neither does the
/// retroactive removal list. The Staff-hive rows L1 plans for removable storage are
/// checked too (their GUIDs come out of the same generated rows, not from the table).
pub fn check_input_devices(doc: &AgentDoc, facts: &Facts) -> Result<(), Refusal> {
    let mut lists: Vec<DenyTables> = Vec::new();
    if let Some(lockdown) = &doc.lockdown {
        lists.push(usb::generate(&lockdown.usb));
    }
    lists.extend(facts.generated.usb.clone());
    for tables in &lists {
        check_tables(tables)?;
    }
    // The registry rows themselves: a removable-storage class subkey that is a never-block class.
    let storage_prefix = r"software\policies\microsoft\windows\removablestoragedevices\";
    for row in staff::planned_rows(doc.lockdown.as_ref()) {
        let path = row.path.to_ascii_lowercase();
        if let Some(subkey) = path.strip_prefix(storage_prefix) {
            if usb::never_block_hit(subkey, &[]).is_some() {
                return Err(Refusal::WouldBlockInputDevice);
            }
        }
    }
    Ok(())
}

/// I10 on one set of deny tables. The machine layer calls it again on the exact tables
/// it is about to write, so the check holds even for a caller that skipped `validate`.
pub fn check_tables(tables: &DenyTables) -> Result<(), Refusal> {
    if tables.input_device_conflicts().is_empty() {
        Ok(())
    } else {
        Err(Refusal::WouldBlockInputDevice)
    }
}

/// Runs I1 to I7 and I10 in the order of the plan; the first failure is the answer.
pub fn validate(doc: &AgentDoc, facts: &Facts) -> Result<(), Refusal> {
    check_rulebox(facts)?;
    check_exit(doc, facts)?;
    check_network(doc, facts)?;
    if facts.generated.blocks_administrators {
        return Err(Refusal::WouldBlockAdmin);
    }
    check_admin_signin(doc, facts)?;
    check_input_devices(doc, facts)
}

#[cfg(test)]
mod tests;
