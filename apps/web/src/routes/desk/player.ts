// Take playback engine: decodes each stream's archived FLAC into an
// AudioBuffer and plays them through per-track gain → analyser → master
// gain → analyser → speakers. Alignment offsets from chirp correlation are
// applied at schedule time — stored audio is never touched (RFC §13).

import { find_chirp_offset, init as initWasm } from "@antiphon/core-wasm";
import { DEFAULT_CHIRP_SPEC } from "@antiphon/protocol";

const MIN_DB = -60;
const MAX_DB = 6;
/** Correlate against at most this much of the stream head. */
const ALIGN_WINDOW_SECONDS = 25;
const ALIGN_MIN_CONFIDENCE = 2.5;

export interface AlignmentResult {
  lagSamples: number;
  confidence: number;
  applied: boolean;
}

export interface PlayerTrackSnapshot {
  streamId: string;
  gainDb: number;
  muted: boolean;
  soloed: boolean;
  /** 0..1 instantaneous peak while playing. */
  level: number;
  alignment: AlignmentResult | null;
  /** True absolute peak waveform from the decoded audio (0..1 per bucket). */
  waveform: number[];
}

export interface PlayerSnapshot {
  loadedTakeId: string | null;
  loading: boolean;
  aligning: boolean;
  playing: boolean;
  positionSec: number;
  durationSec: number;
  masterDb: number;
  masterLevel: number;
  tracks: PlayerTrackSnapshot[];
  error: string | null;
  /** Times source scheduling ran since play() — a continuous, uncut
   * playback stays at 1 (regression guard for re-schedule storms). */
  scheduleCount: number;
}

interface Track {
  streamId: string;
  buffer: AudioBuffer;
  gain: GainNode;
  analyser: AnalyserNode;
  scratch: Float32Array<ArrayBuffer>;
  gainDb: number;
  muted: boolean;
  soloed: boolean;
  alignment: AlignmentResult | null;
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
  private masterAnalyser: AnalyserNode | null = null;
  private masterScratch: Float32Array<ArrayBuffer> | null = null;
  private tracks = new Map<string, Track>();
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
      masterLevel: this.masterLevel,
      tracks: [...this.tracks.values()].map((t) => ({
        streamId: t.streamId,
        gainDb: t.gainDb,
        muted: t.muted,
        soloed: t.soloed,
        level: this.levels.get(t.streamId) ?? 0,
        alignment: t.alignment,
        waveform: t.waveform,
      })),
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
      this.masterAnalyser = this.ctx.createAnalyser();
      this.masterAnalyser.fftSize = 512;
      this.masterScratch = new Float32Array(this.masterAnalyser.fftSize);
      this.master.connect(this.masterAnalyser);
      this.masterAnalyser.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /** Decode and mount every stream of a take. Previous take is discarded. */
  async load(
    takeId: string,
    streamIds: string[],
    assemble: (takeId: string, streamId: string) => Promise<ArrayBuffer | null>,
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
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        gain.connect(analyser);
        analyser.connect(this.master as GainNode);
        const previous = this.tracks.get(streamId);
        next.set(streamId, {
          streamId,
          buffer,
          gain,
          analyser,
          scratch: new Float32Array(analyser.fftSize),
          gainDb: previous?.gainDb ?? 0,
          muted: previous?.muted ?? false,
          soloed: previous?.soloed ?? false,
          alignment: previous?.alignment ?? null,
          waveform: computeWaveform(buffer),
        });
      }
      for (const old of this.tracks.values()) {
        old.gain.disconnect();
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
      max = Math.max(
        max,
        this.clipDelay(t.streamId) + t.buffer.duration - this.alignDelta(t) / t.buffer.sampleRate,
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
      const alignSec = this.alignDelta(track) / track.buffer.sampleRate;
      // Timeline time t maps to buffer time (t - clipDelay + alignSec).
      const rel = fromSec - this.clipDelay(track.streamId);
      const source = ctx.createBufferSource();
      source.buffer = track.buffer;
      source.connect(track.gain);
      if (rel >= 0) {
        const offset = rel + alignSec;
        if (offset >= track.buffer.duration) continue;
        source.start(when, offset);
      } else {
        // Clip begins later on the timeline: schedule its future start.
        source.start(when - rel, alignSec);
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

  setTrackDb(streamId: string, db: number): void {
    const track = this.tracks.get(streamId);
    if (!track) return;
    track.gainDb = Math.max(MIN_DB, Math.min(MAX_DB, db));
    this.applyGains();
    this.notify();
  }

  toggleMute(streamId: string): void {
    const track = this.tracks.get(streamId);
    if (!track) return;
    track.muted = !track.muted;
    this.applyGains();
    this.notify();
  }

  toggleSolo(streamId: string): void {
    const track = this.tracks.get(streamId);
    if (!track) return;
    track.soloed = !track.soloed;
    this.applyGains();
    this.notify();
  }

  setMasterDb(db: number): void {
    this.masterDb = Math.max(MIN_DB, Math.min(MAX_DB, db));
    this.applyGains();
    this.notify();
  }

  private applyGains(): void {
    const anySolo = [...this.tracks.values()].some((t) => t.soloed);
    for (const track of this.tracks.values()) {
      const audible = !track.muted && (!anySolo || track.soloed);
      track.gain.gain.value = audible ? dbToLinear(track.gainDb) : 0;
    }
    if (this.master) this.master.gain.value = dbToLinear(this.masterDb);
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
