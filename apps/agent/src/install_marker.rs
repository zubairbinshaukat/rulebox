//! The install marker `HKLM\SOFTWARE\Rulebox\Install` as the agent keeps it (Phase 6 Step 8,
//! plan 4.10 and 4.11).
//!
//! The MSI writes `InstallDir` and `Version`. Two more values are the agent's:
//!
//! - **`ComputerName`**: this computer's name. The production guard compares it with the computer
//!   it runs on, so a disk image copied to another PC does not arm itself. Written **at every
//!   service start**, before the data directory check (which already needs the armed guard), and
//!   only when the value is missing: a name that is there, even another PC's, is never overwritten.
//!   A major upgrade deletes the whole key, which is why "missing" happens again.
//! - **`KioskOn`**: a DWORD, 1 while the kiosk is on, 0 otherwise. The MSI's uninstall guard reads
//!   it ("Turn kiosk mode off first"). Written at every start, then again whenever the kiosk
//!   switches on or off, and only when the value differs from what the registry holds. "On" is
//!   what `service uninstall` calls "the kiosk is applied" (`kiosk::has_kiosk_changes`), so both
//!   uninstall paths refuse in the same cases.
//!
//! The marker key must already exist: a PC without the MSI (the dev machine, a VM) is left alone and
//! nothing is created. Both writes go through the `Platform` seam
//! (`write_install_marker`), which has the marker guard of `rulebox_win32::guard`.

use std::sync::Arc;

use rulebox_ipc::types::AgentSnapshot;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::kiosk::has_kiosk_changes;
use crate::platform::{InstallMarkerValue, Platform, RegData, RegValueRef};
use crate::state::SharedState;

fn marker_value(name: &str) -> RegValueRef {
    RegValueRef { path: rulebox_win32::guard::INSTALL_KEY.to_string(), name: name.to_string() }
}

/// Whether the MSI's marker is there (its `InstallDir` is what created the key).
fn marker_exists(platform: &dyn Platform) -> Result<bool, String> {
    match platform.read_machine_value(&marker_value(rulebox_win32::guard::INSTALL_DIR_VALUE)) {
        Ok(Some(RegData::String(dir))) => Ok(!dir.trim().is_empty()),
        Ok(_) => Ok(false),
        Err(error) => Err(format!("cannot read the install marker ({error})")),
    }
}

/// What the `ComputerName` step found or did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NameOutcome {
    /// No `Install` key (no MSI): nothing to do.
    NoMarker,
    /// It already names this computer.
    AlreadySet,
    /// It was missing and now names this computer.
    Written,
    /// It names another computer (a copied disk): left alone, so the production guard stays closed
    /// here. Uninstalling and installing Rulebox again clears the key.
    NamesAnotherPc { marker: String },
    Failed(String),
}

impl NameOutcome {
    /// Logs what happened (the log does not exist yet when the step runs, so the service calls
    /// this after it started logging).
    pub fn log(&self) {
        match self {
            NameOutcome::NoMarker => tracing::debug!("no install marker (no MSI on this PC); ComputerName not written"),
            NameOutcome::AlreadySet => tracing::debug!("the install marker already names this computer"),
            NameOutcome::Written => tracing::info!("the install marker now names this computer"),
            NameOutcome::NamesAnotherPc { marker } => tracing::error!(
                marker = %marker,
                "the install marker names another computer (a copied disk?); it was not changed and the production guard stays closed"
            ),
            NameOutcome::Failed(why) => tracing::error!("cannot write the install marker's ComputerName: {why}"),
        }
    }
}

/// Makes sure `Install\ComputerName` names this computer. Called first in the service start path.
pub fn assert_computer_name(platform: &dyn Platform) -> NameOutcome {
    match marker_exists(platform) {
        Ok(true) => {}
        Ok(false) => return NameOutcome::NoMarker,
        Err(why) => return NameOutcome::Failed(why),
    }
    let computer = match platform.computer_name() {
        Ok(name) if !name.trim().is_empty() => name,
        Ok(_) => return NameOutcome::Failed("this computer has no name".to_string()),
        Err(error) => return NameOutcome::Failed(format!("cannot read the computer name ({error})")),
    };
    match platform.read_machine_value(&marker_value(rulebox_win32::guard::INSTALL_COMPUTER_VALUE)) {
        Ok(Some(RegData::String(marker))) if !marker.trim().is_empty() => {
            return if marker.eq_ignore_ascii_case(&computer) { NameOutcome::AlreadySet } else { NameOutcome::NamesAnotherPc { marker } };
        }
        // Missing, empty or not text: written below.
        Ok(_) => {}
        Err(error) => return NameOutcome::Failed(format!("cannot read the install marker ({error})")),
    }
    match platform.write_install_marker(&InstallMarkerValue::ComputerName(computer)) {
        Ok(true) => NameOutcome::Written,
        // The key vanished between the read and the write.
        Ok(false) => NameOutcome::NoMarker,
        Err(error) => NameOutcome::Failed(error.to_string()),
    }
}

/// What one `KioskOn` sync did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KioskSync {
    NoMarker,
    /// The registry already says so: nothing was written.
    Unchanged,
    Written,
    Failed(String),
}

/// Makes `Install\KioskOn` say `on`, writing only when it differs (or is missing).
pub fn sync_kiosk_on(platform: &dyn Platform, on: bool) -> KioskSync {
    match marker_exists(platform) {
        Ok(true) => {}
        Ok(false) => return KioskSync::NoMarker,
        Err(why) => return KioskSync::Failed(why),
    }
    match platform.read_machine_value(&marker_value(rulebox_win32::installmarker::KIOSK_ON_VALUE)) {
        Ok(Some(RegData::Dword(value))) if value == u32::from(on) => return KioskSync::Unchanged,
        Ok(_) => {}
        Err(error) => return KioskSync::Failed(format!("cannot read KioskOn ({error})")),
    }
    match platform.write_install_marker(&InstallMarkerValue::KioskOn(on)) {
        Ok(true) => KioskSync::Written,
        Ok(false) => KioskSync::NoMarker,
        Err(error) => KioskSync::Failed(error.to_string()),
    }
}

/// The agent task that keeps `KioskOn` right: once at start (so a major upgrade's wiped key is
/// filled again), then whenever the snapshot changes (the kiosk switching on or off changes it),
/// writing only on a change. Ends when there is no marker, or at shutdown.
pub async fn run_kiosk_marker(
    platform: Arc<dyn Platform>,
    shared: Arc<SharedState>,
    mut snapshot_rx: watch::Receiver<AgentSnapshot>,
    shutdown: CancellationToken,
) {
    let mut last: Option<bool> = None;
    loop {
        let on = shared.read(has_kiosk_changes);
        if last != Some(on) {
            match sync_kiosk_on(platform.as_ref(), on) {
                KioskSync::NoMarker => {
                    tracing::debug!("no install marker (no MSI on this PC); KioskOn is not kept");
                    return;
                }
                KioskSync::Unchanged => last = Some(on),
                KioskSync::Written => {
                    tracing::info!(on, "the install marker's KioskOn was updated");
                    last = Some(on);
                }
                // Tried again at the next change.
                KioskSync::Failed(why) => tracing::warn!("cannot update the install marker's KioskOn: {why}"),
            }
        }
        tokio::select! {
            () = shutdown.cancelled() => return,
            changed = snapshot_rx.changed() => {
                if changed.is_err() {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::sim::{SimOp, SimPlatform};
    use crate::platform::PlatformError;
    use crate::state::{AgentState, KioskApplied, StateStore};
    use crate::testutil::TempDir;

    const NAME: &str = "ComputerName";
    const KIOSK: &str = "KioskOn";

    fn machine(with_marker: bool) -> (TempDir, SimPlatform) {
        let dir = TempDir::new();
        let sim = SimPlatform::new(dir.path().to_path_buf());
        if with_marker {
            msi_installs(&sim);
        }
        (dir, sim)
    }

    /// What the MSI leaves: the key with `InstallDir` and `Version`, and nothing else.
    fn msi_installs(sim: &SimPlatform) {
        sim.with_world(|world| {
            world.machine_values.retain(|key, _| !key.path.eq_ignore_ascii_case(rulebox_win32::guard::INSTALL_KEY));
            for (name, value) in [("InstallDir", r"C:\Program Files\Rulebox\"), ("Version", "1.2.3")] {
                world.machine_values.insert(marker_value(name), RegData::String(value.into()));
            }
        });
    }

    fn value(sim: &SimPlatform, name: &str) -> Option<RegData> {
        sim.with_world(|world| world.machine_values.get(&marker_value(name)).cloned())
    }

    fn writes(sim: &SimPlatform) -> usize {
        sim.calls().iter().filter(|op| **op == SimOp::WriteInstallMarker).count()
    }

    #[test]
    fn the_first_start_writes_this_computers_name() {
        let (_dir, sim) = machine(true);
        assert_eq!(assert_computer_name(&sim), NameOutcome::Written);
        assert_eq!(value(&sim, NAME), Some(RegData::String("SIM-PC".into())));
        // The MSI's own values are untouched.
        assert_eq!(value(&sim, "Version"), Some(RegData::String("1.2.3".into())));
    }

    #[test]
    fn a_name_that_is_there_is_not_written_again() {
        let (_dir, sim) = machine(true);
        assert_eq!(assert_computer_name(&sim), NameOutcome::Written);
        assert_eq!(assert_computer_name(&sim), NameOutcome::AlreadySet);
        // Case does not matter, as in the guard.
        sim.with_world(|world| world.machine_values.insert(marker_value(NAME), RegData::String("sim-pc".into())));
        assert_eq!(assert_computer_name(&sim), NameOutcome::AlreadySet);
        assert_eq!(writes(&sim), 1, "one write in three starts");
    }

    #[test]
    fn a_major_upgrade_wipes_the_key_and_the_next_start_writes_the_name_again() {
        let (_dir, sim) = machine(true);
        assert_eq!(assert_computer_name(&sim), NameOutcome::Written);
        // The MSI removes the old product (the whole key) and installs the new one (InstallDir, Version).
        msi_installs(&sim);
        assert_eq!(value(&sim, NAME), None);
        assert_eq!(assert_computer_name(&sim), NameOutcome::Written);
        assert_eq!(value(&sim, NAME), Some(RegData::String("SIM-PC".into())));
        assert_eq!(writes(&sim), 2);
    }

    #[test]
    fn another_pcs_name_is_never_overwritten() {
        let (_dir, sim) = machine(true);
        sim.with_world(|world| world.machine_values.insert(marker_value(NAME), RegData::String("OTHER-PC".into())));
        assert_eq!(assert_computer_name(&sim), NameOutcome::NamesAnotherPc { marker: "OTHER-PC".into() });
        assert_eq!(value(&sim, NAME), Some(RegData::String("OTHER-PC".into())));
        assert_eq!(writes(&sim), 0);
        // An empty name counts as missing.
        sim.with_world(|world| world.machine_values.insert(marker_value(NAME), RegData::String("  ".into())));
        assert_eq!(assert_computer_name(&sim), NameOutcome::Written);
    }

    #[test]
    fn a_pc_without_the_msi_is_left_alone() {
        let (_dir, sim) = machine(false);
        assert_eq!(assert_computer_name(&sim), NameOutcome::NoMarker);
        assert_eq!(sync_kiosk_on(&sim, true), KioskSync::NoMarker);
        assert_eq!(writes(&sim), 0, "no write was even tried");
        assert!(sim.with_world(|world| world.machine_values.keys().all(|key| !key.path.contains("Rulebox"))), "nothing was created");
        // An empty InstallDir is no marker either.
        sim.with_world(|world| world.machine_values.insert(marker_value("InstallDir"), RegData::String(" ".into())));
        assert_eq!(assert_computer_name(&sim), NameOutcome::NoMarker);
    }

    #[test]
    fn failed_reads_and_writes_are_reported_not_hidden() {
        let (_dir, sim) = machine(true);
        sim.fail_next(SimOp::WriteInstallMarker, PlatformError::AccessDenied);
        assert!(matches!(assert_computer_name(&sim), NameOutcome::Failed(_)));
        assert_eq!(value(&sim, NAME), None);
        // And the next start tries again.
        assert_eq!(assert_computer_name(&sim), NameOutcome::Written);
        sim.fail_next(SimOp::ComputerName, PlatformError::AccessDenied);
        sim.with_world(|world| world.machine_values.remove(&marker_value(NAME)));
        assert!(matches!(assert_computer_name(&sim), NameOutcome::Failed(_)));
        sim.fail_next(SimOp::ReadMachineValue, PlatformError::AccessDenied);
        assert!(matches!(assert_computer_name(&sim), NameOutcome::Failed(_)));
    }

    #[test]
    fn kiosk_on_is_a_dword_written_only_when_it_differs() {
        let (_dir, sim) = machine(true);
        // The MSI wrote no KioskOn: the first sync creates it, as 0 for "off".
        assert_eq!(sync_kiosk_on(&sim, false), KioskSync::Written);
        assert_eq!(value(&sim, KIOSK), Some(RegData::Dword(0)));
        assert_eq!(sync_kiosk_on(&sim, false), KioskSync::Unchanged);
        assert_eq!(sync_kiosk_on(&sim, true), KioskSync::Written);
        assert_eq!(value(&sim, KIOSK), Some(RegData::Dword(1)));
        assert_eq!(sync_kiosk_on(&sim, true), KioskSync::Unchanged);
        assert_eq!(writes(&sim), 2);
        // A wiped key (major upgrade) is filled again, with the right value, at the next start.
        msi_installs(&sim);
        assert_eq!(sync_kiosk_on(&sim, true), KioskSync::Written);
        assert_eq!(value(&sim, KIOSK), Some(RegData::Dword(1)));
        // A value of the wrong type or number is put right.
        sim.with_world(|world| world.machine_values.insert(marker_value(KIOSK), RegData::String("1".into())));
        assert_eq!(sync_kiosk_on(&sim, true), KioskSync::Written);
        sim.with_world(|world| world.machine_values.insert(marker_value(KIOSK), RegData::Dword(7)));
        assert_eq!(sync_kiosk_on(&sim, true), KioskSync::Written);
        assert_eq!(value(&sim, KIOSK), Some(RegData::Dword(1)));
    }

    #[test]
    fn what_the_msi_reads_is_what_the_agent_writes() {
        // Checks.wxs searches this key and value raw and compares with "1" and "#1".
        let checks = include_str!("../../installer/Checks.wxs");
        assert!(checks.contains(r#"Key="SOFTWARE\Rulebox\Install" Name="KioskOn" Type="raw""#));
        assert!(checks.contains("#1"));
        assert_eq!(rulebox_win32::installmarker::KIOSK_ON_VALUE, KIOSK);
        assert_eq!(rulebox_win32::guard::INSTALL_COMPUTER_VALUE, NAME);
    }

    fn rig(dir: &TempDir, sim: &Arc<SimPlatform>) -> (Arc<dyn Platform>, Arc<SharedState>, watch::Sender<AgentSnapshot>, CancellationToken) {
        let platform: Arc<dyn Platform> = Arc::clone(sim) as Arc<dyn Platform>;
        let store = StateStore::open(&dir.path().join("state")).unwrap();
        let shared = SharedState::new(store, AgentState::default(), Arc::clone(&platform));
        let (tx, _rx) = watch::channel(crate::testutil::test_snapshot());
        (platform, shared, tx, CancellationToken::new())
    }

    async fn until(mut condition: impl FnMut() -> bool) {
        for _ in 0..10_000 {
            if condition() {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("the condition never held");
    }

    #[tokio::test(start_paused = true)]
    async fn the_task_fills_kiosk_on_at_start_and_follows_the_kiosk() {
        let (dir, sim) = machine(true);
        let sim = Arc::new(sim);
        let (platform, shared, tx, shutdown) = rig(&dir, &sim);
        let read = {
            let platform = Arc::clone(&platform);
            move || platform.read_machine_value(&marker_value(KIOSK)).unwrap()
        };
        let task = tokio::spawn(run_kiosk_marker(Arc::clone(&platform), Arc::clone(&shared), tx.subscribe(), shutdown.clone()));
        until(|| read() == Some(RegData::Dword(0))).await;
        // The kiosk is switched on: the state changes, the snapshot is sent.
        shared.update(|state| state.kiosk.applied = KioskApplied::Enabled).unwrap();
        tx.send_modify(|snapshot| snapshot.kiosk.enabled = true);
        until(|| read() == Some(RegData::Dword(1))).await;
        // And off again.
        shared.update(|state| state.kiosk.applied = KioskApplied::Disabled).unwrap();
        tx.send_modify(|snapshot| snapshot.kiosk.enabled = false);
        until(|| read() == Some(RegData::Dword(0))).await;
        shutdown.cancel();
        task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn the_task_writes_only_on_a_change_and_ends_without_a_marker() {
        let (dir, sim) = machine(true);
        let sim = Arc::new(sim);
        let (platform, shared, tx, shutdown) = rig(&dir, &sim);
        let task = tokio::spawn(run_kiosk_marker(Arc::clone(&platform), Arc::clone(&shared), tx.subscribe(), shutdown.clone()));
        for _ in 0..20 {
            // Snapshot changes that are not about the kiosk wake the task but write nothing.
            tx.send_modify(|snapshot| snapshot.agent_version.push('x'));
            tokio::task::yield_now().await;
        }
        shutdown.cancel();
        task.await.unwrap();
        assert_eq!(platform.read_machine_value(&marker_value(KIOSK)).unwrap(), Some(RegData::Dword(0)));
        assert_eq!(writes(&sim), 1, "written once at start, never again while nothing changed");

        // No MSI: the task ends at once and writes nothing.
        let (dir, sim) = machine(false);
        let sim = Arc::new(sim);
        let (platform, shared, tx, shutdown) = rig(&dir, &sim);
        run_kiosk_marker(Arc::clone(&platform), shared, tx.subscribe(), shutdown).await;
        assert_eq!(platform.read_machine_value(&marker_value(KIOSK)).unwrap(), None);
        assert_eq!(writes(&sim), 0);
    }
}
