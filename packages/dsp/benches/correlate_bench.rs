//! Correlation throughput (W3-E).
//!
//! `correlation_series` on a ~1 s @ 48 kHz window is the drift estimator's
//! unit of work (one window every ~30 s of audio per stream) and the chirp
//! locator's inner loop. Time-per-window ≪ window interval means drift
//! re-correlation is effectively free at render/ingest time.

use criterion::{Criterion, Throughput, criterion_group, criterion_main};
use std::hint::black_box;

use antiphon_dsp::chirp::generate_ess;
use antiphon_dsp::correlate::{correlation_series, find_chirp};

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

fn bench_correlation_series(c: &mut Criterion) {
    let rate = 48_000usize;

    // Drift-shaped: 1 s target window against a reference segment padded
    // by the ±100 ms search margin (DriftConfig defaults at t≈30 s).
    let window = noise(rate, 11, 0.5);
    let segment = noise(rate + 2 * 4_800, 13, 0.5);

    let mut group = c.benchmark_group("correlation_series");
    group.throughput(Throughput::Elements(rate as u64));
    group.bench_function("drift_window_1s_48k", |b| {
        b.iter(|| correlation_series(black_box(&segment), black_box(&window)).expect("valid"))
    });
    group.finish();
}

fn bench_find_chirp(c: &mut Criterion) {
    // Calibration-shaped: locate the §10 sweep inside 10 s of room audio.
    let rate = 48_000u32;
    let chirp = generate_ess(rate, 200.0, 8_000.0, 1_000.0, -12.0);
    let mut signal = noise(rate as usize * 10, 17, 0.02);
    for (i, &s) in chirp.iter().enumerate() {
        signal[123_456 + i] += s * 0.5;
    }

    let mut group = c.benchmark_group("find_chirp");
    group.sample_size(20);
    group.throughput(Throughput::Elements(u64::from(rate) * 10));
    group.bench_function("locate_1s_sweep_in_10s_48k", |b| {
        b.iter(|| {
            find_chirp(
                black_box(&signal),
                rate,
                200.0,
                8_000.0,
                1_000.0,
                -12.0,
                1,
                0.0,
            )
            .expect("embedded chirp found")
        })
    });
    group.finish();
}

criterion_group!(benches, bench_correlation_series, bench_find_chirp);
criterion_main!(benches);
