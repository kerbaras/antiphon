//! Sink-side stream engine: idempotent ingest, CHWM/hole computation,
//! ACK/HAVE generation, sink↔sink diff planning, and crash rebuild.
//!
//! Storage is the caller's (Postgres+blobs on the server, OPFS on the desk);
//! this engine tracks *keys and metadata only* and tells the caller what to
//! do with payload bytes. Contract: the caller MUST persist a chunk before
//! the next `ack_status()` is sent — an ACK is a durability claim, and the
//! recorder's ring evicts acked chunks (RFC §9).

use std::collections::BTreeMap;

use crate::constants::CHWM_NONE;
use crate::crc32c::crc32c;
use crate::frame::{AckStatus, AudioChunk, RangeList, SeqRange, StreamKey};
use crate::ranges::RangeSet;

/// Metadata retained per held chunk (payloads live in the caller's store).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkMeta {
    pub crc32c: u32,
    pub first_sample_index: u64,
    pub sample_count: u32,
    pub payload_len: u32,
}

/// Outcome of ingesting one AUDIO_CHUNK (§6.2 idempotency law, §11 table).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ingest {
    /// New chunk: persist the payload, then let the next ACK claim it.
    Stored,
    /// Duplicate key, matching CRC: normal operation, no-op.
    Duplicate,
    /// Duplicate key, different CRC: fatal protocol violation. The original
    /// bytes are kept; the stream is quarantined (flagged) but keeps
    /// ingesting — fatal errors never delete data.
    FatalCrcConflict {
        existing_crc: u32,
        incoming_crc: u32,
    },
    /// Header CRC disagrees with the payload bytes: corrupt frame. Not
    /// stored — the hole machinery will re-request it.
    CorruptPayload {
        declared_crc: u32,
        computed_crc: u32,
    },
    /// `first_sample_index` inconsistent with a stored neighbor (§6.2).
    /// Stored anyway (never delete data) but the stream is flagged.
    ContinuityViolation { expected: u64, got: u64 },
}

/// Sticky fatal conditions observed on a stream (reported via control plane,
/// preserved in take metadata).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamFlag {
    CrcConflict {
        seq: u32,
        existing_crc: u32,
        incoming_crc: u32,
    },
    Discontinuity {
        seq: u32,
        expected: u64,
        got: u64,
    },
}

#[derive(Debug, Default)]
pub struct StreamReceiver {
    held: RangeSet,
    meta: BTreeMap<u32, ChunkMeta>,
    declared_gaps: RangeSet,
    final_seq: Option<u32>,
    flags: Vec<StreamFlag>,
}

impl StreamReceiver {
    pub fn new() -> Self {
        Self::default()
    }

    /// Crash recovery: reload one held chunk's metadata from durable storage.
    /// After reloading everything, the receiver behaves as if it had merely
    /// been disconnected (§8).
    pub fn rebuild_one(&mut self, seq: u32, meta: ChunkMeta) {
        self.held.insert(seq);
        self.meta.insert(seq, meta);
    }

    pub fn set_final_seq(&mut self, final_seq: u32) {
        // First writer wins; a conflicting later value is a protocol error we
        // surface but never let shrink completeness expectations.
        match self.final_seq {
            None => self.final_seq = Some(final_seq),
            Some(existing) if existing != final_seq => {
                self.final_seq = Some(existing.max(final_seq));
            }
            _ => {}
        }
    }

    pub fn final_seq(&self) -> Option<u32> {
        self.final_seq
    }

    pub fn held(&self) -> &RangeSet {
        &self.held
    }

    pub fn holds(&self, seq: u32) -> bool {
        self.held.contains(seq)
    }

    pub fn meta(&self, seq: u32) -> Option<&ChunkMeta> {
        self.meta.get(&seq)
    }

    pub fn declared_gaps(&self) -> &RangeSet {
        &self.declared_gaps
    }

    pub fn flags(&self) -> &[StreamFlag] {
        &self.flags
    }

    pub fn is_flagged(&self) -> bool {
        !self.flags.is_empty()
    }

    // ---- ingest -----------------------------------------------------------

    pub fn ingest(&mut self, chunk: &AudioChunk) -> Ingest {
        let computed = crc32c(&chunk.payload);
        if computed != chunk.crc32c {
            return Ingest::CorruptPayload {
                declared_crc: chunk.crc32c,
                computed_crc: computed,
            };
        }
        if let Some(existing) = self.meta.get(&chunk.seq) {
            if existing.crc32c == chunk.crc32c {
                return Ingest::Duplicate;
            }
            let flag = StreamFlag::CrcConflict {
                seq: chunk.seq,
                existing_crc: existing.crc32c,
                incoming_crc: chunk.crc32c,
            };
            if !self.flags.contains(&flag) {
                self.flags.push(flag);
            }
            return Ingest::FatalCrcConflict {
                existing_crc: existing.crc32c,
                incoming_crc: chunk.crc32c,
            };
        }

        let meta = ChunkMeta {
            crc32c: chunk.crc32c,
            first_sample_index: chunk.first_sample_index,
            sample_count: chunk.sample_count,
            payload_len: chunk.payload.len() as u32,
        };

        let continuity = self.check_continuity(chunk);
        self.held.insert(chunk.seq);
        self.meta.insert(chunk.seq, meta);

        match continuity {
            Some((expected, got)) => {
                let flag = StreamFlag::Discontinuity {
                    seq: chunk.seq,
                    expected,
                    got,
                };
                if !self.flags.contains(&flag) {
                    self.flags.push(flag);
                }
                Ingest::ContinuityViolation { expected, got }
            }
            None => Ingest::Stored,
        }
    }

    /// §6.2: `first_sample_index` MUST equal the previous chunk's
    /// `first_sample_index + sample_count`. Backfill interleaves seqs, so
    /// check against whichever stored neighbors exist. Seq 0 (header) and
    /// its successor's zero origin are special-cased.
    fn check_continuity(&self, chunk: &AudioChunk) -> Option<(u64, u64)> {
        if chunk.seq == 0 {
            return None;
        }
        if chunk.seq == 1 && chunk.first_sample_index != 0 {
            return Some((0, chunk.first_sample_index));
        }
        if chunk.seq >= 2
            && let Some(prev) = self.meta.get(&(chunk.seq - 1))
        {
            let expected = prev.first_sample_index + u64::from(prev.sample_count);
            if chunk.first_sample_index != expected {
                return Some((expected, chunk.first_sample_index));
            }
        }
        if let Some(next) = self.meta.get(&(chunk.seq + 1)) {
            let expected_next = chunk.first_sample_index + u64::from(chunk.sample_count);
            if next.first_sample_index != expected_next {
                return Some((expected_next, next.first_sample_index));
            }
        }
        None
    }

    /// GAP_REPORT (§6.6): record and stop requesting.
    pub fn record_gaps(&mut self, ranges: &[SeqRange]) {
        for r in ranges {
            self.declared_gaps.insert_range(*r);
        }
    }

    // ---- status -----------------------------------------------------------

    /// Contiguous high-water mark; `CHWM_NONE` when seq 0 is missing.
    ///
    /// Interpretation note (proposed RFC clarification): ranges the recorder
    /// declared permanently lost (GAP_REPORT) count as *satisfied* here.
    /// Otherwise a gap would pin the CHWM below it forever, the recorder
    /// could never observe `CHWM = final`, and the take could never leave
    /// DRAINING — even though waiting cannot fill a declared gap. True
    /// possession (for take metadata / flagging) is `held()`; every non-gap
    /// seq at or below the returned CHWM is genuinely held.
    pub fn chwm(&self) -> u32 {
        self.held
            .union(&self.declared_gaps)
            .contiguous_from_zero()
            .unwrap_or(CHWM_NONE)
    }

    /// Missing ranges above the CHWM worth requesting: bounded by the highest
    /// seq we know exists (max held, or final if known), minus declared gaps.
    pub fn holes(&self) -> Vec<SeqRange> {
        let horizon = match (self.held.max(), self.final_seq) {
            (Some(m), Some(f)) => m.max(f),
            (Some(m), None) => m,
            (None, Some(f)) => f,
            (None, None) => return vec![],
        };
        self.held
            .missing_within(SeqRange::new(0, horizon))
            .subtract(&self.declared_gaps)
            .ranges()
            .to_vec()
    }

    pub fn ack_status(&self, stream: StreamKey) -> AckStatus {
        AckStatus {
            stream,
            chwm: self.chwm(),
            holes: self.holes(),
        }
    }

    /// HAVE_SUMMARY payloads (§6.8), split to frame-sized batches.
    pub fn have_summaries(&self, stream: StreamKey) -> Vec<RangeList> {
        if self.held.is_empty() {
            return vec![RangeList {
                stream,
                ranges: vec![],
            }];
        }
        crate::frame::split_ranges_for_frames(self.held.ranges())
            .map(|batch| RangeList {
                stream,
                ranges: batch.to_vec(),
            })
            .collect()
    }

    /// Sink↔sink replication planning: seqs we hold that `their_have` lacks.
    /// Direction is data-driven — whoever has bytes the other lacks, sends.
    pub fn plan_push(&self, their_have: &RangeSet) -> RangeSet {
        self.held.subtract(their_have)
    }

    /// Explicit "I want these now" request (§6.5), split to frame batches.
    pub fn backfill_request(&self, stream: StreamKey) -> Vec<RangeList> {
        let holes = self.holes();
        if holes.is_empty() {
            return vec![];
        }
        crate::frame::split_ranges_for_frames(&holes)
            .map(|batch| RangeList {
                stream,
                ranges: batch.to_vec(),
            })
            .collect()
    }

    // ---- completeness -----------------------------------------------------

    /// §7.5: complete = holds seq 0..=final.
    pub fn is_complete(&self) -> bool {
        match self.final_seq {
            Some(f) => self.held.missing_within(SeqRange::new(0, f)).is_empty(),
            None => false,
        }
    }

    /// Complete except for ranges the recorder declared permanently lost.
    pub fn is_settled(&self) -> bool {
        match self.final_seq {
            Some(f) => self
                .held
                .union(&self.declared_gaps)
                .missing_within(SeqRange::new(0, f))
                .is_empty(),
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::audio_chunk;

    fn stream() -> StreamKey {
        StreamKey {
            take_id: [3; 16],
            stream_id: [4; 16],
        }
    }

    fn chunk(seq: u32, fsi: u64, count: u32) -> AudioChunk {
        audio_chunk(stream(), seq, fsi, count, 0, vec![seq as u8; 8])
    }

    #[test]
    fn chwm_and_holes() {
        let mut r = StreamReceiver::new();
        assert_eq!(r.chwm(), CHWM_NONE);
        assert_eq!(r.ingest(&chunk(1, 0, 100)), Ingest::Stored);
        assert_eq!(r.chwm(), CHWM_NONE, "missing seq 0");
        assert_eq!(r.holes(), vec![SeqRange::new(0, 0)]);

        let mut h = crate::chunk::header_chunk(
            stream(),
            &crate::chunk::StreamHeaderV1 {
                codec: 1,
                channels: 1,
                bits_per_sample: 24,
                sample_rate: 48_000,
                clock_epoch_us: 0,
                wall_clock_hint_ms: 0,
                device_desc: "d".into(),
                codec_header: vec![9],
            },
        );
        h.capture_ts_us = 0;
        assert_eq!(r.ingest(&h), Ingest::Stored);
        assert_eq!(r.chwm(), 1);

        assert_eq!(r.ingest(&chunk(4, 300, 100)), Ingest::Stored);
        assert_eq!(r.holes(), vec![SeqRange::new(2, 3)]);
        r.set_final_seq(6);
        assert_eq!(r.holes(), vec![SeqRange::new(2, 3), SeqRange::new(5, 6)]);
    }

    #[test]
    fn duplicates_are_noops_and_conflicts_fatal() {
        let mut r = StreamReceiver::new();
        let c = chunk(1, 0, 100);
        assert_eq!(r.ingest(&c), Ingest::Stored);
        assert_eq!(r.ingest(&c), Ingest::Duplicate);
        assert!(!r.is_flagged());

        let mut evil = audio_chunk(stream(), 1, 0, 100, 0, vec![0xEE; 8]);
        evil.first_sample_index = 0;
        let outcome = r.ingest(&evil);
        assert!(matches!(outcome, Ingest::FatalCrcConflict { .. }));
        assert!(r.is_flagged());
        // Original meta retained.
        assert_eq!(r.meta(1).unwrap().crc32c, c.crc32c);
    }

    #[test]
    fn corrupt_payload_not_stored() {
        let mut r = StreamReceiver::new();
        let mut c = chunk(1, 0, 100);
        c.crc32c ^= 0xFFFF;
        assert!(matches!(r.ingest(&c), Ingest::CorruptPayload { .. }));
        assert!(!r.holds(1));
    }

    #[test]
    fn continuity_violations_flag_but_store() {
        let mut r = StreamReceiver::new();
        assert_eq!(r.ingest(&chunk(1, 0, 100)), Ingest::Stored);
        assert_eq!(r.ingest(&chunk(2, 100, 100)), Ingest::Stored);
        let bad = chunk(3, 250, 100); // expected fsi 200
        assert!(matches!(
            r.ingest(&bad),
            Ingest::ContinuityViolation {
                expected: 200,
                got: 250
            }
        ));
        assert!(r.holds(3), "bytes are kept even when flagged");
        assert!(r.is_flagged());
    }

    #[test]
    fn out_of_order_backfill_checks_next_neighbor() {
        let mut r = StreamReceiver::new();
        assert_eq!(r.ingest(&chunk(3, 200, 100)), Ingest::Stored);
        // Backfilled chunk 2 must line up with already-held chunk 3.
        assert_eq!(r.ingest(&chunk(2, 100, 100)), Ingest::Stored);
        assert!(!r.is_flagged());
        // A mismatched earlier neighbor is caught via the next-check:
        // chunk 2 implies chunk 3 should start at 190, but it starts at 200.
        let mut r2 = StreamReceiver::new();
        assert_eq!(r2.ingest(&chunk(3, 200, 100)), Ingest::Stored);
        assert!(matches!(
            r2.ingest(&chunk(2, 100, 90)),
            Ingest::ContinuityViolation {
                expected: 190,
                got: 200
            }
        ));
    }

    #[test]
    fn gaps_and_settlement() {
        let mut r = StreamReceiver::new();
        assert_eq!(r.ingest(&chunk(1, 0, 100)), Ingest::Stored);
        r.set_final_seq(3);
        assert!(!r.is_complete());
        r.record_gaps(&[SeqRange::new(2, 3)]);
        assert_eq!(r.holes(), vec![SeqRange::new(0, 0)]);
        assert!(!r.is_settled(), "seq 0 still missing and not gapped");
        // Header arrives.
        let h = crate::chunk::header_chunk(
            stream(),
            &crate::chunk::StreamHeaderV1 {
                codec: 1,
                channels: 1,
                bits_per_sample: 24,
                sample_rate: 48_000,
                clock_epoch_us: 0,
                wall_clock_hint_ms: 0,
                device_desc: "d".into(),
                codec_header: vec![9],
            },
        );
        assert_eq!(r.ingest(&h), Ingest::Stored);
        assert!(r.is_settled());
        assert!(!r.is_complete(), "complete still means every chunk");
    }

    #[test]
    fn rebuild_equals_disconnect() {
        let mut r = StreamReceiver::new();
        for s in [1u32, 2, 4] {
            let c = chunk(s, u64::from(s - 1) * 100, 100);
            r.ingest(&c);
        }
        let metas: Vec<(u32, ChunkMeta)> = [1u32, 2, 4]
            .iter()
            .map(|&s| (s, *r.meta(s).unwrap()))
            .collect();
        let mut rebuilt = StreamReceiver::new();
        for (s, m) in metas {
            rebuilt.rebuild_one(s, m);
        }
        assert_eq!(rebuilt.chwm(), r.chwm());
        assert_eq!(rebuilt.holes(), r.holes());
        assert_eq!(rebuilt.held(), r.held());
    }

    #[test]
    fn plan_push_is_symmetric_difference_side() {
        let mut a = StreamReceiver::new();
        let mut b = StreamReceiver::new();
        for s in 1..=4u32 {
            a.ingest(&chunk(s, u64::from(s - 1) * 100, 100));
        }
        for s in 3..=6u32 {
            b.ingest(&chunk(s, u64::from(s - 1) * 100, 100));
        }
        let push_a_to_b = a.plan_push(b.held());
        let push_b_to_a = b.plan_push(a.held());
        assert_eq!(push_a_to_b.iter_values().collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(push_b_to_a.iter_values().collect::<Vec<_>>(), vec![5, 6]);
    }
}
