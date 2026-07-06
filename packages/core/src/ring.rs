//! Sender-side ring buffer (RFC §9).
//!
//! Byte-budgeted store of recent encoded chunks kept for backfill. Eviction
//! is oldest-first and skips chunks not yet acknowledged by any sink while
//! the budget allows; only under budget exhaustion are unacknowledged chunks
//! evicted — which is a declared gap (GAP_REPORT, §6.6), the protocol
//! admitting defeat.
//!
//! Never-lose-audio interpretations (noted for the RFC amendment PR):
//! - Seq 0 (the stream header) is pinned: it is tiny and any late-joining or
//!   amnesiac sink needs it to decode anything at all.
//! - The most recent chunk is never evicted before it has had a chance to be
//!   transmitted, even over budget.

use std::collections::BTreeMap;

use crate::frame::AudioChunk;
use crate::ranges::RangeSet;

#[derive(Debug)]
pub struct ChunkRing {
    budget_bytes: usize,
    used_bytes: usize,
    chunks: BTreeMap<u32, AudioChunk>,
    /// Seqs acknowledged by at least one sink (safe to evict).
    acked_by_any: RangeSet,
    /// Evicted while unacknowledged — true, permanent gaps pending report.
    pending_gaps: RangeSet,
    /// Everything evicted while unacknowledged, ever (gap ground truth).
    evicted_unacked: RangeSet,
    /// Evicted after some sink acknowledged (recoverable via sink↔sink sync).
    evicted_acked: RangeSet,
}

fn chunk_cost(chunk: &AudioChunk) -> usize {
    crate::constants::AUDIO_CHUNK_HEADER_LEN + chunk.payload.len()
}

impl ChunkRing {
    pub fn new(budget_bytes: usize) -> Self {
        Self {
            budget_bytes,
            used_bytes: 0,
            chunks: BTreeMap::new(),
            acked_by_any: RangeSet::new(),
            pending_gaps: RangeSet::new(),
            evicted_unacked: RangeSet::new(),
            evicted_acked: RangeSet::new(),
        }
    }

    pub fn used_bytes(&self) -> usize {
        self.used_bytes
    }

    pub fn len(&self) -> usize {
        self.chunks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.chunks.is_empty()
    }

    pub fn contains(&self, seq: u32) -> bool {
        self.chunks.contains_key(&seq)
    }

    pub fn get(&self, seq: u32) -> Option<&AudioChunk> {
        self.chunks.get(&seq)
    }

    /// Was `seq` evicted before any sink acknowledged it? (= a declared gap)
    pub fn is_gap(&self, seq: u32) -> bool {
        self.evicted_unacked.contains(seq)
    }

    /// Was `seq` evicted after acknowledgement? (recoverable via sink sync)
    pub fn is_evicted_acked(&self, seq: u32) -> bool {
        self.evicted_acked.contains(seq)
    }

    pub fn insert(&mut self, chunk: AudioChunk) {
        let seq = chunk.seq;
        if self.chunks.contains_key(&seq) {
            // Idempotency law: one seq, one immutable payload. Re-insertion
            // is a sender bug; keep the original.
            debug_assert!(false, "chunk {seq} inserted twice");
            return;
        }
        self.used_bytes += chunk_cost(&chunk);
        self.chunks.insert(seq, chunk);
        self.evict_to_budget();
    }

    /// Record that at least one sink acknowledged these seqs.
    pub fn mark_acked(&mut self, ranges: &RangeSet) {
        for r in ranges.ranges() {
            self.acked_by_any.insert_range(*r);
        }
    }

    /// Gap ranges newly created since the last call (drain-once semantics).
    pub fn take_pending_gaps(&mut self) -> RangeSet {
        std::mem::take(&mut self.pending_gaps)
    }

    /// All gaps ever declared (for re-answering stale backfill requests).
    pub fn gaps(&self) -> &RangeSet {
        &self.evicted_unacked
    }

    fn evict_to_budget(&mut self) {
        if self.used_bytes <= self.budget_bytes {
            return;
        }
        let newest = self.chunks.keys().next_back().copied();
        // Pass 1: evict acked chunks, oldest first (skipping pinned seq 0).
        let acked_victims: Vec<u32> = self
            .chunks
            .keys()
            .copied()
            .filter(|&s| s != 0 && Some(s) != newest && self.acked_by_any.contains(s))
            .collect();
        for seq in acked_victims {
            if self.used_bytes <= self.budget_bytes {
                return;
            }
            let chunk = self.chunks.remove(&seq).expect("victim exists");
            self.used_bytes -= chunk_cost(&chunk);
            self.evicted_acked.insert(seq);
        }
        if self.used_bytes <= self.budget_bytes {
            return;
        }
        // Pass 2: budget exhausted — evict unacknowledged, oldest first,
        // declaring gaps (§9).
        let unacked_victims: Vec<u32> = self
            .chunks
            .keys()
            .copied()
            .filter(|&s| s != 0 && Some(s) != newest)
            .collect();
        for seq in unacked_victims {
            if self.used_bytes <= self.budget_bytes {
                return;
            }
            let chunk = self.chunks.remove(&seq).expect("victim exists");
            self.used_bytes -= chunk_cost(&chunk);
            self.pending_gaps.insert(seq);
            self.evicted_unacked.insert(seq);
        }
    }
}

/// Convenience: budget for `seconds` of retention at an estimated encoded
/// bitrate (defaults sized per RFC §9's practical note).
pub fn budget_for_seconds(seconds: u32, encoded_bytes_per_sec: u32) -> usize {
    seconds as usize * encoded_bytes_per_sec as usize
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::audio_chunk;
    use crate::frame::{SeqRange, StreamKey};

    fn stream() -> StreamKey {
        StreamKey {
            take_id: [7; 16],
            stream_id: [9; 16],
        }
    }

    fn mk(seq: u32, payload_len: usize) -> AudioChunk {
        audio_chunk(
            stream(),
            seq,
            u64::from(seq) * 100,
            100,
            0,
            vec![0xAB; payload_len],
        )
    }

    fn ranges(pairs: &[(u32, u32)]) -> RangeSet {
        RangeSet::from_ranges(pairs.iter().map(|&(a, b)| SeqRange::new(a, b)))
    }

    #[test]
    fn stores_and_serves() {
        let mut ring = ChunkRing::new(10_000);
        for seq in 1..=5 {
            ring.insert(mk(seq, 100));
        }
        assert_eq!(ring.len(), 5);
        assert_eq!(ring.get(3).unwrap().seq, 3);
    }

    #[test]
    fn evicts_acked_first_oldest_first() {
        // Each chunk costs 68 + 100 = 168 bytes. Budget fits ~3.
        let mut ring = ChunkRing::new(520);
        ring.insert(mk(1, 100));
        ring.insert(mk(2, 100));
        ring.insert(mk(3, 100));
        ring.mark_acked(&ranges(&[(1, 2)]));
        ring.insert(mk(4, 100));
        // Over budget: acked 1 evicted first; 2 next if still needed.
        assert!(!ring.contains(1));
        assert!(
            ring.contains(3),
            "unacked survives while acked victims exist"
        );
        assert!(ring.contains(4));
        assert!(
            ring.take_pending_gaps().is_empty(),
            "no gaps while acked victims exist"
        );
        assert!(ring.is_evicted_acked(1));
    }

    #[test]
    fn budget_exhaustion_gaps_unacked() {
        let mut ring = ChunkRing::new(400); // fits ~2 chunks of 168
        ring.insert(mk(1, 100));
        ring.insert(mk(2, 100));
        ring.insert(mk(3, 100)); // nothing acked: must evict unacked 1
        let gaps = ring.take_pending_gaps();
        assert!(gaps.contains(1));
        assert!(ring.is_gap(1));
        assert!(!ring.is_evicted_acked(1));
        assert!(ring.contains(2) && ring.contains(3));
        assert!(ring.take_pending_gaps().is_empty(), "drain-once");
    }

    #[test]
    fn seq0_pinned_and_newest_protected() {
        let mut ring = ChunkRing::new(300); // fits ~1 chunk
        let header = AudioChunk {
            stream: stream(),
            seq: 0,
            first_sample_index: 0,
            sample_count: 0,
            capture_ts_us: 0,
            crc32c: crate::crc32c::crc32c(&[0xAB; 40]),
            payload: vec![0xAB; 40],
        };
        ring.insert(header);
        ring.insert(mk(1, 100));
        ring.insert(mk(2, 100));
        assert!(ring.contains(0), "stream header pinned");
        assert!(ring.contains(2), "newest never evicted");
        assert!(!ring.contains(1));
    }
}
