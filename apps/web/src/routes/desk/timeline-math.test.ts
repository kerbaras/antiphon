import { describe, expect, it } from "vitest";
import {
  alignShifts,
  anchorAtSec,
  normalizeAlignDeltas,
  persistedAlignShifts,
  planSource,
  resolveRange,
  type SessionTakeSpan,
  sessionEndSec,
  sessionStartSec,
  type TakeAnchorSpan,
  type TrackTiming,
  takesToMount,
  takesToRelease,
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

// ---- W7-A — persisted shifts (all takes draw aligned) + per-take anchor ----------

describe("persistedAlignShifts (W7-A)", () => {
  it("reproduces the live composition from stored entries — applied lags only", () => {
    // The same lag pair the live path composes (1.5 s content stagger),
    // plus a declined entry that must contribute nothing.
    const shifts = persistedAlignShifts(
      {
        ref: { alignment: { lagSamples: 0, applied: true, method: "content" } },
        b: { alignment: { lagSamples: 72_000, applied: true, method: "content" } },
        declined: { alignment: { lagSamples: 999, applied: false, method: "content" } },
      },
      48_000,
      1,
    );
    const live = alignShifts(
      [
        { streamId: "ref", lagSamples: 0, sampleRate: 48_000, method: "content" },
        { streamId: "b", lagSamples: 72_000, sampleRate: 48_000, method: "content" },
      ],
      1,
    );
    expect(shifts.anchorSec).toBeCloseTo(live.anchorSec, 12);
    expect([...shifts.shiftSec.entries()].sort()).toEqual([...live.shiftSec.entries()].sort());
    expect(shifts.shiftSec.has("declined")).toBe(false); // falls to the anchor at draw time
  });

  it("legacy entries without a method wrap as chirp — parity with the restore path", () => {
    // One repeat interval (48 000) of lock ambiguity between two chirp
    // lags: the persisted composition must wrap exactly like the live one.
    const { shiftSec, anchorSec } = persistedAlignShifts(
      {
        a: { alignment: { lagSamples: 1_000, applied: true } },
        b: { alignment: { lagSamples: 49_400, applied: true } },
      },
      48_000,
      1,
    );
    expect(anchorSec).toBeCloseTo(400 / 48_000, 12);
    expect(shiftSec.get("b")).toBe(0);
    expect(shiftSec.get("a")).toBeCloseTo(400 / 48_000, 12);
  });

  it("a declined take composes the empty shifts — draws unshifted, honestly", () => {
    expect(
      persistedAlignShifts({ a: { alignment: { lagSamples: 100, applied: false } } }, 48_000, 1),
    ).toEqual({ shiftSec: new Map(), anchorSec: 0 });
    expect(persistedAlignShifts({}, 48_000, 1)).toEqual({ shiftSec: new Map(), anchorSec: 0 });
  });
});

describe("anchorAtSec (W7-A per-take playhead anchor)", () => {
  const spans: TakeAnchorSpan[] = [
    { startSec: 1, endSec: 5, anchorSec: 1.5 },
    { startSec: 7, endSec: 12, anchorSec: 0.4 },
  ];

  it("returns the containing take's anchor, span edges included", () => {
    expect(anchorAtSec(spans, 3)).toBe(1.5);
    expect(anchorAtSec(spans, 1)).toBe(1.5);
    expect(anchorAtSec(spans, 5)).toBe(1.5);
    expect(anchorAtSec(spans, 7.5)).toBe(0.4);
  });

  it("is 0 in the gaps, before the first take, and beyond the session", () => {
    expect(anchorAtSec(spans, 0.5)).toBe(0);
    expect(anchorAtSec(spans, 6)).toBe(0);
    expect(anchorAtSec(spans, 99)).toBe(0);
    expect(anchorAtSec([], 3)).toBe(0);
  });

  it("first match wins on (defensive) overlap — takes are laid out disjoint", () => {
    const overlapping: TakeAnchorSpan[] = [
      { startSec: 0, endSec: 10, anchorSec: 2 },
      { startSec: 5, endSec: 15, anchorSec: 3 },
    ];
    expect(anchorAtSec(overlapping, 7)).toBe(2);
  });
});

// ---- W6-B — session spans / look-ahead scheduler math ---------------------------

const SPANS: SessionTakeSpan[] = [
  { takeId: "t1", startSec: 1, endSec: 5 },
  { takeId: "t2", startSec: 7, endSec: 12 },
  { takeId: "t3", startSec: 20, endSec: 26 },
];

describe("session spans (W6-B)", () => {
  it("session start/end come from the outermost clip edges", () => {
    expect(sessionStartSec(SPANS)).toBe(1);
    expect(sessionEndSec(SPANS)).toBe(26);
    expect(sessionStartSec([])).toBe(0);
    expect(sessionEndSec([])).toBe(0);
  });

  it("mounts the takes intersecting the look-ahead window, nearest first", () => {
    // Playhead mid-take-1 with a 15 s window: t1 is already mounted, t2
    // starts inside the window, t3 (start 20 > 3+15) stays out.
    expect(takesToMount(SPANS, (id) => id === "t1", 3, 15)).toEqual(["t2"]);
    // Wider window reaches t3 too — start order, not span order.
    expect(
      takesToMount([SPANS[2] as SessionTakeSpan, SPANS[1] as SessionTakeSpan], () => false, 3, 30),
    ).toEqual(["t2", "t3"]);
  });

  it("a take already behind the playhead never mounts", () => {
    // Playhead in the t2..t3 gap: t1 ended, t2 ended at 12 < 13.
    expect(takesToMount(SPANS, () => false, 13, 15)).toEqual(["t3"]);
  });

  it("a seek into a gap mounts only the NEXT take, not the passed ones", () => {
    expect(takesToMount(SPANS, () => false, 5.5, 15)).toEqual(["t2", "t3"]);
    expect(takesToMount(SPANS, () => false, 5.5, 3)).toEqual(["t2"]);
  });

  it("releases mounted takes that ended beyond the margin, keeping the selected one", () => {
    // Playhead at 11 (inside t2): t1 ended at 5, margin 5 → 5 < 11−5.
    expect(takesToRelease(SPANS, ["t1", "t2"], 11, null, 5)).toEqual(["t1"]);
    // Not yet past the margin at 9.9.
    expect(takesToRelease(SPANS, ["t1", "t2"], 9.9, null, 5)).toEqual([]);
    // The selected take is never released, however far behind.
    expect(takesToRelease(SPANS, ["t1", "t2"], 25, "t1", 5)).toEqual(["t2"]);
  });

  it("releases mounted takes the plan no longer knows (deleted)", () => {
    expect(takesToRelease(SPANS, ["gone", "t2"], 8, null, 5)).toEqual(["gone"]);
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
