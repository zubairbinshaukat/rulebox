//! Read-only process and system figures for the developer resource monitor
//! (debug builds only). Nothing here changes anything; a process that cannot
//! be opened (another user's, a protected one) is listed without figures.

use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX2};
use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows::Win32::System::Threading::{
    GetProcessTimes, GetSystemTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// One running process.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcInfo {
    pub pid: u32,
    pub parent: u32,
    /// The program's file name (`msedgewebview2.exe`).
    pub exe: String,
    /// Private working set in bytes (Task Manager's "Memory" column), when readable.
    pub private_ws: Option<u64>,
    /// Kernel plus user CPU time so far, in 100 ns units, when readable.
    pub cpu_100ns: Option<u64>,
}

/// The system's CPU times since boot, in 100 ns units (kernel includes idle).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SystemTimes {
    pub idle: u64,
    pub kernel: u64,
    pub user: u64,
}

fn ticks(time: FILETIME) -> u64 {
    (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
}

/// Every process, with memory and CPU time where Windows lets us read them.
pub fn processes() -> Vec<ProcInfo> {
    // SAFETY: a process snapshot handle, closed below.
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    // SAFETY: `entry` is a valid out-parameter with its size set.
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok();
    while more {
        let len = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
        let exe = String::from_utf16_lossy(&entry.szExeFile[..len]);
        let (private_ws, cpu_100ns) = figures(entry.th32ProcessID);
        out.push(ProcInfo {
            pid: entry.th32ProcessID,
            parent: entry.th32ParentProcessID,
            exe,
            private_ws,
            cpu_100ns,
        });
        // SAFETY: as above.
        more = unsafe { Process32NextW(snapshot, &mut entry) }.is_ok();
    }
    // SAFETY: the handle came from CreateToolhelp32Snapshot above.
    let _ = unsafe { CloseHandle(snapshot) };
    out
}

/// Private working set and CPU time of one process.
fn figures(pid: u32) -> (Option<u64>, Option<u64>) {
    if pid == 0 {
        return (None, None);
    }
    // SAFETY: a query-only handle, closed below.
    let Ok(process) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
        return (None, None);
    };
    let memory = private_working_set(process);
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: valid handle and out-parameters.
    let cpu = unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) }
        .ok()
        .map(|()| ticks(kernel) + ticks(user));
    // SAFETY: the handle came from OpenProcess above.
    let _ = unsafe { CloseHandle(process) };
    (memory, cpu)
}

fn private_working_set(process: HANDLE) -> Option<u64> {
    let mut counters = PROCESS_MEMORY_COUNTERS_EX2 {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32,
        ..Default::default()
    };
    // SAFETY: the EX2 structure starts with PROCESS_MEMORY_COUNTERS and `cb` says its real size.
    unsafe {
        GetProcessMemoryInfo(
            process,
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX2).cast::<PROCESS_MEMORY_COUNTERS>(),
            counters.cb,
        )
    }
    .ok()
    .map(|()| counters.PrivateWorkingSetSize as u64)
}

/// The system's CPU times, for the overall CPU percentage.
pub fn system_times() -> Option<SystemTimes> {
    let mut idle = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: valid out-parameters.
    unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)) }.ok()?;
    Some(SystemTimes {
        idle: ticks(idle),
        kernel: ticks(kernel),
        user: ticks(user),
    })
}

/// Physical memory: `(total, available)` in bytes.
pub fn memory() -> Option<(u64, u64)> {
    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    // SAFETY: valid out-parameter with its length set.
    unsafe { GlobalMemoryStatusEx(&mut status) }.ok()?;
    Some((status.ullTotalPhys, status.ullAvailPhys))
}

/// Pure: the busy share of the CPU between two readings, 0-100.
pub fn cpu_percent(before: SystemTimes, after: SystemTimes) -> f32 {
    let idle = after.idle.saturating_sub(before.idle);
    let total = after.kernel.saturating_sub(before.kernel) + after.user.saturating_sub(before.user);
    if total == 0 {
        return 0.0;
    }
    (total.saturating_sub(idle) as f64 * 100.0 / total as f64) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_percent_is_the_busy_share() {
        let before = SystemTimes { idle: 0, kernel: 0, user: 0 };
        // Kernel time includes idle: 100 ticks total, 75 idle, so 25 % busy.
        let after = SystemTimes { idle: 75, kernel: 80, user: 20 };
        assert!((cpu_percent(before, after) - 25.0).abs() < 0.01);
        assert_eq!(cpu_percent(after, after), 0.0, "no time passed");
    }

    #[test]
    fn this_process_is_listed_with_figures() {
        let me = std::process::id();
        let list = processes();
        let mine = list.iter().find(|p| p.pid == me).expect("own process listed");
        assert!(mine.private_ws.unwrap_or(0) > 0);
        assert!(mine.cpu_100ns.is_some());
        let (total, available) = memory().expect("memory status");
        assert!(total > available);
        assert!(system_times().is_some());
    }
}
