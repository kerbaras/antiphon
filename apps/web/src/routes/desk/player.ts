// Take playback engine: decodes each stream's archived FLAC into an
// AudioBuffer and plays them through per-track gain → analyser → master
// gain → analyser → speakers. Alignment offsets from chirp correlation and
// per-stream drift ratios are applied at schedule time — stored audio is
// never touched (RFC §13).

import { DriftEstimator, find_chirp_offset, init as initWasm } from "@antiphon/core-wasm";
import { DEFAULT_CHIRP_SPEC } from "@antiphon/protocol";

const MIN_DB = -60;
const MAX_DB = 6;
/** Correlate against at most this much of the stream head. */
const ALIGN_WINDOW_SECONDS = 25;
const ALIGN_MIN_CONFIDENCE = 2.5;
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
 * gain/pan/mute/solo belong to the track (channel), survive take switches,
 * and are editable with nothing loaded at all. */
export interface ChannelStrip {
  key: string;
  gainDb: number;
  /** Stereo placement of the mono source, −1 (L) .. +1 (R). */
  pan: number;
  muted: boolean;
  soloed: boolean;
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
  masterLevel: number;
  tracks: PlayerTrackSnapshot[];
  channels: ChannelStrip[];
  error: string | null;
  /** Times source scheduling ran since play() — a continuous, uncut
   * playback stays at 1 (regression guard for re-schedule storms). */
  scheduleCount: number;
}

interface Track {
  streamId: string;
  channelKey: string;
  buffer: AudioBuffer;
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
  private error: string | null = null;
  private scheduleCount = 0;
  private raf: number | null = null;
  private listeners = new Set<(snap: PlayerSnapshot) => void>();
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
      channels: [...this.channels.values()].map((c) => ({ ...c })),
      error: this.error,
      scheduleCount: this.scheduleCount,
    };
  }

  private notify(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }

  private ensureGraph(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.masterPanner = this.ctx.createStereoPanner();
      this.masterAnalyser = this.ctx.createAnalyser();
      this.masterAnalyser.fftSize = 512;
      this.masterScratch = new Float32Array(this.masterAnalyser.fftSize);
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
      strip = { key, gainDb: 0, pan: 0, muted: false, soloed: false };
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
        const gain = ctx.createGain();
        const panner = ctx.createStereoPanner();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        gain.connect(panner);
        panner.connect(analyser);
        analyser.connect(this.master as GainNode);
        const previous = this.tracks.get(streamId);
        next.set(streamId, {
          streamId,
          channelKey: channelOf(streamId),
          buffer,
          gain,
          panner,
          analyser,
          scratch: new Float32Array(analyser.fftSize),
          alignment: previous?.alignment ?? null,
          drift: previous?.drift ?? null,
          waveform: computeWaveform(buffer),
        });
      }
      for (const old of this.tracks.values()) {
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

  /** Chirp correlation per track (RFC §10): the chirp position in each
   * stream maps its sample domain onto the shared room clock. Idempotent
   * unless `force`: auto-align triggers ride on status polls, and both the
   * correlation cost and the final re-schedule must not repeat. */
  async align(force = false): Promise<void> {
    if (this.tracks.size === 0 || this.aligning) return;
    if (!force && [...this.tracks.values()].every((t) => t.alignment !== null)) return;
    this.aligning = true;
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
    } finally {
      this.aligning = false;
      this.notify();
    }
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

  /** Samples to trim from each track's head so all aligned tracks share the
   * room clock. Streams may lock onto different repeats of the sweep (the
   * §10 schedule emits it twice); deltas are normalized modulo the repeat
   * interval, which is safe while true inter-device offsets stay under half
   * the interval (1 s — arming spread is hundreds of ms at worst). */
  private alignDeltas(): Map<string, number> {
    const out = new Map<string, number>();
    const applied = [...this.tracks.values()].filter((t) => t.alignment?.applied);
    if (applied.length < 2) return out;
    const spec = DEFAULT_CHIRP_SPEC;
    const base = Math.min(...applied.map((t) => t.alignment?.lagSamples ?? 0));
    const normalized = applied.map((t) => {
      const interval = Math.round(((spec.durationMs + spec.gapMs) / 1_000) * t.buffer.sampleRate);
      const raw = (t.alignment?.lagSamples ?? 0) - base;
      return [t.streamId, raw - Math.round(raw / interval) * interval] as const;
    });
    const min = Math.min(...normalized.map(([, d]) => d));
    for (const [streamId, d] of normalized) out.set(streamId, d - min);
    return out;
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

  duration(): number {
    let max = 0;
    for (const t of this.tracks.values()) {
      // Buffer seconds shrink by the drift ratio on the room timeline.
      max = Math.max(
        max,
        this.clipDelay(t.streamId) + (t.buffer.duration - this.headSec(t)) / this.driftRatio(t),
      );
    }
    return max;
  }

  position(): number {
    if (!this.playing || !this.ctx) return this.startPos;
    return Math.min(this.duration(), this.startPos + this.ctx.currentTime - this.startCtxTime);
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
      const ratio = this.driftRatio(track);
      const headSec = this.headSec(track);
      // Timeline time t maps to buffer time headSec + (t − clipDelay)·ratio:
      // a fast target clock packed more samples into each room-second, so
      // playbackRate = ratio consumes them at exactly one room-second per
      // second (±200 ppm is far below audible pitch change).
      const rel = fromSec - this.clipDelay(track.streamId);
      const source = ctx.createBufferSource();
      source.buffer = track.buffer;
      source.playbackRate.value = ratio;
      source.connect(track.gain);
      if (rel >= 0) {
        const offset = headSec + rel * ratio;
        if (offset >= track.buffer.duration) continue;
        source.start(when, offset);
      } else {
        // Clip begins later on the timeline: schedule its future start.
        source.start(when - rel, headSec);
      }
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
        this.pause();
        this.startPos = 0;
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
