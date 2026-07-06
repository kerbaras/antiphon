//! RFC §15 conformance: the protocol's real specification.
//!
//! A miniature distributed system — N recorder streams, M sinks, every
//! inter-actor byte routed through fault-injectable links — driven by a
//! proptest-generated adversarial schedule of chunk production, frame drops,
//! duplications, reorders, disconnects, reconnects, and sink crashes (state
//! lost, durable store survives). After faults cease, a bounded fault-free
//! reconciliation phase runs (ACK cycles, backfill service, sink↔sink HAVE
//! exchange).
//!
//! Property 1 (ample ring): every sink converges to an identical, complete,
//! byte-identical chunk set `0..=final` for every stream, and the recorder
//! observes every sink settled (DRAINING may end).
//!
//! Property 2 (starved ring): unacknowledged eviction declares gaps; every
//! sink still converges to an identical set — everything obtainable — and
//! settles around the declared gaps.

use std::collections::BTreeMap;

use antiphon_core::chunk::{CODEC_FLAC, StreamHeaderV1};
use antiphon_core::frame::{Decoded, Frame, SeqRange, StreamKey};
use antiphon_core::ranges::RangeSet;
use antiphon_core::receiver::{Ingest, StreamReceiver};
use antiphon_core::sender::{StreamSender, TakeState};
use proptest::prelude::*;

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Op {
    /// Recorder produces one encoded chunk (payload derived from indices).
    Produce { stream: u8 },
    /// Recorder pops up to `n` outbound frames toward a sink onto the link.
    Pump { stream: u8, sink: u8, n: u8 },
    /// Sink processes the frame at the front of the recorder→sink link.
    DeliverToSink { stream: u8, sink: u8 },
    /// Recorder processes the frame at the front of the sink→recorder link.
    DeliverToRecorder { stream: u8, sink: u8 },
    /// Adversary: drop the frame at the front of a link.
    Drop { link: LinkSel },
    /// Adversary: duplicate the frame at the front of a link (to the back).
    Duplicate { link: LinkSel },
    /// Adversary: swap the two frames at the front of a link.
    Reorder { link: LinkSel },
    /// Sink emits ACK_STATUS for one stream (only if connected).
    Ack { stream: u8, sink: u8 },
    /// Tear down a recorder↔sink connection; frames in flight are lost.
    Disconnect { stream: u8, sink: u8 },
    /// Re-establish; the sink acks + backfill-requests immediately (§6.4).
    Reconnect { stream: u8, sink: u8 },
    /// Sink loses all volatile state and rebuilds from its durable store.
    Crash { sink: u8 },
    /// One sink announces HAVE summaries to another (sync channel).
    SyncAnnounce { from: u8, to: u8 },
    /// Process one frame from the sink↔sink link.
    SyncDeliver { from: u8, to: u8 },
    /// Desk stops the take: every stream finishes (idempotent).
    TakeStop,
}

#[derive(Debug, Clone, Copy)]
enum LinkSel {
    ToSink { stream: u8, sink: u8 },
    ToRecorder { stream: u8, sink: u8 },
    Sync { from: u8, to: u8 },
}

/// Deterministic pseudo-random payload for (stream, seq): the oracle both
/// sides of every assertion agree on.
fn payload_for(stream: usize, seq: u32) -> Vec<u8> {
    let mut state = (stream as u64 + 1).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ u64::from(seq + 1);
    let len = 1 + (seq as usize * 37 + stream * 11) % 180;
    (0..len)
        .map(|_| {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 33) as u8
        })
        .collect()
}

const SAMPLES_PER_CHUNK: u32 = 100;

fn stream_key(i: usize) -> StreamKey {
    let take_id = [0xA7; 16];
    let mut stream_id = [0u8; 16];
    stream_id[0] = i as u8 + 1;
    StreamKey { take_id, stream_id }
}

fn stream_header() -> StreamHeaderV1 {
    StreamHeaderV1 {
        codec: CODEC_FLAC,
        channels: 1,
        bits_per_sample: 24,
        sample_rate: 48_000,
        clock_epoch_us: 1_000,
        wall_clock_hint_ms: 0,
        device_desc: "sim".into(),
        codec_header: vec![0xF1, 0xAC],
    }
}

/// One sink: volatile receivers + durable store (frame bytes, final, gaps).
struct SinkSim {
    recv: Vec<StreamReceiver>,
    store: Vec<BTreeMap<u32, Vec<u8>>>,
    durable_final: Vec<Option<u32>>,
    durable_gaps: Vec<RangeSet>,
}

impl SinkSim {
    fn new(n_streams: usize) -> Self {
        Self {
            recv: (0..n_streams).map(|_| StreamReceiver::new()).collect(),
            store: vec![BTreeMap::new(); n_streams],
            durable_final: vec![None; n_streams],
            durable_gaps: vec![RangeSet::new(); n_streams],
        }
    }

    /// Crash: volatile state lost; rebuild from durables (§8 crash recovery).
    fn crash_and_rebuild(&mut self) {
        let n = self.recv.len();
        self.recv = (0..n).map(|_| StreamReceiver::new()).collect();
        for i in 0..n {
            for (seq, bytes) in &self.store[i] {
                let Ok(Decoded::Frame(Frame::AudioChunk(chunk))) = Frame::decode(bytes) else {
                    panic!("durable store holds undecodable frame");
                };
                self.recv[i].rebuild_one(
                    *seq,
                    antiphon_core::receiver::ChunkMeta {
                        crc32c: chunk.crc32c,
                        first_sample_index: chunk.first_sample_index,
                        sample_count: chunk.sample_count,
                        payload_len: chunk.payload.len() as u32,
                    },
                );
            }
            if let Some(f) = self.durable_final[i] {
                self.recv[i].set_final_seq(f);
            }
            let gaps = self.durable_gaps[i].clone();
            self.recv[i].record_gaps(gaps.ranges());
        }
    }

    /// Handle one frame arriving from anywhere (recorder link or sink sync).
    /// Persist-before-ack is upheld by persisting synchronously here.
    fn ingest_bytes(&mut self, stream: usize, bytes: &[u8]) {
        match Frame::decode(bytes) {
            Ok(Decoded::Frame(Frame::AudioChunk(chunk))) => {
                match self.recv[stream].ingest(&chunk) {
                    Ingest::Stored => {
                        self.store[stream].insert(chunk.seq, bytes.to_vec());
                    }
                    Ingest::Duplicate => {}
                    other => panic!("honest sim produced {other:?}"),
                }
            }
            Ok(Decoded::Frame(Frame::GapReport(list))) => {
                self.recv[stream].record_gaps(&list.ranges);
                for r in &list.ranges {
                    self.durable_gaps[stream].insert_range(*r);
                }
            }
            Ok(_) => {}
            Err(e) => panic!("sim link corrupted a frame: {e}"),
        }
    }

    fn learn_final(&mut self, stream: usize, final_seq: u32) {
        self.recv[stream].set_final_seq(final_seq);
        self.durable_final[stream] = Some(final_seq);
    }
}

/// Frame bytes in flight on one directed link.
type FrameQueue = Vec<Vec<u8>>;
/// Sink↔sink frames tagged with their stream index.
type SyncQueue = Vec<(usize, Vec<u8>)>;

struct Sim {
    n_streams: usize,
    n_sinks: usize,
    senders: Vec<StreamSender>,
    sinks: Vec<SinkSim>,
    /// Frame queues: recorder→sink and sink→recorder, per (stream, sink).
    to_sink: Vec<Vec<FrameQueue>>,
    to_recorder: Vec<Vec<FrameQueue>>,
    /// Sink↔sink frames, per (from, to).
    sync: Vec<Vec<SyncQueue>>,
    connected: Vec<Vec<bool>>,
    take_stopped: bool,
}

impl Sim {
    fn new(n_streams: usize, n_sinks: usize, ring_budget: usize) -> Self {
        let mut senders: Vec<StreamSender> = (0..n_streams)
            .map(|i| StreamSender::new(stream_key(i), ring_budget))
            .collect();
        for sender in &mut senders {
            for s in 0..n_sinks {
                sender.add_sink(s as u32);
            }
            sender.arm(&stream_header());
        }
        let mut sim = Self {
            n_streams,
            n_sinks,
            senders,
            sinks: (0..n_sinks).map(|_| SinkSim::new(n_streams)).collect(),
            to_sink: vec![vec![vec![]; n_sinks]; n_streams],
            to_recorder: vec![vec![vec![]; n_sinks]; n_streams],
            sync: vec![vec![vec![]; n_sinks]; n_sinks],
            connected: vec![vec![false; n_sinks]; n_streams],
            take_stopped: false,
        };
        // Everything starts connected (ICE succeeded) — faults come later.
        for i in 0..n_streams {
            for s in 0..n_sinks {
                sim.set_connected(i, s, true);
            }
        }
        sim
    }

    fn set_connected(&mut self, stream: usize, sink: usize, up: bool) {
        self.connected[stream][sink] = up;
        self.senders[stream].set_connected(sink as u32, up);
        if !up {
            // Connection death loses whatever was in flight.
            self.to_sink[stream][sink].clear();
            self.to_recorder[stream][sink].clear();
        } else {
            // §6.4: ACK immediately on reconnect (+ explicit backfill ask).
            self.sink_ack(stream, sink);
            self.sink_backfill_request(stream, sink);
            if self.take_stopped {
                let final_seq = self.senders[stream].final_seq().expect("stopped");
                self.sinks[sink].learn_final(stream, final_seq);
            }
        }
    }

    fn sink_ack(&mut self, stream: usize, sink: usize) {
        if !self.connected[stream][sink] {
            return;
        }
        let ack = self.sinks[sink].recv[stream].ack_status(stream_key(stream));
        self.to_recorder[stream][sink].push(Frame::AckStatus(ack).encode());
    }

    fn sink_backfill_request(&mut self, stream: usize, sink: usize) {
        if !self.connected[stream][sink] {
            return;
        }
        for list in self.sinks[sink].recv[stream].backfill_request(stream_key(stream)) {
            self.to_recorder[stream][sink].push(Frame::BackfillRequest(list).encode());
        }
    }

    fn produce(&mut self, stream: usize) {
        if self.senders[stream].state() != TakeState::Streaming {
            return;
        }
        let seq = self.senders[stream].next_seq();
        let payload = payload_for(stream, seq);
        self.senders[stream].push_audio(SAMPLES_PER_CHUNK, u64::from(seq) * 2_083, payload);
    }

    fn pump(&mut self, stream: usize, sink: usize, n: usize) {
        if !self.connected[stream][sink] {
            return;
        }
        for _ in 0..n {
            match self.senders[stream].pop_frame(sink as u32) {
                Some(frame) => self.to_sink[stream][sink].push(frame.encode()),
                None => break,
            }
        }
    }

    fn deliver_to_sink(&mut self, stream: usize, sink: usize) {
        if self.to_sink[stream][sink].is_empty() {
            return;
        }
        let bytes = self.to_sink[stream][sink].remove(0);
        self.sinks[sink].ingest_bytes(stream, &bytes);
    }

    fn deliver_to_recorder(&mut self, stream: usize, sink: usize) {
        if self.to_recorder[stream][sink].is_empty() {
            return;
        }
        let bytes = self.to_recorder[stream][sink].remove(0);
        match Frame::decode(&bytes) {
            Ok(Decoded::Frame(frame)) => self.senders[stream].handle_frame(sink as u32, &frame),
            _ => panic!("sim link corrupted a frame"),
        }
    }

    fn sync_announce(&mut self, from: usize, to: usize) {
        if from == to {
            return;
        }
        for stream in 0..self.n_streams {
            for list in self.sinks[from].recv[stream].have_summaries(stream_key(stream)) {
                self.sync[from][to].push((stream, Frame::HaveSummary(list).encode()));
            }
        }
    }

    fn sync_deliver(&mut self, from: usize, to: usize) {
        if from == to || self.sync[from][to].is_empty() {
            return;
        }
        let (stream, bytes) = self.sync[from][to].remove(0);
        match Frame::decode(&bytes) {
            Ok(Decoded::Frame(Frame::HaveSummary(list))) => {
                // `to` pushes whatever it holds that `from` lacks (§6.8).
                let theirs = RangeSet::from_ranges(list.ranges.iter().copied());
                let push = self.sinks[to].recv[stream].plan_push(&theirs);
                for seq in push.iter_values() {
                    if let Some(frame_bytes) = self.sinks[to].store[stream].get(&seq) {
                        self.sync[to][from].push((stream, frame_bytes.clone()));
                    }
                }
                // Also mirror durable knowledge that isn't chunk bytes.
                if let Some(f) = self.sinks[to].durable_final[stream] {
                    let _ = f; // finals propagate via control plane, not sync
                }
            }
            Ok(Decoded::Frame(Frame::AudioChunk(_))) => {
                self.sinks[to].ingest_bytes(stream, &bytes);
            }
            _ => panic!("unexpected sync frame"),
        }
    }

    fn crash(&mut self, sink: usize) {
        self.sinks[sink].crash_and_rebuild();
        for stream in 0..self.n_streams {
            if self.connected[stream][sink] {
                self.set_connected(stream, sink, false);
            }
        }
        for other in 0..self.n_sinks {
            self.sync[sink][other].clear();
            self.sync[other][sink].clear();
        }
    }

    fn take_stop(&mut self) {
        if self.take_stopped {
            return;
        }
        self.take_stopped = true;
        for stream in 0..self.n_streams {
            if self.senders[stream].state() == TakeState::Streaming {
                // The final (possibly short) chunk, then DRAINING (§7.4).
                self.produce(stream);
                self.senders[stream].finish();
            }
        }
        for stream in 0..self.n_streams {
            let final_seq = self.senders[stream].final_seq().expect("just stopped");
            for sink in 0..self.n_sinks {
                if self.connected[stream][sink] {
                    self.sinks[sink].learn_final(stream, final_seq);
                }
            }
        }
    }

    fn link_mut(&mut self, sel: LinkSel) -> LinkQueue<'_> {
        match sel {
            LinkSel::ToSink { stream, sink } => {
                let (i, s) = (
                    stream as usize % self.n_streams,
                    sink as usize % self.n_sinks,
                );
                LinkQueue::Plain(&mut self.to_sink[i][s])
            }
            LinkSel::ToRecorder { stream, sink } => {
                let (i, s) = (
                    stream as usize % self.n_streams,
                    sink as usize % self.n_sinks,
                );
                LinkQueue::Plain(&mut self.to_recorder[i][s])
            }
            LinkSel::Sync { from, to } => {
                let (f, t) = (from as usize % self.n_sinks, to as usize % self.n_sinks);
                LinkQueue::Tagged(&mut self.sync[f][t])
            }
        }
    }

    fn apply(&mut self, op: &Op) {
        let ns = self.n_streams;
        let nk = self.n_sinks;
        match *op {
            Op::Produce { stream } => self.produce(stream as usize % ns),
            Op::Pump { stream, sink, n } => {
                self.pump(stream as usize % ns, sink as usize % nk, 1 + n as usize % 8)
            }
            Op::DeliverToSink { stream, sink } => {
                self.deliver_to_sink(stream as usize % ns, sink as usize % nk)
            }
            Op::DeliverToRecorder { stream, sink } => {
                self.deliver_to_recorder(stream as usize % ns, sink as usize % nk)
            }
            Op::Drop { link } => self.link_mut(link).drop_front(),
            Op::Duplicate { link } => self.link_mut(link).duplicate_front(),
            Op::Reorder { link } => self.link_mut(link).swap_front(),
            Op::Ack { stream, sink } => self.sink_ack(stream as usize % ns, sink as usize % nk),
            Op::Disconnect { stream, sink } => {
                self.set_connected(stream as usize % ns, sink as usize % nk, false)
            }
            Op::Reconnect { stream, sink } => {
                self.set_connected(stream as usize % ns, sink as usize % nk, true)
            }
            Op::Crash { sink } => self.crash(sink as usize % nk),
            Op::SyncAnnounce { from, to } => {
                self.sync_announce(from as usize % nk, to as usize % nk)
            }
            Op::SyncDeliver { from, to } => self.sync_deliver(from as usize % nk, to as usize % nk),
            Op::TakeStop => self.take_stop(),
        }
    }

    /// Fault-free reconciliation until fixpoint (bounded). Models "faults
    /// cease" from §15: connections restored, ACK cycles run, sinks sync.
    fn quiesce(&mut self) {
        self.take_stop();
        for stream in 0..self.n_streams {
            for sink in 0..self.n_sinks {
                if !self.connected[stream][sink] {
                    self.set_connected(stream, sink, true);
                }
                let final_seq = self.senders[stream].final_seq().expect("stopped");
                self.sinks[sink].learn_final(stream, final_seq);
            }
        }

        for _round in 0..40 {
            // Drain every recorder-facing queue.
            for stream in 0..self.n_streams {
                for sink in 0..self.n_sinks {
                    while !self.to_recorder[stream][sink].is_empty() {
                        self.deliver_to_recorder(stream, sink);
                    }
                    self.pump(stream, sink, usize::MAX >> 1);
                    while !self.to_sink[stream][sink].is_empty() {
                        self.deliver_to_sink(stream, sink);
                    }
                }
            }
            // Full sink↔sink exchange.
            for a in 0..self.n_sinks {
                for b in 0..self.n_sinks {
                    if a != b {
                        self.sync_announce(a, b);
                    }
                }
            }
            let mut moved = true;
            while moved {
                moved = false;
                for a in 0..self.n_sinks {
                    for b in 0..self.n_sinks {
                        if a != b && !self.sync[a][b].is_empty() {
                            self.sync_deliver(a, b);
                            moved = true;
                        }
                    }
                }
            }
            // Fresh ACK cycle so the recorder observes post-sync state.
            for stream in 0..self.n_streams {
                for sink in 0..self.n_sinks {
                    self.sink_ack(stream, sink);
                    while !self.to_recorder[stream][sink].is_empty() {
                        self.deliver_to_recorder(stream, sink);
                    }
                }
            }
            if self.is_fixpoint() {
                return;
            }
        }
        panic!("no fixpoint after bounded quiesce rounds");
    }

    fn is_fixpoint(&self) -> bool {
        let queues_empty = (0..self.n_streams).all(|i| {
            (0..self.n_sinks)
                .all(|s| self.to_sink[i][s].is_empty() && self.to_recorder[i][s].is_empty())
        }) && (0..self.n_sinks)
            .all(|a| (0..self.n_sinks).all(|b| self.sync[a][b].is_empty()));
        let senders_idle = (0..self.n_streams)
            .all(|i| (0..self.n_sinks).all(|s| self.senders[i].is_idle(s as u32)));
        queues_empty && senders_idle
    }
}

enum LinkQueue<'a> {
    Plain(&'a mut FrameQueue),
    Tagged(&'a mut SyncQueue),
}

impl LinkQueue<'_> {
    fn drop_front(&mut self) {
        match self {
            LinkQueue::Plain(q) if !q.is_empty() => {
                q.remove(0);
            }
            LinkQueue::Tagged(q) if !q.is_empty() => {
                q.remove(0);
            }
            _ => {}
        }
    }

    fn duplicate_front(&mut self) {
        match self {
            LinkQueue::Plain(q) => {
                if let Some(front) = q.first().cloned() {
                    q.push(front);
                }
            }
            LinkQueue::Tagged(q) => {
                if let Some(front) = q.first().cloned() {
                    q.push(front);
                }
            }
        }
    }

    fn swap_front(&mut self) {
        match self {
            LinkQueue::Plain(q) if q.len() >= 2 => q.swap(0, 1),
            LinkQueue::Tagged(q) if q.len() >= 2 => q.swap(0, 1),
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

fn assert_converged(sim: &Sim, allow_gaps: bool) {
    for stream in 0..sim.n_streams {
        let sender = &sim.senders[stream];
        let final_seq = sender.final_seq().expect("take stopped");
        let gaps = sender.gaps().clone();
        if !allow_gaps {
            assert!(
                gaps.is_empty(),
                "ample ring must never gap (stream {stream})"
            );
        }

        // Everything obtainable: produced minus gaps, plus any gap seq some
        // sink managed to persist before the ring evicted it.
        let full = RangeSet::from_ranges([SeqRange::new(0, final_seq)]);
        let mut expected = full.subtract(&gaps);
        for sink in &sim.sinks {
            for &seq in sink.store[stream].keys() {
                if gaps.contains(seq) {
                    expected.insert(seq);
                }
            }
        }

        for (s, sink) in sim.sinks.iter().enumerate() {
            let held: RangeSet = sink.store[stream].keys().copied().collect();
            assert_eq!(
                held.ranges(),
                expected.ranges(),
                "sink {s} stream {stream}: store diverges from expected set"
            );
            // Byte-identical payloads, verified against the oracle.
            for (&seq, bytes) in &sink.store[stream] {
                let Ok(Decoded::Frame(Frame::AudioChunk(chunk))) = Frame::decode(bytes) else {
                    panic!("stored frame undecodable");
                };
                if seq == 0 {
                    assert_eq!(
                        chunk.payload,
                        stream_header().encode(),
                        "seq 0 header bytes"
                    );
                } else {
                    assert_eq!(
                        chunk.payload,
                        payload_for(stream, seq),
                        "sink {s} stream {stream} seq {seq}: payload diverges from oracle"
                    );
                }
            }
            let recv = &sink.recv[stream];
            assert!(recv.flags().is_empty(), "honest run must not flag streams");
            if allow_gaps {
                assert!(recv.is_settled(), "sink {s} stream {stream} not settled");
            } else {
                assert!(recv.is_complete(), "sink {s} stream {stream} not complete");
            }
            assert!(
                sender.sink_settled(s as u32),
                "recorder does not observe sink {s} settled (stream {stream})"
            );
        }
        assert!(
            sender.drained_all(),
            "stream {stream} cannot leave DRAINING"
        );
        assert_eq!(sender.state(), TakeState::Closed);
    }
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

fn arb_link() -> impl Strategy<Value = LinkSel> {
    prop_oneof![
        (any::<u8>(), any::<u8>()).prop_map(|(stream, sink)| LinkSel::ToSink { stream, sink }),
        (any::<u8>(), any::<u8>()).prop_map(|(stream, sink)| LinkSel::ToRecorder { stream, sink }),
        (any::<u8>(), any::<u8>()).prop_map(|(from, to)| LinkSel::Sync { from, to }),
    ]
}

fn arb_op() -> impl Strategy<Value = Op> {
    prop_oneof![
        8 => any::<u8>().prop_map(|stream| Op::Produce { stream }),
        8 => (any::<u8>(), any::<u8>(), any::<u8>())
            .prop_map(|(stream, sink, n)| Op::Pump { stream, sink, n }),
        10 => (any::<u8>(), any::<u8>())
            .prop_map(|(stream, sink)| Op::DeliverToSink { stream, sink }),
        6 => (any::<u8>(), any::<u8>())
            .prop_map(|(stream, sink)| Op::DeliverToRecorder { stream, sink }),
        3 => arb_link().prop_map(|link| Op::Drop { link }),
        3 => arb_link().prop_map(|link| Op::Duplicate { link }),
        3 => arb_link().prop_map(|link| Op::Reorder { link }),
        4 => (any::<u8>(), any::<u8>()).prop_map(|(stream, sink)| Op::Ack { stream, sink }),
        2 => (any::<u8>(), any::<u8>())
            .prop_map(|(stream, sink)| Op::Disconnect { stream, sink }),
        3 => (any::<u8>(), any::<u8>())
            .prop_map(|(stream, sink)| Op::Reconnect { stream, sink }),
        1 => any::<u8>().prop_map(|sink| Op::Crash { sink }),
        2 => (any::<u8>(), any::<u8>()).prop_map(|(from, to)| Op::SyncAnnounce { from, to }),
        3 => (any::<u8>(), any::<u8>()).prop_map(|(from, to)| Op::SyncDeliver { from, to }),
        1 => Just(Op::TakeStop),
    ]
}

fn run(n_streams: usize, n_sinks: usize, ring_budget: usize, ops: &[Op], allow_gaps: bool) {
    let mut sim = Sim::new(n_streams, n_sinks, ring_budget);
    for op in ops {
        sim.apply(op);
    }
    sim.quiesce();
    assert_converged(&sim, allow_gaps);
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// RFC §15, the headline property: any interleaving of loss, reordering,
    /// duplication, disconnection, and sink crash → identical complete sets.
    #[test]
    fn all_sinks_converge(
        n_streams in 1usize..=3,
        n_sinks in 2usize..=3,
        ops in prop::collection::vec(arb_op(), 0..300),
    ) {
        run(n_streams, n_sinks, 64 << 20, &ops, false);
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    /// Ring starvation: unacked eviction declares gaps; sinks still converge
    /// to an identical set and settle around the declared gaps.
    #[test]
    fn starved_ring_converges_with_gaps(
        n_streams in 1usize..=2,
        n_sinks in 2usize..=3,
        ops in prop::collection::vec(arb_op(), 0..300),
    ) {
        // Budget fits roughly three max-size sim chunks.
        run(n_streams, n_sinks, 800, &ops, true);
    }
}

/// Deterministic sanity: a clean run with no faults at all.
#[test]
fn clean_run_converges() {
    let mut ops = vec![];
    for i in 0..20u8 {
        ops.push(Op::Produce { stream: i });
        ops.push(Op::Pump {
            stream: i,
            sink: 0,
            n: 8,
        });
        ops.push(Op::Pump {
            stream: i,
            sink: 1,
            n: 8,
        });
        ops.push(Op::DeliverToSink { stream: i, sink: 0 });
        ops.push(Op::DeliverToSink { stream: i, sink: 1 });
    }
    ops.push(Op::TakeStop);
    run(2, 2, 64 << 20, &ops, false);
}

/// Deterministic reproduction of the milestone-1 demo shape: one sink dies
/// mid-take, misses chunks, reconnects, backfills, converges.
#[test]
fn dropout_backfill_converges() {
    let mut ops = vec![];
    for _ in 0..5 {
        ops.push(Op::Produce { stream: 0 });
        ops.push(Op::Pump {
            stream: 0,
            sink: 0,
            n: 8,
        });
        ops.push(Op::Pump {
            stream: 0,
            sink: 1,
            n: 8,
        });
        ops.push(Op::DeliverToSink { stream: 0, sink: 0 });
        ops.push(Op::DeliverToSink { stream: 0, sink: 1 });
    }
    ops.push(Op::Disconnect { stream: 0, sink: 1 });
    for _ in 0..10 {
        ops.push(Op::Produce { stream: 0 });
        ops.push(Op::Pump {
            stream: 0,
            sink: 0,
            n: 8,
        });
        ops.push(Op::DeliverToSink { stream: 0, sink: 0 });
    }
    ops.push(Op::Reconnect { stream: 0, sink: 1 });
    ops.push(Op::TakeStop);
    run(1, 2, 64 << 20, &ops, false);
}
