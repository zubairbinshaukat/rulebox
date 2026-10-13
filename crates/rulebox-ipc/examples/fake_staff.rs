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
//! Each prints its result as JSON. A typed password is never printed back.
//! Honours `RULEBOX_AGENT_SIM=1` (debug builds only).

use rulebox_ipc::client::{ClientEvent, IpcClient};
use rulebox_ipc::methods::{
    AppsList, Empty, SessionGet, SessionSignIn, SessionSignOut, SessionVerifyPassword, ShellHeartbeat,
    ShellReady, StateGet,
};
use rulebox_ipc::requests::{SignInParams, VerifyPasswordParams};
use rulebox_ipc::types::{ClientInfo, ClientRole};
use rulebox_ipc::{CAP_APPS, CAP_SESSION, HEARTBEAT_INTERVAL};
use tokio::sync::mpsc;
use tokio::time::interval;

/// What the next typed line is for.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pending {
    SignIn,
    Verify,
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
    let (client, mut events) = IpcClient::spawn(info);
    println!("fake-staff: c = crash (exit 1), h = hang (stop heartbeats), q = quit (exit 0)");

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
                    }
                    continue;
                }
                match line.trim().chars().next() {
                    Some('c') => std::process::exit(1),
                    Some('h') => { hung = true; println!("heartbeats stopped"); }
                    Some('q') => std::process::exit(0),
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
