//! Printer queues and their security descriptors (plan 4.5, 4.8, 4.15, Steps 7 and 14b).
//!
//! Rules checked before the guard and before any API call:
//!
//! - a printer Rulebox **adds or deletes** is named `<display name> (Rulebox)`, so it only
//!   ever removes a queue it made (plan 4.15);
//! - the security descriptor of any queue can be read and replaced (the file-output
//!   printers of plan 4.8 are Windows' own queues), but the name must be a plain queue
//!   name: no `\`, no `,`, no control characters.
//!
//! Driver choice and the approved-driver list are the agent's job (Step 14; Step 14b adds pushing drivers); `add` only
//! passes the names it is given to Windows, which refuses a driver that is not installed. Step 14 adds the comment
//! field (the stored printer id), the driver list, Standard TCP/IP ports (`Rulebox_<id>`) and per-machine share
//! connections. Every writer checks its rules first, then the guard.

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Graphics::Printing::{
    AddPrinterW, ClosePrinter, DeletePrinter, EnumPortsW, EnumPrinterDriversW, EnumPrintersW, GetPrinterW, OpenPrinterW,
    SetPrinterW, XcvDataW, DRIVER_INFO_1W, PORT_INFO_1W, PRINTER_ACCESS_RIGHTS, PRINTER_ALL_ACCESS, PRINTER_DEFAULTSW,
    PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_HANDLE, PRINTER_INFO_2W, PRINTER_INFO_3,
};
use windows::Win32::Security::PSECURITY_DESCRIPTOR;

use crate::error::{api_err, Result, Win32Error};
use crate::guard::require_test_machine;
use crate::security::{dacl_sddl_of, SecurityAttributes};
use crate::util::{pwstr_to_string, to_wide};

/// The suffix of every queue Rulebox owns.
pub const NAME_SUFFIX: &str = " (Rulebox)";
/// `READ_CONTROL`: enough to read a printer's security descriptor.
const READ_CONTROL: u32 = 0x0002_0000;
/// `ERROR_INSUFFICIENT_BUFFER`.
const INSUFFICIENT_BUFFER: u32 = 122;
/// `ERROR_INVALID_PRINTER_NAME`.
const INVALID_PRINTER_NAME: u32 = 1801;
/// `ERROR_ALREADY_EXISTS` and `ERROR_UNKNOWN_PORT` (what the port monitor answers).
const ERROR_ALREADY_EXISTS: u32 = 183;
const ERROR_UNKNOWN_PORT: u32 = 1796;

/// A queue Rulebox is asked to create.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrinterSpec {
    /// `<display name> (Rulebox)`.
    pub name: String,
    /// An existing port: one of ours (`Rulebox_<id>`, see [`add_port`]) or, for an IPP printer, the printer's URL.
    pub port: String,
    pub driver: String,
    /// The queue's comment field. Rulebox stores `rulebox:<printer id>` here, so a queue is found by id even when
    /// somebody renamed it (plan 4.15).
    pub comment: String,
}

/// One queue as `list` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrinterInfo {
    pub name: String,
    pub port: String,
    pub driver: String,
    pub attributes: u32,
    /// The comment field (see [`PrinterSpec::comment`]).
    pub comment: String,
}

/// A printer handle closed on drop.
struct Printer(PRINTER_HANDLE);

impl Drop for Printer {
    fn drop(&mut self) {
        // SAFETY: the handle was opened by this module, is owned by this value and closed once.
        unsafe {
            let _ = ClosePrinter(self.0);
        }
    }
}

pub fn check_plain_name(name: &str) -> Result<()> {
    let plain = !name.trim().is_empty()
        && name.len() <= 220
        && !name.chars().any(|c| c.is_control() || matches!(c, '\\' | ',' | '/'));
    if plain {
        Ok(())
    } else {
        Err(Win32Error::Forbidden(format!("{name:?} is not a plain printer name")))
    }
}

/// (Phase 5 Step 7) Whether a queue's port sends the output to a file instead of a device
/// (plan 4.8, `fileOutputPrinters`). Decided by the **port**, never by the queue's name,
/// which Windows translates: `FILE:` (the print-to-file port), `PORTPROMPT:` (Microsoft Print
/// to PDF and the XPS writer ask for a file name), `XPSPort:` (older XPS writers) and a local
/// port that is a file path (`C:\Spool\out.prn`). The fixed port names are not localized.
pub fn is_file_output_port(port: &str) -> bool {
    let port = port.trim();
    let lower = port.to_ascii_lowercase();
    if matches!(lower.as_str(), "file:" | "portprompt:" | "xpsport:") {
        return true;
    }
    // A drive-letter path (`C:\...`): a local port that appends to a file. A UNC path is a
    // printer share, not a file, and is left alone.
    let bytes = port.as_bytes();
    bytes.len() > 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/')
}

/// A queue Rulebox may add or delete: a plain name ending in ` (Rulebox)`.
pub fn check_own_name(name: &str) -> Result<()> {
    check_plain_name(name)?;
    if name.len() > NAME_SUFFIX.len() && name.ends_with(NAME_SUFFIX) {
        Ok(())
    } else {
        Err(Win32Error::Forbidden(format!("{name:?} is not a queue Rulebox made")))
    }
}

/// The rules of [`add`] (no API call, no guard).
pub fn check_spec(spec: &PrinterSpec) -> Result<()> {
    check_own_name(&spec.name)?;
    check_plain_name(&spec.driver)?;
    if spec.port.trim().is_empty() || spec.port.len() > 220 || spec.port.chars().any(char::is_control) {
        return Err(Win32Error::Forbidden("the port name is not valid".into()));
    }
    Ok(())
}

fn open(name: &str, access: u32) -> Result<Option<Printer>> {
    let wide = to_wide(name);
    let defaults = PRINTER_DEFAULTSW { DesiredAccess: PRINTER_ACCESS_RIGHTS(access), ..Default::default() };
    let mut handle = PRINTER_HANDLE::default();
    // SAFETY: `wide` is NUL-terminated and outlives the call; `handle` and `defaults` are valid.
    match unsafe { OpenPrinterW(PCWSTR(wide.as_ptr()), &mut handle, Some(&defaults)) } {
        Ok(()) => Ok(Some(Printer(handle))),
        Err(e) => match api_err("OpenPrinterW", &e) {
            Win32Error::Api { code: INVALID_PRINTER_NAME, .. } => Ok(None),
            other => Err(other),
        },
    }
}

/// A zeroed buffer aligned for the structures the spooler writes into it.
fn aligned(bytes: usize) -> Vec<u64> {
    vec![0u64; bytes.div_ceil(8).max(1)]
}

fn as_bytes(buffer: &mut [u64]) -> &mut [u8] {
    let len = std::mem::size_of_val(buffer);
    // SAFETY: the slice covers exactly the allocation of `buffer` (u64 units viewed as bytes).
    unsafe { std::slice::from_raw_parts_mut(buffer.as_mut_ptr().cast::<u8>(), len) }
}

/// The local queues and connected shares. Read-only.
pub fn list() -> Result<Vec<PrinterInfo>> {
    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
    let (mut needed, mut returned) = (0u32, 0u32);
    // SAFETY: no buffer, size 0: only the size is asked for. A null name is this machine.
    let first = unsafe { EnumPrintersW(flags, PCWSTR::null(), 2, None, &mut needed, &mut returned) };
    if let Err(e) = first {
        match api_err("EnumPrintersW", &e) {
            Win32Error::Api { code: INSUFFICIENT_BUFFER, .. } => {}
            other => return Err(other),
        }
    }
    if needed == 0 {
        return Ok(Vec::new());
    }
    let mut buffer = aligned(needed as usize);
    // SAFETY: the buffer holds at least `needed` bytes and is 8-byte aligned.
    unsafe { EnumPrintersW(flags, PCWSTR::null(), 2, Some(as_bytes(&mut buffer)), &mut needed, &mut returned) }
        .map_err(|e| api_err("EnumPrintersW", &e))?;
    let first = buffer.as_ptr().cast::<PRINTER_INFO_2W>();
    let mut out = Vec::with_capacity(returned as usize);
    for i in 0..returned as usize {
        // SAFETY: the call wrote `returned` consecutive PRINTER_INFO_2W structures at the
        // start of `buffer`; their strings point into the same buffer.
        let info = unsafe { &*first.add(i) };
        out.push(PrinterInfo {
            name: pwstr_to_string(info.pPrinterName),
            port: pwstr_to_string(info.pPortName),
            driver: pwstr_to_string(info.pDriverName),
            attributes: info.Attributes,
            comment: pwstr_to_string(info.pComment),
        });
    }
    Ok(out)
}

/// The names of the printer drivers in the Windows driver store (current architecture). Read-only. The agent never
/// installs a driver (plan 4.15): a printer whose driver is not in this list is `driver_missing`.
pub fn list_drivers() -> Result<Vec<String>> {
    let (mut needed, mut returned) = (0u32, 0u32);
    // SAFETY: no buffer, size 0: only the size is asked for. Null name and environment: this machine, this architecture.
    let first = unsafe { EnumPrinterDriversW(PCWSTR::null(), PCWSTR::null(), 1, None, &mut needed, &mut returned) };
    if let Err(e) = first {
        match api_err("EnumPrinterDriversW", &e) {
            Win32Error::Api { code: INSUFFICIENT_BUFFER, .. } => {}
            other => return Err(other),
        }
    }
    if needed == 0 {
        return Ok(Vec::new());
    }
    let mut buffer = aligned(needed as usize);
    // SAFETY: the buffer holds at least `needed` bytes and is 8-byte aligned.
    unsafe { EnumPrinterDriversW(PCWSTR::null(), PCWSTR::null(), 1, Some(as_bytes(&mut buffer)), &mut needed, &mut returned) }
        .map_err(|e| api_err("EnumPrinterDriversW", &e))?;
    let first = buffer.as_ptr().cast::<DRIVER_INFO_1W>();
    let mut out = Vec::with_capacity(returned as usize);
    for i in 0..returned as usize {
        // SAFETY: the call wrote `returned` consecutive DRIVER_INFO_1W structures at the start of `buffer`.
        out.push(pwstr_to_string(unsafe { &*first.add(i) }.pName));
    }
    Ok(out)
}

// ---- ports (Standard TCP/IP port monitor) ---------------------------------------------------------------------------

/// The prefix of every port Rulebox creates, so it only ever deletes a port it made.
pub const PORT_PREFIX: &str = "Rulebox_";
/// Longest port name (`PORT_DATA_1.sztPortName` is 64 characters with the terminator).
const MAX_PORT_NAME: usize = 63;
/// `PORT_DATA_1` field sizes: host 48, LPR queue 32 characters.
const MAX_PORT_HOST: usize = 48;
const MAX_PORT_QUEUE: usize = 32;
/// `SERVER_ACCESS_ADMINISTER`: what the Xcv port of a print monitor needs.
const SERVER_ACCESS_ADMINISTER: u32 = 1;
/// The Xcv name of the Standard TCP/IP port monitor.
const TCP_MONITOR: &str = ",XcvMonitor Standard TCP/IP Port";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortProtocol {
    /// Raw TCP (usually 9100).
    RawTcp,
    /// LPR / LPD (port 515, queue name required).
    Lpr,
}

/// A Standard TCP/IP port Rulebox is asked to create.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortSpec {
    /// `Rulebox_<printer id>`.
    pub name: String,
    pub protocol: PortProtocol,
    pub host: String,
    /// The TCP port (raw); LPR ignores it (515).
    pub number: u16,
    /// The LPR queue; empty for raw.
    pub queue: String,
}

/// `PORT_DATA_1` (tcpmon): the layout `XcvData("AddPort")` expects.
#[repr(C)]
struct PortData1 {
    port_name: [u16; 64],
    version: u32,
    protocol: u32,
    size: u32,
    reserved: u32,
    host: [u16; 49],
    snmp_community: [u16; 33],
    double_spool: u32,
    queue: [u16; 33],
    ip_address: [u16; 16],
    reserved2: [u8; 540],
    port_number: u32,
    snmp_enabled: u32,
    snmp_dev_index: u32,
}

fn fill<const N: usize>(target: &mut [u16; N], text: &str) {
    for (slot, unit) in target.iter_mut().zip(text.encode_utf16().take(N - 1)) {
        *slot = unit;
    }
}

/// A port name Rulebox may add or delete: `Rulebox_<id>`, plain characters, at most 63.
pub fn check_own_port_name(name: &str) -> Result<()> {
    let plain = name.len() > PORT_PREFIX.len()
        && name.len() <= MAX_PORT_NAME
        && name.starts_with(PORT_PREFIX)
        && !name.chars().any(|c| c.is_control() || matches!(c, '\\' | ',' | '/' | ' '));
    if plain {
        Ok(())
    } else {
        Err(Win32Error::Forbidden(format!("{name:?} is not a port Rulebox made")))
    }
}

/// The rules of [`add_port`] (no API call, no guard).
pub fn check_port_spec(spec: &PortSpec) -> Result<()> {
    check_own_port_name(&spec.name)?;
    let host_ok = !spec.host.is_empty() && spec.host.chars().count() <= MAX_PORT_HOST && !spec.host.chars().any(|c| c.is_control() || c.is_whitespace());
    if !host_ok {
        return Err(Win32Error::Forbidden("the port host is not valid".into()));
    }
    let queue_ok = spec.queue.chars().count() <= MAX_PORT_QUEUE && !spec.queue.chars().any(|c| c.is_control() || c.is_whitespace());
    if !queue_ok || (spec.protocol == PortProtocol::Lpr && spec.queue.is_empty()) || (spec.protocol == PortProtocol::RawTcp && !spec.queue.is_empty()) {
        return Err(Win32Error::Forbidden("the port queue is not valid".into()));
    }
    if spec.protocol == PortProtocol::RawTcp && spec.number == 0 {
        return Err(Win32Error::Forbidden("the port number is not valid".into()));
    }
    Ok(())
}

/// Names of the ports on this machine. Read-only.
pub fn list_ports() -> Result<Vec<String>> {
    let (mut needed, mut returned) = (0u32, 0u32);
    // SAFETY: no buffer, size 0: only the size is asked for. A null name is this machine.
    let first = unsafe { EnumPortsW(PCWSTR::null(), 1, None, &mut needed, &mut returned) }.ok();
    if let Err(e) = first {
        match api_err("EnumPortsW", &e) {
            Win32Error::Api { code: INSUFFICIENT_BUFFER, .. } => {}
            other => return Err(other),
        }
    }
    if needed == 0 {
        return Ok(Vec::new());
    }
    let mut buffer = aligned(needed as usize);
    // SAFETY: the buffer holds at least `needed` bytes and is 8-byte aligned.
    unsafe { EnumPortsW(PCWSTR::null(), 1, Some(as_bytes(&mut buffer)), &mut needed, &mut returned) }
        .ok()
        .map_err(|e| api_err("EnumPortsW", &e))?;
    let first = buffer.as_ptr().cast::<PORT_INFO_1W>();
    let mut out = Vec::with_capacity(returned as usize);
    for i in 0..returned as usize {
        // SAFETY: the call wrote `returned` consecutive PORT_INFO_1W structures at the start of `buffer`.
        out.push(pwstr_to_string(unsafe { &*first.add(i) }.pName));
    }
    Ok(out)
}

/// One Xcv call to the Standard TCP/IP port monitor.
fn xcv(command: &str, input: &[u8]) -> Result<()> {
    let monitor = open(TCP_MONITOR, SERVER_ACCESS_ADMINISTER)?.ok_or(Win32Error::NotFound)?;
    let name = to_wide(command);
    let (mut needed, mut status) = (0u32, 0u32);
    // SAFETY: the Xcv handle is open; `name` is NUL-terminated; `input` outlives the call; no output is expected.
    unsafe {
        XcvDataW(
            HANDLE(monitor.0.Value),
            PCWSTR(name.as_ptr()),
            Some(input),
            None,
            &mut needed,
            Some(&mut status),
        )
    }
    .ok()
    .map_err(|e| api_err("XcvDataW", &e))?;
    if status != 0 {
        return Err(Win32Error::Api { api: "XcvDataW", code: status });
    }
    Ok(())
}

/// Creates a Standard TCP/IP port (raw or LPR). A port of that name that exists already is `AlreadyExists`.
///
/// DESTRUCTIVE: guarded. UNVERIFIED on a real print spooler (Step 21).
pub fn add_port(spec: &PortSpec) -> Result<()> {
    check_port_spec(spec)?;
    require_test_machine()?;
    // SAFETY: PortData1 is plain old data; all-zero is a valid value.
    let mut data: PortData1 = unsafe { std::mem::zeroed() };
    fill(&mut data.port_name, &spec.name);
    data.version = 1;
    data.protocol = if spec.protocol == PortProtocol::RawTcp { 1 } else { 2 };
    data.size = std::mem::size_of::<PortData1>() as u32;
    fill(&mut data.host, &spec.host);
    fill(&mut data.queue, &spec.queue);
    data.port_number = if spec.protocol == PortProtocol::Lpr { 515 } else { u32::from(spec.number) };
    // SAFETY: `data` is a live, initialised repr(C) value; the slice covers exactly its bytes.
    let bytes = unsafe { std::slice::from_raw_parts(std::ptr::from_ref(&data).cast::<u8>(), std::mem::size_of::<PortData1>()) };
    match xcv("AddPort", bytes) {
        Err(Win32Error::Api { code: ERROR_ALREADY_EXISTS, .. }) => Err(Win32Error::AlreadyExists),
        other => other,
    }
}

/// Deletes a port Rulebox made (a port that is not there is fine).
///
/// DESTRUCTIVE: guarded.
pub fn delete_port(name: &str) -> Result<()> {
    check_own_port_name(name)?;
    require_test_machine()?;
    let wide = to_wide(name);
    // SAFETY: the slice covers exactly the UTF-16 units (with the terminator) of `wide`.
    let bytes = unsafe { std::slice::from_raw_parts(wide.as_ptr().cast::<u8>(), wide.len() * 2) };
    match xcv("DeletePort", bytes) {
        Err(Win32Error::Api { code: ERROR_UNKNOWN_PORT, .. }) => Ok(()),
        other => other,
    }
}

// ---- per-machine share connections ----------------------------------------------------------------------------------

/// A share name `\\server\queue`: two plain parts, nothing else.
pub fn check_share_name(unc: &str) -> Result<()> {
    let ok = unc.len() <= 255
        && unc.strip_prefix("\\\\").is_some_and(|rest| {
            let mut parts = rest.split('\\');
            let (server, queue, more) = (parts.next(), parts.next(), parts.next());
            more.is_none()
                && server.is_some_and(|s| !s.is_empty() && !s.chars().any(|c| c.is_control() || c.is_whitespace() || matches!(c, ',' | '/' | '"')))
                && queue.is_some_and(|q| !q.trim().is_empty() && !q.chars().any(|c| c.is_control() || matches!(c, ',' | '/' | '"')))
        });
    if ok {
        Ok(())
    } else {
        Err(Win32Error::Forbidden(format!("{unc:?} is not a printer share name")))
    }
}

fn printui(flag: &str, unc: &str) -> Result<()> {
    let root = std::env::var_os("SystemRoot").map(std::path::PathBuf::from).unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"));
    let mut command = std::process::Command::new(root.join(r"System32\rundll32.exe"));
    command.arg("printui.dll,PrintUIEntry").arg(flag).arg(format!("/n{unc}"));
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let status = command.status().map_err(|_| Win32Error::Api { api: "PrintUIEntry", code: 0 })?;
    if status.success() {
        Ok(())
    } else {
        Err(Win32Error::Api { api: "PrintUIEntry", code: status.code().map_or(0, |c| c as u32) })
    }
}

/// Adds a per-machine printer connection (`PrintUIEntry /ga`): every user gets the printer at sign-in, no driver is
/// fetched by Rulebox. DESTRUCTIVE: guarded. UNVERIFIED on a real print server (Step 21): whether Windows pulls the
/// driver from the server in this call is the open question of plan 4.15 (`driver_not_approved`).
pub fn connect_share(unc: &str) -> Result<()> {
    check_share_name(unc)?;
    require_test_machine()?;
    printui("/ga", unc)
}

/// Removes a per-machine printer connection (`PrintUIEntry /gd`). DESTRUCTIVE: guarded.
pub fn disconnect_share(unc: &str) -> Result<()> {
    check_share_name(unc)?;
    require_test_machine()?;
    printui("/gd", unc)
}
/// Creates a local queue on an existing port with an installed driver.
///
/// DESTRUCTIVE: guarded.
pub fn add(spec: &PrinterSpec) -> Result<()> {
    check_spec(spec)?;
    require_test_machine()?;
    let mut name = to_wide(&spec.name);
    let mut port = to_wide(&spec.port);
    let mut driver = to_wide(&spec.driver);
    let mut processor = to_wide("winprint");
    let mut datatype = to_wide("RAW");
    let mut comment = to_wide(&spec.comment);
    let info = PRINTER_INFO_2W {
        pPrinterName: PWSTR(name.as_mut_ptr()),
        pComment: PWSTR(comment.as_mut_ptr()),
        pPortName: PWSTR(port.as_mut_ptr()),
        pDriverName: PWSTR(driver.as_mut_ptr()),
        pPrintProcessor: PWSTR(processor.as_mut_ptr()),
        pDatatype: PWSTR(datatype.as_mut_ptr()),
        ..Default::default()
    };
    // SAFETY: `info` is a valid PRINTER_INFO_2W whose strings outlive the call; a null
    // server name is this machine.
    let handle = unsafe { AddPrinterW(PCWSTR::null(), 2, std::ptr::from_ref(&info).cast::<u8>()) }
        .map_err(|e| api_err("AddPrinterW", &e))?;
    // The returned handle is only closed. It is a printer handle in a HANDLE-typed wrapper.
    drop(Printer(PRINTER_HANDLE { Value: handle.0 }));
    Ok(())
}

/// Deletes a queue Rulebox made (a queue that is not there is fine).
///
/// DESTRUCTIVE: guarded.
pub fn delete(name: &str) -> Result<()> {
    check_own_name(name)?;
    require_test_machine()?;
    let Some(printer) = open(name, PRINTER_ALL_ACCESS.0)? else {
        return Ok(());
    };
    // SAFETY: the handle is open with full access.
    unsafe { DeletePrinter(printer.0) }.map_err(|e| api_err("DeletePrinter", &e))
}

/// The DACL of a queue as SDDL. `Ok(None)` when there is no such queue. Read-only.
pub fn get_security(name: &str) -> Result<Option<String>> {
    check_plain_name(name)?;
    let Some(printer) = open(name, READ_CONTROL)? else {
        return Ok(None);
    };
    let mut needed = 0u32;
    // SAFETY: the handle is open; no buffer: only the size is asked for.
    if let Err(e) = unsafe { GetPrinterW(printer.0, 3, None, &mut needed) } {
        match api_err("GetPrinterW", &e) {
            Win32Error::Api { code: INSUFFICIENT_BUFFER, .. } => {}
            other => return Err(other),
        }
    }
    let mut buffer = aligned(needed as usize);
    let mut again = 0u32;
    // SAFETY: the buffer holds at least `needed` bytes and is 8-byte aligned.
    unsafe { GetPrinterW(printer.0, 3, Some(as_bytes(&mut buffer)), &mut again) }
        .map_err(|e| api_err("GetPrinterW", &e))?;
    // SAFETY: the call wrote one PRINTER_INFO_3 at the start of `buffer`.
    let info = unsafe { &*buffer.as_ptr().cast::<PRINTER_INFO_3>() };
    dacl_sddl_of(info.pSecurityDescriptor).map(Some)
}

/// Replaces the DACL of a queue with `sddl`.
///
/// DESTRUCTIVE: guarded.
pub fn set_security(name: &str, sddl: &str) -> Result<()> {
    check_plain_name(name)?;
    require_test_machine()?;
    let attrs = SecurityAttributes::from_sddl(sddl)?;
    let printer = open(name, PRINTER_ALL_ACCESS.0)?.ok_or(Win32Error::NotFound)?;
    let info = PRINTER_INFO_3 { pSecurityDescriptor: PSECURITY_DESCRIPTOR(attrs.descriptor().0) };
    // SAFETY: the handle is open with full access; `info` points at a valid self-relative
    // descriptor owned by `attrs`, which outlives the call.
    unsafe { SetPrinterW(printer.0, 3, Some(std::ptr::from_ref(&info).cast::<u8>()), 0) }
        .map_err(|e| api_err("SetPrinterW", &e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str) -> PrinterSpec {
        PrinterSpec { name: name.into(), port: "IP_192.168.1.20".into(), driver: "Microsoft IPP Class Driver".into(), comment: "rulebox:k7".into() }
    }

    #[test]
    fn only_rulebox_queues_are_added_or_deleted() {
        assert!(check_spec(&spec("Front desk (Rulebox)")).is_ok());
        for bad in [
            "Front desk",
            " (Rulebox)",
            "Front\\desk (Rulebox)",
            "A,B (Rulebox)",
            "Front desk (rulebox)",
            "",
            "Microsoft Print to PDF",
        ] {
            assert!(matches!(check_spec(&spec(bad)), Err(Win32Error::Forbidden(_))), "{bad}");
            assert!(matches!(delete(bad), Err(Win32Error::Forbidden(_))), "{bad}");
            assert!(matches!(add(&spec(bad)), Err(Win32Error::Forbidden(_))), "{bad}");
        }
        let mut no_port = spec("Front desk (Rulebox)");
        no_port.port = String::new();
        assert!(check_spec(&no_port).is_err());
    }

    #[test]
    fn file_output_ports_are_told_by_port_not_by_name() {
        for port in ["FILE:", "file:", "PORTPROMPT:", "PortPrompt:", "XPSPort:", r"C:\Spool\out.prn", "d:/x/y.prn"] {
            assert!(is_file_output_port(port), "{port}");
        }
        for port in ["IP_192.168.1.20", "WSD-1234", "USB001", "LPT1:", "COM1:", r"\\server\share", "nul:", "", "C:", "https://10.0.0.20:631/ipp/print"] {
            assert!(!is_file_output_port(port), "{port}");
        }
    }

    fn port(name: &str) -> PortSpec {
        PortSpec { name: name.into(), protocol: PortProtocol::RawTcp, host: "10.0.0.20".into(), number: 9100, queue: String::new() }
    }

    #[test]
    fn only_rulebox_ports_are_added_or_deleted() {
        assert!(check_port_spec(&port("Rulebox_k7")).is_ok());
        assert!(check_port_spec(&PortSpec { protocol: PortProtocol::Lpr, queue: "lp".into(), ..port("Rulebox_k7") }).is_ok());
        for bad in ["IP_10.0.0.20", "Rulebox_", "rulebox_k7", "Rulebox_a b", "Rulebox_a,b", "Rulebox_a\\b", &format!("Rulebox_{}", "x".repeat(60))] {
            assert!(matches!(check_port_spec(&port(bad)), Err(Win32Error::Forbidden(_))), "{bad}");
            assert!(matches!(delete_port(bad), Err(Win32Error::Forbidden(_))), "{bad}");
            assert!(matches!(add_port(&port(bad)), Err(Win32Error::Forbidden(_))), "{bad}");
        }
        // Raw needs a port number and no queue; LPR needs a queue; the host is at most 48 characters, no spaces.
        assert!(check_port_spec(&PortSpec { number: 0, ..port("Rulebox_k7") }).is_err());
        assert!(check_port_spec(&PortSpec { queue: "lp".into(), ..port("Rulebox_k7") }).is_err());
        assert!(check_port_spec(&PortSpec { protocol: PortProtocol::Lpr, ..port("Rulebox_k7") }).is_err());
        assert!(check_port_spec(&PortSpec { protocol: PortProtocol::Lpr, queue: "x".repeat(33), ..port("Rulebox_k7") }).is_err());
        assert!(check_port_spec(&PortSpec { host: "a".repeat(49), ..port("Rulebox_k7") }).is_err());
        assert!(check_port_spec(&PortSpec { host: "a b".into(), ..port("Rulebox_k7") }).is_err());
        assert!(check_port_spec(&PortSpec { host: String::new(), ..port("Rulebox_k7") }).is_err());
    }

    #[test]
    fn share_names_are_two_plain_parts() {
        for ok in [r"\\print01\hp", r"\\10.0.0.5\Front desk"] {
            assert!(check_share_name(ok).is_ok(), "{ok}");
        }
        for bad in [r"print01\hp", r"\\print01", r"\\print01\", r"\\\hp", r"\\print01\a\b", r"\\pr int\hp", r"\\print01\a,b", "//print01/hp", ""] {
            assert!(matches!(check_share_name(bad), Err(Win32Error::Forbidden(_))), "{bad}");
            assert!(matches!(connect_share(bad), Err(Win32Error::Forbidden(_))), "{bad}");
            assert!(matches!(disconnect_share(bad), Err(Win32Error::Forbidden(_))), "{bad}");
        }
    }

    #[test]
    fn port_data_has_the_layout_tcpmon_expects() {
        // 128 + 4*4 + 98 (+2) + 66 + 2 + 4 (double spool) + 66 + 32 + 540 + 4*3, with C padding: 950 -> 952 + 12.
        assert_eq!(std::mem::size_of::<PortData1>(), 964);
    }

    #[test]
    fn security_names_are_plain() {
        assert!(matches!(get_security(r"\\server\queue"), Err(Win32Error::Forbidden(_))));
        assert!(matches!(set_security("a/b", "D:P(A;;GA;;;SY)"), Err(Win32Error::Forbidden(_))));
    }

    #[test]
    fn writers_meet_the_guard_on_the_dev_machine() {
        if crate::guard::is_test_machine() {
            return;
        }
        assert!(matches!(add(&spec("Front desk (Rulebox)")), Err(Win32Error::Guard(_))));
        assert!(matches!(delete("Front desk (Rulebox)"), Err(Win32Error::Guard(_))));
        assert!(matches!(set_security("Microsoft Print to PDF", "D:P(A;;GA;;;SY)"), Err(Win32Error::Guard(_))));
        assert!(matches!(add_port(&port("Rulebox_k7")), Err(Win32Error::Guard(_))));
        assert!(matches!(delete_port("Rulebox_k7"), Err(Win32Error::Guard(_))));
        assert!(matches!(connect_share(r"\\print01\hp"), Err(Win32Error::Guard(_))));
        assert!(matches!(disconnect_share(r"\\print01\hp"), Err(Win32Error::Guard(_))));
    }

    /// Reads the real printer list; never writes. Run by hand.
    #[test]
    #[ignore = "reads the real print spooler"]
    fn smoke_list() {
        println!("drivers: {:?}", list_drivers().unwrap());
        println!("ports: {:?}", list_ports().unwrap());
        for printer in list().unwrap() {
            println!("{printer:?}");
            if let Some(sddl) = get_security(&printer.name).unwrap() {
                assert!(sddl.starts_with("D:"), "{sddl}");
            }
        }
    }
}
