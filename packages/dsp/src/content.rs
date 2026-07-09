//! Content-based stream alignment — the chirp-less fallback (W4-B).
//!
//! When no calibration chirp is present (or it was too quiet/clipped to
//! trust), two streams of the same room can still be aligned by
//! cross-correlating what they actually recorded. The naive approach —
//! full-length FFT correlation of raw PCM — is off the table: a 45-minute
//! stream is ~130M samples, and clock drift (±hundreds of ppm) smears a
//! full-length correlation peak by tens of ms anyway. Instead, two stages,
//! both bounded:
//!
//! 1. **Coarse (envelope domain).** Per-hop RMS envelopes (~5 ms hop →
//!    200 Hz) of each stream's head (≤ `head_max`, default 60 s), mean-
//!    removed so DC never correlates. Up to four probe windows (~10 s
//!    each) are cut from the *target* envelope at deliberate positions —
//!    pinned to the head (maximum reach for negative lags: the probe can
//!    match anywhere later in the reference), pinned to the tail (maximum
//!    reach for positive lags: a probe finds pre-roll only earlier than
//!    itself), the midpoint (a second witness for either sign), and the
//!    loudest window overall (loud content carries the most alignment
//!    information) — each matched against the whole reference envelope.
//!    Envelopes are phase-blind, so this survives different
//!    mics/positions, and 200 Hz frames make drift slip negligible
//!    (<3 frames over 60 s at 200 ppm).
//! 2. **Consensus.** Music is self-similar (verses repeat, AM is quasi-
//!    periodic), so a single envelope peak-to-sidelobe ratio separates
//!    honest matches from ambiguity poorly. Independent probes agreeing on
//!    the same lag is the strong evidence — the same philosophy as the
//!    drift estimator's Theil–Sen consensus. Reported confidence = best
//!    probe's peak-to-sidelobe, scaled ×1.5/×2 by two/three agreeing
//!    probes. Corroboration AMPLIFIES decisiveness, never creates it: a
//!    LONE probe is capped below any accept threshold (one witness is no
//!    consensus), tie-level prominence (~1) stays sub-threshold at any
//!    agreement count (perfectly periodic content agrees with itself at
//!    every repeat, consistently), and prominence itself is bounded and
//!    coverage-gated so a mostly silent reference can never manufacture
//!    confidence.
//! 3. **Fine (PCM domain).** A ~1 s raw slice at the best probe position
//!    is re-correlated against the reference within ±2 hops of the coarse
//!    hit — refinement may sharpen the envelope lag to sample precision
//!    but never move it further than the coarse pass's own error bound —
//!    and only when the PCM peak is decisive: sustained tonal content
//!    (choir chords) peaks at every pitch period, and a near-tie means
//!    the phase is a coin toss. Otherwise the envelope lag stands at
//!    hop-level (~5 ms) precision, inside the architecture's "that's air,
//!    not a bug" tolerance for room mics.
//!
//! Honesty gates mirror `drift::measure_window`: silence (probe RMS),
//! weak normalized envelope peak, and the consensus-weighted confidence —
//! genuinely uncorrelated takes, periodic content (a bare sine tone is
//! ambiguous at every period), and lone-transient lanes return `None` or
//! a low confidence the caller must threshold, never an invented lag.

use crate::correlate::correlation_series;

/// A content match between two streams.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ContentMatch {
    /// Signed pre-roll difference: the target holds `lag_samples` MORE
    /// samples before any shared room instant than the reference does
    /// (`target[i] ≈ reference[i − lag]`). Same semantics as a chirp lag
    /// difference: bigger = started capturing earlier = trim more head.
    pub lag_samples: i64,
    /// Normalized correlation peak at the match (fine stage when it
    /// resolved, envelope stage otherwise), 0..~1.
    pub peak: f32,
    /// Consensus-weighted ambiguity score: best probe's envelope
    /// peak-to-sidelobe ratio × agreeing probe count (see module docs) —
    /// comparable scale to chirp confidence, thresholded by the caller.
    pub confidence: f32,
}

/// Tunable knobs. [`ContentAlignConfig::for_sample_rate`] gives the
/// product defaults; tests shrink windows to stay fast.
#[derive(Debug, Clone)]
pub struct ContentAlignConfig {
    pub sample_rate: u32,
    /// Correlate only the first this-many samples of each stream: streams
    /// of one take are armed together, so their pre-roll difference lives
    /// in the head — and this caps cost independent of take length.
    pub head_max: usize,
    /// Envelope hop (samples per RMS frame), ~5 ms.
    pub env_hop: usize,
    /// Probe window cut from the target (samples), ~10 s. Lag reach of
    /// either sign is the stream head minus one probe — the head/tail
    /// pinned probes guarantee it.
    pub probe_len: usize,
    /// Fine PCM correlation window (samples), ~1 s — the chirp's own
    /// exposure to intra-window drift slip.
    pub fine_len: usize,
    /// Fine search margin around the coarse hit (samples), ≥ a few hops.
    pub fine_margin: usize,
    /// Probe windows quieter than this mean RMS are silence: no match.
    pub min_rms: f32,
    /// Minimum normalized envelope peak to consider a match at all.
    pub min_env_peak: f32,
    /// Minimum normalized fine peak to trust PCM precision over the
    /// envelope lag (distant mics decorrelate raw phase, not envelopes).
    pub min_fine_peak: f32,
}

impl ContentAlignConfig {
    pub fn for_sample_rate(sample_rate: u32) -> Self {
        let rate = sample_rate as usize;
        let hop = (rate / 200).max(1); // 5 ms
        Self {
            sample_rate,
            head_max: rate * 60,
            env_hop: hop,
            probe_len: rate * 10,
            fine_len: rate,
            fine_margin: (4 * hop).max(rate / 50), // ≥ 20 ms
            min_rms: 1.0e-3,
            min_env_peak: 0.4,
            min_fine_peak: 0.2,
        }
    }
}

/// Fewest envelope frames a usable probe needs (~100 ms at defaults).
const MIN_PROBE_FRAMES: usize = 20;
/// Candidate probe positions per stream pair (head, mid, tail, loudest —
/// near-duplicates collapse).
const MAX_PROBES: usize = 4;
/// Agreement factor cap: for any real lag one pinned probe is
/// structurally blind (a head probe cannot match pre-roll it does not
/// have), so three agreeing probes is already full marks.
const MAX_AGREEMENT: usize = 3;
/// Probes agreeing within this many envelope frames (~15 ms at defaults)
/// count as consensus — covers worst-case drift slip between probes 60 s
/// apart, far below music's self-similarity spacing.
const CONSENSUS_TOL_FRAMES: usize = 3;
/// A lone agreeing probe is testimony without corroboration: consensus IS
/// the confidence signal, so a single-witness verdict is capped here —
/// safely below any sane accept threshold, it can only DECLINE loudly.
/// (QA MAJOR-2: a take whose only loud moment is one transient used to
/// clear the bar on an unbounded prominence alone.)
const LONE_PROBE_CONFIDENCE_CAP: f32 = 1.0;
/// Prominence ceiling: a sidelobe of ~0 (nothing else eligible correlates
/// at all) must read as "very confident", never as infinity — the number
/// crosses an FFI boundary as JSON and multiplies into the verdict.
const MAX_PROMINENCE: f32 = 100.0;
/// Fraction of outside-guard lags the sidelobe scan must have actually
/// scored for the prominence to mean anything. Below this the reference
/// is essentially silent everywhere but the match — no ambiguity evidence
/// exists either way, so prominence degrades to a neutral 1.0
/// (QA MAJOR-2: an emptied scan manufactured unbounded confidence).
const MIN_SIDELOBE_COVERAGE: f32 = 0.25;
/// Fine-pass decisiveness (drift.rs `min_prominence` rule): the PCM peak
/// must beat everything a pitch period away (outside ±1 ms) by this
/// factor, or the phase information is ambiguous and the envelope lag
/// stands (QA MAJOR-1: sustained chords lock a wrong tone period).
const FINE_MIN_PROMINENCE: f32 = 1.2;

/// Locate `target`'s content inside `reference` with product defaults.
/// See [`ContentMatch::lag_samples`] for the sign convention. `None` for
/// silence, degenerate/non-finite input, or nothing resembling a shared
/// performance — never a made-up offset.
pub fn align_content(reference: &[f32], target: &[f32], sample_rate: u32) -> Option<ContentMatch> {
    align_content_with(
        reference,
        target,
        &ContentAlignConfig::for_sample_rate(sample_rate),
    )
}

/// As [`align_content`] with explicit knobs.
pub fn align_content_with(
    reference: &[f32],
    target: &[f32],
    config: &ContentAlignConfig,
) -> Option<ContentMatch> {
    let hop = config.env_hop.max(1);
    let ref_head = &reference[..reference.len().min(config.head_max)];
    let tgt_head = &target[..target.len().min(config.head_max)];

    // ---- coarse: envelope correlation, one probe per disjoint band ---------
    let env_ref = envelope(ref_head, hop)?;
    let env_tgt = envelope(tgt_head, hop)?;
    let probe_frames = (config.probe_len / hop)
        .min(env_tgt.len() / 2)
        .min(env_ref.len().saturating_sub(1));
    if probe_frames < MIN_PROBE_FRAMES {
        return None;
    }
    // Deliberate probe positions (module docs): head-pinned (full
    // negative reach), tail-pinned (full positive reach), the midpoint
    // (a second feasible witness whichever sign the true lag has), and
    // the loudest window overall (best content). Near-duplicates (< half
    // a probe apart) are collapsed — overlapping probes would partially
    // self-confirm in the consensus.
    let latest = env_tgt.len() - probe_frames;
    let loudest = loudest_window_start(&env_tgt, probe_frames, 0, latest);
    let mut starts = [0usize, latest / 2, latest, loudest];
    starts.sort_unstable();
    struct Probe {
        /// Probe start in target envelope frames.
        p: usize,
        /// Matched position in reference envelope frames.
        q: usize,
        peak: f32,
        prominence: f32,
    }
    let mut probes: Vec<Probe> = Vec::with_capacity(MAX_PROBES);
    let mut last_start: Option<usize> = None;
    for &p in &starts {
        if last_start.is_some_and(|prev| p.abs_diff(prev) < probe_frames / 2) {
            continue;
        }
        last_start = Some(p);
        let probe_rms = env_tgt[p..p + probe_frames].iter().sum::<f32>() / probe_frames as f32;
        if probe_rms < config.min_rms {
            continue; // silence carries no alignment information
        }
        let probe_env = mean_removed(&env_tgt[p..p + probe_frames]);
        let Some(coarse) = normalized_scan(&env_ref, &probe_env) else {
            continue;
        };
        if coarse.peak < config.min_env_peak {
            continue; // nothing in the reference resembles this probe
        }
        probes.push(Probe {
            p,
            q: coarse.lag,
            peak: coarse.peak,
            prominence: coarse.prominence,
        });
    }
    let anchor = probes.iter().max_by(|a, b| a.peak.total_cmp(&b.peak))?;
    // Consensus: independent probes reporting the SAME lag (their p−q
    // differences match within drift slack) is the evidence a lone
    // peak-to-sidelobe ratio can't provide on self-similar music. A lone
    // witness never clears an accept threshold (see the cap's docs).
    let anchor_lag = anchor.p as i64 - anchor.q as i64;
    let agreeing = probes
        .iter()
        .filter(|m| (m.p as i64 - m.q as i64).abs_diff(anchor_lag) as usize <= CONSENSUS_TOL_FRAMES)
        .count()
        .min(MAX_AGREEMENT);
    // Corroboration scales the anchor's decisiveness (×1.5 at two
    // witnesses, ×2 at three) — it must never manufacture acceptance from
    // ties: a prominence of ~1 (perfectly periodic content agrees with
    // itself at every repeat, consistently across probes) stays below the
    // 2.75 accept bar at ANY agreement count.
    let confidence = if agreeing >= 2 {
        anchor.prominence * (1.0 + 0.5 * (agreeing as f32 - 1.0))
    } else {
        anchor.prominence.min(LONE_PROBE_CONFIDENCE_CAP)
    };

    // ---- fine: PCM refinement inside the coarse hit's quantization noise ----
    // The envelope lag is phase-blind and already right to ~a hop; the PCM
    // pass exists ONLY to sharpen it to sample precision, never to move
    // it. On sustained tonal content — choir chords, THE product content —
    // raw-phase correlation peaks at every tone period with near-equal
    // height, and a free-roaming argmax locked a wrong period up to ±20 ms
    // out with full confidence (QA MAJOR-1). Two guards in refine_lag:
    // the search window is ±2 hops around the coarse prediction, and the
    // winning peak must be DECISIVE (FINE_MIN_PROMINENCE vs everything a
    // pitch period away). Anything less keeps the coarse envelope lag —
    // which was correct in every QA failure case.
    let p0 = anchor.p * hop;
    let q0 = anchor.q * hop;
    let coarse_match = ContentMatch {
        lag_samples: p0 as i64 - q0 as i64,
        peak: anchor.peak,
        confidence,
    };
    match refine_lag(ref_head, tgt_head, p0, q0, probe_frames * hop, config) {
        Some((lag_samples, peak)) => Some(ContentMatch {
            lag_samples,
            peak,
            // Global ambiguity lives in the envelope stage — the fine
            // window is too small for a meaningful sidelobe scan.
            confidence,
        }),
        // Ambiguous or decorrelated raw phase: the envelope lag stands at
        // hop precision — honest, and within room tolerance.
        None => Some(coarse_match),
    }
}

/// PCM sharpening of a coarse envelope hit (guards documented at the call
/// site). Returns the refined signed lag and its normalized peak, or
/// `None` when the phase evidence is weak or ambiguous.
fn refine_lag(
    ref_head: &[f32],
    tgt_head: &[f32],
    p0: usize,
    q0: usize,
    probe_span: usize,
    config: &ContentAlignConfig,
) -> Option<(i64, f32)> {
    let hop = config.env_hop.max(1);
    let fine_len = config.fine_len.min(probe_span);
    // Mean-removed slices: a DC offset correlates at every lag and would
    // both bias the peak and flatten its prominence.
    let fine_probe = mean_removed(tgt_head.get(p0..(p0 + fine_len).min(tgt_head.len()))?);
    let seg_start = q0.saturating_sub(config.fine_margin);
    let seg_end = (q0 + fine_len + config.fine_margin).min(ref_head.len());
    let segment = mean_removed(ref_head.get(seg_start..seg_end)?);
    let corr = correlation_series(&segment, &fine_probe)?;
    // Restrict the search to the coarse prediction ± 2 envelope hops: the
    // refinement can never exceed the coarse pass's own error bound.
    let expected = q0 - seg_start;
    let lo = expected.saturating_sub(2 * hop);
    let hi = (expected + 2 * hop).min(corr.len().saturating_sub(1));
    if lo > hi {
        return None;
    }
    let (best, best_val) = (lo..=hi)
        .map(|lag| (lag, corr[lag].abs()))
        .max_by(|a, b| a.1.total_cmp(&b.1))?;
    if !best_val.is_finite() || best_val <= f32::EPSILON {
        return None;
    }
    // Normalized peak (cosine at the match), as in cross_correlate_peak.
    let probe_energy: f32 = fine_probe.iter().map(|v| v * v).sum();
    let window = &segment[best..(best + fine_probe.len()).min(segment.len())];
    let local_energy: f32 = window.iter().map(|v| v * v).sum();
    let denom = (probe_energy * local_energy).sqrt();
    if denom <= f32::EPSILON {
        return None;
    }
    let peak = best_val / denom;
    if !peak.is_finite() || peak < config.min_fine_peak {
        return None;
    }
    // Decisiveness: the peak must tower over everything a pitch period
    // away (outside ±1 ms) WITHIN the window — near-ties mean the phase
    // is periodic and any pick would be a coin toss.
    let guard = (config.sample_rate as usize / 1_000).max(16);
    let sidelobe = (lo..=hi)
        .filter(|lag| lag.abs_diff(best) > guard)
        .map(|lag| corr[lag].abs())
        .fold(0.0f32, f32::max);
    if sidelobe > f32::EPSILON && best_val / sidelobe < FINE_MIN_PROMINENCE {
        return None;
    }
    Some((p0 as i64 - (seg_start + best) as i64, peak))
}

struct CoarseHit {
    /// Envelope-frame lag of the probe inside the reference.
    lag: usize,
    /// Local normalized correlation (Pearson r) at the match.
    peak: f32,
    /// Peak-to-sidelobe ratio outside ± half a probe, in Fisher-z space:
    /// r is bounded at 1, so a raw ratio collapses exactly where the
    /// evidence is strongest (a 0.9999 match over a 0.85 background is
    /// overwhelming, not "1.18×"). atanh stabilizes the variance and
    /// restores that contrast.
    prominence: f32,
}

/// Fisher z-transform, clamped at r = 0.99: past that, differences in a
/// float correlation are measurement/rounding noise, not evidence — and
/// the pole would MANUFACTURE decisiveness exactly there (two tied
/// periodic matches at r 0.99999 vs 0.9995 are a coin toss, not a 1.8×
/// ratio — the Chromium beep-grid e2e caught precisely that).
fn fisher_z(r: f32) -> f32 {
    r.clamp(0.0, 0.99).atanh()
}

/// Envelope matched-filter scan, scored as a per-lag LOCAL normalized
/// correlation (Pearson-style): `cross_correlate_peak` picks its peak by
/// raw dot product, which favors LOUD reference passages over matching
/// ones (a passage twice as loud at cosine 0.5 outscores the true lock —
/// real performances have phrase dynamics). The probe is zero-mean, so
/// correlating it against the RAW reference envelope already cancels each
/// window's DC in the numerator; the denominator must then use the
/// window's AC energy too (its own mean removed), or windows louder or
/// quieter than the global average get their cosine deflated and a
/// mediocre average-loudness match can outscore the true lock. Lags whose
/// AC energy is under 10% of the probe's are skipped (cosine against
/// near-silence is noise-vs-noise).
fn normalized_scan(ref_env: &[f32], probe_env: &[f32]) -> Option<CoarseHit> {
    let corr = correlation_series(ref_env, probe_env)?;
    let probe_energy: f32 = probe_env.iter().map(|v| v * v).sum();
    if probe_energy <= f32::EPSILON {
        return None;
    }
    let w = probe_env.len();
    // Sliding Σx and Σx² (f64 accumulators: the add/subtract walk over
    // ~10⁴ windows must not drift) → per-lag AC energy Σx² − (Σx)²/w.
    let mut local = vec![0.0f32; corr.len()];
    let mut sum: f64 = ref_env[..w].iter().map(|&v| f64::from(v)).sum();
    let mut sq: f64 = ref_env[..w]
        .iter()
        .map(|&v| f64::from(v) * f64::from(v))
        .sum();
    local[0] = (sq - sum * sum / w as f64).max(0.0) as f32;
    for i in 1..corr.len() {
        let add = f64::from(ref_env[i + w - 1]);
        let drop = f64::from(ref_env[i - 1]);
        sum += add - drop;
        sq += add * add - drop * drop;
        local[i] = (sq - sum * sum / w as f64).max(0.0) as f32;
    }
    let floor = probe_energy * 0.1;
    let cosine = |lag: usize| corr[lag].abs() / (probe_energy * local[lag]).sqrt();
    let mut best: Option<(usize, f32)> = None;
    for (lag, &energy) in local.iter().enumerate() {
        if energy < floor {
            continue;
        }
        let v = cosine(lag);
        if v.is_finite() && best.is_none_or(|(_, bv)| v > bv) {
            best = Some((lag, v));
        }
    }
    let (best_lag, best_val) = best?;
    let guard = w / 2;
    let mut sidelobe = 0.0f32;
    let mut outside = 0usize;
    let mut eligible = 0usize;
    for (lag, &energy) in local.iter().enumerate() {
        if lag.abs_diff(best_lag) <= guard {
            continue;
        }
        outside += 1;
        if energy < floor {
            continue;
        }
        eligible += 1;
        sidelobe = sidelobe.max(cosine(lag));
    }
    // Prominence is only meaningful when the scan actually SCORED a real
    // share of the background. A reference that is silent everywhere but
    // the match (one cough on a quiet lane — QA MAJOR-2) empties the
    // eligible set: that is absence of ambiguity EVIDENCE, not proof of
    // uniqueness, so prominence degrades to a neutral 1.0. And a genuine
    // near-zero sidelobe caps at MAX_PROMINENCE — never infinity.
    let coverage = eligible as f32 / outside.max(1) as f32;
    let prominence = if outside == 0 || coverage < MIN_SIDELOBE_COVERAGE {
        1.0
    } else {
        (fisher_z(best_val) / fisher_z(sidelobe).max(1.0e-3)).min(MAX_PROMINENCE)
    };
    Some(CoarseHit {
        lag: best_lag,
        peak: best_val,
        prominence,
    })
}

/// RMS windows span this many hops (~20 ms at defaults). A window of a
/// single hop (~5 ms ≈ one period of a low voice) makes the RMS wobble
/// with pitch PHASE — the envelope inherits tonal structure and the
/// coarse peak wanders on sustained chords. Several periods per window
/// keep the envelope a loudness measure, at unchanged hop resolution.
const ENV_WINDOW_HOPS: usize = 4;

/// AC RMS envelope: overlapping `ENV_WINDOW_HOPS`-hop windows sliding by
/// one hop; frame `f` covers samples starting at `f·hop`. Each window's
/// own mean is subtracted before the RMS, so a DC offset (cheap phone
/// mics genuinely carry one) cannot inflate the floor and flatten the
/// envelope's modulation. `None` if the input is shorter than one window
/// or any sample is non-finite (a NaN would spread through the FFT into
/// every lag — same rule as `correlate`).
fn envelope(x: &[f32], hop: usize) -> Option<Vec<f32>> {
    if !x.iter().all(|v| v.is_finite()) {
        return None;
    }
    let window = hop * ENV_WINDOW_HOPS;
    if x.len() < window {
        return None;
    }
    let frames = (x.len() - window) / hop + 1;
    Some(
        (0..frames)
            .map(|f| {
                let w = &x[f * hop..f * hop + window];
                let mean = w.iter().sum::<f32>() / window as f32;
                (w.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / window as f32).sqrt()
            })
            .collect(),
    )
}

fn mean_removed(x: &[f32]) -> Vec<f32> {
    let mean = x.iter().sum::<f32>() / x.len().max(1) as f32;
    x.iter().map(|v| v - mean).collect()
}

/// Start index in `lo..=hi` of the highest-energy window of `len`
/// (sliding sum; `hi + len ≤ env.len()` is the caller's invariant).
fn loudest_window_start(env: &[f32], len: usize, lo: usize, hi: usize) -> usize {
    let mut best = lo;
    let mut energy: f32 = env[lo..lo + len].iter().map(|v| v * v).sum();
    let mut best_energy = energy;
    for start in lo + 1..=hi {
        energy += env[start + len - 1].powi(2) - env[start - 1].powi(2);
        if energy > best_energy {
            best_energy = energy;
            best = start;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 16_000;

    /// Accept threshold the desk applies to CONTENT verdicts (player
    /// CONTENT_MIN_CONFIDENCE) — pinned here so the calibration below and
    /// the product agree. 2.75, not the chirp path's 2.5: QA round-2
    /// calibration put the uncorrelated-content false-accept tail at 2.62
    /// (1/200) while the lowest honest accept observed was 3.41 — the bar
    /// splits that gap. The chirp threshold (correlate.rs) is a different
    /// scale (matched filter) and stays where W1-A calibrated it.
    const ACCEPT: f32 = 2.75;

    /// Fast knobs: 8 s head, 2 s probe, 0.5 s fine window at 16 kHz.
    fn test_config() -> ContentAlignConfig {
        let rate = RATE as usize;
        ContentAlignConfig {
            sample_rate: RATE,
            head_max: rate * 8,
            env_hop: rate / 200,
            probe_len: rate * 2,
            fine_len: rate / 2,
            fine_margin: rate / 50,
            min_rms: 1.0e-3,
            min_env_peak: 0.4,
            min_fine_peak: 0.2,
        }
    }

    fn lcg(state: &mut u64) -> f32 {
        *state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((*state >> 32) as u32 as f32 / u32::MAX as f32) * 2.0 - 1.0
    }

    fn noise(len: usize, seed: u64, amplitude: f32) -> Vec<f32> {
        let mut state = seed | 1;
        (0..len).map(|_| lcg(&mut state) * amplitude).collect()
    }

    /// Music-like room content (drift.rs recipe + performance dynamics):
    /// three non-harmonic tones under syllable-rate AM (2–5 Hz — sung
    /// text) plus band-limited noise, all under an APERIODIC random
    /// loudness contour (0.5 s knots, linearly interpolated — phrase
    /// dynamics). Those modulations are exactly what the envelope stage
    /// locks onto. The seed perturbs tones, AM, and contour: different
    /// seeds are different PERFORMANCES (uncorrelated content), not just
    /// different mic noise.
    fn music_like(len: usize, seed: u64) -> Vec<f32> {
        const TONES: [(f64, f64); 3] = [(220.0, 0.11), (311.1, 0.07), (466.2, 0.05)];
        let rate = f64::from(RATE);
        let detune = 1.0 + (seed % 13) as f64 * 0.021;
        let am_shift = (seed % 7) as f64 * 0.41;
        let knot_len = RATE as usize / 2;
        let mut contour_state = seed.wrapping_mul(31) | 1;
        let knots: Vec<f32> = (0..len / knot_len + 2)
            .map(|_| 0.7 + 0.3 * lcg(&mut contour_state))
            .collect();
        let mut state = seed | 1;
        let (mut lp1, mut lp2) = (0.0f32, 0.0f32);
        (0..len)
            .map(|i| {
                let t = i as f64 / rate;
                let mut s = 0.0f64;
                for (k, (freq, amp)) in TONES.iter().enumerate() {
                    let am_hz = 2.3 + 1.1 * k as f64 + am_shift;
                    let am = 0.6 + 0.4 * (2.0 * std::f64::consts::PI * am_hz * t).sin();
                    s += amp * am * (2.0 * std::f64::consts::PI * freq * detune * t).sin();
                }
                lp1 += 0.35 * (lcg(&mut state) - lp1);
                lp2 += 0.35 * (lp1 - lp2);
                let frac = (i % knot_len) as f32 / knot_len as f32;
                let contour = knots[i / knot_len] * (1.0 - frac) + knots[i / knot_len + 1] * frac;
                (s as f32 + 0.3 * lp2) * contour
            })
            .collect()
    }

    /// Sustained choir chord: three notes, three voices per note, each
    /// voice slightly detuned (±0.4%) with its own ~5–7 Hz vibrato —
    /// real ensemble singing — under the aperiodic phrase contour, and
    /// deliberately NO shared broadband component (each mic adds its OWN
    /// noise). Short-term raw phase repeats every pitch period with
    /// near-tied PCM correlation peaks — THE content class of QA MAJOR-1:
    /// the fine pass must not out-vote a correct envelope lag — while
    /// vibrato/chorus shimmer plus the contour keep the ENVELOPE
    /// aperiodic enough for a coarse lock.
    fn chord_like(len: usize, seed: u64) -> Vec<f32> {
        const TONES: [(f64, f64); 3] = [(220.0, 0.10), (274.2, 0.08), (329.6, 0.06)];
        const VOICES: usize = 3;
        let rate = f64::from(RATE);
        let mut st = seed | 1;
        struct Voice {
            freq: f64,
            amp: f64,
            phase: f64,
            vib_hz: f64,
            /// Peak phase deviation (rad) for ±0.3% frequency vibrato.
            vib_dev: f64,
            vib_phase: f64,
        }
        let voices: Vec<Voice> = TONES
            .iter()
            .flat_map(|&(freq, amp)| {
                (0..VOICES)
                    .map(|_| {
                        let f = freq * (1.0 + 0.006 * f64::from(lcg(&mut st)));
                        let vib_hz = 5.0 + 2.0 * f64::from(lcg(&mut st));
                        Voice {
                            freq: f,
                            amp: amp / VOICES as f64,
                            phase: std::f64::consts::PI * f64::from(lcg(&mut st)),
                            vib_hz,
                            vib_dev: 0.003 * f / vib_hz,
                            vib_phase: std::f64::consts::PI * f64::from(lcg(&mut st)),
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        let knot_len = RATE as usize / 2;
        let mut contour_state = seed.wrapping_mul(31) | 1;
        let knots: Vec<f32> = (0..len / knot_len + 2)
            .map(|_| 0.7 + 0.3 * lcg(&mut contour_state))
            .collect();
        (0..len)
            .map(|i| {
                let t = i as f64 / rate;
                let s: f64 = voices
                    .iter()
                    .map(|v| {
                        let vib = v.vib_dev
                            * (2.0 * std::f64::consts::PI * v.vib_hz * t + v.vib_phase).sin();
                        v.amp * (2.0 * std::f64::consts::PI * v.freq * t + v.phase + vib).sin()
                    })
                    .sum();
                let frac = (i % knot_len) as f32 / knot_len as f32;
                let contour = knots[i / knot_len] * (1.0 - frac) + knots[i / knot_len + 1] * frac;
                s as f32 * contour
            })
            .collect()
    }

    /// A quiet lane: room-noise floor below the silence gate plus ONE
    /// ~100 ms broadband transient (a cough / page turn) at `at`.
    fn transient_lane(len: usize, at: usize, seed: u64) -> Vec<f32> {
        let mut lane = noise(len, seed, 4.0e-4);
        let burst = noise(RATE as usize / 10, seed.wrapping_mul(7919) | 1, 0.5);
        for (i, &b) in burst.iter().enumerate() {
            if at + i < lane.len() {
                lane[at + i] += b;
            }
        }
        lane
    }

    /// Two captures of the same `secs`-long performance with independent
    /// mic noise; `preroll` extra samples of room noise at the target's
    /// head.
    fn capture_pair_secs(preroll: usize, noise_amp: f32, secs: usize) -> (Vec<f32>, Vec<f32>) {
        let content = music_like(RATE as usize * secs, 7);
        let ref_noise = noise(content.len(), 101, noise_amp);
        let reference: Vec<f32> = content
            .iter()
            .zip(&ref_noise)
            .map(|(c, n)| c * 0.8 + n)
            .collect();
        let mut target = noise(preroll, 55, 2.0e-3);
        let tgt_noise = noise(content.len(), 77, noise_amp);
        target.extend(content.iter().zip(&tgt_noise).map(|(c, n)| c * 0.6 + n));
        (reference, target)
    }

    fn capture_pair(preroll: usize, noise_amp: f32) -> (Vec<f32>, Vec<f32>) {
        // 12 s of content under the 8 s test head-cap: probes stay well
        // separated, so honest matches earn their full consensus.
        capture_pair_secs(preroll, noise_amp, 12)
    }

    #[test]
    fn recovers_positive_offset_on_near_identical_streams() {
        let preroll = 5_600; // 0.35 s more pre-roll in the target
        let (reference, target) = capture_pair(preroll, 1.0e-3);
        let m = align_content_with(&reference, &target, &test_config()).expect("match");
        assert!(
            (m.lag_samples - preroll as i64).abs() <= 2,
            "lag {} vs {preroll}",
            m.lag_samples
        );
        assert!(m.confidence > ACCEPT, "confidence {}", m.confidence);
        assert!(m.peak > 0.5, "peak {}", m.peak);
    }

    #[test]
    fn recovers_negative_offset() {
        // The REFERENCE armed earlier: its head holds the extra pre-roll.
        let preroll = 4_000;
        let (target_content, reference) = capture_pair(preroll, 1.0e-3);
        let m = align_content_with(&reference, &target_content, &test_config()).expect("match");
        assert!(
            (m.lag_samples + preroll as i64).abs() <= 2,
            "lag {} vs -{preroll}",
            m.lag_samples
        );
        assert!(m.confidence > ACCEPT, "confidence {}", m.confidence);
    }

    #[test]
    fn short_take_windows_of_one_source_align_in_both_directions() {
        // The fake-mic e2e shape: two recorders capture the SAME source
        // but their captures started 2.2 s apart, and the take is only
        // 12 s long — the offset must be recoverable regardless of which
        // stream the desk happens to pick as the reference.
        let perf = music_like(RATE as usize * 20, 9);
        let gap = RATE as usize * 22 / 10;
        let len = RATE as usize * 12;
        let deep: Vec<f32> = perf[gap..gap + len].to_vec(); // capture began earlier
        let late: Vec<f32> = perf[..len].to_vec(); // capture began 2.2 s later
        let m = align_content(&deep, &late, RATE).expect("match (late vs deep)");
        assert!(
            (m.lag_samples - gap as i64).abs() <= 2,
            "lag {} vs {gap}",
            m.lag_samples
        );
        assert!(m.confidence > ACCEPT, "confidence {}", m.confidence);
        let m = align_content(&late, &deep, RATE).expect("match (deep vs late)");
        assert!(
            (m.lag_samples + gap as i64).abs() <= 2,
            "lag {} vs -{gap}",
            m.lag_samples
        );
        assert!(m.confidence > ACCEPT, "confidence {}", m.confidence);
    }

    #[test]
    fn product_defaults_recover_offset() {
        // The untuned path the desk actually calls: for_sample_rate
        // defaults (10 s probes) on 30 s captures with a realistic 1.7 s
        // arming spread.
        let preroll = RATE as usize * 17 / 10;
        let (reference, target) = capture_pair_secs(preroll, 1.0e-2, 30);
        let m = align_content(&reference, &target, RATE).expect("match");
        assert!(
            (m.lag_samples - preroll as i64).abs() <= 2,
            "lag {} vs {preroll}",
            m.lag_samples
        );
        assert!(m.confidence > ACCEPT, "confidence {}", m.confidence);
    }

    #[test]
    fn identical_streams_align_at_zero() {
        let content = music_like(RATE as usize * 6, 3);
        let m = align_content_with(&content, &content, &test_config()).expect("match");
        assert_eq!(m.lag_samples, 0);
        assert!(m.confidence > ACCEPT, "confidence {}", m.confidence);
    }

    #[test]
    fn survives_heavy_independent_noise() {
        // Independent mic noise at ≈0 dB SNR (content RMS after the 0.6×
        // capture gain and contour is ~0.035; uniform amp 0.06 ≈ RMS 0.035).
        let preroll = 2_400;
        let (reference, target) = capture_pair(preroll, 0.06);
        let m = align_content_with(&reference, &target, &test_config()).expect("match");
        assert!(
            (m.lag_samples - preroll as i64).abs() <= 4,
            "lag {} vs {preroll}",
            m.lag_samples
        );
        assert!(m.confidence > ACCEPT, "confidence {}", m.confidence);
    }

    #[test]
    fn uncorrelated_takes_never_align() {
        // Two different performances: any reported match must sit below
        // the accept threshold — the desk then declines honestly.
        let a = music_like(RATE as usize * 6, 11);
        let b = music_like(RATE as usize * 6, 12345);
        if let Some(m) = align_content_with(&a, &b, &test_config()) {
            assert!(m.confidence < ACCEPT, "confidence {}", m.confidence);
        }
        let na = noise(RATE as usize * 6, 21, 0.3);
        let nb = noise(RATE as usize * 6, 22, 0.3);
        if let Some(m) = align_content_with(&na, &nb, &test_config()) {
            assert!(m.confidence < ACCEPT, "confidence {}", m.confidence);
        }
    }

    #[test]
    fn periodic_content_is_ambiguous_and_declined() {
        // A bare tone repeats at every period — no honest unique lag
        // exists. Flat envelope ⇒ mean removal leaves nothing to match.
        let tone: Vec<f32> = (0..RATE as usize * 6)
            .map(|i| (2.0 * std::f64::consts::PI * 440.0 * i as f64 / f64::from(RATE)).sin() as f32)
            .map(|v| v * 0.5)
            .collect();
        if let Some(m) = align_content_with(&tone, &tone[8_000..], &test_config()) {
            assert!(m.confidence < ACCEPT, "confidence {}", m.confidence);
        }
        // Periodic beeps (the Chromium fake-mic shape): envelope repeats
        // every 0.5 s — ties at every repeat must kill confidence.
        let beeps: Vec<f32> = (0..RATE as usize * 6)
            .map(|i| {
                let phase = i % (RATE as usize / 2);
                if phase < RATE as usize / 10 {
                    (2.0 * std::f64::consts::PI * 440.0 * i as f64 / f64::from(RATE)).sin() as f32
                        * 0.5
                } else {
                    0.0
                }
            })
            .collect();
        if let Some(m) = align_content_with(&beeps, &beeps[4_000..], &test_config()) {
            assert!(m.confidence < ACCEPT, "confidence {}", m.confidence);
        }
    }

    /// Pair of near-identical chord captures with independent mic noise;
    /// `preroll` extra samples of quiet room at the target's head.
    fn chord_pair(preroll: usize, seed: u64, noise_amp: f32) -> (Vec<f32>, Vec<f32>) {
        let content = chord_like(RATE as usize * 12, seed);
        let ref_noise = noise(content.len(), 101, noise_amp);
        let reference: Vec<f32> = content
            .iter()
            .zip(&ref_noise)
            .map(|(c, n)| c * 0.8 + n)
            .collect();
        let mut target = noise(preroll, 55, 2.0e-4);
        let tgt_noise = noise(content.len(), 77, noise_amp);
        target.extend(content.iter().zip(&tgt_noise).map(|(c, n)| c * 0.6 + n));
        (reference, target)
    }

    #[test]
    fn sustained_chords_keep_the_coarse_lag() {
        // QA MAJOR-1 repro class: raw phase of a steady chord peaks at
        // every pitch period (≈73–291 samples at 16 kHz — well inside the
        // old ±fine_margin roam), so an unguarded fine argmax locks a
        // wrong period with a near-1.0 peak. The envelope lag is the
        // truth; any residual error must stay within ONE hop, never a
        // pitch period.
        let hop = test_config().env_hop as i64;
        for &(preroll, seed) in &[(4_000usize, 3u64), (5_680, 11), (2_400, 29)] {
            let (reference, target) = chord_pair(preroll, seed, 8.0e-3);
            let m = align_content_with(&reference, &target, &test_config()).expect("match");
            assert!(
                (m.lag_samples - preroll as i64).abs() <= hop,
                "preroll {preroll} seed {seed}: lag {} err {}",
                m.lag_samples,
                m.lag_samples - preroll as i64
            );
            assert!(m.confidence > ACCEPT, "confidence {}", m.confidence);
        }
    }

    #[test]
    fn operator_offset_on_chords_stays_within_a_hop() {
        // The QA live-run shape: a −37 ms offset on sustained tonal
        // content picked up a 7 ms fine-pass error. Both directions.
        let cfg = test_config();
        let hop = cfg.env_hop as i64;
        let offset = (RATE as f64 * 0.037) as usize; // 37 ms = 592 samples
        let perf = chord_like(RATE as usize * 14, 17);
        let mic_a = noise(perf.len(), 201, 8.0e-3);
        let mic_b = noise(perf.len(), 203, 8.0e-3);
        let deep: Vec<f32> = perf[offset..]
            .iter()
            .zip(&mic_a)
            .map(|(c, n)| c * 0.8 + n)
            .collect();
        let late: Vec<f32> = perf[..perf.len() - offset]
            .iter()
            .zip(&mic_b)
            .map(|(c, n)| c * 0.6 + n)
            .collect();
        let m = align_content_with(&deep, &late, &cfg).expect("match");
        assert!(
            (m.lag_samples - offset as i64).abs() <= hop,
            "lag {} vs {offset}",
            m.lag_samples
        );
        let m = align_content_with(&late, &deep, &cfg).expect("match");
        assert!(
            (m.lag_samples + offset as i64).abs() <= hop,
            "lag {} vs -{offset}",
            m.lag_samples
        );
    }

    #[test]
    fn lone_transient_lanes_never_align() {
        // QA MAJOR-2 repro, at PRODUCT defaults (the failure needs the
        // real 60 s head — QA's cough and page turn sat 15 s apart): two
        // quiet lanes, one DIFFERENT transient each. The old scan matched
        // cough-to-page-turn at lag −15 s with conf ~24 (silence emptied
        // the sidelobe scan → unbounded prominence; the silence gate left
        // a single probe → no consensus). Every leg must hold: verdict
        // absent or sub-accept — a 15 s head-trim would be catastrophic.
        let a = transient_lane(RATE as usize * 25, RATE as usize * 3, 31);
        let b = transient_lane(RATE as usize * 25, RATE as usize * 18, 37);
        if let Some(m) = align_content(&a, &b, RATE) {
            assert!(
                m.confidence < ACCEPT,
                "confidence {} lag {}",
                m.confidence,
                m.lag_samples
            );
        }
        if let Some(m) = align_content(&b, &a, RATE) {
            assert!(
                m.confidence < ACCEPT,
                "confidence {} lag {}",
                m.confidence,
                m.lag_samples
            );
        }
    }

    #[test]
    fn a_single_shared_transient_is_a_lone_witness_and_declines() {
        // Policy pin: even a GENUINE match carried by exactly one probe
        // (one shared cough on otherwise silent lanes) declines — one
        // witness is no consensus, and the operator sees "declined"
        // rather than a verdict resting on a single moment of audio.
        let a = transient_lane(RATE as usize * 25, RATE as usize * 12, 41);
        let mut b = noise(RATE as usize * 25, 43, 4.0e-4);
        let burst = noise(RATE as usize / 10, 41u64.wrapping_mul(7919) | 1, 0.5);
        let at = RATE as usize * 12 + 800; // same cough, 50 ms more pre-roll
        for (i, &v) in burst.iter().enumerate() {
            b[at + i] += v;
        }
        if let Some(m) = align_content(&a, &b, RATE) {
            assert!(m.confidence < ACCEPT, "confidence {}", m.confidence);
        }
    }

    #[test]
    fn dc_offset_streams_still_align() {
        // NIT-1: cheap phone mics carry DC. The per-window AC RMS keeps
        // the envelope modulated, and the mean-removed fine slices keep
        // sample precision.
        let preroll = 4_000;
        let (mut reference, mut target) = capture_pair(preroll, 1.0e-3);
        for v in reference.iter_mut() {
            *v += 0.15;
        }
        for v in target.iter_mut() {
            *v += 0.2;
        }
        let m = align_content_with(&reference, &target, &test_config()).expect("match");
        assert!(
            (m.lag_samples - preroll as i64).abs() <= 4,
            "lag {} vs {preroll}",
            m.lag_samples
        );
        assert!(m.confidence > ACCEPT, "confidence {}", m.confidence);
    }

    #[test]
    fn beep_grid_with_mic_noise_declines_despite_probe_agreement() {
        // The Chromium fake-mic e2e regression: identical clipped beeps
        // every 0.5 s, two captures 2.5 s apart with tiny independent mic
        // noise. Every candidate lag on the 0.5 s grid is a near-perfect
        // tie; the noise makes one tie fractionally "win" consistently
        // across probes, and an unclamped Fisher ratio near r = 1 turned
        // that float-level difference into decisiveness × agreement → a
        // confident garbage verdict. Ties must decline at ANY agreement.
        let beep: Vec<f32> = (0..RATE as usize * 20)
            .map(|i| {
                let phase = i % (RATE as usize / 2);
                if phase < RATE as usize / 10 {
                    ((2.0 * std::f64::consts::PI * 440.0 * i as f64 / f64::from(RATE)).sin() as f32
                        * 2.0)
                        .clamp(-0.5, 0.5)
                } else {
                    0.0
                }
            })
            .collect();
        let offset = RATE as usize * 5 / 2; // 2.5 s = 5 beep periods
        let len = RATE as usize * 12;
        let mic_a = noise(len, 301, 1.0e-3);
        let mic_b = noise(len, 303, 1.0e-3);
        let a: Vec<f32> = beep[offset..offset + len]
            .iter()
            .zip(&mic_a)
            .map(|(c, n)| c + n)
            .collect();
        let b: Vec<f32> = beep[..len].iter().zip(&mic_b).map(|(c, n)| c + n).collect();
        if let Some(m) = align_content(&a, &b, RATE) {
            assert!(
                m.confidence < ACCEPT,
                "confidence {} lag {}",
                m.confidence,
                m.lag_samples
            );
        }
    }

    #[test]
    fn silence_and_degenerate_inputs_are_none() {
        let cfg = test_config();
        assert!(
            align_content_with(
                &vec![0.0; RATE as usize * 4],
                &vec![0.0; RATE as usize * 4],
                &cfg
            )
            .is_none()
        );
        assert!(align_content_with(&[], &[], &cfg).is_none());
        assert!(align_content_with(&[0.1; 100], &[0.1; 100], &cfg).is_none());
        let mut bad = music_like(RATE as usize * 4, 5);
        bad[1_000] = f32::NAN;
        assert!(align_content_with(&bad, &music_like(RATE as usize * 4, 5), &cfg).is_none());
        assert!(align_content_with(&music_like(RATE as usize * 4, 5), &bad, &cfg).is_none());
    }
}
