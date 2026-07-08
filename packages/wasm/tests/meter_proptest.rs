//! The experimental METER frame (0x80, private range per RFC §6.1) is the
//! one decode path implemented in this facade rather than in
//! `antiphon-core` — so it gets the same fuzz-shaped treatment: totality on
//! arbitrary bytes, mutation-resistance, and non-finite peak hygiene.
//!
//! Runs on the native target (the meter codec is plain Rust); wasm-bindgen
//! is inert here.

use antiphon_wasm::{FT_METER_EXPERIMENTAL, decode_meter_frame, encode_meter_frame};
use proptest::prelude::*;

proptest! {
    /// Decode is total on arbitrary bytes; anything accepted must have the
    /// exact meter shape (length, magic, version, type).
    #[test]
    fn decode_total_on_arbitrary_bytes(bytes in prop::collection::vec(any::<u8>(), 0..128)) {
        if decode_meter_frame(&bytes).is_some() {
            prop_assert_eq!(bytes.len(), 40);
            prop_assert_eq!(&bytes[0..2], b"AN");
            prop_assert_eq!(bytes[2], 0x01);
            prop_assert_eq!(bytes[3], FT_METER_EXPERIMENTAL);
        }
    }

    /// encode → decode roundtrips; the peak is clamped to [0, 1] on encode
    /// and non-finite peaks never surface in the JSON.
    #[test]
    fn roundtrip_with_clamped_peak(
        take_id in any::<[u8; 16]>(),
        stream_id in any::<[u8; 16]>(),
        peak in any::<f32>(),
    ) {
        let bytes = encode_meter_frame(&take_id, &stream_id, peak)
            .expect("16-byte ids are valid");
        prop_assert_eq!(bytes.len(), 40);
        let json = decode_meter_frame(&bytes).expect("own encoding decodes");
        prop_assert!(!json.contains("NaN") && !json.contains("inf"), "json: {json}");
        if peak.is_finite() {
            // The facade emits numbers via f64 formatting; mirror it.
            let clamped = f64::from(peak.clamp(0.0, 1.0));
            let expected = if clamped.fract() == 0.0 {
                format!("\"peak\":{}", clamped as i64)
            } else {
                format!("\"peak\":{clamped}")
            };
            prop_assert!(json.contains(&expected), "json: {json} want {expected}");
        }
    }

    /// Bit flips over a valid meter frame never panic; the frame either
    /// still parses as a meter frame or is rejected outright.
    #[test]
    fn bit_flips_total(
        take_id in any::<[u8; 16]>(),
        stream_id in any::<[u8; 16]>(),
        peak in 0.0f32..=1.0,
        flips in prop::collection::vec((any::<prop::sample::Index>(), 0u8..8), 1..6),
    ) {
        let mut bytes = encode_meter_frame(&take_id, &stream_id, peak)
            .expect("16-byte ids are valid");
        for (idx, bit) in flips {
            let i = idx.index(bytes.len());
            bytes[i] ^= 1 << bit;
        }
        let _ = decode_meter_frame(&bytes); // totality is the property
    }

    /// Truncations and extensions are rejected (fixed 40-byte shape).
    #[test]
    fn wrong_lengths_rejected(
        take_id in any::<[u8; 16]>(),
        stream_id in any::<[u8; 16]>(),
        cut in 0usize..40,
        tail in prop::collection::vec(any::<u8>(), 1..16),
    ) {
        let bytes = encode_meter_frame(&take_id, &stream_id, 0.5).expect("valid ids");
        prop_assert!(decode_meter_frame(&bytes[..cut]).is_none());
        let mut extended = bytes.clone();
        extended.extend_from_slice(&tail);
        prop_assert!(decode_meter_frame(&extended).is_none());
    }
}
