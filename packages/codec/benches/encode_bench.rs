//! FLAC encode realtime factor (W3-E).
//!
//! The encoder runs on phones inside the recorder worker; the number that
//! matters is the realtime factor at 48 kHz mono. Divide the reported
//! Melem/s by 0.048 for RTF — anything ≥ ~10× leaves headroom for cheap
//! phones and browser overhead.

use criterion::{BatchSize, Criterion, Throughput, criterion_group, criterion_main};
use std::hint::black_box;

use antiphon_codec::{EncoderConfig, StreamEncoder};

/// Music-like content (tones + noise floor): representative of what the
/// predictor actually sees — neither the silence best case nor the
/// white-noise worst case.
fn music_like(len: usize, rate: u32) -> Vec<f32> {
    let mut state = 0x00DD_BA11_u64;
    (0..len)
        .map(|i| {
            let t = i as f64 / f64::from(rate);
            let tone = 0.3 * (2.0 * std::f64::consts::PI * 220.0 * t).sin()
                + 0.15 * (2.0 * std::f64::consts::PI * 311.1 * t).sin();
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let noise = f64::from((state >> 33) as i32) / f64::from(i32::MAX) * 0.05;
            (tone + noise) as f32
        })
        .collect()
}

fn bench_encode(c: &mut Criterion) {
    let rate = 48_000u32;
    let one_second = music_like(rate as usize, rate);

    for bits in [16u8, 24] {
        let mut group = c.benchmark_group(format!("flac_encode_{bits}bit"));
        group.sample_size(20);
        group.throughput(Throughput::Elements(u64::from(rate)));
        group.bench_function("one_second_48k_mono", |b| {
            b.iter_batched(
                || {
                    StreamEncoder::new(EncoderConfig {
                        sample_rate: rate,
                        bits_per_sample: bits,
                    })
                    .expect("valid config")
                },
                |mut enc| {
                    let mut chunks = enc.push_f32(black_box(&one_second)).expect("encode");
                    chunks.extend(enc.finish().expect("finish"));
                    chunks
                },
                BatchSize::SmallInput,
            )
        });
        group.finish();
    }
}

criterion_group!(benches, bench_encode);
criterion_main!(benches);
