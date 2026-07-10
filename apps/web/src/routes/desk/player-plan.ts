// Session-plan shapes and pure plan math for SessionPlayer: normalization,
// content diffing, take base/end from clip starts and regions, and the
// RenderModel builder for takes assembled off the plan (never selected).

import { DEFAULT_CHIRP_SPEC } from "@antiphon/protocol";
import type { ClipRegion } from "../../net/collab-doc";
import type { EqState } from "./eq";
import type { StoredTrackAlignment } from "./player-align";
import type { RenderModel, RenderTrackModel } from "./render";
import { normalizeAlignDeltas, regionsEndSec, trackEndSec } from "./timeline-math";

/** One stream of the SESSION plan: where its clip sits on the arrangement
 * and how long the archive says it is (pre-alignment). */
export interface SessionStreamPlan {
  streamId: string;
  /** Mixer lane (performer) the stream plays through. */
  channelKey: string;
  /** Absolute arrangement position of the clip (override or take slot).
   * For a SPLIT stream: the first region's start (regions carry the rest). */
  clipStartSec: number;
  /** Declared stream length: totalSamples / sample rate. */
  declaredDurationSec: number;
  /** Split regions, source-ordered, from the shared doc. ABSENT for
   * never-split streams — those keep the verbatim whole-stream schedule
   * path, so a zero-split session is schedule-identical to a pre-split one. */
  regions?: ClipRegion[];
}

/** One take of the session plan — only COMPLETE streams belong here (the
 * live take and unassembled streams are not playable material). */
export interface SessionTakePlan {
  takeId: string;
  streams: SessionStreamPlan[];
}

/** What the engine needs to mount takes WITHOUT a selection: OPFS stream
 * assembly and the persisted per-take alignment verdict. Wired once by
 * the desk (use-desk.ts). */
export interface SessionSources {
  assemble(takeId: string, streamId: string): Promise<ArrayBuffer | null>;
  storedAlignment(takeId: string): Record<string, StoredTrackAlignment> | null;
}

/** Canonical plan shape: playable takes only, streams in stable order. */
export function normalizeSessionPlan(plan: readonly SessionTakePlan[]): SessionTakePlan[] {
  return plan
    .filter((p) => p.streams.length > 0)
    .map((p) => ({
      takeId: p.takeId,
      streams: [...p.streams].sort((a, b) => a.streamId.localeCompare(b.streamId)),
    }));
}

/** Content diff for setSessionPlan's no-op guard (status polls re-derive
 * the plan every second). Regions come from the doc verbatim (discrete
 * edits, no per-poll jitter) — structural equality is the honest diff. */
export function samePlan(a: readonly SessionTakePlan[], b: readonly SessionTakePlan[]): boolean {
  if (b.length !== a.length) return false;
  for (let i = 0; i < b.length; i++) {
    const pa = a[i] as SessionTakePlan;
    const pb = b[i] as SessionTakePlan;
    if (pa.takeId !== pb.takeId || pa.streams.length !== pb.streams.length) return false;
    for (let j = 0; j < pa.streams.length; j++) {
      const sa = pa.streams[j] as SessionStreamPlan;
      const sb = pb.streams[j] as SessionStreamPlan;
      if (
        sa.streamId !== sb.streamId ||
        sa.channelKey !== sb.channelKey ||
        Math.abs(sa.clipStartSec - sb.clipStartSec) > 1e-4 ||
        Math.abs(sa.declaredDurationSec - sb.declaredDurationSec) > 1e-4 ||
        JSON.stringify(sa.regions ?? null) !== JSON.stringify(sb.regions ?? null)
      ) {
        return false;
      }
    }
  }
  return true;
}

/** A clip's leftmost arrangement start for base math: split streams
 * contribute their leftmost REGION start; a stream whose every clip was
 * deleted (regions: []) has no arrangement presence (+Infinity, never wins). */
function clipStartOf(
  clipStartSec: number,
  regions: readonly ClipRegion[] | null | undefined,
): number {
  return regions
    ? regions.length > 0
      ? Math.min(...regions.map((r) => r.startSec))
      : Number.POSITIVE_INFINITY
    : clipStartSec;
}

/** A take's base on the arrangement: its leftmost clip start (0 when every
 * stream is empty — an all-deleted take collapses to base 0). */
export function clipsBaseSec(
  streams: ReadonlyArray<{ clipStartSec: number; regions?: readonly ClipRegion[] | null }>,
): number {
  const base = Math.min(...streams.map((s) => clipStartOf(s.clipStartSec, s.regions)));
  return Number.isFinite(base) ? base : 0;
}

/** A planned (un-mounted) take's declared end: last region end, or clip
 * start + declared length. Approximates ratio = 1, like declared ends
 * always have; empty regions span nothing. */
export function plannedEndSec(streams: readonly SessionStreamPlan[]): number {
  return Math.max(
    ...streams.map((s) =>
      s.regions
        ? s.regions.length > 0
          ? Math.max(...s.regions.map((r) => r.startSec + r.durationSec))
          : 0
        : s.clipStartSec + s.declaredDurationSec,
    ),
  );
}

/** Resolved mixer state for one render track (mute/solo folded to gain 0). */
export interface RenderStripView {
  gain: number;
  pan: number;
  eq: EqState;
}

/** Take-local RenderModel for a take decoded off the plan: persisted
 * verdicts feed the SAME timing/planSource math as playback — parity by
 * construction. Clip delays and regions are rebased onto the take's head. */
export function plannedRenderModel(
  takeId: string,
  decoded: ReadonlyArray<{ plan: SessionStreamPlan; buffer: AudioBuffer }>,
  entries: Record<string, StoredTrackAlignment>,
  stripOf: (channelKey: string) => RenderStripView,
  master: { gain: number; pan: number; eq: EqState },
): RenderModel {
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
  const base = Math.min(
    ...decoded.map(({ plan }) =>
      plan.regions && plan.regions.length > 0
        ? Math.min(...plan.regions.map((r) => r.startSec))
        : plan.clipStartSec,
    ),
  );
  const tracks: RenderTrackModel[] = decoded.map(({ plan, buffer }) => {
    const drift = entries[plan.streamId]?.drift;
    const driftSamples = drift?.applied ? drift.initialOffsetSamples : 0;
    const strip = stripOf(plan.channelKey);
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
      ...(plan.regions
        ? { regions: plan.regions.map((r) => ({ ...r, startSec: r.startSec - base })) }
        : {}),
      gain: strip.gain,
      pan: strip.pan,
      eq: strip.eq,
    };
  });
  return {
    takeId,
    durationSec: Math.max(
      ...tracks.map((t) =>
        t.regions ? regionsEndSec(t.timing, t.regions) : trackEndSec(t.timing),
      ),
    ),
    masterGain: master.gain,
    masterPan: master.pan,
    masterEq: master.eq,
    tracks,
  };
}
