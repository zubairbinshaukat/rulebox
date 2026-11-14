//! A tiny read-only WMI reader (Phase 5 Step 5): one query, a few numeric properties
//! of the first row. It exists for the physical-protection report of plan 4.16
//! (BitLocker `Win32_EncryptableVolume`, TPM `Win32_Tpm`) and changes nothing, so it is
//! not guarded and not on the guard-coverage list.
//!
//! The query text is built by the caller from constants; nothing here takes user input.
//! COM is initialised for the call and left as it was found.

use windows::core::{BSTR, PCWSTR};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoSetProxyBlanket, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    EOAC_NONE, RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE,
};
use windows::Win32::System::Variant::{VariantClear, VARIANT, VT_BOOL, VT_I4, VT_UI1, VT_UI4};
use windows::Win32::System::Wmi::{
    IWbemContext, IWbemLocator, WbemLocator, WBEM_FLAG_FORWARD_ONLY, WBEM_FLAG_RETURN_IMMEDIATELY, WBEM_INFINITE,
};

use crate::error::{Result, Win32Error};

/// `WBEM_E_INVALID_NAMESPACE`: the namespace does not exist (no TPM, BitLocker not installed).
pub const WBEM_E_INVALID_NAMESPACE: u32 = 0x8004_100E;

/// `RPC_C_AUTHN_WINNT` and `RPC_C_AUTHZ_NONE` (the values `CoSetProxyBlanket` takes).
const AUTHN_WINNT: u32 = 10;
const AUTHZ_NONE: u32 = 0;
/// `RPC_E_CHANGED_MODE`: the thread already has COM in another mode; that is fine.
const RPC_E_CHANGED_MODE: i32 = 0x8001_0106_u32 as i32;

pub(crate) fn hr_err(api: &'static str, error: &windows::core::Error) -> Win32Error {
    Win32Error::Api { api, code: error.code().0 as u32 }
}

/// Calls `CoUninitialize` on drop, when this call initialised COM.
struct ComScope(bool);

impl Drop for ComScope {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: balances the successful `CoInitializeEx` of this scope on this thread.
            unsafe { CoUninitialize() };
        }
    }
}

fn number(variant: &VARIANT) -> Option<u32> {
    // SAFETY: `vt` says which member is valid; only plain integer members are read.
    unsafe {
        let inner = &variant.Anonymous.Anonymous;
        match inner.vt {
            VT_I4 => u32::try_from(inner.Anonymous.lVal).ok(),
            VT_UI4 => Some(inner.Anonymous.ulVal),
            VT_UI1 => Some(u32::from(inner.Anonymous.bVal)),
            VT_BOOL => Some(u32::from(inner.Anonymous.boolVal.0 != 0)),
            _ => None,
        }
    }
}

/// (Phase 5 Step 7) Connects to `namespace` on this PC (COM initialised for the call) and
/// hands the services to `work`. The caller decides whether `work` reads or changes
/// anything: this function takes no input from the user and does not guard (a writer
/// that uses it is guarded itself, `applocker::set_policy`).
pub(crate) fn with_services<T>(
    namespace: &str,
    work: impl FnOnce(&windows::Win32::System::Wmi::IWbemServices) -> Result<T>,
) -> Result<T> {
    // SAFETY: COM is initialised on this thread for the scope of the call; every pointer
    // passed below is a live local or a null where the API allows one, and the COM
    // objects are released when they drop.
    unsafe {
        let init = CoInitializeEx(None, COINIT_MULTITHREADED);
        let _scope = if init.is_ok() {
            ComScope(true)
        } else if init.0 == RPC_E_CHANGED_MODE {
            ComScope(false)
        } else {
            return Err(Win32Error::Api { api: "CoInitializeEx", code: init.0 as u32 });
        };
        let locator: IWbemLocator = CoCreateInstance(&WbemLocator, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| hr_err("CoCreateInstance(WbemLocator)", &e))?;
        let services = locator
            .ConnectServer(
                &BSTR::from(namespace),
                &BSTR::new(),
                &BSTR::new(),
                &BSTR::new(),
                0,
                &BSTR::new(),
                None::<&IWbemContext>,
            )
            .map_err(|e| hr_err("IWbemLocator::ConnectServer", &e))?;
        CoSetProxyBlanket(
            &services,
            AUTHN_WINNT,
            AUTHZ_NONE,
            PCWSTR::null(),
            RPC_C_AUTHN_LEVEL_CALL,
            RPC_C_IMP_LEVEL_IMPERSONATE,
            None,
            EOAC_NONE,
        )
        .map_err(|e| hr_err("CoSetProxyBlanket", &e))?;
        work(&services)
    }
}

/// Runs `wql` in `namespace` and returns, for the first row, the numeric value of each
/// property (`None` when it is null or not a number). `Ok(None)`: the query matched no
/// instance. Read-only.
pub fn query_numbers(namespace: &str, wql: &str, properties: &[&str]) -> Result<Option<Vec<Option<u32>>>> {
    // SAFETY: COM is initialised on this thread for the scope of the call; every pointer
    // passed below is a live local or a null where the API allows one, and the COM
    // objects are released when they drop.
    unsafe {
        let init = CoInitializeEx(None, COINIT_MULTITHREADED);
        let _scope = if init.is_ok() {
            ComScope(true)
        } else if init.0 == RPC_E_CHANGED_MODE {
            ComScope(false)
        } else {
            return Err(Win32Error::Api { api: "CoInitializeEx", code: init.0 as u32 });
        };
        let locator: IWbemLocator = CoCreateInstance(&WbemLocator, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| hr_err("CoCreateInstance(WbemLocator)", &e))?;
        let services = locator
            .ConnectServer(
                &BSTR::from(namespace),
                &BSTR::new(),
                &BSTR::new(),
                &BSTR::new(),
                0,
                &BSTR::new(),
                None::<&IWbemContext>,
            )
            .map_err(|e| hr_err("IWbemLocator::ConnectServer", &e))?;
        CoSetProxyBlanket(
            &services,
            AUTHN_WINNT,
            AUTHZ_NONE,
            PCWSTR::null(),
            RPC_C_AUTHN_LEVEL_CALL,
            RPC_C_IMP_LEVEL_IMPERSONATE,
            None,
            EOAC_NONE,
        )
        .map_err(|e| hr_err("CoSetProxyBlanket", &e))?;
        let rows = services
            .ExecQuery(
                &BSTR::from("WQL"),
                &BSTR::from(wql),
                WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY,
                None::<&IWbemContext>,
            )
            .map_err(|e| hr_err("IWbemServices::ExecQuery", &e))?;
        let mut objects = [None];
        let mut returned = 0u32;
        let status = rows.Next(WBEM_INFINITE, &mut objects, &mut returned);
        if status.is_err() {
            return Err(Win32Error::Api { api: "IEnumWbemClassObject::Next", code: status.0 as u32 });
        }
        let Some(Some(object)) = objects.into_iter().next().filter(|_| returned > 0) else {
            return Ok(None);
        };
        let mut values = Vec::with_capacity(properties.len());
        for property in properties {
            let wide: Vec<u16> = property.encode_utf16().chain(std::iter::once(0)).collect();
            let mut variant = VARIANT::default();
            let read = object.Get(PCWSTR(wide.as_ptr()), 0, &mut variant, None, None);
            values.push(if read.is_ok() { number(&variant) } else { None });
            let _ = VariantClear(&mut variant);
        }
        Ok(Some(values))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads the real machine's BitLocker state; never writes. Run by hand.
    #[test]
    #[ignore = "queries WMI on the real machine"]
    fn smoke_bitlocker_query() {
        let result = query_numbers(
            r"ROOT\CIMV2\Security\MicrosoftVolumeEncryption",
            "SELECT ProtectionStatus FROM Win32_EncryptableVolume WHERE DriveLetter = 'C:'",
            &["ProtectionStatus"],
        );
        println!("{result:?}");
    }
}
