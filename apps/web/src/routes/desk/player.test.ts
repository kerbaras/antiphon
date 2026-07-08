// TakePlayer transport regressions (QA F12 / sweep QA-2 B1+B2).
//
// The engine under test is pure transport bookkeeping (startPos /
// startCtxTime / playing / notify), so the Web Audio graph is faked with
// inert nodes plus a manually advanced clock, and the meter loop is driven
// by flushing a stubbed requestAnimationFrame queue. Invariant pinned here:
// the LAST notified snapshot (what the desk UI renders) and the live
// engine (`position()`) must never disagree about where the playhead is.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PlayerSnapshot, TakePlayer } from "./player";

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

async function loadedPlayer(durationSec = 1): Promise<Loaded> {
  FakeAudioContext.nextBuffer = fakeBuffer(durationSec);
  const player = new TakePlayer();
  const snaps: PlayerSnapshot[] = [];
  player.subscribe((s) => snaps.push(s));
  const ok = await player.load("take-1", ["s1"], () => Promise.resolve(new ArrayBuffer(4)));
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
