// TakePlayer transport regressions (QA F12 / sweep QA-2 B1+B2) and the
// F7 alignment surfaces (outcome derivation, verdict restore parity).
//
// The engine under test is pure transport bookkeeping (startPos /
// startCtxTime / playing / notify), so the Web Audio graph is faked with
// inert nodes plus a manually advanced clock, and the meter loop is driven
// by flushing a stubbed requestAnimationFrame queue. Invariant pinned here:
// the LAST notified snapshot (what the desk UI renders) and the live
// engine (`position()`) must never disagree about where the playhead is.
// The wasm module is mocked so align() runs deterministically in node.

import { find_chirp_offset, init as initWasm } from "@antiphon/core-wasm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PlayerSnapshot, type StoredTrackAlignment, TakePlayer } from "./player";

vi.mock("@antiphon/core-wasm", () => ({
  init: vi.fn(() => Promise.resolve()),
  // Default: a measurable but low-confidence hit → align() declines.
  find_chirp_offset: vi.fn(() => JSON.stringify({ lagSamples: 120, confidence: 0.3 })),
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
  buffer: unknown = null;
  playbackRate = new FakeParam();
  start(): void {
    // scheduling side effects are not under test
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
  player: TakePlayer;
  ctx: FakeAudioContext;
  snaps: PlayerSnapshot[];
}

async function loadedPlayer(durationSec = 1, streamIds: string[] = ["s1"]): Promise<Loaded> {
  FakeAudioContext.nextBuffer = fakeBuffer(durationSec);
  const player = new TakePlayer();
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
    expect(outcome).toEqual({ kind: "declined", confidence: 0.3 });
    // Declined ≠ applied: no head-trim deltas are in force.
    expect(player.alignDeltas().size).toBe(0);
  });

  it("reports aligned with track count and the drift reference", async () => {
    const { player } = await loadedPlayer(1, ["s1", "s2"]);
    expect(player.restoreAlignment("take-1", appliedEntries())).toBe(true);
    expect(player.snapshot().alignmentOutcome).toEqual({
      kind: "aligned",
      trackCount: 2,
      referenceStreamId: "s1",
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
    expect(player.snapshot().alignmentOutcome).toEqual({ kind: "declined", confidence: 0.3 });
    vi.mocked(find_chirp_offset).mockClear();
    await player.align(); // non-force: the restored verdict stands
    expect(find_chirp_offset).not.toHaveBeenCalled();
    expect(initWasm).toBeDefined(); // mock module wired (sanity)
  });
});
