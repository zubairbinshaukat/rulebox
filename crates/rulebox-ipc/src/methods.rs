//! One unit struct per method on the shell pipe (plan Section 6.6).

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

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

#[cfg(test)]
mod tests {
    use super::*;

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
    }
}
