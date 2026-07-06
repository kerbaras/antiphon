//! Chunk framing: fixed binary header + opaque payload (FLAC audio).
//! Wire format shared by every consumer: TS via WASM, mobile via UniFFI,
//! server via napi-rs.

/// One sequence-numbered, idempotent unit of encoded audio.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub seq: u64,
    /// Capture time in microseconds since session epoch. Coarse hint only —
    /// precise placement comes from acoustic alignment.
    pub capture_ts_us: u64,
    pub payload: Vec<u8>,
}
