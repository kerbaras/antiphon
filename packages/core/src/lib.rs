//! Antiphon chunk protocol core (RFC 0001; docs/ARCHITECTURE.md §7).
//!
//! Transport-agnostic and sans-IO: framing, sequence logic, reconciliation
//! engines for both ends (recorder sender, sink receiver), and the
//! sender-side ring buffer. The proptest suite in `tests/` (random drops,
//! reorders, duplicates, disconnects, sink crashes must always converge) is
//! this crate's real specification — no network code exists until it passes.

pub mod chunk;
pub mod constants;
pub mod crc32c;
pub mod frame;
pub mod ranges;
pub mod receiver;
pub mod ring;
pub mod sender;
pub mod timesync;
