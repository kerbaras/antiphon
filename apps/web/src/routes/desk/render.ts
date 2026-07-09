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
  /** Split regions (W7-B), rebased to the model's take-local timeline by
   * the player. Absent = never split (the whole-stream schedule path —
   * zero-split renders stay byte-identical to pre-region output). */
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
 * DAW (the mix itself ships as the master WAV).
 *
 * SPLIT REGIONS (W7-B) ARE NOT BAKED EITHER, by the same pre-mix
 * philosophy: a split is an arrangement/mix decision, and cutting the
 * stem would destroy source material the importing DAW could still use
 * (the trimmed-away take intro, the breath before the cut). Stems stay
 * WHOLE-STREAM — the full capture at the stream's clip position (its
 * first region's placement) — while the master mix carries the splits. */
export async function renderStems(model: RenderModel, range?: RenderRange): Promise<Stem[]> {
  const { startSec, endSec } = resolveRange(model.durationSec, range);
  const length = Math.max(1, Math.round((endSec - startSec) * RENDER_SAMPLE_RATE));
  const stems: Stem[] = [];
  for (const track of model.tracks) {
    // OfflineAudioContext.startRendering is one-shot: one context per stem.
    const ctx = new OfflineAudioContext(1, length, RENDER_SAMPLE_RATE);
    // Whole-stream on purpose (regions dropped) — see the docstring.
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

// ---- session master render (W6-B) ------------------------------------------------
// The operator's ask: "master render should render the entire session, not
// the take you are in." Sequential per-take renderMaster passes — the SAME
// planSource math as playback and every per-take export — mixed into one
// session-length stereo buffer at each take's room offset. Gaps are zeros.
// Memory bounds like playback: one take's decoded audio lives at a time
// (modelOf decodes on demand; renderMaster's output is the only long-lived
// PCM, and it IS the deliverable).

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
 * between. The output timeline starts at the FIRST clip's start (the
 * arrangement's leading second is desk furniture, not recorded silence) —
 * so a single-take session renders exactly what the per-take master
 * renders. Takes render sequentially through `modelOf`; a take that can't
 * build a model throws — a master with a silent hole would be a lie. */
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
  // subarray, not slice (QA M-4): slice would transiently DOUBLE the
  // session-length float pair just to drop the ≤1 s drift slack. Aliasing
  // is safe here — encodeWav only READS the channels into its own fresh
  // ArrayBuffer, and the SessionMix (with its slack-sized backing) is
  // transient export state either way.
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
 * uses, with the context origin standing in for `currentTime + lead`.
 * Split tracks (W7-B) fan out one source per region through the shared
 * planRegionSource, each stopped at its region's end by the duration arg —
 * playback/render parity by construction, exactly like planSource. */
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
