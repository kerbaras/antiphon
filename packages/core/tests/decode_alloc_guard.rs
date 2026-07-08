//! Tests the DoS claim, not just the error code: hostile length fields
//! (`payload_len`, `hole_count`) must be rejected *before any allocation*,
//! measured with a counting global allocator. Lives in its own integration
//! test binary with a single #[test] so no concurrent test pollutes the
//! peak-allocation measurement.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use antiphon_core::chunk::StreamHeaderV1;
use antiphon_core::constants::AUDIO_CHUNK_HEADER_LEN;
use antiphon_core::frame::{FT_ACK_STATUS, FT_AUDIO_CHUNK, FT_BACKFILL_REQUEST, Frame};

struct CountingAlloc;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let live = LIVE.fetch_add(layout.size(), Ordering::SeqCst) + layout.size();
        PEAK.fetch_max(live, Ordering::SeqCst);
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Ordering::SeqCst);
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOC: CountingAlloc = CountingAlloc;

/// Bytes newly allocated (peak over baseline) while running `f`.
fn peak_alloc_during(f: impl FnOnce()) -> usize {
    let baseline = LIVE.load(Ordering::SeqCst);
    PEAK.store(baseline, Ordering::SeqCst);
    f();
    PEAK.load(Ordering::SeqCst).saturating_sub(baseline)
}

/// Any hostile claim below asks the decoder for hundreds of KB to 4 GiB.
/// An honest rejection needs no buffer at all; the slack covers incidental
/// error-path plumbing.
const SLACK: usize = 4_096;

#[test]
fn hostile_length_claims_never_allocate() {
    // AUDIO_CHUNK header claiming a 4 GiB payload with zero payload bytes.
    let mut chunk_frame = vec![0x41, 0x4E, 0x01, FT_AUDIO_CHUNK];
    chunk_frame.extend_from_slice(&[0u8; AUDIO_CHUNK_HEADER_LEN - 8]);
    chunk_frame.extend_from_slice(&u32::MAX.to_le_bytes()); // payload_len
    assert_eq!(chunk_frame.len(), AUDIO_CHUNK_HEADER_LEN);

    // ACK_STATUS claiming 65_535 holes (524 KB) with zero range bytes.
    let mut ack_frame = vec![0x41, 0x4E, 0x01, FT_ACK_STATUS];
    ack_frame.extend_from_slice(&[0u8; 36]); // keys + chwm
    ack_frame.extend_from_slice(&u16::MAX.to_le_bytes());

    // BACKFILL_REQUEST with the same count lie.
    let mut backfill_frame = vec![0x41, 0x4E, 0x01, FT_BACKFILL_REQUEST];
    backfill_frame.extend_from_slice(&[0u8; 32]);
    backfill_frame.extend_from_slice(&u16::MAX.to_le_bytes());

    // StreamHeaderV1 claiming a 65_535-byte device description on a
    // 30-byte buffer.
    let mut header_payload = b"ANS0".to_vec();
    header_payload.push(1);
    header_payload.extend_from_slice(&[0u8; 23]);
    header_payload.extend_from_slice(&u16::MAX.to_le_bytes()); // desc_len

    for (name, bytes) in [
        ("audio-chunk payload_len", &chunk_frame),
        ("ack hole_count", &ack_frame),
        ("backfill count", &backfill_frame),
    ] {
        let peak = peak_alloc_during(|| {
            assert!(Frame::decode(bytes).is_err(), "{name} must be rejected");
        });
        assert!(
            peak <= SLACK,
            "{name}: rejected but allocated {peak} bytes first"
        );
    }

    let peak = peak_alloc_during(|| {
        assert!(StreamHeaderV1::decode(&header_payload).is_err());
    });
    assert!(
        peak <= SLACK,
        "stream-header desc_len: rejected but allocated {peak} bytes first"
    );

    // Control: decoding an honest frame allocates roughly its payload.
    let honest = Frame::TimePing(antiphon_core::frame::TimePing { ping_id: 1, t1: 2 }).encode();
    let peak = peak_alloc_during(|| {
        assert!(Frame::decode(&honest).is_ok());
    });
    assert!(peak <= SLACK, "control decode allocated {peak} bytes");
}
