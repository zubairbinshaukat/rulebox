//! Sleep, restart, shut down (plan Step 9) and battery status (plan Step 10).
//!
//! A default standard user may do these when the process token holds
//! `SeShutdownPrivilege`. The Staff App never asks for administrator rights:
//! if the privilege is missing, the three items stay hidden. These functions
//! really do suspend or exit Windows — nothing in the test suite calls
//! [`sleep`], [`restart`] or [`shut_down`].

use std::mem::{size_of, zeroed};

use windows::core::w;
use windows::Win32::Foundation::{CloseHandle, ERROR_NOT_ALL_ASSIGNED, GetLastError, HANDLE, LUID};
use windows::Win32::Security::{
    AdjustTokenPrivileges, GetTokenInformation, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES,
    SE_PRIVILEGE_ENABLED, TOKEN_ACCESS_MASK, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
    TokenPrivileges,
};
use windows::Win32::System::Power::SetSuspendState;
use windows::Win32::System::Shutdown::{
    ExitWindowsEx, EWX_POWEROFF, EWX_REBOOT, EWX_SHUTDOWN, SHUTDOWN_REASON, SHTDN_REASON_FLAG_PLANNED,
    SHTDN_REASON_MAJOR_OTHER, SHTDN_REASON_MINOR_OTHER,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use crate::error::{DesktopError, Result};

/// Enough room for a token's privilege list (a logon token has far fewer).
const PRIV_CAP: usize = 64;

#[repr(C)]
struct PrivBuf {
    count: u32,
    privs: [LUID_AND_ATTRIBUTES; PRIV_CAP],
}

struct OwnedToken(HANDLE);

impl Drop for OwnedToken {
    fn drop(&mut self) {
        // SAFETY: the handle is owned here and closed once.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn open_token(access: TOKEN_ACCESS_MASK) -> Result<OwnedToken> {
    let mut token = HANDLE::default();
    // SAFETY: `token` is an out-handle we take ownership of.
    unsafe {
        OpenProcessToken(GetCurrentProcess(), access, &mut token)
            .map_err(|e| DesktopError::win32("OpenProcessToken", &e))?;
    }
    Ok(OwnedToken(token))
}

fn privilege_luid() -> Result<LUID> {
    let mut luid = LUID::default();
    // SAFETY: `luid` is an out-parameter.
    unsafe {
        LookupPrivilegeValueW(None, w!("SeShutdownPrivilege"), &mut luid)
            .map_err(|e| DesktopError::win32("LookupPrivilegeValueW", &e))?;
    }
    Ok(luid)
}

/// The process token lists `SeShutdownPrivilege` (enabled or not). Enabling
/// it later is not an elevation.
pub fn can_power_off() -> bool {
    match token_has_shutdown_privilege() {
        Ok(present) => present,
        Err(error) => {
            tracing::warn!(%error, "could not read the shutdown privilege");
            false
        }
    }
}

/// The firmware offers a sleep state (S1 to S3, or modern standby). A Hyper-V
/// VM offers none, and `SetSuspendState` then fails with `ERROR_NOT_SUPPORTED`.
pub fn can_sleep() -> bool {
    use windows::Win32::System::Power::{GetPwrCapabilities, SYSTEM_POWER_CAPABILITIES};

    let mut caps = SYSTEM_POWER_CAPABILITIES::default();
    // SAFETY: `caps` is a valid out-parameter of the size the API expects.
    if !unsafe { GetPwrCapabilities(&mut caps) } {
        tracing::warn!("could not read the power capabilities; Sleep stays hidden");
        return false;
    }
    caps.SystemS1 || caps.SystemS2 || caps.SystemS3 || caps.AoAc
}

fn token_has_shutdown_privilege() -> Result<bool> {
    let token = open_token(TOKEN_QUERY)?;
    let wanted = privilege_luid()?;
    // SAFETY: `buf` is zeroed and large enough for the header plus PRIV_CAP
    // entries; the byte length is passed.
    let buf = unsafe {
        let mut buf: PrivBuf = zeroed();
        let mut returned = 0u32;
        GetTokenInformation(
            token.0,
            TokenPrivileges,
            Some(&mut buf as *mut PrivBuf as *mut _),
            size_of::<PrivBuf>() as u32,
            &mut returned,
        )
        .map_err(|e| DesktopError::win32("GetTokenInformation", &e))?;
        buf
    };
    let count = (buf.count as usize).min(PRIV_CAP);
    Ok(buf.privs[..count].iter().any(|entry| entry.Luid == wanted))
}

fn enable_shutdown_privilege() -> Result<()> {
    let token = open_token(TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY)?;
    let luid = privilege_luid()?;
    let privileges = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        Privileges: [LUID_AND_ATTRIBUTES {
            Luid: luid,
            Attributes: SE_PRIVILEGE_ENABLED,
        }],
    };
    // SAFETY: the privilege list is one entry and the token is ours.
    unsafe {
        AdjustTokenPrivileges(token.0, false, Some(&privileges), 0, None, None)
            .map_err(|e| DesktopError::win32("AdjustTokenPrivileges", &e))?;
    }
    // The call returns success even when the privilege was not held.
    let last = unsafe { GetLastError() };
    if last == ERROR_NOT_ALL_ASSIGNED {
        return Err(DesktopError::Refused(
            "this account cannot shut down the PC".into(),
        ));
    }
    Ok(())
}

/// A planned shutdown reason: other / other, flagged as planned.
fn planned_reason() -> SHUTDOWN_REASON {
    SHUTDOWN_REASON(
        SHTDN_REASON_MAJOR_OTHER.0 | SHTDN_REASON_MINOR_OTHER.0 | SHTDN_REASON_FLAG_PLANNED.0,
    )
}

/// Suspend the PC. Does not sign anyone out.
pub fn sleep() -> Result<()> {
    enable_shutdown_privilege()?;
    tracing::info!("suspending the PC");
    // SAFETY: no pointers. Hibernate is false (sleep, not hibernate).
    // The API returns a BOOL rather than a Result.
    if unsafe { SetSuspendState(false, false, false) } {
        Ok(())
    } else {
        let error = windows::core::Error::from_thread();
        Err(DesktopError::win32("SetSuspendState", &error))
    }
}

/// Restart Windows. The caller signs the employee out first when someone is in.
pub fn restart() -> Result<()> {
    enable_shutdown_privilege()?;
    tracing::info!("restarting the PC");
    // SAFETY: no pointers.
    unsafe { ExitWindowsEx(EWX_REBOOT, planned_reason()) }
        .map_err(|e| DesktopError::win32("ExitWindowsEx", &e))
}

/// Shut the PC down.
pub fn shut_down() -> Result<()> {
    enable_shutdown_privilege()?;
    tracing::info!("shutting the PC down");
    // SAFETY: no pointers.
    unsafe { ExitWindowsEx(EWX_SHUTDOWN | EWX_POWEROFF, planned_reason()) }
        .map_err(|e| DesktopError::win32("ExitWindowsEx", &e))
}

/// Battery the shell can show. `None` from [`battery`] means a desktop with
/// no battery, or Windows could not answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Battery {
    pub percent: Option<u8>,
    pub charging: bool,
    /// Minutes of runtime Windows estimates, when it has one.
    pub minutes_left: Option<u32>,
}

/// One line for quick settings. `None` when there is no battery.
///
/// Charging: `"86% · Charging"`. On battery with an estimate:
/// `"On battery · 2 h 10 min left"`.
pub fn battery_text(battery: &Battery) -> Option<String> {
    if battery.charging {
        return Some(match battery.percent {
            Some(percent) => format!("{percent}% · Charging"),
            None => "Charging".to_string(),
        });
    }
    if let Some(minutes) = battery.minutes_left {
        return Some(format!("On battery · {}", format_minutes(minutes)));
    }
    battery
        .percent
        .map(|percent| format!("{percent}% · On battery"))
}

fn format_minutes(minutes: u32) -> String {
    let hours = minutes / 60;
    let mins = minutes % 60;
    if hours == 0 {
        format!("{mins} min left")
    } else {
        format!("{hours} h {mins} min left")
    }
}

/// `GetSystemPowerStatus`. `None` when this PC has no battery.
pub fn battery() -> Option<Battery> {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

    let mut status = SYSTEM_POWER_STATUS::default();
    // SAFETY: `status` is a valid out-parameter.
    if unsafe { GetSystemPowerStatus(&mut status) }.is_err() {
        return None;
    }
    // 128 = no system battery. 255 = unknown.
    if status.BatteryFlag == 128 || status.BatteryFlag == 255 {
        return None;
    }
    let percent = (status.BatteryLifePercent <= 100).then_some(status.BatteryLifePercent);
    let charging = status.BatteryFlag & 8 != 0 || status.ACLineStatus == 1;
    let minutes_left = (status.BatteryLifeTime != u32::MAX).then_some(status.BatteryLifeTime / 60);
    Some(Battery {
        percent,
        charging,
        minutes_left,
    })
}

/// Current brightness, 0–100, if a monitor answered. `None` hides the slider
/// for the session. Uses the physical-monitor API (dxva2): the WMI brightness
/// classes need a large raw-COM surface and are not required once this query
/// fails — the slider stays hidden.
pub fn brightness() -> Option<u8> {
    let monitors = physical_monitors();
    let found = monitors.iter().find_map(read_brightness);
    destroy_monitors(&monitors);
    found
}

/// Set the brightness of every monitor that answered, 0–100.
pub fn set_brightness(percent: u8) -> Result<()> {
    let percent = percent.min(100);
    let monitors = physical_monitors();
    if monitors.is_empty() {
        return Err(DesktopError::Message(
            "no monitor reported a brightness".into(),
        ));
    }
    let mut any = false;
    for monitor in &monitors {
        if let Some((min, _current, max)) = brightness_range(monitor) {
            if max <= min {
                continue;
            }
            let span = max - min;
            let value = min + (u32::from(percent) * span) / 100;
            // SAFETY: `hPhysicalMonitor` came from GetPhysicalMonitorsFromHMONITOR.
            if set_monitor_brightness(monitor, value) {
                any = true;
            }
        }
    }
    destroy_monitors(&monitors);
    if any {
        Ok(())
    } else {
        Err(DesktopError::Message(
            "brightness could not be changed".into(),
        ))
    }
}

fn physical_monitors() -> Vec<windows::Win32::Devices::Display::PHYSICAL_MONITOR> {
    use std::sync::Mutex;

    use windows::Win32::Foundation::LPARAM;
    use windows_core::BOOL;
    use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR};

    let found = Mutex::new(Vec::<isize>::new());
    let ptr = &found as *const Mutex<Vec<isize>>;
    unsafe extern "system" fn each(
        monitor: HMONITOR,
        _hdc: HDC,
        _rect: *mut windows::Win32::Foundation::RECT,
        data: LPARAM,
    ) -> BOOL {
        // SAFETY: `data` is the `Mutex<Vec<isize>>` from `physical_monitors`,
        // and EnumDisplayMonitors calls this before it returns.
        let found = unsafe { &*(data.0 as *const Mutex<Vec<isize>>) };
        if let Ok(mut list) = found.lock() {
            list.push(monitor.0 as isize);
        }
        BOOL(1)
    }
    // SAFETY: `each` only writes into `found`, which outlives the call.
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(each), LPARAM(ptr as isize));
    }
    let handles = found.lock().map(|list| list.clone()).unwrap_or_default();
    let mut out = Vec::new();
    for handle in handles {
        out.extend(monitors_of(handle));
    }
    out
}

fn monitors_of(handle: isize) -> Vec<windows::Win32::Devices::Display::PHYSICAL_MONITOR> {
    use windows::Win32::Devices::Display::{
        GetNumberOfPhysicalMonitorsFromHMONITOR, GetPhysicalMonitorsFromHMONITOR, PHYSICAL_MONITOR,
    };
    use windows::Win32::Graphics::Gdi::HMONITOR;

    let monitor = HMONITOR(handle as *mut _);
    let mut count = 0u32;
    // SAFETY: `monitor` was just enumerated.
    if unsafe { GetNumberOfPhysicalMonitorsFromHMONITOR(monitor, &mut count) }.is_err()
        || count == 0
        || count > 16
    {
        return Vec::new();
    }
    let mut buf = vec![PHYSICAL_MONITOR::default(); count as usize];
    // SAFETY: `buf` has `count` slots.
    if unsafe { GetPhysicalMonitorsFromHMONITOR(monitor, &mut buf) }.is_err() {
        return Vec::new();
    }
    buf
}

fn brightness_range(
    monitor: &windows::Win32::Devices::Display::PHYSICAL_MONITOR,
) -> Option<(u32, u32, u32)> {
    use windows::Win32::Devices::Display::GetMonitorBrightness;

    let mut min = 0u32;
    let mut current = 0u32;
    let mut max = 0u32;
    // SAFETY: the handle is owned by `physical_monitors` until destroy.
    let ok = unsafe {
        GetMonitorBrightness(
            monitor.hPhysicalMonitor,
            &mut min,
            &mut current,
            &mut max,
        )
    };
    if ok == 0 || max <= min {
        return None;
    }
    Some((min, current, max))
}

fn read_brightness(monitor: &windows::Win32::Devices::Display::PHYSICAL_MONITOR) -> Option<u8> {
    let (min, current, max) = brightness_range(monitor)?;
    let span = max - min;
    let pct = ((current.saturating_sub(min)) * 100) / span;
    Some(pct.min(100) as u8)
}

fn set_monitor_brightness(
    monitor: &windows::Win32::Devices::Display::PHYSICAL_MONITOR,
    value: u32,
) -> bool {
    use windows::Win32::Devices::Display::SetMonitorBrightness;
    // SAFETY: the handle is owned until `destroy_monitors`.
    unsafe { SetMonitorBrightness(monitor.hPhysicalMonitor, value) != 0 }
}

fn destroy_monitors(monitors: &[windows::Win32::Devices::Display::PHYSICAL_MONITOR]) {
    use windows::Win32::Devices::Display::DestroyPhysicalMonitors;
    if monitors.is_empty() {
        return;
    }
    // SAFETY: each handle was returned by GetPhysicalMonitorsFromHMONITOR and
    // is destroyed once.
    let _ = unsafe { DestroyPhysicalMonitors(monitors) };
}

#[cfg(test)]
mod battery_tests {
    use super::*;

    #[test]
    fn battery_text_matches_the_three_cases() {
        assert_eq!(
            battery_text(&Battery {
                percent: Some(86),
                charging: true,
                minutes_left: None,
            })
            .as_deref(),
            Some("86% · Charging")
        );
        assert_eq!(
            battery_text(&Battery {
                percent: Some(40),
                charging: false,
                minutes_left: Some(130),
            })
            .as_deref(),
            Some("On battery · 2 h 10 min left")
        );
        assert_eq!(
            battery_text(&Battery {
                percent: None,
                charging: false,
                minutes_left: None,
            })
            .as_deref(),
            None
        );
    }
}
