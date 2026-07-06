// Typed wrapper around the wasm-pack output in ./pkg (built from
// packages/wasm). One package, two runtimes: the browser fetches the .wasm
// by URL; Node reads it from disk. Consumers call `init()` once — in a
// worker or on the server, never on an audio thread — then use the classes.

import wasmInit, { initSync } from "../pkg/antiphon.js";

export {
  chunk_meta_json,
  constants_json,
  encode_have_summary,
  extract_chunk_payload,
  extract_codec_header,
  generate_chirp,
  IngestResult,
  RecorderEngine,
  SinkEngine,
  stream_header_json,
  TimeSyncSession,
  version,
} from "../pkg/antiphon.js";

let initialized = false;

/** Idempotent. Resolves when the wasm module is instantiated. */
export async function init(): Promise<void> {
  if (initialized) return;
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
  initialized = true;
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
