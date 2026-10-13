//! Stand-in Staff App for tests: connects with `IpcClient`, prints every event,
//! asks for the snapshot, signals ready and heartbeats every 10 seconds.
//!
//! Type a letter and press Enter: `c` exit with code 1 (crash), `h` stop
//! heartbeating (hang), `q` exit with code 0. When the agent lists the `session`
//! and `apps` capabilities (protocol 1.1) these keys appear too:
//!
//! - `i` sign in; the next line is `username password`
//! - `o` sign out
//! - `g` `session.get`
//! - `a` `apps.list` (prints id, kind and name per app)
//! - `v` verify password; the next line is the password
//!
//! With the `adminExit` capability (protocol 1.1) there is also:
//!
//! - `x` hidden admin exit; the next line is the PIN. Prints `adminExit.submit`'s
//!   result as JSON (`signingOut`, `wrongPin` with `attemptsLeft`, `lockedOut`
//!   with `retryAfterMs`, `disabled`); a correct PIN is followed by an
//!   `agent.shuttingDown` event with reason `adminExit`.
//!
//! And always `p`: the pipe probe of the VM checklist. It opens a second
//! connection (which sends no frame) and prints the pipe's owner and the server's
//! session, then whether a non-service process could create another instance of the
//! pipe, then whether an open that asks for generic write access is accepted.
//!
//! Each prints its result as JSON. A typed password or PIN is never printed back.
//! Honours `RULEBOX_AGENT_SIM=1` (debug builds only).

use rulebox_ipc::client::{ClientConfig, ClientEvent, IpcClient};
use rulebox_ipc::methods::{
    AdminExitSubmit, AppsList, Empty, SessionGet, SessionSignIn, SessionSignOut,
    SessionVerifyPassword, ShellHeartbeat, ShellReady, StateGet,
};
use rulebox_ipc::requests::{AdminExitSubmitParams, SignInParams, VerifyPasswordParams};
use rulebox_ipc::types::{ClientInfo, ClientRole};
use rulebox_ipc::{CAP_ADMIN_EXIT, CAP_APPS, CAP_SESSION, HEARTBEAT_INTERVAL};
use rulebox_win32::Win32Error;
use tokio::sync::mpsc;
use tokio::time::interval;

/// `GENERIC_READ | GENERIC_WRITE`: the access mask the client must NOT ask for
/// (plan Section 6.2); written as a number so this file needs no `windows` import.
const GENERIC_READ_WRITE: u32 = 0xC000_0000;

/// What the next typed line is for.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pending {
    SignIn,
    Verify,
    ExitPin,
}

/// The Win32 error number for the probe lines, or the error text when it has none.
fn error_text(error: &Win32Error) -> String {
    match error {
        Win32Error::Api { code, .. } => format!("error {code}"),
        Win32Error::Busy => "error 231".to_string(),
        Win32Error::NotFound => "error 2".to_string(),
        other => other.to_string(),
    }
}

/// The pipe probe (`p`). The connection it opens sends no frame, so the agent drops
/// it at the `hello` deadline.
fn probe_pipe(name: &str) {
    println!("probe: pipe {name}");
    match rulebox_win32::pipe::open_client(name) {
        Ok(handle) => {
            let raw = handle.raw().0;
            match rulebox_win32::pipe::pipe_owner(raw) {
                Ok(owner) => println!("owner: {}", owner.as_str()),
                Err(e) => println!("owner: cannot read ({})", error_text(&e)),
            }
            match rulebox_win32::pipe::server_session_id(raw) {
                Ok(session) => println!("server session: {session}"),
                Err(e) => println!("server session: cannot read ({})", error_text(&e)),
            }
            drop(handle);
        }
        Err(e) => println!("probe connection failed ({})", error_text(&e)),
    }
    match rulebox_win32::pipe::probe_create_instance(name) {
        Ok(Some(code)) => println!("create-instance: DENIED (error {code})"),
        Ok(None) => println!("create-instance: ALLOWED"),
        Err(e) => println!("create-instance: probe failed ({})", error_text(&e)),
    }
    match rulebox_win32::pipe::open_client_with_access(name, GENERIC_READ_WRITE) {
        Ok(handle) => {
            drop(handle);
            println!("generic-write open: ACCEPTED");
        }
        Err(e) => println!("generic-write open: REFUSED ({})", error_text(&e)),
    }
}

fn print_json<T: serde::Serialize>(label: &str, value: &T) {
    match serde_json::to_string(value) {
        Ok(json) => println!("{label}: {json}"),
        Err(e) => println!("{label}: cannot print the result: {e}"),
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let info = ClientInfo {
        role: ClientRole::Shell,
        name: "fake-staff".into(),
        version: env!("CARGO_PKG_VERSION").into(),
    };
    let pipe_name = ClientConfig::production().pipe_name;
    let (client, mut events) = IpcClient::spawn(info);
    println!(
        "fake-staff: c = crash (exit 1), h = hang (stop heartbeats), q = quit (exit 0), \
         p = pipe probe"
    );

    let (key_tx, mut keys) = mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lines().map_while(Result::ok) {
            if key_tx.send(line).is_err() {
                break;
            }
        }
    });

    let mut beat = interval(HEARTBEAT_INTERVAL);
    let mut ready = false;
    let mut hung = false;
    let mut has_session = false;
    let mut has_apps = false;
    let mut has_exit = false;
    let mut pending: Option<Pending> = None;
    loop {
        tokio::select! {
            event = events.recv() => {
                let Some(event) = event else { return };
                println!("event: {event:?}");
                match event {
                    ClientEvent::Linked(hello) => {
                        has_session = hello.capabilities.iter().any(|c| c == CAP_SESSION);
                        has_apps = hello.capabilities.iter().any(|c| c == CAP_APPS);
                        has_exit = hello.capabilities.iter().any(|c| c == CAP_ADMIN_EXIT);
                        if has_exit {
                            println!("fake-staff: x = admin exit (next line: the PIN)");
                        }
                        if has_session {
                            println!(
                                "fake-staff: i = sign in (next line: username password), o = sign out, \
                                 g = session.get, v = verify password (next line: password)"
                            );
                        }
                        if has_apps {
                            println!("fake-staff: a = apps.list");
                        }
                        match client.call::<StateGet>(Empty {}).await {
                            // JSON, the wire form (enrollment, displayMode, ...).
                            Ok(snapshot) => print_json("state.get", &snapshot),
                            Err(e) => println!("state.get failed: {e}"),
                        }
                        match client.call::<ShellReady>(Empty {}).await {
                            Ok(_) => ready = true,
                            Err(e) => println!("shell.ready failed: {e}"),
                        }
                    }
                    ClientEvent::Unlinked => ready = false,
                    _ => {}
                }
            }
            _ = beat.tick() => {
                if ready && !hung {
                    if let Err(e) = client.call::<ShellHeartbeat>(Empty {}).await {
                        println!("shell.heartbeat failed: {e}");
                    }
                }
            }
            line = keys.recv() => {
                let Some(line) = line else { std::process::exit(0) };
                // A line that follows `i` or `v` is its argument, not a key.
                if let Some(what) = pending.take() {
                    match what {
                        Pending::SignIn => {
                            let mut parts = line.split_whitespace();
                            match (parts.next(), parts.next()) {
                                (Some(username), Some(password)) => {
                                    let params = SignInParams {
                                        username: username.to_string(),
                                        password: password.to_string(),
                                    };
                                    match client.call::<SessionSignIn>(params).await {
                                        Ok(result) => print_json("session.signIn", &result),
                                        Err(e) => println!("session.signIn failed: {e}"),
                                    }
                                }
                                _ => println!("expected: username password"),
                            }
                        }
                        Pending::Verify => {
                            let password = line.trim();
                            if password.is_empty() {
                                println!("expected: the password");
                            } else {
                                let params = VerifyPasswordParams { password: password.to_string() };
                                match client.call::<SessionVerifyPassword>(params).await {
                                    Ok(result) => print_json("session.verifyPassword", &result),
                                    Err(e) => println!("session.verifyPassword failed: {e}"),
                                }
                            }
                        }
                        Pending::ExitPin => {
                            let pin = line.trim();
                            if pin.is_empty() {
                                println!("expected: the PIN");
                            } else {
                                let params = AdminExitSubmitParams { pin: pin.to_string() };
                                match client.call::<AdminExitSubmit>(params).await {
                                    Ok(result) => print_json("adminExit.submit", &result),
                                    Err(e) => println!("adminExit.submit failed: {e}"),
                                }
                            }
                        }
                    }
                    continue;
                }
                match line.trim().chars().next() {
                    Some('c') => std::process::exit(1),
                    Some('h') => { hung = true; println!("heartbeats stopped"); }
                    Some('q') => std::process::exit(0),
                    Some('p') => probe_pipe(&pipe_name),
                    Some('x') if has_exit => {
                        pending = Some(Pending::ExitPin);
                        println!("type: the PIN");
                    }
                    Some('i') if has_session => {
                        pending = Some(Pending::SignIn);
                        println!("type: username password");
                    }
                    Some('v') if has_session => {
                        pending = Some(Pending::Verify);
                        println!("type: the password");
                    }
                    Some('o') if has_session => {
                        match client.call::<SessionSignOut>(Empty {}).await {
                            Ok(result) => print_json("session.signOut", &result),
                            Err(e) => println!("session.signOut failed: {e}"),
                        }
                    }
                    Some('g') if has_session => {
                        match client.call::<SessionGet>(Empty {}).await {
                            Ok(result) => print_json("session.get", &result),
                            Err(e) => println!("session.get failed: {e}"),
                        }
                    }
                    Some('a') if has_apps => {
                        match client.call::<AppsList>(Empty {}).await {
                            Ok(result) => {
                                for app in &result.apps {
                                    println!("app: {} {:?} {}", app.id, app.kind, app.name);
                                }
                                print_json("apps.list", &result);
                            }
                            Err(e) => println!("apps.list failed: {e}"),
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}
