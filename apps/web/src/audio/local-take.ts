// Local pseudo-sink for rehearsal takes: a real SinkEngine backs it so
// retained takes run the genuine ACK/drain protocol instead of faking a
// state transition, and the retained payloads assemble into a local .flac.

import {
  chunk_meta_json,
  extract_chunk_payload,
  extract_codec_header,
  type RecorderEngine,
  SinkEngine,
} from "@antiphon/core-wasm";
import { withTotalSamples } from "./flac-streaminfo";
import { LOCAL_SINK_ID, type RecorderStats } from "./worker-protocol";

let retainLocal = false;
let localSink: SinkEngine | null = null;
/** seq → payload bytes, for local .flac export. */
const localPayloads = new Map<number, Uint8Array>();
let localCodecHeader: Uint8Array | null = null;
/** Take sample total, accumulated per retained chunk — patches the export's
 * STREAMINFO total-samples field at finalize. */
let localTotalSamples = 0;

function nowUs(): number {
  return performance.now() * 1_000;
}

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Arm-time reset: (re)create the pseudo-sink and clear retained payloads. */
export function resetLocalTake(retain: boolean): void {
  retainLocal = retain;
  localSink = retain ? new SinkEngine() : null;
  localPayloads.clear();
  localCodecHeader = null;
  localTotalSamples = 0;
}

/** Register the pseudo-sink on a fresh engine (no-op when not retaining). */
export function attachLocalSink(engine: RecorderEngine): void {
  if (!retainLocal) return;
  engine.add_sink(LOCAL_SINK_ID);
  engine.set_sink_connected(LOCAL_SINK_ID, true);
}

export function localChunkCount(): number {
  return localPayloads.size;
}

function ackLocal(engine: RecorderEngine): void {
  if (!localSink) return;
  for (const ack of localSink.ack_frames()) {
    engine.handle_frame(LOCAL_SINK_ID, ack as Uint8Array, nowUs());
  }
}

/** Pump the engine's local-sink queue into the pseudo-sink, retaining chunk
 * payloads for export, then ack back so the engine can settle. */
export function drainLocal(engine: RecorderEngine | null): void {
  if (!engine || !retainLocal || !localSink) return;
  let got = false;
  for (;;) {
    const frame = engine.pop_frame(LOCAL_SINK_ID);
    if (!frame) break;
    got = true;
    localSink.ingest(frame, nowUs());
    try {
      const payload = extract_chunk_payload(frame);
      const meta = JSON.parse(chunk_meta_json(frame)) as { seq: number; sampleCount: number };
      if (meta.seq === 0) {
        localCodecHeader = extract_codec_header(payload);
      } else if (!localPayloads.has(meta.seq)) {
        localPayloads.set(meta.seq, payload);
        localTotalSamples += meta.sampleCount;
      }
    } catch {
      // Non-chunk frames (gap reports) still went into the sink engine.
    }
  }
  if (got) ackLocal(engine);
}

/** Take-stop: mark the pseudo-sink final so its ACKs settle the engine. */
export function finalizeLocal(engine: RecorderEngine, finalSeq: number | null): void {
  if (!localSink || finalSeq === null) return;
  const stats = JSON.parse(engine.stats_json()) as RecorderStats;
  localSink.set_final_seq(uuidBytes(stats.takeId), uuidBytes(stats.streamId), finalSeq);
  ackLocal(engine);
}

/** Assemble the retained take as a playable .flac (null = nothing armed
 * with retainLocal, or the codec bootstrap never arrived). */
export function buildLocalFlac(): ArrayBuffer | null {
  if (!localCodecHeader) return null;
  // Finalize the export's STREAMINFO: the streamed bootstrap says
  // total-samples unknown; the local file knows better.
  const header = withTotalSamples(localCodecHeader, localTotalSamples);
  const seqs = [...localPayloads.keys()].sort((a, b) => a - b);
  let total = header.byteLength;
  for (const s of seqs) total += (localPayloads.get(s) as Uint8Array).byteLength;
  const out = new Uint8Array(total);
  out.set(header, 0);
  let off = header.byteLength;
  for (const s of seqs) {
    const p = localPayloads.get(s) as Uint8Array;
    out.set(p, off);
    off += p.byteLength;
  }
  return out.buffer as ArrayBuffer;
}
