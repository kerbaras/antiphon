//! Proptest suite for the chunk protocol (docs/ARCHITECTURE.md §11).
//!
//! Random drops, reorders, and duplicates must ALWAYS reconcile — this suite
//! is written before any network code exists. It is what makes Milestone 1 a
//! demo instead of a prayer.
