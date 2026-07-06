//! Protocol constants (RFC 0001 §13).

/// First two bytes of every data-plane frame: `b"AN"`.
pub const MAGIC: [u8; 2] = *b"AN";

/// Data-plane protocol version carried in every frame header.
pub const PROTOCOL_VERSION: u8 = 0x01;

/// A frame MUST NOT exceed this size (§4.2).
pub const MAX_FRAME_BYTES: usize = 65_536;

/// Nominal chunk duration (§6.3).
pub const NOMINAL_CHUNK_MS: u32 = 500;

/// Minimum non-final chunk duration (§6.3).
pub const MIN_CHUNK_MS: u32 = 100;

/// ACK_STATUS cadence per active stream (§6.4).
pub const ACK_INTERVAL_MS: u32 = 2_000;

/// Minimum ring retention (§9). 60 s is RECOMMENDED.
pub const RING_MIN_SECONDS: u32 = 30;

/// TIME_PING cadence (§6.7).
pub const TIME_SYNC_INTERVAL_MS: u32 = 5_000;

/// Sliding window for min-RTT filtering (§6.7).
pub const TIME_SYNC_WINDOW: usize = 16;

/// `chwm` sentinel meaning "nothing contiguous yet" (§6.4).
pub const CHWM_NONE: u32 = 0xFFFF_FFFF;

/// Recorder→sink data channel label (§4.2).
pub const CHANNEL_LABEL_DATA: &str = "antiphon/1";

/// Sink↔sink replication channel label (§4.2).
pub const CHANNEL_LABEL_SYNC: &str = "antiphon-sync/1";

/// Common frame header length in bytes (§6.1).
pub const FRAME_HEADER_LEN: usize = 4;

/// AUDIO_CHUNK header length including the common header (§6.2).
pub const AUDIO_CHUNK_HEADER_LEN: usize = 68;

/// Maximum payload bytes that fit in one AUDIO_CHUNK frame.
pub const MAX_CHUNK_PAYLOAD_BYTES: usize = MAX_FRAME_BYTES - AUDIO_CHUNK_HEADER_LEN;
