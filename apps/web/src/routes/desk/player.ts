// Session playback engine (W6-B): the transport runs the whole SESSION
// timeline — every take at its room offset, silence in the gaps — through
// per-track EQ → gain → pan → analyser → master EQ → master gain → master
// pan → analyser → speakers. Position/seek/duration are absolute session
// (arrangement) seconds; take-scoped data (markers, comments, exports)
// stays take-local and the desk converts at the UI boundary.
//
// Memory is bounded by a rolling mount window, not by decoding everything:
// the SELECTED take is always mounted (the F5 load queue path, unchanged);
// while playing, a look-ahead mounts the next take on the room timeline
// before its start arrives and schedules its sources into the SAME
// AudioContext on the running clock grid — a seamless handoff, one extra
// schedule pass per boundary, never a re-schedule of what is already
// rolling. Passed takes release their buffers once safely behind the
// playhead. Gaps schedule nothing; the clock just runs.
//
// Alignment offsets from chirp correlation — or, when no usable chirp is
// present, from content cross-correlation against a reference stream
// (W4-B) — and per-stream drift ratios stay PER TAKE and are applied at
// schedule time — stored audio is never touched (RFC §13). Look-ahead
// mounts reapply the take's persisted verdict (F7b) before their first
// schedule, so a boundary handoff never causes a mid-roll re-schedule.

import {
  align_content,
  DriftEstimator,
  find_chirp_offset,
  init as initWasm,
} from "@antiphon/core-wasm";
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
import type { RenderModel, RenderTrackModel } from "./render";
import {
  type AlignLag,
  type AlignMethod,
  type AlignShifts,
  alignShifts,
  normalizeAlignDeltas,
  planSource,
  type SessionTakeSpan,
  sessionEndSec,
  type TrackTiming,
  takesToMount,
  takesToRelease,
  trackEndSec,
  wrapLag,
} from "./timeline-math";

const MIN_DB = -60;
const MAX_DB = 6;
/** Correlate against at most this much of the stream head (chirp). */
const ALIGN_WINDOW_SECONDS = 25;
/** Content correlation head window: pre-roll offsets are arming spread
 * (seconds at worst), so both live in the head — and the slice caps what
 * crosses the wasm boundary (the dsp side caps at 60 s anyway). */
const CONTENT_WINDOW_SECONDS = 60;
/** CHIRP correlation accept threshold. The chirp is a matched filter with
 * its own sidelobe statistics — W1-A calibrated this bar and it stays
 * put. Exported so the toolbar's declined readout can show the honest
 * comparison (F7a). */
export const ALIGN_MIN_CONFIDENCE = 2.5;
/** CONTENT correlation accept threshold — deliberately STRICTER than the
 * chirp bar. The two confidence scales are comparable (peak-to-sidelobe
 * based) but their tail statistics are not: QA round-2 calibration put the
 * uncorrelated-content false-accept tail at 2.62 (1/200) while the lowest
 * honest content accept observed anywhere was 3.41 — 2.75 splits that gap
 * with margin on both sides. The chirp path saw no false accepts near its
 * bar, so the thresholds diverge on purpose; keep them separate constants
 * and recalibrate them independently. Mirrored by the dsp calibration
 * tests' ACCEPT pin (packages/dsp/src/content.rs). */
export const CONTENT_MIN_CONFIDENCE = 2.75;
/** Drift guard rails: below this confidence, or beyond this |ratio−1|,
 * fall back to ratio 1 — a wrong ratio is worse than uncorrected drift,
 * and real ADC crystals never miss by a full 1000 ppm. */
const DRIFT_MIN_CONFIDENCE = 0.5;
const DRIFT_MAX_PPM = 1_000;
/** Look-ahead window: a take starting within this many seconds of the
 * playhead gets decoded NOW. Sized for a comfortable assemble+decode of a
 * multi-minute take (decodeAudioData runs well over 50× realtime; OPFS
 * assembly is the slower half) with margin for a loaded machine. */
const LOOKAHEAD_SEC = 15;
/** A mounted take releases its buffers once its end is this far behind
 * the playhead — close enough to bound memory, far enough that a small
 * backwards scrub doesn't thrash decode. */
const RELEASE_MARGIN_SEC = 5;
/** Look-ahead poll cadence inside the meter loop (raf runs at 60 Hz; the
 * window math needs nothing near that). */
const LOOKAHEAD_POLL_MS = 500;

export interface AlignmentResult {
  lagSamples: number;
  confidence: number;
  applied: boolean;
  /** How the lag was measured (W4-B). Absent — legacy pre-content
   * verdicts, or entries applied through untyped hooks — means chirp. */
  method?: AlignMethod;
}

/** One auto-align run's honest verdict for the toolbar (F7a), derived from
 * per-track state — so a persisted verdict restored after a reload reads
 * exactly like a freshly measured one. Null = never ran on this take.
 * `method` distinguishes chirp-aligned from content-aligned (and `mixed`
 * when chirp anchored most tracks and content rescued the rest). */
export type AlignmentOutcome =
  | {
      kind: "aligned";
      trackCount: number;
      referenceStreamId: string | null;
      method: AlignMethod | "mixed";
    }
  | {
      kind: "declined";
      confidence: number;
      /** The accept bar the best measurement failed — the content bar
       * (2.75) when the best-confidence track was content-measured, else
       * the chirp bar (2.5). The readout must compare like with like. */
      threshold: number;
    }
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
  /** Absolute SESSION (arrangement) seconds — the transport clock (W6-B). */
  positionSec: number;
  /** Session end: the last take's aligned end. The transport's end-stop. */
  durationSec: number;
  /** The LOADED take's own span (its aligned end minus its base) — the
   * domain of take-scoped UI: song spans, per-take export hints, the MIDI
   * lane. Kept separate from `durationSec` on purpose: the transport runs
   * the session, the editing surfaces stay per-take. */
  takeDurationSec: number;
  /** Takes currently holding decoded buffers (diagnostics/e2e: the memory
   * bound is selected + current + look-ahead, plus a release-margin
   * transient). */
  mountedTakeIds: string[];
  /** Peak level per mixer lane across ALL mounted takes — the lane meters
   * must follow whatever take is audible, not just the selected one. */
  channelLevels: Record<string, number>;
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

/** One stream of the SESSION plan: where its clip sits on the arrangement
 * and how long the archive says it is (pre-alignment — head-trims refine
 * the end once decoded). */
export interface SessionStreamPlan {
  streamId: string;
  /** Mixer lane (performer) the stream plays through. */
  channelKey: string;
  /** Absolute arrangement position of the clip (override or take slot). */
  clipStartSec: number;
  /** Declared stream length: totalSamples / sample rate. */
  declaredDurationSec: number;
}

/** One take of the session plan — only COMPLETE streams belong here (the
 * live take and unassembled streams are not playable material). */
export interface SessionTakePlan {
  takeId: string;
  streams: SessionStreamPlan[];
}

/** What the engine needs to mount takes WITHOUT a selection: OPFS stream
 * assembly and the persisted per-take alignment verdict (F7b). Wired once
 * by the desk (use-desk.ts). */
export interface SessionSources {
  assemble(takeId: string, streamId: string): Promise<ArrayBuffer | null>;
  storedAlignment(takeId: string): Record<string, StoredTrackAlignment> | null;
}

interface Track {
  streamId: string;
  /** The take this stream belongs to — the mount window's unit. */
  takeId: string;
  channelKey: string;
  /** Absolute arrangement position of the clip (session plan). */
  clipStartSec: number;
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
  /** Drift estimates survive take switches like waveforms do; keyed by
   * stream, valid only for the (reference, head-trim) pair they were
   * measured against. */
  private readonly driftCache = new Map<
    string,
    { referenceId: string; refDelta: number; trackDelta: number; result: DriftResult }
  >();
  /** Scheduled sources, tagged by take so a released take can stop its
   * own (already-ended) nodes and free their buffer references. */
  private sources: Array<{ node: AudioBufferSourceNode; takeId: string }> = [];
  /** The session plan (desk → engine): every playable take's streams with
   * absolute clip starts and declared lengths. THE source of the session
   * timeline — duration(), look-ahead targets, render segments. */
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
    const measured = this.loadedTracks().filter((t) => t.alignment !== null);
    if (measured.length === 0) return null;
    const applied = measured.filter((t) => t.alignment?.applied);
    if (applied.length > 0) {
      const reference = applied.find((t) => t.drift?.isReference) ?? null;
      const methods = new Set<AlignMethod>(applied.map((t) => t.alignment?.method ?? "chirp"));
      return {
        kind: "aligned",
        trackCount: applied.length,
        referenceStreamId: reference?.streamId ?? null,
        method: methods.size > 1 ? "mixed" : methods.has("content") ? "content" : "chirp",
      };
    }
    const best = measured.reduce((a, b) =>
      (b.alignment?.confidence ?? 0) > (a.alignment?.confidence ?? 0) ? b : a,
    );
    return {
      kind: "declined",
      confidence: best.alignment?.confidence ?? 0,
      threshold:
        (best.alignment?.method ?? "chirp") === "content"
          ? CONTENT_MIN_CONFIDENCE
          : ALIGN_MIN_CONFIDENCE,
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

  // ---- mount-window accessors (W6-B) --------------------------------------------

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
   * tracks first (exact), else the plan, else 0 (pre-plan unit paths). */
  private takeBaseSec(takeId: string | null): number {
    if (takeId === null) return 0;
    const mounted = this.takeTracks(takeId);
    if (mounted.length > 0) return Math.min(...mounted.map((t) => t.clipStartSec));
    const planned = this.plan.find((p) => p.takeId === takeId);
    if (planned && planned.streams.length > 0) {
      return Math.min(...planned.streams.map((s) => s.clipStartSec));
    }
    return 0;
  }

  /** A take's end on the arrangement: aligned (mounted) or declared. */
  private takeEndSec(takeId: string): number {
    const mounted = this.takeTracks(takeId);
    if (mounted.length > 0) {
      return Math.max(...mounted.map((t) => trackEndSec(this.timing(t))));
    }
    const planned = this.plan.find((p) => p.takeId === takeId);
    if (planned && planned.streams.length > 0) {
      return Math.max(...planned.streams.map((s) => s.clipStartSec + s.declaredDurationSec));
    }
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

  /** Publish the session plan (desk → engine). Diffed internally: identical
   * content — status polls re-derive it every second — is a strict no-op.
   * A clip-start change on MOUNTED tracks re-schedules live (the audible
   * consequence must land immediately, exactly like the old per-take clip
   * delays); anything else (added/removed takes, declared-length updates)
   * just refreshes the timeline math and notifies. */
  setSessionPlan(plan: SessionTakePlan[]): void {
    const next = plan
      .filter((p) => p.streams.length > 0)
      .map((p) => ({
        takeId: p.takeId,
        streams: [...p.streams].sort((a, b) => a.streamId.localeCompare(b.streamId)),
      }));
    if (this.samePlan(next)) return;
    const known = new Set(next.map((p) => p.takeId));
    this.plan = next;
    // Mounted takes the plan dropped (deleted / re-scoped) release now —
    // removeTracks covers server-confirmed deletes, this covers the rest.
    for (const takeId of this.mountedTakeIds()) {
      if (!known.has(takeId) && takeId !== this.loadedTakeId) this.unmountTake(takeId);
    }
    // Re-point mounted tracks at their plan entries: clip moves re-schedule
    // (audible), lane re-keys re-route (parameter-only, like remapChannels).
    let moved = false;
    for (const p of next) {
      for (const s of p.streams) {
        const track = this.tracks.get(s.streamId);
        if (!track || track.takeId !== p.takeId) continue;
        if (Math.abs(track.clipStartSec - s.clipStartSec) > 1e-4) {
          track.clipStartSec = s.clipStartSec;
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

  private samePlan(next: SessionTakePlan[]): boolean {
    if (next.length !== this.plan.length) return false;
    for (let i = 0; i < next.length; i++) {
      const a = this.plan[i] as SessionTakePlan;
      const b = next[i] as SessionTakePlan;
      if (a.takeId !== b.takeId || a.streams.length !== b.streams.length) return false;
      for (let j = 0; j < a.streams.length; j++) {
        const sa = a.streams[j] as SessionStreamPlan;
        const sb = b.streams[j] as SessionStreamPlan;
        if (
          sa.streamId !== sb.streamId ||
          sa.channelKey !== sb.channelKey ||
          Math.abs(sa.clipStartSec - sb.clipStartSec) > 1e-4 ||
          Math.abs(sa.declaredDurationSec - sb.declaredDurationSec) > 1e-4
        ) {
          return false;
        }
      }
    }
    return true;
  }

  /** Decode and mount every stream of a take, making it the SELECTED one.
   * Other mounted takes are released (the look-ahead re-mounts what
   * playback needs); a take the look-ahead already mounted PROMOTES
   * without a re-decode. `channelOf` maps each stream to its mixer lane
   * (performer); mixer state lives on the lane, so it carries across takes
   * untouched. The transport parks at the take's arrangement base — the
   * same spot the old take-local domain called position 0. */
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
    const track: Track = {
      streamId,
      takeId,
      channelKey,
      clipStartSec: this.planClipStart(takeId, streamId),
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

  private planClipStart(takeId: string, streamId: string): number {
    const planned = this.plan.find((p) => p.takeId === takeId);
    return planned?.streams.find((s) => s.streamId === streamId)?.clipStartSec ?? 0;
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

  /** Auto-align the loaded take (RFC §10 + W4-B). Chirp correlation per
   * track first: the chirp position in each stream maps its sample domain
   * onto the shared room clock. Tracks the chirp couldn't place (no chirp
   * emitted, or too quiet/clipped to trust) then fall back to CONTENT
   * cross-correlation against a reference stream — near-identical clips
   * align without any calibration sweep. Idempotent unless `force`:
   * auto-align triggers ride on status polls, and both the correlation
   * cost and the final re-schedule must not repeat. */
  async align(force = false): Promise<void> {
    if (this.loadedTracks().length === 0 || this.aligning) return;
    if (!force && this.loadedTracks().every((t) => t.alignment !== null)) return;
    const takeId = this.loadedTakeId;
    this.aligning = true;
    this.alignError = null;
    this.notify();
    // Schedule inputs before the run: a re-schedule mid-playback is an
    // audible cut, so it must happen ONLY when the measurements actually
    // changed a track's timing (align runs on every take load now, and
    // W4-A's gapless invariant pins scheduleCount == 1 — a declined run
    // landing during playback must be inaudible and schedule-free).
    const fingerprint = () =>
      JSON.stringify(this.loadedTracks().map((t) => [t.streamId, this.timing(t)]));
    const before = fingerprint();
    try {
      await initWasm();
      const spec = DEFAULT_CHIRP_SPEC;
      for (const track of this.loadedTracks()) {
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
            method: "chirp",
          };
        } else {
          track.alignment = { lagSamples: 0, confidence: 0, applied: false, method: "chirp" };
        }
      }
      await this.alignContentFallback();
      // Alignment offsets fix the take head; drift keeps it fixed for 45 min.
      await this.estimateDrift();
      // Re-schedule if currently playing AND the run changed any track's
      // schedule timing, so offsets take effect audibly (see fingerprint).
      if (this.playing && fingerprint() !== before) {
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
      this.loadedTracks().some((t) => t.alignment !== null)
    ) {
      for (const listener of this.alignmentSettledListeners) listener(takeId);
    }
  }

  /** Content-based alignment for the tracks chirp correlation couldn't
   * place (W4-B — the operator's "near-identical clips won't align" P0).
   * Each chirp-declined track's head is cross-correlated against a
   * reference stream's head (dsp content module: envelope coarse pass +
   * PCM fine pass, consensus-gated); its lag is stored in the VIRTUAL
   * chirp-lag domain — the reference's own (wrapped) chirp lag plus the
   * measured signed pre-roll offset — so chirp- and content-aligned
   * tracks share one domain and the existing delta/persistence/render
   * math applies unchanged. Reference policy: the longest chirp-applied
   * track when any exist (content rescues the stragglers into the chirp
   * anchor), otherwise the longest track overall (pure content mode).
   * A failed content measurement KEEPS the honest chirp decline — the
   * verdict never fabricates. */
  private async alignContentFallback(): Promise<void> {
    const tracks = this.loadedTracks();
    if (tracks.length < 2) return; // nothing to align against
    const chirpApplied = tracks.filter((t) => t.alignment?.applied);
    if (chirpApplied.length === tracks.length) return; // chirp placed everything
    const anchors = chirpApplied.length > 0 ? chirpApplied : tracks;
    const reference = anchors.reduce((a, b) => (b.buffer.length > a.buffer.length ? b : a));
    const spec = DEFAULT_CHIRP_SPEC;
    const rate = reference.buffer.sampleRate;
    // Content lags chain onto the reference's chirp lag, wrapped exactly
    // as normalizeAlignDeltas wraps it against the applied chirp set — the
    // two computations must agree or restored deltas would tear apart.
    let refVirtualLag = 0;
    if (reference.alignment?.applied) {
      const base = Math.min(...chirpApplied.map((t) => t.alignment?.lagSamples ?? 0));
      const interval = Math.round(((spec.durationMs + spec.gapMs) / 1_000) * rate);
      refVirtualLag = base + wrapLag(reference.alignment.lagSamples - base, interval);
    }
    const refWindow = Math.min(reference.buffer.length, Math.round(rate * CONTENT_WINDOW_SECONDS));
    const refHead = reference.buffer.getChannelData(0).slice(0, refWindow);
    let bestConfidence = 0;
    for (const track of tracks) {
      if (track === reference || track.alignment?.applied) continue;
      const trackRate = track.buffer.sampleRate;
      const window = Math.min(track.buffer.length, Math.round(trackRate * CONTENT_WINDOW_SECONDS));
      const head = track.buffer.getChannelData(0).slice(0, window);
      // Yield to the UI between (potentially ~100ms) correlations.
      await new Promise((r) => setTimeout(r, 0));
      const result = align_content(refHead, head, trackRate);
      if (!result) continue; // keep the honest chirp decline
      const parsed = JSON.parse(result) as { lagSamples: number; confidence: number };
      const applied = parsed.confidence >= CONTENT_MIN_CONFIDENCE;
      track.alignment = {
        lagSamples: refVirtualLag + parsed.lagSamples,
        confidence: parsed.confidence,
        applied,
        method: "content",
      };
      if (applied) bestConfidence = Math.max(bestConfidence, parsed.confidence);
    }
    // Pure content mode: anchor the reference at lag 0 so the deltas have
    // their second point. Its confidence is the set's best pair match —
    // the anchor's verdict is only as trustworthy as what locked onto it.
    if (bestConfidence > 0 && !reference.alignment?.applied) {
      reference.alignment = {
        lagSamples: 0,
        confidence: bestConfidence,
        applied: true,
        method: "content",
      };
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
    for (const track of this.loadedTracks()) {
      const entry = entries[track.streamId];
      if (!entry) continue;
      // Normalize before comparing/applying: legacy verdicts (and untyped
      // hook entries) carry no method — they can only be chirp.
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
    const aligned = this.loadedTracks().filter((t) => deltas.has(t.streamId));
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

  /** ONE take's applied alignment lags exactly as the schedule math
   * consumes them — the single source for both the head-trim deltas below
   * and the visual shift composition (W6-C). PER TAKE by construction
   * (W6-B): with multiple takes mounted, mixing their lag domains would
   * tear both the trims and the drawn shifts. */
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
   * the room clock — the modulo-repeat normalization lives in
   * timeline-math (shared with the offline render). PER TAKE: alignment
   * is a property of one take's recording, never of the session. Public
   * form reads the SELECTED take (a pure diagnostics readout — F7 e2e
   * asserts restored deltas through it). */
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

  /** Visual composition of the LOADED take's alignment (W6-C): per-clip
   * box shifts + the room-zero anchor, derived from the SAME lag set the
   * schedule trims with (timeline-math.alignShifts) — the timeline draws
   * exactly what plays. Empty/zero until a verdict applies. Scope note
   * (W6-B × W6-C): the anchor is a DRAWING transform of the selected
   * take only — the session clock itself is anchor-free (every take's
   * aligned audio starts at its clip's arrangement position; see the
   * timing() contract), and mounted-but-unselected takes draw at capture
   * placement, W6-C's documented scope. */
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
   * plan sources with (timeline-math.planSource) — the parity contract.
   * `clipDelaySec` is the ABSOLUTE arrangement position now: one session
   * clock for every mounted take. */
  private timing(track: Track): TrackTiming {
    return {
      headSec: this.headSec(track),
      ratio: this.driftRatio(track),
      clipDelaySec: track.clipStartSec,
      bufferDurationSec: track.buffer.duration,
    };
  }

  /** Transport duration = SESSION end: the last take's end on the room
   * timeline, planned takes included (they need no decode to have an
   * extent). Mounted takes report their aligned ends. */
  duration(): number {
    return sessionEndSec(this.takeSpans());
  }

  /** The loaded take's own span (aligned end − base): the take-scoped
   * domain for song ranges, export hints, the MIDI lane. */
  takeDuration(): number {
    if (!this.loadedTakeId || this.loadedTracks().length === 0) return 0;
    return this.takeEndSec(this.loadedTakeId) - this.takeBaseSec(this.loadedTakeId);
  }

  /** Immutable inputs for the offline export path (render.ts): the decoded
   * buffers (shared by reference, read-only — stored audio is never
   * mutated), the SAME per-track timing playback schedules with, and the
   * mixer state resolved exactly as applyGains() resolves it (mute/solo →
   * gain 0). Null while nothing is loaded. TAKE-LOCAL by contract: clip
   * delays are rebased onto the take's own head, so per-take/per-song
   * exports and manifests keep their W2-A/W2-B domain untouched. */
  renderModel(): RenderModel | null {
    if (!this.loadedTakeId || this.loadedTracks().length === 0) return null;
    return this.renderModelOfMounted(this.loadedTakeId);
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
        const strip = this.channel(track.channelKey);
        const audible = !strip.muted && (!anySolo || strip.soloed);
        return {
          streamId: track.streamId,
          channelKey: track.channelKey,
          buffer: track.buffer,
          timing: { ...this.timing(track), clipDelaySec: track.clipStartSec - base },
          gain: audible ? dbToLinear(strip.gainDb) : 0,
          pan: strip.pan,
          eq: { ...strip.eq },
        };
      }),
    };
  }

  /** The session master render's segment list (W6-B): every planned take
   * with its arrangement base and declared end, base order. The render
   * walks these sequentially through `renderModelFor` — one take decoded
   * at a time, memory bounded exactly like playback. */
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
   * this desk) and apply the persisted verdict (F7b) — the same
   * timing/planSource math as playback, then the buffers go out of scope
   * with the returned model. Null when the take can't be built. */
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
    const spec = DEFAULT_CHIRP_SPEC;
    const deltas = normalizeAlignDeltas(
      decoded
        .filter(({ plan }) => entries[plan.streamId]?.alignment.applied)
        .map(({ plan, buffer }) => ({
          streamId: plan.streamId,
          lagSamples: entries[plan.streamId]?.alignment.lagSamples ?? 0,
          sampleRate: buffer.sampleRate,
          method: entries[plan.streamId]?.alignment.method ?? "chirp",
        })),
      (spec.durationMs + spec.gapMs) / 1_000,
    );
    const base = Math.min(...decoded.map(({ plan }) => plan.clipStartSec));
    const anySolo = [...this.channels.values()].some((c) => c.soloed);
    const tracks: RenderTrackModel[] = decoded.map(({ plan, buffer }) => {
      const drift = entries[plan.streamId]?.drift;
      const driftSamples = drift?.applied ? drift.initialOffsetSamples : 0;
      const strip = this.channel(plan.channelKey);
      const audible = !strip.muted && (!anySolo || strip.soloed);
      return {
        streamId: plan.streamId,
        channelKey: plan.channelKey,
        buffer,
        timing: {
          headSec: ((deltas.get(plan.streamId) ?? 0) + driftSamples) / buffer.sampleRate,
          ratio: drift?.applied ? drift.ratio : 1,
          clipDelaySec: plan.clipStartSec - base,
          bufferDurationSec: buffer.duration,
        },
        gain: audible ? dbToLinear(strip.gainDb) : 0,
        pan: strip.pan,
        eq: { ...strip.eq },
      };
    });
    return {
      takeId,
      durationSec: Math.max(...tracks.map((t) => trackEndSec(t.timing))),
      masterGain: dbToLinear(this.masterDb),
      masterPan: this.masterPan,
      masterEq: { ...this.masterEq },
      tracks,
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
    // End rule (F12, now end-of-SESSION): Play from the parked end returns
    // to the top of the room timeline.
    this.schedule(pos >= this.duration() - 0.05 ? 0 : pos);
    // Kick the mount window immediately: a play landing just before a
    // boundary must not wait for the meter loop's first poll.
    this.ensureLookahead();
  }

  private schedule(fromSec: number): void {
    const ctx = this.ensureGraph();
    const when = ctx.currentTime + 0.06;
    for (const track of this.tracks.values()) {
      // Timeline→buffer mapping (head trim, drift ratio, clip delay) is the
      // shared planSource — identical for playback and export by design.
      // Every MOUNTED take schedules here: future takes get future starts
      // (planSource's whenSec), passed ones plan null — one pass covers
      // whatever the mount window holds.
      const timing = this.timing(track);
      const plan = planSource(timing, fromSec);
      if (!plan) continue;
      const source = ctx.createBufferSource();
      source.buffer = track.buffer;
      source.playbackRate.value = timing.ratio;
      source.connect(track.input);
      source.start(when + plan.whenSec, plan.offsetSec);
      this.sources.push({ node: source, takeId: track.takeId });
    }
    this.startCtxTime = when;
    this.startPos = fromSec;
    this.playing = true;
    this.scheduleCount += 1;
    this.startMeterLoop();
    this.notify();
  }

  /** Boundary handoff (W6-B): schedule ONE freshly mounted take's sources
   * onto the RUNNING clock grid — startCtxTime anchors the same
   * origin the rolling sources were planned against, so the new take's
   * room offset is sample-exact relative to them. Never touches what is
   * already playing; counts as one schedule pass (the honest evolution of
   * W4-A's storm guard: schedules == 1 + boundary handoffs). */
  private scheduleTake(takeId: string): void {
    const ctx = this.ensureGraph();
    let scheduled = false;
    for (const track of this.takeTracks(takeId)) {
      const timing = this.timing(track);
      let plan = planSource(timing, this.startPos);
      if (!plan) continue;
      let when = this.startCtxTime + plan.whenSec;
      if (when < ctx.currentTime + 0.02) {
        // The decode landed after the take's start passed (late mount —
        // machine load, a seek straight into the take): start NOW at the
        // current session position instead of replaying from its head.
        const now = ctx.currentTime + 0.02;
        const posNow = this.startPos + (now - this.startCtxTime);
        const late = planSource(timing, posNow);
        if (!late) continue;
        plan = late;
        when = now + late.whenSec;
      }
      const source = ctx.createBufferSource();
      source.buffer = track.buffer;
      source.playbackRate.value = timing.ratio;
      source.connect(track.input);
      source.start(when, plan.offsetSec);
      this.sources.push({ node: source, takeId });
      scheduled = true;
    }
    if (!scheduled) return;
    this.scheduleCount += 1;
    this.notify();
  }

  /** The rolling mount window: release takes safely behind the playhead,
   * then decode the next take the room timeline needs (one at a time,
   * nearest first). Runs on play(), on a throttled meter-loop poll, and on
   * every seek (QA M-3) — paused included, so a parked transport already
   * holds the takes its position would play. mountAhead handles the
   * paused case (mount + notify, no schedule). */
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
   * into the LIVE context, apply the persisted alignment verdict (F7b) so
   * the first schedule is already aligned, then hand off onto the running
   * clock. A failure surfaces on the error strip but never stops the
   * transport — the session plays on with an honest hole. */
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
    // QA M-3: a seek can land anywhere on the session — re-point the mount
    // window NOW instead of waiting for the meter loop's 500 ms poll (a
    // rolling seek into an unmounted take lost ~0.5 s of its head to that
    // wait). A PAUSED seek pre-mounts too: by the time a human presses
    // Play the decode has landed and resume starts complete at the target.
    // Deliberately fire-and-forget (no await/queue machinery): if Play
    // beats the decode, the completion hands off from the live position
    // exactly like any mid-roll mount.
    this.ensureLookahead();
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
      // Rolling mount window (W6-B): the raf runs at 60 Hz, the window
      // math needs ~2 Hz — decode kicks are throttled, decodes themselves
      // run async off this loop.
      const nowMs = performance.now();
      if (nowMs - this.lastLookaheadMs > LOOKAHEAD_POLL_MS) {
        this.lastLookaheadMs = nowMs;
        this.ensureLookahead();
      }
      if (this.position() >= this.duration() - 0.02) {
        // End of SESSION (the F12 end-of-take rule, promoted with the
        // transport scope in W6-B): EXACTLY a user pause on the last
        // frame. startPos parks at the end (position() clamps to duration)
        // and pause()'s notify hands the UI the same parked position the
        // engine reports — Play from here returns to the session top
        // through play()'s own >= duration guard, the transport's one rule
        // for "play from the end". (A silent startPos = 0 here desynced
        // timecode vs engine — QA F12.) Return WITHOUT re-arming: pause()
        // stopped the meter loop, and re-arming would strand a stale raf
        // id that gates the next startMeterLoop, freezing playhead/meters
        // on the next play.
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
