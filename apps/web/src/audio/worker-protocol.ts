// Message contract between the main thread and the encoder worker.
// Frames cross as transferred ArrayBuffers; the worker owns the wasm engine.

import type { RingDiagnostics } from "./sab-ring";

/** Pseudo-sink drained into worker memory for local .flac export. */
export const LOCAL_SINK_ID = 0xffff;

export interface RecorderSinkStats {
  id: number;
  connected: boolean;
  settled: boolean;
  idle: boolean;
  clockOffsetUs: number | null;
}

export interface RecorderStats {
  state: "idle" | "armed" | "streaming" | "draining" | "closed";
  nextSeq: number;
  finalSeq: number | null;
  samplesIn: number;
  ringBytes: number;
  ringChunks: number;
  gaps: Array<[number, number]>;
  takeId: string;
  streamId: string;
  sampleRate: number;
  sinks: RecorderSinkStats[];
}

export type ToEncoderWorker =
  | { type: "configure"; sab: SharedArrayBuffer; sampleRate: number }
  | {
      type: "arm";
      takeId: Uint8Array;
      streamId: Uint8Array;
      bitsPerSample: 16 | 24;
      deviceDesc: string;
      wallClockHintMs: number;
      ringBudgetBytes: number;
      retainLocal: boolean;
    }
  | { type: "stop" }
  | { type: "sink-add"; sinkId: number }
  | { type: "sink-connected"; sinkId: number; connected: boolean }
  | { type: "sink-remove"; sinkId: number }
  | { type: "frame"; sinkId: number; bytes: ArrayBuffer }
  | { type: "drain"; sinkId: number; maxBytes: number }
  | { type: "time-ping"; sinkId: number }
  | { type: "export" };

export type FromEncoderWorker =
  | { type: "ready" }
  | { type: "armed"; epochUs: number }
  | { type: "frames"; sinkId: number; frames: ArrayBuffer[] }
  | { type: "reply"; sinkId: number; bytes: ArrayBuffer }
  | { type: "pending"; sinkIds: number[] }
  | {
      type: "stats";
      stats: RecorderStats | null;
      ring: RingDiagnostics | null;
      peak: number;
      localChunks: number;
    }
  | { type: "stopped"; finalSeq: number | null }
  | { type: "export-result"; flac: ArrayBuffer | null }
  | { type: "error"; message: string };
