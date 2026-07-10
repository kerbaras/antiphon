// Typed wrapper around the wasm-pack output in ./pkg (built from
// packages/wasm). Browser fetches the .wasm by URL; Node reads it from disk.
// Call `init()` once — never on an audio thread — then use the classes.

import wasmInit, { initSync } from "../pkg/antiphon.js";

export {
  align_content,
  chunk_meta_json,
  constants_json,
  DriftEstimator,
  decode_meter_frame,
  encode_flac_mono,
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
  if (typeof proc?.versions?.node !== "string") {
    await wasmInit({
      module_or_path: new URL("../pkg/antiphon_bg.wasm", import.meta.url),
    });
    return;
  }
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
}

/** Idempotent and race-safe: the in-flight promise is memoized so concurrent
 * callers share one fetch + instantiate; a failed init clears the memo so a
 * later call retries. Instantiation is per JS context (main thread, workers). */
export function init(): Promise<void> {
  initPromise ??= instantiate().catch((error: unknown) => {
    initPromise = null;
    throw error;
  });
  return initPromise;
}
