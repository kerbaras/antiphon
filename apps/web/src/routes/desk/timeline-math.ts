// Pure room-timeline math shared by live playback (player.ts) and the
// offline render (render.ts): both plan their AudioBufferSourceNodes
// through the SAME functions, so export parity holds by construction.

/** Per-track schedule parameters. All values are seconds; `headSec`,
 * `bufferDurationSec` and the planned offset live in the track's own
 * buffer-time domain, `clipDelaySec` and `fromSec` on the shared room
 * timeline. */
export interface TrackTiming {
  /** Buffer seconds consumed before the track's room-time zero: chirp
   * head-trim plus the drift fit's residual offset. */
  headSec: number;
  /** Drift playback-rate factor, target_clock/reference_clock (1 = off). */
  ratio: number;
  /** Arrangement position of the clip on the room timeline (≥ 0). */
  clipDelaySec: number;
  /** Total decoded buffer duration. */
  bufferDurationSec: number;
}

export interface SourcePlan {
  /** Context-time delay before the source starts (≥ 0). */
  whenSec: number;
  /** Buffer offset to start playing from. */
  offsetSec: number;
}

/** Plan an AudioBufferSourceNode start for room-timeline position
 * `fromSec`. Timeline time t maps to buffer time headSec + (t −
 * clipDelay)·ratio: a fast target clock packed more samples into each
 * room-second, so playbackRate = ratio consumes them at exactly one
 * room-second per second (±200 ppm is far below audible pitch change).
 * Returns null when the track holds no audio at or after `fromSec`. */
export function planSource(t: TrackTiming, fromSec: number): SourcePlan | null {
  const rel = fromSec - t.clipDelaySec;
  if (rel >= 0) {
    const offsetSec = t.headSec + rel * t.ratio;
    if (offsetSec >= t.bufferDurationSec) return null;
    return { whenSec: 0, offsetSec };
  }
  // Clip begins later on the timeline: schedule its future start.
  return { whenSec: -rel, offsetSec: t.headSec };
}

/** Room-timeline position where the track's audio ends — buffer seconds
 * shrink by the drift ratio on the room timeline. */
export function trackEndSec(t: TrackTiming): number {
  return t.clipDelaySec + (t.bufferDurationSec - t.headSec) / t.ratio;
}

// ---- clip regions ------------------------------------------------------------------
// Buffer time b plays at t = (startSec − sourceOffsetSec) + (b − headSec)/ratio:
// the whole-stream rule translated per region, so abutting fresh-split pieces
// reproduce the uncut mapping exactly. Unsplit streams keep planSource verbatim.

/** One region as the schedule math consumes it (the doc's ClipRegion minus
 * identity — net/collab-doc.ts owns the wire shape). */
export interface RegionSpan {
  /** Arrangement position of the region (audio domain, like clipDelaySec). */
  startSec: number;
  /** Source-buffer seconds where the region's material begins (raw buffer
   * domain — alignment trims stay schedule-time, never stored). */
  sourceOffsetSec: number;
  /** Region length in source seconds. */
  durationSec: number;
}

/** The stream-level schedule parameters a region plan needs — TrackTiming
 * without clipDelaySec (a split stream has no single clip position). */
export type RegionStreamTiming = Omit<TrackTiming, "clipDelaySec">;

export interface RegionPlan {
  /** Context-time delay before the source starts (≥ 0). */
  whenSec: number;
  /** Buffer offset to start playing from. */
  offsetSec: number;
  /** SOURCE seconds to play — AudioBufferSourceNode.start()'s duration
   * argument (buffer-domain per the Web Audio spec, so the stop lands
   * sample-accurately at the region's end regardless of playbackRate). */
  playSec: number;
}

/** The audible window of a region in buffer seconds: never before the
 * alignment head-trim (that material is what alignment trims — it never
 * plays, split or not), never past the buffer or the region end. */
function regionWindow(t: RegionStreamTiming, r: RegionSpan): { lo: number; hi: number } {
  return {
    lo: Math.max(r.sourceOffsetSec, t.headSec),
    hi: Math.min(r.sourceOffsetSec + r.durationSec, t.bufferDurationSec),
  };
}

/** Room-timeline span of a region's audible audio. Empty regions (fully
 * inside the trimmed head, or windows past the buffer) report a zero-length
 * span at their would-be start. */
export function regionSpanSec(
  t: RegionStreamTiming,
  r: RegionSpan,
): { startSec: number; endSec: number } {
  const { lo, hi } = regionWindow(t, r);
  const delay = r.startSec - r.sourceOffsetSec;
  const startSec = delay + (lo - t.headSec) / t.ratio;
  return { startSec, endSec: Math.max(startSec, delay + (hi - t.headSec) / t.ratio) };
}

/** Plan one region's AudioBufferSourceNode for room-timeline position
 * `fromSec` — planSource's region twin, with the extra stop: the source
 * must play EXACTLY the region's window and no further (the next region,
 * or silence, owns what follows). Null when the region holds no audio at
 * or after `fromSec`. */
export function planRegionSource(
  t: RegionStreamTiming,
  r: RegionSpan,
  fromSec: number,
): RegionPlan | null {
  const { lo, hi } = regionWindow(t, r);
  if (hi <= lo) return null; // nothing audible (trimmed away / out of buffer)
  const delay = r.startSec - r.sourceOffsetSec;
  const startSec = delay + (lo - t.headSec) / t.ratio;
  const endSec = delay + (hi - t.headSec) / t.ratio;
  if (fromSec >= endSec) return null;
  if (fromSec >= startSec) {
    const offsetSec = t.headSec + (fromSec - delay) * t.ratio;
    return { whenSec: 0, offsetSec, playSec: hi - offsetSec };
  }
  // Region begins later on the timeline: schedule its future start.
  return { whenSec: startSec - fromSec, offsetSec: lo, playSec: hi - lo };
}

/** Room-timeline end of a region list (the split analogue of trackEndSec). */
export function regionsEndSec(t: RegionStreamTiming, regions: readonly RegionSpan[]): number {
  let end = 0;
  for (const r of regions) end = Math.max(end, regionSpanSec(t, r).endSec);
  return end;
}

/** How a track's alignment lag was measured: `chirp` = calibration sweep
 * located in the stream; `content` = cross-correlation against a reference
 * stream, expressed in the same virtual lag domain (reference lag + offset). */
export type AlignMethod = "chirp" | "content";

export interface AlignLag {
  streamId: string;
  /** Alignment lag in the stream's own samples (see AlignMethod). */
  lagSamples: number;
  sampleRate: number;
  /** Absent (legacy verdicts) means chirp. */
  method?: AlignMethod;
}

/** Wrap a lag difference to the nearest repeat of `intervalSamples` —
 * resolves which-sweep-did-I-lock-onto ambiguity between chirp lags. */
export function wrapLag(raw: number, intervalSamples: number): number {
  return raw - Math.round(raw / intervalSamples) * intervalSamples;
}

/** Samples to trim from each track's head so aligned tracks share the room
 * clock. Chirp lags may lock onto different sweep repeats, so their deltas
 * normalize modulo the repeat interval; content lags have no repeat
 * ambiguity and pass through unwrapped. Fewer than two lags: no deltas. */
export function normalizeAlignDeltas(
  lags: AlignLag[],
  repeatIntervalSec: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (lags.length < 2) return out;
  // The wrap base must come from the chirp domain when one exists: content
  // lags are built ON a chirp reference lag (player.align), so wrapping
  // them against a content minimum would tear the two domains apart.
  const chirp = lags.filter((l) => (l.method ?? "chirp") === "chirp");
  const anchored = chirp.length > 0 ? chirp : lags;
  const base = Math.min(...anchored.map((l) => l.lagSamples));
  const normalized = lags.map((l) => {
    const raw = l.lagSamples - base;
    if ((l.method ?? "chirp") === "content") return [l.streamId, raw] as const;
    const interval = Math.round(repeatIntervalSec * l.sampleRate);
    return [l.streamId, wrapLag(raw, interval)] as const;
  });
  const min = Math.min(...normalized.map(([, d]) => d));
  for (const [streamId, d] of normalized) out.set(streamId, d - min);
  return out;
}

/** Visual composition of the applied head-trims. Alignment is schedule-time
 * only (stored audio and arrangement positions never move); these shifts are
 * pure DRAWING transforms derived from the same deltas the schedule trims
 * with, so what is drawn is what plays. */
export interface AlignShifts {
  /** streamId → seconds the clip box sits right of its arrangement position. */
  shiftSec: Map<string, number>;
  /** Arrangement offset of room-time zero (max head-trim, seconds ≥ 0) —
   * the playhead's drawing shift, doubling as the shift for streams
   * without an applied lag. */
  anchorSec: number;
}

export function alignShifts(lags: AlignLag[], repeatIntervalSec: number): AlignShifts {
  const deltas = normalizeAlignDeltas(lags, repeatIntervalSec);
  const rateOf = new Map(lags.map((l) => [l.streamId, l.sampleRate]));
  const deltaSec = new Map<string, number>();
  let anchorSec = 0;
  for (const [streamId, delta] of deltas) {
    const sec = delta / (rateOf.get(streamId) as number);
    deltaSec.set(streamId, sec);
    anchorSec = Math.max(anchorSec, sec);
  }
  const shiftSec = new Map<string, number>();
  for (const [streamId, sec] of deltaSec) shiftSec.set(streamId, anchorSec - sec);
  return { shiftSec, anchorSec };
}

// ---- every take draws aligned -----------------------------------------------------
// The loaded take composes shifts from LIVE player state; every other take
// from its PERSISTED verdict — stored entries yield the same AlignShifts.

/** One stream's persisted verdict as the drawing layer consumes it — the
 * alignment-persist entry shape, structurally (no import cycle with
 * player.ts). Lags are in stream samples at the desk's capture rate. */
export interface PersistedAlignmentLag {
  alignment: { lagSamples: number; applied: boolean; method?: AlignMethod };
}

/** AlignShifts of a take that is NOT loaded, from its persisted verdict —
 * the exact alignShifts composition the live path produces. Unapplied/absent
 * entries contribute nothing; a declined take draws unshifted (anchor 0). */
export function persistedAlignShifts(
  entries: Readonly<Record<string, PersistedAlignmentLag>>,
  sampleRate: number,
  repeatIntervalSec: number,
): AlignShifts {
  const lags: AlignLag[] = Object.entries(entries)
    .filter(([, entry]) => entry.alignment.applied)
    .map(([streamId, entry]) => ({
      streamId,
      lagSamples: entry.alignment.lagSamples,
      sampleRate,
      method: entry.alignment.method ?? "chirp",
    }));
  return alignShifts(lags, repeatIntervalSec);
}

/** One take's AUDIO span on the arrangement (un-shifted positions — the
 * player's clock domain) with the drawing anchor its verdict composes. */
export interface TakeAnchorSpan {
  startSec: number;
  endSec: number;
  anchorSec: number;
}

/** The drawing anchor in force at an arrangement position: the containing
 * take's anchor, 0 in gaps and beyond the session — the playhead rides the
 * drawn waveforms of whatever take its audio comes from. First match wins
 * as the defensive tie-break should a dragged arrangement overlap spans. */
export function anchorAtSec(spans: readonly TakeAnchorSpan[], posSec: number): number {
  for (const span of spans) {
    if (posSec >= span.startSec && posSec <= span.endSec) return span.anchorSec;
  }
  return 0;
}

// ---- session spans and the look-ahead scheduler -----------------------------------
// The pure half of the engine's memory-bounded decode: which takes must be
// mounted for the next stretch of playback, and which are safely behind.
// Takes never overlap on the room clock (the desk lays them out
// sequentially), so a rolling mount window is enough.

/** One take's extent on the session (arrangement) timeline. `endSec` is the
 * best current estimate: the aligned end for a mounted take, the declared
 * stream length otherwise (head-trims move it by fractions of a second). */
export interface SessionTakeSpan {
  takeId: string;
  startSec: number;
  endSec: number;
}

/** Where session playback stops: the last take's end (0 with no takes). */
export function sessionEndSec(spans: readonly SessionTakeSpan[]): number {
  let end = 0;
  for (const span of spans) end = Math.max(end, span.endSec);
  return end;
}

/** Where session content begins: the first clip's start (0 with none).
 * The session master render starts HERE, not at arrangement zero — the
 * leading second is desk furniture, not recorded silence. */
export function sessionStartSec(spans: readonly SessionTakeSpan[]): number {
  let start = Number.POSITIVE_INFINITY;
  for (const span of spans) start = Math.min(start, span.startSec);
  return Number.isFinite(start) ? start : 0;
}

/** Takes that must be decoded for playback to continue seamlessly: spans
 * intersecting [posSec, posSec + aheadSec) that are not mounted yet, in
 * start order — the caller decodes them one at a time, nearest first. */
export function takesToMount(
  spans: readonly SessionTakeSpan[],
  isMounted: (takeId: string) => boolean,
  posSec: number,
  aheadSec: number,
): string[] {
  return [...spans]
    .filter(
      (span) =>
        !isMounted(span.takeId) && span.endSec > posSec && span.startSec < posSec + aheadSec,
    )
    .sort((a, b) => a.startSec - b.startSec)
    .map((span) => span.takeId);
}

/** Mounted takes whose audio is safely behind the playhead: ended more than
 * `marginSec` ago and not the protected (selected) take. Their buffers can
 * be released — a backwards seek re-decodes through the mount path. */
export function takesToRelease(
  spans: readonly SessionTakeSpan[],
  mountedTakeIds: readonly string[],
  posSec: number,
  keepTakeId: string | null,
  marginSec: number,
): string[] {
  const endOf = new Map(spans.map((span) => [span.takeId, span.endSec]));
  return mountedTakeIds.filter((takeId) => {
    if (takeId === keepTakeId) return false;
    const end = endOf.get(takeId);
    // A mounted take the plan no longer knows is stale — release it too.
    return end === undefined || end < posSec - marginSec;
  });
}

/** Optional export range on the take's room timeline — the same domain as
 * player positions/seeks (0 = take head after alignment). Omitted bounds
 * mean whole-take. */
export interface RenderRange {
  startSec?: number;
  endSec?: number;
}

/** Clamp a render range into [0, durationSec]. Throws on an empty result
 * (a zero-length OfflineAudioContext is unconstructible anyway). */
export function resolveRange(
  durationSec: number,
  range?: RenderRange,
): { startSec: number; endSec: number } {
  const startSec = Math.min(Math.max(range?.startSec ?? 0, 0), durationSec);
  const endSec = Math.min(Math.max(range?.endSec ?? durationSec, 0), durationSec);
  if (endSec - startSec <= 0) {
    throw new Error(`empty render range: ${startSec}s..${endSec}s of ${durationSec}s`);
  }
  return { startSec, endSec };
}
