//! Alignment DSP (docs/ARCHITECTURE.md §4).
//!
//! Chirp calibration via cross-correlation (`realfft`) and per-phone drift
//! estimation via periodic re-correlation (see `drift`); playback applies
//! the fitted ratio, `rubato` is reserved for the offline render. The
//! legitimate WASM workloads.

pub mod chirp;
pub mod content;
pub mod correlate;
pub mod drift;
