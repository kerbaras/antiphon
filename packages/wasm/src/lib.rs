//! Thin wasm-bindgen facade over `antiphon-core`/`-codec`/`-dsp`.
//!
//! Built by wasm-pack into `packages/core-wasm` — the ONLY way TS consumes
//! Rust. Keep this crate glue-only; logic lives in the inner crates.
//! (Later: sibling `ffi/` crates for UniFFI mobile and napi-rs server.)

use wasm_bindgen::prelude::*;

/// Smoke-test export proving the wasm pipeline works end to end.
/// Replace with real encoder/DSP bindings as the inner crates land.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
