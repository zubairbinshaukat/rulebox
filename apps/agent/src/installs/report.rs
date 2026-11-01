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
pub fn report_of(record: &InstallRecord) -> Option<InstallReport> {
    Some(InstallReport {
        app_id: record.app_id.clone(),
        state: wire_state(record.state)?,
        app_revision: record.revision,
        attempts: record.attempts,
        exit_code: record.last_exit_code,
        detail: record.detail.as_deref().and_then(Detail::parse).map(|d| d.as_str().to_string()),
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
}
