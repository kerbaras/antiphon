// AudioWorklet processor — stays ~50 lines, forever.
// Copy input frames into the SharedArrayBuffer ring, bump the atomic write
// index, nothing else. No allocation, no WASM, no encoding on this thread.
// (docs/ARCHITECTURE.md §2.1)
