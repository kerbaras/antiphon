//! DSP property suite (W3-E), in the style of the core/codec proptests.
//!
//! Chirp: exact sample counts, finiteness, and the spec'd amplitude bound
//! for arbitrary valid specs; totality (empty, never panic) for hostile
//! specs. Correlation: locating a reference shifted by k reports lag
//! exactly k; degenerate and non-finite inputs return None, never garbage.
//! Drift: arbitrary valid configs never panic on arbitrary windows, and
//! NaN/Inf samples can never propagate into an estimate.

use antiphon_dsp::chirp::{MAX_ESS_SAMPLES, generate_ess};
use antiphon_dsp::correlate::{correlation_series, cross_correlate_peak};
use antiphon_dsp::drift::{DriftConfig, DriftEstimator};
use proptest::prelude::*;

/// Deterministic zero-mean noise in [-amplitude, amplitude].
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

proptest! {
    /// Valid specs: exact sample count (round(rate·ms/1000)), every sample
    /// finite, peak amplitude within the spec'd gain (fades only reduce it).
    #[test]
    fn chirp_valid_specs_exact_count_bounded_amplitude(
        rate in prop_oneof![Just(44_100u32), Just(48_000u32), 8_000u32..192_000],
        start_hz in 20.0f32..20_000.0,
        end_hz in 20.0f32..20_000.0,
        duration_ms in 10.0f32..2_000.0,
        gain_dbfs in -60.0f32..=0.0,
    ) {
        let sweep = generate_ess(rate, start_hz, end_hz, duration_ms, gain_dbfs);
        let expected =
            ((f64::from(rate) * f64::from(duration_ms)) / 1_000.0).round() as usize;
        prop_assert_eq!(sweep.len(), expected);
        let bound = 10f64.powf(f64::from(gain_dbfs) / 20.0) as f32 * (1.0 + 1e-6);
        for (i, &s) in sweep.iter().enumerate() {
            prop_assert!(s.is_finite(), "sample {i} not finite: {s}");
            prop_assert!(s.abs() <= bound, "sample {i} = {s} exceeds {bound}");
        }
    }

    /// Hostile specs (NaN, ±Inf, negatives, absurd durations): total —
    /// empty or bounded output, never a panic, never a non-finite sample.
    #[test]
    fn chirp_hostile_specs_total(
        rate in any::<u32>(),
        start_hz in any::<f32>(),
        end_hz in any::<f32>(),
        duration_ms in any::<f32>(),
        gain_dbfs in any::<f32>(),
    ) {
        let sweep = generate_ess(rate, start_hz, end_hz, duration_ms, gain_dbfs);
        prop_assert!(sweep.len() <= MAX_ESS_SAMPLES);
        prop_assert!(sweep.iter().all(|s| s.is_finite()));
    }

    /// Matched filtering is exact: a reference placed at offset k inside a
    /// zero-padded signal correlates with peak lag exactly k and a
    /// normalized peak of ~1 (the window IS the reference).
    #[test]
    fn correlation_peak_moves_with_shift(
        seed in any::<u64>(),
        ref_len in 64usize..1024,
        place in 0usize..2048,
        tail in 0usize..512,
    ) {
        let reference = noise(ref_len, seed, 1.0);
        let mut signal = vec![0.0f32; place];
        signal.extend_from_slice(&reference);
        signal.extend(std::iter::repeat_n(0.0f32, tail));
        let m = cross_correlate_peak(&signal, &reference)
            .expect("clean embedded copy must match");
        prop_assert_eq!(m.lag_samples, place, "peak {} conf {}", m.peak, m.confidence);
        prop_assert!((m.peak - 1.0).abs() < 1e-2, "peak {}", m.peak);
    }

    /// correlate(x, x) peaks at lag 0 with normalized peak ~1 — the
    /// self-similarity identity, via the raw series (single valid lag) and
    /// with padding (many lags).
    #[test]
    fn self_correlation_peaks_at_zero(seed in any::<u64>(), len in 64usize..2048) {
        let x = noise(len, seed, 0.8);
        let series = correlation_series(&x, &x).expect("valid inputs");
        prop_assert_eq!(series.len(), 1);
        let energy: f32 = x.iter().map(|v| v * v).sum();
        prop_assert!(
            (series[0] - energy).abs() <= energy * 1e-3,
            "corr {} vs energy {energy}", series[0]
        );

        let mut padded = x.clone();
        padded.extend(std::iter::repeat_n(0.0f32, 512));
        let m = cross_correlate_peak(&padded, &x).expect("self-match");
        prop_assert_eq!(m.lag_samples, 0);
        prop_assert!((m.peak - 1.0).abs() < 1e-2, "peak {}", m.peak);
    }

    /// Silence returns None at any shape — never a fabricated lag.
    #[test]
    fn silence_returns_none(sig_len in 0usize..4096, ref_len in 0usize..1024) {
        let signal = vec![0.0f32; sig_len];
        let reference = vec![0.0f32; ref_len];
        prop_assert!(cross_correlate_peak(&signal, &reference).is_none());
    }

    /// Non-finite samples anywhere in either input: rejected (None), so a
    /// NaN can never launder itself into an alignment or drift estimate.
    #[test]
    fn non_finite_inputs_rejected(
        seed in any::<u64>(),
        sig_len in 64usize..1024,
        ref_len in 16usize..64,
        poison_signal in any::<bool>(),
        poison_index in any::<prop::sample::Index>(),
        poison in prop_oneof![
            Just(f32::NAN),
            Just(f32::INFINITY),
            Just(f32::NEG_INFINITY)
        ],
    ) {
        let mut signal = noise(sig_len, seed, 0.5);
        let mut reference = noise(ref_len, seed ^ 0xDEAD_BEEF, 0.5);
        if poison_signal {
            let i = poison_index.index(signal.len());
            signal[i] = poison;
        } else {
            let i = poison_index.index(reference.len());
            reference[i] = poison;
        }
        prop_assert!(correlation_series(&signal, &reference).is_none());
        prop_assert!(cross_correlate_peak(&signal, &reference).is_none());
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// Arbitrary-but-valid DriftConfig (finite, positive knobs of any
    /// magnitude) driven over arbitrary noise windows: never panics, and
    /// the estimate is always finite with confidence in [0, 1].
    #[test]
    fn drift_estimator_total_for_valid_configs(
        sample_rate in 1u32..200_000,
        window_len in 0usize..4_096,
        interval in 0usize..50_000,
        max_initial_offset in 0usize..10_000,
        max_drift_ppm in 0.0f64..100_000.0,
        min_rms in 0.0f32..1.0,
        min_peak in 0.0f32..1.0,
        min_prominence in 0.0f32..10.0,
        ref_len in 0usize..50_000,
        target_len in 0usize..50_000,
        seed in any::<u64>(),
    ) {
        let config = DriftConfig {
            sample_rate,
            window_len,
            interval,
            max_initial_offset,
            max_drift_ppm,
            min_rms,
            min_peak,
            min_prominence,
        };
        let mut est = DriftEstimator::with_config(config, ref_len, target_len);
        // Bounded drive: interval may be tiny, so cap the loop rather than
        // walk 50k windows.
        for i in 0..24 {
            let Some(req) = est.next_request() else { break };
            let reference = noise(req.ref_len, seed ^ i, 0.5);
            let target = noise(req.target_len, seed.rotate_left(i as u32), 0.5);
            est.push_window(&reference, &target).expect("shapes from request");
        }
        let e = est.estimate();
        prop_assert!(e.ratio.is_finite(), "ratio {}", e.ratio);
        prop_assert!(e.initial_offset_samples.is_finite());
        prop_assert!(
            (0.0..=1.0).contains(&e.confidence),
            "confidence {}", e.confidence
        );
        prop_assert!(e.windows_used <= e.windows_total);
    }

    /// Windows poisoned with NaN/Inf are rejected wholesale: they count in
    /// `windows_total`, never in `windows_used`, and the estimate stays the
    /// honest no-drift fallback rather than NaN.
    #[test]
    fn drift_rejects_non_finite_windows(
        seed in any::<u64>(),
        poison in prop_oneof![
            Just(f32::NAN),
            Just(f32::INFINITY),
            Just(f32::NEG_INFINITY)
        ],
    ) {
        let config = DriftConfig {
            sample_rate: 16_000,
            window_len: 2_000,
            interval: 8_000,
            max_initial_offset: 800,
            max_drift_ppm: 1_500.0,
            min_rms: 1.0e-3,
            min_peak: 0.25,
            min_prominence: 1.2,
        };
        let mut est = DriftEstimator::with_config(config, 64_000, 64_000);
        let mut pushed = 0usize;
        while let Some(req) = est.next_request() {
            let reference = noise(req.ref_len, seed, 0.5);
            let mut target = noise(req.target_len, seed, 0.5);
            let i = (seed as usize) % target.len();
            target[i] = poison;
            est.push_window(&reference, &target).expect("shapes from request");
            pushed += 1;
        }
        prop_assert!(pushed > 0, "schedule must produce windows");
        let e = est.estimate();
        prop_assert_eq!(e.windows_used, 0, "poisoned windows must be gated");
        prop_assert_eq!(e.ratio, 1.0);
        prop_assert_eq!(e.confidence, 0.0);
        prop_assert!(e.initial_offset_samples == 0.0);
        prop_assert_eq!(e.windows_total, pushed);
    }
}
