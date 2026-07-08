//! Drift-estimation facade (ARCHITECTURE §4 layer 3). Pull-driven so full
//! streams never cross the JS↔wasm boundary: TS asks for the next window,
//! slices ~seconds out of its AudioBuffers, and pushes them in — a 45-min
//! take never needs a half-GB copy into wasm memory. All policy (window
//! schedule, gating, robust fit) lives in `antiphon_dsp::drift`.

use wasm_bindgen::prelude::*;

use crate::json::Obj;

#[wasm_bindgen]
pub struct DriftEstimator {
    inner: antiphon_dsp::drift::DriftEstimator,
}

#[wasm_bindgen]
impl DriftEstimator {
    /// `reference_len`/`target_len`: total samples available per stream,
    /// both at the same nominal rate and already coarsely aligned (chirp).
    /// Which stream is the reference is the caller's policy.
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: u32, reference_len: u32, target_len: u32) -> DriftEstimator {
        DriftEstimator {
            inner: antiphon_dsp::drift::DriftEstimator::new(
                sample_rate,
                reference_len as usize,
                target_len as usize,
            ),
        }
    }

    /// Next window wanted as JSON
    /// `{"targetStart":n,"targetLen":n,"refStart":n,"refLen":n}`, or null
    /// once every scheduled window has been pushed.
    pub fn next_request_json(&self) -> Option<String> {
        self.inner.next_request().map(|r| {
            Obj::new()
                .num("targetStart", r.target_start as f64)
                .num("targetLen", r.target_len as f64)
                .num("refStart", r.ref_start as f64)
                .num("refLen", r.ref_len as f64)
                .build()
        })
    }

    /// Feed the slices for the current `next_request_json` window.
    pub fn push_window(
        &mut self,
        reference_segment: &[f32],
        target_window: &[f32],
    ) -> Result<(), JsError> {
        self.inner
            .push_window(reference_segment, target_window)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Robust-fit result as JSON `{"ratio":r,"ppm":p,"initialOffsetSamples":o,
    /// "confidence":c,"windowsUsed":u,"windowsTotal":t}`. Ratio is
    /// target_clock/reference_clock — the playback-rate factor.
    pub fn estimate_json(&self) -> String {
        let est = self.inner.estimate();
        Obj::new()
            .num("ratio", est.ratio)
            .num("ppm", est.ppm())
            .num("initialOffsetSamples", est.initial_offset_samples)
            .num("confidence", f64::from(est.confidence))
            .num("windowsUsed", est.windows_used as f64)
            .num("windowsTotal", est.windows_total as f64)
            .build()
    }
}
