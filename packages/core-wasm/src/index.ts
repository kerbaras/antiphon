// Typed wrapper around the wasm-pack output in ./pkg (built from
// packages/wasm). One package, two runtimes: the browser fetches the .wasm
// by URL; Node reads it from disk. Consumers call `init()` once — in a
// worker or on the server, never on an audio thread — then use the classes.

import wasmInit, { initSync } from "../pkg/antiphon.js";

export {
  IngestResult,
  RecorderEngine,
  SinkEngine,
  TimeSyncSession,
  constants_json,
  encode_have_summary,
  version,
} from "../pkg/antiphon.js";

let initialized = false;

/** Idempotent. Resolves when the wasm module is instantiated. */
export async function init(): Promise<void> {
  if (initialized) return;
  const isNode =
    typeof process !== "undefined" &&
    typeof process.versions === "object" &&
    process.versions !== null &&
    "node" in process.versions;
  if (isNode) {
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(new URL("../pkg/antiphon_bg.wasm", import.meta.url));
    initSync({ module: new WebAssembly.Module(bytes) });
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
