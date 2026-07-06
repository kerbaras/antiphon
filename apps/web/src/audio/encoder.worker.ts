// Encoder worker: hosts the WASM RecorderEngine (never the audio thread).
// Drains PCM from the SAB ring on a timer, encodes to chunks, and serves
// per-sink frame queues to the main thread on demand. Capture NEVER gates on
// network state — the pump runs regardless of transport (§7.1).

import {
  chunk_meta_json,
  encode_meter_frame,
  extract_chunk_payload,
  extract_codec_header,
  init,
  RecorderEngine,
  SinkEngine,
} from "@antiphon/core-wasm";
import { CaptureRingReader } from "./sab-ring";
import {
  type FromEncoderWorker,
  LOCAL_SINK_ID,
  type RecorderStats,
  type ToEncoderWorker,
} from "./worker-protocol";

const PUMP_INTERVAL_MS = 100;
const STATS_INTERVAL_MS = 250;

let ring: CaptureRingReader | null = null;
let sampleRate = 48_000;
let engine: RecorderEngine | null = null;
let retainLocal = false;
/** A real SinkEngine backs the local pseudo-sink so rehearsal takes run the
 * genuine ACK/drain protocol instead of faking a state transition. */
let localSink: SinkEngine | null = null;
/** seq → payload bytes, for local .flac export. */
const localPayloads = new Map<number, Uint8Array>();
let localCodecHeader: Uint8Array | null = null;
let peak = 0;
/** Take/stream identity retained for METER telemetry frames. */
let meterIds: { takeId: Uint8Array; streamId: Uint8Array } | null = null;
/** Sinks registered before the engine exists (arm applies them). */
const preArmSinks = new Map<number, boolean>();

function post(msg: FromEncoderWorker, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, transfer);
}

function nowUs(): number {
  return performance.now() * 1_000;
}

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function pump() {
  if (!ring || !engine) return;
  // Cap one pump at 2s of audio to bound slab size after long stalls.
  const slab = ring.read(sampleRate * 2);
  if (slab.length > 0) {
    let localPeak = 0;
    for (let i = 0; i < slab.length; i++) {
      const v = Math.abs(slab[i] as number);
      if (v > localPeak) localPeak = v;
    }
    peak = Math.max(peak * 0.6, localPeak);
    try {
      engine.push_samples(slab);
    } catch (e) {
      post({ type: "error", message: `encode failed: ${String(e)}` });
      return;
    }
  }
  drainLocal();
  announcePending();
}

function drainLocal() {
  if (!engine || !retainLocal || !localSink) return;
  let got = false;
  for (;;) {
    const frame = engine.pop_frame(LOCAL_SINK_ID);
    if (!frame) break;
    got = true;
    localSink.ingest(frame, nowUs());
    try {
      const payload = extract_chunk_payload(frame);
      const meta = JSON.parse(chunk_meta_json(frame)) as { seq: number };
      if (meta.seq === 0) {
        localCodecHeader = extract_codec_header(payload);
      } else {
        localPayloads.set(meta.seq, payload);
      }
    } catch {
      // Non-chunk frames (gap reports) still went into the sink engine.
    }
  }
  if (got) ackLocal();
}

function ackLocal() {
  if (!engine || !localSink) return;
  for (const ack of localSink.ack_frames()) {
    engine.handle_frame(LOCAL_SINK_ID, ack as Uint8Array, nowUs());
  }
}

function announcePending() {
  if (!engine) return;
  const stats = JSON.parse(engine.stats_json()) as RecorderStats;
  const pending = stats.sinks
    .filter((s) => s.id !== LOCAL_SINK_ID && s.connected && !s.idle)
    .map((s) => s.id);
  if (pending.length > 0) post({ type: "pending", sinkIds: pending });
}

function sendStats() {
  const stats = engine ? (JSON.parse(engine.stats_json()) as RecorderStats) : null;
  if (stats) stats.sinks = stats.sinks.filter((s) => s.id !== LOCAL_SINK_ID);
  post({
    type: "stats",
    stats,
    ring: ring ? ring.diagnostics() : null,
    peak,
    localChunks: localPayloads.size,
  });
  // Live level telemetry toward the desk's meters, only while capturing.
  if (stats?.state === "streaming" && meterIds) {
    const frame = encode_meter_frame(meterIds.takeId, meterIds.streamId, peak);
    const buf = frame.buffer as ArrayBuffer;
    post({ type: "meter", frame: buf }, [buf]);
  }
}

async function handle(msg: ToEncoderWorker) {
  switch (msg.type) {
    case "configure": {
      await init();
      ring = new CaptureRingReader(msg.sab);
      sampleRate = msg.sampleRate;
      setInterval(pump, PUMP_INTERVAL_MS);
      setInterval(sendStats, STATS_INTERVAL_MS);
      post({ type: "ready" });
      break;
    }
    case "arm": {
      if (!ring) throw new Error("arm before configure");
      if (engine) {
        // One engine per take. A closed take can be replaced; a draining
        // one still owes backfill from its ring — never discard it.
        if (engine.state() !== "closed") {
          throw new Error(`take in progress (${engine.state()})`);
        }
        engine.free();
        engine = null;
      }
      ring.snapToWrite();
      const epochUs = nowUs();
      retainLocal = msg.retainLocal;
      localSink = retainLocal ? new SinkEngine() : null;
      meterIds = { takeId: msg.takeId.slice(), streamId: msg.streamId.slice() };
      localPayloads.clear();
      localCodecHeader = null;
      engine = new RecorderEngine(
        msg.takeId,
        msg.streamId,
        sampleRate,
        msg.bitsPerSample,
        msg.deviceDesc,
        epochUs,
        msg.wallClockHintMs,
        msg.ringBudgetBytes,
      );
      if (retainLocal) {
        engine.add_sink(LOCAL_SINK_ID);
        engine.set_sink_connected(LOCAL_SINK_ID, true);
      }
      for (const [sinkId, connected] of preArmSinks) {
        engine.add_sink(sinkId);
        engine.set_sink_connected(sinkId, connected);
      }
      post({ type: "armed", epochUs });
      break;
    }
    case "stop": {
      if (!engine) return;
      pump(); // consume anything still in the ring first
      engine.finish();
      const finalSeq = engine.final_seq() ?? null;
      drainLocal();
      if (localSink && finalSeq !== null) {
        const stats = JSON.parse(engine.stats_json()) as RecorderStats;
        const takeId = uuidBytes(stats.takeId);
        const streamId = uuidBytes(stats.streamId);
        localSink.set_final_seq(takeId, streamId, finalSeq);
        ackLocal();
      }
      announcePending();
      post({ type: "stopped", finalSeq });
      break;
    }
    case "sink-add": {
      preArmSinks.set(msg.sinkId, preArmSinks.get(msg.sinkId) ?? false);
      engine?.add_sink(msg.sinkId);
      break;
    }
    case "sink-connected": {
      preArmSinks.set(msg.sinkId, msg.connected);
      engine?.set_sink_connected(msg.sinkId, msg.connected);
      if (msg.connected) announcePending();
      break;
    }
    case "sink-remove": {
      preArmSinks.delete(msg.sinkId);
      engine?.remove_sink(msg.sinkId);
      break;
    }
    case "frame": {
      if (!engine) return;
      const reply = engine.handle_frame(msg.sinkId, new Uint8Array(msg.bytes), nowUs());
      if (reply) {
        const buf = reply.buffer as ArrayBuffer;
        post({ type: "reply", sinkId: msg.sinkId, bytes: buf }, [buf]);
      }
      announcePending();
      break;
    }
    case "drain": {
      if (!engine) return;
      const frames: ArrayBuffer[] = [];
      let bytes = 0;
      while (bytes < msg.maxBytes) {
        const frame = engine.pop_frame(msg.sinkId);
        if (!frame) break;
        bytes += frame.byteLength;
        frames.push(frame.buffer as ArrayBuffer);
      }
      if (frames.length > 0) {
        post({ type: "frames", sinkId: msg.sinkId, frames }, frames);
      }
      break;
    }
    case "time-ping": {
      if (!engine) return;
      const ping = engine.time_ping(msg.sinkId, nowUs());
      const buf = ping.buffer as ArrayBuffer;
      post({ type: "reply", sinkId: msg.sinkId, bytes: buf }, [buf]);
      break;
    }
    case "export": {
      if (!localCodecHeader) {
        post({ type: "export-result", flac: null });
        return;
      }
      const seqs = [...localPayloads.keys()].sort((a, b) => a - b);
      let total = localCodecHeader.byteLength;
      for (const s of seqs) total += (localPayloads.get(s) as Uint8Array).byteLength;
      const out = new Uint8Array(total);
      out.set(localCodecHeader, 0);
      let off = localCodecHeader.byteLength;
      for (const s of seqs) {
        const p = localPayloads.get(s) as Uint8Array;
        out.set(p, off);
        off += p.byteLength;
      }
      post({ type: "export-result", flac: out.buffer as ArrayBuffer }, [out.buffer as ArrayBuffer]);
      break;
    }
  }
}

self.onmessage = (event: MessageEvent<ToEncoderWorker>) => {
  handle(event.data).catch((e) => post({ type: "error", message: String(e) }));
};
