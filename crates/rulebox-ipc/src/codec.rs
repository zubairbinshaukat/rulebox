//! Length-delimited JSON codec (plan Section 6.3): a 4-byte big-endian length,
//! then that many bytes of UTF-8 JSON (one `Frame`).

use bytes::{Bytes, BytesMut};
use tokio_util::codec::{Decoder, Encoder, LengthDelimitedCodec};

use crate::envelope::Frame;
use crate::MAX_FRAME_LEN;

#[derive(Debug, thiserror::Error)]
pub enum CodecError {
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    /// The frame is longer than `MAX_FRAME_LEN`.
    #[error("frame larger than {MAX_FRAME_LEN} bytes")]
    TooLarge,
    /// Invalid UTF-8 or invalid JSON, or JSON that is not a `Frame`.
    #[error("invalid JSON: {0}")]
    InvalidJson(String),
}

/// Errors of the pipe transport (server and client).
#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("framing error: {0}")]
    Codec(#[from] CodecError),
    #[error("{0}")]
    Win32(#[from] rulebox_win32::Win32Error),
    /// Another process already owns the pipe name (first-instance protection).
    #[error("the pipe name is owned by another process")]
    NameInUse,
}

/// Turns the next item of a framed pipe into a frame. A closed or broken pipe
/// is a clean end (`None`), not an error.
pub(crate) fn frame_or_end(
    item: Option<Result<Frame, CodecError>>,
) -> Result<Option<Frame>, TransportError> {
    match item {
        None => Ok(None),
        Some(Ok(frame)) => Ok(Some(frame)),
        Some(Err(CodecError::Io(e))) if e.kind() == std::io::ErrorKind::BrokenPipe => Ok(None),
        Some(Err(e)) => Err(e.into()),
    }
}

pub struct FrameCodec {
    inner: LengthDelimitedCodec,
}

impl FrameCodec {
    pub fn new() -> Self {
        let inner = LengthDelimitedCodec::builder()
            .big_endian()
            .length_field_length(4)
            .max_frame_length(MAX_FRAME_LEN)
            .new_codec();
        Self { inner }
    }
}

impl Default for FrameCodec {
    fn default() -> Self {
        Self::new()
    }
}

/// `LengthDelimitedCodec` reports an oversized frame as `InvalidData`; the
/// other I/O kinds it can return are real I/O errors.
fn map_io(e: std::io::Error) -> CodecError {
    if e.kind() == std::io::ErrorKind::InvalidData {
        CodecError::TooLarge
    } else {
        CodecError::Io(e)
    }
}

impl Decoder for FrameCodec {
    type Item = Frame;
    type Error = CodecError;

    fn decode(&mut self, src: &mut BytesMut) -> Result<Option<Frame>, CodecError> {
        match self.inner.decode(src).map_err(map_io)? {
            None => Ok(None),
            // serde_json rejects invalid UTF-8 and invalid JSON alike.
            Some(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|e| CodecError::InvalidJson(e.to_string())),
        }
    }
}

impl Encoder<Frame> for FrameCodec {
    type Error = CodecError;

    fn encode(&mut self, frame: Frame, dst: &mut BytesMut) -> Result<(), CodecError> {
        let json = serde_json::to_vec(&frame).map_err(|e| CodecError::InvalidJson(e.to_string()))?;
        if json.len() > MAX_FRAME_LEN {
            return Err(CodecError::TooLarge);
        }
        self.inner.encode(Bytes::from(json), dst).map_err(map_io)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(id: u32) -> Frame {
        Frame::Request { id, method: "state.get".into(), params: json!({}) }
    }

    #[test]
    fn round_trip() {
        let mut codec = FrameCodec::new();
        let mut buf = BytesMut::new();
        codec.encode(request(1), &mut buf).unwrap();
        // 4-byte big-endian length prefix.
        let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        assert_eq!(len, buf.len() - 4);
        assert_eq!(codec.decode(&mut buf).unwrap(), Some(request(1)));
        assert!(buf.is_empty());
    }

    #[test]
    fn two_frames_in_one_buffer() {
        let mut codec = FrameCodec::new();
        let mut buf = BytesMut::new();
        codec.encode(request(1), &mut buf).unwrap();
        codec.encode(request(2), &mut buf).unwrap();
        assert_eq!(codec.decode(&mut buf).unwrap(), Some(request(1)));
        assert_eq!(codec.decode(&mut buf).unwrap(), Some(request(2)));
        assert_eq!(codec.decode(&mut buf).unwrap(), None);
    }

    #[test]
    fn frame_split_across_two_reads() {
        let mut codec = FrameCodec::new();
        let mut full = BytesMut::new();
        codec.encode(request(9), &mut full).unwrap();
        let tail = full.split_off(6);
        let mut buf = full;
        assert_eq!(codec.decode(&mut buf).unwrap(), None);
        buf.extend_from_slice(&tail);
        assert_eq!(codec.decode(&mut buf).unwrap(), Some(request(9)));
    }

    #[test]
    fn oversized_length_prefix_is_too_large() {
        let mut codec = FrameCodec::new();
        let mut buf = BytesMut::new();
        buf.extend_from_slice(&((MAX_FRAME_LEN as u32) + 1).to_be_bytes());
        assert!(matches!(codec.decode(&mut buf), Err(CodecError::TooLarge)));
    }

    #[test]
    fn max_length_prefix_is_accepted_and_waits_for_data() {
        let mut codec = FrameCodec::new();
        let mut buf = BytesMut::new();
        buf.extend_from_slice(&(MAX_FRAME_LEN as u32).to_be_bytes());
        assert_eq!(codec.decode(&mut buf).unwrap(), None);
    }

    #[test]
    fn oversized_frame_is_not_encoded() {
        let mut codec = FrameCodec::new();
        let mut buf = BytesMut::new();
        let big = Frame::Event { event: "x".into(), data: json!({ "s": "a".repeat(MAX_FRAME_LEN) }) };
        assert!(matches!(codec.encode(big, &mut buf), Err(CodecError::TooLarge)));
        assert!(buf.is_empty());
    }

    #[test]
    fn invalid_json_and_invalid_utf8_are_errors() {
        for payload in [&b"{not json"[..], &[0xff, 0xfe, 0xfd][..], &b"[1,2]"[..]] {
            let mut codec = FrameCodec::new();
            let mut buf = BytesMut::new();
            buf.extend_from_slice(&(payload.len() as u32).to_be_bytes());
            buf.extend_from_slice(payload);
            assert!(matches!(codec.decode(&mut buf), Err(CodecError::InvalidJson(_))));
        }
    }
}
