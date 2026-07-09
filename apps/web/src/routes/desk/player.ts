// Take playback engine: decodes each stream's archived FLAC into an
// AudioBuffer and plays them through per-track EQ → gain → pan → analyser
// → master EQ → master gain → master pan → analyser → speakers. Alignment
// offsets from chirp correlation and per-stream drift ratios are applied
// at schedule time — stored audio is never touched (RFC §13).

import { DriftEstimator, find_chirp_offset, init as initWasm } from "@antiphon/core-wasm";
import { DEFAULT_CHIRP_SPEC } from "@antiphon/protocol";
import {
  applyEqPatch,
  createEqChain,
  defaultEq,
  disconnectEqChain,
  type EqBandPatch,
  type EqChain,
  type EqState,
  updateEqChain,
} from "./eq";
import type { RenderModel } from "./render";
import { normalizeAlignDeltas, planSource, type TrackTiming, trackEndSec } from "./timeline-math";

const MIN_DB = -60;
const MAX_DB = 6;
/** Correlate against at most this much of the stream head. */
const ALIGN_WINDOW_SECONDS = 25;
/** Chirp-correlation accept threshold — exported so the toolbar's declined
 * readout can show the honest comparison (F7a). */
export const ALIGN_MIN_CONFIDENCE = 2.5;
/** Drift guard rails: below this confidence, or beyond this |ratio−1|,
 * fall back to ratio 1 — a wrong ratio is worse than uncorrected drift,
 * and real ADC crystals never miss by a full 1000 ppm. */
const DRIFT_MIN_CONFIDENCE = 0.5;
const DRIFT_MAX_PPM = 1_000;

export interface AlignmentResult {
  lagSamples: number;
  confidence: number;
  applied: boolean;
}

/** One auto-align run's honest verdict for the toolbar (F7a), derived from
 * per-track state — so a persisted verdict restored after a reload reads
 * exactly like a freshly measured one. Null = never ran on this take. */
export type AlignmentOutcome =
  | { kind: "aligned"; trackCount: number; referenceStreamId: string | null }
  | { kind: "declined"; confidence: number }
  | { kind: "failed"; message: string };

/** Persisted per-stream alignment verdict (F7b): exactly the fields
 * align() writes, restorable at schedule time with playback parity. */
export interface StoredTrackAlignment {
  alignment: AlignmentResult;
  drift: DriftResult | null;
}

/** Clock-drift fit vs the reference stream (ARCHITECTURE §4 layer 3).
 * `ratio`/`initialOffsetSamples` are the values in force at schedule time:
 * zeroed to the identity when `applied` is false; `ppm`/`confidence` keep
 * the measurement for diagnostics either way. */
export interface DriftResult {
  /** target_clock/reference_clock, applied as playbackRate. */
  ratio: number;
  ppm: number;
  initialOffsetSamples: number;
  confidence: number;
  windowsUsed: number;
  applied: boolean;
  /** True for the stream every other track was measured against. */
  isReference: boolean;
}

export interface PlayerTrackSnapshot {
  streamId: string;
  /** Mixer channel this track plays through (the performer lane). */
  channelKey: string;
  gainDb: number;
  muted: boolean;
  soloed: boolean;
  /** 0..1 instantaneous peak while playing. */
  level: number;
  alignment: AlignmentResult | null;
  drift: DriftResult | null;
  /** True absolute peak waveform from the decoded audio (0..1 per bucket). */
  waveform: number[];
}

/** Persistent mixer strip state, keyed by performer lane — NOT by stream:
 * gain/pan/mute/solo/EQ belong to the track (channel), survive take
 * switches, and are editable with nothing loaded at all. */
export interface ChannelStrip {
  key: string;
  gainDb: number;
  /** Stereo placement of the mono source, −1 (L) .. +1 (R). */
  pan: number;
  muted: boolean;
  soloed: boolean;
  /** 3-band strip EQ, inserted before the strip gain. */
  eq: EqState;
}

export interface PlayerSnapshot {
  loadedTakeId: string | null;
  loading: boolean;
  aligning: boolean;
  playing: boolean;
  positionSec: number;
  durationSec: number;
  masterDb: number;
  masterPan: number;
  masterEq: EqState;
  masterLevel: number;
  tracks: PlayerTrackSnapshot[];
  channels: ChannelStrip[];
  error: string | null;
  /** Honest auto-align verdict for the toolbar readout (F7a). */
  alignmentOutcome: AlignmentOutcome | null;
  /** Times source scheduling ran since play() — a continuous, uncut
   * playback stays at 1 (regression guard for re-schedule storms). */
  scheduleCount: number;
  /** Times seek() ran, ever. The desk's parked playhead pin (W4-C) tells a
   * FOREIGN seek (marker flag, comment tick, ⏮) apart from its own
   * reconciliation by this counter — the position value alone can't carry
   * that signal (⏮ with the transport already parked at 0 moves nothing). */
  seekCount: number;
}

interface Track {
  streamId: string;
  channelKey: string;
  buffer: AudioBuffer;
  /** Stable node sources connect to; feeds `eq` or (bypassed) `gain`. */
  input: GainNode;
  /** Strip EQ biquads; `eq.high` stays wired into `gain` in both modes. */
  eq: EqChain;
  gain: GainNode;
  panner: StereoPannerNode;
  analyser: AnalyserNode;
  scratch: Float32Array<ArrayBuffer>;
  alignment: AlignmentResult | null;
  drift: DriftResult | null;
  waveform: number[];
}

/** Peak-per-bucket waveform of the decoded audio — what a DAW draws.
 * Absolute amplitude (not normalized): quiet audio draws small. */
export function computeWaveform(buffer: AudioBuffer, buckets = 240): number[] {
  const data = buffer.getChannelData(0);
  if (data.length === 0) return [];
  const perBucket = data.length / buckets;
  const stride = Math.max(1, Math.floor(perBucket / 64));
  const out: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * perBucket);
    const end = Math.min(data.length, Math.max(start + 1, Math.floor((b + 1) * perBucket)));
    let peak = 0;
    for (let i = start; i < end; i += stride) {
      const v = Math.abs(data[i] as number);
      if (v > peak) peak = v;
    }
    out.push(Math.min(1, peak));
  }
  return out;
}

export function dbToLinear(db: number): number {
  return db <= MIN_DB ? 0 : 10 ** (db / 20);
}

export class TakePlayer {
  private ctx: AudioContext | null = null;
  /** Stable node track analysers feed; routes into `masterEqChain` or
   * (bypassed) straight into `master`. */
  private masterBus: GainNode | null = null;
  private masterEqChain: EqChain | null = null;
  private master: GainNode | null = null;
  private masterPanner: StereoPannerNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private masterScratch: Float32Array<ArrayBuffer> | null = null;
  private tracks = new Map<string, Track>();
  private readonly channels = new Map<string, ChannelStrip>();
  /** Drift estimates survive take switches like waveforms do; keyed by
   * stream, valid only for the (reference, head-trim) pair they were
   * measured against. */
  private readonly driftCache = new Map<
    string,
    { referenceId: string; refDelta: number; trackDelta: number; result: DriftResult }
  >();
  private sources: AudioBufferSourceNode[] = [];
  /** Per-clip timeline delay (seconds ≥ 0 relative to the take's base):
   * the arrangement position of each clip, set by timeline edits. */
  private clipDelays = new Map<string, number>();
  private loadedTakeId: string | null = null;
  private loading = false;
  private aligning = false;
  private playing = false;
  private startCtxTime = 0;
  private startPos = 0;
  private masterDb = 0;
  private masterPan = 0;
  private masterEq: EqState = defaultEq();
  private error: string | null = null;
  /** Last align() failure (F7a) — cleared by the next run/load/restore. */
  private alignError: string | null = null;
  private scheduleCount = 0;
  private seekCount = 0;
  private raf: number | null = null;
  private listeners = new Set<(snap: PlayerSnapshot) => void>();
  /** Fired after an align() RUN settles with measurements — the F7b
   * persistence hook. Restores never fire it (no write-back loops). */
  private readonly alignmentSettledListeners = new Set<(takeId: string) => void>();
  private levels = new Map<string, number>();
  private masterLevel = 0;

  subscribe(listener: (snap: PlayerSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): PlayerSnapshot {
    return {
      loadedTakeId: this.loadedTakeId,
      loading: this.loading,
      aligning: this.aligning,
      playing: this.playing,
      positionSec: this.position(),
      durationSec: this.duration(),
      masterDb: this.masterDb,
      masterPan: this.masterPan,
      masterEq: { ...this.masterEq },
      masterLevel: this.masterLevel,
      tracks: [...this.tracks.values()].map((t) => {
        const strip = this.channel(t.channelKey);
        return {
          streamId: t.streamId,
          channelKey: t.channelKey,
          gainDb: strip.gainDb,
          muted: strip.muted,
          soloed: strip.soloed,
          level: this.levels.get(t.streamId) ?? 0,
          alignment: t.alignment,
          drift: t.drift,
          waveform: t.waveform,
        };
      }),
      channels: [...this.channels.values()].map((c) => ({ ...c, eq: { ...c.eq } })),
      error: this.error,
      alignmentOutcome: this.alignmentOutcome(),
      scheduleCount: this.scheduleCount,
      seekCount: this.seekCount,
    };
  }

  /** Derive the honest align verdict (F7a) from per-track state: never-ran
   * (null), aligned (any applied), declined (measured, none applied — the
   * best confidence is the number to show), or failed (align() threw). */
  private alignmentOutcome(): AlignmentOutcome | null {
    if (this.alignError) return { kind: "failed", message: this.alignError };
    const measured = [...this.tracks.values()].filter((t) => t.alignment !== null);
    if (measured.length === 0) return null;
    const applied = measured.filter((t) => t.alignment?.applied);
    if (applied.length > 0) {
      const reference = applied.find((t) => t.drift?.isReference) ?? null;
      return {
        kind: "aligned",
        trackCount: applied.length,
        referenceStreamId: reference?.streamId ?? null,
      };
    }
    return {
      kind: "declined",
      confidence: Math.max(...measured.map((t) => t.alignment?.confidence ?? 0)),
    };
  }

  private notify(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }

  private ensureGraph(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterBus = this.ctx.createGain();
      this.masterEqChain = createEqChain(this.ctx, this.masterEq);
      this.master = this.ctx.createGain();
      this.masterPanner = this.ctx.createStereoPanner();
      this.masterAnalyser = this.ctx.createAnalyser();
      this.masterAnalyser.fftSize = 512;
      this.masterScratch = new Float32Array(this.masterAnalyser.fftSize);
      this.masterEqChain.high.connect(this.master);
      this.routeMasterEq();
      this.master.connect(this.masterPanner);
      this.masterPanner.connect(this.masterAnalyser);
      this.masterAnalyser.connect(this.ctx.destination);
      this.applyGains();
    }
    return this.ctx;
  }

  /** Get-or-create the persistent mixer strip for a lane. */
  private channel(key: string): ChannelStrip {
    let strip = this.channels.get(key);
    if (!strip) {
      strip = { key, gainDb: 0, pan: 0, muted: false, soloed: false, eq: defaultEq() };
      this.channels.set(key, strip);
    }
    return strip;
  }

  /** Decode and mount every stream of a take. Previous take is discarded.
   * `channelOf` maps each stream to its mixer lane (performer); mixer state
   * lives on the lane, so it carries across takes untouched. */
  async load(
    takeId: string,
    streamIds: string[],
    assemble: (takeId: string, streamId: string) => Promise<ArrayBuffer | null>,
    channelOf: (streamId: string) => string = (id) => id,
  ): Promise<boolean> {
    if (this.loading) return false;
    if (this.loadedTakeId === takeId && streamIds.every((id) => this.tracks.has(id))) {
      return true;
    }
    this.pause();
    this.loading = true;
    this.error = null;
    this.alignError = null;
    this.notify();
    try {
      const ctx = this.ensureGraph();
      const next = new Map<string, Track>();
      for (const streamId of streamIds) {
        const flac = await assemble(takeId, streamId);
        if (!flac) {
          this.error = `stream ${streamId.slice(0, 8)} not reconstructable yet`;
          continue;
        }
        const buffer = await ctx.decodeAudioData(flac);
        const channelKey = channelOf(streamId);
        const input = ctx.createGain();
        const eq = createEqChain(ctx, this.channel(channelKey).eq);
        const gain = ctx.createGain();
        const panner = ctx.createStereoPanner();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        eq.high.connect(gain);
        gain.connect(panner);
        panner.connect(analyser);
        // Meters tap AFTER the whole strip — post-EQ/gain/pan by construction.
        analyser.connect(this.masterBus as GainNode);
        const previous = this.tracks.get(streamId);
        const track: Track = {
          streamId,
          channelKey,
          buffer,
          input,
          eq,
          gain,
          panner,
          analyser,
          scratch: new Float32Array(analyser.fftSize),
          alignment: previous?.alignment ?? null,
          drift: previous?.drift ?? null,
          waveform: computeWaveform(buffer),
        };
        this.routeTrackEq(track);
        next.set(streamId, track);
      }
      for (const old of this.tracks.values()) {
        old.input.disconnect();
        disconnectEqChain(old.eq);
        old.gain.disconnect();
        old.panner.disconnect();
        old.analyser.disconnect();
      }
      this.tracks = next;
      this.loadedTakeId = takeId;
      this.startPos = 0;
      this.applyGains();
      return this.tracks.size > 0;
    } catch (e) {
      this.error = `decode failed: ${String(e)}`;
      return false;
    } finally {
      this.loading = false;
      this.notify();
    }
  }

  /** Surface an out-of-band load failure on the transport error strip
   * (F5): queue-level errors must not die in a console. Cleared by the
   * next load attempt like every other player error. */
  reportError(message: string): void {
    this.error = message;
    this.notify();
  }

  /** Re-key loaded tracks onto (possibly new) mixer lanes (F1): a cold
   * desk may load a take before the archive attribution lands, mounting
   * tracks on streamId-keyed fallback strips. Once the stream→peer mapping
   * arrives this re-points them at their performer lanes WITHOUT a
   * re-decode or re-schedule — strip state re-applies through node params
   * (gain/pan/EQ), so playback never cuts. */
  remapChannels(channelOf: (streamId: string) => string): void {
    let changed = false;
    for (const track of this.tracks.values()) {
      const key = channelOf(track.streamId);
      if (key === track.channelKey) continue;
      track.channelKey = key;
      const strip = this.channel(key);
      if (this.ctx) updateEqChain(track.eq, strip.eq, this.ctx.currentTime);
      this.routeTrackEq(track);
      changed = true;
    }
    if (!changed) return;
    this.applyGains();
    this.notify();
  }

  /** Chirp correlation per track (RFC §10): the chirp position in each
   * stream maps its sample domain onto the shared room clock. Idempotent
   * unless `force`: auto-align triggers ride on status polls, and both the
   * correlation cost and the final re-schedule must not repeat. */
  async align(force = false): Promise<void> {
    if (this.tracks.size === 0 || this.aligning) return;
    if (!force && [...this.tracks.values()].every((t) => t.alignment !== null)) return;
    const takeId = this.loadedTakeId;
    this.aligning = true;
    this.alignError = null;
    this.notify();
    try {
      await initWasm();
      const spec = DEFAULT_CHIRP_SPEC;
      for (const track of this.tracks.values()) {
        const rate = track.buffer.sampleRate;
        const window = Math.min(track.buffer.length, Math.round(rate * ALIGN_WINDOW_SECONDS));
        const head = track.buffer.getChannelData(0).slice(0, window);
        // Yield to the UI between (potentially ~100ms) correlations.
        await new Promise((r) => setTimeout(r, 0));
        const result = find_chirp_offset(
          head,
          rate,
          spec.startHz,
          spec.endHz,
          spec.durationMs,
          spec.gainDbfs,
          spec.repeats,
          spec.gapMs,
        );
        if (result) {
          const parsed = JSON.parse(result) as { lagSamples: number; confidence: number };
          track.alignment = {
            lagSamples: parsed.lagSamples,
            confidence: parsed.confidence,
            applied: parsed.confidence >= ALIGN_MIN_CONFIDENCE,
          };
        } else {
          track.alignment = { lagSamples: 0, confidence: 0, applied: false };
        }
      }
      // Chirp offsets fix the take head; drift keeps it fixed for 45 min.
      await this.estimateDrift();
      // Re-schedule if currently playing so offsets take effect audibly.
      if (this.playing) {
        const pos = this.position();
        this.stopSources();
        this.schedule(pos);
      }
    } catch (e) {
      // Honest failure state (F7a): a wasm/init error must read as
      // "failed", never as "not run" — and must not kill the load queue.
      this.alignError = e instanceof Error ? e.message : String(e);
    } finally {
      this.aligning = false;
      this.notify();
    }
    // Persistence hook (F7b): a completed run with measurements settles the
    // take's verdict — declined runs persist too (the verdict IS the state).
    if (
      !this.alignError &&
      takeId !== null &&
      takeId === this.loadedTakeId &&
      [...this.tracks.values()].some((t) => t.alignment !== null)
    ) {
      for (const listener of this.alignmentSettledListeners) listener(takeId);
    }
  }

  /** Register for settled align() runs (F7b persistence). */
  onAlignmentSettled(listener: (takeId: string) => void): () => void {
    this.alignmentSettledListeners.add(listener);
    return () => this.alignmentSettledListeners.delete(listener);
  }

  /** Reapply a persisted per-take alignment verdict (F7b): the same track
   * fields align() writes, consumed through the same timing()/planSource
   * math as live playback AND the offline render — parity by construction,
   * stored audio untouched, schedule-time only. Entries equal to the
   * current verdict are skipped (idempotent: doc echoes and take
   * re-selection never cause re-schedule storms); differing entries win, so
   * desks converge on the shared doc's verdict. Returns true when anything
   * changed. */
  restoreAlignment(takeId: string, entries: Record<string, StoredTrackAlignment>): boolean {
    if (this.loadedTakeId !== takeId || this.aligning || this.loading) return false;
    let changed = false;
    for (const track of this.tracks.values()) {
      const entry = entries[track.streamId];
      if (!entry) continue;
      if (
        track.alignment !== null &&
        JSON.stringify({ alignment: track.alignment, drift: track.drift }) === JSON.stringify(entry)
      ) {
        continue;
      }
      track.alignment = { ...entry.alignment };
      track.drift = entry.drift ? { ...entry.drift } : null;
      changed = true;
    }
    if (!changed) return false;
    this.alignError = null;
    if (this.playing) {
      const pos = this.position();
      this.stopSources();
      this.schedule(pos);
    } else {
      this.notify();
    }
    return true;
  }

  /** Per-stream clock-drift estimation (ARCHITECTURE §4 layer 3). The
   * reference is the chirp alignment anchor — the track whose head-trim is
   * zero, i.e. the sample domain every other track is already mapped onto.
   * (A future desk room-reference mic slots in here; the dsp API is
   * reference-agnostic.) Runs chunked off the audio thread like align():
   * window pairs are sliced on demand, pushed to wasm, UI yielded between
   * correlations. Results are cached per stream. */
  private async estimateDrift(): Promise<void> {
    const deltas = this.alignDeltas();
    if (deltas.size < 2) return; // no anchor to drift against
    const aligned = [...this.tracks.values()].filter((t) => deltas.has(t.streamId));
    const reference = aligned.reduce((a, b) =>
      (deltas.get(b.streamId) as number) < (deltas.get(a.streamId) as number) ? b : a,
    );
    reference.drift = {
      ratio: 1,
      ppm: 0,
      initialOffsetSamples: 0,
      confidence: 1,
      windowsUsed: 0,
      applied: false,
      isReference: true,
    };
    const refDelta = deltas.get(reference.streamId) as number;
    const refData = reference.buffer.getChannelData(0);
    for (const track of aligned) {
      if (track === reference) continue;
      const trackDelta = deltas.get(track.streamId) as number;
      const cached = this.driftCache.get(track.streamId);
      if (
        cached &&
        cached.referenceId === reference.streamId &&
        cached.refDelta === refDelta &&
        cached.trackDelta === trackDelta
      ) {
        track.drift = cached.result;
        continue;
      }
      const result = await this.estimateTrackDrift(track, refData, refDelta, trackDelta);
      track.drift = result;
      this.driftCache.set(track.streamId, {
        referenceId: reference.streamId,
        refDelta,
        trackDelta,
        result,
      });
    }
  }

  /** Drive the pull-based wasm estimator for one track, then apply the
   * guard rails: an implausible or low-confidence fit degrades to ratio 1
   * (measurement kept for the diagnostics readout) — drift correction must
   * never make playback worse than no correction. */
  private async estimateTrackDrift(
    track: Track,
    refData: Float32Array,
    refDelta: number,
    trackDelta: number,
  ): Promise<DriftResult> {
    const data = track.buffer.getChannelData(0);
    const estimator = new DriftEstimator(
      track.buffer.sampleRate,
      refData.length - refDelta,
      data.length - trackDelta,
    );
    try {
      for (;;) {
        const reqJson = estimator.next_request_json();
        if (!reqJson) break;
        const req = JSON.parse(reqJson) as {
          targetStart: number;
          targetLen: number;
          refStart: number;
          refLen: number;
        };
        estimator.push_window(
          refData.subarray(refDelta + req.refStart, refDelta + req.refStart + req.refLen),
          data.subarray(trackDelta + req.targetStart, trackDelta + req.targetStart + req.targetLen),
        );
        // Yield to the UI between (potentially ~10ms) correlations.
        await new Promise((r) => setTimeout(r, 0));
      }
      const est = JSON.parse(estimator.estimate_json()) as {
        ratio: number;
        ppm: number;
        initialOffsetSamples: number;
        confidence: number;
        windowsUsed: number;
        windowsTotal: number;
      };
      const applied = est.confidence >= DRIFT_MIN_CONFIDENCE && Math.abs(est.ppm) <= DRIFT_MAX_PPM;
      return {
        ratio: applied ? est.ratio : 1,
        ppm: est.ppm,
        initialOffsetSamples: applied ? est.initialOffsetSamples : 0,
        confidence: est.confidence,
        windowsUsed: est.windowsUsed,
        applied,
        isReference: false,
      };
    } finally {
      estimator.free();
    }
  }

  /** Applied playback-rate factor: target_clock/reference_clock, 1 = off. */
  private driftRatio(track: Track): number {
    return track.drift?.applied ? track.drift.ratio : 1;
  }

  /** Seconds of buffer consumed before the track's room-time zero: chirp
   * head-trim plus the drift fit's residual offset. */
  private headSec(track: Track): number {
    const driftSamples = track.drift?.applied ? track.drift.initialOffsetSamples : 0;
    return (this.alignDelta(track) + driftSamples) / track.buffer.sampleRate;
  }

  /** Samples to trim from each track's head so all aligned tracks share
   * the room clock — the modulo-repeat normalization lives in
   * timeline-math (shared with the offline render). Public as a pure
   * diagnostics readout (F7 e2e asserts restored deltas through it). */
  alignDeltas(): Map<string, number> {
    const spec = DEFAULT_CHIRP_SPEC;
    return normalizeAlignDeltas(
      [...this.tracks.values()]
        .filter((t) => t.alignment?.applied)
        .map((t) => ({
          streamId: t.streamId,
          lagSamples: t.alignment?.lagSamples ?? 0,
          sampleRate: t.buffer.sampleRate,
        })),
      (spec.durationMs + spec.gapMs) / 1_000,
    );
  }

  private alignDelta(track: Track): number {
    return this.alignDeltas().get(track.streamId) ?? 0;
  }

  /** Drop tracks whose streams were deleted. Playback continues with the
   * survivors (re-scheduled from the same position); an emptied player
   * unloads entirely. */
  removeTracks(streamIds: string[]): void {
    let removed = false;
    for (const streamId of streamIds) {
      const track = this.tracks.get(streamId);
      if (!track) continue;
      track.input.disconnect();
      disconnectEqChain(track.eq);
      track.gain.disconnect();
      track.panner.disconnect();
      track.analyser.disconnect();
      this.tracks.delete(streamId);
      this.levels.delete(streamId);
      this.clipDelays.delete(streamId);
      this.driftCache.delete(streamId);
      removed = true;
    }
    if (!removed) return;
    if (this.tracks.size === 0) {
      this.pause();
      this.loadedTakeId = null;
      this.startPos = 0;
    } else if (this.playing) {
      const pos = this.position();
      this.stopSources();
      this.schedule(pos);
    }
    this.notify();
  }

  /** Update arrangement positions (from timeline clip drags). Re-schedules
   * live so the change is audible immediately — but ONLY when a delay
   * actually changed: callers fire on status polls, and a spurious
   * re-schedule mid-playback is an audible cut. */
  setClipDelays(delays: Record<string, number>): void {
    const next = new Map(Object.entries(delays).map(([id, d]) => [id, Math.max(0, d)]));
    let changed = next.size !== this.clipDelays.size;
    if (!changed) {
      for (const [id, d] of next) {
        const prev = this.clipDelays.get(id);
        if (prev === undefined || Math.abs(prev - d) > 1e-4) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return;
    this.clipDelays = next;
    if (this.playing) {
      const pos = this.position();
      this.stopSources();
      this.schedule(pos);
    } else {
      this.notify();
    }
  }

  private clipDelay(streamId: string): number {
    return this.clipDelays.get(streamId) ?? 0;
  }

  /** The SAME schedule parameters live playback and the offline render
   * plan sources with (timeline-math.planSource) — the parity contract. */
  private timing(track: Track): TrackTiming {
    return {
      headSec: this.headSec(track),
      ratio: this.driftRatio(track),
      clipDelaySec: this.clipDelay(track.streamId),
      bufferDurationSec: track.buffer.duration,
    };
  }

  duration(): number {
    let max = 0;
    for (const t of this.tracks.values()) {
      max = Math.max(max, trackEndSec(this.timing(t)));
    }
    return max;
  }

  /** Immutable inputs for the offline export path (render.ts): the decoded
   * buffers (shared by reference, read-only — stored audio is never
   * mutated), the SAME per-track timing playback schedules with, and the
   * mixer state resolved exactly as applyGains() resolves it (mute/solo →
   * gain 0). Null while nothing is loaded. */
  renderModel(): RenderModel | null {
    if (!this.loadedTakeId || this.tracks.size === 0) return null;
    const anySolo = [...this.channels.values()].some((c) => c.soloed);
    return {
      takeId: this.loadedTakeId,
      durationSec: this.duration(),
      masterGain: dbToLinear(this.masterDb),
      masterPan: this.masterPan,
      masterEq: { ...this.masterEq },
      tracks: [...this.tracks.values()].map((track) => {
        const strip = this.channel(track.channelKey);
        const audible = !strip.muted && (!anySolo || strip.soloed);
        return {
          streamId: track.streamId,
          channelKey: track.channelKey,
          buffer: track.buffer,
          timing: this.timing(track),
          gain: audible ? dbToLinear(strip.gainDb) : 0,
          pan: strip.pan,
          eq: { ...strip.eq },
        };
      }),
    };
  }

  position(): number {
    if (!this.playing || !this.ctx) return this.startPos;
    // schedule() starts sources 0.06 s in the future; until that pre-roll
    // elapses no audio has been consumed, so the playhead HOLDS at startPos
    // instead of regressing below it — pause() would otherwise capture the
    // regressed value and rapid play/pause cycles walked the position back
    // up to 60 ms per cycle (QA-2 B2).
    const elapsed = Math.max(0, this.ctx.currentTime - this.startCtxTime);
    return Math.min(this.duration(), this.startPos + elapsed);
  }

  play(fromSec?: number): void {
    if (this.tracks.size === 0) return;
    const ctx = this.ensureGraph();
    void ctx.resume();
    this.stopSources();
    this.scheduleCount = 0;
    const pos = fromSec ?? this.startPos;
    this.schedule(pos >= this.duration() - 0.05 ? 0 : pos);
  }

  private schedule(fromSec: number): void {
    const ctx = this.ensureGraph();
    const when = ctx.currentTime + 0.06;
    for (const track of this.tracks.values()) {
      // Timeline→buffer mapping (head trim, drift ratio, clip delay) is the
      // shared planSource — identical for playback and export by design.
      const timing = this.timing(track);
      const plan = planSource(timing, fromSec);
      if (!plan) continue;
      const source = ctx.createBufferSource();
      source.buffer = track.buffer;
      source.playbackRate.value = timing.ratio;
      source.connect(track.input);
      source.start(when + plan.whenSec, plan.offsetSec);
      this.sources.push(source);
    }
    this.startCtxTime = when;
    this.startPos = fromSec;
    this.playing = true;
    this.scheduleCount += 1;
    this.startMeterLoop();
    this.notify();
  }

  pause(): void {
    if (!this.playing) return;
    this.startPos = this.position();
    this.stopSources();
    this.playing = false;
    this.stopMeterLoop();
    this.notify();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(sec: number): void {
    this.seekCount += 1;
    const clamped = Math.max(0, Math.min(sec, this.duration()));
    if (this.playing) {
      this.stopSources();
      this.schedule(clamped);
    } else {
      this.startPos = clamped;
      this.notify();
    }
  }

  // Channel-strip controls: keyed by lane, valid at ANY time — before the
  // first load, while recording, across take switches. State persists for
  // the page's lifetime and applies to whatever that lane plays.

  setChannelDb(channelKey: string, db: number): void {
    this.channel(channelKey).gainDb = Math.max(MIN_DB, Math.min(MAX_DB, db));
    this.applyGains();
    this.notify();
  }

  setChannelPan(channelKey: string, pan: number): void {
    this.channel(channelKey).pan = Math.max(-1, Math.min(1, pan));
    this.applyGains();
    this.notify();
  }

  toggleChannelMute(channelKey: string): void {
    const strip = this.channel(channelKey);
    strip.muted = !strip.muted;
    this.applyGains();
    this.notify();
  }

  toggleChannelSolo(channelKey: string): void {
    const strip = this.channel(channelKey);
    strip.soloed = !strip.soloed;
    this.applyGains();
    this.notify();
  }

  setMasterDb(db: number): void {
    this.masterDb = Math.max(MIN_DB, Math.min(MAX_DB, db));
    this.applyGains();
    this.notify();
  }

  setMasterPan(pan: number): void {
    this.masterPan = Math.max(-1, Math.min(1, pan));
    this.applyGains();
    this.notify();
  }

  // Strip/master EQ: band params re-target live biquads click-free; bypass
  // is TRUE bypass — a single edge swap that reconnects the signal path
  // around the filters (honest A/B, not a gains-cancel approximation).

  setChannelEq(channelKey: string, patch: EqBandPatch): void {
    const strip = this.channel(channelKey);
    strip.eq = applyEqPatch(strip.eq, patch);
    if (this.ctx) {
      for (const track of this.tracks.values()) {
        if (track.channelKey === channelKey) {
          updateEqChain(track.eq, strip.eq, this.ctx.currentTime);
        }
      }
    }
    this.notify();
  }

  toggleChannelEqBypass(channelKey: string): void {
    const strip = this.channel(channelKey);
    strip.eq = { ...strip.eq, bypassed: !strip.eq.bypassed };
    for (const track of this.tracks.values()) {
      if (track.channelKey === channelKey) this.routeTrackEq(track);
    }
    this.notify();
  }

  setMasterEq(patch: EqBandPatch): void {
    this.masterEq = applyEqPatch(this.masterEq, patch);
    if (this.ctx && this.masterEqChain) {
      updateEqChain(this.masterEqChain, this.masterEq, this.ctx.currentTime);
    }
    this.notify();
  }

  toggleMasterEqBypass(): void {
    this.masterEq = { ...this.masterEq, bypassed: !this.masterEq.bypassed };
    this.routeMasterEq();
    this.notify();
  }

  private routeTrackEq(track: Track): void {
    track.input.disconnect();
    track.input.connect(this.channel(track.channelKey).eq.bypassed ? track.gain : track.eq.low);
  }

  private routeMasterEq(): void {
    if (!this.masterBus || !this.master || !this.masterEqChain) return;
    this.masterBus.disconnect();
    this.masterBus.connect(this.masterEq.bypassed ? this.master : this.masterEqChain.low);
  }

  private applyGains(): void {
    // Solo is a property of the mixer, not of the loaded take: a soloed
    // lane silences every other lane in whatever take plays.
    const anySolo = [...this.channels.values()].some((c) => c.soloed);
    for (const track of this.tracks.values()) {
      const strip = this.channel(track.channelKey);
      const audible = !strip.muted && (!anySolo || strip.soloed);
      track.gain.gain.value = audible ? dbToLinear(strip.gainDb) : 0;
      track.panner.pan.value = strip.pan;
    }
    if (this.master) this.master.gain.value = dbToLinear(this.masterDb);
    if (this.masterPanner) this.masterPanner.pan.value = this.masterPan;
  }

  private lastMeterNotify = 0;

  private startMeterLoop(): void {
    if (this.raf !== null) return;
    const tick = () => {
      if (!this.playing) return;
      for (const track of this.tracks.values()) {
        track.analyser.getFloatTimeDomainData(track.scratch);
        let peak = 0;
        for (const v of track.scratch) peak = Math.max(peak, Math.abs(v));
        this.levels.set(track.streamId, peak);
      }
      if (this.masterAnalyser && this.masterScratch) {
        this.masterAnalyser.getFloatTimeDomainData(this.masterScratch);
        let peak = 0;
        for (const v of this.masterScratch) peak = Math.max(peak, Math.abs(v));
        this.masterLevel = peak;
      }
      if (this.position() >= this.duration() - 0.02) {
        // End of take: EXACTLY a user pause on the last frame. startPos
        // parks at the end (position() clamps to duration) and pause()'s
        // notify hands the UI the same parked position the engine reports —
        // Play from here returns to the start through play()'s own
        // >= duration guard, the transport's one rule for "play from the
        // end". (A silent startPos = 0 here desynced timecode vs engine —
        // QA F12.) Return WITHOUT re-arming: pause() stopped the meter
        // loop, and re-arming would strand a stale raf id that gates the
        // next startMeterLoop, freezing playhead/meters on the next play.
        this.pause();
        return;
      }
      // Meters/playhead re-render at ~25 fps — a 60 Hz notify makes the
      // whole desk re-render every frame for no visual gain.
      const now = performance.now();
      if (now - this.lastMeterNotify > 40) {
        this.lastMeterNotify = now;
        this.notify();
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopMeterLoop(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.levels.clear();
    this.masterLevel = 0;
  }

  private stopSources(): void {
    for (const source of this.sources) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // already stopped
      }
    }
    this.sources = [];
  }
}
