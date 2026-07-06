//! Probe: how large can a single encoded FLAC frame get, per content class?

use antiphon_codec::{EncoderConfig, StreamEncoder};

#[test]
fn probe_flacenc_reference_path() {
    // Same pathological input, through flacenc's own high-level API.
    let max = (1i64 << 23) - 1;
    let min = -(1i64 << 23);
    let input: Vec<i32> = (0..4080)
        .map(|i| {
            if (i / 64) % 2 == 0 {
                max as i32 / 2
            } else {
                min as i32 / 2
            }
        })
        .collect();
    let mut cfg = flacenc::config::Encoder::default();
    cfg.block_size = 4096;
    cfg.multithread = false;
    let cfg = flacenc::error::Verify::into_verified(cfg).unwrap();
    let source = flacenc::source::MemSource::from_samples(&input, 1, 24, 44_100);
    let stream = flacenc::encode_with_fixed_block_size(&cfg, source, 4096).unwrap();
    let mut sink = flacenc::bitsink::ByteSink::new();
    flacenc::component::BitRepr::write(&stream, &mut sink).unwrap();
    let bytes = sink.into_inner();
    println!("flacenc reference path total bytes: {}", bytes.len());
    let mut reader = claxon::FlacReader::new(std::io::Cursor::new(bytes)).expect("valid flac");
    let decoded: Vec<i32> = reader.samples().map(|s| s.expect("sample")).collect();
    assert_eq!(decoded, input);
}

fn frame_sizes(bits: u8, input: &[i32]) -> Vec<usize> {
    let mut enc = StreamEncoder::new(EncoderConfig {
        sample_rate: 48_000,
        bits_per_sample: bits,
    })
    .unwrap();
    let mut chunks = enc.push_i32(input).unwrap();
    chunks.extend(enc.finish().unwrap());
    chunks.iter().map(|c| c.payload.len()).collect()
}

#[test]
fn probe_minimal_regression() {
    // seed=0, len=4080, slab=1, bits=24, rate=44100, kind=3 (square-ish)
    let max = (1i64 << 23) - 1;
    let min = -(1i64 << 23);
    let input: Vec<i32> = (0..4080)
        .map(|i| {
            if (i / 64) % 2 == 0 {
                max as i32 / 2
            } else {
                min as i32 / 2
            }
        })
        .collect();
    let mut enc = StreamEncoder::new(EncoderConfig {
        sample_rate: 44_100,
        bits_per_sample: 24,
    })
    .unwrap();
    let mut chunks = Vec::new();
    for s in input.chunks(1) {
        chunks.extend(enc.push_i32(s).unwrap());
    }
    chunks.extend(enc.finish().unwrap());
    let mut flac = enc.codec_header();
    for c in &chunks {
        flac.extend_from_slice(&c.payload);
    }
    let mut reader = claxon::FlacReader::new(std::io::Cursor::new(flac)).expect("valid flac");
    let decoded: Vec<i32> = reader.samples().map(|s| s.expect("sample")).collect();
    assert_eq!(decoded, input);
}

#[test]
fn probe_noise_frame_size() {
    let max = (1i64 << 23) - 1;
    let min = -(1i64 << 23);
    let mut state = 3u64;
    let input: Vec<i32> = (0..4096)
        .map(|_| {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((i64::from((state >> 33) as u32) % (max - min + 1)) + min) as i32
        })
        .collect();
    let sizes = frame_sizes(24, &input);
    println!("24-bit noise single block chunk sizes: {sizes:?}");
    assert!(
        sizes.iter().all(|&s| s < 20_000),
        "noise frame blew up: {sizes:?}"
    );
}
