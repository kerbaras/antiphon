// Pure room-timeline math shared by live playback (player.ts) and the
// offline render (render.ts). Playback-parity for exports is guaranteed by
// construction: both paths plan their AudioBufferSourceNodes through the
// SAME functions, so any change to the alignment/drift scheduling model
// lands in exactly one place.

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

/** How a track's alignment lag was measured (W4-B): `chirp` = the §10
 * calibration sweep located in the stream; `content` = cross-correlation
 * of the recorded content itself against a reference stream, expressed in
 * the same virtual lag domain (reference lag + signed pre-roll offset). */
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

/** Samples to trim from each track's head so all aligned tracks share the
 * room clock. Chirp lags may lock onto different repeats of the sweep
 * (the §10 schedule emits it twice), so their deltas are normalized
 * modulo the repeat interval — safe while true inter-device offsets stay
 * under half the interval (1 s — arming spread is hundreds of ms at
 * worst). Content lags carry no repeat ambiguity (there is exactly one
 * performance) and pass through unwrapped, so offsets beyond the chirp
 * interval stay honest. Fewer than two lags yields no deltas: there is
 * nothing to align against. */
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

/** Visual composition of the applied head-trims (W6-C). Alignment is
 * schedule-time only — stored audio and arrangement positions never move —
 * but the desk must SHOW it: each clip box shifts right by how much later
 * its stream started capturing, so aligned waveforms line up on screen.
 * `shiftSec` is that per-stream box shift (0 for the earliest starter, the
 * one with the maximal head-trim); `anchorSec` is where room-time zero
 * lands relative to the take's arrangement base — the playhead (and every
 * other room-timeline drawing) moves right with it, and it doubles as the
 * shift for streams WITHOUT an applied lag (their audio starts exactly at
 * room zero, unaligned). Both derive from the SAME normalized deltas the
 * schedule trims with, so what is drawn is what plays by construction. */
export interface AlignShifts {
  /** streamId → seconds the clip box sits right of its arrangement position. */
  shiftSec: Map<string, number>;
  /** Arrangement offset of room-time zero (max head-trim, seconds ≥ 0). */
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

// ---- W7-A — every take draws aligned (fold-in of the parked W6 follow-up) --------
// The loaded take composes its shifts from LIVE player state; every other
// take composes them from its PERSISTED verdict (alignment-persist.ts).
// These are the pure conversions: stored entries → the same AlignShifts
// the live path produces, and "which take's anchor is the playhead
// inside?" for the per-take playhead mapping.

/** One stream's persisted verdict as the drawing layer consumes it — the
 * alignment-persist entry shape, structurally (no import cycle with
 * player.ts). Lags are in stream samples at the desk's capture rate. */
export interface PersistedAlignmentLag {
  alignment: { lagSamples: number; applied: boolean; method?: AlignMethod };
}

/** AlignShifts of a take that is NOT loaded, from its persisted verdict:
 * the exact alignShifts composition the loaded take gets from live track
 * state, fed by stored lags at `sampleRate` (the capture rate every other
 * drawn duration on the timeline already uses). Unapplied/absent entries
 * contribute nothing — their clips fall to the anchor at draw time,
 * exactly like live unmeasured streams. A declined take yields the empty
 * shifts (anchor 0): it draws unshifted, honestly. */
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
 * take's anchor, 0 in the gaps and beyond the session. The playhead rides
 * the drawn (shifted) waveforms of WHATEVER take its audio comes from and
 * never lies by another take's anchor over a gap — the W7-A promotion of
 * the W6-C per-take rule from "selected take only" to every take with a
 * verdict. Takes never overlap on the room clock by construction (the
 * desk lays them out sequentially); first match wins as the defensive
 * tie-break should a dragged arrangement overlap two spans. */
export function anchorAtSec(spans: readonly TakeAnchorSpan[], posSec: number): number {
  for (const span of spans) {
    if (posSec >= span.startSec && posSec <= span.endSec) return span.anchorSec;
  }
  return 0;
}

// ---- W6-B — session spans and the look-ahead scheduler ---------------------------
// The transport runs the whole SESSION timeline now: takes at their room
// offsets, silence in the gaps. These helpers are the pure half of the
// engine's memory-bounded decode: which takes must be mounted for the next
// stretch of playback, and which mounted takes are safely behind us. Takes
// never overlap on the room clock by construction (the desk lays them out
// sequentially), so at most one take is audible at any instant — the whole
// reason a rolling mount window is enough.

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
 * player positions/seeks (0 = take head after alignment). W2-B song
 * markers render ranges through this; omitted bounds mean whole-take. */
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
