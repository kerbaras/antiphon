//! Recorder-side stream engine: take state machine (RFC §7), per-sink
//! transmit tracking, and ACK/BACKFILL/GAP servicing from the ring buffer.
//!
//! Sans-IO: the engine never touches a network. Callers push encoded audio
//! in, deliver inbound frames, and pop outbound frames per sink. Everything
//! else — retransmission, gap declaration, drain detection — is internal.
//!
//! Convergence design (what the proptest suite leans on):
//!
//! - `produced` is the set of every seq ever created. Per sink, an ACK_STATUS
//!   snapshot proves possession of `0..=chwm` plus the regions strictly
//!   between reported holes. Everything else in `produced` is *outstanding*
//!   for that sink and gets (re)queued on every ACK — so any lost frame is
//!   retried within one ACK interval, and a sink that crash-recovered to an
//!   older state (lower chwm) is automatically re-fed. Duplicates are free by
//!   the idempotency law.
//! - Fresh audio outranks backlog: per sink, queued frames drain GAP_REPORTs
//!   first (tiny, unblocks the sink), then live chunks, then backfill (§7.3).
//!   On disconnect the sink's live queue is demoted to backfill so that
//!   post-reconnect fresh chunks keep priority.
//! - Proven-held state is a *latest-snapshot*, not a monotonic union: a
//!   crashed sink that lost state shrinks its proven set and gets everything
//!   re-sent. (Sinks must persist a chunk before acknowledging it — see
//!   `receiver` docs — which is what makes ring eviction of acked chunks
//!   safe.)

use std::collections::{BTreeMap, VecDeque};

use crate::chunk::{StreamHeaderV1, audio_chunk, header_chunk};
use crate::constants::CHWM_NONE;
use crate::frame::{AckStatus, AudioChunk, Frame, RangeList, SeqRange, StreamKey};
use crate::ranges::RangeSet;
use crate::ring::ChunkRing;

/// Caller-assigned sink identity (stable across reconnects of the same sink).
pub type SinkId = u32;

/// Take lifecycle (RFC §7). `Streaming` covers the disconnected sub-state:
/// connectivity is per sink, capture never gates on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TakeState {
    Idle,
    Armed,
    Streaming,
    Draining,
    Closed,
}

#[derive(Debug)]
struct SinkTx {
    connected: bool,
    /// Latest ACK snapshot: what this sink provably holds.
    proven_held: RangeSet,
    /// Latest chwm as reported (CHWM_NONE if never acked).
    chwm: u32,
    /// Seqs currently sitting in either queue (dedup guard).
    queued: RangeSet,
    live: VecDeque<u32>,
    backfill: VecDeque<u32>,
    /// Non-chunk frames owed to this sink (gap reports).
    control: VecDeque<Frame>,
    /// Gap ranges already reported to this sink (re-report only on demand).
    gaps_reported: RangeSet,
}

impl SinkTx {
    fn new() -> Self {
        Self {
            connected: false,
            proven_held: RangeSet::new(),
            chwm: CHWM_NONE,
            queued: RangeSet::new(),
            live: VecDeque::new(),
            backfill: VecDeque::new(),
            control: VecDeque::new(),
            gaps_reported: RangeSet::new(),
        }
    }
}

#[derive(Debug)]
pub struct StreamSender {
    stream: StreamKey,
    state: TakeState,
    ring: ChunkRing,
    /// Every seq ever produced (0..next_seq), tracked as a set for clarity.
    produced: RangeSet,
    next_seq: u32,
    next_first_sample_index: u64,
    final_seq: Option<u32>,
    sinks: BTreeMap<SinkId, SinkTx>,
}

impl StreamSender {
    pub fn new(stream: StreamKey, ring_budget_bytes: usize) -> Self {
        Self {
            stream,
            state: TakeState::Idle,
            ring: ChunkRing::new(ring_budget_bytes),
            produced: RangeSet::new(),
            next_seq: 0,
            next_first_sample_index: 0,
            final_seq: None,
            sinks: BTreeMap::new(),
        }
    }

    pub fn stream(&self) -> StreamKey {
        self.stream
    }

    pub fn state(&self) -> TakeState {
        self.state
    }

    pub fn final_seq(&self) -> Option<u32> {
        self.final_seq
    }

    pub fn next_seq(&self) -> u32 {
        self.next_seq
    }

    pub fn ring(&self) -> &ChunkRing {
        &self.ring
    }

    /// Declared-gap ranges (unacked chunks lost to ring eviction).
    pub fn gaps(&self) -> &RangeSet {
        self.ring.gaps()
    }

    // ---- take lifecycle -------------------------------------------------

    /// `take-start` received: produce the seq-0 stream header. Capture starts
    /// NOW regardless of any sink's connectivity (§7.1).
    pub fn arm(&mut self, header: &StreamHeaderV1) {
        assert_eq!(self.state, TakeState::Idle, "arm() from {:?}", self.state);
        self.state = TakeState::Armed;
        let chunk = header_chunk(self.stream, header);
        self.produce(chunk);
        self.state = TakeState::Streaming;
    }

    /// Append one encoded audio chunk. Returns its seq.
    pub fn push_audio(&mut self, sample_count: u32, capture_ts_us: u64, payload: Vec<u8>) -> u32 {
        assert!(
            matches!(self.state, TakeState::Streaming),
            "push_audio() in {:?}",
            self.state
        );
        let seq = self.next_seq;
        let chunk = audio_chunk(
            self.stream,
            seq,
            self.next_first_sample_index,
            sample_count,
            capture_ts_us,
            payload,
        );
        self.next_first_sample_index += u64::from(sample_count);
        self.produce(chunk);
        seq
    }

    /// `take-stop` received and the final chunk has been pushed.
    pub fn finish(&mut self) {
        assert!(
            matches!(self.state, TakeState::Streaming),
            "finish() in {:?}",
            self.state
        );
        assert!(self.next_seq > 0, "finish() before arm()");
        self.final_seq = Some(self.next_seq - 1);
        self.state = TakeState::Draining;
        self.try_close();
    }

    fn produce(&mut self, chunk: AudioChunk) {
        let seq = chunk.seq;
        debug_assert_eq!(seq, self.next_seq);
        self.next_seq += 1;
        self.produced.insert(seq);
        self.ring.insert(chunk);
        for tx in self.sinks.values_mut() {
            if !tx.queued.contains(seq) {
                tx.queued.insert(seq);
                tx.live.push_back(seq);
            }
        }
        self.broadcast_new_gaps();
    }

    // ---- sink management -------------------------------------------------

    /// Register a sink. A brand-new sink starts with nothing proven; the
    /// ACK-driven requeue feeds it the backlog once it connects and acks.
    pub fn add_sink(&mut self, id: SinkId) {
        self.sinks.entry(id).or_insert_with(SinkTx::new);
    }

    pub fn remove_sink(&mut self, id: SinkId) {
        self.sinks.remove(&id);
    }

    pub fn sink_ids(&self) -> impl Iterator<Item = SinkId> + '_ {
        self.sinks.keys().copied()
    }

    pub fn set_connected(&mut self, id: SinkId, connected: bool) {
        let Some(tx) = self.sinks.get_mut(&id) else {
            return;
        };
        tx.connected = connected;
        if !connected {
            // Demote unsent live chunks to backlog so fresh post-reconnect
            // audio keeps transmit priority (§7.3).
            let mut demoted: Vec<u32> = tx.live.drain(..).collect();
            demoted.sort_unstable();
            for seq in demoted {
                tx.backfill.push_back(seq);
            }
        }
    }

    pub fn is_connected(&self, id: SinkId) -> bool {
        self.sinks.get(&id).is_some_and(|t| t.connected)
    }

    // ---- inbound frames ---------------------------------------------------

    /// Deliver a frame received from `sink`. Non-sender frames are ignored.
    pub fn handle_frame(&mut self, sink: SinkId, frame: &Frame) {
        match frame {
            Frame::AckStatus(ack) if ack.stream == self.stream => self.handle_ack(sink, ack),
            Frame::BackfillRequest(req) if req.stream == self.stream => {
                self.handle_backfill_request(sink, req)
            }
            _ => {}
        }
    }

    fn handle_ack(&mut self, sink: SinkId, ack: &AckStatus) {
        let Some(tx) = self.sinks.get_mut(&sink) else {
            return;
        };

        // Reconstruct proven possession from the snapshot: 0..=chwm plus the
        // regions strictly between holes. Above the last hole (or above chwm
        // when hole-free) nothing is proven — resending there is harmless.
        let mut proven = RangeSet::new();
        if ack.chwm != CHWM_NONE {
            proven.insert_range(SeqRange::new(0, ack.chwm));
        }
        if !ack.holes.is_empty() {
            let mut cursor = match ack.chwm {
                CHWM_NONE => 0,
                c => c.saturating_add(1),
            };
            for hole in &ack.holes {
                if hole.start > cursor {
                    proven.insert_range(SeqRange::new(cursor, hole.start - 1));
                }
                cursor = hole.end.saturating_add(1);
            }
        }
        tx.proven_held = proven;
        tx.chwm = ack.chwm;

        // Ring: anything proven held by ANY sink is safe to evict.
        self.ring.mark_acked(&tx.proven_held.clone());

        // Outstanding = produced − proven − declared gaps: requeue whatever
        // the ring still holds and isn't already queued.
        let tx = self.sinks.get_mut(&sink).expect("sink exists");
        let outstanding = self
            .produced
            .subtract(&tx.proven_held)
            .subtract(self.ring.gaps());
        for seq in outstanding.iter_values() {
            if self.ring.contains(seq) && !tx.queued.contains(seq) {
                tx.queued.insert(seq);
                tx.backfill.push_back(seq);
            }
        }

        // Holes that intersect declared gaps can never be filled: (re)send a
        // GAP_REPORT so the sink stops asking (§6.6).
        let holes: RangeSet = RangeSet::from_ranges(ack.holes.iter().copied());
        let gapped = holes.subtract(&holes.subtract(self.ring.gaps()));
        if !gapped.is_empty() {
            tx.gaps_reported = RangeSet::new(); // force re-report below
            Self::queue_gap_report(self.stream, tx, &gapped);
        }

        self.try_close();
    }

    fn handle_backfill_request(&mut self, sink: SinkId, req: &RangeList) {
        let Some(tx) = self.sinks.get_mut(&sink) else {
            return;
        };
        let wanted = RangeSet::from_ranges(req.ranges.iter().copied());
        let gapped = wanted.subtract(&wanted.subtract(self.ring.gaps()));
        if !gapped.is_empty() {
            Self::queue_gap_report(self.stream, tx, &gapped);
        }
        for seq in wanted.iter_values() {
            if self.ring.contains(seq) && !tx.queued.contains(seq) {
                tx.queued.insert(seq);
                tx.backfill.push_back(seq);
            }
        }
    }

    fn queue_gap_report(stream: StreamKey, tx: &mut SinkTx, gaps: &RangeSet) {
        let unreported = gaps.subtract(&tx.gaps_reported);
        if unreported.is_empty() {
            return;
        }
        for batch in crate::frame::split_ranges_for_frames(unreported.ranges()) {
            tx.control.push_back(Frame::GapReport(RangeList {
                stream,
                ranges: batch.to_vec(),
            }));
        }
        for r in unreported.ranges() {
            tx.gaps_reported.insert_range(*r);
        }
    }

    /// Ring eviction may declare gaps at any insert; tell every sink once.
    fn broadcast_new_gaps(&mut self) {
        let new_gaps = self.ring.take_pending_gaps();
        if new_gaps.is_empty() {
            return;
        }
        let stream = self.stream;
        for tx in self.sinks.values_mut() {
            Self::queue_gap_report(stream, tx, &new_gaps);
            // Gapped seqs can no longer be transmitted; drop them from queues
            // lazily at pop time (ring no longer contains them).
        }
    }

    // ---- outbound frames --------------------------------------------------

    /// Pop the next frame owed to `sink`, or None if it is disconnected or
    /// has nothing to send. Priority: control (gap reports) → live → backfill.
    pub fn pop_frame(&mut self, sink: SinkId) -> Option<Frame> {
        let tx = self.sinks.get_mut(&sink)?;
        if !tx.connected {
            return None;
        }
        if let Some(frame) = tx.control.pop_front() {
            return Some(frame);
        }
        loop {
            let (seq, _from_live) = match tx.live.pop_front() {
                Some(s) => (s, true),
                None => match tx.backfill.pop_front() {
                    Some(s) => (s, false),
                    None => return None,
                },
            };
            tx.queued.remove(seq);
            // Suppress sends the sink provably no longer needs.
            if tx.proven_held.contains(seq) {
                continue;
            }
            match self.ring.get(seq) {
                Some(chunk) => return Some(Frame::AudioChunk(chunk.clone())),
                // Evicted since queued: gap reports (unacked) are queued via
                // the control path; acked-evicted seqs are the sink-sync
                // layer's job. Either way there is nothing to send here.
                None => continue,
            }
        }
    }

    /// True when this sink has nothing pending (all queues empty).
    pub fn is_idle(&self, sink: SinkId) -> bool {
        self.sinks
            .get(&sink)
            .is_none_or(|t| t.control.is_empty() && t.live.is_empty() && t.backfill.is_empty())
    }

    // ---- drain / completion ------------------------------------------------

    /// The set every sink must account for: 0..=final.
    fn full_range(&self) -> Option<SeqRange> {
        self.final_seq.map(|f| SeqRange::new(0, f))
    }

    /// A sink is settled when it provably holds everything produced except
    /// declared gaps (which it has been told about).
    pub fn sink_settled(&self, sink: SinkId) -> bool {
        let Some(full) = self.full_range() else {
            return false;
        };
        let Some(tx) = self.sinks.get(&sink) else {
            return false;
        };
        tx.proven_held
            .union(self.ring.gaps())
            .missing_within(full)
            .is_empty()
    }

    /// DRAINING exit condition (§7.4): at least one sink settled.
    pub fn drained_any(&self) -> bool {
        self.final_seq.is_some() && self.sinks.keys().any(|&id| self.sink_settled(id))
    }

    /// The SHOULD condition: every configured sink settled.
    pub fn drained_all(&self) -> bool {
        self.final_seq.is_some()
            && !self.sinks.is_empty()
            && self.sinks.keys().all(|&id| self.sink_settled(id))
    }

    fn try_close(&mut self) {
        if self.state == TakeState::Draining && self.drained_all() {
            self.state = TakeState::Closed;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::{CODEC_FLAC, StreamHeaderV1};
    use crate::frame::AckStatus;

    fn header() -> StreamHeaderV1 {
        StreamHeaderV1 {
            codec: CODEC_FLAC,
            channels: 1,
            bits_per_sample: 24,
            sample_rate: 48_000,
            clock_epoch_us: 0,
            wall_clock_hint_ms: 0,
            device_desc: "test".into(),
            codec_header: vec![1, 2, 3],
        }
    }

    fn stream() -> StreamKey {
        StreamKey {
            take_id: [1; 16],
            stream_id: [2; 16],
        }
    }

    fn sender_with_sink() -> StreamSender {
        let mut s = StreamSender::new(stream(), 1 << 20);
        s.add_sink(1);
        s.set_connected(1, true);
        s.arm(&header());
        s
    }

    fn ack(chwm: u32, holes: &[(u32, u32)]) -> Frame {
        Frame::AckStatus(AckStatus {
            stream: stream(),
            chwm,
            holes: holes.iter().map(|&(a, b)| SeqRange::new(a, b)).collect(),
        })
    }

    fn pop_seq(s: &mut StreamSender, sink: SinkId) -> Option<u32> {
        match s.pop_frame(sink) {
            Some(Frame::AudioChunk(c)) => Some(c.seq),
            Some(other) => panic!("expected chunk, got {other:?}"),
            None => None,
        }
    }

    #[test]
    fn live_flows_in_order() {
        let mut s = sender_with_sink();
        s.push_audio(100, 0, vec![0; 10]);
        s.push_audio(100, 1, vec![1; 10]);
        assert_eq!(pop_seq(&mut s, 1), Some(0));
        assert_eq!(pop_seq(&mut s, 1), Some(1));
        assert_eq!(pop_seq(&mut s, 1), Some(2));
        assert!(s.pop_frame(1).is_none());
    }

    #[test]
    fn ack_holes_requeue() {
        let mut s = sender_with_sink();
        for i in 0..5 {
            s.push_audio(100, i, vec![i as u8; 10]);
        }
        while s.pop_frame(1).is_some() {}
        // Sink reports it is missing 2..=3.
        s.handle_frame(1, &ack(1, &[(2, 3)]));
        assert_eq!(pop_seq(&mut s, 1), Some(2));
        assert_eq!(pop_seq(&mut s, 1), Some(3));
        // 4..=5 were above the last hole: not proven, so they requeue too.
        assert_eq!(pop_seq(&mut s, 1), Some(4));
        assert_eq!(pop_seq(&mut s, 1), Some(5));
        assert!(s.pop_frame(1).is_none());
    }

    #[test]
    fn snapshot_semantics_resend_after_crash_regression() {
        let mut s = sender_with_sink();
        for i in 0..4 {
            s.push_audio(100, i, vec![0; 10]);
        }
        while s.pop_frame(1).is_some() {}
        s.handle_frame(1, &ack(4, &[]));
        assert!(s.pop_frame(1).is_none(), "fully acked: nothing to send");
        // Sink crashes and rebuilds an older state.
        s.handle_frame(1, &ack(1, &[]));
        let mut reseen = vec![];
        while let Some(seq) = pop_seq(&mut s, 1) {
            reseen.push(seq);
        }
        assert_eq!(reseen, vec![2, 3, 4]);
    }

    #[test]
    fn fresh_live_outranks_reconnect_backlog() {
        let mut s = sender_with_sink();
        for i in 0..3 {
            s.push_audio(100, i, vec![0; 10]);
        }
        s.set_connected(1, false); // live queue (0..=3) demoted to backfill
        s.push_audio(100, 3, vec![0; 10]); // produced offline → live queue
        s.set_connected(1, true);
        assert_eq!(pop_seq(&mut s, 1), Some(4), "freshest chunk first");
        let rest: Vec<u32> = std::iter::from_fn(|| pop_seq(&mut s, 1)).collect();
        assert_eq!(rest, vec![0, 1, 2, 3]);
    }

    #[test]
    fn drain_lifecycle() {
        let mut s = sender_with_sink();
        s.push_audio(100, 0, vec![0; 10]);
        s.finish();
        assert_eq!(s.state(), TakeState::Draining);
        assert_eq!(s.final_seq(), Some(1));
        assert!(!s.drained_any());
        s.handle_frame(1, &ack(1, &[]));
        assert!(s.drained_any());
        assert!(s.drained_all());
        assert_eq!(s.state(), TakeState::Closed);
    }

    #[test]
    fn budget_exhaustion_reports_gaps_and_settles_around_them() {
        // Ring fits ~2 audio chunks; produce 5 with zero acks.
        let mut s = StreamSender::new(stream(), 2 * (68 + 100));
        s.add_sink(1);
        s.set_connected(1, true);
        s.arm(&header());
        for i in 0..5 {
            s.push_audio(100, i, vec![0; 100]);
        }
        s.finish();
        assert!(
            !s.gaps().is_empty(),
            "eviction under pressure declares gaps"
        );
        // Sink acks nothing; eventually pops everything still available plus
        // gap reports.
        let mut got_gap_report = false;
        let mut got_seqs = vec![];
        while let Some(frame) = s.pop_frame(1) {
            match frame {
                Frame::GapReport(_) => got_gap_report = true,
                Frame::AudioChunk(c) => got_seqs.push(c.seq),
                other => panic!("unexpected {other:?}"),
            }
        }
        assert!(got_gap_report);
        assert!(got_seqs.contains(&0), "pinned header always survives");
        // The sink converges on exactly what remains obtainable: everything
        // produced minus the declared gaps. Emulate a gap-aware sink ACK
        // (see receiver::chwm): declared gaps count as satisfied, holes
        // exclude them — the sender must settle on it.
        let holdable = s.produced.subtract(s.gaps());
        let effective = holdable.union(s.gaps());
        let chwm = effective.contiguous_from_zero().expect("seq 0 is pinned");
        let holes: Vec<SeqRange> = effective
            .missing_within(SeqRange::new(0, s.final_seq().unwrap()))
            .ranges()
            .to_vec();
        s.handle_frame(
            1,
            &Frame::AckStatus(AckStatus {
                stream: stream(),
                chwm,
                holes,
            }),
        );
        assert!(s.drained_all());
    }
}
