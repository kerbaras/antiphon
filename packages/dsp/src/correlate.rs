//! Cross-correlation for acoustic alignment (RFC §10, architecture §4).
//!
//! FFT-based matched filtering: find where the known calibration chirp sits
//! inside a captured stream. Every stream heard the same chirp at the same
//! room instant, so the per-stream chirp position maps sample domains onto
//! one wall clock — including each device's unknown input latency.

use realfft::RealFftPlanner;
use realfft::num_complex::Complex;

/// Result of locating a reference inside a signal.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChirpMatch {
    /// Sample index in `signal` where the reference best aligns.
    pub lag_samples: usize,
    /// Normalized correlation peak (0..~1 for a clean acoustic path).
    pub peak: f32,
    /// Peak-to-sidelobe ratio: how much the best match towers over the best
    /// non-adjacent alternative. Below ~2 the match is untrustworthy.
    pub confidence: f32,
}

/// Raw linear cross-correlation for every valid lag:
/// `out[lag] = Σᵢ signal[lag+i]·reference[i]`, lag ∈ `0..=signal.len()-reference.len()`.
/// The shared engine behind chirp location and drift window re-correlation.
/// Returns `None` for degenerate inputs (empty reference, or reference
/// longer than signal).
pub fn correlation_series(signal: &[f32], reference: &[f32]) -> Option<Vec<f32>> {
    if reference.is_empty() || signal.len() < reference.len() {
        return None;
    }
    let fft_len = (signal.len() + reference.len()).next_power_of_two();

    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(fft_len);
    let ifft = planner.plan_fft_inverse(fft_len);

    let mut sig_buf = vec![0.0f32; fft_len];
    sig_buf[..signal.len()].copy_from_slice(signal);
    let mut ref_buf = vec![0.0f32; fft_len];
    ref_buf[..reference.len()].copy_from_slice(reference);

    let mut sig_spec = fft.make_output_vec();
    let mut ref_spec = fft.make_output_vec();
    fft.process(&mut sig_buf, &mut sig_spec).ok()?;
    fft.process(&mut ref_buf, &mut ref_spec).ok()?;

    // Correlation = IFFT( S · conj(R) )
    let mut cross: Vec<Complex<f32>> = sig_spec
        .iter()
        .zip(ref_spec.iter())
        .map(|(s, r)| s * r.conj())
        .collect();
    let mut corr = vec![0.0f32; fft_len];
    ifft.process(&mut cross, &mut corr).ok()?;

    // ifft output is unnormalized: scale by 1/fft_len so entries are true
    // dot products, then keep only the valid (non-wrapped) lags.
    let scale = 1.0 / fft_len as f32;
    corr.truncate(signal.len() - reference.len() + 1);
    for v in &mut corr {
        *v *= scale;
    }
    Some(corr)
}

/// Cross-correlate `signal` against `reference`, returning the best lag.
/// Returns `None` for degenerate inputs (empty, silent, or reference longer
/// than signal).
pub fn cross_correlate_peak(signal: &[f32], reference: &[f32]) -> Option<ChirpMatch> {
    cross_correlate_peak_excluding(signal, reference, &[])
}

/// As `cross_correlate_peak`, but lags at `best ± offset` for each entry in
/// `expected_echo_offsets` are excluded from the sidelobe scan — used when
/// the reference is known to repeat in the signal (chirp `repeats` > 1), so
/// the sibling sweep's equally-strong peak doesn't destroy confidence.
pub fn cross_correlate_peak_excluding(
    signal: &[f32],
    reference: &[f32],
    expected_echo_offsets: &[usize],
) -> Option<ChirpMatch> {
    let corr = correlation_series(signal, reference)?;
    let ref_energy: f32 = reference.iter().map(|v| v * v).sum();
    if ref_energy <= f32::EPSILON {
        return None;
    }

    // Find the global peak among valid lags.
    let mut best_lag = 0usize;
    let mut best_val = f32::MIN;
    for (lag, &value) in corr.iter().enumerate() {
        let v = value.abs();
        if v > best_val {
            best_val = v;
            best_lag = lag;
        }
    }
    if best_val <= f32::EPSILON {
        return None;
    }

    // Normalize the peak by reference energy × local signal energy so the
    // score is scale-invariant (≈ cosine similarity at the matched window).
    let window = &signal[best_lag..(best_lag + reference.len()).min(signal.len())];
    let sig_energy: f32 = window.iter().map(|v| v * v).sum();
    let denom = (ref_energy * sig_energy).sqrt();
    let peak = if denom > f32::EPSILON {
        best_val / denom
    } else {
        0.0
    };

    // Peak-to-sidelobe: best value outside ± half a reference of the peak
    // and outside every expected-echo zone (repeat sweeps).
    let guard = reference.len() / 2;
    let excluded = |lag: usize| -> bool {
        if lag.abs_diff(best_lag) <= guard {
            return true;
        }
        expected_echo_offsets.iter().any(|&off| {
            lag.abs_diff(best_lag.saturating_add(off)) <= guard
                || best_lag >= off && lag.abs_diff(best_lag - off) <= guard
        })
    };
    let mut sidelobe = 0.0f32;
    for (lag, &value) in corr.iter().enumerate() {
        if !excluded(lag) {
            sidelobe = sidelobe.max(value.abs());
        }
    }
    let confidence = if sidelobe > f32::EPSILON {
        best_val / sidelobe
    } else {
        f32::MAX
    };

    Some(ChirpMatch {
        lag_samples: best_lag,
        peak,
        confidence,
    })
}

/// Locate the calibration chirp (§10 spec) inside a captured stream.
/// Generates the reference sweep internally so playback and detection can
/// never drift apart. `repeats`/`gap_ms` describe the emission schedule so
/// sibling sweeps don't count as sidelobes.
#[allow(clippy::too_many_arguments)]
pub fn find_chirp(
    signal: &[f32],
    sample_rate: u32,
    start_hz: f32,
    end_hz: f32,
    duration_ms: f32,
    gain_dbfs: f32,
    repeats: u32,
    gap_ms: f32,
) -> Option<ChirpMatch> {
    let reference =
        crate::chirp::generate_ess(sample_rate, start_hz, end_hz, duration_ms, gain_dbfs);
    let interval =
        ((f64::from(duration_ms) + f64::from(gap_ms)) / 1_000.0 * f64::from(sample_rate)) as usize;
    let echoes: Vec<usize> = (1..repeats.max(1)).map(|k| k as usize * interval).collect();
    cross_correlate_peak_excluding(signal, &reference, &echoes)
}

/// Sweep repeat interval in samples for a given spec — used to resolve the
/// which-sweep-did-I-lock-onto ambiguity across streams.
pub fn repeat_interval_samples(sample_rate: u32, duration_ms: f32, gap_ms: f32) -> usize {
    ((f64::from(duration_ms) + f64::from(gap_ms)) / 1_000.0 * f64::from(sample_rate)) as usize
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chirp::generate_ess;

    fn noise(len: usize, seed: u64, amplitude: f32) -> Vec<f32> {
        let mut state = seed | 1;
        (0..len)
            .map(|_| {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                (((state >> 33) as i32) as f32 / i32::MAX as f32) * amplitude
            })
            .collect()
    }

    #[test]
    fn recovers_embedded_chirp_offset_exactly() {
        let rate = 48_000;
        let chirp = generate_ess(rate, 200.0, 8_000.0, 1_000.0, -12.0);
        let offset = 123_456;
        let mut signal = noise(rate as usize * 10, 7, 0.02); // -34 dBFS room noise
        for (i, &c) in chirp.iter().enumerate() {
            signal[offset + i] += c * 0.5; // chirp through air, attenuated
        }
        let m = find_chirp(&signal, rate, 200.0, 8_000.0, 1_000.0, -12.0, 1, 0.0).expect("match");
        assert!(
            m.lag_samples.abs_diff(offset) <= 1,
            "lag {} vs {}",
            m.lag_samples,
            offset
        );
        assert!(m.confidence > 3.0, "confidence {}", m.confidence);
    }

    /// The real emission schedule (§10): TWO sweeps, 1s apart. The sibling
    /// sweep must not count as a sidelobe, or confidence collapses to ~1.
    #[test]
    fn repeated_sweeps_keep_confidence() {
        let rate = 48_000;
        let chirp = generate_ess(rate, 200.0, 8_000.0, 1_000.0, -12.0);
        let interval = repeat_interval_samples(rate, 1_000.0, 1_000.0);
        let offset = 90_000;
        let mut signal = noise(rate as usize * 10, 21, 0.02);
        for k in 0..2 {
            for (i, &c) in chirp.iter().enumerate() {
                signal[offset + k * interval + i] += c * 0.5;
            }
        }
        // Without echo exclusion: the twin sweep caps confidence at ~1.
        let naive = find_chirp(&signal, rate, 200.0, 8_000.0, 1_000.0, -12.0, 1, 0.0).unwrap();
        assert!(
            naive.confidence < 1.5,
            "naive confidence {}",
            naive.confidence
        );
        // With the schedule declared: confident lock on the FIRST sweep.
        let m = find_chirp(&signal, rate, 200.0, 8_000.0, 1_000.0, -12.0, 2, 1_000.0).unwrap();
        assert!(
            m.lag_samples.abs_diff(offset) <= 1 || m.lag_samples.abs_diff(offset + interval) <= 1,
            "lag {}",
            m.lag_samples
        );
        assert!(m.confidence > 3.0, "confidence {}", m.confidence);
    }

    #[test]
    fn two_streams_relative_offset() {
        // The actual alignment use-case: same chirp lands at different
        // positions in two streams; the lag difference IS the clock offset.
        let rate = 48_000;
        let chirp = generate_ess(rate, 200.0, 8_000.0, 1_000.0, -12.0);
        let make = |offset: usize, seed: u64| {
            let mut s = noise(rate as usize * 6, seed, 0.01);
            for (i, &c) in chirp.iter().enumerate() {
                s[offset + i] += c * 0.4;
            }
            s
        };
        let a = make(48_000, 11); // chirp at 1.0s
        let b = make(60_000, 13); // chirp at 1.25s
        let ma = find_chirp(&a, rate, 200.0, 8_000.0, 1_000.0, -12.0, 1, 0.0).unwrap();
        let mb = find_chirp(&b, rate, 200.0, 8_000.0, 1_000.0, -12.0, 1, 0.0).unwrap();
        let delta = mb.lag_samples as i64 - ma.lag_samples as i64;
        assert!((delta - 12_000).abs() <= 2, "delta {delta}");
    }

    #[test]
    fn silence_and_pure_noise_are_low_confidence() {
        let rate = 48_000;
        assert!(
            find_chirp(
                &vec![0.0; rate as usize * 3],
                rate,
                200.0,
                8_000.0,
                1_000.0,
                -12.0,
                2,
                1_000.0
            )
            .is_none()
        );
        let n = noise(rate as usize * 5, 99, 0.3);
        if let Some(m) = find_chirp(&n, rate, 200.0, 8_000.0, 1_000.0, -12.0, 2, 1_000.0) {
            assert!(
                m.confidence < 2.5,
                "noise matched with confidence {}",
                m.confidence
            );
        }
    }

    #[test]
    fn degenerate_inputs() {
        assert!(cross_correlate_peak(&[], &[1.0]).is_none());
        assert!(cross_correlate_peak(&[1.0, 2.0], &[1.0, 2.0, 3.0]).is_none());
    }
}
