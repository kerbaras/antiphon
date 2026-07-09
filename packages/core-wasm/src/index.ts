// Typed wrapper around the wasm-pack output in ./pkg (built from
// packages/wasm). One package, two runtimes: the browser fetches the .wasm
// by URL; Node reads it from disk. Consumers call `init()` once — in a
// worker or on the server, never on an audio thread — then use the classes.

import wasmInit, { initSync } from "../pkg/antiphon.js";

export {
  align_content,
  chunk_meta_json,
  constants_json,
  DriftEstimator,
  decode_meter_frame,
  encode_have_summary,
  encode_meter_frame,
  extract_chunk_payload,
  extract_codec_header,
  find_chirp_offset,
  generate_chirp,
  IngestResult,
  RecorderEngine,
  SinkEngine,
  stream_header_json,
  TimeSyncSession,
  version,
} from "../pkg/antiphon.js";

let initPromise: Promise<void> | null = null;

async function instantiate(): Promise<void> {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (typeof proc?.versions?.node === "string") {
    // Specifier kept opaque so browser bundlers don't try to resolve the
    // Node builtin into worker/client bundles.
    const fsSpecifier = "node:fs/promises";
    const { readFile } = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFile: (url: URL) => Promise<Uint8Array<ArrayBuffer>>;
    };
    const bytes = await readFile(new URL("../pkg/antiphon_bg.wasm", import.meta.url));
    // initSync accepts raw bytes; avoids referencing the WebAssembly global
    // type, which Node lib configs don't declare.
    initSync({ module: bytes });
  } else {
    await wasmInit({
      module_or_path: new URL("../pkg/antiphon_bg.wasm", import.meta.url),
    });
  }
}

/**
 * Idempotent AND race-safe. Resolves when the wasm module is instantiated.
 *
 * The in-flight PROMISE is memoized, not a done-flag: concurrent callers on
 * one thread (the desk main thread calls init() from session start, chirp
 * playback, and alignment) share a single fetch + instantiate instead of
 * racing into a double init. A failed init clears the memo so a later call
 * can retry instead of inheriting a cached rejection.
 *
 * NOTE on the QA-2 "wasm asset fetched twice per load" network log: two
 * fetches per DESK load are INTENDED. Wasm instantiation is per JS context —
 * the desk needs the module on the main thread (chirp/align/meter decode)
 * and inside the sink worker; the phone fetches once (encoder worker only).
 * One fetch per context is the budget; e2e pins it (join-polish.spec.ts).
 */
export function init(): Promise<void> {
  initPromise ??= instantiate().catch((error: unknown) => {
    initPromise = null;
    throw error;
  });
  return initPromise;
}

/** Protocol constants (RFC 0001 §13) decoded from the wasm module. */
export interface ProtocolConstants {
  maxFrameBytes: number;
  nominalChunkMs: number;
  minChunkMs: number;
  ackIntervalMs: number;
  ringMinSeconds: number;
  timeSyncIntervalMs: number;
  channelLabelData: string;
  channelLabelSync: string;
}

export async function protocolConstants(): Promise<ProtocolConstants> {
  await init();
  const { constants_json } = await import("../pkg/antiphon.js");
  return JSON.parse(constants_json()) as ProtocolConstants;
}
