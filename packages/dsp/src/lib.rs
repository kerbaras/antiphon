//! Alignment DSP (docs/ARCHITECTURE.md §4).
//!
//! Chirp calibration via cross-correlation (`realfft`) and per-phone drift
//! correction via resampling (`rubato`). The legitimate WASM workloads.

pub mod chirp;
pub mod correlate;
pub mod drift;
