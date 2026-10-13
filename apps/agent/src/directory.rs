//! The employee directory seam (plan Section 5.9). The agent never talks to an
//! employee backend directly; it asks this trait. Phase 4 puts a Convex-backed
//! implementation here; until then the real agent has [`UnavailableDirectory`].

use std::sync::Arc;

use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use rulebox_ipc::requests::{AppEntry, Employee};

use crate::agent::AgentConfig;
use crate::fixtures;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirectoryAnswer {
    Ok(DirectoryEmployee),
    WrongCredentials,
    Disabled,
    LockedOut { retry_after_ms: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryEmployee {
    pub employee: Employee,
    /// The employee's whole catalogue.
    pub apps: Vec<AppEntry>,
    /// How long offline sign-in stays allowed; 0 = never.
    pub offline_days: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectoryError {
    Unreachable,
    Unavailable,
}

pub trait EmployeeDirectory: Send + Sync + 'static {
    /// False = this build cannot check employees at all. The agent then does not
    /// list the `session` and `apps` capabilities in `hello`.
    fn available(&self) -> bool;

    /// One online check of one username and password. Never retries, never caches.
    /// The caller applies the timeout and the rate limit. `username` is already
    /// normalized (trimmed, lower-cased).
    fn verify<'a>(
        &'a self,
        username: &'a str,
        password: &'a str,
    ) -> BoxFuture<'a, Result<DirectoryAnswer, DirectoryError>>;
}

/// The real agent until Phase 4.
pub struct UnavailableDirectory;

impl EmployeeDirectory for UnavailableDirectory {
    fn available(&self) -> bool {
        false
    }

    fn verify<'a>(
        &'a self,
        _username: &'a str,
        _password: &'a str,
    ) -> BoxFuture<'a, Result<DirectoryAnswer, DirectoryError>> {
        std::future::ready(Err(DirectoryError::Unavailable)).boxed()
    }
}

/// Answers from `fixtures.rs`: the demo employees, password `demo`.
pub struct FixtureDirectory {
    /// `--sim-offline`: every check answers `Unreachable`.
    unreachable: bool,
}

impl FixtureDirectory {
    pub fn new(unreachable: bool) -> Self {
        Self { unreachable }
    }
}

impl EmployeeDirectory for FixtureDirectory {
    fn available(&self) -> bool {
        true
    }

    fn verify<'a>(
        &'a self,
        username: &'a str,
        password: &'a str,
    ) -> BoxFuture<'a, Result<DirectoryAnswer, DirectoryError>> {
        let answer = if self.unreachable {
            Err(DirectoryError::Unreachable)
        } else {
            Ok(fixture_answer(username, password))
        };
        std::future::ready(answer).boxed()
    }
}

fn fixture_answer(username: &str, password: &str) -> DirectoryAnswer {
    let Some(demo) = fixtures::employees().into_iter().find(|e| e.username == username) else {
        return DirectoryAnswer::WrongCredentials;
    };
    if demo.disabled {
        return DirectoryAnswer::Disabled;
    }
    if password != fixtures::DEMO_PASSWORD {
        return DirectoryAnswer::WrongCredentials;
    }
    DirectoryAnswer::Ok(DirectoryEmployee {
        employee: demo.employee,
        apps: fixtures::catalogue(),
        offline_days: demo.offline_days,
    })
}

/// Which directory the agent runs with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectoryChoice {
    Fixture,
    Unavailable,
}

/// The one place that decides whether fixture employees exist (Section 5.9,
/// Section 6.11, README answers table): the simulated agent with `--sim-demo`, or
/// the real agent only when `agent-config.json` has `"fixtureDirectory": true`
/// **and** the test-machine marker is present. Without the marker the setting is
/// ignored and logged. Pure apart from the log lines.
pub fn choose(config: &AgentConfig, is_test_machine: bool, simulate_demo: bool) -> DirectoryChoice {
    if simulate_demo {
        return DirectoryChoice::Fixture;
    }
    match (config.fixture_directory, is_test_machine) {
        (true, true) => {
            tracing::warn!("fixture employee directory is ON (test machine only)");
            DirectoryChoice::Fixture
        }
        (true, false) => {
            tracing::warn!(
                "agent-config.json asks for the fixture employee directory, but this is not a test \
                 machine; ignoring it"
            );
            DirectoryChoice::Unavailable
        }
        (false, _) => DirectoryChoice::Unavailable,
    }
}

/// Builds the directory for a choice. `unreachable` is `--sim-offline`.
pub fn build(choice: DirectoryChoice, unreachable: bool) -> Arc<dyn EmployeeDirectory> {
    match choice {
        DirectoryChoice::Fixture => Arc::new(FixtureDirectory::new(unreachable)),
        DirectoryChoice::Unavailable => Arc::new(UnavailableDirectory),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(fixture_directory: bool) -> AgentConfig {
        AgentConfig { fixture_directory, ..AgentConfig::default() }
    }

    #[test]
    fn choose_follows_the_guard() {
        // Fixture on, test machine: fixture.
        assert_eq!(choose(&config(true), true, false), DirectoryChoice::Fixture);
        // Fixture on, not a test machine: refused.
        assert_eq!(choose(&config(true), false, false), DirectoryChoice::Unavailable);
        // Off: unavailable on a test machine and anywhere else.
        assert_eq!(choose(&config(false), true, false), DirectoryChoice::Unavailable);
        assert_eq!(choose(&config(false), false, false), DirectoryChoice::Unavailable);
        // Simulate demo: fixture.
        assert_eq!(choose(&config(false), false, true), DirectoryChoice::Fixture);
    }

    #[test]
    fn the_default_config_never_asks_for_fixtures() {
        assert!(!AgentConfig::default().fixture_directory);
        let parsed: AgentConfig = serde_json::from_str(r#"{ "fixtureDirectory": true }"#).unwrap();
        assert!(parsed.fixture_directory && parsed.kill_hung_shell);
    }

    #[test]
    fn built_directories_report_availability() {
        assert!(build(DirectoryChoice::Fixture, false).available());
        assert!(!build(DirectoryChoice::Unavailable, false).available());
    }

    #[tokio::test]
    async fn the_fixture_directory_answers_like_the_plan() {
        let directory = FixtureDirectory::new(false);
        match directory.verify("maya", "demo").await {
            Ok(DirectoryAnswer::Ok(found)) => {
                assert_eq!(found.employee.id, "emp_maya");
                assert_eq!(found.offline_days, 7);
                assert_eq!(found.apps.len(), 4);
            }
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(directory.verify("maya", "nope").await, Ok(DirectoryAnswer::WrongCredentials));
        assert_eq!(directory.verify("nobody", "demo").await, Ok(DirectoryAnswer::WrongCredentials));
        assert_eq!(directory.verify("alex", "demo").await, Ok(DirectoryAnswer::Disabled));
        match directory.verify("sam", "demo").await {
            Ok(DirectoryAnswer::Ok(found)) => assert_eq!(found.offline_days, 0),
            other => panic!("unexpected {other:?}"),
        }

        let offline = FixtureDirectory::new(true);
        assert_eq!(offline.verify("maya", "demo").await, Err(DirectoryError::Unreachable));
        assert_eq!(UnavailableDirectory.verify("maya", "demo").await, Err(DirectoryError::Unavailable));
    }
}
