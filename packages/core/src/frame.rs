//! Data-plane wire format (RFC 0001 §6). All integers little-endian.
//!
//! One frame per DataChannel message; boundaries come from SCTP, so frames
//! are not length-prefixed. Decoding is total: it never panics on arbitrary
//! bytes (property-tested), and per §11 distinguishes "discard silently"
//! (bad magic / truncation) from "reject with control-plane error" (version
//! mismatch) from "ignore" (unknown frame type).

use crate::constants::{
    AUDIO_CHUNK_HEADER_LEN, FRAME_HEADER_LEN, MAGIC, MAX_CHUNK_PAYLOAD_BYTES, MAX_FRAME_BYTES,
    PROTOCOL_VERSION,
};

pub const FT_AUDIO_CHUNK: u8 = 0x01;
pub const FT_ACK_STATUS: u8 = 0x02;
pub const FT_BACKFILL_REQUEST: u8 = 0x03;
pub const FT_GAP_REPORT: u8 = 0x04;
pub const FT_TIME_PING: u8 = 0x05;
pub const FT_TIME_PONG: u8 = 0x06;
pub const FT_HAVE_SUMMARY: u8 = 0x07;

/// Identifies one stream within one take. Both halves of every chunk key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct StreamKey {
    pub take_id: [u8; 16],
    pub stream_id: [u8; 16],
}

/// The globally unique, immutable, idempotent chunk key (§2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ChunkKey {
    pub stream: StreamKey,
    pub seq: u32,
}

/// Inclusive sequence range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SeqRange {
    pub start: u32,
    pub end: u32,
}

impl SeqRange {
    pub fn new(start: u32, end: u32) -> Self {
        Self { start, end }
    }

    pub fn contains(&self, seq: u32) -> bool {
        self.start <= seq && seq <= self.end
    }

    pub fn len(&self) -> u64 {
        u64::from(self.end) - u64::from(self.start) + 1
    }

    pub fn is_empty(&self) -> bool {
        self.end < self.start
    }
}

/// AUDIO_CHUNK (0x01). Seq 0 carries the stream header, not audio (§6.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioChunk {
    pub stream: StreamKey,
    pub seq: u32,
    /// Position of the first sample in the take's sample domain. 0 for seq 0.
    pub first_sample_index: u64,
    /// Samples in this chunk. 0 for seq 0.
    pub sample_count: u32,
    /// Recorder monotonic clock, microseconds. Coarse placement hint only.
    pub capture_ts_us: u64,
    /// CRC-32C over `payload` only.
    pub crc32c: u32,
    pub payload: Vec<u8>,
}

impl AudioChunk {
    pub fn key(&self) -> ChunkKey {
        ChunkKey {
            stream: self.stream,
            seq: self.seq,
        }
    }
}

/// ACK_STATUS (0x02): sink → recorder. `chwm` = CHWM_NONE means nothing yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AckStatus {
    pub stream: StreamKey,
    pub chwm: u32,
    /// Holes above the CHWM: exactly what to retransmit (§6.4).
    pub holes: Vec<SeqRange>,
}

/// Shared layout of BACKFILL_REQUEST / GAP_REPORT / HAVE_SUMMARY (§6.5–6.8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RangeList {
    pub stream: StreamKey,
    pub ranges: Vec<SeqRange>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimePing {
    pub ping_id: u32,
    /// Sender clock at emission, µs.
    pub t1: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimePong {
    pub ping_id: u32,
    /// Echo of the ping's t1.
    pub t1: u64,
    /// Responder clock at receipt, µs.
    pub t2: u64,
    /// Responder clock at send, µs.
    pub t3: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    AudioChunk(AudioChunk),
    AckStatus(AckStatus),
    BackfillRequest(RangeList),
    GapReport(RangeList),
    TimePing(TimePing),
    TimePong(TimePong),
    HaveSummary(RangeList),
}

/// Successful decode: either a known frame or an unknown type to be ignored
/// for forward compatibility (§6.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decoded {
    Frame(Frame),
    /// Unknown `frame type` — MUST be ignored (§6.1).
    UnknownType(u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DecodeError {
    /// Discard silently (§11).
    #[error("bad magic")]
    BadMagic,
    /// Discard silently (§11).
    #[error("truncated frame")]
    Truncated,
    /// Reject frame; surface a control-plane error (§5, §11).
    #[error("data-plane version mismatch: got {0:#04x}")]
    VersionMismatch(u8),
    /// Structurally invalid (length fields disagree with actual bytes).
    #[error("malformed frame: {0}")]
    Malformed(&'static str),
    /// Larger than MAX_FRAME_BYTES (§4.2).
    #[error("frame exceeds MAX_FRAME_BYTES: {0}")]
    Oversize(usize),
}

impl Frame {
    pub fn frame_type(&self) -> u8 {
        match self {
            Frame::AudioChunk(_) => FT_AUDIO_CHUNK,
            Frame::AckStatus(_) => FT_ACK_STATUS,
            Frame::BackfillRequest(_) => FT_BACKFILL_REQUEST,
            Frame::GapReport(_) => FT_GAP_REPORT,
            Frame::TimePing(_) => FT_TIME_PING,
            Frame::TimePong(_) => FT_TIME_PONG,
            Frame::HaveSummary(_) => FT_HAVE_SUMMARY,
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.encoded_len());
        out.extend_from_slice(&MAGIC);
        out.push(PROTOCOL_VERSION);
        out.push(self.frame_type());
        match self {
            Frame::AudioChunk(c) => {
                debug_assert!(c.payload.len() <= MAX_CHUNK_PAYLOAD_BYTES);
                out.extend_from_slice(&c.stream.take_id);
                out.extend_from_slice(&c.stream.stream_id);
                out.extend_from_slice(&c.seq.to_le_bytes());
                out.extend_from_slice(&c.first_sample_index.to_le_bytes());
                out.extend_from_slice(&c.sample_count.to_le_bytes());
                out.extend_from_slice(&c.capture_ts_us.to_le_bytes());
                out.extend_from_slice(&c.crc32c.to_le_bytes());
                out.extend_from_slice(&(c.payload.len() as u32).to_le_bytes());
                out.extend_from_slice(&c.payload);
            }
            Frame::AckStatus(a) => {
                out.extend_from_slice(&a.stream.take_id);
                out.extend_from_slice(&a.stream.stream_id);
                out.extend_from_slice(&a.chwm.to_le_bytes());
                encode_ranges(&mut out, &a.holes);
            }
            Frame::BackfillRequest(r) | Frame::GapReport(r) | Frame::HaveSummary(r) => {
                out.extend_from_slice(&r.stream.take_id);
                out.extend_from_slice(&r.stream.stream_id);
                encode_ranges(&mut out, &r.ranges);
            }
            Frame::TimePing(p) => {
                out.extend_from_slice(&p.ping_id.to_le_bytes());
                out.extend_from_slice(&p.t1.to_le_bytes());
            }
            Frame::TimePong(p) => {
                out.extend_from_slice(&p.ping_id.to_le_bytes());
                out.extend_from_slice(&p.t1.to_le_bytes());
                out.extend_from_slice(&p.t2.to_le_bytes());
                out.extend_from_slice(&p.t3.to_le_bytes());
            }
        }
        debug_assert!(out.len() <= MAX_FRAME_BYTES);
        out
    }

    pub fn encoded_len(&self) -> usize {
        FRAME_HEADER_LEN
            + match self {
                Frame::AudioChunk(c) => 64 + c.payload.len(),
                Frame::AckStatus(a) => 32 + 4 + 2 + 8 * a.holes.len(),
                Frame::BackfillRequest(r) | Frame::GapReport(r) | Frame::HaveSummary(r) => {
                    32 + 2 + 8 * r.ranges.len()
                }
                Frame::TimePing(_) => 12,
                Frame::TimePong(_) => 28,
            }
    }

    /// Decode one frame from one DataChannel message.
    pub fn decode(bytes: &[u8]) -> Result<Decoded, DecodeError> {
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(DecodeError::Oversize(bytes.len()));
        }
        if bytes.len() < FRAME_HEADER_LEN {
            return Err(DecodeError::Truncated);
        }
        if bytes[0..2] != MAGIC {
            return Err(DecodeError::BadMagic);
        }
        if bytes[2] != PROTOCOL_VERSION {
            return Err(DecodeError::VersionMismatch(bytes[2]));
        }
        let frame_type = bytes[3];
        let mut r = Reader {
            buf: bytes,
            pos: FRAME_HEADER_LEN,
        };
        let frame = match frame_type {
            FT_AUDIO_CHUNK => {
                let stream = r.stream_key()?;
                let seq = r.u32()?;
                let first_sample_index = r.u64()?;
                let sample_count = r.u32()?;
                let capture_ts_us = r.u64()?;
                let crc32c = r.u32()?;
                let payload_len = r.u32()? as usize;
                if payload_len > MAX_CHUNK_PAYLOAD_BYTES {
                    return Err(DecodeError::Malformed("payload_len exceeds frame bound"));
                }
                let payload = r.bytes(payload_len)?.to_vec();
                r.expect_end()?;
                debug_assert_eq!(r.pos, AUDIO_CHUNK_HEADER_LEN + payload.len());
                Frame::AudioChunk(AudioChunk {
                    stream,
                    seq,
                    first_sample_index,
                    sample_count,
                    capture_ts_us,
                    crc32c,
                    payload,
                })
            }
            FT_ACK_STATUS => {
                let stream = r.stream_key()?;
                let chwm = r.u32()?;
                let holes = r.ranges()?;
                r.expect_end()?;
                Frame::AckStatus(AckStatus {
                    stream,
                    chwm,
                    holes,
                })
            }
            FT_BACKFILL_REQUEST | FT_GAP_REPORT | FT_HAVE_SUMMARY => {
                let stream = r.stream_key()?;
                let ranges = r.ranges()?;
                r.expect_end()?;
                let list = RangeList { stream, ranges };
                match frame_type {
                    FT_BACKFILL_REQUEST => Frame::BackfillRequest(list),
                    FT_GAP_REPORT => Frame::GapReport(list),
                    _ => Frame::HaveSummary(list),
                }
            }
            FT_TIME_PING => {
                let ping_id = r.u32()?;
                let t1 = r.u64()?;
                r.expect_end()?;
                Frame::TimePing(TimePing { ping_id, t1 })
            }
            FT_TIME_PONG => {
                let ping_id = r.u32()?;
                let t1 = r.u64()?;
                let t2 = r.u64()?;
                let t3 = r.u64()?;
                r.expect_end()?;
                Frame::TimePong(TimePong {
                    ping_id,
                    t1,
                    t2,
                    t3,
                })
            }
            other => return Ok(Decoded::UnknownType(other)),
        };
        Ok(Decoded::Frame(frame))
    }
}

fn encode_ranges(out: &mut Vec<u8>, ranges: &[SeqRange]) {
    // hole_count is u16; senders MUST split lists that do not fit. Encoding
    // truncates defensively — callers use `split_ranges_for_frames`.
    let n = ranges.len().min(u16::MAX as usize);
    out.extend_from_slice(&(n as u16).to_le_bytes());
    for range in &ranges[..n] {
        out.extend_from_slice(&range.start.to_le_bytes());
        out.extend_from_slice(&range.end.to_le_bytes());
    }
}

/// Max ranges that keep a range-list frame within MAX_FRAME_BYTES.
/// 4 (header) + 32 (keys) + 2 (count) + 8n <= 65_536.
pub const MAX_RANGES_PER_FRAME: usize = (MAX_FRAME_BYTES - FRAME_HEADER_LEN - 32 - 2) / 8;

/// Split an arbitrarily long range list into frame-sized batches.
pub fn split_ranges_for_frames(ranges: &[SeqRange]) -> impl Iterator<Item = &[SeqRange]> {
    ranges.chunks(MAX_RANGES_PER_FRAME)
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn bytes(&mut self, n: usize) -> Result<&'a [u8], DecodeError> {
        let end = self.pos.checked_add(n).ok_or(DecodeError::Truncated)?;
        if end > self.buf.len() {
            return Err(DecodeError::Truncated);
        }
        let slice = &self.buf[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn u16(&mut self) -> Result<u16, DecodeError> {
        let b = self.bytes(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    fn u32(&mut self) -> Result<u32, DecodeError> {
        let b = self.bytes(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn u64(&mut self) -> Result<u64, DecodeError> {
        let b = self.bytes(8)?;
        Ok(u64::from_le_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }

    fn stream_key(&mut self) -> Result<StreamKey, DecodeError> {
        let mut take_id = [0u8; 16];
        take_id.copy_from_slice(self.bytes(16)?);
        let mut stream_id = [0u8; 16];
        stream_id.copy_from_slice(self.bytes(16)?);
        Ok(StreamKey { take_id, stream_id })
    }

    fn ranges(&mut self) -> Result<Vec<SeqRange>, DecodeError> {
        let count = self.u16()? as usize;
        // Reject counts the remaining bytes cannot possibly satisfy before
        // allocating.
        if self.buf.len().saturating_sub(self.pos) < count * 8 {
            return Err(DecodeError::Truncated);
        }
        let mut ranges = Vec::with_capacity(count);
        for _ in 0..count {
            let start = self.u32()?;
            let end = self.u32()?;
            if end < start {
                return Err(DecodeError::Malformed("inverted range"));
            }
            ranges.push(SeqRange { start, end });
        }
        Ok(ranges)
    }

    fn expect_end(&self) -> Result<(), DecodeError> {
        if self.pos != self.buf.len() {
            return Err(DecodeError::Malformed("trailing bytes"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crc32c::crc32c;

    fn take_id() -> [u8; 16] {
        [
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E,
            0x0F, 0x10,
        ]
    }

    fn stream_id() -> [u8; 16] {
        [
            0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xAB, 0xAC, 0xAD, 0xAE,
            0xAF, 0xB0,
        ]
    }

    fn key() -> StreamKey {
        StreamKey {
            take_id: take_id(),
            stream_id: stream_id(),
        }
    }

    /// Golden vector: byte-exact AUDIO_CHUNK layout per §6.2.
    #[test]
    fn golden_audio_chunk() {
        let payload = vec![0xDE, 0xAD, 0xBE, 0xEF];
        let chunk = AudioChunk {
            stream: key(),
            seq: 7,
            first_sample_index: 0x0102_0304_0506_0708,
            sample_count: 24_576,
            capture_ts_us: 0x1122_3344_5566_7788,
            crc32c: crc32c(&[0xDE, 0xAD, 0xBE, 0xEF]),
            payload: payload.clone(),
        };
        let bytes = Frame::AudioChunk(chunk.clone()).encode();

        let mut expected = vec![
            0x41, 0x4E, 0x01, 0x01, // 'A' 'N' version type
        ];
        expected.extend_from_slice(&take_id());
        expected.extend_from_slice(&stream_id());
        expected.extend_from_slice(&7u32.to_le_bytes());
        expected.extend_from_slice(&0x0102_0304_0506_0708u64.to_le_bytes());
        expected.extend_from_slice(&24_576u32.to_le_bytes());
        expected.extend_from_slice(&0x1122_3344_5566_7788u64.to_le_bytes());
        expected.extend_from_slice(&chunk.crc32c.to_le_bytes());
        expected.extend_from_slice(&4u32.to_le_bytes());
        expected.extend_from_slice(&payload);

        assert_eq!(bytes, expected);
        assert_eq!(bytes.len(), AUDIO_CHUNK_HEADER_LEN + 4);
        assert_eq!(
            Frame::decode(&bytes),
            Ok(Decoded::Frame(Frame::AudioChunk(chunk)))
        );
    }

    /// Golden vector: ACK_STATUS with CHWM sentinel and two holes.
    #[test]
    fn golden_ack_status() {
        let ack = AckStatus {
            stream: key(),
            chwm: crate::constants::CHWM_NONE,
            holes: vec![SeqRange::new(3, 5), SeqRange::new(9, 9)],
        };
        let bytes = Frame::AckStatus(ack.clone()).encode();

        let mut expected = vec![0x41, 0x4E, 0x01, 0x02];
        expected.extend_from_slice(&take_id());
        expected.extend_from_slice(&stream_id());
        expected.extend_from_slice(&[0xFF, 0xFF, 0xFF, 0xFF]);
        expected.extend_from_slice(&2u16.to_le_bytes());
        expected.extend_from_slice(&3u32.to_le_bytes());
        expected.extend_from_slice(&5u32.to_le_bytes());
        expected.extend_from_slice(&9u32.to_le_bytes());
        expected.extend_from_slice(&9u32.to_le_bytes());

        assert_eq!(bytes, expected);
        assert_eq!(
            Frame::decode(&bytes),
            Ok(Decoded::Frame(Frame::AckStatus(ack)))
        );
    }

    #[test]
    fn golden_time_ping_pong() {
        let ping = Frame::TimePing(TimePing {
            ping_id: 42,
            t1: 1_000_000,
        });
        let mut expected = vec![0x41, 0x4E, 0x01, 0x05];
        expected.extend_from_slice(&42u32.to_le_bytes());
        expected.extend_from_slice(&1_000_000u64.to_le_bytes());
        assert_eq!(ping.encode(), expected);
        assert_eq!(ping.encode().len(), 16);

        let pong = Frame::TimePong(TimePong {
            ping_id: 42,
            t1: 1_000_000,
            t2: 2_000_000,
            t3: 2_000_050,
        });
        assert_eq!(pong.encode().len(), 32);
        assert_eq!(Frame::decode(&pong.encode()), Ok(Decoded::Frame(pong)));
    }

    #[test]
    fn range_list_frames_roundtrip() {
        let list = RangeList {
            stream: key(),
            ranges: vec![SeqRange::new(0, 0), SeqRange::new(2, 10)],
        };
        for frame in [
            Frame::BackfillRequest(list.clone()),
            Frame::GapReport(list.clone()),
            Frame::HaveSummary(list.clone()),
        ] {
            let bytes = frame.encode();
            assert_eq!(Frame::decode(&bytes), Ok(Decoded::Frame(frame)));
        }
    }

    #[test]
    fn bad_magic_discarded() {
        assert_eq!(Frame::decode(b"XX\x01\x01"), Err(DecodeError::BadMagic));
    }

    #[test]
    fn version_mismatch_rejected() {
        assert_eq!(
            Frame::decode(b"AN\x02\x01"),
            Err(DecodeError::VersionMismatch(0x02))
        );
    }

    #[test]
    fn unknown_type_ignored() {
        assert_eq!(Frame::decode(b"AN\x01\x7F"), Ok(Decoded::UnknownType(0x7F)));
        assert_eq!(Frame::decode(b"AN\x01\x80"), Ok(Decoded::UnknownType(0x80)));
    }

    #[test]
    fn truncated_discarded() {
        let full = Frame::TimePing(TimePing { ping_id: 1, t1: 2 }).encode();
        for cut in 0..full.len() {
            assert_eq!(
                Frame::decode(&full[..cut]),
                Err(DecodeError::Truncated),
                "cut={cut}"
            );
        }
    }

    #[test]
    fn trailing_bytes_malformed() {
        let mut bytes = Frame::TimePing(TimePing { ping_id: 1, t1: 2 }).encode();
        bytes.push(0x00);
        assert_eq!(
            Frame::decode(&bytes),
            Err(DecodeError::Malformed("trailing bytes"))
        );
    }

    #[test]
    fn inverted_range_malformed() {
        let mut bytes = vec![0x41, 0x4E, 0x01, 0x03];
        bytes.extend_from_slice(&take_id());
        bytes.extend_from_slice(&stream_id());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&5u32.to_le_bytes());
        bytes.extend_from_slice(&3u32.to_le_bytes());
        assert_eq!(
            Frame::decode(&bytes),
            Err(DecodeError::Malformed("inverted range"))
        );
    }
}
