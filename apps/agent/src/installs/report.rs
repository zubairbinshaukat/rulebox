//! What the server is told about installs (plan 4.8 "Reporting", amended by A12):
//! per app, only `pending` (the agent took the job) and the terminal states
//! (`installed`, `failed`, `removed`, `unsupported`). `downloading`,
//! `installing` and `removing` stay local (the agent log).
//!
//! The last result of each app is kept in `installs.json` (`reported`) with
//! `acked` until the report queue says the server took exactly that result, so a
//! restart or a long time offline sends the unacknowledged ones again, never the
//! acknowledged ones.

use crate::backend::{InstallReport, InstallState};

use super::engine::{InstallRecord, LocalState};
use super::Detail;

/// The wire state of a local state, `None` for one that stays local.
pub fn wire_state(state: LocalState) -> Option<InstallState> {
    match state {
        LocalState::Pending => Some(InstallState::Pending),
        LocalState::Installed => Some(InstallState::Installed),
        LocalState::Failed => Some(InstallState::Failed),
        LocalState::Removed => Some(InstallState::Removed),
        LocalState::Unsupported => Some(InstallState::Unsupported),
        LocalState::Downloading | LocalState::Installing | LocalState::Removing => None,
    }
}

/// The result `record` stands for, when its state is one that is reported. The
/// detail is re-checked against the fixed list (a hand-edited file cannot send
/// another text).
///
/// (Phase 6 Step 11, plan 4.6) **An upgrade of an installed app reports terminal states only:** an
/// `update` record is never `pending` (the app works the whole time), so nothing goes out until it ends
/// as `installed` or `failed` (or waits, which is `installed` with the detail `waiting_for_close`).
///
/// `installedVersion` (plan 4.4.1): the version the PC has, sent with `installed` and with a `failed`
/// update whose old version still works. A failed update whose old version no longer works clears it
/// (`null`): the PC does not have a known version of the app. Anything else leaves it alone (absent).
pub fn report_of(record: &InstallRecord) -> Option<InstallReport> {
    if record.update && record.state == LocalState::Pending {
        return None;
    }
    let installed_version = match record.state {
        LocalState::Installed => record.installed_version.clone().map(Some),
        LocalState::Failed if record.update && record.old_works => record.installed_version.clone().map(Some),
        LocalState::Failed if record.update => Some(None),
        _ => None,
    };
    Some(InstallReport {
        app_id: record.app_id.clone(),
        state: wire_state(record.state)?,
        app_revision: record.revision,
        attempts: record.attempts,
        exit_code: record.last_exit_code,
        detail: record.detail.as_deref().and_then(Detail::parse).map(|d| d.as_str().to_string()),
        installed_version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::installs::engine::RecordKind;

    fn record(state: LocalState) -> InstallRecord {
        InstallRecord::new("app1", RecordKind::Msi, &"a".repeat(64), 3, state)
    }

    #[test]
    fn only_accepted_and_terminal_states_are_reported() {
        for (state, wire) in [
            (LocalState::Pending, Some(InstallState::Pending)),
            (LocalState::Installed, Some(InstallState::Installed)),
            (LocalState::Failed, Some(InstallState::Failed)),
            (LocalState::Removed, Some(InstallState::Removed)),
            (LocalState::Unsupported, Some(InstallState::Unsupported)),
            (LocalState::Downloading, None),
            (LocalState::Installing, None),
            (LocalState::Removing, None),
        ] {
            assert_eq!(report_of(&record(state)).map(|r| r.state), wire, "{state:?}");
        }
        let mut failed = record(LocalState::Failed);
        failed.attempts = 2;
        failed.last_exit_code = Some(1603);
        failed.detail = Some("exit_code".into());
        let report = report_of(&failed).unwrap();
        assert_eq!((report.app_revision, report.attempts, report.exit_code), (3, 2, Some(1603)));
        assert_eq!(report.detail.as_deref(), Some("exit_code"));
        // A detail that is not one of the server's texts never leaves the PC.
        failed.detail = Some("C:\\secret path".into());
        assert_eq!(report_of(&failed).unwrap().detail, None);
    }

    #[test]
    fn an_upgrade_of_an_installed_app_reports_terminal_states_only() {
        // The app works the whole time: no `pending`, however the record is passing through.
        let mut updating = record(LocalState::Pending);
        updating.update = true;
        assert_eq!(report_of(&updating), None);
        for state in [LocalState::Downloading, LocalState::Installing] {
            updating.state = state;
            assert_eq!(report_of(&updating), None, "{state:?}");
        }
        // Terminal states go out: installed (also while waiting, with the detail), failed.
        updating.state = LocalState::Installed;
        updating.detail = Some("waiting_for_close".into());
        let waiting = report_of(&updating).unwrap();
        assert_eq!((waiting.state, waiting.detail.as_deref()), (InstallState::Installed, Some("waiting_for_close")));
        updating.state = LocalState::Failed;
        assert_eq!(report_of(&updating).unwrap().state, InstallState::Failed);
        // A first install still reports `pending`.
        assert_eq!(report_of(&record(LocalState::Pending)).unwrap().state, InstallState::Pending);
    }

    #[test]
    fn the_installed_version_is_sent_when_it_is_known_and_cleared_when_it_is_not() {
        let mut installed = record(LocalState::Installed);
        // Unknown: absent, the server keeps what it has.
        assert_eq!(report_of(&installed).unwrap().installed_version, None);
        installed.installed_version = Some("2.4.0.0".into());
        assert_eq!(report_of(&installed).unwrap().installed_version, Some(Some("2.4.0.0".to_string())));
        // A failed update whose old version still works keeps reporting it ...
        let mut failed = record(LocalState::Failed);
        failed.update = true;
        failed.old_works = true;
        failed.installed_version = Some("1.0.0.0".into());
        assert_eq!(report_of(&failed).unwrap().installed_version, Some(Some("1.0.0.0".to_string())));
        // ... one that broke the old version clears it (`null`: the PC has no known version).
        failed.old_works = false;
        assert_eq!(report_of(&failed).unwrap().installed_version, Some(None));
        // A failed first install, a removal and `unsupported` say nothing about it.
        for state in [LocalState::Failed, LocalState::Removed, LocalState::Unsupported, LocalState::Pending] {
            let mut other = record(state);
            other.installed_version = Some("9.9".into());
            assert_eq!(report_of(&other).unwrap().installed_version, None, "{state:?}");
        }
    }
}
