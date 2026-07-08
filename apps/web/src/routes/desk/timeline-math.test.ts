import { describe, expect, it } from "vitest";
import {
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
