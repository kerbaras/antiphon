// Ingest: node-datachannel sink for phone chunk streams → chunk store.
//
// KEEP ISOLATED. This module is the designated extraction candidate for
// Axum + webrtc-rs if hosted-product scale ever demands it. It must only
// speak the idempotent chunk protocol — no reaching into other modules.
// (docs/ARCHITECTURE.md §2.3, §7)
