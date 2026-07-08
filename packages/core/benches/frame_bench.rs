//! Wire-format and ingest throughput (W3-E).
//!
//! Context for the numbers: one recorder stream is ~2 chunks/s of ~38 KB
//! (§6.3), so a session of 8 phones asks ~16 chunks/s of a sink — anything
//! above tens of thousands of chunks/s means framing/ingest can never be
//! the bottleneck, on the desk or the server.

use criterion::{BatchSize, Criterion, Throughput, criterion_group, criterion_main};
use std::hint::black_box;

use antiphon_core::chunk::audio_chunk;
use antiphon_core::frame::{AckStatus, AudioChunk, Frame, SeqRange, StreamKey};
use antiphon_core::receiver::StreamReceiver;

fn stream() -> StreamKey {
    StreamKey {
        take_id: [0xA7; 16],
        stream_id: [0x51; 16],
    }
}

/// Deterministic FLAC-ish (incompressible) payload bytes.
fn payload(len: usize, seed: u64) -> Vec<u8> {
    let mut state = seed | 1;
    (0..len)
        .map(|_| {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 33) as u8
        })
        .collect()
}

/// One nominal chunk: 500 ms @ 48 kHz/24-bit mono FLAC ≈ 38 KB (§6.3).
fn nominal_chunk(seq: u32) -> AudioChunk {
    audio_chunk(
        stream(),
        seq,
        u64::from(seq) * 24_000,
        24_000,
        u64::from(seq) * 500_000,
        payload(38 * 1024, u64::from(seq)),
    )
}

fn bench_frame_codec(c: &mut Criterion) {
    let chunk = nominal_chunk(7);
    let encoded = Frame::AudioChunk(chunk.clone()).encode();

    let mut group = c.benchmark_group("frame");
    group.throughput(Throughput::Bytes(encoded.len() as u64));
    group.bench_function("encode_audio_chunk_38k", |b| {
        let frame = Frame::AudioChunk(chunk.clone());
        b.iter(|| black_box(&frame).encode())
    });
    group.bench_function("decode_audio_chunk_38k", |b| {
        b.iter(|| Frame::decode(black_box(&encoded)).expect("valid"))
    });
    group.finish();

    let ack = Frame::AckStatus(AckStatus {
        stream: stream(),
        chwm: 1_000,
        holes: (0..64)
            .map(|i| SeqRange::new(1_010 + i * 10, 1_014 + i * 10))
            .collect(),
    });
    let ack_bytes = ack.encode();
    let mut group = c.benchmark_group("frame_ack");
    group.throughput(Throughput::Bytes(ack_bytes.len() as u64));
    group.bench_function("decode_ack_64_holes", |b| {
        b.iter(|| Frame::decode(black_box(&ack_bytes)).expect("valid"))
    });
    group.finish();
}

fn bench_receiver_ingest(c: &mut Criterion) {
    // 100 chunks ≈ 50 s of one stream at nominal sizing. Ingest includes
    // the CRC-32C pass over every payload byte — the honest cost.
    let chunks: Vec<AudioChunk> = (1..=100).map(nominal_chunk).collect();
    let total_bytes: usize = chunks.iter().map(|c| c.payload.len()).sum();

    let mut group = c.benchmark_group("receiver");
    group.throughput(Throughput::Elements(chunks.len() as u64));
    group.bench_function("ingest_100_chunks_38k", |b| {
        b.iter_batched(
            StreamReceiver::new,
            |mut recv| {
                for chunk in &chunks {
                    black_box(recv.ingest(black_box(chunk)));
                }
                recv
            },
            BatchSize::SmallInput,
        )
    });
    group.finish();

    let mut group = c.benchmark_group("receiver_bytes");
    group.throughput(Throughput::Bytes(total_bytes as u64));
    group.bench_function("ingest_100_chunks_38k_bytes", |b| {
        b.iter_batched(
            StreamReceiver::new,
            |mut recv| {
                for chunk in &chunks {
                    black_box(recv.ingest(black_box(chunk)));
                }
                recv
            },
            BatchSize::SmallInput,
        )
    });
    group.finish();
}

criterion_group!(benches, bench_frame_codec, bench_receiver_ingest);
criterion_main!(benches);
