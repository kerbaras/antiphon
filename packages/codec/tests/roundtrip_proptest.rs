//! Property: for arbitrary audio content, push granularity, and take length,
//! `codec_header ++ concat(chunk payloads)` decodes to exactly the input
//! samples. Lossless is not a vibe, it is an equation.

use antiphon_codec::{EncoderConfig, StreamEncoder};
use proptest::prelude::*;

fn decode(bytes: &[u8]) -> Vec<i32> {
    let mut reader =
        claxon::FlacReader::new(std::io::Cursor::new(bytes.to_vec())).expect("valid flac");
    reader.samples().map(|s| s.expect("sample")).collect()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    #[test]
    fn lossless_roundtrip(
        seed in any::<u64>(),
        len in 0usize..40_000,
        slab in 1usize..8_192,
        bits in prop_oneof![Just(16u8), Just(24u8)],
        rate in prop_oneof![Just(44_100u32), Just(48_000u32)],
        kind in 0u8..4,
    ) {
        // Content families: silence, noise, sine, square-ish (worst cases
        // for prediction: constant, incompressible, tonal, discontinuous).
        let max = (1i64 << (bits - 1)) - 1;
        let min = -(1i64 << (bits - 1));
        let mut state = seed | 1;
        let mut rnd = move || {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (state >> 33) as u32
        };
        let input: Vec<i32> = (0..len)
            .map(|i| match kind {
                0 => 0,
                1 => ((i64::from(rnd()) % (max - min + 1)) + min) as i32,
                2 => ((f64::from(i as u32) * 0.05).sin() * max as f64 * 0.8) as i32,
                _ => if (i / 64) % 2 == 0 { max as i32 / 2 } else { min as i32 / 2 },
            })
            .collect();

        let mut enc = StreamEncoder::new(EncoderConfig {
            sample_rate: rate,
            bits_per_sample: bits,
        }).unwrap();
        let mut chunks = Vec::new();
        for s in input.chunks(slab) {
            chunks.extend(enc.push_i32(s).unwrap());
        }
        chunks.extend(enc.finish().unwrap());

        let mut flac = enc.codec_header();
        let mut cursor = 0u64;
        for c in &chunks {
            prop_assert_eq!(c.first_sample_index, cursor);
            prop_assert!(c.payload.len() <= antiphon_core::constants::MAX_CHUNK_PAYLOAD_BYTES);
            cursor += u64::from(c.sample_count);
            flac.extend_from_slice(&c.payload);
        }
        prop_assert_eq!(cursor, input.len() as u64);
        prop_assert_eq!(decode(&flac), input);
    }
}
