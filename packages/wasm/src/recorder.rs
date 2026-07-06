//! Recorder-side engine: FLAC encoder + stream sender behind one class,
//! hosted in the phone's encoder worker (never the audio thread).

use antiphon_codec::{EncoderConfig, StreamEncoder};
use antiphon_core::chunk::{CODEC_FLAC, StreamHeaderV1};
use antiphon_core::frame::{Decoded, Frame, StreamKey};
use antiphon_core::sender::{StreamSender, TakeState};
use antiphon_core::timesync::TimeSync;
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;

use crate::json::{Obj, ranges_json, uuid_string};
use crate::parse_id;

#[wasm_bindgen]
pub struct RecorderEngine {
    sender: StreamSender,
    encoder: StreamEncoder,
    sample_rate: u32,
    clock_epoch_us: u64,
    /// Per-sink NTP-style sync responders/initiators.
    timesync: BTreeMap<u32, TimeSync>,
}

#[wasm_bindgen]
impl RecorderEngine {
    /// Arms the stream immediately: seq 0 is produced before this returns.
    /// Capture never gates on any network state (§7.1).
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        take_id: &[u8],
        stream_id: &[u8],
        sample_rate: u32,
        bits_per_sample: u8,
        device_desc: String,
        clock_epoch_us: f64,
        wall_clock_hint_ms: f64,
        ring_budget_bytes: u32,
    ) -> Result<RecorderEngine, JsError> {
        let stream = StreamKey {
            take_id: parse_id(take_id, "take_id")?,
            stream_id: parse_id(stream_id, "stream_id")?,
        };
        let encoder = StreamEncoder::new(EncoderConfig {
            sample_rate,
            bits_per_sample,
        })
        .map_err(|e| JsError::new(&e.to_string()))?;
        let header = StreamHeaderV1 {
            codec: CODEC_FLAC,
            channels: 1,
            bits_per_sample,
            sample_rate,
            clock_epoch_us: clock_epoch_us as u64,
            wall_clock_hint_ms: wall_clock_hint_ms as u64,
            device_desc,
            codec_header: encoder.codec_header(),
        };
        let mut sender = StreamSender::new(stream, ring_budget_bytes as usize);
        sender.arm(&header);
        Ok(Self {
            sender,
            encoder,
            sample_rate,
            clock_epoch_us: clock_epoch_us as u64,
            timesync: BTreeMap::new(),
        })
    }

    pub fn add_sink(&mut self, sink_id: u32) {
        self.sender.add_sink(sink_id);
        self.timesync.entry(sink_id).or_default();
    }

    pub fn remove_sink(&mut self, sink_id: u32) {
        self.sender.remove_sink(sink_id);
        self.timesync.remove(&sink_id);
    }

    pub fn set_sink_connected(&mut self, sink_id: u32, connected: bool) {
        self.sender.set_connected(sink_id, connected);
    }

    /// Push captured PCM (Web Audio float frames). Encoded chunks flow into
    /// the per-sink outbound queues automatically.
    pub fn push_samples(&mut self, samples: &[f32]) -> Result<(), JsError> {
        let chunks = self
            .encoder
            .push_f32(samples)
            .map_err(|e| JsError::new(&e.to_string()))?;
        for c in chunks {
            let ts = self.capture_ts_for(c.first_sample_index);
            self.sender.push_audio(c.sample_count, ts, c.payload);
        }
        Ok(())
    }

    /// take-stop: flush the encoder, emit the final (possibly short) chunk,
    /// enter DRAINING.
    pub fn finish(&mut self) -> Result<(), JsError> {
        let chunks = self
            .encoder
            .finish()
            .map_err(|e| JsError::new(&e.to_string()))?;
        for c in chunks {
            let ts = self.capture_ts_for(c.first_sample_index);
            self.sender.push_audio(c.sample_count, ts, c.payload);
        }
        self.sender.finish();
        Ok(())
    }

    /// Next frame owed to `sink_id` (gap reports → live → backfill), or
    /// undefined when idle/disconnected.
    pub fn pop_frame(&mut self, sink_id: u32) -> Option<Vec<u8>> {
        self.sender.pop_frame(sink_id).map(|f| f.encode())
    }

    pub fn has_pending(&self, sink_id: u32) -> bool {
        !self.sender.is_idle(sink_id)
    }

    /// Feed a frame received from `sink_id`. Returns an immediate reply frame
    /// when one is owed (TIME_PING → TIME_PONG).
    pub fn handle_frame(
        &mut self,
        sink_id: u32,
        bytes: &[u8],
        now_us: f64,
    ) -> Result<Option<Vec<u8>>, JsError> {
        match Frame::decode(bytes) {
            Ok(Decoded::Frame(Frame::TimePing(ping))) => {
                let pong = TimeSync::pong_for(&ping, now_us as u64, now_us as u64);
                Ok(Some(Frame::TimePong(pong).encode()))
            }
            Ok(Decoded::Frame(Frame::TimePong(pong))) => {
                if let Some(sync) = self.timesync.get_mut(&sink_id) {
                    sync.handle_pong(&pong, now_us as u64);
                }
                Ok(None)
            }
            Ok(Decoded::Frame(frame)) => {
                self.sender.handle_frame(sink_id, &frame);
                Ok(None)
            }
            Ok(Decoded::UnknownType(_)) => Ok(None),
            // Bad magic / truncated: discard silently (§11). Version
            // mismatch: surface to the caller for a control-plane error.
            Err(antiphon_core::frame::DecodeError::VersionMismatch(v)) => {
                Err(JsError::new(&format!("data-plane version mismatch: {v}")))
            }
            Err(_) => Ok(None),
        }
    }

    /// Emit a TIME_PING toward a sink (call every TIME_SYNC_INTERVAL_MS).
    pub fn time_ping(&mut self, sink_id: u32, now_us: f64) -> Vec<u8> {
        let sync = self.timesync.entry(sink_id).or_default();
        Frame::TimePing(sync.ping(now_us as u64)).encode()
    }

    /// Recorder-observed drain conditions (§7.4).
    pub fn drained_any(&self) -> bool {
        self.sender.drained_any()
    }

    pub fn drained_all(&self) -> bool {
        self.sender.drained_all()
    }

    pub fn final_seq(&self) -> Option<u32> {
        self.sender.final_seq()
    }

    pub fn state(&self) -> String {
        match self.sender.state() {
            TakeState::Idle => "idle",
            TakeState::Armed => "armed",
            TakeState::Streaming => "streaming",
            TakeState::Draining => "draining",
            TakeState::Closed => "closed",
        }
        .to_string()
    }

    /// Diagnostics for the UI, as JSON.
    pub fn stats_json(&self) -> String {
        let sinks: Vec<String> = self
            .sender
            .sink_ids()
            .map(|id| {
                Obj::new()
                    .num("id", id)
                    .bool("connected", self.sender.is_connected(id))
                    .bool("settled", self.sender.sink_settled(id))
                    .bool("idle", self.sender.is_idle(id))
                    .opt_num(
                        "clockOffsetUs",
                        self.timesync
                            .get(&id)
                            .and_then(|s| s.offset_us())
                            .map(|v| v as f64),
                    )
                    .build()
            })
            .collect();
        Obj::new()
            .str("state", self.state())
            .num("nextSeq", self.sender.next_seq())
            .opt_num("finalSeq", self.sender.final_seq())
            .num("samplesIn", self.encoder.samples_in() as f64)
            .num("ringBytes", self.sender.ring().used_bytes() as f64)
            .num("ringChunks", self.sender.ring().len() as f64)
            .raw("gaps", ranges_json(self.sender.gaps().ranges()))
            .str("takeId", uuid_string(&self.sender.stream().take_id))
            .str("streamId", uuid_string(&self.sender.stream().stream_id))
            .num("sampleRate", self.sample_rate)
            .raw("sinks", format!("[{}]", sinks.join(",")))
            .build()
    }

    fn capture_ts_for(&self, first_sample_index: u64) -> u64 {
        // Capture clock and sample clock are the same thing on a recorder:
        // ts = epoch + samples/rate. Coarse hint only; truth is acoustic.
        self.clock_epoch_us + first_sample_index * 1_000_000 / u64::from(self.sample_rate)
    }
}
