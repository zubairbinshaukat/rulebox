//! The employee directory seam (plan Section 5.9). The agent never talks to an
//! employee backend directly; it asks this trait. (Phase 4 Step 13) The real
//! agent has [`ConvexDirectory`] (`deviceApi:verifyEmployee`); `--sim-demo` has
//! the fixture employees.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use rulebox_ipc::requests::{AppEntry, Employee};
use tokio::sync::watch;

use crate::agent_policy::AgentPolicy;
use crate::backend::{BackendError, BackendLink, VerifyAnswer, CODE_DEVICE_REJECTED};
use crate::catalog::AppResolver;
use crate::fixtures;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirectoryAnswer {
    Ok(DirectoryEmployee),
    WrongCredentials,
    Disabled,
    LockedOut { retry_after_ms: u64 },
    /// (Step 13) The password is right but the employee is not in this PC's group.
    NotAllowedHere,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryEmployee {
    pub employee: Employee,
    /// What the employee sees on this PC.
    pub apps: Vec<AppEntry>,
    /// How long offline sign-in stays allowed; 0 = never.
    pub offline_days: u32,
    /// (Step 13) The server's `credentialRevision` (0 from the fixtures): the
    /// offline cache entry is dropped when the signed roster names another one.
    pub credential_revision: u64,
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

    /// (Step 13) The employee's apps from the current signed catalogue, or `None`
    /// when this directory has no catalogue (the session keeps the apps it got
    /// at sign-in).
    fn apps_for(&self, _employee_id: &str) -> Option<Vec<AppEntry>> {
        None
    }

    /// (Step 13) Offline sign-in and the cached employees follow the device's
    /// signed roster (`roster.rs`). False for the fixtures, which have none.
    fn uses_roster(&self) -> bool {
        false
    }
}

/// No employees at all (tests).
#[cfg(test)]
pub struct UnavailableDirectory;

#[cfg(test)]
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
        credential_revision: 0,
    })
}

/// (Phase 4 Step 13) The real directory: `deviceApi:verifyEmployee` through the
/// backend link, and the employee's apps from the current signed catalogue.
pub struct ConvexDirectory {
    link: Arc<BackendLink>,
    policy_rx: watch::Receiver<AgentPolicy>,
    resolver: AppResolver,
}

impl ConvexDirectory {
    pub fn new(link: Arc<BackendLink>, policy_rx: watch::Receiver<AgentPolicy>, resolver: AppResolver) -> Self {
        Self { link, policy_rx, resolver }
    }

    fn apps(&self, employee_id: &str) -> Vec<AppEntry> {
        // Cloned out of the channel: the resolver touches the disk.
        let catalog = self.policy_rx.borrow().catalog.clone();
        self.resolver.visible(&catalog, employee_id)
    }
}

/// How a backend answer maps to the directory (Step 13 item 4).
pub fn map_verify(answer: Result<VerifyAnswer, BackendError>) -> Result<VerifyMapped, DirectoryError> {
    match answer {
        Ok(VerifyAnswer::Ok { employee, offline_days, credential_revision }) => {
            Ok(VerifyMapped::Ok { employee, offline_days, credential_revision })
        }
        Ok(VerifyAnswer::WrongCredentials) => Ok(VerifyMapped::Answer(DirectoryAnswer::WrongCredentials)),
        Ok(VerifyAnswer::Disabled) => Ok(VerifyMapped::Answer(DirectoryAnswer::Disabled)),
        Ok(VerifyAnswer::NotAllowedHere) => Ok(VerifyMapped::Answer(DirectoryAnswer::NotAllowedHere)),
        Ok(VerifyAnswer::LockedOut { retry_after_ms }) => {
            Ok(VerifyMapped::Answer(DirectoryAnswer::LockedOut { retry_after_ms }))
        }
        // The device itself is refused (revoked, wrong secret): the subscription
        // decides what that means; this check cannot be made.
        Err(BackendError::Rejected { code }) if code == CODE_DEVICE_REJECTED => Err(DirectoryError::Unavailable),
        // No answer, or one that cannot be used (rate limited, server error, bad
        // shape): like being offline.
        Err(_) => Err(DirectoryError::Unreachable),
    }
}

/// [`map_verify`]'s result before the apps are added.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyMapped {
    Ok { employee: Employee, offline_days: u32, credential_revision: u64 },
    Answer(DirectoryAnswer),
}

impl EmployeeDirectory for ConvexDirectory {
    fn available(&self) -> bool {
        true
    }

    fn verify<'a>(
        &'a self,
        username: &'a str,
        password: &'a str,
    ) -> BoxFuture<'a, Result<DirectoryAnswer, DirectoryError>> {
        async move {
            let Some((backend, auth)) = self.link.get() else {
                return Err(DirectoryError::Unreachable);
            };
            let answer = backend.verify_employee(&auth, username, password).await;
            match map_verify(answer)? {
                VerifyMapped::Ok { employee, offline_days, credential_revision } => {
                    let apps = self.apps(&employee.id);
                    Ok(DirectoryAnswer::Ok(DirectoryEmployee { employee, apps, offline_days, credential_revision }))
                }
                VerifyMapped::Answer(answer) => Ok(answer),
            }
        }
        .boxed()
    }

    fn apps_for(&self, employee_id: &str) -> Option<Vec<AppEntry>> {
        Some(self.apps(employee_id))
    }

    fn uses_roster(&self) -> bool {
        true
    }
}

/// Which directory the agent runs with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectoryChoice {
    Fixture,
    Convex,
}

/// The one place that decides whether fixture employees exist: only the
/// simulated agent with `--sim-demo`. The real agent and `--simulate` without
/// `--sim-demo` use the Convex directory. (Phase 3 is done, so the Phase 3 test
/// switch `fixtureDirectory` of `agent-config.json` is gone, Step 13 item 4.)
pub fn choose(simulate_demo: bool) -> DirectoryChoice {
    if simulate_demo {
        DirectoryChoice::Fixture
    } else {
        DirectoryChoice::Convex
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::fake::FakeBackend;
    use crate::backend::DeviceAuth;
    use crate::platform::sim::SimPlatform;

    #[test]
    fn choose_gives_fixtures_only_to_the_demo() {
        assert_eq!(choose(true), DirectoryChoice::Fixture);
        assert_eq!(choose(false), DirectoryChoice::Convex);
        // The old config key is ignored, not an error.
        let parsed: crate::agent::AgentConfig = serde_json::from_str(r#"{ "fixtureDirectory": true }"#).unwrap();
        assert!(parsed.kill_hung_shell);
    }

    #[tokio::test]
    async fn the_fixture_directory_answers_like_the_plan() {
        let directory = FixtureDirectory::new(false);
        match directory.verify("maya", "demo").await {
            Ok(DirectoryAnswer::Ok(found)) => {
                assert_eq!(found.employee.id, "emp_maya");
                assert_eq!(found.offline_days, 7);
                assert_eq!(found.apps.len(), 7);
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
        assert!(!directory.uses_roster() && directory.apps_for("emp_maya").is_none());

        let offline = FixtureDirectory::new(true);
        assert_eq!(offline.verify("maya", "demo").await, Err(DirectoryError::Unreachable));
        assert_eq!(UnavailableDirectory.verify("maya", "demo").await, Err(DirectoryError::Unavailable));
    }

    fn maya() -> Employee {
        Employee { id: "emp1".into(), username: "maya".into(), name: "Maya".into(), role: None, quota_bytes: 0 }
    }

    #[tokio::test]
    async fn convex_directory_maps_every_answer() {
        let link = BackendLink::new();
        let dir = crate::testutil::TempDir::new();
        let platform: Arc<dyn crate::platform::Platform> = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        let doc = serde_json::json!({ "catalog": [{
            "id": "files", "name": "My files", "description": null, "kind": "builtin", "builtin": { "tool": "files" },
            "web": null, "desktop": null, "pinnedTaskbar": true, "pinnedDesktop": false, "hue": null, "icon": null,
            "audience": "everyone", "employeeIds": [], "revision": 1
        }] });
        let (_policy_tx, policy_rx) = watch::channel(AgentPolicy::from_doc(Some(&doc)));
        let directory = ConvexDirectory::new(Arc::clone(&link), policy_rx, AppResolver::new(platform));
        assert!(directory.available() && directory.uses_roster());

        // Not enrolled yet (no link): unreachable, so the offline path runs.
        assert_eq!(directory.verify("maya", "pw").await, Err(DirectoryError::Unreachable));

        let fake = FakeBackend::new();
        link.set(Arc::new(fake.clone()), DeviceAuth { device_id: "dev-1".into(), device_secret: "s".into() });
        fake.script_verify(Ok(VerifyAnswer::Ok { employee: maya(), offline_days: 3, credential_revision: 4 }));
        match directory.verify("maya", "pw").await {
            Ok(DirectoryAnswer::Ok(found)) => {
                assert_eq!((found.employee.id.as_str(), found.offline_days, found.credential_revision), ("emp1", 3, 4));
                assert_eq!(found.apps.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["files"]);
            }
            other => panic!("unexpected {other:?}"),
        }
        for (answer, expected) in [
            (VerifyAnswer::WrongCredentials, DirectoryAnswer::WrongCredentials),
            (VerifyAnswer::Disabled, DirectoryAnswer::Disabled),
            (VerifyAnswer::NotAllowedHere, DirectoryAnswer::NotAllowedHere),
            (VerifyAnswer::LockedOut { retry_after_ms: 900_000 }, DirectoryAnswer::LockedOut { retry_after_ms: 900_000 }),
        ] {
            fake.script_verify(Ok(answer));
            assert_eq!(directory.verify("maya", "pw").await, Ok(expected));
        }
        for (error, expected) in [
            (BackendError::Unreachable, DirectoryError::Unreachable),
            (BackendError::Timeout, DirectoryError::Unreachable),
            (BackendError::Rejected { code: "device_rejected".into() }, DirectoryError::Unavailable),
            (BackendError::Rejected { code: "rate_limited".into() }, DirectoryError::Unreachable),
            (BackendError::Protocol("x".into()), DirectoryError::Unreachable),
        ] {
            fake.script_verify(Err(error));
            assert_eq!(directory.verify("maya", "pw").await, Err(expected));
        }
        // The calls carried the username, never anything logged here.
        assert!(fake.verify_calls().iter().all(|(_, user)| user == "maya"));
        assert_eq!(directory.apps_for("emp1").map(|apps| apps.len()), Some(1));
    }
}
