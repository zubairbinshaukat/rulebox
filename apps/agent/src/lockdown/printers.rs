//! `machine.fileOutputPrinters` (plan 4.8, Phase 5 Step 7): Print-to-file queues are unusable
//! for the Staff account. The agent adds one deny ACE ("Print", `SW` = `PRINTER_ACCESS_USE`)
//! for the Staff SID to the security descriptor of every queue whose **port** sends the output
//! to a file (`rulebox_win32::printing::is_file_output_port`, never the localized queue name).
//! Administrators and every other account are untouched: the ACE names the Staff SID only.
//!
//! * The original DACL of each queue is journalled first (`printer-sec:<queue>`, owner `L2`,
//!   target `PrinterSecurity`, original `Sddl`); Disable, `unenroll` and `recover` put it back.
//! * A queue whose DACL already denies Staff Print is left alone, so a second run writes nothing
//!   even though Windows may spell the DACL differently after it stored it.
//! * A queue that is gone, or whose port is no longer a file port, has its entry restored.
//! * Without a Staff account there is nobody to deny: nothing is written (and entries stay
//!   restorable).

use rulebox_policy::lockdown::LockdownPolicy;
use rulebox_win32::printing::is_file_output_port;

use super::allowlist::aces;
use super::apply::ApplyCtx;
use super::staff::Tally;
use crate::journal::{self, Change, JournalOwner};

/// The journal id prefix of every queue this module changed.
pub const ID_PREFIX: &str = "printer-sec:";
/// The SDDL right for "Print" on a queue (`PRINTER_ACCESS_USE`, 0x8).
const PRINT_RIGHT: &str = "SW";

/// True when the DACL has a deny ACE for `sid` that includes the Print right.
pub fn denies_print(sddl: &str, sid: &str) -> bool {
    aces(sddl).iter().any(|ace| {
        ace.kind == "D"
            && ace.trustee.eq_ignore_ascii_case(sid)
            && (ace.rights.contains(PRINT_RIGHT) || ace.rights.strip_prefix("0x").is_some_and(|hex| u32::from_str_radix(hex, 16).is_ok_and(|mask| mask & 0x8 != 0)))
    })
}

/// The DACL with a deny-Print ACE for `sid` in front of every other ACE (deny ACEs go first).
/// `None` when `sddl` is not a DACL string. Pure.
pub fn deny_print(sddl: &str, sid: &str) -> Option<String> {
    let start = sddl.find("D:")?;
    let after = start + 2;
    // The ACL flags (`PAI`, `P`, ...) come before the first ACE.
    let first_ace = sddl[after..].find('(').map_or(sddl.len(), |at| after + at);
    let ace = format!("(D;;{PRINT_RIGHT};;;{sid})");
    Some(format!("{}{ace}{}", &sddl[..first_ace], &sddl[first_ace..]))
}

/// Applies or restores the setting. Called by the machine layer (L2); results go into its tally.
pub(super) fn apply(ctx: &ApplyCtx<'_>, policy: Option<&LockdownPolicy>, tally: &mut Tally, restore: &mut Vec<String>) {
    let wanted = policy.is_some_and(|p| p.machine.file_output_printers);
    let staff = ctx.journal.shared.read(|state| state.staff.as_ref().map(|staff| staff.sid.clone()));
    let platform = ctx.journal.platform;

    // The queues that should carry the ACE.
    let mut keep: Vec<String> = Vec::new();
    if let (true, Some(sid)) = (wanted, staff.as_deref()) {
        match platform.printer_list() {
            Err(_) => {
                tally.record(Err("printer_list_unreadable"));
                // Keep what is there: an unreadable list is not a reason to undo anything.
                keep.extend(journal_ids(ctx));
            }
            Ok(printers) => {
                for printer in printers.iter().filter(|p| is_file_output_port(&p.port)) {
                    keep.push(journal::printer_security_id(&printer.name));
                    match platform.printer_get_security(&printer.name) {
                        Ok(Some(sddl)) if !denies_print(&sddl, sid) => match deny_print(&sddl, sid) {
                            Some(new) => {
                                let change = Change::printer_security(JournalOwner::L2, &printer.name, &new).since(ctx.version);
                                tally.record(journal::change(&ctx.journal, &change).map(|_| ()).map_err(|error| journal::error_code(&error)));
                            }
                            None => tally.record(Err("printer_security_unreadable")),
                        },
                        // Already denied (by us, or by the administrator): nothing to write.
                        Ok(Some(_)) => {}
                        // The queue vanished between the list and the read.
                        Ok(None) => {}
                        Err(_) => tally.record(Err("printer_security_unreadable")),
                    }
                }
            }
        }
    } else if wanted {
        // No Staff account: nobody to deny. Whatever an earlier run did stays until it is unwanted.
        keep.extend(journal_ids(ctx));
    }

    for id in journal_ids(ctx) {
        if !keep.iter().any(|kept| kept.eq_ignore_ascii_case(&id)) {
            restore.push(id);
        }
    }
}

/// The ids of the queue entries the journal holds.
fn journal_ids(ctx: &ApplyCtx<'_>) -> Vec<String> {
    ctx.journal.shared.read(|state| {
        state
            .journal
            .iter()
            .filter(|entry| entry.owner == JournalOwner::L2 && entry.id.starts_with(ID_PREFIX))
            .map(|entry| entry.id.clone())
            .collect()
    })
}

#[cfg(test)]
mod tests;
