import { describe, expect, it } from "vitest";
import {
  alignShifts,
  normalizeAlignDeltas,
  planSource,
  resolveRange,
  type TrackTiming,
  trackEndSec,
} from "./timeline-math";

const IDENTITY: TrackTiming = { headSec: 0, ratio: 1, clipDelaySec: 0, bufferDurationSec: 10 };

describe("planSource", () => {
  it("identity timing plays the buffer as-is", () => {
    expect(planSource(IDENTITY, 0)).toEqual({ whenSec: 0, offsetSec: 0 });
    expect(planSource(IDENTITY, 4.5)).toEqual({ whenSec: 0, offsetSec: 4.5 });
  });

  it("head trim shifts the buffer offset, not the timeline", () => {
    const t: TrackTiming = { ...IDENTITY, headSec: 0.25 };
    expect(planSource(t, 0)).toEqual({ whenSec: 0, offsetSec: 0.25 });
    expect(planSource(t, 3)).toEqual({ whenSec: 0, offsetSec: 3.25 });
  });

  it("drift ratio scales the buffer offset: offset = headSec + rel·ratio", () => {
    const t: TrackTiming = { ...IDENTITY, headSec: 0.5, ratio: 1.0002 };
    const plan = planSource(t, 5);
    expect(plan).not.toBeNull();
    expect(plan?.whenSec).toBe(0);
    // A fast clock (ratio > 1) packed MORE samples into each room-second.
    expect(plan?.offsetSec).toBeCloseTo(0.5 + 5 * 1.0002, 12);
    expect(plan?.offsetSec).toBeGreaterThan(5.5);
  });

  it("clip delay defers the start instead of offsetting the buffer", () => {
    const t: TrackTiming = { ...IDENTITY, headSec: 0.1, clipDelaySec: 2 };
    expect(planSource(t, 0.5)).toEqual({ whenSec: 1.5, offsetSec: 0.1 });
    expect(planSource(t, 2)).toEqual({ whenSec: 0, offsetSec: 0.1 });
    expect(planSource(t, 2.5)).toEqual({ whenSec: 0, offsetSec: 0.6 });
  });

  it("range start at the drift-scaled end boundary is exact", () => {
    const t: TrackTiming = { headSec: 0.5, ratio: 1.0005, clipDelaySec: 1, bufferDurationSec: 10 };
    const end = trackEndSec(t);
    // Just inside the end: offset lands just under the buffer duration.
    const inside = planSource(t, end - 1e-6);
    expect(inside).not.toBeNull();
    expect(inside?.offsetSec).toBeLessThan(t.bufferDurationSec);
    expect(inside?.offsetSec).toBeCloseTo(t.bufferDurationSec, 5);
    // At (or past) the end there is nothing left to play.
    expect(planSource(t, end)).toBeNull();
    expect(planSource(t, end + 1)).toBeNull();
  });

  it("round-trips with trackEndSec under drift: end maps back to buffer end", () => {
    const t: TrackTiming = {
      headSec: 0.75,
      ratio: 0.9998,
      clipDelaySec: 3,
      bufferDurationSec: 42,
    };
    const end = trackEndSec(t);
    // trackEndSec = clipDelay + (dur − head)/ratio, so the slow clock
    // (ratio < 1) STRETCHES the buffer on the room timeline.
    expect(end).toBeCloseTo(3 + (42 - 0.75) / 0.9998, 12);
    expect(end).toBeGreaterThan(3 + (42 - 0.75));
    // planSource at `end` would need offset = head + (end − delay)·ratio = dur.
    expect(t.headSec + (end - t.clipDelaySec) * t.ratio).toBeCloseTo(t.bufferDurationSec, 12);
  });
});

describe("normalizeAlignDeltas", () => {
  it("yields nothing without at least two lags", () => {
    expect(normalizeAlignDeltas([], 1).size).toBe(0);
    expect(
      normalizeAlignDeltas([{ streamId: "a", lagSamples: 5_000, sampleRate: 48_000 }], 1).size,
    ).toBe(0);
  });

  it("shifts deltas so the earliest track trims zero", () => {
    const deltas = normalizeAlignDeltas(
      [
        { streamId: "a", lagSamples: 5_000, sampleRate: 48_000 },
        { streamId: "b", lagSamples: 3_000, sampleRate: 48_000 },
      ],
      1,
    );
    expect(deltas.get("b")).toBe(0);
    expect(deltas.get("a")).toBe(2_000);
  });

  it("normalizes lags that locked onto different chirp repeats", () => {
    // b locked one full repeat interval (1 s = 48 000 samples) later:
    // the true inter-device offset is 400 samples, not 48 400.
    const deltas = normalizeAlignDeltas(
      [
        { streamId: "a", lagSamples: 1_000, sampleRate: 48_000 },
        { streamId: "b", lagSamples: 49_400, sampleRate: 48_000 },
      ],
      1,
    );
    expect(deltas.get("a")).toBe(0);
    expect(deltas.get("b")).toBe(400);
  });

  it("content lags never wrap — offsets beyond the chirp interval stay honest (W4-B)", () => {
    // 1.5 s of genuine pre-roll difference: a chirp lag pair would wrap
    // this modulo the 1 s interval; content lags carry no repeat ambiguity.
    const deltas = normalizeAlignDeltas(
      [
        { streamId: "ref", lagSamples: 0, sampleRate: 48_000, method: "content" },
        { streamId: "b", lagSamples: 72_000, sampleRate: 48_000, method: "content" },
      ],
      1,
    );
    expect(deltas.get("ref")).toBe(0);
    expect(deltas.get("b")).toBe(72_000);
  });

  it("negative content lags shift the base so every delta stays a head-trim", () => {
    const deltas = normalizeAlignDeltas(
      [
        { streamId: "ref", lagSamples: 0, sampleRate: 48_000, method: "content" },
        { streamId: "b", lagSamples: -4_800, sampleRate: 48_000, method: "content" },
      ],
      1,
    );
    expect(deltas.get("ref")).toBe(4_800);
    expect(deltas.get("b")).toBe(0);
  });

  it("mixed sets wrap chirp lags against the CHIRP base and chain content raw (W4-B)", () => {
    // Chirp pair with a repeat-wrapped member; a content track measured
    // against the chirp anchor (lag = anchor lag 1 000 + offset 500).
    const deltas = normalizeAlignDeltas(
      [
        { streamId: "a", lagSamples: 1_000, sampleRate: 48_000, method: "chirp" },
        { streamId: "b", lagSamples: 49_400, sampleRate: 48_000, method: "chirp" },
        { streamId: "c", lagSamples: 1_500, sampleRate: 48_000, method: "content" },
      ],
      1,
    );
    expect(deltas.get("a")).toBe(0);
    expect(deltas.get("b")).toBe(400);
    expect(deltas.get("c")).toBe(500);
  });
});

describe("alignShifts (W6-C visual composition)", () => {
  it("is empty/zero without an applied verdict — clips stay put", () => {
    expect(alignShifts([], 1)).toEqual({ shiftSec: new Map(), anchorSec: 0 });
    // A lone lag yields no deltas (normalizeAlignDeltas rule) → no shifts.
    expect(alignShifts([{ streamId: "a", lagSamples: 5_000, sampleRate: 48_000 }], 1)).toEqual({
      shiftSec: new Map(),
      anchorSec: 0,
    });
  });

  it("shifts the LATER starter right; the earliest (max head-trim) stays put", () => {
    // b holds 72 000 samples (1.5 s) more pre-roll: it started capturing
    // 1.5 s earlier, so on an honest timeline REF sits 1.5 s to its right.
    const { shiftSec, anchorSec } = alignShifts(
      [
        { streamId: "ref", lagSamples: 0, sampleRate: 48_000, method: "content" },
        { streamId: "b", lagSamples: 72_000, sampleRate: 48_000, method: "content" },
      ],
      1,
    );
    expect(shiftSec.get("b")).toBe(0);
    expect(shiftSec.get("ref")).toBeCloseTo(1.5, 12);
    // Room-time zero draws at the base plus the max trim.
    expect(anchorSec).toBeCloseTo(1.5, 12);
  });

  it("mirrors the schedule deltas exactly: shift + delta = anchor for every stream", () => {
    const lags = [
      { streamId: "a", lagSamples: 1_000, sampleRate: 48_000, method: "chirp" as const },
      { streamId: "b", lagSamples: 49_400, sampleRate: 48_000, method: "chirp" as const },
      { streamId: "c", lagSamples: 1_500, sampleRate: 48_000, method: "content" as const },
    ];
    const deltas = normalizeAlignDeltas(lags, 1);
    const { shiftSec, anchorSec } = alignShifts(lags, 1);
    for (const [streamId, delta] of deltas) {
      expect((shiftSec.get(streamId) as number) + delta / 48_000).toBeCloseTo(anchorSec, 12);
    }
    // Every shift is a rightward (≥ 0) move — never off the left edge.
    for (const shift of shiftSec.values()) expect(shift).toBeGreaterThanOrEqual(0);
  });
});

describe("resolveRange", () => {
  it("defaults to the whole take", () => {
    expect(resolveRange(30)).toEqual({ startSec: 0, endSec: 30 });
    expect(resolveRange(30, {})).toEqual({ startSec: 0, endSec: 30 });
  });

  it("passes explicit in-bounds ranges through (W2-B marker renders)", () => {
    expect(resolveRange(30, { startSec: 5, endSec: 12.5 })).toEqual({
      startSec: 5,
      endSec: 12.5,
    });
    expect(resolveRange(30, { startSec: 5 })).toEqual({ startSec: 5, endSec: 30 });
    expect(resolveRange(30, { endSec: 5 })).toEqual({ startSec: 0, endSec: 5 });
  });

  it("clamps out-of-bounds ranges into the take", () => {
    expect(resolveRange(30, { startSec: -3, endSec: 99 })).toEqual({ startSec: 0, endSec: 30 });
  });

  it("rejects empty ranges", () => {
    expect(() => resolveRange(30, { startSec: 10, endSec: 10 })).toThrow(/empty render range/);
    expect(() => resolveRange(30, { startSec: 12, endSec: 4 })).toThrow(/empty render range/);
    expect(() => resolveRange(0)).toThrow(/empty render range/);
  });
});
