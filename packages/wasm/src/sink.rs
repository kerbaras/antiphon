//! Sink-side engine: multi-stream idempotent ingest + reconciliation frame
//! generation. Used identically by the server (Node) and the desk (browser
//! worker); storage stays with the caller — an ACK is a durability claim, so
//! persist before generating the next ACK.

use antiphon_core::constants::CHWM_NONE;
use antiphon_core::frame::{Decoded, Frame, RangeList, SeqRange, StreamKey};
use antiphon_core::ranges::RangeSet;
use antiphon_core::receiver::{ChunkMeta, Ingest, StreamReceiver};
use antiphon_core::timesync::TimeSync;
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;

use crate::json::{Obj, ranges_json, uuid_string};
use crate::parse_id;

/// Outcome of feeding one inbound frame to the sink engine.
#[wasm_bindgen]
pub struct IngestResult {
    kind: &'static str,
    json: String,
    reply: Option<Vec<u8>>,
}

#[wasm_bindgen]
impl IngestResult {
    /// One of: stored | duplicate | corrupt | fatal-crc | continuity |
    /// gap-report | time-ping | ack | backfill | have | ignored | discard.
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> String {
        self.kind.to_string()
    }

    /// Event details as JSON (shape depends on `kind`).
    #[wasm_bindgen(getter)]
    pub fn json(&self) -> String {
        self.json.clone()
    }

    /// Frame bytes owed back to the peer (TIME_PING → TIME_PONG).
    #[wasm_bindgen(getter)]
    pub fn reply(&self) -> Option<Vec<u8>> {
        self.reply.clone()
    }
}

fn key_obj(stream: &StreamKey) -> Obj {
    Obj::new()
        .str("takeId", uuid_string(&stream.take_id))
        .str("streamId", uuid_string(&stream.stream_id))
}

#[wasm_bindgen]
pub struct SinkEngine {
    streams: BTreeMap<StreamKey, StreamReceiver>,
}

impl Default for SinkEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl SinkEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> SinkEngine {
        SinkEngine {
            streams: BTreeMap::new(),
        }
    }

    /// Feed one inbound data-plane frame. For AUDIO_CHUNK the caller MUST
    /// persist the frame bytes when `kind == "stored"` or `"continuity"`
    /// before the next ACK cycle.
    pub fn ingest(&mut self, bytes: &[u8], now_us: f64) -> IngestResult {
        match Frame::decode(bytes) {
            Ok(Decoded::Frame(Frame::AudioChunk(chunk))) => {
                let recv = self.streams.entry(chunk.stream).or_default();
                let (kind, extra) = match recv.ingest(&chunk) {
                    Ingest::Stored => ("stored", None),
                    Ingest::Duplicate => ("duplicate", None),
                    Ingest::CorruptPayload {
                        declared_crc,
                        computed_crc,
                    } => (
                        "corrupt",
                        Some(format!(
                            "\"declaredCrc\":{declared_crc},\"computedCrc\":{computed_crc}"
                        )),
                    ),
                    Ingest::FatalCrcConflict {
                        existing_crc,
                        incoming_crc,
                    } => (
                        "fatal-crc",
                        Some(format!(
                            "\"existingCrc\":{existing_crc},\"incomingCrc\":{incoming_crc}"
                        )),
                    ),
                    Ingest::ContinuityViolation { expected, got } => (
                        "continuity",
                        Some(format!("\"expected\":{expected},\"got\":{got}")),
                    ),
                };
                let mut obj = key_obj(&chunk.stream)
                    .num("seq", chunk.seq)
                    .num("firstSampleIndex", chunk.first_sample_index as f64)
                    .num("sampleCount", chunk.sample_count)
                    .num("captureTsUs", chunk.capture_ts_us as f64)
                    .num("crc32c", chunk.crc32c)
                    .num("payloadLen", chunk.payload.len() as f64)
                    .num("chwm", f64::from(recv.chwm()));
                if let Some(extra) = extra {
                    obj = obj.raw("detail", format!("{{{extra}}}"));
                }
                IngestResult {
                    kind,
                    json: obj.build(),
                    reply: None,
                }
            }
            Ok(Decoded::Frame(Frame::GapReport(list))) => {
                let recv = self.streams.entry(list.stream).or_default();
                recv.record_gaps(&list.ranges);
                IngestResult {
                    kind: "gap-report",
                    json: key_obj(&list.stream)
                        .raw("ranges", ranges_json(&list.ranges))
                        .build(),
                    reply: None,
                }
            }
            Ok(Decoded::Frame(Frame::TimePing(ping))) => {
                let pong = TimeSync::pong_for(&ping, now_us as u64, now_us as u64);
                IngestResult {
                    kind: "time-ping",
                    json: "{}".into(),
                    reply: Some(Frame::TimePong(pong).encode()),
                }
            }
            Ok(Decoded::Frame(Frame::HaveSummary(list))) => IngestResult {
                kind: "have",
                json: key_obj(&list.stream)
                    .raw("ranges", ranges_json(&list.ranges))
                    .build(),
                reply: None,
            },
            Ok(Decoded::Frame(Frame::BackfillRequest(list))) => IngestResult {
                kind: "backfill",
                json: key_obj(&list.stream)
                    .raw("ranges", ranges_json(&list.ranges))
                    .build(),
                reply: None,
            },
            Ok(Decoded::Frame(Frame::AckStatus(ack))) => IngestResult {
                kind: "ack",
                json: key_obj(&ack.stream)
                    .num("chwm", ack.chwm)
                    .raw("holes", ranges_json(&ack.holes))
                    .build(),
                reply: None,
            },
            Ok(Decoded::Frame(Frame::TimePong(_))) => {
                // Routed by the caller to its TimeSyncSession.
                IngestResult {
                    kind: "time-pong",
                    json: "{}".into(),
                    reply: None,
                }
            }
            Ok(Decoded::UnknownType(t)) => IngestResult {
                kind: "ignored",
                json: format!("{{\"frameType\":{t}}}"),
                reply: None,
            },
            Err(e) => IngestResult {
                kind: "discard",
                json: Obj::new()
                    .str("reason", format!("{e:?}").replace('"', "'"))
                    .build(),
                reply: None,
            },
        }
    }

    /// Crash recovery: reload one chunk's metadata from durable storage.
    #[allow(clippy::too_many_arguments)]
    pub fn rebuild_chunk(
        &mut self,
        take_id: &[u8],
        stream_id: &[u8],
        seq: u32,
        crc32c: u32,
        first_sample_index: f64,
        sample_count: u32,
        payload_len: u32,
    ) -> Result<(), JsError> {
        let stream = StreamKey {
            take_id: parse_id(take_id, "take_id")?,
            stream_id: parse_id(stream_id, "stream_id")?,
        };
        self.streams.entry(stream).or_default().rebuild_one(
            seq,
            ChunkMeta {
                crc32c,
                first_sample_index: first_sample_index as u64,
                sample_count,
                payload_len,
            },
        );
        Ok(())
    }

    /// Record a declared gap from durable storage (crash recovery).
    pub fn rebuild_gap(
        &mut self,
        take_id: &[u8],
        stream_id: &[u8],
        start_seq: u32,
        end_seq: u32,
    ) -> Result<(), JsError> {
        let stream = StreamKey {
            take_id: parse_id(take_id, "take_id")?,
            stream_id: parse_id(stream_id, "stream_id")?,
        };
        self.streams
            .entry(stream)
            .or_default()
            .record_gaps(&[SeqRange::new(start_seq, end_seq)]);
        Ok(())
    }

    /// Control-plane `stream-final`: the sink now knows the last seq.
    pub fn set_final_seq(
        &mut self,
        take_id: &[u8],
        stream_id: &[u8],
        final_seq: u32,
    ) -> Result<(), JsError> {
        let stream = StreamKey {
            take_id: parse_id(take_id, "take_id")?,
            stream_id: parse_id(stream_id, "stream_id")?,
        };
        self.streams
            .entry(stream)
            .or_default()
            .set_final_seq(final_seq);
        Ok(())
    }

    /// ACK_STATUS frames for every tracked stream (send every
    /// ACK_INTERVAL_MS, immediately on reconnect, and on take close).
    pub fn ack_frames(&self) -> js_sys::Array {
        let out = js_sys::Array::new();
        for (stream, recv) in &self.streams {
            let bytes = Frame::AckStatus(recv.ack_status(*stream)).encode();
            out.push(&js_sys::Uint8Array::from(bytes.as_slice()));
        }
        out
    }

    /// HAVE_SUMMARY frames for every tracked stream (sink↔sink sync).
    pub fn have_frames(&self) -> js_sys::Array {
        let out = js_sys::Array::new();
        for (stream, recv) in &self.streams {
            for list in recv.have_summaries(*stream) {
                out.push(&js_sys::Uint8Array::from(
                    Frame::HaveSummary(list).encode().as_slice(),
                ));
            }
        }
        out
    }

    /// Explicit BACKFILL_REQUEST frames for current holes (reconnect boost).
    pub fn backfill_frames(&self) -> js_sys::Array {
        let out = js_sys::Array::new();
        for (stream, recv) in &self.streams {
            for list in recv.backfill_request(*stream) {
                out.push(&js_sys::Uint8Array::from(
                    Frame::BackfillRequest(list).encode().as_slice(),
                ));
            }
        }
        out
    }

    /// Given a peer's HAVE_SUMMARY frame, return the seq ranges *we* hold
    /// that they lack, as JSON `{takeId, streamId, ranges: [[s,e],..]}`.
    /// The caller streams those chunks' stored frame bytes to the peer.
    pub fn plan_push(&self, have_frame: &[u8]) -> Result<String, JsError> {
        let Ok(Decoded::Frame(Frame::HaveSummary(list))) = Frame::decode(have_frame) else {
            return Err(JsError::new("not a HAVE_SUMMARY frame"));
        };
        let theirs = RangeSet::from_ranges(list.ranges.iter().copied());
        let push = match self.streams.get(&list.stream) {
            Some(recv) => recv.plan_push(&theirs),
            None => RangeSet::new(),
        };
        Ok(key_obj(&list.stream)
            .raw("ranges", ranges_json(push.ranges()))
            .build())
    }

    /// Status of every tracked stream, as a JSON array.
    pub fn status_json(&self) -> String {
        let items: Vec<String> = self
            .streams
            .iter()
            .map(|(stream, recv)| {
                let chwm = recv.chwm();
                key_obj(stream)
                    .opt_num("chwm", (chwm != CHWM_NONE).then_some(chwm))
                    .num("heldCount", recv.held().count() as f64)
                    .raw("holes", ranges_json(&recv.holes()))
                    .raw("gaps", ranges_json(recv.declared_gaps().ranges()))
                    .opt_num("finalSeq", recv.final_seq())
                    .bool("complete", recv.is_complete())
                    .bool("settled", recv.is_settled())
                    .bool("flagged", recv.is_flagged())
                    .build()
            })
            .collect();
        format!("[{}]", items.join(","))
    }

    pub fn stream_count(&self) -> u32 {
        self.streams.len() as u32
    }
}

/// One NTP-style sync conversation with one peer (sink→recorder direction).
#[wasm_bindgen]
pub struct TimeSyncSession {
    sync: TimeSync,
}

impl Default for TimeSyncSession {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl TimeSyncSession {
    #[wasm_bindgen(constructor)]
    pub fn new() -> TimeSyncSession {
        TimeSyncSession {
            sync: TimeSync::new(),
        }
    }

    pub fn ping(&mut self, now_us: f64) -> Vec<u8> {
        Frame::TimePing(self.sync.ping(now_us as u64)).encode()
    }

    /// Feed a TIME_PONG frame; returns true when it produced a sample.
    pub fn handle_pong(&mut self, bytes: &[u8], now_us: f64) -> bool {
        match Frame::decode(bytes) {
            Ok(Decoded::Frame(Frame::TimePong(pong))) => {
                self.sync.handle_pong(&pong, now_us as u64).is_some()
            }
            _ => false,
        }
    }

    /// Peer clock minus local clock, µs (min-RTT filtered), or undefined.
    pub fn offset_us(&self) -> Option<f64> {
        self.sync.offset_us().map(|v| v as f64)
    }

    pub fn best_rtt_us(&self) -> Option<f64> {
        self.sync.best_rtt_us().map(|v| v as f64)
    }

    pub fn sample_count(&self) -> u32 {
        self.sync.sample_count() as u32
    }
}

/// Extract the payload bytes of an AUDIO_CHUNK frame (storage layers slice
/// payloads for .flac reconstruction without re-implementing wire layout).
#[wasm_bindgen]
pub fn extract_chunk_payload(frame: &[u8]) -> Result<Vec<u8>, JsError> {
    match Frame::decode(frame) {
        Ok(Decoded::Frame(Frame::AudioChunk(chunk))) => Ok(chunk.payload),
        _ => Err(JsError::new("not an AUDIO_CHUNK frame")),
    }
}

/// AUDIO_CHUNK header metadata as JSON (for storage layers).
#[wasm_bindgen]
pub fn chunk_meta_json(frame: &[u8]) -> Result<String, JsError> {
    match Frame::decode(frame) {
        Ok(Decoded::Frame(Frame::AudioChunk(chunk))) => Ok(key_obj(&chunk.stream)
            .num("seq", chunk.seq)
            .num("firstSampleIndex", chunk.first_sample_index as f64)
            .num("sampleCount", chunk.sample_count)
            .num("captureTsUs", chunk.capture_ts_us as f64)
            .num("crc32c", chunk.crc32c)
            .num("payloadLen", chunk.payload.len() as f64)
            .build()),
        _ => Err(JsError::new("not an AUDIO_CHUNK frame")),
    }
}

/// Extract the codec bootstrap (`fLaC` + STREAMINFO) from a seq-0 payload.
#[wasm_bindgen]
pub fn extract_codec_header(seq0_payload: &[u8]) -> Result<Vec<u8>, JsError> {
    antiphon_core::chunk::StreamHeaderV1::decode(seq0_payload)
        .map(|h| h.codec_header)
        .map_err(|e| JsError::new(&e.to_string()))
}

/// Stream header (seq-0 payload) metadata as JSON.
#[wasm_bindgen]
pub fn stream_header_json(seq0_payload: &[u8]) -> Result<String, JsError> {
    let h = antiphon_core::chunk::StreamHeaderV1::decode(seq0_payload)
        .map_err(|e| JsError::new(&e.to_string()))?;
    // device_desc is free text: strip characters that would need escaping.
    let safe_desc: String =
        h.device_desc.chars().filter(|c| !matches!(c, '"' | '\\' | '\u{0}'..='\u{1f}')).collect();
    Ok(Obj::new()
        .num("codec", h.codec)
        .num("channels", h.channels)
        .num("bitsPerSample", h.bits_per_sample)
        .num("sampleRate", h.sample_rate)
        .num("clockEpochUs", h.clock_epoch_us as f64)
        .num("wallClockHintMs", h.wall_clock_hint_ms as f64)
        .str("deviceDesc", safe_desc)
        .build())
}

/// Free helper for building RangeList-shaped frames from TS when the desk
/// pushes chunks after HAVE reconciliation is done at the storage layer.
#[wasm_bindgen]
pub fn encode_have_summary(
    take_id: &[u8],
    stream_id: &[u8],
    ranges_flat: &[u32],
) -> Result<Vec<u8>, JsError> {
    if !ranges_flat.len().is_multiple_of(2) {
        return Err(JsError::new("ranges_flat must be [start,end,start,end,..]"));
    }
    let stream = StreamKey {
        take_id: parse_id(take_id, "take_id")?,
        stream_id: parse_id(stream_id, "stream_id")?,
    };
    let ranges: Vec<SeqRange> = ranges_flat
        .chunks(2)
        .map(|p| {
            if p[1] < p[0] {
                Err(JsError::new("inverted range"))
            } else {
                Ok(SeqRange::new(p[0], p[1]))
            }
        })
        .collect::<Result<_, _>>()?;
    Ok(Frame::HaveSummary(RangeList { stream, ranges }).encode())
}
