//! Clock-drift estimation (ARCHITECTURE §4 layer 3 — non-negotiable).
//!
//! Every recorder's ADC crystal runs at a slightly different true rate;
//! over a 45-minute take the accumulated error reaches tens of ms —
//! audible smear on a choir. Both inputs here are nominally the same
//! sample rate and already coarsely aligned by chirp correlation; what
//! remains is the *rate* mismatch and the small residual offset.
//!
//! Algorithm:
//! 1. Every `interval` (~30 s) take a short target window (~1 s) and
//!    matched-filter it (`correlate::correlation_series`) against a
//!    reference segment around the same position. The lag search margin
//!    grows linearly with position so late windows still contain the true
//!    lag at any plausible drift.
//! 2. Gate each window: silence (RMS), weak normalized peak (cosine
//!    similarity), and low peak-to-sidelobe prominence outside a ±1 ms
//!    guard (sustained periodic content correlates a pitch period away —
//!    ambiguous, better dropped than mis-locked). Surviving peaks are
//!    refined to sub-sample precision by parabolic interpolation.
//! 3. Robust-fit a line through the (window center, lag) points with
//!    Theil–Sen, drop gross residual outliers once (MAD gate), refit.
//!    With target index t and lag(t) = target − matching reference
//!    position: lag(t) = t·(1 − 1/ratio) + offset₀/ratio, so
//!    `ratio = 1/(1 − slope)` and `offset₀ = intercept·ratio`.
//!
//! `ratio` is target_clock/reference_clock: >1 means the target ADC ran
//! fast (more samples per room-second) and the stream must be rendered
//! proportionally faster to stay locked. The desk applies it at schedule
//! time (`AudioBufferSourceNode.playbackRate`); stored audio is never
//! mutated. Reference choice is the caller's policy — this module is
//! reference-agnostic (today the desk uses its chirp alignment anchor; a
//! future room-reference mic slots in unchanged).
//!
//! The estimator is pull-driven (`next_request` → `push_window`) so full
//! streams never need to cross the wasm boundary — the caller slices only
//! seconds-long windows out of its buffers. `estimate_drift_with` drives
//! the same loop over in-memory slices for native callers and tests.

use crate::correlate::correlation_series;

/// Tunable knobs. [`DriftConfig::for_sample_rate`] gives the product
/// defaults; tests shrink windows/intervals to stay fast.
#[derive(Debug, Clone)]
pub struct DriftConfig {
    pub sample_rate: u32,
    /// Correlation window length (samples). ~1 s: long enough for a sharp
    /// matched peak, short enough that intra-window slip at plausible
    /// drift (≤ ~200 ppm → ≤ ~10 samples) barely blurs it.
    pub window_len: usize,
    /// Spacing between window starts (samples). ~30 s per §4.
    pub interval: usize,
    /// Residual coarse-alignment error tolerated at position 0 (samples).
    pub max_initial_offset: usize,
    /// Largest clock-rate error (ppm) the lag search accommodates; sets
    /// how fast the search margin grows with position.
    pub max_drift_ppm: f64,
    /// Target windows quieter than this RMS are silence: skipped.
    pub min_rms: f32,
    /// Minimum normalized correlation peak (cosine similarity) to trust.
    pub min_peak: f32,
    /// Minimum peak-to-sidelobe ratio outside the ±1 ms guard.
    pub min_prominence: f32,
}

impl DriftConfig {
    pub fn for_sample_rate(sample_rate: u32) -> Self {
        let rate = sample_rate as usize;
        Self {
            sample_rate,
            window_len: rate,              // 1 s
            interval: rate * 30,           // 30 s
            max_initial_offset: rate / 20, // 50 ms
            max_drift_ppm: 1_500.0,
            min_rms: 1.0e-3,
            min_peak: 0.25,
            // Real music is tonal: sidelobes at pitch-period lags routinely
            // reach ~0.7–0.8 of the peak on honest matches. The gate only
            // needs to drop near-perfect periodicity (ties → ~1.0); the
            // Theil–Sen + MAD fit absorbs the occasional survivor.
            min_prominence: 1.2,
        }
    }
}

/// Fitted clock relation between one target stream and the reference.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DriftEstimate {
    /// target_clock / reference_clock. Apply as the playback-rate factor.
    pub ratio: f64,
    /// Residual target-domain offset at reference position 0 (samples):
    /// `target_index ≈ initial_offset + ratio × reference_index`.
    pub initial_offset_samples: f64,
    /// 0..1 heuristic: median normalized peak of the windows the robust
    /// fit kept × the fraction of scheduled windows kept. Silence and
    /// ambiguous content lower it. Not a formal probability.
    pub confidence: f32,
    pub windows_used: usize,
    pub windows_total: usize,
}

impl DriftEstimate {
    /// Rate error in parts per million.
    pub fn ppm(&self) -> f64 {
        (self.ratio - 1.0) * 1.0e6
    }
}

/// One correlation window the estimator wants next: the caller slices
/// these ranges out of its streams and hands them to `push_window`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowRequest {
    pub target_start: usize,
    pub target_len: usize,
    pub ref_start: usize,
    pub ref_len: usize,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DriftError {
    #[error("no window pending: drive push_window from next_request")]
    NoWindowPending,
    #[error(
        "window shape mismatch: expected ref {expected_ref}/target {expected_target}, got ref {got_ref}/target {got_target}"
    )]
    WindowShape {
        expected_ref: usize,
        expected_target: usize,
        got_ref: usize,
        got_target: usize,
    },
}

/// One accepted window measurement feeding the line fit.
#[derive(Debug, Clone, Copy)]
struct LagPoint {
    /// Target-domain window center (samples) — the abscissa the measured
    /// lag actually corresponds to when the window slips internally.
    t: f64,
    /// Measured lag: target position − matching reference position.
    lag: f64,
    /// Normalized correlation peak, kept for the confidence score.
    peak: f32,
}

pub struct DriftEstimator {
    config: DriftConfig,
    ref_len: usize,
    target_len: usize,
    /// Next target window start.
    cursor: usize,
    windows_total: usize,
    points: Vec<LagPoint>,
}

impl DriftEstimator {
    pub fn new(sample_rate: u32, ref_len: usize, target_len: usize) -> Self {
        Self::with_config(
            DriftConfig::for_sample_rate(sample_rate),
            ref_len,
            target_len,
        )
    }

    pub fn with_config(config: DriftConfig, ref_len: usize, target_len: usize) -> Self {
        Self {
            config,
            ref_len,
            target_len,
            cursor: 0,
            windows_total: 0,
            points: Vec::new(),
        }
    }

    /// Search slack around a window ending at `target_end`: residual
    /// coarse-alignment error plus worst-case accumulated drift.
    fn margin_at(&self, target_end: usize) -> usize {
        let slack = (target_end as f64 * self.config.max_drift_ppm * 1.0e-6).ceil() as usize;
        self.config.max_initial_offset + slack
    }

    /// The next window to correlate, or `None` when the streams are
    /// exhausted. Pure peek: only `push_window` advances.
    pub fn next_request(&self) -> Option<WindowRequest> {
        let w = self.config.window_len;
        if w == 0 {
            return None;
        }
        let mut start = self.cursor;
        while start + w <= self.target_len {
            let margin = self.margin_at(start + w);
            let ref_start = start.saturating_sub(margin);
            let ref_end = (start + w + margin).min(self.ref_len);
            if ref_end >= ref_start + w {
                return Some(WindowRequest {
                    target_start: start,
                    target_len: w,
                    ref_start,
                    ref_len: ref_end - ref_start,
                });
            }
            start += self.config.interval.max(1);
        }
        None
    }

    /// Feed the slices for the current `next_request` window.
    pub fn push_window(
        &mut self,
        reference_segment: &[f32],
        target_window: &[f32],
    ) -> Result<(), DriftError> {
        let req = self.next_request().ok_or(DriftError::NoWindowPending)?;
        if reference_segment.len() != req.ref_len || target_window.len() != req.target_len {
            return Err(DriftError::WindowShape {
                expected_ref: req.ref_len,
                expected_target: req.target_len,
                got_ref: reference_segment.len(),
                got_target: target_window.len(),
            });
        }
        self.cursor = req.target_start + self.config.interval.max(1);
        self.windows_total += 1;
        if let Some(m) = measure_window(reference_segment, target_window, &self.config) {
            self.points.push(LagPoint {
                t: req.target_start as f64 + req.target_len as f64 / 2.0,
                lag: req.target_start as f64 - (req.ref_start as f64 + m.lag_in_segment),
                peak: m.peak,
            });
        }
        Ok(())
    }

    /// Robust line fit over everything pushed so far. Fewer than two
    /// usable windows ⇒ no-drift estimate with zero confidence — never
    /// a made-up ratio.
    pub fn estimate(&self) -> DriftEstimate {
        let fallback = DriftEstimate {
            ratio: 1.0,
            initial_offset_samples: 0.0,
            confidence: 0.0,
            windows_used: self.points.len(),
            windows_total: self.windows_total,
        };
        if self.points.len() < 2 {
            return fallback;
        }
        let (slope, intercept) = theil_sen(&self.points);
        // One MAD-gated refit: Theil–Sen already resists outliers, but
        // dropping gross wrong-locks entirely tightens the fit and keeps
        // windows_used honest.
        let residual = |p: &LagPoint, s: f64, c: f64| (p.lag - (c + s * p.t)).abs();
        let mut abs_res: Vec<f64> = self
            .points
            .iter()
            .map(|p| residual(p, slope, intercept))
            .collect();
        let mad = median(&mut abs_res).unwrap_or(0.0);
        let tol = (8.0 * mad).max(4.0);
        let kept: Vec<LagPoint> = self
            .points
            .iter()
            .copied()
            .filter(|p| residual(p, slope, intercept) <= tol)
            .collect();
        let (slope, intercept, used) = if kept.len() >= 2 && kept.len() < self.points.len() {
            let (s, c) = theil_sen(&kept);
            (s, c, kept)
        } else {
            (slope, intercept, self.points.clone())
        };
        let ratio = 1.0 / (1.0 - slope);
        let initial_offset = intercept * ratio;
        if !ratio.is_finite() || !initial_offset.is_finite() {
            return fallback;
        }
        let mut peaks: Vec<f64> = used.iter().map(|p| f64::from(p.peak)).collect();
        let median_peak = median(&mut peaks).unwrap_or(0.0);
        let coverage = used.len() as f64 / self.windows_total.max(1) as f64;
        DriftEstimate {
            ratio,
            initial_offset_samples: initial_offset,
            confidence: (median_peak * coverage).clamp(0.0, 1.0) as f32,
            windows_used: used.len(),
            windows_total: self.windows_total,
        }
    }
}

/// One-shot estimation over in-memory streams with product defaults.
pub fn estimate_drift(reference: &[f32], target: &[f32], sample_rate: u32) -> DriftEstimate {
    estimate_drift_with(
        reference,
        target,
        &DriftConfig::for_sample_rate(sample_rate),
    )
}

/// As [`estimate_drift`] with explicit knobs.
pub fn estimate_drift_with(
    reference: &[f32],
    target: &[f32],
    config: &DriftConfig,
) -> DriftEstimate {
    let mut estimator = DriftEstimator::with_config(config.clone(), reference.len(), target.len());
    while let Some(req) = estimator.next_request() {
        estimator
            .push_window(
                &reference[req.ref_start..req.ref_start + req.ref_len],
                &target[req.target_start..req.target_start + req.target_len],
            )
            .expect("request-driven push cannot mismatch");
    }
    estimator.estimate()
}

struct WindowMeasure {
    /// Sub-sample lag of the target window inside the reference segment.
    lag_in_segment: f64,
    /// Normalized correlation peak (cosine similarity).
    peak: f32,
}

fn measure_window(
    reference_segment: &[f32],
    target_window: &[f32],
    config: &DriftConfig,
) -> Option<WindowMeasure> {
    let w = target_window.len();
    let energy: f32 = target_window.iter().map(|v| v * v).sum();
    if (energy / w as f32).sqrt() < config.min_rms {
        return None;
    }
    let corr = correlation_series(reference_segment, target_window)?;
    let (best, best_val) =
        corr.iter()
            .map(|v| v.abs())
            .enumerate()
            .fold(
                (0usize, 0.0f32),
                |acc, (i, v)| if v > acc.1 { (i, v) } else { acc },
            );
    // Non-finite means f32 energy overflow (absurd amplitudes): drop the
    // window rather than let a NaN reach the line fit.
    if !best_val.is_finite() || best_val <= f32::EPSILON {
        return None;
    }
    let local: f32 = reference_segment[best..best + w]
        .iter()
        .map(|v| v * v)
        .sum();
    let denom = (energy * local).sqrt();
    if denom <= f32::EPSILON {
        return None;
    }
    let peak = best_val / denom;
    // A NaN peak (energy overflow) must be rejected explicitly: NaN
    // comparisons are false, so `< min_peak` alone would let it through.
    if peak.is_nan() || peak < config.min_peak {
        return None;
    }
    // Peak-to-sidelobe outside ±1 ms: sustained periodic content produces
    // near-tied peaks a pitch period away — ambiguous, better dropped.
    let guard = (config.sample_rate as usize / 1_000).max(16);
    let sidelobe = corr
        .iter()
        .enumerate()
        .filter(|(i, _)| i.abs_diff(best) > guard)
        .map(|(_, v)| v.abs())
        .fold(0.0f32, f32::max);
    if sidelobe > f32::EPSILON && best_val / sidelobe < config.min_prominence {
        return None;
    }
    // Sub-sample refinement: parabola through the peak and its neighbors.
    let delta = if best > 0 && best + 1 < corr.len() {
        let (y0, y1, y2) = (corr[best - 1].abs(), best_val, corr[best + 1].abs());
        let curve = y0 - 2.0 * y1 + y2;
        if curve.abs() > f32::EPSILON {
            f64::from(0.5 * (y0 - y2) / curve).clamp(-0.5, 0.5)
        } else {
            0.0
        }
    } else {
        0.0
    };
    Some(WindowMeasure {
        lag_in_segment: best as f64 + delta,
        peak,
    })
}

/// Theil–Sen line fit: slope = median of pairwise slopes, intercept =
/// median of per-point intercepts. Breakdown point ~29%: a few windows
/// that locked onto the wrong content cannot steer the fit.
fn theil_sen(points: &[LagPoint]) -> (f64, f64) {
    let mut slopes = Vec::with_capacity(points.len() * (points.len() - 1) / 2);
    for (i, a) in points.iter().enumerate() {
        for b in &points[i + 1..] {
            let dt = b.t - a.t;
            if dt != 0.0 {
                slopes.push((b.lag - a.lag) / dt);
            }
        }
    }
    let slope = median(&mut slopes).unwrap_or(0.0);
    let mut intercepts: Vec<f64> = points.iter().map(|p| p.lag - slope * p.t).collect();
    let intercept = median(&mut intercepts).unwrap_or(0.0);
    (slope, intercept)
}

fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.total_cmp(b));
    let mid = values.len() / 2;
    Some(if values.len() % 2 == 1 {
        values[mid]
    } else {
        (values[mid - 1] + values[mid]) / 2.0
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 16_000;

    /// Fast test knobs: 0.5 s windows every 4 s at 16 kHz.
    fn test_config() -> DriftConfig {
        DriftConfig {
            sample_rate: RATE,
            window_len: 8_000,
            interval: 64_000,
            max_initial_offset: 800,
            max_drift_ppm: 1_500.0,
            min_rms: 1.0e-3,
            min_peak: 0.25,
            min_prominence: 1.2,
        }
    }

    /// Zero-mean uniform noise in [−1, 1] — any DC component correlates at
    /// every lag and would poison the prominence gate.
    fn lcg(state: &mut u64) -> f32 {
        *state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((*state >> 32) as u32 as f32 / u32::MAX as f32) * 2.0 - 1.0
    }

    /// Music-like: three non-harmonic tones with slow independent AM plus
    /// band-limited noise (two one-pole low-passes ≈ 1 kHz) at comparable
    /// energy — voices carry consonants, breath, and room reverberation,
    /// not just sustained partials. Broadband enough for a sharp
    /// correlation peak, tonal enough to exercise the prominence gate.
    fn music_like(len: usize, seed: u64) -> Vec<f32> {
        const TONES: [(f64, f64); 3] = [(220.0, 0.11), (311.1, 0.07), (466.2, 0.05)];
        let rate = f64::from(RATE);
        let mut state = seed | 1;
        let (mut lp1, mut lp2) = (0.0f32, 0.0f32);
        (0..len)
            .map(|i| {
                let t = i as f64 / rate;
                let mut s = 0.0f64;
                for (k, (freq, amp)) in TONES.iter().enumerate() {
                    let am = 0.6
                        + 0.4 * (2.0 * std::f64::consts::PI * (0.07 + 0.05 * k as f64) * t).sin();
                    s += amp * am * (2.0 * std::f64::consts::PI * freq * t).sin();
                }
                lp1 += 0.35 * (lcg(&mut state) - lp1);
                lp2 += 0.35 * (lp1 - lp2);
                s as f32 + 0.3 * lp2
            })
            .collect()
    }

    /// Simulate a target ADC at `ratio` × the reference clock with a
    /// residual `offset0`: y[k] = x((k − offset0)/ratio), via a phase-table
    /// windowed-sinc (48-tap Blackman) — the high-quality resampler the
    /// estimator must see through.
    fn drifted_copy(src: &[f32], ratio: f64, offset0: f64) -> Vec<f32> {
        const HALF: usize = 24;
        const PHASES: usize = 512;
        let taps = 2 * HALF;
        let mut table = vec![0.0f64; (PHASES + 1) * taps];
        for ph in 0..=PHASES {
            let frac = ph as f64 / PHASES as f64;
            let row = &mut table[ph * taps..(ph + 1) * taps];
            let mut sum = 0.0;
            for (j, slot) in row.iter_mut().enumerate() {
                let d = frac + (HALF as f64 - 1.0) - j as f64;
                let sinc = if d == 0.0 {
                    1.0
                } else {
                    (std::f64::consts::PI * d).sin() / (std::f64::consts::PI * d)
                };
                let u = d / HALF as f64;
                let window = 0.42
                    + 0.5 * (std::f64::consts::PI * u).cos()
                    + 0.08 * (2.0 * std::f64::consts::PI * u).cos();
                *slot = sinc * window;
                sum += *slot;
            }
            for slot in row.iter_mut() {
                *slot /= sum; // exact DC response per phase
            }
        }
        let out_len = (src.len() as f64 * ratio) as usize;
        (0..out_len)
            .map(|k| {
                let pos = (k as f64 - offset0) / ratio;
                let i0 = pos.floor() as isize;
                let first = i0 - HALF as isize + 1;
                if first < 0 || (i0 + HALF as isize) as usize >= src.len() {
                    return 0.0;
                }
                let ph = ((pos - i0 as f64) * PHASES as f64).round() as usize;
                let row = &table[ph * taps..(ph + 1) * taps];
                row.iter()
                    .enumerate()
                    .map(|(j, &c)| c * f64::from(src[(first + j as isize) as usize]))
                    .sum::<f64>() as f32
            })
            .collect()
    }

    fn assert_recovers(ppm: f64, offset0: f64) {
        let cfg = test_config();
        let src = music_like(768_000, 42); // 48 s
        let tgt = drifted_copy(&src, 1.0 + ppm * 1.0e-6, offset0);
        let est = estimate_drift_with(&src, &tgt, &cfg);
        assert!(
            (est.ppm() - ppm).abs() <= 5.0,
            "recovered {:.2} ppm, wanted {ppm} ppm",
            est.ppm()
        );
        assert!(
            (est.initial_offset_samples - offset0).abs() <= 3.0,
            "offset {:.2}, wanted {offset0}",
            est.initial_offset_samples
        );
        assert!(est.confidence >= 0.5, "confidence {}", est.confidence);
        assert!(est.windows_used >= 10, "windows {}", est.windows_used);
    }

    #[test]
    fn recovers_plus_30_ppm() {
        assert_recovers(30.0, 12.4);
    }

    #[test]
    fn recovers_plus_200_ppm() {
        assert_recovers(200.0, 12.4);
    }

    #[test]
    fn recovers_minus_100_ppm() {
        assert_recovers(-100.0, -7.6);
    }

    #[test]
    fn identical_streams_are_unity() {
        let cfg = test_config();
        let src = music_like(400_000, 7); // 25 s
        let est = estimate_drift_with(&src, &src, &cfg);
        assert!((est.ratio - 1.0).abs() * 1.0e6 < 1.0, "ppm {}", est.ppm());
        assert!(
            est.initial_offset_samples.abs() < 0.5,
            "offset {}",
            est.initial_offset_samples
        );
        assert!(est.confidence > 0.9, "confidence {}", est.confidence);
    }

    /// A signal that goes quiet must lose confidence, not invent a ratio:
    /// the fit still comes only from the audible windows.
    #[test]
    fn silence_degrades_confidence_not_sanity() {
        let cfg = test_config();
        let mut src = music_like(160_000, 9); // 10 s of music…
        src.extend(std::iter::repeat_n(0.0f32, 608_000)); // …then 38 s of nothing
        let tgt = drifted_copy(&src, 1.0 + 40.0e-6, 3.0);
        let est = estimate_drift_with(&src, &tgt, &cfg);
        assert!(est.confidence < 0.35, "confidence {}", est.confidence);
        assert!(est.windows_used <= 3, "windows {}", est.windows_used);
        assert!(est.ppm().abs() < 1_000.0, "ppm {} is garbage", est.ppm());
    }

    #[test]
    fn short_streams_return_no_drift() {
        let cfg = test_config();
        let src = music_like(40_000, 11); // 2.5 s: a single grid window
        let est = estimate_drift_with(&src, &src, &cfg);
        assert_eq!(est.ratio, 1.0);
        assert_eq!(est.confidence, 0.0);
        assert!(est.windows_used <= 1);
    }

    /// Windows whose content was replaced wholesale (a cough, a bumped
    /// mic) must be gated out or outvoted — the fit stays on target.
    #[test]
    fn corrupted_windows_do_not_skew_the_fit() {
        let cfg = test_config();
        let src = music_like(768_000, 13);
        let mut tgt = drifted_copy(&src, 1.0 - 60.0e-6, -4.2);
        let mut state = 999u64;
        for i in 0..20_000 {
            tgt[320_000 + i] = 0.3 * lcg(&mut state); // window 5
            tgt[576_000 + i] = 0.3 * lcg(&mut state); // window 9
        }
        let est = estimate_drift_with(&src, &tgt, &cfg);
        assert!((est.ppm() + 60.0).abs() <= 5.0, "ppm {}", est.ppm());
        assert!(
            (est.initial_offset_samples + 4.2).abs() <= 3.0,
            "offset {}",
            est.initial_offset_samples
        );
    }

    #[test]
    fn theil_sen_resists_outliers() {
        let mut pts: Vec<LagPoint> = (0..12)
            .map(|i| {
                let t = f64::from(i) * 64_000.0;
                LagPoint {
                    t,
                    lag: 5.0 + 80.0e-6 * t,
                    peak: 0.9,
                }
            })
            .collect();
        pts[3].lag += 400.0;
        pts[8].lag -= 250.0;
        let (slope, intercept) = theil_sen(&pts);
        assert!((slope - 80.0e-6).abs() < 2.0e-6, "slope {slope}");
        assert!((intercept - 5.0).abs() < 1.0, "intercept {intercept}");
    }

    #[test]
    fn default_config_recovers_drift() {
        // The product path: 1 s windows every 30 s. 75 s at 16 kHz gives
        // three grid windows — enough for a fit.
        let src = music_like(1_200_000, 17);
        let tgt = drifted_copy(&src, 1.0 + 120.0e-6, 6.0);
        let est = estimate_drift(&src, &tgt, RATE);
        assert!((est.ppm() - 120.0).abs() <= 5.0, "ppm {}", est.ppm());
        assert!(est.confidence >= 0.5, "confidence {}", est.confidence);
    }

    #[test]
    fn degenerate_inputs_return_no_drift() {
        let cfg = test_config();
        let empty = estimate_drift_with(&[], &[], &cfg);
        assert_eq!(empty.ratio, 1.0);
        assert_eq!(empty.windows_total, 0);
        let zeros = vec![0.0f32; 200_000];
        let silent = estimate_drift_with(&zeros, &zeros, &cfg);
        assert_eq!(silent.ratio, 1.0);
        assert_eq!(silent.confidence, 0.0);
        assert_eq!(silent.windows_used, 0);
    }

    #[test]
    fn push_window_validates_shape() {
        let mut est = DriftEstimator::with_config(test_config(), 100_000, 100_000);
        let req = est.next_request().expect("one window fits");
        assert!(matches!(
            est.push_window(&[0.0; 10], &[0.0; 10]),
            Err(DriftError::WindowShape { .. })
        ));
        est.push_window(&vec![0.0; req.ref_len], &vec![0.0; req.target_len])
            .expect("matching shapes accepted");
    }
}
