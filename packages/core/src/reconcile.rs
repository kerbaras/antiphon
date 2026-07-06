//! Receiver-side sequence tracking and "send me ≥ seq N" reconciliation.
//! Must tolerate drops, reorders, and duplicates (idempotent by design).
