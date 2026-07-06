//! Antiphon chunk protocol core (see docs/ARCHITECTURE.md §7).
//!
//! Transport-agnostic: chunk framing, sequence logic, reconciliation, and the
//! sender-side ring buffer. Gets a proptest suite (drops/reorders/duplicates
//! must always reconcile) before any network code exists.

pub mod chunk;
pub mod reconcile;
pub mod ring;
