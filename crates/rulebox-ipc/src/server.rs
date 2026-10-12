//! Server side of the pipe (feature `server`): listener, connections, peer info.
//! Must run inside a tokio runtime.

use std::os::windows::io::AsRawHandle;

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tokio::net::windows::named_pipe::NamedPipeServer;
use tokio_util::codec::Framed;

use rulebox_win32::pipe::create_server_instance;
use rulebox_win32::security::SecurityAttributes;

pub use rulebox_win32::pipe::PeerInfo;

use crate::codec::{frame_or_end, FrameCodec, TransportError};
use crate::envelope::Frame;

type Pipe = Framed<NamedPipeServer, FrameCodec>;

/// Accepts connections on one pipe name. Every instance gets the same security
/// descriptor; the first one is created with first-instance protection.
pub struct PipeListener {
    name: String,
    attrs: SecurityAttributes,
    /// The instance waiting for the next client.
    next: Option<NamedPipeServer>,
}

impl PipeListener {
    /// Creates the first instance. Fails with `NameInUse` if another process
    /// already owns the name.
    pub fn bind(name: &str, sddl: &str) -> Result<Self, TransportError> {
        let attrs = SecurityAttributes::from_sddl(sddl)?;
        let first = create_server_instance(name, &attrs, true).map_err(|e| {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                TransportError::NameInUse
            } else {
                TransportError::Io(e)
            }
        })?;
        Ok(Self { name: name.to_string(), attrs, next: Some(first) })
    }

    /// Waits for a client, creates the next instance first, then returns the
    /// connected one. Cancel-safe.
    pub async fn accept(&mut self) -> Result<Connection, TransportError> {
        if self.next.is_none() {
            self.next = Some(create_server_instance(&self.name, &self.attrs, false)?);
        }
        let Some(waiting) = self.next.as_ref() else {
            return Err(std::io::Error::other("no pipe instance").into());
        };
        waiting.connect().await?;
        // If the replacement cannot be created the client is still served; the
        // next `accept` tries again.
        let replacement = create_server_instance(&self.name, &self.attrs, false).ok();
        let Some(connected) = std::mem::replace(&mut self.next, replacement) else {
            return Err(std::io::Error::other("no pipe instance").into());
        };
        Ok(Connection { framed: Framed::new(connected, FrameCodec::new()) })
    }
}

pub struct Connection {
    framed: Pipe,
}

impl Connection {
    /// `None` when the client closed the pipe.
    pub async fn read_frame(&mut self) -> Result<Option<Frame>, TransportError> {
        frame_or_end(self.framed.next().await)
    }

    pub async fn write_frame(&mut self, frame: Frame) -> Result<(), TransportError> {
        Ok(self.framed.send(frame).await?)
    }

    /// Who is on the other end. Call after the first read. Synchronous on
    /// purpose: the impersonation inside must not span an `.await`.
    pub fn verify_peer(&self) -> Result<PeerInfo, TransportError> {
        Ok(rulebox_win32::pipe::verify_peer(self.framed.get_ref().as_raw_handle())?)
    }

    /// Elevation check for the admin pipe; same rules as `verify_peer`.
    pub fn peer_is_elevated_admin(&self) -> Result<bool, TransportError> {
        Ok(rulebox_win32::pipe::token_is_elevated_admin(self.framed.get_ref().as_raw_handle())?)
    }

    pub fn split(self) -> (FrameReader, FrameWriter) {
        let (sink, stream) = self.framed.split();
        (FrameReader { stream }, FrameWriter { sink })
    }
}

pub struct FrameReader {
    stream: SplitStream<Pipe>,
}

impl FrameReader {
    /// `None` when the client closed the pipe.
    pub async fn read_frame(&mut self) -> Result<Option<Frame>, TransportError> {
        frame_or_end(self.stream.next().await)
    }
}

pub struct FrameWriter {
    sink: SplitSink<Pipe, Frame>,
}

impl FrameWriter {
    pub async fn write_frame(&mut self, frame: Frame) -> Result<(), TransportError> {
        Ok(self.sink.send(frame).await?)
    }
}
