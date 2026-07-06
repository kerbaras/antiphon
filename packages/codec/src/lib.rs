//! FLAC encoding for the capture pipeline (docs/ARCHITECTURE.md §2.1).
//!
//! Pure-Rust `flacenc` — no C toolchain, runtime-free when compiled to WASM.
//! Encodes raw PCM frames from the capture ring into chunk payloads.

pub mod encoder;
