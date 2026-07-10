// Pure builder: per-row clip boxes (one per region) with geometry and
// interaction handlers. Box x = arrangement position + align shift — the
// waveform (and stored audio) never moves, only the box does.

import type React from "react";
import type { DeskStreamStatus } from "../../audio/sink-worker-protocol";
import type { ClipRegion } from "../../net/collab-doc";
import type { ClipModel } from "./clip-card";
import type { DeskTool } from "./tools";
import { SAMPLE_RATE, type TakeSlot, type TrackRow } from "./track-model";
import type { StreamRegions } from "./use-arrangement";
import { getCachedWaveform } from "./use-desk";

/** A region's slice of its stream's waveform array: a proportional index
 * window over the full source, so a split's pieces visually CONTINUE the
 * original drawing — same peaks at the same source positions. */
function sliceEnergy(energy: number[], region: ClipRegion, streamDurationSec: number): number[] {
  if (energy.length === 0 || streamDurationSec <= 0) return energy;
  const from = Math.round((region.sourceOffsetSec / streamDurationSec) * energy.length);
  const to = Math.round(
    ((region.sourceOffsetSec + region.durationSec) / streamDurationSec) * energy.length,
  );
  return energy.slice(Math.max(0, from), Math.max(from + 1, Math.min(energy.length, to)));
}

export function buildRowClips({
  rows,
  takes,
  pxPerSec,
  tool,
  selection,
  serverDigestOf,
  alignedOf,
  orphanedStreams,
  clipStartSec,
  clipShiftSec,
  streamRegionsOf,
  onClipPointerDown,
  onPickTake,
}: {
  rows: TrackRow[];
  takes: Map<string, TakeSlot>;
  pxPerSec: number;
  tool: DeskTool;
  selection: string[];
  serverDigestOf: (streamId: string) => { complete: boolean; digest: string | null } | undefined;
  alignedOf: (streamId: string) => boolean;
  orphanedStreams: Set<string>;
  clipStartSec: (streamId: string, takeId: string) => number;
  clipShiftSec: (streamId: string, takeId: string) => number;
  streamRegionsOf: (stream: DeskStreamStatus) => StreamRegions;
  onClipPointerDown: (e: React.PointerEvent, regionId: string) => void;
  onPickTake: (takeId: string) => void;
}): ClipModel[][] {
  const takeOrder = [...takes.keys()];

  const badgeOf = (stream: DeskStreamStatus): NonNullable<ClipModel["badge"]> => {
    // A terminal orphan can never align or converge — "incomplete"
    // outranks the transient "syncing".
    if (orphanedStreams.has(stream.streamId)) return "incomplete";
    if (alignedOf(stream.streamId)) return "aligned";
    const server = serverDigestOf(stream.streamId);
    const converged =
      stream.complete && (server?.complete ?? false) && stream.digest === server?.digest;
    return converged ? "converged" : "syncing";
  };

  return rows.map((row) =>
    row.streams.flatMap((stream): ClipModel[] => {
      const slot = takes.get(stream.takeId);
      if (!slot) return [];
      // Completed streams always draw the true decoded waveform; the
      // encoded-complexity proxy only covers the live take.
      const waveform = getCachedWaveform(stream.streamId) ?? stream.energy;
      const recordedSec = stream.totalSamples / SAMPLE_RATE;
      const shiftSec = clipShiftSec(stream.streamId, stream.takeId);
      if (slot.live) {
        const durationSec = Math.max(recordedSec, slot.durationSec);
        return [
          {
            id: stream.streamId,
            streamId: stream.streamId,
            takeId: stream.takeId,
            name: "Incoming take",
            color: row.color,
            x: (clipStartSec(stream.streamId, stream.takeId) + shiftSec) * pxPerSec,
            width: durationSec * pxPerSec - 3,
            durationSec,
            live: true,
            badge: "rec",
            energy: waveform,
            fillFraction: durationSec > 0 ? Math.min(1, recordedSec / durationSec) : 1,
            selected: false,
          },
        ];
      }
      const { regions, split, streamDurationSec } = streamRegionsOf(stream);
      const badge = badgeOf(stream);
      const name = `Take ${takeOrder.indexOf(stream.takeId) + 1}`;
      return regions.map(
        (region): ClipModel => ({
          id: region.id,
          streamId: stream.streamId,
          takeId: stream.takeId,
          name,
          color: row.color,
          x: (region.startSec + shiftSec) * pxPerSec,
          width: region.durationSec * pxPerSec - 3,
          durationSec: region.durationSec,
          live: false,
          splitting: tool === "split",
          trimming: tool === "trim",
          badge,
          // Split pieces draw their slice of the stream waveform; the
          // unsplit seed keeps the verbatim array.
          energy: split ? sliceEnergy(waveform, region, streamDurationSec) : waveform,
          fillFraction: 1,
          selected: selection.includes(region.id),
          onPointerDown: (e: React.PointerEvent) => onClipPointerDown(e, region.id),
          // Double-click loads the take — selection alone never does; the
          // blade and trim grabs suspend it.
          ...(tool === "select" ? { onDoubleClick: () => onPickTake(stream.takeId) } : {}),
        }),
      );
    }),
  );
}
