// Alignment measurement for SessionPlayer: chirp correlation, content
// cross-correlation fallback, and per-stream clock-drift estimation.
// Offsets apply at schedule time only — stored audio is never mutated.

import { align_content, DriftEstimator, find_chirp_offset } from "@antiphon/core-wasm";
import { DEFAULT_CHIRP_SPEC } from "@antiphon/protocol";
import { type AlignMethod, wrapLag } from "./timeline-math";

/** Correlate against at most this much of the stream head (chirp). */
const ALIGN_WINDOW_SECONDS = 25;
/** Content correlation head window: pre-roll offsets are arming spread
 * (seconds at worst), so both live in the head — and the slice caps what
 * crosses the wasm boundary. */
const CONTENT_WINDOW_SECONDS = 60;
/** CHIRP correlation accept threshold (matched-filter sidelobe statistics).
 * Exported so the toolbar's declined readout compares like with like. */
export const ALIGN_MIN_CONFIDENCE = 2.5;
/** CONTENT correlation accept threshold — deliberately STRICTER than the
 * chirp bar: the two scales share a construction but not tail statistics.
 * Calibrated independently; mirrored by the dsp ACCEPT pin (dsp/content.rs). */
export const CONTENT_MIN_CONFIDENCE = 2.75;
/** Drift guard rails: below this confidence, or beyond this |ratio−1|,
 * fall back to ratio 1 — a wrong ratio is worse than uncorrected drift,
 * and real ADC crystals never miss by a full 1000 ppm. */
const DRIFT_MIN_CONFIDENCE = 0.5;
const DRIFT_MAX_PPM = 1_000;

export interface AlignmentResult {
  lagSamples: number;
  confidence: number;
  applied: boolean;
  /** How the lag was measured. Absent (legacy verdicts) means chirp. */
  method?: AlignMethod;
}

/** One auto-align run's verdict for the toolbar, derived from per-track
 * state — a persisted verdict restored after a reload reads exactly like a
 * freshly measured one. Null = never ran on this take. */
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
      /** The accept bar the best measurement failed — content or chirp,
       * matching how the best-confidence track was measured. */
      threshold: number;
    }
  | { kind: "failed"; message: string };

/** Persisted per-stream alignment verdict: exactly the fields align()
 * writes, restorable at schedule time with playback parity. */
export interface StoredTrackAlignment {
  alignment: AlignmentResult;
  drift: DriftResult | null;
}

/** Clock-drift fit vs the reference stream. `ratio`/`initialOffsetSamples`
 * are the values in force at schedule time: zeroed to the identity when
 * `applied` is false; `ppm`/`confidence` keep the measurement either way. */
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

/** The slice of a player track the measurement passes read and mutate. */
export interface AlignableTrack {
  streamId: string;
  buffer: AudioBuffer;
  alignment: AlignmentResult | null;
  drift: DriftResult | null;
}

/** Derive the honest align verdict from per-track state: never-ran (null),
 * aligned (any applied), declined (measured, none applied — best confidence
 * shown), or failed (align() threw). */
export function deriveAlignmentOutcome(
  alignError: string | null,
  tracks: readonly AlignableTrack[],
): AlignmentOutcome | null {
  if (alignError) return { kind: "failed", message: alignError };
  const measured = tracks.filter((t) => t.alignment !== null);
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

/** Chirp correlation per in-scope track: locate the calibration sweep in
 * the stream head, mapping its sample domain onto the shared room clock. */
export async function chirpAlignPass(
  tracks: readonly AlignableTrack[],
  scopeSet: ReadonlySet<string> | null,
): Promise<void> {
  const spec = DEFAULT_CHIRP_SPEC;
  for (const track of tracks) {
    if (scopeSet !== null && !scopeSet.has(track.streamId)) continue;
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
    if (!result) {
      track.alignment = { lagSamples: 0, confidence: 0, applied: false, method: "chirp" };
      continue;
    }
    const parsed = JSON.parse(result) as { lagSamples: number; confidence: number };
    track.alignment = {
      lagSamples: parsed.lagSamples,
      confidence: parsed.confidence,
      applied: parsed.confidence >= ALIGN_MIN_CONFIDENCE,
      method: "chirp",
    };
  }
}

/** Scoped-run domain guard: a fresh RAW chirp lag shares no origin with a
 * kept PURE-CONTENT lag domain — applying it would tear every pairwise
 * offset. Demote to unapplied; the content fallback places them instead. */
export function demoteChirpHitsIntoContentDomain(
  tracks: readonly AlignableTrack[],
  scopeSet: ReadonlySet<string> | null,
): void {
  if (scopeSet === null) return;
  const keptApplied = tracks.filter((t) => !scopeSet.has(t.streamId) && t.alignment?.applied);
  const keptChirp = keptApplied.some((t) => (t.alignment?.method ?? "chirp") === "chirp");
  if (keptApplied.length === 0 || keptChirp) return;
  for (const track of tracks) {
    if (!scopeSet.has(track.streamId)) continue;
    if (track.alignment?.applied && (track.alignment.method ?? "chirp") === "chirp") {
      track.alignment = { ...track.alignment, applied: false };
    }
  }
}

/** Content alignment for tracks chirp couldn't place: each pending lag
 * chains onto a reference's lag in the VIRTUAL chirp-lag domain so all
 * verdicts share one domain; a failed measurement keeps the chirp decline. */
export async function contentAlignPass(
  tracks: readonly AlignableTrack[],
  scope: ReadonlySet<string> | null,
): Promise<void> {
  if (tracks.length < 2) return; // nothing to align against
  const inScope = (t: AlignableTrack) => scope === null || scope.has(t.streamId);
  const pending = tracks.filter((t) => inScope(t) && !t.alignment?.applied);
  if (pending.length === 0) return; // chirp placed everything in scope
  const anchors = tracks.filter((t) => t.alignment?.applied);
  const chirpAnchors = anchors.filter((t) => (t.alignment?.method ?? "chirp") === "chirp");
  const longest = (pool: readonly AlignableTrack[]): AlignableTrack =>
    pool.reduce((a, b) => (b.buffer.length > a.buffer.length ? b : a));
  const keptReference =
    scope === null
      ? undefined
      : anchors.find((t) => !scope.has(t.streamId) && t.drift?.isReference);
  const reference =
    keptReference ??
    (chirpAnchors.length > 0
      ? longest(chirpAnchors)
      : anchors.length > 0
        ? longest(anchors)
        : longest(scope === null ? tracks : pending));
  const spec = DEFAULT_CHIRP_SPEC;
  const rate = reference.buffer.sampleRate;
  // A content reference's stored lag already IS virtual-domain; a chirp
  // reference wraps exactly as normalizeAlignDeltas wraps it against the
  // applied chirp set — the two computations must agree or deltas tear.
  let refVirtualLag = 0;
  if (reference.alignment?.applied) {
    if ((reference.alignment.method ?? "chirp") === "content") {
      refVirtualLag = reference.alignment.lagSamples;
    } else {
      const base = Math.min(...chirpAnchors.map((t) => t.alignment?.lagSamples ?? 0));
      const interval = Math.round(((spec.durationMs + spec.gapMs) / 1_000) * rate);
      refVirtualLag = base + wrapLag(reference.alignment.lagSamples - base, interval);
    }
  }
  const refWindow = Math.min(reference.buffer.length, Math.round(rate * CONTENT_WINDOW_SECONDS));
  const refHead = reference.buffer.getChannelData(0).slice(0, refWindow);
  let bestConfidence = 0;
  for (const track of pending) {
    if (track === reference) continue;
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
  // their second point. Its confidence is the set's best pair match.
  if (bestConfidence > 0 && !reference.alignment?.applied) {
    reference.alignment = {
      lagSamples: 0,
      confidence: bestConfidence,
      applied: true,
      method: "content",
    };
  }
}

/** Drift estimates survive take switches; keyed by stream, valid only for
 * the (reference, head-trim) pair they were measured against. */
export type DriftCache = Map<
  string,
  { referenceId: string; refDelta: number; trackDelta: number; result: DriftResult }
>;

/** Per-stream clock-drift estimation. The reference is the alignment anchor
 * (head-trim zero — the sample domain every other track maps onto); window
 * pairs stream through the wasm estimator with UI yields between them. */
export async function estimateDriftPass(
  tracks: readonly AlignableTrack[],
  deltas: ReadonlyMap<string, number>,
  cache: DriftCache,
): Promise<void> {
  if (deltas.size < 2) return; // no anchor to drift against
  const aligned = tracks.filter((t) => deltas.has(t.streamId));
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
    const cached = cache.get(track.streamId);
    if (
      cached &&
      cached.referenceId === reference.streamId &&
      cached.refDelta === refDelta &&
      cached.trackDelta === trackDelta
    ) {
      track.drift = cached.result;
      continue;
    }
    const result = await estimateTrackDrift(track, refData, refDelta, trackDelta);
    track.drift = result;
    cache.set(track.streamId, {
      referenceId: reference.streamId,
      refDelta,
      trackDelta,
      result,
    });
  }
}

/** Drive the pull-based wasm estimator for one track, then apply the guard
 * rails: an implausible or low-confidence fit degrades to ratio 1 (the
 * measurement is kept for diagnostics). */
async function estimateTrackDrift(
  track: AlignableTrack,
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
