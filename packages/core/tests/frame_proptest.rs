//! Wire-format properties: decode totality (never panics, on anything) and
//! encode/decode roundtrip fidelity for every frame type.

use antiphon_core::chunk::StreamHeaderV1;
use antiphon_core::frame::{
    AckStatus, AudioChunk, Decoded, Frame, RangeList, SeqRange, StreamKey, TimePing, TimePong,
};
use proptest::prelude::*;

fn arb_stream_key() -> impl Strategy<Value = StreamKey> {
    (any::<[u8; 16]>(), any::<[u8; 16]>())
        .prop_map(|(take_id, stream_id)| StreamKey { take_id, stream_id })
}

fn arb_ranges() -> impl Strategy<Value = Vec<SeqRange>> {
    prop::collection::vec((any::<u32>(), 0u32..1024), 0..24).prop_map(|pairs| {
        pairs
            .into_iter()
            .map(|(start, span)| SeqRange::new(start, start.saturating_add(span)))
            .collect()
    })
}

fn arb_frame() -> impl Strategy<Value = Frame> {
    let chunk = (
        arb_stream_key(),
        any::<u32>(),
        any::<u64>(),
        any::<u32>(),
        any::<u64>(),
        prop::collection::vec(any::<u8>(), 0..2048),
    )
        .prop_map(|(stream, seq, fsi, count, ts, payload)| {
            Frame::AudioChunk(AudioChunk {
                stream,
                seq,
                first_sample_index: fsi,
                sample_count: count,
                capture_ts_us: ts,
                crc32c: antiphon_core::crc32c::crc32c(&payload),
                payload,
            })
        });
    let ack = (arb_stream_key(), any::<u32>(), arb_ranges()).prop_map(|(stream, chwm, holes)| {
        Frame::AckStatus(AckStatus {
            stream,
            chwm,
            holes,
        })
    });
    let list = (arb_stream_key(), arb_ranges(), 0u8..3).prop_map(|(stream, ranges, kind)| {
        let list = RangeList { stream, ranges };
        match kind {
            0 => Frame::BackfillRequest(list),
            1 => Frame::GapReport(list),
            _ => Frame::HaveSummary(list),
        }
    });
    let ping = (any::<u32>(), any::<u64>())
        .prop_map(|(ping_id, t1)| Frame::TimePing(TimePing { ping_id, t1 }));
    let pong = (any::<u32>(), any::<u64>(), any::<u64>(), any::<u64>()).prop_map(
        |(ping_id, t1, t2, t3)| {
            Frame::TimePong(TimePong {
                ping_id,
                t1,
                t2,
                t3,
            })
        },
    );
    prop_oneof![chunk, ack, list, ping, pong]
}

proptest! {
    /// Decode is total: arbitrary bytes never panic.
    #[test]
    fn decode_never_panics(bytes in prop::collection::vec(any::<u8>(), 0..4096)) {
        let _ = Frame::decode(&bytes);
    }

    /// Arbitrary bytes behind a valid header never panic either (exercises
    /// every per-type parser instead of dying at the magic check).
    #[test]
    fn decode_never_panics_valid_header(
        frame_type in any::<u8>(),
        body in prop::collection::vec(any::<u8>(), 0..4096),
    ) {
        let mut bytes = vec![0x41, 0x4E, 0x01, frame_type];
        bytes.extend_from_slice(&body);
        let _ = Frame::decode(&bytes);
    }

    /// encode → decode is the identity for every frame type.
    #[test]
    fn roundtrip(frame in arb_frame()) {
        let bytes = frame.encode();
        prop_assert!(bytes.len() <= antiphon_core::constants::MAX_FRAME_BYTES);
        prop_assert_eq!(Frame::decode(&bytes), Ok(Decoded::Frame(frame)));
    }

    /// Any truncation of a valid frame is an error, never a panic and never
    /// a silently different frame.
    #[test]
    fn truncations_error(frame in arb_frame(), keep_fraction in 0.0f64..1.0) {
        let bytes = frame.encode();
        let cut = ((bytes.len() as f64) * keep_fraction) as usize;
        if cut < bytes.len() {
            prop_assert!(Frame::decode(&bytes[..cut]).is_err());
        }
    }

    /// Stream header (seq-0 payload) roundtrips and survives truncation.
    #[test]
    fn stream_header_roundtrip(
        codec in any::<u8>(),
        bits in prop_oneof![Just(16u8), Just(24u8)],
        rate in prop_oneof![Just(44_100u32), Just(48_000u32), any::<u32>()],
        epoch in any::<u64>(),
        wall in any::<u64>(),
        desc in ".{0,64}",
        codec_header in prop::collection::vec(any::<u8>(), 0..128),
        cut_fraction in 0.0f64..1.0,
    ) {
        let header = StreamHeaderV1 {
            codec,
            channels: 1,
            bits_per_sample: bits,
            sample_rate: rate,
            clock_epoch_us: epoch,
            wall_clock_hint_ms: wall,
            device_desc: desc,
            codec_header,
        };
        let bytes = header.encode();
        prop_assert_eq!(StreamHeaderV1::decode(&bytes), Ok(header));
        let cut = ((bytes.len() as f64) * cut_fraction) as usize;
        if cut < bytes.len() {
            prop_assert!(StreamHeaderV1::decode(&bytes[..cut]).is_err());
        }
    }
}
