// Offline master/stems render (W2-A): the take through an
// OfflineAudioContext instead of the speakers. Playback parity is
// structural, not re-derived: the player hands over its decoded buffers
// plus the exact TrackTiming it schedules live sources with, and sources
// are planned through the same timeline-math.planSource — chirp head-trim,
// drift ratio as AudioBufferSourceNode.playbackRate (honored offline), and
// clip delays behave identically in both paths. Stored audio is never
// mutated (RFC §13): buffers are only ever read by source nodes.
//
// Output rate is a fixed 48 kHz: capture records 48 kHz FLAC (the take's
// native rate). The player's buffers carry whatever rate the desk's output
// device runs at (decodeAudioData resamples to the AudioContext rate) — a
// device artifact, not a property of the take. The offline context
// resamples sources to 48 kHz exactly like live playback resamples to the
// device rate, so exports are device-independent.

import { createEqChain, type EqState } from "./eq";
import { planSource, type RenderRange, resolveRange, type TrackTiming } from "./timeline-math";

export const RENDER_SAMPLE_RATE = 48_000;

export interface RenderTrackModel {
  streamId: string;
  /** Mixer lane (performer) the track plays through. */
  channelKey: string;
  /** Decoded stream audio — read-only, shared with the player. */
  buffer: AudioBuffer;
  /** Alignment/drift/arrangement timing, straight from the player. */
  timing: TrackTiming;
  /** Resolved audible strip gain (linear; mute/solo already folded to 0). */
  gain: number;
  /** Strip pan, −1 (L) .. +1 (R). */
  pan: number;
  /** Strip 3-band EQ (bypass included) — built through the same
   * createEqChain live monitoring uses. */
  eq: EqState;
}

/** Everything an export needs, snapshotted from the player at render time
 * (TakePlayer.renderModel). */
export interface RenderModel {
  takeId: string;
  /** Whole-take room-timeline length (player.duration()). */
  durationSec: number;
  masterGain: number;
  masterPan: number;
  masterEq: EqState;
  tracks: RenderTrackModel[];
}

export interface Stem {
  streamId: string;
  channelKey: string;
  buffer: AudioBuffer;
}

/** Master mixdown: 48 kHz stereo, exactly what monitoring plays — per-track
 * EQ/gain/pan/mute/solo, master EQ/gain/pan, alignment and drift correction
 * all applied. `range` selects a slice of the take's room timeline (the
 * player.position() domain) for W2-B marker renders; omitted = whole take. */
export async function renderMaster(model: RenderModel, range?: RenderRange): Promise<AudioBuffer> {
  const { startSec, endSec } = resolveRange(model.durationSec, range);
  const ctx = new OfflineAudioContext(
    2,
    Math.max(1, Math.round((endSec - startSec) * RENDER_SAMPLE_RATE)),
    RENDER_SAMPLE_RATE,
  );
  // Mirror the playback graph: track EQ → gain → pan → master EQ → master
  // gain → master pan. Bypassed EQs are omitted outright — the render of a
  // bypassed strip must equal the render of a strip with no EQ at all,
  // exactly like the player's true-bypass edge swap. (The player's unity
  // input/bus nodes and analysers are wiring/metering conveniences —
  // acoustically transparent, so they have no offline counterpart.)
  const master = ctx.createGain();
  master.gain.value = model.masterGain;
  const masterPanner = ctx.createStereoPanner();
  masterPanner.pan.value = model.masterPan;
  master.connect(masterPanner);
  masterPanner.connect(ctx.destination);
  let bus: AudioNode = master;
  if (!model.masterEq.bypassed) {
    const masterEq = createEqChain(ctx, model.masterEq);
    masterEq.high.connect(master);
    bus = masterEq.low;
  }
  for (const track of model.tracks) {
    const gain = ctx.createGain();
    gain.gain.value = track.gain;
    const panner = ctx.createStereoPanner();
    panner.pan.value = track.pan;
    gain.connect(panner);
    panner.connect(bus);
    let stripInput: AudioNode = gain;
    if (!track.eq.bypassed) {
      const eq = createEqChain(ctx, track.eq);
      eq.high.connect(gain);
      stripInput = eq.low;
    }
    startSource(ctx, track, startSec, stripInput);
  }
  return ctx.startRendering();
}

/** One mono stem per track, all exactly the range's length so lanes line
 * up at 0 when imported into a DAW. Deliberately PRE-mix: only the
 * room-clock mapping (chirp alignment + drift correction + clip delay) is
 * baked — that is what makes lanes line up and cannot be reproduced
 * downstream. Strip gain/pan/mute/solo/EQ are NOT baked: stems are source
 * material, and mixer moves (EQ included) stay editable in the importing
 * DAW (the mix itself ships as the master WAV). */
export async function renderStems(model: RenderModel, range?: RenderRange): Promise<Stem[]> {
  const { startSec, endSec } = resolveRange(model.durationSec, range);
  const length = Math.max(1, Math.round((endSec - startSec) * RENDER_SAMPLE_RATE));
  const stems: Stem[] = [];
  for (const track of model.tracks) {
    // OfflineAudioContext.startRendering is one-shot: one context per stem.
    const ctx = new OfflineAudioContext(1, length, RENDER_SAMPLE_RATE);
    startSource(ctx, track, startSec, ctx.destination);
    stems.push({
      streamId: track.streamId,
      channelKey: track.channelKey,
      buffer: await ctx.startRendering(),
    });
  }
  return stems;
}

/** Schedule one track into an offline graph — the same plan live playback
 * uses, with the context origin standing in for `currentTime + lead`. */
function startSource(
  ctx: OfflineAudioContext,
  track: RenderTrackModel,
  fromSec: number,
  destination: AudioNode,
): void {
  const plan = planSource(track.timing, fromSec);
  if (!plan) return;
  const source = ctx.createBufferSource();
  source.buffer = track.buffer;
  source.playbackRate.value = track.timing.ratio;
  source.connect(destination);
  source.start(plan.whenSec, plan.offsetSec);
}
