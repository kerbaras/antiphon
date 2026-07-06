// Web Worker hosting the WASM FLAC encoder (@antiphon/core-wasm).
// Reads PCM from the SAB ring, emits sequence-numbered chunks to the
// transport. WASM never runs inside the worklet.
