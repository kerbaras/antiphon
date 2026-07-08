//! Calibration chirp synthesis (RFC §10).
//!
//! Exponential sine sweep (ESS): the desk plays it through its speakers,
//! every phone captures it acoustically, and cross-correlation against this
//! exact reference nails each device's total offset. The same function
//! produces both the playback buffer and the correlation reference — one
//! source of truth for the waveform.

/// Longest sweep this generator will produce: 60 s at 192 kHz. The spec'd
/// calibration chirp is 1 s (§10); anything beyond this bound is a caller
/// bug or hostile input, answered with an empty buffer instead of a
/// multi-gigabyte allocation (this function is exported verbatim to JS).
pub const MAX_ESS_SAMPLES: usize = 192_000 * 60;

/// Generate one exponential sine sweep.
///
/// `start_hz` → `end_hz` over `duration_ms`, peak amplitude `gain_dbfs`
/// (≤ 0), with 5 ms raised-cosine fades at both ends to keep speakers and
/// correlators happy.
///
/// Total for arbitrary input: degenerate specs (non-finite or non-positive
/// frequencies/duration, non-finite or positive gain, zero rate, oversize
/// sweep) yield an empty buffer — never a panic, never a non-finite sample.
pub fn generate_ess(
    sample_rate: u32,
    start_hz: f32,
    end_hz: f32,
    duration_ms: f32,
    gain_dbfs: f32,
) -> Vec<f32> {
    if !start_hz.is_finite()
        || !end_hz.is_finite()
        || !duration_ms.is_finite()
        || !gain_dbfs.is_finite()
        || gain_dbfs > 0.0
    {
        return Vec::new();
    }
    let n = ((f64::from(sample_rate) * f64::from(duration_ms)) / 1_000.0).round() as usize;
    if n == 0 || n > MAX_ESS_SAMPLES || start_hz <= 0.0 || end_hz <= 0.0 {
        return Vec::new();
    }
    let amplitude = 10f64.powf(f64::from(gain_dbfs) / 20.0);
    let f1 = f64::from(start_hz);
    let f2 = f64::from(end_hz);
    let duration_s = n as f64 / f64::from(sample_rate);
    let k = (f2 / f1).ln();
    let fade = (sample_rate as usize * 5 / 1_000).min(n / 2).max(1);

    (0..n)
        .map(|i| {
            let t = i as f64 / f64::from(sample_rate);
            // k == 0 (start == end) makes the ESS formula 0/0; its limit is
            // a pure tone at f1 — emit that instead of NaN samples.
            let phase = if k == 0.0 {
                2.0 * std::f64::consts::PI * f1 * t
            } else {
                2.0 * std::f64::consts::PI * f1 * duration_s / k
                    * ((t * k / duration_s).exp() - 1.0)
            };
            // Raised-cosine fade in/out.
            let window = if i < fade {
                0.5 * (1.0 - (std::f64::consts::PI * (i as f64 / fade as f64)).cos())
            } else if i >= n - fade {
                0.5 * (1.0 - (std::f64::consts::PI * ((n - 1 - i) as f64 / fade as f64)).cos())
            } else {
                1.0
            };
            (amplitude * phase.sin() * window) as f32
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sweep_shape() {
        let rate = 48_000;
        let sweep = generate_ess(rate, 200.0, 8_000.0, 1_000.0, -12.0);
        assert_eq!(sweep.len(), 48_000);
        // Peak near -12 dBFS (0.251), never clipping.
        let peak = sweep.iter().fold(0f32, |m, &s| m.max(s.abs()));
        assert!(peak <= 0.2512, "peak {peak}");
        assert!(peak > 0.24, "peak {peak}");
        // Fades: endpoints tiny.
        assert!(sweep[0].abs() < 1e-3);
        assert!(sweep[sweep.len() - 1].abs() < 2e-2);
        // Frequency rises: zero-crossing count in the last 100ms far exceeds
        // the first 100ms.
        let crossings = |slice: &[f32]| slice.windows(2).filter(|w| w[0] * w[1] < 0.0).count();
        let head = crossings(&sweep[..4_800]);
        let tail = crossings(&sweep[43_200..]);
        assert!(tail > head * 10, "head {head} tail {tail}");
    }

    #[test]
    fn degenerate_inputs_empty() {
        assert!(generate_ess(48_000, 0.0, 8_000.0, 1_000.0, -12.0).is_empty());
        assert!(generate_ess(48_000, 200.0, 8_000.0, 0.0, -12.0).is_empty());
    }
}
