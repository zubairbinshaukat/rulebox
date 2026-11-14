//! Printers (Phase 5 Step 14, plan 4.15): the apply of the document's `printers` key.
//!
//! * Every `doc.printers` item becomes a print queue named `<display name> (Rulebox)`, found again by the printer id
//!   Rulebox writes into the queue's **comment** (`rulebox:<id>`), not by its name, so a queue an administrator renamed
//!   is still ours (and is not created twice). Created through `journal::change` (original always "not present": restore
//!   deletes it). A queue that already exists under the same name and is not ours is never touched (`name_taken`).
//! * Kinds: `ipp` (the queue's port is the printer's URL, driver the IPP class driver or another approved one), `raw`
//!   and `lpr` (a Standard TCP/IP port `Rulebox_<id>` first, journalled too), `share` (a per-machine connection to
//!   `\\server\queue`).
//! * Drivers come **only from the local driver store**: the agent has no way to install one, and a driver that is not
//!   in the store is `failed / driver_missing` with nothing created. (The approved list itself is the server's: it is not
//!   part of the signed document, so the agent can only check that the driver is really there.)
//! * The default printer of a group is written into the Staff hive (`...\Windows\Device`, plus
//!   `LegacyDefaultPrinterMode = 1` so Windows does not move it), both journalled.
//! * An item the document no longer lists, a printer whose revision changed (rebuilt) and the default when no printer is
//!   default any more are restored through the journal.
//!
//! The states are `applied | failed`; `detail` is a fixed code, never Windows text. Not reached by the reconciler until
//! Step 20.

use std::net::{Ipv4Addr, Ipv6Addr};
use std::str::FromStr;

use rulebox_policy::network::{PrinterKind, PrinterSpec as DocPrinter};
use rulebox_policy::AgentDoc;
use rulebox_win32::printing::{NAME_SUFFIX, PORT_PREFIX};

use crate::backend::reports::PrinterItemState;
use crate::journal::{self, Change, JournalError, JournalOwner, PRINTER_PORT_PREFIX, PRINTER_QUEUE_PREFIX, PRINTER_SHARE_PREFIX};
use crate::lockdown::apply::ApplyCtx;
use crate::platform::{PlatformError, PortProtocol, PortSpec, PrinterInfo, PrinterSpec as QueueSpec, RegData};

pub const APPLIED: &str = "applied";
pub const FAILED: &str = "failed";

/// TCP port of a raw printer when the document gives none.
pub const DEFAULT_RAW_PORT: u16 = 9100;
/// Longest printer id (a port name `Rulebox_<id>` is at most 63 characters).
const MAX_PRINTER_ID: usize = 40;
/// The Staff hive key and values of the default printer (plan 4.15).
const DEFAULT_KEY: &str = r"Software\Microsoft\Windows NT\CurrentVersion\Windows";
const DEFAULT_VALUE: &str = "Device";
const LEGACY_MODE_VALUE: &str = "LegacyDefaultPrinterMode";
/// `ERROR_UNKNOWN_PORT`, `ERROR_UNKNOWN_PRINTER_DRIVER`, `ERROR_INVALID_PRINTER_NAME`.
const ERROR_UNKNOWN_PORT: u32 = 1796;
const ERROR_UNKNOWN_DRIVER: u32 = 1797;
const ERROR_INVALID_PRINTER_NAME: u32 = 1801;

/// Whether the Print Spooler must keep running: never disabled while printers are assigned (plan 4.15, edge case 39).
/// Step 18's performance layer asks this before it honours `performance.noPrinting`.
pub fn spooler_required(doc: &AgentDoc) -> bool {
    !doc.printers.is_empty()
}

/// A printer id the agent will write: `A-Z a-z 0-9 _ -`, 1 to 40 characters (never a backslash: a `\\` target is a share).
pub fn printer_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_PRINTER_ID && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// A display name Windows accepts as part of a queue name: 1 to 60 characters, no control characters, no `\`, `,` or `/`,
/// no leading or trailing space.
pub fn name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 60
        && name == name.trim()
        && !name.chars().any(|c| c.is_control() || matches!(c, '\\' | ',' | '/'))
}

pub fn queue_name(display_name: &str) -> String {
    format!("{display_name}{NAME_SUFFIX}")
}

/// `Rulebox_<id>`.
pub fn port_name(printer_id: &str) -> String {
    format!("{PORT_PREFIX}{printer_id}")
}

/// An IP literal (IPv4 without leading zeros, or IPv6) or a DNS name of at most 253 characters (plan 4.15). No port, no
/// brackets. Same rules as `convex/lib/printerAddress.ts` (`isHost`).
pub fn is_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    if Ipv4Addr::from_str(host).is_ok() || Ipv6Addr::from_str(host).is_ok() {
        return true;
    }
    let labels: Vec<&str> = host.split('.').collect();
    let label_ok = |l: &str| {
        let b = l.as_bytes();
        !b.is_empty()
            && b.len() <= 63
            && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
            && b[0] != b'-'
            && b[b.len() - 1] != b'-'
    };
    // `999.1.1.1` is not a name: a last label of digits only must have been an IPv4 address.
    labels.iter().all(|l| label_ok(l)) && !labels.last().is_some_and(|l| l.bytes().all(|c| c.is_ascii_digit()))
}

/// `ipp://host[:port]/path` or `https://host[:port]/path`: no credentials, a real host, a port of 1 to 65535, a path.
fn ipp_url_ok(address: &str) -> bool {
    let lower = address.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("ipp://").or_else(|| lower.strip_prefix("https://")) else {
        return false;
    };
    let (authority, path) = match rest.find('/') {
        Some(at) => (&rest[..at], &rest[at..]),
        None => return false,
    };
    if authority.is_empty() || authority.contains('@') || path.len() < 2 || path.contains(['?', '#']) {
        return false;
    }
    if path.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    let (host, port) = if let Some(inner) = authority.strip_prefix('[') {
        let Some((host, after)) = inner.split_once(']') else {
            return false;
        };
        if Ipv6Addr::from_str(host).is_err() {
            return false;
        }
        match after {
            "" => ("", None),
            _ => match after.strip_prefix(':') {
                Some(port) => ("", Some(port)),
                None => return false,
            },
        }
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) if !host.contains(':') => (host, Some(port)),
            Some(_) => return false,
            None => (authority, None),
        }
    };
    if !authority.starts_with('[') && !is_host(host) {
        return false;
    }
    match port {
        Some(port) => port.len() <= 5 && port.bytes().all(|c| c.is_ascii_digit()) && port.parse::<u32>().is_ok_and(|p| (1..=65535).contains(&p)),
        None => true,
    }
}

/// `\\server\queue`: a host and a queue name, nothing else.
fn share_ok(address: &str) -> bool {
    let Some(rest) = address.strip_prefix("\\\\") else {
        return false;
    };
    let mut parts = rest.split('\\');
    let (server, queue, more) = (parts.next(), parts.next(), parts.next());
    more.is_none()
        && server.is_some_and(is_host)
        && queue.is_some_and(|q| !q.trim().is_empty() && !q.chars().any(|c| c.is_control() || matches!(c, ',' | '/' | '"')))
        && address.len() <= 255
}

/// How one printer is created.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// The queue's port is the URL.
    Ipp { url: String },
    /// A Standard TCP/IP port of Rulebox's own, then the queue on it.
    Tcp { port: PortSpec },
    /// A per-machine connection; there is no local queue.
    Share { unc: String },
}

/// What the document asks for, or a fixed code: `section_unknown_value`, `address_invalid`, `port_invalid`,
/// `queue_required`, `queue_invalid`.
pub fn plan_of(spec: &DocPrinter) -> Result<Plan, &'static str> {
    let address = spec.address.as_str();
    match spec.kind {
        PrinterKind::Unknown => Err("section_unknown_value"),
        PrinterKind::Ipp => {
            if spec.port.is_some() || spec.queue.is_some() {
                return Err("port_invalid");
            }
            if ipp_url_ok(address) { Ok(Plan::Ipp { url: address.to_string() }) } else { Err("address_invalid") }
        }
        PrinterKind::Share => {
            if spec.port.is_some() || spec.queue.is_some() {
                return Err("port_invalid");
            }
            if share_ok(address) { Ok(Plan::Share { unc: address.to_string() }) } else { Err("address_invalid") }
        }
        PrinterKind::Raw | PrinterKind::Lpr => {
            if !is_host(address) || address.len() > 48 {
                return Err("address_invalid");
            }
            let name = port_name(&spec.id);
            if spec.kind == PrinterKind::Raw {
                if spec.queue.as_deref().is_some_and(|q| !q.is_empty()) {
                    return Err("queue_invalid");
                }
                let number = spec.port.unwrap_or(DEFAULT_RAW_PORT);
                if number == 0 {
                    return Err("port_invalid");
                }
                Ok(Plan::Tcp { port: PortSpec { name, protocol: PortProtocol::RawTcp, host: address.to_string(), number, queue: String::new() } })
            } else {
                if spec.port.is_some() {
                    return Err("port_invalid");
                }
                let queue = match spec.queue.as_deref() {
                    Some(q) if !q.is_empty() => q,
                    _ => return Err("queue_required"),
                };
                if queue.chars().count() > 32 || queue.chars().any(|c| c.is_control() || c.is_whitespace()) {
                    return Err("queue_invalid");
                }
                Ok(Plan::Tcp { port: PortSpec { name, protocol: PortProtocol::Lpr, host: address.to_string(), number: 515, queue: queue.to_string() } })
            }
        }
    }
}

/// `rev<revision>:<sha256 of everything that goes into the queue>`: what the agent remembers about a queue it made. The
/// default flag is not part of it (the default lives in the Staff hive).
pub fn mark_of(spec: &DocPrinter) -> String {
    let canonical = format!(
        "{:?}|{}|{}|{}|{}|{}",
        spec.kind,
        spec.name,
        spec.address,
        spec.port.map_or(String::new(), |p| p.to_string()),
        spec.queue.as_deref().unwrap_or(""),
        spec.driver
    );
    format!("rev{}:{}", spec.revision, journal::policy_hash(canonical.as_bytes()))
}

fn item(spec: &DocPrinter, state: &str, detail: Option<&str>) -> PrinterItemState {
    PrinterItemState { printer_id: spec.id.clone(), revision: spec.revision, state: state.to_string(), detail: detail.map(str::to_string) }
}

/// What the Printers layer did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PrinterOutcome {
    pub items: Vec<PrinterItemState>,
}

/// The fixed code for a failed write.
fn failure_code(error: &JournalError, fallback: &'static str) -> &'static str {
    match error {
        JournalError::Platform(PlatformError::Win32 { code: ERROR_UNKNOWN_DRIVER, .. }) => "driver_missing",
        JournalError::Platform(PlatformError::Win32 { code: ERROR_UNKNOWN_PORT, .. }) => "port_missing",
        JournalError::Platform(PlatformError::Win32 { code: ERROR_INVALID_PRINTER_NAME, .. }) => "name_invalid",
        JournalError::Platform(PlatformError::AlreadyExists) => "port_exists",
        JournalError::Platform(PlatformError::Win32 { .. } | PlatformError::Other(_) | PlatformError::NotFound) => fallback,
        other => journal::error_code(other),
    }
}

/// The ids of the journal entries of printers (queues, ports, share connections) and of the default printer in the Staff hive.
fn printer_entry_ids(ctx: &ApplyCtx<'_>) -> Vec<String> {
    ctx.journal.shared.read(|state| {
        state
            .journal
            .iter()
            .filter(|entry| {
                entry.owner == JournalOwner::Printer
                    && (entry.id.starts_with(PRINTER_QUEUE_PREFIX) || entry.id.starts_with(PRINTER_PORT_PREFIX) || entry.id.starts_with(PRINTER_SHARE_PREFIX) || entry.id.starts_with("staff:"))
            })
            .map(|entry| entry.id.clone())
            .collect()
    })
}

/// The entries already built for printer `printer_id` (its queue and its port) stay while the document still lists it.
fn keep_built(existing: &[String], printer_id: &str, keep: &mut Vec<String>) {
    let queue = journal::printer_queue_id(printer_id);
    let port = journal::printer_port_id(&port_name(printer_id));
    keep.extend(existing.iter().filter(|id| **id == queue || **id == port).cloned());
}

fn has_entry(ctx: &ApplyCtx<'_>, id: &str) -> bool {
    ctx.journal.shared.read(|state| state.journal.iter().any(|entry| entry.id == id))
}

fn stored_mark(ctx: &ApplyCtx<'_>, id: &str) -> Option<String> {
    ctx.journal.shared.read(|state| state.printer_marks.get(id).cloned())
}

fn default_ids() -> [String; 2] {
    [journal::staff_id(DEFAULT_KEY, DEFAULT_VALUE), journal::staff_id(DEFAULT_KEY, LEGACY_MODE_VALUE)]
}

/// Creates one printer; the name of the queue the Staff default should point at, or the failure code.
fn install(ctx: &ApplyCtx<'_>, spec: &DocPrinter, plan: &Plan, queues: &[PrinterInfo], keep: &mut Vec<String>) -> Result<String, &'static str> {
    let mark = mark_of(spec);
    match plan {
        Plan::Share { unc } => {
            let id = journal::printer_share_id(unc);
            keep.push(id.clone());
            // A changed mark (the driver name, the revision) rebuilds the connection.
            if has_entry(ctx, &id) && stored_mark(ctx, &id).as_deref() != Some(mark.as_str()) {
                let _ = journal::restore_ids(&ctx.journal, std::slice::from_ref(&id));
            }
            let change = Change::printer_share(unc, &mark).since(ctx.version);
            journal::change(&ctx.journal, &change).map_err(|e| failure_code(&e, "share_failed"))?;
            Ok(unc.clone())
        }
        Plan::Ipp { .. } | Plan::Tcp { .. } => {
            let queue_id = journal::printer_queue_id(&spec.id);
            let port_id = match plan {
                Plan::Tcp { port } => Some(journal::printer_port_id(&port.name)),
                _ => None,
            };
            keep.push(queue_id.clone());
            keep.extend(port_id.clone());
            let name = queue_name(&spec.name);
            let comment = journal::printer_comment(&spec.id);
            let ours = queues.iter().find(|queue| queue.comment == comment);
            // The same name used by a queue that is not ours: leave it alone, create nothing (edge case 38).
            if ours.is_none() && queues.iter().any(|queue| queue.name.eq_ignore_ascii_case(&name)) {
                keep.retain(|id| *id != queue_id && Some(id) != port_id.as_ref());
                return Err("name_taken");
            }
            // The printer changed (revision, address, driver, name): rebuild it from scratch (queue first, then port).
            if has_entry(ctx, &queue_id) && stored_mark(ctx, &queue_id).as_deref() != Some(mark.as_str()) {
                let ids: Vec<String> = std::iter::once(queue_id.clone()).chain(port_id.clone()).collect();
                let report = journal::restore_ids(&ctx.journal, &ids);
                if let Some((_, error)) = report.failed.first() {
                    return Err(failure_code(error, "restore_failed"));
                }
            }
            let (queue_port, port_change) = match plan {
                Plan::Ipp { url } => (url.clone(), None),
                Plan::Tcp { port } => (port.name.clone(), Some(Change::printer_port(port.clone(), &mark).since(ctx.version))),
                Plan::Share { .. } => unreachable!("handled above"),
            };
            if let Some(change) = port_change {
                journal::change(&ctx.journal, &change).map_err(|e| failure_code(&e, "port_failed"))?;
            }
            let queue = QueueSpec { name: name.clone(), port: queue_port, driver: spec.driver.clone(), comment };
            let change = Change::printer_queue(&spec.id, queue, &mark).since(ctx.version);
            journal::change(&ctx.journal, &change).map_err(|e| failure_code(&e, "printer_failed"))?;
            Ok(name)
        }
    }
}

/// Applies the document's `printers` key. Runs in `Layer::Printers`.
pub fn apply(ctx: &ApplyCtx<'_>, doc: &AgentDoc) -> PrinterOutcome {
    let mut outcome = PrinterOutcome::default();
    let platform = ctx.journal.platform;
    let existing = printer_entry_ids(ctx);
    if doc.printers.is_empty() && existing.is_empty() {
        return outcome;
    }
    let mut keep: Vec<String> = Vec::new();
    let mut default_pick: Option<(String, String)> = None; // (printer id, name the Staff default points at)

    if !doc.printers.is_empty() {
        let (queues, drivers) = match (platform.printer_list(), platform.printer_drivers()) {
            (Ok(queues), Ok(drivers)) => (queues, drivers),
            (Err(_), _) | (_, Err(_)) => {
                // Cannot read the spooler: touch nothing, say so for every printer, keep what is there.
                outcome.items = doc.printers.iter().map(|spec| item(spec, FAILED, Some("printers_unreadable"))).collect();
                return outcome;
            }
        };
        for spec in &doc.printers {
            if !printer_id_ok(&spec.id) {
                outcome.items.push(item(spec, FAILED, Some("bad_printer_id")));
                continue;
            }
            let plan = match plan_of(spec) {
                Ok(plan) => plan,
                Err(code) => {
                    outcome.items.push(item(spec, FAILED, Some(code)));
                    // Whatever was built for this id stays until the document stops listing it.
                    keep_built(&existing, &spec.id, &mut keep);
                    continue;
                }
            };
            if !matches!(plan, Plan::Share { .. }) && !name_ok(&spec.name) {
                outcome.items.push(item(spec, FAILED, Some("name_invalid")));
                continue;
            }
            // Drivers only from the local store; a missing one creates nothing (edge case 37).
            if !drivers.iter().any(|driver| driver.eq_ignore_ascii_case(&spec.driver)) {
                outcome.items.push(item(spec, FAILED, Some("driver_missing")));
                keep_built(&existing, &spec.id, &mut keep);
                if let Plan::Share { unc } = &plan {
                    keep.push(journal::printer_share_id(unc));
                }
                continue;
            }
            match install(ctx, spec, &plan, &queues, &mut keep) {
                Ok(default_name) => {
                    outcome.items.push(item(spec, APPLIED, None));
                    if spec.is_default && default_pick.as_ref().is_none_or(|(id, _)| spec.id < *id) {
                        default_pick = Some((spec.id.clone(), default_name));
                    }
                }
                Err(code) => outcome.items.push(item(spec, FAILED, Some(code))),
            }
        }
    }

    // The default printer of the Staff account (journalled in the Staff hive).
    let has_staff = ctx.journal.shared.read(|state| state.staff.is_some());
    let default_keys = default_ids();
    if let (Some((id, name)), true) = (&default_pick, has_staff) {
        let device = format!("{name},winspool,Ne00:");
        let device_change = Change::staff(JournalOwner::Printer, DEFAULT_KEY, DEFAULT_VALUE, Some(RegData::String(device))).since(ctx.version);
        let legacy_change = Change::staff(JournalOwner::Printer, DEFAULT_KEY, LEGACY_MODE_VALUE, Some(RegData::Dword(1))).since(ctx.version);
        let result = journal::change(&ctx.journal, &device_change).and_then(|_| journal::change(&ctx.journal, &legacy_change));
        keep.extend(default_keys.iter().cloned());
        if let Err(error) = result {
            if let Some(entry) = outcome.items.iter_mut().find(|entry| entry.printer_id == *id) {
                entry.detail = Some(failure_code(&error, "default_not_set").to_string());
            }
        }
    }

    // Everything Rulebox made that the document does not list any more (or no longer wants as the default) goes back.
    let gone: Vec<String> = printer_entry_ids(ctx).into_iter().filter(|id| !keep.contains(id)).collect();
    if !gone.is_empty() {
        let report = journal::restore_ids(&ctx.journal, &gone);
        if !report.failed.is_empty() {
            tracing::warn!("{} printer item(s) could not be removed", report.failed.len());
        }
    }
    outcome
}

#[cfg(test)]
mod tests;
