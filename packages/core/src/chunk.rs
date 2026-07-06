//! Chunk construction and the seq-0 stream header payload.
//!
//! RFC §6.2 requires seq 0 to carry a self-describing codec configuration but
//! leaves its encoding open; `StreamHeaderV1` (little-endian, versioned,
//! length-prefixed) is Antiphon's normative encoding — proposed as an RFC
//! amendment. Reconstruction of a playable file is `codec_header` followed by
//! the concatenated payloads of seq 1..=final.

use crate::crc32c::crc32c;
use crate::frame::{AudioChunk, StreamKey};

/// Magic prefix of a StreamHeaderV1 payload: "ANS0" (ANtiphon Stream, v0 wire).
pub const STREAM_HEADER_MAGIC: [u8; 4] = *b"ANS0";

pub const CODEC_FLAC: u8 = 1;

/// Seq-0 payload: everything a sink needs to decode the stream with no other
/// context (§6.2 — "a sink can always recover the decode context").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamHeaderV1 {
    /// Codec identifier. FLAC (=1) is the only value in v1.
    pub codec: u8,
    /// MUST be 1 in protocol v1.
    pub channels: u8,
    /// 16 or 24.
    pub bits_per_sample: u8,
    pub sample_rate: u32,
    /// Recorder monotonic clock (µs) at take sample index 0 — the stream's
    /// clock-domain epoch.
    pub clock_epoch_us: u64,
    /// Unix milliseconds wall-clock hint at the same instant; 0 if unknown.
    pub wall_clock_hint_ms: u64,
    /// Human-readable recorder device description.
    pub device_desc: String,
    /// Codec bootstrap bytes. For FLAC: `fLaC` marker + STREAMINFO metadata
    /// block with the last-metadata-block flag set.
    pub codec_header: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum StreamHeaderError {
    #[error("bad stream header magic")]
    BadMagic,
    #[error("unsupported stream header version {0}")]
    UnsupportedVersion(u8),
    #[error("truncated stream header")]
    Truncated,
    #[error("stream header device description is not UTF-8")]
    BadDeviceDesc,
    #[error("trailing bytes after stream header")]
    TrailingBytes,
}

impl StreamHeaderV1 {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(32 + self.device_desc.len() + self.codec_header.len());
        out.extend_from_slice(&STREAM_HEADER_MAGIC);
        out.push(1u8); // header version
        out.push(self.codec);
        out.push(self.channels);
        out.push(self.bits_per_sample);
        out.extend_from_slice(&self.sample_rate.to_le_bytes());
        out.extend_from_slice(&self.clock_epoch_us.to_le_bytes());
        out.extend_from_slice(&self.wall_clock_hint_ms.to_le_bytes());
        let desc = self.device_desc.as_bytes();
        let desc_len = desc.len().min(u16::MAX as usize);
        out.extend_from_slice(&(desc_len as u16).to_le_bytes());
        out.extend_from_slice(&desc[..desc_len]);
        let ch_len = self.codec_header.len().min(u16::MAX as usize);
        out.extend_from_slice(&(ch_len as u16).to_le_bytes());
        out.extend_from_slice(&self.codec_header[..ch_len]);
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, StreamHeaderError> {
        use StreamHeaderError as E;
        if bytes.len() < 4 {
            return Err(E::Truncated);
        }
        if bytes[0..4] != STREAM_HEADER_MAGIC {
            return Err(E::BadMagic);
        }
        if bytes.len() < 5 {
            return Err(E::Truncated);
        }
        if bytes[4] != 1 {
            return Err(E::UnsupportedVersion(bytes[4]));
        }
        if bytes.len() < 30 {
            return Err(E::Truncated);
        }
        let codec = bytes[5];
        let channels = bytes[6];
        let bits_per_sample = bytes[7];
        let sample_rate = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
        let clock_epoch_us = u64::from_le_bytes(bytes[12..20].try_into().unwrap());
        let wall_clock_hint_ms = u64::from_le_bytes(bytes[20..28].try_into().unwrap());
        let desc_len = u16::from_le_bytes(bytes[28..30].try_into().unwrap()) as usize;
        let desc_end = 30usize.checked_add(desc_len).ok_or(E::Truncated)?;
        if bytes.len() < desc_end + 2 {
            return Err(E::Truncated);
        }
        let device_desc =
            String::from_utf8(bytes[30..desc_end].to_vec()).map_err(|_| E::BadDeviceDesc)?;
        let ch_len = u16::from_le_bytes(bytes[desc_end..desc_end + 2].try_into().unwrap()) as usize;
        let ch_end = (desc_end + 2).checked_add(ch_len).ok_or(E::Truncated)?;
        if bytes.len() < ch_end {
            return Err(E::Truncated);
        }
        if bytes.len() > ch_end {
            return Err(E::TrailingBytes);
        }
        let codec_header = bytes[desc_end + 2..ch_end].to_vec();
        Ok(Self {
            codec,
            channels,
            bits_per_sample,
            sample_rate,
            clock_epoch_us,
            wall_clock_hint_ms,
            device_desc,
            codec_header,
        })
    }
}

/// Build the seq-0 chunk for a stream (§6.2: `first_sample_index` and
/// `sample_count` are 0).
pub fn header_chunk(stream: StreamKey, header: &StreamHeaderV1) -> AudioChunk {
    let payload = header.encode();
    AudioChunk {
        stream,
        seq: 0,
        first_sample_index: 0,
        sample_count: 0,
        capture_ts_us: header.clock_epoch_us,
        crc32c: crc32c(&payload),
        payload,
    }
}

/// Build an audio chunk (seq >= 1) with its CRC computed.
pub fn audio_chunk(
    stream: StreamKey,
    seq: u32,
    first_sample_index: u64,
    sample_count: u32,
    capture_ts_us: u64,
    payload: Vec<u8>,
) -> AudioChunk {
    debug_assert!(seq >= 1, "seq 0 is the stream header");
    AudioChunk {
        stream,
        seq,
        first_sample_index,
        sample_count,
        capture_ts_us,
        crc32c: crc32c(&payload),
        payload,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header() -> StreamHeaderV1 {
        StreamHeaderV1 {
            codec: CODEC_FLAC,
            channels: 1,
            bits_per_sample: 24,
            sample_rate: 48_000,
            clock_epoch_us: 123_456_789,
            wall_clock_hint_ms: 1_760_000_000_000,
            device_desc: "iPhone 15 · Safari 26".to_string(),
            codec_header: vec![0x66, 0x4C, 0x61, 0x43, 0x80, 0x00, 0x00, 0x22],
        }
    }

    #[test]
    fn roundtrip() {
        let h = header();
        assert_eq!(StreamHeaderV1::decode(&h.encode()), Ok(h));
    }

    #[test]
    fn truncation_never_panics() {
        let bytes = header().encode();
        for cut in 0..bytes.len() {
            assert!(StreamHeaderV1::decode(&bytes[..cut]).is_err(), "cut={cut}");
        }
    }

    #[test]
    fn header_chunk_is_seq0_with_zero_domain() {
        let stream = StreamKey {
            take_id: [1; 16],
            stream_id: [2; 16],
        };
        let chunk = header_chunk(stream, &header());
        assert_eq!(chunk.seq, 0);
        assert_eq!(chunk.first_sample_index, 0);
        assert_eq!(chunk.sample_count, 0);
        assert_eq!(chunk.crc32c, crate::crc32c::crc32c(&chunk.payload));
        assert_eq!(StreamHeaderV1::decode(&chunk.payload), Ok(header()));
    }
}
