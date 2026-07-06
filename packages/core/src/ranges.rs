//! Sorted, coalesced sets of inclusive `u32` sequence ranges.
//!
//! The workhorse behind CHWM/hole computation, HAVE summaries, gap
//! declarations, and backfill queue dedup. Unit-tested against a
//! `BTreeSet<u32>` model.

use crate::frame::SeqRange;

/// A set of u32 values stored as sorted, non-adjacent, non-overlapping
/// inclusive ranges.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RangeSet {
    /// Invariant: sorted by start; `ranges[i].end + 1 < ranges[i+1].start`.
    ranges: Vec<SeqRange>,
}

impl RangeSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_ranges<I: IntoIterator<Item = SeqRange>>(iter: I) -> Self {
        let mut set = Self::new();
        for r in iter {
            set.insert_range(r);
        }
        set
    }

    pub fn is_empty(&self) -> bool {
        self.ranges.is_empty()
    }

    pub fn ranges(&self) -> &[SeqRange] {
        &self.ranges
    }

    pub fn contains(&self, value: u32) -> bool {
        self.ranges
            .binary_search_by(|r| {
                if value < r.start {
                    std::cmp::Ordering::Greater
                } else if value > r.end {
                    std::cmp::Ordering::Less
                } else {
                    std::cmp::Ordering::Equal
                }
            })
            .is_ok()
    }

    /// Number of values covered.
    pub fn count(&self) -> u64 {
        self.ranges.iter().map(SeqRange::len).sum()
    }

    pub fn min(&self) -> Option<u32> {
        self.ranges.first().map(|r| r.start)
    }

    pub fn max(&self) -> Option<u32> {
        self.ranges.last().map(|r| r.end)
    }

    pub fn insert(&mut self, value: u32) {
        self.insert_range(SeqRange::new(value, value));
    }

    pub fn insert_range(&mut self, range: SeqRange) {
        if range.is_empty() {
            return;
        }
        // u64 arithmetic sidesteps overflow at the u32 boundaries.
        // lo = first index that can merge with us (its end touches our start).
        let lo = self
            .ranges
            .partition_point(|r| u64::from(r.end) + 1 < u64::from(range.start));
        // hi = first index that cannot merge (starts beyond our end + 1).
        let hi = self
            .ranges
            .partition_point(|r| u64::from(r.start) <= u64::from(range.end) + 1);
        let mut new_start = range.start;
        let mut new_end = range.end;
        if lo < hi {
            new_start = new_start.min(self.ranges[lo].start);
            new_end = new_end.max(self.ranges[hi - 1].end);
        }
        self.ranges
            .splice(lo..hi, [SeqRange::new(new_start, new_end)]);
    }

    pub fn remove(&mut self, value: u32) {
        self.remove_range(SeqRange::new(value, value));
    }

    pub fn remove_range(&mut self, range: SeqRange) {
        if range.is_empty() || self.ranges.is_empty() {
            return;
        }
        let mut result: Vec<SeqRange> = Vec::with_capacity(self.ranges.len() + 1);
        for r in &self.ranges {
            if r.end < range.start || r.start > range.end {
                result.push(*r);
                continue;
            }
            if r.start < range.start {
                result.push(SeqRange::new(r.start, range.start - 1));
            }
            if r.end > range.end {
                result.push(SeqRange::new(range.end + 1, r.end));
            }
        }
        self.ranges = result;
    }

    pub fn union(&self, other: &RangeSet) -> RangeSet {
        let mut out = self.clone();
        for r in &other.ranges {
            out.insert_range(*r);
        }
        out
    }

    /// Values in `self` but not in `other`.
    pub fn subtract(&self, other: &RangeSet) -> RangeSet {
        let mut out = self.clone();
        for r in &other.ranges {
            out.remove_range(*r);
        }
        out
    }

    /// Values in `within` that are NOT in `self`.
    pub fn missing_within(&self, within: SeqRange) -> RangeSet {
        let mut out = RangeSet::from_ranges([within]);
        for r in &self.ranges {
            out.remove_range(*r);
        }
        out
    }

    /// Highest `n` such that all of `0..=n` is contained, or `None` if 0 is
    /// missing.
    pub fn contiguous_from_zero(&self) -> Option<u32> {
        let first = self.ranges.first()?;
        if first.start != 0 {
            return None;
        }
        Some(first.end)
    }

    pub fn iter_values(&self) -> impl Iterator<Item = u32> + '_ {
        self.ranges.iter().flat_map(|r| r.start..=r.end)
    }
}

impl FromIterator<u32> for RangeSet {
    fn from_iter<I: IntoIterator<Item = u32>>(iter: I) -> Self {
        let mut set = Self::new();
        for v in iter {
            set.insert(v);
        }
        set
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn assert_matches_model(set: &RangeSet, model: &BTreeSet<u32>, probe_max: u32) {
        for v in 0..=probe_max {
            assert_eq!(set.contains(v), model.contains(&v), "value {v}");
        }
        assert_eq!(set.count(), model.len() as u64);
        // Invariants: sorted, coalesced.
        for pair in set.ranges().windows(2) {
            assert!(pair[0].end < pair[1].start, "sorted/disjoint");
            assert!(
                u64::from(pair[0].end) + 1 < u64::from(pair[1].start),
                "coalesced"
            );
        }
    }

    #[test]
    fn insert_coalesces() {
        let mut s = RangeSet::new();
        s.insert(1);
        s.insert(3);
        s.insert(2);
        assert_eq!(s.ranges(), &[SeqRange::new(1, 3)]);
        s.insert_range(SeqRange::new(0, 10));
        assert_eq!(s.ranges(), &[SeqRange::new(0, 10)]);
    }

    #[test]
    fn adjacency_merges() {
        let mut s = RangeSet::new();
        s.insert_range(SeqRange::new(0, 4));
        s.insert_range(SeqRange::new(5, 9));
        assert_eq!(s.ranges(), &[SeqRange::new(0, 9)]);
    }

    #[test]
    fn remove_splits() {
        let mut s = RangeSet::from_ranges([SeqRange::new(0, 10)]);
        s.remove_range(SeqRange::new(3, 6));
        assert_eq!(s.ranges(), &[SeqRange::new(0, 2), SeqRange::new(7, 10)]);
    }

    #[test]
    fn contiguous_from_zero() {
        let mut s = RangeSet::new();
        assert_eq!(s.contiguous_from_zero(), None);
        s.insert(1);
        assert_eq!(s.contiguous_from_zero(), None);
        s.insert(0);
        assert_eq!(s.contiguous_from_zero(), Some(1));
        s.insert_range(SeqRange::new(3, 8));
        assert_eq!(s.contiguous_from_zero(), Some(1));
        s.insert(2);
        assert_eq!(s.contiguous_from_zero(), Some(8));
    }

    #[test]
    fn missing_within() {
        let s = RangeSet::from_ranges([SeqRange::new(2, 3), SeqRange::new(7, 8)]);
        let missing = s.missing_within(SeqRange::new(0, 10));
        assert_eq!(
            missing.ranges(),
            &[
                SeqRange::new(0, 1),
                SeqRange::new(4, 6),
                SeqRange::new(9, 10)
            ]
        );
    }

    #[test]
    fn boundary_zero_and_max() {
        let mut s = RangeSet::new();
        s.insert(0);
        s.insert(u32::MAX);
        assert!(s.contains(0));
        assert!(s.contains(u32::MAX));
        s.insert_range(SeqRange::new(1, u32::MAX - 1));
        assert_eq!(s.ranges(), &[SeqRange::new(0, u32::MAX)]);
        assert_eq!(s.count(), u64::from(u32::MAX) + 1);
    }

    #[test]
    fn randomized_against_model() {
        // Deterministic pseudo-random stress vs BTreeSet model.
        let mut seed = 0x1234_5678u64;
        let mut rnd = move || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 33) as u32
        };
        let mut set = RangeSet::new();
        let mut model: BTreeSet<u32> = BTreeSet::new();
        for _ in 0..2000 {
            let a = rnd() % 64;
            let b = rnd() % 64;
            let (start, end) = if a <= b { (a, b) } else { (b, a) };
            if rnd() % 3 == 0 {
                set.remove_range(SeqRange::new(start, end));
                for v in start..=end {
                    model.remove(&v);
                }
            } else {
                set.insert_range(SeqRange::new(start, end));
                for v in start..=end {
                    model.insert(v);
                }
            }
        }
        assert_matches_model(&set, &model, 70);
    }
}
