// W7-B clip-region math: the split rules the tool enforces before anything
// touches the shared doc — piece identity, abutment, the 100 ms floor, and
// the stored-list invariants.

import { describe, expect, it } from "vitest";
import {
  MIN_REGION_SEC,
  regionsValid,
  seedRegion,
  selectionStreamIds,
  splitRegion,
  trimRegion,
} from "./regions";

describe("seedRegion", () => {
  it("is the whole source at the arrangement position, id == streamId", () => {
    expect(seedRegion("s1", 1.5, 8)).toEqual({
      id: "s1",
      startSec: 1.5,
      sourceOffsetSec: 0,
      durationSec: 8,
    });
  });
});

describe("splitRegion", () => {
  const seed = [seedRegion("s1", 1, 10)];

  it("cuts into two abutting pieces; the left keeps the original id", () => {
    const out = splitRegion(seed, "s1", 4, "fresh");
    expect(out).toEqual([
      { id: "s1", startSec: 1, sourceOffsetSec: 0, durationSec: 4 },
      { id: "fresh", startSec: 5, sourceOffsetSec: 4, durationSec: 6 },
    ]);
  });

  it("abuts on BOTH axes even after the region was dragged", () => {
    const dragged = [{ id: "s1", startSec: 7.25, sourceOffsetSec: 0, durationSec: 10 }];
    const out = splitRegion(dragged, "s1", 4, "fresh");
    expect(out?.[1]).toEqual({ id: "fresh", startSec: 11.25, sourceOffsetSec: 4, durationSec: 6 });
  });

  it("splits a non-first piece, leaving siblings untouched", () => {
    const twice = splitRegion(splitRegion(seed, "s1", 4, "b") as [], "b", 7, "c");
    expect(twice).toEqual([
      { id: "s1", startSec: 1, sourceOffsetSec: 0, durationSec: 4 },
      { id: "b", startSec: 5, sourceOffsetSec: 4, durationSec: 3 },
      { id: "c", startSec: 8, sourceOffsetSec: 7, durationSec: 3 },
    ]);
  });

  it("rejects cuts within 100 ms of either region edge", () => {
    expect(splitRegion(seed, "s1", MIN_REGION_SEC / 2)).toBeNull();
    expect(splitRegion(seed, "s1", 10 - MIN_REGION_SEC / 2)).toBeNull();
    expect(splitRegion(seed, "s1", 0)).toBeNull();
    expect(splitRegion(seed, "s1", 10)).toBeNull();
    // Exactly at the floor is allowed.
    expect(splitRegion(seed, "s1", MIN_REGION_SEC)).not.toBeNull();
  });

  it("rejects an unknown region id", () => {
    expect(splitRegion(seed, "nope", 4)).toBeNull();
  });
});

describe("selectionStreamIds", () => {
  it("maps region ids to owning streams, dedupes, keeps never-split ids verbatim", () => {
    const docRegions = {
      "stream-a": [
        { id: "stream-a", startSec: 1, sourceOffsetSec: 0, durationSec: 4 },
        { id: "piece-2", startSec: 5, sourceOffsetSec: 4, durationSec: 6 },
      ],
    };
    // A split piece, the split stream's left piece (id == streamId), and a
    // never-split stream: pieces resolve to the stream, dupes collapse.
    expect(selectionStreamIds(["piece-2", "stream-a", "stream-b"], docRegions)).toEqual([
      "stream-a",
      "stream-b",
    ]);
    expect(selectionStreamIds([], docRegions)).toEqual([]);
    // No regions map at all: identity (the pre-W7-B behavior).
    expect(selectionStreamIds(["s1", "s2"], {})).toEqual(["s1", "s2"]);
  });
});

describe("trimRegion (W9-F)", () => {
  // Windows: [1..4), gap (4..5), [5..8) of a 10 s stream — the gap is the
  // deleted material an edge drag can re-open.
  const list = [
    { id: "a", startSec: 2, sourceOffsetSec: 1, durationSec: 3 },
    { id: "b", startSec: 7, sourceOffsetSec: 5, durationSec: 3 },
  ];

  it("tail trim shortens; the untrimmed head holds its spot", () => {
    const out = trimRegion(list, "a", "tail", -1, 10);
    expect(out?.find((r) => r.id === "a")).toEqual({
      id: "a",
      startSec: 2,
      sourceOffsetSec: 1,
      durationSec: 2,
    });
    expect(out?.find((r) => r.id === "b")).toEqual(list[1]); // sibling untouched
  });

  it("tail extend re-opens hidden audio, clamped at the next window", () => {
    // +5 wants source end 9, but b starts at 5 → clamps to +1.
    const out = trimRegion(list, "a", "tail", 5, 10);
    expect(out?.find((r) => r.id === "a")?.durationSec).toBeCloseTo(4, 9);
    // The LAST region's tail is clamped by the stream end instead.
    const tail = trimRegion(list, "b", "tail", 99, 10);
    expect(tail?.find((r) => r.id === "b")?.durationSec).toBeCloseTo(5, 9); // 5..10
  });

  it("head trim moves start with source offset (material holds position)", () => {
    const out = trimRegion(list, "a", "head", 1, 10);
    expect(out?.find((r) => r.id === "a")).toEqual({
      id: "a",
      startSec: 3,
      sourceOffsetSec: 2,
      durationSec: 2,
    });
  });

  it("head extend clamps at the previous window's end and at source 0", () => {
    // b's head can only reach a's end (source 4): -3 wants source 2 → -1.
    const out = trimRegion(list, "b", "head", -3, 10);
    expect(out?.find((r) => r.id === "b")).toEqual({
      id: "b",
      startSec: 6,
      sourceOffsetSec: 4,
      durationSec: 4,
    });
    // a's head clamps at source 0.
    const first = trimRegion(list, "a", "head", -99, 10);
    expect(first?.find((r) => r.id === "a")?.sourceOffsetSec).toBe(0);
    // …and never past its own startSec 0 (arrangement floor).
    const nearZero = [{ id: "z", startSec: 0.5, sourceOffsetSec: 5, durationSec: 2 }];
    expect(trimRegion(nearZero, "z", "head", -3, 10)?.[0]?.startSec).toBeCloseTo(0, 9);
  });

  it("keeps the 100 ms floor and rejects unknown ids", () => {
    const out = trimRegion(list, "a", "tail", -99, 10);
    expect(out?.find((r) => r.id === "a")?.durationSec).toBeCloseTo(MIN_REGION_SEC, 9);
    const head = trimRegion(list, "a", "head", 99, 10);
    expect(head?.find((r) => r.id === "a")?.durationSec).toBeCloseTo(MIN_REGION_SEC, 9);
    expect(trimRegion(list, "nope", "tail", 1, 10)).toBeNull();
  });

  it("every clamped result satisfies the stored-list invariants", () => {
    for (const edge of ["head", "tail"] as const) {
      for (const d of [-99, -1, -0.05, 0.05, 1, 99]) {
        for (const id of ["a", "b"]) {
          const out = trimRegion(list, id, edge, d, 10);
          expect(out, `${edge} ${id} ${d}`).not.toBeNull();
          expect(regionsValid(out as [], 10), `${edge} ${id} ${d} valid`).toBe(true);
        }
      }
    }
  });
});

describe("regionsValid", () => {
  it("accepts a fresh split of a valid seed", () => {
    const out = splitRegion([seedRegion("s1", 1, 10)], "s1", 4) as [];
    expect(regionsValid(out, 10)).toBe(true);
  });

  it("rejects source overlap, out-of-bounds windows, and slivers", () => {
    expect(
      regionsValid(
        [
          { id: "a", startSec: 1, sourceOffsetSec: 0, durationSec: 5 },
          { id: "b", startSec: 6, sourceOffsetSec: 4, durationSec: 5 }, // overlaps a
        ],
        10,
      ),
    ).toBe(false);
    expect(regionsValid([{ id: "a", startSec: 0, sourceOffsetSec: 0, durationSec: 11 }], 10)).toBe(
      false,
    );
    expect(
      regionsValid([{ id: "a", startSec: 0, sourceOffsetSec: 0, durationSec: 0.05 }], 10),
    ).toBe(false);
    expect(regionsValid([{ id: "a", startSec: -1, sourceOffsetSec: 0, durationSec: 5 }], 10)).toBe(
      false,
    );
    // Empty is VALID (W9-F): every clip deleted from the arrangement.
    expect(regionsValid([], 10)).toBe(true);
  });

  it("allows arrangement-domain overlap — stacked pieces BOTH sound, like overlapped whole clips (source stays disjoint)", () => {
    expect(
      regionsValid(
        [
          { id: "a", startSec: 1, sourceOffsetSec: 0, durationSec: 5 },
          { id: "b", startSec: 1, sourceOffsetSec: 5, durationSec: 5 },
        ],
        10,
      ),
    ).toBe(true);
  });
});
