//! Stand-in Staff App for tests: connects with `IpcClient`, prints every event,
//! asks for the snapshot, signals ready and heartbeats every 10 seconds.
//!
//! Type a letter and press Enter: `c` exit with code 1 (crash), `h` stop
//! heartbeating (hang), `q` exit with code 0. Honours `RULEBOX_AGENT_SIM=1`
//! (debug builds only).

use rulebox_ipc::client::{ClientEvent, IpcClient};
use rulebox_ipc::methods::{Empty, ShellHeartbeat, ShellReady, StateGet};
use rulebox_ipc::types::{ClientInfo, ClientRole};
use rulebox_ipc::HEARTBEAT_INTERVAL;
use tokio::sync::mpsc;
use tokio::time::interval;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let info = ClientInfo {
        role: ClientRole::Shell,
        name: "fake-staff".into(),
        version: env!("CARGO_PKG_VERSION").into(),
    };
    let (client, mut events) = IpcClient::spawn(info);
    println!("fake-staff: c = crash (exit 1), h = hang (stop heartbeats), q = quit (exit 0)");

    let (key_tx, mut keys) = mpsc::unbounded_channel::<char>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lines().map_while(Result::ok) {
            if let Some(key) = line.trim().chars().next() {
                if key_tx.send(key).is_err() {
                    break;
                }
            }
        }
    });

    let mut beat = interval(HEARTBEAT_INTERVAL);
    let mut ready = false;
    let mut hung = false;
    loop {
        tokio::select! {
            event = events.recv() => {
                let Some(event) = event else { return };
                println!("event: {event:?}");
                match event {
                    ClientEvent::Linked(_) => {
                        match client.call::<StateGet>(Empty {}).await {
                            Ok(snapshot) => println!("state.get: {snapshot:#?}"),
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
            key = keys.recv() => match key {
                Some('c') => std::process::exit(1),
                Some('h') => { hung = true; println!("heartbeats stopped"); }
                Some('q') | None => std::process::exit(0),
                Some(_) => {}
            },
        }
    }
}
