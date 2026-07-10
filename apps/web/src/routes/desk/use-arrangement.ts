// Arrangement + alignment view: where every clip sits (doc overrides,
// split regions) and how far its box draws right of that (align verdicts).
//
// THE composition invariant: the SESSION clock (position/seek/duration) is
// anchor-free — audio schedules at its arrangement positions whether a take
// is selected or a neighbor. The anchor is a DRAWING transform, applied
// per-take: audio at session t inside a verdict-holding take draws at
// t + that take's anchor; everywhere else drawn x == session t. Playhead
// and click mapping apply the same per-take transform.

import { useCallback, useMemo } from "react";
import type { DeskStreamStatus } from "../../audio/sink-worker-protocol";
import type { CollabClient } from "../../net/collab";
import type { ClipRegion } from "../../net/collab-doc";
import type { DeskSessionState } from "../../net/desk-session";
import type { DriftResult, PlayerSnapshot } from "./player";
import { seedRegion } from "./regions";
import { SAMPLE_RATE, type TakeSlot } from "./track-model";
import { useCollabArrange, useCollabRegions } from "./use-collab";
import { getPlayer, useTakeAlignShifts } from "./use-desk";

export interface StreamRegions {
  regions: ClipRegion[];
  split: boolean;
  streamDurationSec: number;
}

export interface RegionEntry extends StreamRegions {
  region: ClipRegion;
  streamId: string;
  takeId: string;
  /** Complete, not an orphan, not the rolling take: cuttable/trimmable. */
  splittable: boolean;
}

export function useArrangement({
  sessionId,
  collab,
  state,
  takes,
  selectedTakeId,
  playerLoaded,
  playerSnap,
  orphanedStreams,
}: {
  sessionId: string;
  collab: CollabClient;
  state: DeskSessionState;
  takes: Map<string, TakeSlot>;
  selectedTakeId: string | null;
  playerLoaded: boolean;
  playerSnap: PlayerSnapshot;
  orphanedStreams: Set<string>;
}) {
  const alignmentByStream = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const t of playerSnap.tracks) map.set(t.streamId, t.alignment?.applied ?? false);
    return map;
  }, [playerSnap.tracks]);

  // Live verdict for the loaded take (doc-synced, fresher mid-run);
  // persisted verdicts for every other take — identical values once a run
  // settles, so promoting a take from persisted to live never moves a box.
  // biome-ignore lint/correctness/useExhaustiveDependencies: playerSnap.tracks carries the verdict state this reads
  const alignView = useMemo(
    () =>
      playerLoaded
        ? getPlayer().alignShifts()
        : { shiftSec: new Map<string, number>(), anchorSec: 0 },
    [playerLoaded, playerSnap.tracks],
  );
  const drawnTakeIdsKey = useMemo(
    () => [...takes.keys()].filter((takeId) => takeId !== state.activeTakeId).join(","),
    [takes, state.activeTakeId],
  );
  const persistedShiftsByTake = useTakeAlignShifts(sessionId, drawnTakeIdsKey);

  /** Seconds a clip's box draws right of its arrangement position. An
   * unmeasured/declined stream sits at the room-zero anchor; a take with
   * no applied verdict draws unshifted. */
  const clipShiftSec = (streamId: string, takeId: string): number => {
    if (takeId === selectedTakeId && playerLoaded) {
      return alignView.shiftSec.get(streamId) ?? alignView.anchorSec;
    }
    const persisted = persistedShiftsByTake.get(takeId);
    return persisted ? (persisted.shiftSec.get(streamId) ?? persisted.anchorSec) : 0;
  };

  const driftByStream = useMemo(() => {
    const map = new Map<string, DriftResult>();
    for (const t of playerSnap.tracks) {
      if (t.drift) map.set(t.streamId, t.drift);
    }
    return map;
  }, [playerSnap.tracks]);

  // Clip arrangement lives in the shared doc: local drags write through,
  // remote desks' drags land here live.
  const [clipStartOverrides, setClipStartOverrides] = useCollabArrange(collab);
  // Split regions: streamId → doc-held piece list. A stream ABSENT here is
  // never-split (its one implicit region derives from the legacy arrange
  // override / take slot — old clients only read `arrange`); an EMPTY list
  // means every clip was deleted from the arrangement (audio archived).
  const [docRegions, writeStreamRegionsMap] = useCollabRegions(collab);

  /** Arrangement position of a never-split clip: override ?? take slot. */
  const clipStartSec = (streamId: string, takeId: string): number =>
    clipStartOverrides[streamId] ?? takes.get(takeId)?.offsetSec ?? 0;

  /** A stream's arrangement start: leftmost region for split streams, the
   * legacy rule otherwise. Zero-clip streams have NO start (+Infinity) so
   * they never win a leftmost-of-take reduction (callers filter). */
  const streamStartSec = useCallback(
    (streamId: string, takeId: string): number => {
      const regions = docRegions[streamId];
      if (regions) {
        return regions.length > 0
          ? Math.min(...regions.map((r) => r.startSec))
          : Number.POSITIVE_INFINITY;
      }
      return clipStartOverrides[streamId] ?? takes.get(takeId)?.offsetSec ?? 0;
    },
    [docRegions, clipStartOverrides, takes],
  );

  /** The selected take's arrangement base: leftmost clip in un-shifted
   * audio-domain positions — the zero of the take-local domains (markers,
   * comments, MIDI, render ranges). */
  const selectedBaseSec = useMemo(() => {
    if (!selectedTakeId) return 0;
    const starts = state.deskStatus
      .filter((s) => s.takeId === selectedTakeId)
      .map((s) => streamStartSec(s.streamId, selectedTakeId))
      .filter((s) => Number.isFinite(s));
    return starts.length > 0 ? Math.min(...starts) : 0;
  }, [selectedTakeId, state.deskStatus, streamStartSec]);

  /** Where the selected take's room-time zero DRAWS: base + anchor.
   * Room-timeline drawing maps through this; seeks use selectedBaseSec. */
  const timelineBaseSec = selectedBaseSec + alignView.anchorSec;

  /** A non-live stream's editable regions: the doc list when split, else
   * the implicit whole-stream seed (id == streamId). */
  const streamRegionsOf = (stream: DeskStreamStatus): StreamRegions => {
    const streamDurationSec = Math.max(stream.totalSamples / SAMPLE_RATE, 1);
    const doc = docRegions[stream.streamId];
    if (doc) return { regions: doc, split: true, streamDurationSec };
    return {
      regions: [
        seedRegion(
          stream.streamId,
          clipStartSec(stream.streamId, stream.takeId),
          streamDurationSec,
        ),
      ],
      split: false,
      streamDurationSec,
    };
  };

  /** Every editable (non-live) region by id — the shared lookup for drags,
   * the blade, trims, and Delete's region→stream resolution. */
  const regionIndex = new Map<string, RegionEntry>();
  for (const stream of state.deskStatus) {
    const slot = takes.get(stream.takeId);
    if (!slot || slot.live) continue;
    const streamRegions = streamRegionsOf(stream);
    const splittable = stream.complete && !orphanedStreams.has(stream.streamId);
    for (const region of streamRegions.regions) {
      regionIndex.set(region.id, {
        ...streamRegions,
        region,
        streamId: stream.streamId,
        takeId: stream.takeId,
        splittable,
      });
    }
  }

  return {
    alignmentByStream,
    alignView,
    persistedShiftsByTake,
    clipShiftSec,
    driftByStream,
    clipStartOverrides,
    setClipStartOverrides,
    docRegions,
    writeStreamRegionsMap,
    clipStartSec,
    streamStartSec,
    selectedBaseSec,
    timelineBaseSec,
    streamRegionsOf,
    regionIndex,
  };
}
