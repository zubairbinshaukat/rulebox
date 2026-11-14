//! One unit struct per method on the shell pipe (plan Section 6.6).

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::requests::{
    AdminExitSubmitParams, AdminExitSubmitResult, AppsListResult, BroadcastAckParams, OkResult,
    ReportDenialsParams, SessionGetResult, SignInParams, SignInResult, VerifyPasswordParams,
    VerifyPasswordResult,
};
use crate::types::{AgentSnapshot, HelloParams, HelloResult};

pub trait Method {
    const NAME: &'static str;
    type Params: Serialize + DeserializeOwned;
    type Result: Serialize + DeserializeOwned;
}

/// The JSON object `{}`: params or result of a method that carries nothing.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct Empty {}

/// Event names (agent -> client).
pub mod events {
    pub const STATE_CHANGED: &str = "state.changed";
    pub const AGENT_SHUTTING_DOWN: &str = "agent.shuttingDown";
    /// (1.2) `{}`: the signed-in employee's app list changed; call `apps.list`
    /// again. At most one per 2 seconds.
    pub const APPS_CHANGED: &str = "apps.changed";
    /// (1.2) `SessionEndedData`: the agent ended the employee session itself.
    pub const SESSION_ENDED: &str = "session.ended";
    /// (1.3) `{}`: the device lock was set or cleared; read the snapshot.
    pub const DEVICE_LOCK_CHANGED: &str = "device.lockChanged";
    /// (1.3) `{}`: the broadcast list changed; read the snapshot. At most one per 2 seconds.
    pub const BROADCASTS_CHANGED: &str = "broadcasts.changed";
    /// (1.3) `ProgramBlockedData`: the process watch ended a Staff program. At most once
    /// per program per session.
    pub const PROGRAM_BLOCKED: &str = "program.blocked";
}

/// First request on every connection; triggers peer verification.
pub struct Hello;
impl Method for Hello {
    const NAME: &'static str = "hello";
    type Params = HelloParams;
    type Result = HelloResult;
}

/// The whole state the shell needs, in one call.
pub struct StateGet;
impl Method for StateGet {
    const NAME: &'static str = "state.get";
    type Params = Empty;
    type Result = AgentSnapshot;
}

/// The Staff App's first screen is usable; starts hang detection.
pub struct ShellReady;
impl Method for ShellReady {
    const NAME: &'static str = "shell.ready";
    type Params = Empty;
    type Result = Empty;
}

/// Every 10 seconds after `shell.ready`; 30 seconds of silence means "hung".
pub struct ShellHeartbeat;
impl Method for ShellHeartbeat {
    const NAME: &'static str = "shell.heartbeat";
    type Params = Empty;
    type Result = Empty;
}

/// (1.1, capability `session`) Employee sign-in.
pub struct SessionSignIn;
impl Method for SessionSignIn {
    const NAME: &'static str = "session.signIn";
    type Params = SignInParams;
    type Result = SignInResult;
}

/// (1.1, capability `session`) Ends the employee's Rulebox session.
pub struct SessionSignOut;
impl Method for SessionSignOut {
    const NAME: &'static str = "session.signOut";
    type Params = Empty;
    type Result = Empty;
}

/// (1.1, capability `session`) Who is signed in.
pub struct SessionGet;
impl Method for SessionGet {
    const NAME: &'static str = "session.get";
    type Params = Empty;
    type Result = SessionGetResult;
}

/// (1.1, capability `session`) Re-checks the signed-in employee's password.
pub struct SessionVerifyPassword;
impl Method for SessionVerifyPassword {
    const NAME: &'static str = "session.verifyPassword";
    type Params = VerifyPasswordParams;
    type Result = VerifyPasswordResult;
}

/// (1.1, capability `apps`) The signed-in employee's app catalogue.
pub struct AppsList;
impl Method for AppsList {
    const NAME: &'static str = "apps.list";
    type Params = Empty;
    type Result = AppsListResult;
}

/// (1.1, capability `adminExit`) Submits the hidden-exit PIN.
pub struct AdminExitSubmit;
impl Method for AdminExitSubmit {
    const NAME: &'static str = "adminExit.submit";
    type Params = AdminExitSubmitParams;
    type Result = AdminExitSubmitResult;
}

/// (1.3, capability `broadcasts`) The employee pressed "OK" on a broadcast; the agent
/// queues one acknowledgement.
pub struct BroadcastAcknowledge;
impl Method for BroadcastAcknowledge {
    const NAME: &'static str = "broadcast.acknowledge";
    type Params = BroadcastAckParams;
    type Result = OkResult;
}

/// (1.3, capability `permissionReports`) The Staff App's per-app denial counters.
pub struct WebappReportDenials;
impl Method for WebappReportDenials {
    const NAME: &'static str = "webapp.reportDenials";
    type Params = ReportDenialsParams;
    type Result = OkResult;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_1_3_names_match_the_contract() {
        assert_eq!(BroadcastAcknowledge::NAME, "broadcast.acknowledge");
        assert_eq!(WebappReportDenials::NAME, "webapp.reportDenials");
        assert_eq!(events::DEVICE_LOCK_CHANGED, "device.lockChanged");
        assert_eq!(events::BROADCASTS_CHANGED, "broadcasts.changed");
        assert_eq!(events::PROGRAM_BLOCKED, "program.blocked");
        assert_eq!(crate::CAP_DEVICE_LOCK, "deviceLock");
        assert_eq!(crate::CAP_BROADCASTS, "broadcasts");
        assert_eq!(crate::CAP_KEYBOARD_POLICY, "keyboardPolicy");
        assert_eq!(crate::CAP_PERMISSION_REPORTS, "permissionReports");
        assert_eq!((crate::PROTOCOL_MAJOR, crate::PROTOCOL_MINOR), (1, 3));
    }

    #[test]
    fn empty_is_an_object() {
        assert_eq!(serde_json::to_string(&Empty {}).unwrap(), "{}");
        assert_eq!(serde_json::from_str::<Empty>("{}").unwrap(), Empty {});
    }

    #[test]
    fn method_names_match_the_contract() {
        assert_eq!(Hello::NAME, "hello");
        assert_eq!(StateGet::NAME, "state.get");
        assert_eq!(ShellReady::NAME, "shell.ready");
        assert_eq!(ShellHeartbeat::NAME, "shell.heartbeat");
        assert_eq!(SessionSignIn::NAME, "session.signIn");
        assert_eq!(SessionSignOut::NAME, "session.signOut");
        assert_eq!(SessionGet::NAME, "session.get");
        assert_eq!(SessionVerifyPassword::NAME, "session.verifyPassword");
        assert_eq!(AppsList::NAME, "apps.list");
        assert_eq!(AdminExitSubmit::NAME, "adminExit.submit");
        assert_eq!(events::APPS_CHANGED, "apps.changed");
        assert_eq!(events::SESSION_ENDED, "session.ended");
        assert_eq!(crate::CAP_APPS_CHANGED, "appsChanged");
        assert_eq!(crate::CAP_SESSION_ENDED, "sessionEnded");
    }
}
