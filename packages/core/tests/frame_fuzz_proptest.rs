//! Fuzz-shaped decoder hardening (W3-E), extending `frame_proptest.rs`:
//! structure-aware mutations of *valid* frames — bit flips, truncations,
//! length-field lies — against every decode entry point, plus explicit
//! hostile-length DoS probes.
//!
//! The load-bearing property is **canonical totality**: decoding arbitrary
//! bytes never panics, and any byte string that decodes successfully
//! re-encodes to exactly itself. Canonicity is what makes the mutation
//! tests strong — a decoder that silently mis-reads a lying length field
//! cannot re-produce the mutated bytes.

use antiphon_core::chunk::{STREAM_HEADER_MAGIC, StreamHeaderV1};
use antiphon_core::constants::{AUDIO_CHUNK_HEADER_LEN, MAX_CHUNK_PAYLOAD_BYTES, MAX_FRAME_BYTES};
use antiphon_core::frame::{
    AckStatus, AudioChunk, DecodeError, Decoded, FT_ACK_STATUS, FT_AUDIO_CHUNK, Frame, RangeList,
    SeqRange, StreamKey, TimePing, TimePong,
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

fn arb_audio_chunk() -> impl Strategy<Value = AudioChunk> {
    (
        arb_stream_key(),
        any::<u32>(),
        any::<u64>(),
        any::<u32>(),
        any::<u64>(),
        prop::collection::vec(any::<u8>(), 0..2048),
    )
        .prop_map(|(stream, seq, fsi, count, ts, payload)| AudioChunk {
            stream,
            seq,
            first_sample_index: fsi,
            sample_count: count,
            capture_ts_us: ts,
            crc32c: antiphon_core::crc32c::crc32c(&payload),
            payload,
        })
}

fn arb_frame() -> impl Strategy<Value = Frame> {
    let chunk = arb_audio_chunk().prop_map(Frame::AudioChunk);
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

fn arb_header() -> impl Strategy<Value = StreamHeaderV1> {
    (
        any::<u8>(),
        any::<u8>(),
        any::<u8>(),
        any::<u32>(),
        any::<u64>(),
        any::<u64>(),
        ".{0,64}",
        prop::collection::vec(any::<u8>(), 0..128),
    )
        .prop_map(
            |(codec, channels, bits, rate, epoch, wall, desc, codec_header)| StreamHeaderV1 {
                codec,
                channels,
                bits_per_sample: bits,
                sample_rate: rate,
                clock_epoch_us: epoch,
                wall_clock_hint_ms: wall,
                device_desc: desc,
                codec_header,
            },
        )
}

proptest! {
    /// Structure-aware mutation: arbitrary bit flips over a valid frame.
    /// Decode must stay total, and any accepted result must be canonical
    /// (re-encode to exactly the mutated bytes).
    #[test]
    fn frame_bit_flips_total_and_canonical(
        frame in arb_frame(),
        flips in prop::collection::vec((any::<prop::sample::Index>(), 0u8..8), 1..8),
    ) {
        let mut bytes = frame.encode();
        for (idx, bit) in flips {
            let i = idx.index(bytes.len());
            bytes[i] ^= 1 << bit;
        }
        match Frame::decode(&bytes) {
            Ok(Decoded::Frame(f)) => prop_assert_eq!(f.encode(), bytes),
            Ok(Decoded::UnknownType(t)) => prop_assert_eq!(t, bytes[3]),
            Err(_) => {} // rejection is always legal for corrupted bytes
        }
    }

    /// Splice arbitrary tails onto a valid frame: every known frame type is
    /// fixed-shape (self-describing lengths + expect_end), so extension must
    /// be rejected — never silently absorbed into a payload.
    #[test]
    fn frame_extensions_rejected(
        frame in arb_frame(),
        tail in prop::collection::vec(any::<u8>(), 1..64),
    ) {
        let mut bytes = frame.encode();
        bytes.extend_from_slice(&tail);
        if bytes.len() <= MAX_FRAME_BYTES {
            prop_assert!(Frame::decode(&bytes).is_err());
        } else {
            prop_assert_eq!(Frame::decode(&bytes), Err(DecodeError::Oversize(bytes.len())));
        }
    }

    /// AUDIO_CHUNK `payload_len` lies: any claim that disagrees with the
    /// actual byte count is an error — oversize claims (the classic
    /// pre-allocation DoS) must die at the bound check, not at an allocator.
    #[test]
    fn payload_len_lies_rejected(chunk in arb_audio_chunk(), lie in any::<u32>()) {
        let truth = chunk.payload.len() as u32;
        let mut bytes = Frame::AudioChunk(chunk).encode();
        bytes[AUDIO_CHUNK_HEADER_LEN - 4..AUDIO_CHUNK_HEADER_LEN]
            .copy_from_slice(&lie.to_le_bytes());
        let decoded = Frame::decode(&bytes);
        if lie == truth {
            prop_assert!(matches!(decoded, Ok(Decoded::Frame(Frame::AudioChunk(_)))));
        } else {
            prop_assert!(decoded.is_err(), "lie {lie} vs truth {truth}: {decoded:?}");
        }
    }

    /// Range-list `hole_count` lies (ACK_STATUS layout, §6.4): any count
    /// that disagrees with the bytes present is rejected before the range
    /// vector is built.
    #[test]
    fn hole_count_lies_rejected(
        stream in arb_stream_key(),
        chwm in any::<u32>(),
        holes in arb_ranges(),
        lie in any::<u16>(),
    ) {
        let truth = holes.len() as u16;
        let mut bytes = Frame::AckStatus(AckStatus { stream, chwm, holes }).encode();
        // ACK_STATUS: 4 header + 32 keys + 4 chwm, then the u16 count.
        bytes[40..42].copy_from_slice(&lie.to_le_bytes());
        let decoded = Frame::decode(&bytes);
        if lie == truth {
            prop_assert!(matches!(decoded, Ok(Decoded::Frame(Frame::AckStatus(_)))));
        } else {
            prop_assert!(decoded.is_err(), "lie {lie} vs truth {truth}: {decoded:?}");
        }
    }

    /// StreamHeaderV1 (seq-0 payload) decode is total on arbitrary bytes,
    /// and canonical for anything it accepts.
    #[test]
    fn stream_header_arbitrary_bytes_total_and_canonical(
        bytes in prop::collection::vec(any::<u8>(), 0..4096),
    ) {
        if let Ok(h) = StreamHeaderV1::decode(&bytes) {
            prop_assert_eq!(h.encode(), bytes);
        }
    }

    /// Same, seeded with valid headers plus bit flips so the parser body is
    /// exercised beyond the magic check.
    #[test]
    fn stream_header_bit_flips_total_and_canonical(
        header in arb_header(),
        flips in prop::collection::vec((any::<prop::sample::Index>(), 0u8..8), 1..8),
    ) {
        let mut bytes = header.encode();
        for (idx, bit) in flips {
            let i = idx.index(bytes.len());
            bytes[i] ^= 1 << bit;
        }
        if let Ok(h) = StreamHeaderV1::decode(&bytes) {
            prop_assert_eq!(h.encode(), bytes);
        }
    }

    /// StreamHeaderV1 length-field lies: desc_len is at offset 28.
    #[test]
    fn stream_header_desc_len_lies_total(header in arb_header(), lie in any::<u16>()) {
        let mut bytes = header.encode();
        bytes[28..30].copy_from_slice(&lie.to_le_bytes());
        if let Ok(h) = StreamHeaderV1::decode(&bytes) {
            prop_assert_eq!(h.encode(), bytes);
        }
    }
}

/// The classic decode DoS: a 68-byte AUDIO_CHUNK header claiming a
/// 4 GiB payload. Must be rejected by the payload bound / buffer check —
/// `Reader::bytes` validates against the actual buffer before any
/// allocation happens (see also `decode_alloc_guard.rs`).
#[test]
fn huge_payload_len_claim_rejected() {
    let chunk = AudioChunk {
        stream: StreamKey {
            take_id: [1; 16],
            stream_id: [2; 16],
        },
        seq: 1,
        first_sample_index: 0,
        sample_count: 100,
        capture_ts_us: 0,
        crc32c: 0,
        payload: vec![],
    };
    let mut bytes = Frame::AudioChunk(chunk).encode();
    assert_eq!(bytes.len(), AUDIO_CHUNK_HEADER_LEN);
    for claim in [
        u32::MAX,
        u32::MAX - 1,
        MAX_CHUNK_PAYLOAD_BYTES as u32 + 1,
        MAX_CHUNK_PAYLOAD_BYTES as u32,
        1,
    ] {
        bytes[AUDIO_CHUNK_HEADER_LEN - 4..].copy_from_slice(&claim.to_le_bytes());
        let decoded = Frame::decode(&bytes);
        assert!(decoded.is_err(), "claim {claim}: {decoded:?}");
    }
}

/// hole_count = 0xFFFF (524 KB of claimed ranges) on a count-only body:
/// rejected by the remaining-bytes precheck before `Vec::with_capacity`.
#[test]
fn huge_hole_count_claim_rejected() {
    let mut bytes = vec![0x41, 0x4E, 0x01, FT_ACK_STATUS];
    bytes.extend_from_slice(&[0u8; 32]); // take_id + stream_id
    bytes.extend_from_slice(&0u32.to_le_bytes()); // chwm
    bytes.extend_from_slice(&u16::MAX.to_le_bytes()); // hole_count lie
    assert_eq!(Frame::decode(&bytes), Err(DecodeError::Truncated));
}

/// A maximum-size frame with a self-consistent payload_len still decodes
/// (the bound checks must not over-reject at the boundary)…
#[test]
fn boundary_payload_len_accepted() {
    let payload = vec![0xAB; MAX_CHUNK_PAYLOAD_BYTES];
    let chunk = AudioChunk {
        stream: StreamKey {
            take_id: [1; 16],
            stream_id: [2; 16],
        },
        seq: 1,
        first_sample_index: 0,
        sample_count: 24_000,
        capture_ts_us: 0,
        crc32c: antiphon_core::crc32c::crc32c(&payload),
        payload,
    };
    let bytes = Frame::AudioChunk(chunk.clone()).encode();
    assert_eq!(bytes.len(), MAX_FRAME_BYTES);
    assert_eq!(
        Frame::decode(&bytes),
        Ok(Decoded::Frame(Frame::AudioChunk(chunk)))
    );
}

/// …and one byte past MAX_FRAME_BYTES is rejected as oversize (§4.2).
#[test]
fn oversize_frame_rejected() {
    let mut bytes = vec![0x41, 0x4E, 0x01, FT_AUDIO_CHUNK];
    bytes.resize(MAX_FRAME_BYTES + 1, 0);
    assert_eq!(
        Frame::decode(&bytes),
        Err(DecodeError::Oversize(MAX_FRAME_BYTES + 1))
    );
}

/// The stream-header magic alone (or any prefix of the fixed part) is
/// truncated, not panicking — walked byte by byte.
#[test]
fn stream_header_fixed_prefix_truncations() {
    let mut bytes = STREAM_HEADER_MAGIC.to_vec();
    bytes.push(1); // version
    bytes.extend_from_slice(&[0u8; 64]);
    for cut in 0..bytes.len() {
        let _ = StreamHeaderV1::decode(&bytes[..cut]); // must not panic
    }
}
