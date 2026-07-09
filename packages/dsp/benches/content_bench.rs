//! Content-alignment throughput (W7-D).
//!
//! `align_content` at product defaults is the desk's chirp-less fallback:
//! it runs once per stream pair on take load, on stream HEADS only (≤ 60 s).
//! The envelope stage dominates (per-hop RMS + four probe scans over the
//! whole head); the fine PCM pass is one ~1 s correlation. Keeping the
//! product-shaped pair well under a second means alignment stays an
//! imperceptible part of take load — and gives calibration work (onset
//! weighting) a regression floor to stay within.

use criterion::{Criterion, Throughput, criterion_group, criterion_main};
use std::hint::black_box;

use antiphon_dsp::content::align_content;

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

/// Music-like room content (the content.rs test recipe at bench scale):
/// three non-harmonic tones under syllable-rate AM plus band-limited noise,
/// all under an aperiodic 0.5 s-knot loudness contour — the modulations the
/// envelope stage actually locks onto. Deterministic (seeded LCG only).
fn music_like(len: usize, rate: u32, seed: u64) -> Vec<f32> {
    const TONES: [(f64, f64); 3] = [(220.0, 0.11), (311.1, 0.07), (466.2, 0.05)];
    let rate_f = f64::from(rate);
    let detune = 1.0 + (seed % 13) as f64 * 0.021;
    let am_shift = (seed % 7) as f64 * 0.41;
    let knot_len = rate as usize / 2;
    let mut contour_state = seed.wrapping_mul(31) | 1;
    let knots: Vec<f32> = (0..len / knot_len + 2)
        .map(|_| 0.7 + 0.3 * lcg(&mut contour_state))
        .collect();
    let mut state = seed | 1;
    let (mut lp1, mut lp2) = (0.0f32, 0.0f32);
    (0..len)
        .map(|i| {
            let t = i as f64 / rate_f;
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

fn bench_align_content(c: &mut Criterion) {
    // Product-shaped: two 30 s captures @ 48 kHz of one performance with
    // independent mic noise and a realistic 1.7 s arming spread — the
    // untuned `align_content` path the desk calls on take load.
    let rate = 48_000u32;
    let secs = 30usize;
    let preroll = rate as usize * 17 / 10;
    let content = music_like(rate as usize * secs, rate, 7);
    let ref_noise = noise(content.len(), 101, 1.0e-2);
    let reference: Vec<f32> = content
        .iter()
        .zip(&ref_noise)
        .map(|(c, n)| c * 0.8 + n)
        .collect();
    let mut target = noise(preroll, 55, 2.0e-3);
    let tgt_noise = noise(content.len(), 77, 1.0e-2);
    target.extend(content.iter().zip(&tgt_noise).map(|(c, n)| c * 0.6 + n));

    let mut group = c.benchmark_group("align_content");
    group.sample_size(20);
    group.throughput(Throughput::Elements(u64::from(rate) * secs as u64));
    group.bench_function("pair_30s_48k_product_defaults", |b| {
        b.iter(|| {
            align_content(black_box(&reference), black_box(&target), rate)
                .expect("shared performance must match")
        })
    });
    group.finish();
}

criterion_group!(benches, bench_align_content);
criterion_main!(benches);
