// Session playback engine. The transport runs the whole SESSION timeline —
// every take at its room offset, silence in the gaps — through per-track
// EQ → gain → pan → analyser → master EQ → gain → pan → analyser → out.
//
// Memory is bounded by a rolling mount window, not by decoding everything:
// the SELECTED take is always mounted; while playing, a look-ahead mounts
// the next take before its start and schedules it into the SAME
// AudioContext on the running clock grid — never re-scheduling what is
// already rolling. Passed takes release their buffers behind the playhead.
//
// Alignment offsets and drift ratios stay PER TAKE and are applied at
// schedule time — stored audio is never mutated. Look-ahead mounts reapply
// the take's persisted verdict before their first schedule.

import { init as initWasm } from "@antiphon/core-wasm";
import { DEFAULT_CHIRP_SPEC } from "@antiphon/protocol";
import type { ClipRegion } from "../../net/collab-doc";
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
import {
  type AlignmentOutcome,
  type AlignmentResult,
  chirpAlignPass,
  contentAlignPass,
  type DriftCache,
  type DriftResult,
  demoteChirpHitsIntoContentDomain,
  deriveAlignmentOutcome,
  estimateDriftPass,
  type StoredTrackAlignment,
} from "./player-align";
import {
  clipsBaseSec,
  normalizeSessionPlan,
  plannedEndSec,
  plannedRenderModel,
  type RenderStripView,
  type SessionSources,
  type SessionStreamPlan,
  type SessionTakePlan,
  samePlan,
} from "./player-plan";
import type { RenderModel } from "./render";
import {
  type AlignLag,
  type AlignShifts,
  alignShifts,
  normalizeAlignDeltas,
  planRegionSource,
  planSource,
  type RegionStreamTiming,
  regionsEndSec,
  type SessionTakeSpan,
  sessionEndSec,
  type TrackTiming,
  takesToMount,
  takesToRelease,
  trackEndSec,
} from "./timeline-math";

export {
  ALIGN_MIN_CONFIDENCE,
  type AlignmentOutcome,
  type AlignmentResult,
  CONTENT_MIN_CONFIDENCE,
  type DriftResult,
  type StoredTrackAlignment,
} from "./player-align";
export type { SessionSources, SessionStreamPlan, SessionTakePlan } from "./player-plan";

const MIN_DB = -60;
const MAX_DB = 6;
/** Look-ahead window: a take starting within this many seconds of the
 * playhead gets decoded NOW — sized for a comfortable assemble+decode of a
 * multi-minute take with margin for a loaded machine. */
const LOOKAHEAD_SEC = 15;
/** A mounted take releases its buffers once its end is this far behind the
 * playhead — close enough to bound memory, far enough that a small
 * backwards scrub doesn't thrash decode. */
const RELEASE_MARGIN_SEC = 5;
/** Look-ahead poll cadence inside the meter loop (raf runs at 60 Hz; the
 * window math needs nothing near that). */
const LOOKAHEAD_POLL_MS = 500;

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
  /** Absolute SESSION (arrangement) seconds — the transport clock. */
  positionSec: number;
  /** Session end: the last take's aligned end. The transport's end-stop. */
  durationSec: number;
  /** The LOADED take's own span (aligned end minus base) — the domain of
   * take-scoped UI (song spans, export hints, the MIDI lane). */
  takeDurationSec: number;
  /** Takes currently holding decoded buffers (diagnostics/e2e). */
  mountedTakeIds: string[];
  /** Peak level per mixer lane across ALL mounted takes — lane meters
   * follow whatever take is audible, not just the selected one. */
  channelLevels: Record<string, number>;
  masterDb: number;
  masterPan: number;
  masterEq: EqState;
  masterLevel: number;
  tracks: PlayerTrackSnapshot[];
  channels: ChannelStrip[];
  error: string | null;
  /** Honest auto-align verdict for the toolbar readout. */
  alignmentOutcome: AlignmentOutcome | null;
  /** Times source scheduling ran since play() — continuous uncut playback
   * stays at 1 (regression guard for re-schedule storms). */
  scheduleCount: number;
  /** Times seek() ran, ever. The desk tells a FOREIGN seek apart from its
   * own reconciliation by this counter — position alone can't carry that. */
  seekCount: number;
}

interface Track {
  streamId: string;
  /** The take this stream belongs to — the mount window's unit. */
  takeId: string;
  channelKey: string;
  /** Absolute arrangement position of the clip (session plan). */
  clipStartSec: number;
  /** Split regions (session plan). Null = never split: the track schedules
   * through the verbatim whole-stream path. */
  regions: ClipRegion[] | null;
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

export class SessionPlayer {
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
  private readonly driftCache: DriftCache = new Map();
  /** Scheduled sources, tagged by take so a released take can stop its
   * own (already-ended) nodes and free their buffer references. */
  private sources: Array<{ node: AudioBufferSourceNode; takeId: string }> = [];
  /** The session plan (desk → engine): THE source of the session timeline —
   * duration(), look-ahead targets, render segments. */
  private plan: SessionTakePlan[] = [];
  /** Assembly + persisted-verdict access for selection-less mounts. */
  private sessionSources: SessionSources | null = null;
  /** The one take a look-ahead decode is in flight for (serialized). */
  private decodingTakeId: string | null = null;
  private lastLookaheadMs = 0;
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
  /** Last align() failure — cleared by the next run/load/restore. */
  private alignError: string | null = null;
  private scheduleCount = 0;
  private seekCount = 0;
  private raf: number | null = null;
  private listeners = new Set<(snap: PlayerSnapshot) => void>();
  /** Fired after an align() RUN settles with measurements — the
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
    const channelLevels: Record<string, number> = {};
    for (const t of this.tracks.values()) {
      const level = this.levels.get(t.streamId) ?? 0;
      channelLevels[t.channelKey] = Math.max(channelLevels[t.channelKey] ?? 0, level);
    }
    return {
      loadedTakeId: this.loadedTakeId,
      loading: this.loading,
      aligning: this.aligning,
      playing: this.playing,
      positionSec: this.position(),
      durationSec: this.duration(),
      takeDurationSec: this.takeDuration(),
      mountedTakeIds: this.mountedTakeIds(),
      channelLevels,
      masterDb: this.masterDb,
      masterPan: this.masterPan,
      masterEq: { ...this.masterEq },
      masterLevel: this.masterLevel,
      // `tracks` stays the SELECTED take's view: alignment chip, exports,
      // waveforms, manifests all reason about the take under edit.
      tracks: this.loadedTracks().map((t) => {
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
      alignmentOutcome: deriveAlignmentOutcome(this.alignError, this.loadedTracks()),
      scheduleCount: this.scheduleCount,
      seekCount: this.seekCount,
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

  // ---- mount-window accessors ------------------------------------------------------

  /** Mounted tracks of one take. */
  private takeTracks(takeId: string | null): Track[] {
    return [...this.tracks.values()].filter((t) => t.takeId === takeId);
  }

  /** Mounted tracks of the SELECTED take — the per-take surfaces
   * (alignment, exports, snapshot.tracks) reason over exactly these. */
  private loadedTracks(): Track[] {
    return this.takeTracks(this.loadedTakeId);
  }

  private mountedTakeIds(): string[] {
    const ids: string[] = [];
    for (const t of this.tracks.values()) {
      if (!ids.includes(t.takeId)) ids.push(t.takeId);
    }
    return ids;
  }

  /** A take's base on the arrangement: its leftmost clip start — mounted
   * tracks first (exact), else the plan, else 0. */
  private takeBaseSec(takeId: string | null): number {
    if (takeId === null) return 0;
    const mounted = this.takeTracks(takeId);
    if (mounted.length > 0) return clipsBaseSec(mounted);
    const planned = this.plan.find((p) => p.takeId === takeId);
    if (planned && planned.streams.length > 0) return clipsBaseSec(planned.streams);
    return 0;
  }

  /** A take's end on the arrangement: aligned (mounted) or declared. A
   * split stream ends at its LAST region's end. */
  private takeEndSec(takeId: string): number {
    const mounted = this.takeTracks(takeId);
    if (mounted.length > 0) {
      return Math.max(
        ...mounted.map((t) =>
          t.regions ? regionsEndSec(this.streamTiming(t), t.regions) : trackEndSec(this.timing(t)),
        ),
      );
    }
    const planned = this.plan.find((p) => p.takeId === takeId);
    if (planned && planned.streams.length > 0) return plannedEndSec(planned.streams);
    return 0;
  }

  /** Session spans for the look-ahead/release math — plan takes plus any
   * mounted take the plan hasn't caught up with, aligned ends preferred. */
  private takeSpans(): SessionTakeSpan[] {
    const spans = new Map<string, SessionTakeSpan>();
    for (const p of this.plan) {
      if (p.streams.length === 0) continue;
      spans.set(p.takeId, {
        takeId: p.takeId,
        startSec: this.takeBaseSec(p.takeId),
        endSec: this.takeEndSec(p.takeId),
      });
    }
    for (const takeId of this.mountedTakeIds()) {
      if (spans.has(takeId)) continue;
      spans.set(takeId, {
        takeId,
        startSec: this.takeBaseSec(takeId),
        endSec: this.takeEndSec(takeId),
      });
    }
    return [...spans.values()];
  }

  /** Wire the session sources (assembly + persisted verdicts). Set once by
   * the desk; replaced wholesale on a session switch. */
  setSessionSources(sources: SessionSources): void {
    this.sessionSources = sources;
  }

  /** Publish the session plan (desk → engine). Identical content (status
   * polls re-derive it every second) is a strict no-op. A clip-start or
   * region change on MOUNTED tracks re-schedules live (audible); anything
   * else just refreshes the timeline math and notifies. */
  setSessionPlan(plan: SessionTakePlan[]): void {
    const next = normalizeSessionPlan(plan);
    if (samePlan(this.plan, next)) return;
    const known = new Set(next.map((p) => p.takeId));
    this.plan = next;
    // Mounted takes the plan dropped (deleted / re-scoped) release now —
    // removeTracks covers server-confirmed deletes, this covers the rest.
    for (const takeId of this.mountedTakeIds()) {
      if (!known.has(takeId) && takeId !== this.loadedTakeId) this.unmountTake(takeId);
    }
    // Re-point mounted tracks at their plan entries: clip moves and region
    // edits re-schedule (audible), lane re-keys re-route (parameter-only).
    let moved = false;
    for (const p of next) {
      for (const s of p.streams) {
        const track = this.tracks.get(s.streamId);
        if (!track || track.takeId !== p.takeId) continue;
        if (Math.abs(track.clipStartSec - s.clipStartSec) > 1e-4) {
          track.clipStartSec = s.clipStartSec;
          moved = true;
        }
        if (JSON.stringify(track.regions) !== JSON.stringify(s.regions ?? null)) {
          track.regions = s.regions ?? null;
          moved = true;
        }
        if (track.channelKey !== s.channelKey) {
          track.channelKey = s.channelKey;
          const strip = this.channel(s.channelKey);
          if (this.ctx) updateEqChain(track.eq, strip.eq, this.ctx.currentTime);
          this.routeTrackEq(track);
          this.applyGains();
        }
      }
    }
    if (moved && this.playing) {
      const pos = this.position();
      this.stopSources();
      this.schedule(pos);
    } else {
      this.notify();
    }
  }

  /** Decode and mount every stream of a take, making it the SELECTED one.
   * Other mounted takes are released; a take the look-ahead already mounted
   * PROMOTES without a re-decode. Mixer state lives on the lane
   * (`channelOf`), so it carries across takes untouched. The transport
   * parks at the take's arrangement base. */
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
    if (streamIds.length > 0 && streamIds.every((id) => this.tracks.get(id)?.takeId === takeId)) {
      // Look-ahead already decoded this take: promote it. Alignment came
      // from the persisted verdict at mount time; the queue's restore/align
      // follow-ups are idempotent against it.
      for (const other of this.mountedTakeIds()) {
        if (other !== takeId) this.unmountTake(other);
      }
      this.loadedTakeId = takeId;
      this.startPos = this.takeBaseSec(takeId);
      this.error = null;
      this.alignError = null;
      this.applyGains();
      this.notify();
      return true;
    }
    this.loading = true;
    this.error = null;
    this.alignError = null;
    this.notify();
    try {
      const next = new Map<string, Track>();
      for (const streamId of streamIds) {
        const flac = await assemble(takeId, streamId);
        if (!flac) {
          this.error = `stream ${streamId.slice(0, 8)} not reconstructable yet`;
          continue;
        }
        const buffer = await this.ensureGraph().decodeAudioData(flac);
        const previous = this.tracks.get(streamId);
        const track = this.mountTrack(takeId, streamId, buffer, channelOf(streamId));
        track.alignment = previous?.alignment ?? null;
        track.drift = previous?.drift ?? null;
        next.set(streamId, track);
      }
      // Release everything the new selection doesn't cover — the previous
      // take AND look-ahead mounts (playback is paused; the window rebuilds
      // from the new position on the next play).
      for (const old of this.tracks.values()) {
        if (next.has(old.streamId)) continue;
        this.disconnectTrack(old);
      }
      this.tracks = next;
      this.loadedTakeId = takeId;
      this.startPos = this.takeBaseSec(takeId);
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

  /** Build one track's node chain and register it (shared by the selected
   * load and the look-ahead mount — the graph must be identical). Does NOT
   * touch `loadedTakeId` or transport state. */
  private mountTrack(
    takeId: string,
    streamId: string,
    buffer: AudioBuffer,
    channelKey: string,
  ): Track {
    const ctx = this.ensureGraph();
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
    const planned = this.planStream(takeId, streamId);
    const track: Track = {
      streamId,
      takeId,
      channelKey,
      clipStartSec: planned?.clipStartSec ?? 0,
      regions: planned?.regions ?? null,
      buffer,
      input,
      eq,
      gain,
      panner,
      analyser,
      scratch: new Float32Array(analyser.fftSize),
      alignment: null,
      drift: null,
      waveform: computeWaveform(buffer),
    };
    this.routeTrackEq(track);
    return track;
  }

  private planStream(takeId: string, streamId: string): SessionStreamPlan | undefined {
    const planned = this.plan.find((p) => p.takeId === takeId);
    return planned?.streams.find((s) => s.streamId === streamId);
  }

  private disconnectTrack(track: Track): void {
    track.input.disconnect();
    disconnectEqChain(track.eq);
    track.gain.disconnect();
    track.panner.disconnect();
    track.analyser.disconnect();
  }

  /** Release one mounted take: stop its (ended) sources, tear down its
   * node chains, drop its buffers. The selected take never comes through
   * here — callers guard it. */
  private unmountTake(takeId: string): void {
    for (const entry of this.sources) {
      if (entry.takeId !== takeId) continue;
      try {
        entry.node.stop();
        entry.node.disconnect();
      } catch {
        // already stopped
      }
    }
    this.sources = this.sources.filter((entry) => entry.takeId !== takeId);
    for (const track of this.takeTracks(takeId)) {
      this.disconnectTrack(track);
      this.tracks.delete(track.streamId);
      this.levels.delete(track.streamId);
    }
  }

  /** Surface an out-of-band load failure on the transport error strip.
   * Cleared by the next load attempt like every other player error. */
  reportError(message: string): void {
    this.error = message;
    this.notify();
  }

  /** Re-key loaded tracks onto (possibly new) mixer lanes: a cold desk may
   * mount tracks on streamId-keyed fallback strips before attribution
   * lands. Re-points them WITHOUT a re-decode or re-schedule — strip state
   * re-applies through node params, so playback never cuts. */
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

  /** Auto-align the loaded take: chirp correlation per track, then content
   * cross-correlation against a reference for tracks the chirp couldn't
   * place, then drift estimation. Idempotent unless `force` (auto-align
   * triggers ride on status polls). `scope` re-measures ONLY those streams,
   * keeping every other loaded track's verdict — chained into ONE lag
   * domain so the residual between any two applied streams stays ≈ 0. A
   * scope covering every loaded track (or with nothing measured to keep)
   * normalizes to the whole-take run. */
  async align(force = false, scope?: readonly string[]): Promise<void> {
    if (this.loadedTracks().length === 0 || this.aligning) return;
    if (!force && this.loadedTracks().every((t) => t.alignment !== null)) return;
    const loadedIds = new Set(this.loadedTracks().map((t) => t.streamId));
    const scoped = scope?.filter((id) => loadedIds.has(id)) ?? [];
    let scopeSet: Set<string> | null =
      scope === undefined || scoped.length === loadedIds.size ? null : new Set(scoped);
    if (scopeSet !== null && scopeSet.size === 0) return; // nothing eligible in scope
    if (scopeSet !== null) {
      const set = scopeSet;
      const keptMeasured = this.loadedTracks().some(
        (t) => !set.has(t.streamId) && t.alignment !== null,
      );
      if (!keptMeasured) scopeSet = null; // nothing to preserve → whole take
    }
    const takeId = this.loadedTakeId;
    this.aligning = true;
    this.alignError = null;
    this.notify();
    // A re-schedule mid-playback is an audible cut: fingerprint schedule
    // inputs and re-schedule ONLY when the run changed a track's timing.
    const fingerprint = () =>
      JSON.stringify(this.loadedTracks().map((t) => [t.streamId, this.timing(t)]));
    const before = fingerprint();
    try {
      await initWasm();
      await chirpAlignPass(this.loadedTracks(), scopeSet);
      demoteChirpHitsIntoContentDomain(this.loadedTracks(), scopeSet);
      await contentAlignPass(this.loadedTracks(), scopeSet);
      // Alignment offsets fix the take head; drift keeps it fixed for 45 min.
      await estimateDriftPass(this.loadedTracks(), this.alignDeltas(), this.driftCache);
      if (this.playing && fingerprint() !== before) {
        const pos = this.position();
        this.stopSources();
        this.schedule(pos);
      }
    } catch (e) {
      // A wasm/init error must read as "failed", never as "not run" — and
      // must not kill the load queue.
      this.alignError = e instanceof Error ? e.message : String(e);
    } finally {
      this.aligning = false;
      this.notify();
    }
    // Persistence hook: a completed run with measurements settles the
    // take's verdict — declined runs persist too (the verdict IS the state).
    if (
      !this.alignError &&
      takeId !== null &&
      takeId === this.loadedTakeId &&
      this.loadedTracks().some((t) => t.alignment !== null)
    ) {
      for (const listener of this.alignmentSettledListeners) listener(takeId);
    }
  }

  /** Register for settled align() runs (the persistence hook). */
  onAlignmentSettled(listener: (takeId: string) => void): () => void {
    this.alignmentSettledListeners.add(listener);
    return () => this.alignmentSettledListeners.delete(listener);
  }

  /** Reapply a persisted per-take alignment verdict: the same track fields
   * align() writes, consumed through the same timing()/planSource math —
   * parity by construction, stored audio untouched. Entries equal to the
   * current verdict are skipped (idempotent — doc echoes never cause
   * re-schedule storms); differing entries win. Returns true on change. */
  restoreAlignment(takeId: string, entries: Record<string, StoredTrackAlignment>): boolean {
    if (this.loadedTakeId !== takeId || this.aligning || this.loading) return false;
    let changed = false;
    for (const track of this.loadedTracks()) {
      const entry = entries[track.streamId];
      if (!entry) continue;
      // Normalize before comparing/applying: legacy verdicts carry no
      // method — they can only be chirp.
      const alignment: AlignmentResult = {
        ...entry.alignment,
        method: entry.alignment.method ?? "chirp",
      };
      if (
        track.alignment !== null &&
        JSON.stringify({ alignment: track.alignment, drift: track.drift }) ===
          JSON.stringify({ alignment, drift: entry.drift })
      ) {
        continue;
      }
      track.alignment = alignment;
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

  /** ONE take's applied alignment lags exactly as the schedule math
   * consumes them. PER TAKE by construction: with multiple takes mounted,
   * mixing their lag domains would tear both trims and drawn shifts. */
  private appliedAlignLagsFor(takeId: string | null): AlignLag[] {
    return this.takeTracks(takeId)
      .filter((t) => t.alignment?.applied)
      .map((t) => ({
        streamId: t.streamId,
        lagSamples: t.alignment?.lagSamples ?? 0,
        sampleRate: t.buffer.sampleRate,
        method: t.alignment?.method ?? "chirp",
      }));
  }

  /** Samples to trim from each track's head so all aligned tracks share
   * the room clock. PER TAKE: alignment is a property of one take's
   * recording, never of the session. Public form reads the SELECTED take. */
  alignDeltas(): Map<string, number> {
    return this.alignDeltasFor(this.loadedTakeId);
  }

  private alignDeltasFor(takeId: string | null): Map<string, number> {
    const spec = DEFAULT_CHIRP_SPEC;
    return normalizeAlignDeltas(
      this.appliedAlignLagsFor(takeId),
      (spec.durationMs + spec.gapMs) / 1_000,
    );
  }

  /** Visual composition of the LOADED take's alignment, derived from the
   * SAME lag set the schedule trims with — the timeline draws what plays.
   * The anchor is a DRAWING transform only: the session clock itself is
   * anchor-free (aligned audio starts at its clip's arrangement position). */
  alignShifts(): AlignShifts {
    const spec = DEFAULT_CHIRP_SPEC;
    return alignShifts(
      this.appliedAlignLagsFor(this.loadedTakeId),
      (spec.durationMs + spec.gapMs) / 1_000,
    );
  }

  private alignDelta(track: Track): number {
    return this.alignDeltasFor(track.takeId).get(track.streamId) ?? 0;
  }

  /** Drop tracks whose streams were deleted (any mounted take). Playback
   * continues with the survivors (re-scheduled from the same position);
   * an emptied player unloads entirely. */
  removeTracks(streamIds: string[]): void {
    let removed = false;
    for (const streamId of streamIds) {
      const track = this.tracks.get(streamId);
      if (!track) continue;
      this.disconnectTrack(track);
      this.tracks.delete(streamId);
      this.levels.delete(streamId);
      this.driftCache.delete(streamId);
      removed = true;
    }
    if (!removed) return;
    if (this.loadedTracks().length === 0) {
      this.pause();
      this.loadedTakeId = null;
      this.startPos = 0;
    }
    if (this.playing) {
      const pos = this.position();
      this.stopSources();
      this.schedule(pos);
    }
    this.notify();
  }

  /** The SAME schedule parameters live playback and the offline render
   * plan sources with — the parity contract. `clipDelaySec` is the
   * ABSOLUTE arrangement position: one session clock for every take. */
  private timing(track: Track): TrackTiming {
    return {
      ...this.streamTiming(track),
      clipDelaySec: track.clipStartSec,
    };
  }

  /** The stream-level half of timing() — what region plans consume.
   * Head-trim and drift stay per-STREAM: properties of the capture,
   * identical across its pieces. */
  private streamTiming(track: Track): RegionStreamTiming {
    return {
      headSec: this.headSec(track),
      ratio: this.driftRatio(track),
      bufferDurationSec: track.buffer.duration,
    };
  }

  /** Transport duration = SESSION end: the last take's end on the room
   * timeline, planned takes included. */
  duration(): number {
    return sessionEndSec(this.takeSpans());
  }

  /** The loaded take's own span (aligned end − base): the take-scoped
   * domain for song ranges, export hints, the MIDI lane. */
  takeDuration(): number {
    if (!this.loadedTakeId || this.loadedTracks().length === 0) return 0;
    return this.takeEndSec(this.loadedTakeId) - this.takeBaseSec(this.loadedTakeId);
  }

  /** Immutable inputs for the offline export path: the decoded buffers
   * (shared by reference, read-only), the SAME per-track timing playback
   * schedules with, and the resolved mixer state. TAKE-LOCAL by contract:
   * clip delays are rebased onto the take's own head. */
  renderModel(): RenderModel | null {
    if (!this.loadedTakeId || this.loadedTracks().length === 0) return null;
    return this.renderModelOfMounted(this.loadedTakeId);
  }

  /** Mixer state as the render consumes it (mute/solo folded to gain 0). */
  private stripView(channelKey: string, anySolo: boolean): RenderStripView {
    const strip = this.channel(channelKey);
    const audible = !strip.muted && (!anySolo || strip.soloed);
    return { gain: audible ? dbToLinear(strip.gainDb) : 0, pan: strip.pan, eq: { ...strip.eq } };
  }

  private renderModelOfMounted(takeId: string): RenderModel {
    const anySolo = [...this.channels.values()].some((c) => c.soloed);
    const base = this.takeBaseSec(takeId);
    return {
      takeId,
      durationSec: this.takeEndSec(takeId) - base,
      masterGain: dbToLinear(this.masterDb),
      masterPan: this.masterPan,
      masterEq: { ...this.masterEq },
      tracks: this.takeTracks(takeId).map((track) => {
        const strip = this.stripView(track.channelKey, anySolo);
        return {
          streamId: track.streamId,
          channelKey: track.channelKey,
          buffer: track.buffer,
          timing: { ...this.timing(track), clipDelaySec: track.clipStartSec - base },
          // Split regions rebased onto the take-local render timeline —
          // the same −base translation the clip delay gets.
          ...(track.regions
            ? { regions: track.regions.map((r) => ({ ...r, startSec: r.startSec - base })) }
            : {}),
          gain: strip.gain,
          pan: strip.pan,
          eq: strip.eq,
        };
      }),
    };
  }

  /** The session master render's segment list: every planned take with its
   * arrangement base and declared end, base order. The render walks these
   * through `renderModelFor` — one take decoded at a time. */
  sessionRenderPlan(): Array<{ takeId: string; baseSec: number; declaredEndSec: number }> {
    return this.plan
      .filter((p) => p.streams.length > 0)
      .map((p) => ({
        takeId: p.takeId,
        baseSec: this.takeBaseSec(p.takeId),
        declaredEndSec: this.takeEndSec(p.takeId),
      }))
      .sort((a, b) => a.baseSec - b.baseSec);
  }

  /** A take-local RenderModel for ANY planned take. Mounted takes reuse
   * their live buffers; others assemble+decode on a scratch context at the
   * live graph's rate (so persisted lag samples mean what they mean on
   * this desk). Null when the take can't be built. */
  async renderModelFor(takeId: string): Promise<RenderModel | null> {
    if (this.takeTracks(takeId).length > 0) return this.renderModelOfMounted(takeId);
    const planned = this.plan.find((p) => p.takeId === takeId);
    if (!planned || planned.streams.length === 0 || !this.sessionSources) return null;
    const decoded: Array<{ plan: SessionStreamPlan; buffer: AudioBuffer }> = [];
    for (const stream of planned.streams) {
      const flac = await this.sessionSources.assemble(takeId, stream.streamId);
      if (!flac) return null; // not reconstructable: an honest miss, not silence
      const scratch = new OfflineAudioContext(1, 1, this.ctx?.sampleRate ?? 48_000);
      decoded.push({ plan: stream, buffer: await scratch.decodeAudioData(flac) });
    }
    const entries = this.sessionSources.storedAlignment(takeId) ?? {};
    const anySolo = [...this.channels.values()].some((c) => c.soloed);
    return plannedRenderModel(
      takeId,
      decoded,
      entries,
      (channelKey) => this.stripView(channelKey, anySolo),
      { gain: dbToLinear(this.masterDb), pan: this.masterPan, eq: { ...this.masterEq } },
    );
  }

  position(): number {
    if (!this.playing || !this.ctx) return this.startPos;
    // schedule() starts sources 0.06 s in the future; until that pre-roll
    // elapses no audio has been consumed, so the playhead HOLDS at startPos
    // instead of regressing below it (rapid play/pause walked it back).
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
    // Play from the parked end returns to the top of the room timeline.
    this.schedule(pos >= this.duration() - 0.05 ? 0 : pos);
    // Kick the mount window immediately: a play landing just before a
    // boundary must not wait for the meter loop's first poll.
    this.ensureLookahead();
  }

  /** One planner per SOURCE NODE a track needs: the verbatim whole-stream
   * planSource for never-split tracks, or one planner per region. Region
   * plans carry `playSec` (source.start's duration arg — buffer-domain, so
   * the stop lands sample-accurately regardless of playbackRate);
   * whole-stream plans deliberately DON'T (the node plays out its buffer,
   * byte-identical to the two-arg start). */
  private sourcePlanners(
    track: Track,
  ): Array<(fromSec: number) => { whenSec: number; offsetSec: number; playSec?: number } | null> {
    if (track.regions) {
      const t = this.streamTiming(track);
      return track.regions.map(
        (region) => (fromSec: number) => planRegionSource(t, region, fromSec),
      );
    }
    return [(fromSec: number) => planSource(this.timing(track), fromSec)];
  }

  private schedule(fromSec: number): void {
    const ctx = this.ensureGraph();
    const when = ctx.currentTime + 0.06;
    // Timeline→buffer mapping (head trim, drift ratio, clip delay) is the
    // shared planSource/planRegionSource — identical for playback and
    // export by design. ONE pass covers whatever the mount window holds:
    // future takes get future starts, passed ones plan null.
    for (const track of this.tracks.values()) {
      const ratio = this.driftRatio(track);
      for (const planAt of this.sourcePlanners(track)) {
        const plan = planAt(fromSec);
        if (!plan) continue;
        const source = ctx.createBufferSource();
        source.buffer = track.buffer;
        source.playbackRate.value = ratio;
        source.connect(track.input);
        if (plan.playSec !== undefined) {
          source.start(when + plan.whenSec, plan.offsetSec, plan.playSec);
        } else {
          source.start(when + plan.whenSec, plan.offsetSec);
        }
        this.sources.push({ node: source, takeId: track.takeId });
      }
    }
    this.startCtxTime = when;
    this.startPos = fromSec;
    this.playing = true;
    this.scheduleCount += 1;
    this.startMeterLoop();
    this.notify();
  }

  /** Boundary handoff: schedule ONE freshly mounted take's sources onto
   * the RUNNING clock grid — startCtxTime anchors the same origin the
   * rolling sources were planned against, so the new take's room offset is
   * sample-exact relative to them. Never touches what is already playing;
   * counts as one schedule pass. */
  private scheduleTake(takeId: string): void {
    const ctx = this.ensureGraph();
    let scheduled = false;
    for (const track of this.takeTracks(takeId)) {
      const ratio = this.driftRatio(track);
      for (const planAt of this.sourcePlanners(track)) {
        let plan = planAt(this.startPos);
        if (!plan) continue;
        let when = this.startCtxTime + plan.whenSec;
        if (when < ctx.currentTime + 0.02) {
          // The decode landed after the take's start passed (late mount):
          // start NOW at the current session position instead of replaying
          // from its head.
          const now = ctx.currentTime + 0.02;
          const posNow = this.startPos + (now - this.startCtxTime);
          const late = planAt(posNow);
          if (!late) continue;
          plan = late;
          when = now + late.whenSec;
        }
        const source = ctx.createBufferSource();
        source.buffer = track.buffer;
        source.playbackRate.value = ratio;
        source.connect(track.input);
        if (plan.playSec !== undefined) {
          source.start(when, plan.offsetSec, plan.playSec);
        } else {
          source.start(when, plan.offsetSec);
        }
        this.sources.push({ node: source, takeId });
        scheduled = true;
      }
    }
    if (!scheduled) return;
    this.scheduleCount += 1;
    this.notify();
  }

  /** The rolling mount window: release takes safely behind the playhead,
   * then decode the next take the room timeline needs (one at a time,
   * nearest first). Runs on play(), on a throttled meter-loop poll, and on
   * every seek — paused included, so a parked transport already holds the
   * takes its position would play. */
  private ensureLookahead(): void {
    if (!this.sessionSources) return;
    const pos = this.position();
    const spans = this.takeSpans();
    for (const takeId of takesToRelease(
      spans,
      this.mountedTakeIds(),
      pos,
      this.loadedTakeId,
      RELEASE_MARGIN_SEC,
    )) {
      this.unmountTake(takeId);
    }
    if (this.decodingTakeId !== null) return; // serialized decode
    const [nextTakeId] = takesToMount(
      spans,
      (takeId) => this.takeTracks(takeId).length > 0,
      pos,
      LOOKAHEAD_SEC,
    );
    if (nextTakeId) void this.mountAhead(nextTakeId);
  }

  /** Decode + mount one take for the look-ahead window: assemble, decode
   * into the LIVE context, apply the persisted verdict so the first
   * schedule is already aligned, then hand off onto the running clock. A
   * failure surfaces on the error strip but never stops the transport. */
  private async mountAhead(takeId: string): Promise<void> {
    const sources = this.sessionSources;
    if (!sources) return;
    this.decodingTakeId = takeId;
    try {
      const planned = this.plan.find((p) => p.takeId === takeId);
      if (!planned) return;
      const mounted: Track[] = [];
      for (const stream of planned.streams) {
        const flac = await sources.assemble(takeId, stream.streamId);
        if (!flac) throw new Error(`stream ${stream.streamId.slice(0, 8)} not reconstructable`);
        const buffer = await this.ensureGraph().decodeAudioData(flac);
        mounted.push(this.mountTrack(takeId, stream.streamId, buffer, stream.channelKey));
      }
      // The plan may have moved on while we decoded (session switch, take
      // delete): a mount nobody asked for is discarded, not registered.
      if (!this.plan.some((p) => p.takeId === takeId)) {
        for (const track of mounted) this.disconnectTrack(track);
        return;
      }
      const entries = sources.storedAlignment(takeId);
      for (const track of mounted) {
        const entry = entries?.[track.streamId];
        if (!entry) continue; // no verdict: honest unaligned playback
        track.alignment = { ...entry.alignment, method: entry.alignment.method ?? "chirp" };
        track.drift = entry.drift ? { ...entry.drift } : null;
      }
      for (const track of mounted) this.tracks.set(track.streamId, track);
      this.applyGains();
      if (this.playing) this.scheduleTake(takeId);
      else this.notify();
    } catch (e) {
      this.error = `take ${takeId.slice(0, 8)} decode failed: ${e instanceof Error ? e.message : String(e)}`;
      this.notify();
    } finally {
      this.decodingTakeId = null;
    }
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
    // Re-point the mount window NOW instead of waiting for the meter
    // loop's 500 ms poll; a PAUSED seek pre-mounts too. Fire-and-forget:
    // if Play beats the decode, the completion hands off mid-roll.
    this.ensureLookahead();
  }

  // Channel-strip controls: keyed by lane, valid at ANY time — before the
  // first load, while recording, across take switches.

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
      // Rolling mount window: the raf runs at 60 Hz, the window math needs
      // ~2 Hz — decode kicks are throttled, decodes run async off this loop.
      const nowMs = performance.now();
      if (nowMs - this.lastLookaheadMs > LOOKAHEAD_POLL_MS) {
        this.lastLookaheadMs = nowMs;
        this.ensureLookahead();
      }
      if (this.position() >= this.duration() - 0.02) {
        // End of SESSION = EXACTLY a user pause on the last frame: startPos
        // parks at the end and Play from here returns to the session top.
        // Return WITHOUT re-arming — pause() stopped the meter loop, and
        // re-arming would strand a stale raf id that gates the next
        // startMeterLoop, freezing playhead/meters on the next play.
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
    for (const { node } of this.sources) {
      try {
        node.stop();
        node.disconnect();
      } catch {
        // already stopped
      }
    }
    this.sources = [];
  }
}
