// Offline master/stems render. Playback parity is structural: sources are
// planned through the same timeline-math planners live playback uses, on
// the player's own buffers (read-only — stored audio is never mutated).
//
// Output is fixed 48 kHz (capture's native rate): the player's buffers
// carry the output device's rate — a device artifact — and the offline
// context resamples exactly like live playback, so exports are
// device-independent.

import { createEqChain, type EqState } from "./eq";
import {
  planRegionSource,
  planSource,
  type RegionSpan,
  type RenderRange,
  resolveRange,
  type TrackTiming,
} from "./timeline-math";

export const RENDER_SAMPLE_RATE = 48_000;

export interface RenderTrackModel {
  streamId: string;
  /** Mixer lane (performer) the track plays through. */
  channelKey: string;
  /** Decoded stream audio — read-only, shared with the player. */
  buffer: AudioBuffer;
  /** Alignment/drift/arrangement timing, straight from the player. */
  timing: TrackTiming;
  /** Split regions, rebased to the model's take-local timeline by the
   * player. Absent = never split (the whole-stream schedule path). */
  regions?: RegionSpan[];
  /** Resolved audible strip gain (linear; mute/solo already folded to 0). */
  gain: number;
  /** Strip pan, −1 (L) .. +1 (R). */
  pan: number;
  /** Strip 3-band EQ (bypass included) — built through the same
   * createEqChain live monitoring uses. */
  eq: EqState;
}

/** Everything an export needs, snapshotted from the player at render time
 * (SessionPlayer.renderModel). */
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

/** Master mixdown: 48 kHz stereo, exactly what monitoring plays — strip and
 * master EQ/gain/pan, mute/solo, alignment and drift correction all applied.
 * `range` selects a slice of the take's room timeline; omitted = whole take. */
export async function renderMaster(model: RenderModel, range?: RenderRange): Promise<AudioBuffer> {
  const { startSec, endSec } = resolveRange(model.durationSec, range);
  const ctx = new OfflineAudioContext(
    2,
    Math.max(1, Math.round((endSec - startSec) * RENDER_SAMPLE_RATE)),
    RENDER_SAMPLE_RATE,
  );
  // Mirror the playback graph: track EQ → gain → pan → master EQ → master
  // gain → master pan. Bypassed EQs are omitted outright, matching the
  // player's true-bypass edge swap; unity/analyser nodes have no counterpart.
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

/** One mono stem per track, all exactly the range's length so lanes line up
 * at 0 in a DAW. Deliberately PRE-mix: only the room-clock mapping
 * (alignment + drift + clip delay) is baked — strip gain/pan/mute/solo/EQ
 * and split regions are NOT (stems stay whole-stream source material; the
 * mix and the splits ship in the master WAV). */
export async function renderStems(model: RenderModel, range?: RenderRange): Promise<Stem[]> {
  const { startSec, endSec } = resolveRange(model.durationSec, range);
  const length = Math.max(1, Math.round((endSec - startSec) * RENDER_SAMPLE_RATE));
  const stems: Stem[] = [];
  for (const track of model.tracks) {
    // OfflineAudioContext.startRendering is one-shot: one context per stem.
    const ctx = new OfflineAudioContext(1, length, RENDER_SAMPLE_RATE);
    // Whole-stream on purpose (regions dropped — see the docstring).
    const { regions: _dropped, ...whole } = track;
    startSource(ctx, whole, startSec, ctx.destination);
    stems.push({
      streamId: track.streamId,
      channelKey: track.channelKey,
      buffer: await ctx.startRendering(),
    });
  }
  return stems;
}

// ---- session master render ---------------------------------------------------------
// Sequential per-take renderMaster passes mixed into one session-length
// stereo buffer at each take's room offset; gaps are zeros. Memory bounds
// like playback: one take's decoded audio lives at a time.

/** One take's slot in the session render, from player.sessionRenderPlan(). */
export interface SessionRenderSegment {
  takeId: string;
  /** Arrangement position of the take's base (leftmost clip). */
  baseSec: number;
  /** Declared end (pre-alignment) — sizes the allocation; the actual
   * rendered ends trim the result. */
  declaredEndSec: number;
}

export interface SessionMix {
  /** Stereo PCM, session length: first clip start → last take's end. */
  channelData: [Float32Array, Float32Array];
  sampleRate: number;
  durationSec: number;
}

/** Estimated on-disk size of the session master WAV (24-bit stereo) — the
 * pre-render length guard's number. */
export function estimateSessionWavBytes(spanSec: number): number {
  return 44 + Math.ceil(spanSec * RENDER_SAMPLE_RATE) * 2 * 3;
}

/** Render the whole session: every take mixed at its room offset, silence
 * between. The output starts at the FIRST clip's start (leading arrangement
 * space is desk furniture, not recorded silence). Takes render sequentially
 * through `modelOf`; an unbuildable model throws — no silent holes. */
export async function renderSessionMaster(
  segments: readonly SessionRenderSegment[],
  modelOf: (takeId: string) => Promise<RenderModel | null>,
): Promise<SessionMix> {
  if (segments.length === 0) throw new Error("no takes to render");
  const startSec = Math.min(...segments.map((s) => s.baseSec));
  // Allocate against the declared ends plus drift slack (a slow source
  // clock stretches on the room timeline — 1 s covers 1000 ppm over hours),
  // then trim to the actual rendered end.
  const declaredEnd = Math.max(...segments.map((s) => s.declaredEndSec));
  const capacity = Math.ceil((declaredEnd - startSec + 1) * RENDER_SAMPLE_RATE);
  const out: [Float32Array, Float32Array] = [
    new Float32Array(capacity),
    new Float32Array(capacity),
  ];
  let endSample = 0;
  for (const segment of [...segments].sort((a, b) => a.baseSec - b.baseSec)) {
    const model = await modelOf(segment.takeId);
    if (!model) throw new Error(`take ${segment.takeId.slice(0, 8)} is not renderable`);
    const rendered = await renderMaster(model);
    const offset = Math.round((segment.baseSec - startSec) * RENDER_SAMPLE_RATE);
    for (let ch = 0; ch < 2; ch++) {
      const src = rendered.getChannelData(Math.min(ch, rendered.numberOfChannels - 1));
      const dst = out[ch] as Float32Array;
      const n = Math.min(src.length, capacity - offset);
      // MIX (+=), not overwrite: takes never overlap in a stock session,
      // but a dragged arrangement that overlaps them still sums honestly.
      for (let i = 0; i < n; i++) {
        dst[offset + i] = (dst[offset + i] ?? 0) + (src[i] as number);
      }
      endSample = Math.max(endSample, offset + n);
    }
  }
  // subarray, not slice: slice would transiently DOUBLE the session-length
  // float pair just to drop the ≤1 s drift slack. Aliasing is safe —
  // encodeWav only READS the channels, and the SessionMix is transient.
  return {
    channelData: [
      (out[0] as Float32Array).subarray(0, endSample),
      (out[1] as Float32Array).subarray(0, endSample),
    ],
    sampleRate: RENDER_SAMPLE_RATE,
    durationSec: endSample / RENDER_SAMPLE_RATE,
  };
}

/** Schedule one track into an offline graph — the same plan live playback
 * uses, the context origin standing in for `currentTime + lead`. Split
 * tracks fan out one source per region, each stopped by the duration arg. */
function startSource(
  ctx: OfflineAudioContext,
  track: RenderTrackModel,
  fromSec: number,
  destination: AudioNode,
): void {
  if (track.regions) {
    for (const region of track.regions) {
      const plan = planRegionSource(track.timing, region, fromSec);
      if (!plan) continue;
      const source = ctx.createBufferSource();
      source.buffer = track.buffer;
      source.playbackRate.value = track.timing.ratio;
      source.connect(destination);
      source.start(plan.whenSec, plan.offsetSec, plan.playSec);
    }
    return;
  }
  const plan = planSource(track.timing, fromSec);
  if (!plan) return;
  const source = ctx.createBufferSource();
  source.buffer = track.buffer;
  source.playbackRate.value = track.timing.ratio;
  source.connect(destination);
  source.start(plan.whenSec, plan.offsetSec);
}
