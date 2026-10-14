//! Second thread for Core Audio and the network list (plan Step 10).
//!
//! It is a multithreaded apartment. The message-loop thread stays free of
//! these objects. Callbacks only enqueue a command and return; unregister
//! happens here, on the way out, never inside a callback.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use tokio::sync::mpsc::UnboundedSender;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

use crate::audio::{self, Volume};
use crate::error::{DesktopError, Result};
use crate::msgloop::DesktopEvent;
use crate::net::{self, Connectivity};
use crate::power;

/// What the shell copies into its state after a change.
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub volume: Option<Volume>,
    pub network: Connectivity,
    /// `None` for the whole session when the startup query failed.
    pub brightness: Option<u8>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            volume: None,
            network: Connectivity::None,
            brightness: None,
        }
    }
}

enum Command {
    AudioChanged,
    DeviceChanged,
    NetworkChanged,
    SetVolume(f32, std::sync::mpsc::SyncSender<Result<()>>),
    SetMuted(bool, std::sync::mpsc::SyncSender<Result<()>>),
    SetBrightness(u8, std::sync::mpsc::SyncSender<Result<()>>),
}

struct Queue {
    stop: bool,
    items: VecDeque<Command>,
}

struct Shared {
    queue: Mutex<Queue>,
    wake: Condvar,
    snap: Mutex<Snapshot>,
}

/// Handle the shell keeps. Dropping it stops the worker.
pub struct Watch {
    shared: Arc<Shared>,
}

impl Watch {
    /// Start the worker. `events` receives [`DesktopEvent::VolumeChanged`],
    /// [`DesktopEvent::NetworkChanged`] and [`DesktopEvent::PowerChanged`].
    pub fn start(events: UnboundedSender<DesktopEvent>) -> Watch {
        let shared = Arc::new(Shared {
            queue: Mutex::new(Queue {
                stop: false,
                items: VecDeque::new(),
            }),
            wake: Condvar::new(),
            snap: Mutex::new(Snapshot::default()),
        });
        let thread_shared = Arc::clone(&shared);
        if let Err(error) = std::thread::Builder::new()
            .name("rulebox-system".into())
            .spawn(move || worker(thread_shared, events))
        {
            tracing::error!(%error, "system worker did not start");
        }
        Watch { shared }
    }

    pub fn snapshot(&self) -> Snapshot {
        self.shared
            .snap
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn set_volume(&self, level: f32) -> Result<()> {
        self.call(|reply| Command::SetVolume(audio::clamp_level(level), reply))
    }

    pub fn set_muted(&self, muted: bool) -> Result<()> {
        self.call(|reply| Command::SetMuted(muted, reply))
    }

    pub fn set_brightness(&self, level: u8) -> Result<()> {
        if self.snapshot().brightness.is_none() {
            return Err(DesktopError::Message(
                "brightness is not available".into(),
            ));
        }
        self.call(|reply| Command::SetBrightness(level.min(100), reply))
    }

    fn call(&self, build: impl FnOnce(std::sync::mpsc::SyncSender<Result<()>>) -> Command) -> Result<()> {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        self.push(build(tx));
        match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(result) => result,
            Err(_) => Err(DesktopError::Message(
                "the system worker did not answer".into(),
            )),
        }
    }

    fn push(&self, command: Command) {
        let mut queue = self.shared.queue.lock().unwrap_or_else(|e| e.into_inner());
        if queue.stop {
            return;
        }
        queue.items.push_back(command);
        self.shared.wake.notify_one();
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        let mut queue = self.shared.queue.lock().unwrap_or_else(|e| e.into_inner());
        queue.stop = true;
        self.shared.wake.notify_one();
    }
}

fn worker(shared: Arc<Shared>, events: UnboundedSender<DesktopEvent>) {
    // SAFETY: this thread is new; CoUninitialize runs on the way out if this
    // call initialized COM.
    let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let uninit = com.is_ok();

    let shared_audio = Arc::clone(&shared);
    let on_audio: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        push_shared(&shared_audio, Command::AudioChanged);
    });
    let shared_device = Arc::clone(&shared);
    let on_device: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        push_shared(&shared_device, Command::DeviceChanged);
    });
    let shared_net = Arc::clone(&shared);
    let on_net: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        push_shared(&shared_net, Command::NetworkChanged);
    });

    let mut endpoint = match audio::Endpoint::open(on_audio, on_device) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            tracing::warn!(%error, "volume is unavailable");
            None
        }
    };

    let network = match net::Watch::open(on_net) {
        Ok(watch) => Some(watch),
        Err(error) => {
            tracing::warn!(%error, "network status is unavailable");
            None
        }
    };

    // Queried once. A failure hides the slider for the session.
    let brightness = power::brightness();
    if brightness.is_none() {
        tracing::info!("brightness query failed; the slider stays hidden");
    }

    {
        let mut snap = shared.snap.lock().unwrap_or_else(|e| e.into_inner());
        snap.brightness = brightness;
    }
    refresh_audio(&shared, endpoint.as_ref(), &events);
    refresh_network(&shared, network.as_ref(), &events);
    let _ = events.send(DesktopEvent::PowerChanged);

    loop {
        let command = {
            let mut queue = shared.queue.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if let Some(command) = queue.items.pop_front() {
                    break command;
                }
                if queue.stop {
                    drop(queue);
                    if uninit {
                        // Session objects drop first (end of function), then
                        // we uninitialize below. Break out before that.
                    }
                    drop(endpoint);
                    drop(network);
                    if uninit {
                        // SAFETY: matches the successful CoInitializeEx.
                        unsafe { CoUninitialize() };
                    }
                    return;
                }
                queue = shared
                    .wake
                    .wait(queue)
                    .unwrap_or_else(|e| e.into_inner());
            }
        };
        match command {
            Command::AudioChanged => refresh_audio(&shared, endpoint.as_ref(), &events),
            Command::DeviceChanged => {
                let on_volume: Arc<dyn Fn() + Send + Sync> = Arc::new({
                    let shared = Arc::clone(&shared);
                    move || push_shared(&shared, Command::AudioChanged)
                });
                let on_device: Arc<dyn Fn() + Send + Sync> = Arc::new({
                    let shared = Arc::clone(&shared);
                    move || push_shared(&shared, Command::DeviceChanged)
                });
                match audio::Endpoint::open(on_volume, on_device) {
                    Ok(next) => {
                        endpoint = next;
                        refresh_audio(&shared, endpoint.as_ref(), &events);
                    }
                    Err(error) => tracing::warn!(%error, "could not re-bind the audio device"),
                }
            }
            Command::NetworkChanged => refresh_network(&shared, network.as_ref(), &events),
            Command::SetVolume(level, reply) => {
                let result = match endpoint.as_ref() {
                    Some(endpoint) => endpoint.set_level(level),
                    None => Err(DesktopError::Message("no sound device".into())),
                };
                if result.is_ok() {
                    refresh_audio(&shared, endpoint.as_ref(), &events);
                }
                let _ = reply.send(result);
            }
            Command::SetMuted(muted, reply) => {
                let result = match endpoint.as_ref() {
                    Some(endpoint) => endpoint.set_muted(muted),
                    None => Err(DesktopError::Message("no sound device".into())),
                };
                if result.is_ok() {
                    refresh_audio(&shared, endpoint.as_ref(), &events);
                }
                let _ = reply.send(result);
            }
            Command::SetBrightness(level, reply) => {
                let result = power::set_brightness(level).map(|_| {
                    let mut snap = shared.snap.lock().unwrap_or_else(|e| e.into_inner());
                    snap.brightness = Some(level);
                });
                let _ = events.send(DesktopEvent::PowerChanged);
                let _ = reply.send(result);
            }
        }
    }
}

fn push_shared(shared: &Shared, command: Command) {
    let mut queue = shared.queue.lock().unwrap_or_else(|e| e.into_inner());
    if queue.stop {
        return;
    }
    queue.items.push_back(command);
    shared.wake.notify_one();
}

fn refresh_audio(
    shared: &Shared,
    endpoint: Option<&audio::Endpoint>,
    events: &UnboundedSender<DesktopEvent>,
) {
    let volume = endpoint.and_then(|endpoint| match endpoint.read() {
        Ok(volume) => Some(volume),
        Err(error) => {
            tracing::warn!(%error, "could not read the volume");
            None
        }
    });
    {
        let mut snap = shared.snap.lock().unwrap_or_else(|e| e.into_inner());
        snap.volume = volume;
    }
    let _ = events.send(DesktopEvent::VolumeChanged);
}

fn refresh_network(
    shared: &Shared,
    network: Option<&net::Watch>,
    events: &UnboundedSender<DesktopEvent>,
) {
    let connectivity = network.and_then(|network| match network.read() {
        Ok(connectivity) => Some(connectivity),
        Err(error) => {
            tracing::warn!(%error, "could not read connectivity");
            None
        }
    });
    if let Some(connectivity) = connectivity {
        let mut snap = shared.snap.lock().unwrap_or_else(|e| e.into_inner());
        snap.network = connectivity;
    }
    let _ = events.send(DesktopEvent::NetworkChanged);
}
