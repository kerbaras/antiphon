//! Sender-side ring buffer: last ~30–60s of encoded chunks kept for backfill
//! after a dropout. Bounded by payload bytes, oldest evicted first.
