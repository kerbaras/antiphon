// SessionPlayer transport regressions (QA F12 / sweep QA-2 B1+B2) and the
// F7 alignment surfaces (outcome derivation, verdict restore parity).
//
// The engine under test is pure transport bookkeeping (startPos /
// startCtxTime / playing / notify), so the Web Audio graph is faked with
// inert nodes plus a manually advanced clock, and the meter loop is driven
// by flushing a stubbed requestAnimationFrame queue. Invariant pinned here:
// the LAST notified snapshot (what the desk UI renders) and the live
// engine (`position()`) must never disagree about where the playhead is.
// The wasm module is mocked so align() runs deterministically in node.

import { align_content, find_chirp_offset, init as initWasm } from "@antiphon/core-wasm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PlayerSnapshot, SessionPlayer, type StoredTrackAlignment } from "./player";

vi.mock("@antiphon/core-wasm", () => ({
  init: vi.fn(() => Promise.resolve()),
  // Default: a measurable but low-confidence hit → align() declines.
  find_chirp_offset: vi.fn(() => JSON.stringify({ lagSamples: 120, confidence: 0.3 })),
  // Default: no shared content located → the chirp verdict stands (W4-B).
  align_content: vi.fn((): string | null => null),
  DriftEstimator: class {
    next_request_json(): string | null {
      return null; // no windows: estimate immediately
    }
    push_window(): void {
      // unused when next_request_json returns null
    }
    estimate_json(): string {
      return JSON.stringify({
        ratio: 1,
        ppm: 0,
        initialOffsetSamples: 0,
        confidence: 0,
        windowsUsed: 0,
        windowsTotal: 0,
      });
    }
    free(): void {
      // nothing to free in the mock
    }
  },
}));

// ---- minimal Web Audio fakes -------------------------------------------------

class FakeParam {
  value = 0;
  setTargetAtTime(): void {
    // parameter smoothing is irrelevant to transport state
  }
}

class FakeNode {
  connect(): void {
    // graph topology is irrelevant to transport state
  }
  disconnect(): void {
    // see connect()
  }
}

class FakeGainNode extends FakeNode {
  gain = new FakeParam();
}

class FakePannerNode extends FakeNode {
  pan = new FakeParam();
}

class FakeBiquadNode extends FakeNode {
  type = "";
  frequency = new FakeParam();
  gain = new FakeParam();
  Q = new FakeParam();
}

class FakeAnalyserNode extends FakeNode {
  fftSize = 2048;
  getFloatTimeDomainData(): void {
    // silence: level metering is not under test
  }
}

class FakeBufferSource extends FakeNode {
  /** Every start() call's args, in schedule order — the W7-B region tests
   * pin the exact (when, offset, duration) triples the engine issues. */
  static started: Array<{ when: number; offset: number; duration?: number }> = [];
  buffer: unknown = null;
  playbackRate = new FakeParam();
  start(when = 0, offset = 0, duration?: number): void {
    FakeBufferSource.started.push({
      when,
      offset,
      ...(duration !== undefined ? { duration } : {}),
    });
  }
  stop(): void {
    // see start()
  }
}

interface FakeBuffer {
  duration: number;
  sampleRate: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

function fakeBuffer(durationSec: number, sampleRate = 48_000): FakeBuffer {
  const length = Math.round(durationSec * sampleRate);
  const data = new Float32Array(length);
  return { duration: durationSec, sampleRate, length, getChannelData: () => data };
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static nextBuffer: FakeBuffer = fakeBuffer(1);
  currentTime = 0;
  destination = new FakeNode();
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createGain(): FakeGainNode {
    return new FakeGainNode();
  }
  createStereoPanner(): FakePannerNode {
    return new FakePannerNode();
  }
  createBiquadFilter(): FakeBiquadNode {
    return new FakeBiquadNode();
  }
  createAnalyser(): FakeAnalyserNode {
    return new FakeAnalyserNode();
  }
  createBufferSource(): FakeBufferSource {
    return new FakeBufferSource();
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  decodeAudioData(): Promise<FakeBuffer> {
    return Promise.resolve(FakeAudioContext.nextBuffer);
  }
}

// ---- rAF harness --------------------------------------------------------------

let frames: FrameRequestCallback[] = [];

/** Run every queued meter-loop frame exactly once (re-arms collect anew). */
function tickFrame(): void {
  const queue = frames;
  frames = [];
  for (const cb of queue) cb(performance.now());
}

beforeEach(() => {
  FakeAudioContext.instances = [];
  FakeBufferSource.started = [];
  frames = [];
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", (): void => {
    // queued frames self-cancel via the `playing` guard; ids never reused
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- helpers --------------------------------------------------------------------

interface Loaded {
  player: SessionPlayer;
  ctx: FakeAudioContext;
  snaps: PlayerSnapshot[];
}

async function loadedPlayer(durationSec = 1, streamIds: string[] = ["s1"]): Promise<Loaded> {
  FakeAudioContext.nextBuffer = fakeBuffer(durationSec);
  const player = new SessionPlayer();
  const snaps: PlayerSnapshot[] = [];
  player.subscribe((s) => snaps.push(s));
  const ok = await player.load("take-1", streamIds, () => Promise.resolve(new ArrayBuffer(4)));
  expect(ok).toBe(true);
  const ctx = FakeAudioContext.instances.at(-1);
  if (!ctx) throw new Error("player built no AudioContext");
  return { player, ctx, snaps };
}

/** Play from the top and run the meter loop through the end-of-take stop:
 * one mid-playback tick (a realistic recent meter notify, so the end tick's
 * throttled notify stays suppressed like it usually is live), then the tick
 * that crosses the end threshold. */
function playToEnd({ player, ctx }: Loaded): void {
  player.play();
  ctx.currentTime = 0.56; // mid-take (startCtxTime carries the 0.06 pre-roll)
  tickFrame();
  ctx.currentTime = 1.5; // past the 1 s take
  tickFrame();
}

// ---- F12 / B1: end-of-take auto-stop ------------------------------------------

describe("end-of-take auto-stop", () => {
  it("parks UI and engine at the take end, in agreement", async () => {
    const loaded = await loadedPlayer(1);
    const { player, snaps } = loaded;
    playToEnd(loaded);

    const last = snaps.at(-1);
    if (!last) throw new Error("no snapshot notified");
    expect(last.playing).toBe(false);
    // THE invariant: what the UI last heard is where the engine is.
    expect(last.positionSec).toBe(player.position());
    // Chosen semantics: park at the end, like a user pause on the last frame.
    expect(player.position()).toBeCloseTo(1, 6);
  });

  it("Play after the auto-stop restarts from the top with a live meter loop", async () => {
    const loaded = await loadedPlayer(1);
    const { player, ctx, snaps } = loaded;
    playToEnd(loaded);
    tickFrame(); // drain anything the stop path left queued
    expect(frames).toHaveLength(0);

    player.play();
    ctx.currentTime += 0.2;
    expect(player.snapshot().playing).toBe(true);
    // play() from the parked end restarts at 0 (its own >= duration guard).
    expect(player.position()).toBeCloseTo(0.14, 6);
    const last = snaps.at(-1);
    expect(last?.positionSec).toBe(0);
    // The meter loop re-armed — a stale raf id must not gate startMeterLoop,
    // or the playhead/meters freeze for the whole follow-up playback.
    expect(frames.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 45)); // clear the 40 ms notify throttle
    tickFrame();
    expect(snaps.at(-1)?.positionSec).toBeCloseTo(0.14, 6);
  });
});

// ---- B2: rapid play/pause pre-roll walk-back -----------------------------------

describe("rapid play/pause", () => {
  it("never walks the position backward through the 60 ms pre-roll", async () => {
    const { player, ctx } = await loadedPlayer(1);
    player.seek(0.5);
    for (let i = 0; i < 4; i++) {
      player.play();
      ctx.currentTime += 0.01; // pause well inside the 0.06 s pre-roll
      player.pause();
    }
    // Pre-fix each cycle lost up to 50 ms (0.5 → 0.45 → 0.40 → …).
    expect(player.position()).toBeCloseTo(0.5, 6);
  });

  it("holds the playhead during the pre-roll instead of regressing it", async () => {
    const { player, ctx } = await loadedPlayer(1);
    player.seek(0.5);
    player.play();
    ctx.currentTime += 0.02; // sources not started yet
    expect(player.position()).toBeCloseTo(0.5, 6);
    ctx.currentTime += 0.1; // now rolling: 0.06 pre-roll consumed, 0.06 played
    expect(player.position()).toBeCloseTo(0.56, 6);
  });
});

// ---- F7a: honest alignment outcome ---------------------------------------------

/** A confident, applied verdict pair (s2 lags s1 by 4800 samples = 0.1 s). */
function appliedEntries(): Record<string, StoredTrackAlignment> {
  return {
    s1: {
      alignment: { lagSamples: 0, confidence: 5, applied: true },
      drift: {
        ratio: 1,
        ppm: 0,
        initialOffsetSamples: 0,
        confidence: 1,
        windowsUsed: 0,
        applied: false,
        isReference: true,
      },
    },
    s2: {
      alignment: { lagSamples: 4_800, confidence: 5, applied: true },
      drift: {
        ratio: 1.0001,
        ppm: 100,
        initialOffsetSamples: 48,
        confidence: 2,
        windowsUsed: 10,
        applied: true,
        isReference: false,
      },
    },
  };
}

describe("alignment outcome (F7a)", () => {
  it("reads null before any run — never-ran is distinct", async () => {
    const { player } = await loadedPlayer(1, ["s1", "s2"]);
    expect(player.snapshot().alignmentOutcome).toBeNull();
  });

  it("declines visibly with the best measured confidence", async () => {
    const { player } = await loadedPlayer(1, ["s1", "s2"]);
    await player.align(true);
    const outcome = player.snapshot().alignmentOutcome;
    // Chirp-measured decline → the chirp bar (2.5) is the one it failed.
    expect(outcome).toEqual({ kind: "declined", confidence: 0.3, threshold: 2.5 });
    // Declined ≠ applied: no head-trim deltas are in force.
    expect(player.alignDeltas().size).toBe(0);
  });

  it("reports aligned with track count, the drift reference, and the method", async () => {
    const { player } = await loadedPlayer(1, ["s1", "s2"]);
    expect(player.restoreAlignment("take-1", appliedEntries())).toBe(true);
    expect(player.snapshot().alignmentOutcome).toEqual({
      kind: "aligned",
      trackCount: 2,
      referenceStreamId: "s1",
      method: "chirp",
    });
  });

  it("surfaces an align() crash as a failed outcome (not 'never ran')", async () => {
    const { player } = await loadedPlayer(1, ["s1", "s2"]);
    vi.mocked(find_chirp_offset).mockImplementationOnce(() => {
      throw new Error("wasm exploded");
    });
    await player.align(true); // must not reject — the queue stays alive
    expect(player.snapshot().alignmentOutcome).toEqual({
      kind: "failed",
      message: "wasm exploded",
    });
    expect(player.snapshot().aligning).toBe(false);
  });
});

// ---- W4-B: content-alignment fallback --------------------------------------------

describe("content-alignment fallback (W4-B)", () => {
  beforeEach(() => {
    vi.mocked(find_chirp_offset).mockClear();
    vi.mocked(align_content).mockClear();
  });

  it("aligns chirpless near-identical clips through content correlation", async () => {
    const { player } = await loadedPlayer(2, ["s1", "s2"]);
    // Chirp declines on both (default mock); content locates s2's stream
    // holding 4 800 samples MORE pre-roll than the reference s1.
    vi.mocked(align_content).mockReturnValueOnce(
      JSON.stringify({ lagSamples: 4_800, peak: 0.92, confidence: 6.1 }),
    );
    await player.align(true);
    expect(align_content).toHaveBeenCalledTimes(1);
    expect(player.snapshot().alignmentOutcome).toEqual({
      kind: "aligned",
      trackCount: 2,
      referenceStreamId: "s1",
      method: "content",
    });
    // Head-trim deltas flow through the SAME schedule math as chirp lags.
    expect([...player.alignDeltas().entries()].sort()).toEqual([
      ["s1", 0],
      ["s2", 4_800],
    ]);
    // The measured track and the anchored reference both carry the method
    // — persistence (F7b) rides on these exact fields.
    const tracks = player.snapshot().tracks;
    expect(tracks.find((t) => t.streamId === "s2")?.alignment).toEqual({
      lagSamples: 4_800,
      confidence: 6.1,
      applied: true,
      method: "content",
    });
    expect(tracks.find((t) => t.streamId === "s1")?.alignment).toEqual({
      lagSamples: 0,
      confidence: 6.1,
      applied: true,
      method: "content",
    });
  });

  it("exposes the visual shifts of the same verdict (W6-C): shift + delta = anchor", async () => {
    const { player } = await loadedPlayer(2, ["s1", "s2"]);
    vi.mocked(align_content).mockReturnValueOnce(
      JSON.stringify({ lagSamples: 4_800, peak: 0.92, confidence: 6.1 }),
    );
    await player.align(true);
    // s2 started 0.1 s earlier (4 800 samples more pre-roll): its box
    // stays put, s1's box shifts right by the trim it doesn't need — and
    // room-time zero (the playhead anchor) lands at the max trim.
    const { shiftSec, anchorSec } = player.alignShifts();
    expect(anchorSec).toBeCloseTo(0.1, 9);
    expect(shiftSec.get("s2")).toBe(0);
    expect(shiftSec.get("s1")).toBeCloseTo(0.1, 9);
    // What draws is what plays: shift + schedule delta = anchor, per stream.
    for (const [streamId, delta] of player.alignDeltas()) {
      expect((shiftSec.get(streamId) as number) + delta / 48_000).toBeCloseTo(anchorSec, 9);
    }
  });

  it("handles negative content offsets (the reference armed earlier)", async () => {
    const { player } = await loadedPlayer(2, ["s1", "s2"]);
    vi.mocked(align_content).mockReturnValueOnce(
      JSON.stringify({ lagSamples: -4_800, peak: 0.9, confidence: 5.0 }),
    );
    await player.align(true);
    // s2 holds LESS pre-roll: everyone else trims, s2 trims zero.
    expect([...player.alignDeltas().entries()].sort()).toEqual([
      ["s1", 4_800],
      ["s2", 0],
    ]);
  });

  it("declines honestly when content confidence is below the threshold", async () => {
    const { player } = await loadedPlayer(1, ["s1", "s2"]);
    vi.mocked(align_content).mockReturnValueOnce(
      JSON.stringify({ lagSamples: 4_800, peak: 0.4, confidence: 1.2 }),
    );
    await player.align(true);
    // Best measured confidence across BOTH methods (chirp 0.3, content 1.2)
    // — and the bar shown is the CONTENT one (2.75), matching the method
    // of that best measurement.
    expect(player.snapshot().alignmentOutcome).toEqual({
      kind: "declined",
      confidence: 1.2,
      threshold: 2.75,
    });
    expect(player.alignDeltas().size).toBe(0);
    // The reference is never anchored without an applied peer.
    const s1 = player.snapshot().tracks.find((t) => t.streamId === "s1");
    expect(s1?.alignment?.applied).toBe(false);
    expect(s1?.alignment?.method).toBe("chirp");
  });

  it("rescues chirp-declined tracks into the chirp anchor (mixed verdict)", async () => {
    const { player } = await loadedPlayer(2, ["s1", "s2", "s3"]);
    vi.mocked(find_chirp_offset)
      .mockReturnValueOnce(JSON.stringify({ lagSamples: 48_000, confidence: 5 }))
      .mockReturnValueOnce(JSON.stringify({ lagSamples: 48_400, confidence: 5 }))
      .mockReturnValueOnce(JSON.stringify({ lagSamples: 0, confidence: 0.3 }));
    // s3's content sits 500 samples deeper than the chirp reference s1:
    // its stored lag lands in the VIRTUAL chirp domain (48 000 + 500).
    vi.mocked(align_content).mockReturnValueOnce(
      JSON.stringify({ lagSamples: 500, peak: 0.9, confidence: 4.2 }),
    );
    await player.align(true);
    expect(align_content).toHaveBeenCalledTimes(1);
    expect(player.snapshot().alignmentOutcome).toEqual({
      kind: "aligned",
      trackCount: 3,
      referenceStreamId: "s1",
      method: "mixed",
    });
    expect([...player.alignDeltas().entries()].sort()).toEqual([
      ["s1", 0],
      ["s2", 400],
      ["s3", 500],
    ]);
  });

  it("never runs content correlation when the chirp placed every track", async () => {
    const { player } = await loadedPlayer(2, ["s1", "s2"]);
    vi.mocked(find_chirp_offset)
      .mockReturnValueOnce(JSON.stringify({ lagSamples: 48_000, confidence: 5 }))
      .mockReturnValueOnce(JSON.stringify({ lagSamples: 48_400, confidence: 5 }));
    await player.align(true);
    expect(align_content).not.toHaveBeenCalled();
    expect(player.snapshot().alignmentOutcome).toMatchObject({ kind: "aligned", method: "chirp" });
  });

  it("skips content entirely on a single-track take", async () => {
    const { player } = await loadedPlayer(2, ["s1"]);
    await player.align(true);
    expect(align_content).not.toHaveBeenCalled();
    expect(player.snapshot().alignmentOutcome).toEqual({
      kind: "declined",
      confidence: 0.3,
      threshold: 2.5,
    });
  });
});

// ---- W7-A: scoped (selection-aware) align ---------------------------------------
// The consistency invariant under test: a scoped run's fresh verdicts must
// land in the SAME virtual lag domain as the kept (out-of-scope) verdicts,
// so normalizeAlignDeltas over the mixed set reproduces every true pairwise
// offset — the audible residual between any two applied streams stays ≈ 0.

describe("scoped align (W7-A)", () => {
  beforeEach(() => {
    vi.mocked(find_chirp_offset).mockClear();
    vi.mocked(align_content).mockClear();
  });

  it("re-measures only the scope and chains onto the kept persisted reference", async () => {
    const { player } = await loadedPlayer(2, ["s1", "s2"]);
    expect(player.restoreAlignment("take-1", appliedEntries())).toBe(true);
    // Content places s2 100 samples past the kept reference s1 (chirp lag
    // 0 → virtual base 0): the fresh lag lands in the kept domain.
    vi.mocked(align_content).mockReturnValueOnce(
      JSON.stringify({ lagSamples: 100, peak: 0.9, confidence: 6.0 }),
    );
    await player.align(true, ["s2"]);
    // Only s2 was measured (one chirp probe, one content probe)…
    expect(find_chirp_offset).toHaveBeenCalledTimes(1);
    expect(align_content).toHaveBeenCalledTimes(1);
    const tracks = player.snapshot().tracks;
    // …s1's kept verdict is byte-identical to what restore applied…
    expect(tracks.find((t) => t.streamId === "s1")?.alignment).toEqual({
      lagSamples: 0,
      confidence: 5,
      applied: true,
      method: "chirp",
    });
    // …and s2's fresh content lag chains onto s1's virtual lag (0 + 100).
    expect(tracks.find((t) => t.streamId === "s2")?.alignment).toEqual({
      lagSamples: 100,
      confidence: 6.0,
      applied: true,
      method: "content",
    });
    expect([...player.alignDeltas().entries()].sort()).toEqual([
      ["s1", 0],
      ["s2", 100],
    ]);
    expect(player.snapshot().alignmentOutcome).toMatchObject({
      kind: "aligned",
      trackCount: 2,
      referenceStreamId: "s1",
      method: "mixed",
    });
  });

  it("falls to the longest kept applied anchor when the reference itself is in scope", async () => {
    const { player } = await loadedPlayer(2, ["s1", "s2"]);
    // Pure-content history: s1 was the anchored reference (lag 0), s2
    // locked on at 4 800 — both lags already live in the virtual domain.
    const entries: Record<string, StoredTrackAlignment> = {
      s1: {
        alignment: { lagSamples: 0, confidence: 5, applied: true, method: "content" },
        drift: {
          ratio: 1,
          ppm: 0,
          initialOffsetSamples: 0,
          confidence: 1,
          windowsUsed: 0,
          applied: false,
          isReference: true,
        },
      },
      s2: {
        alignment: { lagSamples: 4_800, confidence: 5, applied: true, method: "content" },
        drift: null,
      },
    };
    expect(player.restoreAlignment("take-1", entries)).toBe(true);
    // Re-measuring s1 against the kept s2: s1 holds 4 800 samples LESS
    // pre-roll, so its fresh lag = s2's stored lag (4 800) − 4 800 = 0.
    vi.mocked(align_content).mockReturnValueOnce(
      JSON.stringify({ lagSamples: -4_800, peak: 0.9, confidence: 5.5 }),
    );
    await player.align(true, ["s1"]);
    const tracks = player.snapshot().tracks;
    // The kept s2 verdict is untouched; the fresh s1 lag reproduces the
    // original domain exactly — the deltas match the pre-run state.
    expect(tracks.find((t) => t.streamId === "s2")?.alignment).toEqual({
      lagSamples: 4_800,
      confidence: 5,
      applied: true,
      method: "content",
    });
    expect(tracks.find((t) => t.streamId === "s1")?.alignment).toEqual({
      lagSamples: 0,
      confidence: 5.5,
      applied: true,
      method: "content",
    });
    expect([...player.alignDeltas().entries()].sort()).toEqual([
      ["s1", 0],
      ["s2", 4_800],
    ]);
  });

  it("widens to the whole take when no out-of-scope verdict exists to preserve", async () => {
    const { player } = await loadedPlayer(2, ["s1", "s2"]);
    vi.mocked(align_content).mockReturnValueOnce(
      JSON.stringify({ lagSamples: 4_800, peak: 0.92, confidence: 6.1 }),
    );
    // A never-aligned take: a scoped run has nothing to stay consistent
    // with, so it runs whole-take — first full measurement, no artificial
    // single-stream decline.
    await player.align(true, ["s2"]);
    expect(find_chirp_offset).toHaveBeenCalledTimes(2); // BOTH tracks probed
    expect(player.snapshot().alignmentOutcome).toEqual({
      kind: "aligned",
      trackCount: 2,
      referenceStreamId: "s1",
      method: "content",
    });
    expect([...player.alignDeltas().entries()].sort()).toEqual([
      ["s1", 0],
      ["s2", 4_800],
    ]);
  });

  it("declines honestly when only kept DECLINED verdicts exist — never fabricates", async () => {
    const { player } = await loadedPlayer(2, ["s1", "s2"]);
    await player.align(true); // both measured, both declined (mock defaults)
    vi.mocked(find_chirp_offset).mockClear();
    vi.mocked(align_content).mockClear();
    await player.align(true, ["s2"]);
    // s1's declined verdict is kept state (the verdict IS the state), so
    // the run stays scoped — but with no applied anchor and a one-stream
    // scope there is nothing to correlate against: honest decline.
    expect(find_chirp_offset).toHaveBeenCalledTimes(1);
    expect(align_content).not.toHaveBeenCalled();
    expect(player.snapshot().alignmentOutcome).toMatchObject({ kind: "declined" });
    expect(player.alignDeltas().size).toBe(0);
  });

  it("ignores unknown ids and no-ops on an empty effective scope", async () => {
    const { player } = await loadedPlayer(2, ["s1", "s2"]);
    await player.align(true, ["ghost"]);
    expect(find_chirp_offset).not.toHaveBeenCalled();
    expect(player.snapshot().alignmentOutcome).toBeNull();
  });

  // ---- the scoped-run domain guard (QA HIGH) ------------------------------------
  // A fresh chirp lag is a RAW sweep position; a pure-content kept domain
  // has an arbitrary origin (its reference anchored at lag 0). Mixing the
  // two raw would hand normalizeAlignDeltas a chirp wrap base the kept
  // content lags were never measured against — garbage pairwise offsets,
  // persisted and drawn. The guard demotes such hits and re-chains them
  // via content; kept chirp anchors (pure or mixed) keep fresh chirp hits
  // raw, because every chirp lag shares the sweep's absolute domain.

  /** QA's probe fixture: a persisted pure-content pair (s1 the anchored
   * reference at lag 0, s2 locked on at 4 800), s3 never measured. */
  function contentPairEntries(): Record<string, StoredTrackAlignment> {
    return {
      s1: {
        alignment: { lagSamples: 0, confidence: 5, applied: true, method: "content" },
        drift: {
          ratio: 1,
          ppm: 0,
          initialOffsetSamples: 0,
          confidence: 1,
          windowsUsed: 0,
          applied: false,
          isReference: true,
        },
      },
      s2: {
        alignment: { lagSamples: 4_800, confidence: 5, applied: true, method: "content" },
        drift: null,
      },
    };
  }

  it("demotes a fresh chirp hit over a pure-content kept domain and re-chains it via content (QA HIGH probe)", async () => {
    const { player } = await loadedPlayer(2, ["s1", "s2", "s3"]);
    expect(player.restoreAlignment("take-1", contentPairEntries())).toBe(true);
    // s3 holds a findable chirp at raw sweep position 250 000 (conf 6.0)
    // — an absolute-domain lag the kept content pair knows nothing about.
    vi.mocked(find_chirp_offset).mockReturnValueOnce(
      JSON.stringify({ lagSamples: 250_000, confidence: 6.0 }),
    );
    // Content places s3 100 samples past the kept reference s1.
    vi.mocked(align_content).mockReturnValueOnce(
      JSON.stringify({ lagSamples: 100, peak: 0.9, confidence: 5.0 }),
    );
    await player.align(true, ["s3"]);
    // The chirp hit did NOT stand in its raw domain: s3 carries a CONTENT
    // verdict chained onto the kept reference, and every pairwise offset
    // stays true — pre-fix this read {s1:0, s2:4800, s3:250000}, a 5.2 s
    // head-trim never measured against the kept pair.
    const s3 = player.snapshot().tracks.find((t) => t.streamId === "s3");
    expect(s3?.alignment).toEqual({
      lagSamples: 100,
      confidence: 5.0,
      applied: true,
      method: "content",
    });
    expect([...player.alignDeltas().entries()].sort()).toEqual([
      ["s1", 0],
      ["s2", 4_800],
      ["s3", 100],
    ]);
  });

  it("a demoted chirp hit content can't place stays honestly unaligned — never confidently torn", async () => {
    const { player } = await loadedPlayer(2, ["s1", "s2", "s3"]);
    expect(player.restoreAlignment("take-1", contentPairEntries())).toBe(true);
    vi.mocked(find_chirp_offset).mockReturnValueOnce(
      JSON.stringify({ lagSamples: 250_000, confidence: 6.0 }),
    );
    // align_content default mock: no shared content located → no chain.
    await player.align(true, ["s3"]);
    const s3 = player.snapshot().tracks.find((t) => t.streamId === "s3");
    // The measurement survives for diagnostics, unapplied — and the kept
    // pair's deltas are exactly what they were.
    expect(s3?.alignment).toEqual({
      lagSamples: 250_000,
      confidence: 6.0,
      applied: false,
      method: "chirp",
    });
    expect([...player.alignDeltas().entries()].sort()).toEqual([
      ["s1", 0],
      ["s2", 4_800],
    ]);
    expect(player.snapshot().alignmentOutcome).toMatchObject({
      kind: "aligned",
      trackCount: 2,
    });
  });

  it("kept chirp anchors keep a fresh chirp hit raw — one absolute sweep domain", async () => {
    const { player } = await loadedPlayer(2, ["s1", "s2", "s3"]);
    const entries: Record<string, StoredTrackAlignment> = {
      s1: {
        alignment: { lagSamples: 1_000, confidence: 5, applied: true, method: "chirp" },
        drift: {
          ratio: 1,
          ppm: 0,
          initialOffsetSamples: 0,
          confidence: 1,
          windowsUsed: 0,
          applied: false,
          isReference: true,
        },
      },
      s2: {
        alignment: { lagSamples: 1_400, confidence: 5, applied: true, method: "chirp" },
        drift: null,
      },
    };
    expect(player.restoreAlignment("take-1", entries)).toBe(true);
    vi.mocked(find_chirp_offset).mockReturnValueOnce(
      JSON.stringify({ lagSamples: 1_900, confidence: 5.0 }),
    );
    await player.align(true, ["s3"]);
    // No demotion, no content probe: chirp lags interoperate raw.
    expect(align_content).not.toHaveBeenCalled();
    expect([...player.alignDeltas().entries()].sort()).toEqual([
      ["s1", 0],
      ["s2", 400],
      ["s3", 900],
    ]);
  });

  it("kept MIXED anchors keep a fresh chirp hit raw too — the kept content lag was chained onto the chirp domain", async () => {
    const { player } = await loadedPlayer(2, ["s1", "s2", "s3"]);
    const entries: Record<string, StoredTrackAlignment> = {
      s1: {
        alignment: { lagSamples: 48_000, confidence: 5, applied: true, method: "chirp" },
        drift: {
          ratio: 1,
          ppm: 0,
          initialOffsetSamples: 0,
          confidence: 1,
          windowsUsed: 0,
          applied: false,
          isReference: true,
        },
      },
      s2: {
        // Content lag in the VIRTUAL chirp domain (48 000 + 500), exactly
        // how alignContentFallback stores a rescued straggler.
        alignment: { lagSamples: 48_500, confidence: 4, applied: true, method: "content" },
        drift: null,
      },
    };
    expect(player.restoreAlignment("take-1", entries)).toBe(true);
    vi.mocked(find_chirp_offset).mockReturnValueOnce(
      JSON.stringify({ lagSamples: 48_200, confidence: 5.0 }),
    );
    await player.align(true, ["s3"]);
    expect(align_content).not.toHaveBeenCalled();
    expect([...player.alignDeltas().entries()].sort()).toEqual([
      ["s1", 0],
      ["s2", 500],
      ["s3", 200],
    ]);
  });
});

// ---- W6-B: session transport — plan, boundary handoff, mount window ---------------

/** Two-take session plan: take-1 at [1, 2), take-2 at [4, 5). */
function twoTakePlan() {
  return [
    {
      takeId: "take-1",
      streams: [{ streamId: "s1", channelKey: "lane-a", clipStartSec: 1, declaredDurationSec: 1 }],
    },
    {
      takeId: "take-2",
      streams: [{ streamId: "s2", channelKey: "lane-a", clipStartSec: 4, declaredDurationSec: 1 }],
    },
  ];
}

describe("session transport (W6-B)", () => {
  it("duration is the SESSION end; the loaded take keeps its own span", async () => {
    FakeAudioContext.nextBuffer = fakeBuffer(1);
    const player = new SessionPlayer();
    player.setSessionPlan(twoTakePlan());
    const ok = await player.load("take-1", ["s1"], () => Promise.resolve(new ArrayBuffer(4)));
    expect(ok).toBe(true);
    // Transport spans the whole session (last take's declared end)…
    expect(player.duration()).toBeCloseTo(5, 6);
    // …while the take-scoped surfaces keep the loaded take's span.
    expect(player.snapshot().takeDurationSec).toBeCloseTo(1, 6);
    // Loading parks the transport at the take's arrangement base — the
    // spot the old take-local domain called position 0.
    expect(player.position()).toBeCloseTo(1, 6);
    // renderModel stays take-local: the clip delay rebases onto the head.
    const model = player.renderModel();
    expect(model?.durationSec).toBeCloseTo(1, 6);
    expect(model?.tracks[0]?.timing.clipDelaySec).toBeCloseTo(0, 9);
  });

  it("plays THROUGH a take boundary: look-ahead mounts the next take, one handoff schedule, no end-stop until the session end", async () => {
    FakeAudioContext.nextBuffer = fakeBuffer(1);
    const player = new SessionPlayer();
    player.setSessionPlan(twoTakePlan());
    await player.load("take-1", ["s1"], () => Promise.resolve(new ArrayBuffer(4)));
    const assembled: string[] = [];
    player.setSessionSources({
      assemble: (takeId, streamId) => {
        assembled.push(`${takeId}:${streamId}`);
        return Promise.resolve(new ArrayBuffer(4));
      },
      storedAlignment: () => null,
    });
    const ctx = FakeAudioContext.instances.at(-1) as FakeAudioContext;

    player.play(1);
    expect(player.snapshot().scheduleCount).toBe(1);
    // play() kicked the look-ahead: take-2 decodes and mounts in the
    // background, then hands off onto the running clock — exactly ONE
    // extra schedule pass (the honest evolution of the W4-A invariant).
    await vi.waitFor(() => {
      expect(player.snapshot().mountedTakeIds.sort()).toEqual(["take-1", "take-2"]);
    });
    expect(assembled).toEqual(["take-2:s2"]);
    expect(player.snapshot().scheduleCount).toBe(2);

    // Past take-1's end (2 s) the transport keeps rolling — the gap is
    // playable silence, not an end-stop.
    ctx.currentTime = 1.5 + 0.06; // position ≈ 2.5, inside the gap
    tickFrame();
    expect(player.snapshot().playing).toBe(true);
    expect(player.position()).toBeCloseTo(2.5, 2);

    // The end-stop fires at the SESSION end (5 s), parking there.
    ctx.currentTime = 4.2 + 0.06;
    tickFrame();
    ctx.currentTime = 5.3 + 0.06;
    tickFrame();
    expect(player.snapshot().playing).toBe(false);
    expect(player.position()).toBeCloseTo(5, 6);
  });

  it("a resume with the window already mounted schedules everything in ONE pass", async () => {
    FakeAudioContext.nextBuffer = fakeBuffer(1);
    const player = new SessionPlayer();
    player.setSessionPlan(twoTakePlan());
    await player.load("take-1", ["s1"], () => Promise.resolve(new ArrayBuffer(4)));
    player.setSessionSources({
      assemble: () => Promise.resolve(new ArrayBuffer(4)),
      storedAlignment: () => null,
    });
    player.play(1);
    await vi.waitFor(() => {
      expect(player.snapshot().mountedTakeIds).toHaveLength(2);
    });
    player.pause();
    player.play(3.5);
    // Both takes' sources plan in the single schedule() pass (future
    // starts via planSource whenSec) — no per-take churn on resume.
    expect(player.snapshot().scheduleCount).toBe(1);
  });

  it("promotes an already-mounted take on load — no re-decode, parked at its base", async () => {
    FakeAudioContext.nextBuffer = fakeBuffer(1);
    const player = new SessionPlayer();
    player.setSessionPlan(twoTakePlan());
    await player.load("take-1", ["s1"], () => Promise.resolve(new ArrayBuffer(4)));
    player.setSessionSources({
      assemble: () => Promise.resolve(new ArrayBuffer(4)),
      storedAlignment: () => ({
        s2: { alignment: { lagSamples: 0, confidence: 5, applied: true }, drift: null },
      }),
    });
    player.play(1);
    await vi.waitFor(() => {
      expect(player.snapshot().mountedTakeIds).toHaveLength(2);
    });
    player.pause();
    // Explicit selection of the look-ahead-mounted take: the load path
    // promotes WITHOUT calling assemble again…
    const assemble = vi.fn(() => Promise.resolve(new ArrayBuffer(4)));
    const ok = await player.load("take-2", ["s2"], assemble);
    expect(ok).toBe(true);
    expect(assemble).not.toHaveBeenCalled();
    expect(player.snapshot().loadedTakeId).toBe("take-2");
    // …parks at take-2's base, releases take-1's mount, and carries the
    // persisted verdict the mount applied (F7b through the window path).
    expect(player.position()).toBeCloseTo(4, 6);
    expect(player.snapshot().mountedTakeIds).toEqual(["take-2"]);
    expect(player.snapshot().tracks[0]?.alignment?.applied).toBe(true);
    // W6-C seam: the desk's parked pin clears only when the verdict has
    // SETTLED (!aligning && outcome !== null). A promoted take must
    // satisfy that gate immediately — its tracks carry the verdict the
    // mount applied, so the outcome derives non-null with no run in
    // flight (a promote that read "never ran" would park the pin forever).
    expect(player.snapshot().aligning).toBe(false);
    expect(player.snapshot().alignmentOutcome).not.toBeNull();
    // And the follow-up align() the load queue always issues is a no-op
    // against the restored verdict — no re-measure, still settled.
    await player.align();
    expect(player.snapshot().aligning).toBe(false);
    expect(player.snapshot().alignmentOutcome).not.toBeNull();
  });

  it("a seek re-points the mount window immediately — paused seeks pre-mount (QA M-3)", async () => {
    FakeAudioContext.nextBuffer = fakeBuffer(1);
    const player = new SessionPlayer();
    player.setSessionPlan(twoTakePlan());
    await player.load("take-1", ["s1"], () => Promise.resolve(new ArrayBuffer(4)));
    player.setSessionSources({
      assemble: () => Promise.resolve(new ArrayBuffer(4)),
      storedAlignment: () => null,
    });
    // PAUSED seek into unmounted take-2's span: the kick decodes it now —
    // no meter loop is running to poll the window — so the next play
    // starts complete at the target, not ~0.5 s into the take.
    player.seek(4.2);
    expect(player.snapshot().playing).toBe(false);
    await vi.waitFor(() => {
      expect(player.snapshot().mountedTakeIds.sort()).toEqual(["take-1", "take-2"]);
    });
    expect(player.snapshot().playing).toBe(false);
    // Resume covers the whole mounted window in ONE schedule pass.
    player.play();
    expect(player.snapshot().scheduleCount).toBe(1);
    expect(player.position()).toBeCloseTo(4.2, 6);
  });

  it("releases a passed take once safely behind the playhead (not the selected one)", async () => {
    FakeAudioContext.nextBuffer = fakeBuffer(1);
    const player = new SessionPlayer();
    const plan = [
      ...twoTakePlan(),
      {
        takeId: "take-3",
        streams: [
          { streamId: "s3", channelKey: "lane-a", clipStartSec: 20, declaredDurationSec: 1 },
        ],
      },
    ];
    player.setSessionPlan(plan);
    await player.load("take-3", ["s3"], () => Promise.resolve(new ArrayBuffer(4)));
    player.setSessionSources({
      assemble: () => Promise.resolve(new ArrayBuffer(4)),
      storedAlignment: () => null,
    });
    player.play(1); // mounts take-1's neighbourhood
    await vi.waitFor(() => {
      expect(player.snapshot().mountedTakeIds).toContain("take-1");
    });
    player.pause();
    // Re-play far past take-1 (end 2, margin 5): play()'s look-ahead kick
    // releases it; the SELECTED take-3 stays mounted whatever the position.
    player.play(12);
    await vi.waitFor(() => {
      expect(player.snapshot().mountedTakeIds).not.toContain("take-1");
    });
    expect(player.snapshot().mountedTakeIds).toContain("take-3");
  });

  it("re-publishing an identical plan is a strict no-op (no notify, no re-schedule)", async () => {
    FakeAudioContext.nextBuffer = fakeBuffer(1);
    const player = new SessionPlayer();
    player.setSessionPlan(twoTakePlan());
    await player.load("take-1", ["s1"], () => Promise.resolve(new ArrayBuffer(4)));
    const snaps: PlayerSnapshot[] = [];
    player.subscribe((s) => snaps.push(s));
    const before = snaps.length;
    player.setSessionPlan(twoTakePlan()); // fresh arrays, same content
    expect(snaps.length).toBe(before);
    // A clip MOVE on the mounted take re-schedules a rolling transport.
    player.play(1);
    const scheduled = player.snapshot().scheduleCount;
    const movedPlan = twoTakePlan();
    const movedStream = (movedPlan[0] as { streams: Array<{ clipStartSec: number }> })
      .streams[0] as { clipStartSec: number };
    movedStream.clipStartSec = 1.5;
    player.setSessionPlan(movedPlan);
    expect(player.snapshot().scheduleCount).toBe(scheduled + 1);
    expect(player.duration()).toBeCloseTo(5, 6);
  });
});

// ---- W7-B: clip regions — schedule fan-out, stops, plan edits ---------------------

describe("clip regions (W7-B)", () => {
  /** twoTakePlan with take-1's one stream split at source 0.4 s. */
  function splitPlan() {
    const plan = twoTakePlan();
    (plan[0] as { streams: Array<Record<string, unknown>> }).streams[0] = {
      streamId: "s1",
      channelKey: "lane-a",
      clipStartSec: 1,
      declaredDurationSec: 1,
      regions: [
        { id: "s1", startSec: 1, sourceOffsetSec: 0, durationSec: 0.4 },
        { id: "r2", startSec: 1.4, sourceOffsetSec: 0.4, durationSec: 0.6 },
      ],
    };
    return plan;
  }

  it("zero splits: the schedule issues the verbatim 2-arg start (parity pin)", async () => {
    FakeAudioContext.nextBuffer = fakeBuffer(1);
    const player = new SessionPlayer();
    player.setSessionPlan(twoTakePlan());
    await player.load("take-1", ["s1"], () => Promise.resolve(new ArrayBuffer(4)));
    player.play(1);
    expect(FakeBufferSource.started).toEqual([{ when: 0.06, offset: 0 }]);
    expect(player.snapshot().scheduleCount).toBe(1);
  });

  it("a split stream fans out one source per region, stopped at each region's end", async () => {
    FakeAudioContext.nextBuffer = fakeBuffer(1);
    const player = new SessionPlayer();
    player.setSessionPlan(splitPlan());
    await player.load("take-1", ["s1"], () => Promise.resolve(new ArrayBuffer(4)));
    player.play(1);
    // ONE schedule pass covers both pieces; the duration args stop each
    // source exactly at its region's boundary, and the second piece starts
    // on the same clock grid at the sample the first stopped on.
    expect(player.snapshot().scheduleCount).toBe(1);
    expect(FakeBufferSource.started).toEqual([
      { when: 0.06, offset: 0, duration: expect.closeTo(0.4, 9) },
      {
        when: expect.closeTo(0.46, 9),
        offset: expect.closeTo(0.4, 9),
        duration: expect.closeTo(0.6, 9),
      },
    ]);
    // The abutting split leaves the take's extent exactly as uncut.
    expect(player.snapshot().takeDurationSec).toBeCloseTo(1, 9);
    expect(player.duration()).toBeCloseTo(5, 9);
  });

  it("mid-region seek plays the remainder of the piece, then the next", async () => {
    FakeAudioContext.nextBuffer = fakeBuffer(1);
    const player = new SessionPlayer();
    player.setSessionPlan(splitPlan());
    await player.load("take-1", ["s1"], () => Promise.resolve(new ArrayBuffer(4)));
    player.play(1.2); // 0.2 s into the left piece
    expect(FakeBufferSource.started).toEqual([
      { when: 0.06, offset: expect.closeTo(0.2, 9), duration: expect.closeTo(0.2, 9) },
      {
        when: expect.closeTo(0.26, 9),
        offset: expect.closeTo(0.4, 9),
        duration: expect.closeTo(0.6, 9),
      },
    ]);
  });

  it("a region edit (split/drag) on the mounted take re-schedules a rolling transport; dragged pieces stretch the session", async () => {
    FakeAudioContext.nextBuffer = fakeBuffer(1);
    const player = new SessionPlayer();
    player.setSessionPlan(twoTakePlan());
    await player.load("take-1", ["s1"], () => Promise.resolve(new ArrayBuffer(4)));
    player.play(1);
    const before = player.snapshot().scheduleCount;
    // The desk writes a split to the doc → the plan republishes with
    // regions: the audible consequence lands NOW, like clip moves.
    player.setSessionPlan(splitPlan());
    expect(player.snapshot().scheduleCount).toBe(before + 1);
    // Dragging the right piece past the session end stretches duration().
    const dragged = splitPlan();
    const s1 = (dragged[0] as { streams: Array<{ regions?: Array<{ startSec: number }> }> })
      .streams[0] as { regions: Array<{ startSec: number }> };
    (s1.regions[1] as { startSec: number }).startSec = 9;
    player.setSessionPlan(dragged);
    expect(player.duration()).toBeCloseTo(9.6, 9);
    // Equal region content re-published is a strict no-op.
    const count = player.snapshot().scheduleCount;
    player.setSessionPlan(dragged.map((p) => ({ ...p, streams: [...p.streams] })));
    expect(player.snapshot().scheduleCount).toBe(count);
  });

  it("renderModel rebases regions onto the take-local timeline", async () => {
    FakeAudioContext.nextBuffer = fakeBuffer(1);
    const player = new SessionPlayer();
    player.setSessionPlan(splitPlan());
    await player.load("take-1", ["s1"], () => Promise.resolve(new ArrayBuffer(4)));
    const model = player.renderModel();
    expect(model?.tracks[0]?.regions).toEqual([
      { id: "s1", startSec: 0, sourceOffsetSec: 0, durationSec: 0.4 },
      { id: "r2", startSec: expect.closeTo(0.4, 9), sourceOffsetSec: 0.4, durationSec: 0.6 },
    ]);
    // An unsplit model keeps regions absent — the whole-stream render path.
    player.setSessionPlan(twoTakePlan());
    expect(player.renderModel()?.tracks[0]?.regions).toBeUndefined();
  });
});

// ---- F7b: verdict restore — schedule parity --------------------------------------

describe("alignment restore (F7b)", () => {
  it("reapplies persisted verdicts into the exact schedule math", async () => {
    const { player } = await loadedPlayer(2, ["s1", "s2"]);
    expect(player.restoreAlignment("take-1", appliedEntries())).toBe(true);

    // Head-trim deltas match a live align() of the same lags.
    expect([...player.alignDeltas().entries()].sort()).toEqual([
      ["s1", 0],
      ["s2", 4_800],
    ]);

    // renderModel timing (the SAME TrackTiming playback schedules with —
    // planSource parity by construction): chirp trim + drift residual.
    const model = player.renderModel();
    const t1 = model?.tracks.find((t) => t.streamId === "s1");
    const t2 = model?.tracks.find((t) => t.streamId === "s2");
    expect(t1?.timing.headSec).toBeCloseTo(0, 9);
    expect(t1?.timing.ratio).toBe(1);
    expect(t2?.timing.headSec).toBeCloseTo((4_800 + 48) / 48_000, 9);
    expect(t2?.timing.ratio).toBeCloseTo(1.0001, 9);

    // Duration reflects the trimmed head of the later-lag track.
    expect(player.duration()).toBeCloseTo(2, 6);
  });

  it("is idempotent — an equal restore changes nothing", async () => {
    const { player } = await loadedPlayer(2, ["s1", "s2"]);
    expect(player.restoreAlignment("take-1", appliedEntries())).toBe(true);
    expect(player.restoreAlignment("take-1", appliedEntries())).toBe(false);
  });

  it("ignores verdicts for a different take", async () => {
    const { player } = await loadedPlayer(2, ["s1", "s2"]);
    expect(player.restoreAlignment("other-take", appliedEntries())).toBe(false);
    expect(player.snapshot().alignmentOutcome).toBeNull();
  });

  it("re-schedules a rolling transport from the same position", async () => {
    const { player, ctx } = await loadedPlayer(2, ["s1", "s2"]);
    player.play(0.5);
    ctx.currentTime += 0.2;
    const before = player.snapshot().scheduleCount;
    expect(player.restoreAlignment("take-1", appliedEntries())).toBe(true);
    expect(player.snapshot().playing).toBe(true);
    expect(player.snapshot().scheduleCount).toBe(before + 1);
    // Restored tracks satisfy align()'s idempotence: no re-measure.
    vi.mocked(find_chirp_offset).mockClear();
    await player.align();
    expect(find_chirp_offset).not.toHaveBeenCalled();
  });

  it("satisfies align() idempotence after a declined restore too", async () => {
    const { player } = await loadedPlayer(1, ["s1", "s2"]);
    const declined: Record<string, StoredTrackAlignment> = {
      s1: { alignment: { lagSamples: 120, confidence: 0.3, applied: false }, drift: null },
      s2: { alignment: { lagSamples: 120, confidence: 0.3, applied: false }, drift: null },
    };
    expect(player.restoreAlignment("take-1", declined)).toBe(true);
    // Restored legacy entries normalize to chirp → the chirp bar shows.
    expect(player.snapshot().alignmentOutcome).toEqual({
      kind: "declined",
      confidence: 0.3,
      threshold: 2.5,
    });
    vi.mocked(find_chirp_offset).mockClear();
    await player.align(); // non-force: the restored verdict stands
    expect(find_chirp_offset).not.toHaveBeenCalled();
    expect(initWasm).toBeDefined(); // mock module wired (sanity)
  });
});
