// SharedArrayBuffer ring buffer glue shared by the capture worklet (writer)
// and the encoder worker (reader). Atomics for the read/write indices.
// Requires cross-origin isolation (COOP/COEP) — enforced in vite.config.ts.
