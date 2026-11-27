//! Command line (plan Section 7, Step 5).

use std::path::PathBuf;

use clap::{Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(name = "rulebox-agent", version = crate::AGENT_VERSION, about = "Rulebox kiosk agent")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand, Debug, PartialEq, Eq)]
pub enum Command {
    /// Windows service entry points (`run` is for the service manager only).
    Service {
        #[command(subcommand)]
        action: ServiceAction,
    },
    /// Run the agent in this console.
    Run {
        #[arg(long, required = true)]
        console: bool,
        /// Use the in-memory platform, the `.sim` pipes and a throwaway data directory.
        #[arg(long)]
        simulate: bool,
        #[arg(long)]
        data_dir: Option<PathBuf>,
        /// (1.1) The demo world: enrolled, demo employees (password `demo`) and
        /// catalogue. Simulate mode only.
        #[arg(long, requires = "simulate")]
        sim_demo: bool,
        /// (1.1) The demo world, but offline: only cached employees can sign in.
        #[arg(long, requires = "sim_demo")]
        sim_offline: bool,
        /// (Step 13) A simulated, signed-in Staff session for the launcher watchdog to
        /// watch. Simulate mode only.
        #[arg(long, requires = "simulate")]
        sim_staff_session: bool,
    },
    /// Enroll this PC with an enrollment code.
    Enroll {
        code: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        allow_joined: bool,
        #[arg(long)]
        simulate: bool,
    },
    /// Print the agent's state.
    Status {
        #[arg(long)]
        json: bool,
        #[arg(long)]
        simulate: bool,
    },
    /// Remove the enrollment and undo the kiosk changes.
    Unenroll {
        #[arg(long)]
        remove_staff_account: bool,
        #[arg(long)]
        simulate: bool,
    },
    /// (Phase 4) Trust another policy signing key (the "key lost" recovery):
    /// standard base64 of the 32-byte Ed25519 public key. Prints its key id.
    TrustKey {
        public_key: String,
        #[arg(long)]
        simulate: bool,
    },
    /// Offline recovery: undo the kiosk changes without the service.
    Recover {
        #[arg(long)]
        yes: bool,
    },
    /// (Q-A6) Uninstall only: delete everything in the Rulebox data directory except `logs\`. The MSI runs it after the
    /// service has stopped, never in an upgrade. Needs an elevated prompt on an armed machine.
    PurgeData,
    /// Read-only compatibility report.
    Compat {
        #[arg(long)]
        json: bool,
    },
    /// (Phase 5) Read-only: the lockdown as the document asks for it against what the service
    /// reported and what is on this PC now, the invariant self-check, the journal and the
    /// posture. Needs an elevated prompt; changes nothing.
    LockdownStatus {
        #[arg(long)]
        json: bool,
    },
    /// (Phase 6) Read-only: which condition of the machine guard holds and which failed
    /// (test-machine door and production door). Exit code 1 when the guard is closed.
    GuardStatus {
        #[arg(long)]
        json: bool,
    },
    /// (1.1) Hash an exit PIN: reads one line (6 to 12 digits) from standard input and
    /// prints the Argon2id hash. Touches no file, pipe or registry key.
    HashPin,
    /// (Phase 6 Step 8) Rulebox Setup: a small window that checks this PC, installs the WebView2
    /// Runtime if it is missing, takes the enrollment code and enrolls. Asks Windows for
    /// administrator rights itself (a UAC prompt) when it is not elevated; the installer's finish
    /// page and the Start menu shortcut start it this way.
    Setup {
        /// Everything in memory: a simulated PC and service, no prompt, nothing changed.
        #[arg(long)]
        simulate: bool,
        /// Set by the program itself on the copy it starts for the prompt (so a refusal does not loop).
        #[arg(long, hide = true)]
        relaunched: bool,
    },
}

#[derive(Subcommand, Debug, PartialEq, Eq)]
pub enum ServiceAction {
    /// For the service manager only: starts the service host.
    Run,
    /// Create (or update) the Windows service and start it. Dev and VM use only.
    Install,
    /// Stop and delete the service.
    Uninstall {
        /// Remove the service even when the kiosk is applied: runs `recover` first.
        #[arg(long)]
        force: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Command {
        let mut full = vec!["rulebox-agent"];
        full.extend_from_slice(args);
        Cli::try_parse_from(full).unwrap().command
    }

    #[test]
    fn parses_every_command_line_in_the_plan() {
        assert_eq!(parse(&["service", "run"]), Command::Service { action: ServiceAction::Run });
        assert_eq!(parse(&["service", "install"]), Command::Service { action: ServiceAction::Install });
        assert_eq!(
            parse(&["service", "uninstall"]),
            Command::Service { action: ServiceAction::Uninstall { force: false } }
        );
        assert_eq!(
            parse(&["service", "uninstall", "--force"]),
            Command::Service { action: ServiceAction::Uninstall { force: true } }
        );
        assert_eq!(
            parse(&["run", "--console"]),
            Command::Run {
                console: true,
                simulate: false,
                data_dir: None,
                sim_demo: false,
                sim_offline: false,
                sim_staff_session: false
            }
        );
        assert_eq!(
            parse(&["run", "--console", "--simulate", "--data-dir", "x"]),
            Command::Run {
                console: true,
                simulate: true,
                data_dir: Some(PathBuf::from("x")),
                sim_demo: false,
                sim_offline: false,
                sim_staff_session: false
            }
        );
        assert_eq!(
            parse(&["run", "--console", "--simulate", "--sim-demo"]),
            Command::Run {
                console: true,
                simulate: true,
                data_dir: None,
                sim_demo: true,
                sim_offline: false,
                sim_staff_session: false
            }
        );
        assert_eq!(
            parse(&["run", "--console", "--simulate", "--sim-demo", "--sim-offline"]),
            Command::Run {
                console: true,
                simulate: true,
                data_dir: None,
                sim_demo: true,
                sim_offline: true,
                sim_staff_session: false
            }
        );
        assert_eq!(
            parse(&["run", "--console", "--simulate", "--sim-staff-session"]),
            Command::Run {
                console: true,
                simulate: true,
                data_dir: None,
                sim_demo: false,
                sim_offline: false,
                sim_staff_session: true
            }
        );
        assert_eq!(
            parse(&["enroll", "RBX1.abc#def", "--name", "Desk 1", "--allow-joined", "--simulate"]),
            Command::Enroll {
                code: "RBX1.abc#def".into(),
                name: Some("Desk 1".into()),
                allow_joined: true,
                simulate: true
            }
        );
        assert_eq!(parse(&["status"]), Command::Status { json: false, simulate: false });
        assert_eq!(parse(&["status", "--json", "--simulate"]), Command::Status { json: true, simulate: true });
        assert_eq!(
            parse(&["unenroll", "--remove-staff-account", "--simulate"]),
            Command::Unenroll { remove_staff_account: true, simulate: true }
        );
        assert_eq!(
            parse(&["trust-key", "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=", "--simulate"]),
            Command::TrustKey { public_key: "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=".into(), simulate: true }
        );
        assert_eq!(parse(&["recover"]), Command::Recover { yes: false });
        assert_eq!(parse(&["recover", "--yes"]), Command::Recover { yes: true });
        assert_eq!(parse(&["purge-data"]), Command::PurgeData);
        assert!(Cli::try_parse_from(["rulebox-agent", "purge-data", "--yes"]).is_err(), "no options: it asks nothing and is not for typing");
        assert_eq!(parse(&["compat", "--json"]), Command::Compat { json: true });
        assert_eq!(parse(&["lockdown-status"]), Command::LockdownStatus { json: false });
        assert_eq!(parse(&["lockdown-status", "--json"]), Command::LockdownStatus { json: true });
        assert_eq!(parse(&["guard-status"]), Command::GuardStatus { json: false });
        assert_eq!(parse(&["guard-status", "--json"]), Command::GuardStatus { json: true });
        assert_eq!(parse(&["hash-pin"]), Command::HashPin);
        assert_eq!(parse(&["setup"]), Command::Setup { simulate: false, relaunched: false });
        assert_eq!(parse(&["setup", "--simulate"]), Command::Setup { simulate: true, relaunched: false });
        assert_eq!(parse(&["setup", "--relaunched"]), Command::Setup { simulate: false, relaunched: true });
    }

    #[test]
    fn the_installers_shortcut_arguments_parse_and_service_run_is_unchanged() {
        // The MSI's "Rulebox Setup" shortcut runs `rulebox-agent.exe setup`; the elevated copy gets
        // `setup --relaunched`. The service entry point stays exactly `service run`.
        assert!(Cli::try_parse_from(["rulebox-agent", "setup"]).is_ok());
        assert!(Cli::try_parse_from(["rulebox-agent", "setup", "--relaunched"]).is_ok());
        assert_eq!(parse(&["service", "run"]), Command::Service { action: ServiceAction::Run });
        assert!(Cli::try_parse_from(["rulebox-agent", "setup", "--code", "x"]).is_err(), "no code on a command line");
    }

    #[test]
    fn run_needs_console() {
        assert!(Cli::try_parse_from(["rulebox-agent", "run"]).is_err());
    }

    #[test]
    fn the_demo_flags_need_simulate_and_each_other() {
        let parse = |args: &[&str]| {
            let mut full = vec!["rulebox-agent", "run", "--console"];
            full.extend_from_slice(args);
            Cli::try_parse_from(full)
        };
        // --sim-demo needs --simulate, so a real agent cannot be given the demo world.
        assert!(parse(&["--sim-demo"]).is_err());
        // --sim-offline needs --sim-demo (and so --simulate).
        assert!(parse(&["--simulate", "--sim-offline"]).is_err());
        assert!(parse(&["--sim-offline"]).is_err());
        assert!(parse(&["--simulate", "--sim-demo", "--sim-offline"]).is_ok());
        // (Step 13) --sim-staff-session needs --simulate; a real agent cannot get it.
        assert!(parse(&["--sim-staff-session"]).is_err());
        assert!(parse(&["--simulate", "--sim-staff-session"]).is_ok());
    }
}
