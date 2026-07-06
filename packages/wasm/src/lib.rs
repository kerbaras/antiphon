//! Thin wasm-bindgen facade over `antiphon-core`/`-codec`.
//!
//! Built by wasm-pack into `packages/core-wasm` — the ONLY way TS consumes
//! Rust, in both the browser (encoder worker, desk sink worker) and Node
//! (server ingest). Glue only: every protocol decision lives in the inner
//! crates. Timestamps cross the boundary as f64 microseconds (exact far
//! beyond any session length); UUIDs as 16-byte arrays; frames as bytes.

mod json;
mod recorder;
mod sink;

pub use recorder::RecorderEngine;
pub use sink::{IngestResult, SinkEngine, TimeSyncSession};

use wasm_bindgen::prelude::*;

/// Smoke-test export proving the wasm pipeline works end to end.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Protocol constants exposed for TS consumers (§13).
#[wasm_bindgen]
pub fn constants_json() -> String {
    format!(
        concat!(
            "{{\"maxFrameBytes\":{},\"nominalChunkMs\":{},\"minChunkMs\":{},",
            "\"ackIntervalMs\":{},\"ringMinSeconds\":{},\"timeSyncIntervalMs\":{},",
            "\"channelLabelData\":\"{}\",\"channelLabelSync\":\"{}\"}}"
        ),
        antiphon_core::constants::MAX_FRAME_BYTES,
        antiphon_core::constants::NOMINAL_CHUNK_MS,
        antiphon_core::constants::MIN_CHUNK_MS,
        antiphon_core::constants::ACK_INTERVAL_MS,
        antiphon_core::constants::RING_MIN_SECONDS,
        antiphon_core::constants::TIME_SYNC_INTERVAL_MS,
        antiphon_core::constants::CHANNEL_LABEL_DATA,
        antiphon_core::constants::CHANNEL_LABEL_SYNC,
    )
}

fn parse_id(bytes: &[u8], what: &str) -> Result<[u8; 16], JsError> {
    bytes
        .try_into()
        .map_err(|_| JsError::new(&format!("{what} must be exactly 16 bytes")))
}
