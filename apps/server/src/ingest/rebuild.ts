// Crash rebuild (RFC §8): reconstruct a SinkEngine from durable storage —
// the server rejoins its own archive as if it had merely been disconnected.

import { init as initWasm, SinkEngine } from "@antiphon/core-wasm";
import type { Archive } from "../archive/index.ts";
import { uuidBytes } from "./util.ts";

export interface KnownState {
  takes: Set<string>;
  streams: Set<string>;
  /** Streams whose seq-0 header has been applied to the streams table. */
  headerApplied: Set<string>;
}

export async function rebuildEngine(
  archive: Archive,
  sessionId: string,
  known: KnownState,
): Promise<SinkEngine> {
  await initWasm();
  const engine = new SinkEngine();
  const state = await archive.loadSessionState(sessionId);
  for (const chunk of state.chunks) {
    engine.rebuild_chunk(
      uuidBytes(chunk.takeId),
      uuidBytes(chunk.streamId),
      chunk.seq,
      chunk.crc32c,
      chunk.firstSampleIndex,
      chunk.sampleCount,
      chunk.payloadLen,
    );
    known.takes.add(chunk.takeId);
    known.streams.add(chunk.streamId);
  }
  for (const stream of state.streams) {
    known.streams.add(stream.id);
    known.takes.add(stream.takeId);
    if (stream.finalSeq !== null) {
      engine.set_final_seq(uuidBytes(stream.takeId), uuidBytes(stream.id), stream.finalSeq);
    }
    if (stream.sampleRate !== null) known.headerApplied.add(stream.id);
  }
  for (const gap of state.gaps) {
    const stream = state.streams.find((s) => s.id === gap.streamId);
    if (stream) {
      engine.rebuild_gap(
        uuidBytes(stream.takeId),
        uuidBytes(gap.streamId),
        gap.startSeq,
        gap.endSeq,
      );
    }
  }
  return engine;
}
