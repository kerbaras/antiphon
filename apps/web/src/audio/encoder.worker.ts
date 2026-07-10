// Encoder worker: hosts the WASM RecorderEngine (never the audio thread).
// Drains PCM from the SAB ring on a timer, encodes to chunks, and serves
// per-sink frame queues to the main thread on demand. Capture NEVER gates on
// network state — the pump runs regardless of transport (§7.1).

import { encode_meter_frame, init, RecorderEngine } from "@antiphon/core-wasm";
import {
  attachLocalSink,
  buildLocalFlac,
  drainLocal,
  finalizeLocal,
  localChunkCount,
  resetLocalTake,
} from "./local-take";
import { CaptureRingReader, decayedPeak } from "./sab-ring";
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
let peak = 0;
/** Take/stream identity retained for METER telemetry frames. */
let meterIds: { takeId: Uint8Array; streamId: Uint8Array } | null = null;
/** Sinks registered before the engine exists (arm applies them). */
const preArmSinks = new Map<number, boolean>();
/** Arm requested while the previous take is still draining: queued, applied
 * the moment the old engine closes. Discarding the old engine would break
 * its backfill obligations; refusing the new take would lose a whole take —
 * a short capture-start delay is the only lossless option. */
let pendingArm: Extract<ToEncoderWorker, { type: "arm" }> | null = null;

function post(msg: FromEncoderWorker, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, transfer);
}

function nowUs(): number {
  return performance.now() * 1_000;
}

function pump() {
  if (pendingArm && engine?.state() === "closed") {
    const queued = pendingArm;
    pendingArm = null;
    doArm(queued);
  }
  if (!ring) return;
  // The ring drains EVERY pump, armed or not. Cap one pump at 2s of audio
  // to bound slab size after long stalls.
  const slab = ring.read(sampleRate * 2);
  if (slab.length > 0) {
    peak = decayedPeak(peak, slab);
    // Samples reach an encoder only while a take is live (§6.2: the sample
    // domain starts at arm). Un-armed, the read above IS the idle drain:
    // the ring stays near-empty, the peak keeps the VU live for
    // soundcheck, and the samples are DISCARDED — pre-arm room audio never
    // lands in any take (privacy).
    if (engine?.state() === "streaming") {
      try {
        engine.push_samples(slab);
      } catch (e) {
        post({ type: "error", message: `encode failed: ${String(e)}` });
        return;
      }
    }
  }
  drainLocal(engine);
  announcePending();
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
    localChunks: localChunkCount(),
  });
  // Live level telemetry toward the desk's meters, only while capturing.
  if (stats?.state === "streaming" && meterIds) {
    const frame = encode_meter_frame(meterIds.takeId, meterIds.streamId, peak);
    const buf = frame.buffer as ArrayBuffer;
    post({ type: "meter", frame: buf }, [buf]);
  }
}

function doArm(msg: Extract<ToEncoderWorker, { type: "arm" }>): void {
  if (!ring) return;
  if (engine) {
    engine.free();
    engine = null;
  }
  // Sample index 0 of the take = the first sample captured AFTER this arm:
  // discard the (already idle-drained, near-empty) ring remainder and zero
  // the overflow ledger so per-take diagnostics start clean.
  ring.snapToWrite();
  ring.resetDropped();
  const epochUs = nowUs();
  resetLocalTake(msg.retainLocal);
  meterIds = { takeId: msg.takeId.slice(), streamId: msg.streamId.slice() };
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
  attachLocalSink(engine);
  for (const [sinkId, connected] of preArmSinks) {
    engine.add_sink(sinkId);
    engine.set_sink_connected(sinkId, connected);
  }
  post({ type: "armed", epochUs });
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
      if (engine && engine.state() !== "closed") {
        // One engine per take, and a draining one still owes backfill from
        // its ring — never discard it. Queue the new take; the pump arms it
        // the moment the old engine settles. Audio before that arm belongs
        // to no take.
        pendingArm = msg;
        return;
      }
      doArm(msg);
      break;
    }
    case "stop": {
      if (pendingArm) {
        // The queued take was stopped before it ever armed: nothing was
        // captured for it, and the old engine keeps draining untouched.
        pendingArm = null;
        post({ type: "stopped", finalSeq: null });
        return;
      }
      if (!engine) return;
      pump(); // consume anything still in the ring first
      engine.finish();
      const finalSeq = engine.final_seq() ?? null;
      drainLocal(engine);
      finalizeLocal(engine, finalSeq);
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
      const flac = buildLocalFlac();
      if (!flac) {
        post({ type: "export-result", flac: null });
        return;
      }
      post({ type: "export-result", flac }, [flac]);
      break;
    }
  }
}

self.onmessage = (event: MessageEvent<ToEncoderWorker>) => {
  handle(event.data).catch((e) => post({ type: "error", message: String(e) }));
};
