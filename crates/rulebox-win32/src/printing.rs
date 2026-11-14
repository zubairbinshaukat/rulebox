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
//! Driver choice and the approved-driver list are the agent's job (Step 14b); `add` only
//! passes the names it is given to Windows, which refuses a driver that is not installed.

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Graphics::Printing::{
    AddPrinterW, ClosePrinter, DeletePrinter, EnumPrintersW, GetPrinterW, OpenPrinterW, SetPrinterW,
    PRINTER_ACCESS_RIGHTS, PRINTER_ALL_ACCESS, PRINTER_DEFAULTSW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL,
    PRINTER_HANDLE, PRINTER_INFO_2W, PRINTER_INFO_3,
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

/// A queue Rulebox is asked to create.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrinterSpec {
    /// `<display name> (Rulebox)`.
    pub name: String,
    /// An existing port (`IP_192.168.1.20`, a WSD or IPP port); creating ports is Step 14b.
    pub port: String,
    pub driver: String,
}

/// One queue as `list` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrinterInfo {
    pub name: String,
    pub port: String,
    pub driver: String,
    pub attributes: u32,
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
        });
    }
    Ok(out)
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
    let info = PRINTER_INFO_2W {
        pPrinterName: PWSTR(name.as_mut_ptr()),
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
        PrinterSpec { name: name.into(), port: "IP_192.168.1.20".into(), driver: "Microsoft IPP Class Driver".into() }
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
    }

    /// Reads the real printer list; never writes. Run by hand.
    #[test]
    #[ignore = "reads the real print spooler"]
    fn smoke_list() {
        for printer in list().unwrap() {
            println!("{printer:?}");
            if let Some(sddl) = get_security(&printer.name).unwrap() {
                assert!(sddl.starts_with("D:"), "{sddl}");
            }
        }
    }
}
