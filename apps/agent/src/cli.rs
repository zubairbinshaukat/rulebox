//! Command line (plan Section 7, Step 5).

use std::path::PathBuf;

use clap::{Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(name = "rulebox-agent", version, about = "Rulebox kiosk agent")]
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
    /// Offline recovery: undo the kiosk changes without the service.
    Recover {
        #[arg(long)]
        yes: bool,
    },
    /// Read-only compatibility report.
    Compat {
        #[arg(long)]
        json: bool,
    },
    /// (1.1) Hash an exit PIN: reads one line (4 to 12 digits) from standard input and
    /// prints the Argon2id hash. Touches no file, pipe or registry key.
    HashPin,
}

#[derive(Subcommand, Debug, PartialEq, Eq)]
pub enum ServiceAction {
    Run,
    Install,
    Uninstall,
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
        assert_eq!(parse(&["service", "uninstall"]), Command::Service { action: ServiceAction::Uninstall });
        assert_eq!(
            parse(&["run", "--console"]),
            Command::Run {
                console: true,
                simulate: false,
                data_dir: None,
                sim_demo: false,
                sim_offline: false
            }
        );
        assert_eq!(
            parse(&["run", "--console", "--simulate", "--data-dir", "x"]),
            Command::Run {
                console: true,
                simulate: true,
                data_dir: Some(PathBuf::from("x")),
                sim_demo: false,
                sim_offline: false
            }
        );
        assert_eq!(
            parse(&["run", "--console", "--simulate", "--sim-demo"]),
            Command::Run { console: true, simulate: true, data_dir: None, sim_demo: true, sim_offline: false }
        );
        assert_eq!(
            parse(&["run", "--console", "--simulate", "--sim-demo", "--sim-offline"]),
            Command::Run { console: true, simulate: true, data_dir: None, sim_demo: true, sim_offline: true }
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
        assert_eq!(parse(&["recover"]), Command::Recover { yes: false });
        assert_eq!(parse(&["recover", "--yes"]), Command::Recover { yes: true });
        assert_eq!(parse(&["compat", "--json"]), Command::Compat { json: true });
        assert_eq!(parse(&["hash-pin"]), Command::HashPin);
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
    }
}
