// Timeline editing interactions: selection, marquee, clip drag, the split
// blade, trim edges, keyboard shortcuts, and deletion.
//
// Deletion is two-tier: plain Delete removes clips from the ARRANGEMENT
// (doc write, undoable, no dialog — raw audio stays archived; a stream's
// last clip leaves the honest empty list). Shift+Delete / the lane menu
// stage whole recordings for the DURABLE server delete behind the confirm
// dialog (rows + blobs — undo can't reach those).

import type React from "react";
import { useEffect, useMemo, useState } from "react";
import type { CollabClient } from "../../net/collab";
import type { ClipRegion } from "../../net/collab-doc";
import type { DeskSessionState } from "../../net/desk-session";
import type { ClipModel } from "./clip-card";
import type { DeleteSummaryTake } from "./delete-confirm";
import { RULER_H, TRACK_HEADER_W, TRACK_ROW_H } from "./lane-chrome";
import {
  regionsValid,
  seedRegion,
  selectionStreamIds,
  splitRegion,
  type TrimEdge,
  trimRegion,
} from "./regions";
import type { Marquee } from "./timeline";
import type { DeskTool } from "./tools";
import { playActionReady } from "./top-bar";
import { SAMPLE_RATE, type TakeSlot, type TrackRow } from "./track-model";
import type { RegionEntry } from "./use-arrangement";
import { getDeskCollab, getDeskSession, getPlayer } from "./use-desk";

export interface DeleteRef {
  takeId: string;
  streamId: string;
}

export function useTimelineEditing({
  sessionId,
  collab,
  state,
  takes,
  rows,
  recording,
  playerLoaded,
  tool,
  setTool,
  pxPerSec,
  timelineRef,
  regionIndex,
  docRegions,
  writeStreamRegionsMap,
  setClipStartOverrides,
  clipStartSec,
  clipShiftSec,
  selectedLaneKey,
  setSelectedLaneKey,
  laneMenuOpen,
  orphanedStreams,
  seekTimeline,
  getRowClips,
  onAddMarker,
  onOpenComments,
}: {
  sessionId: string;
  collab: CollabClient;
  state: DeskSessionState;
  takes: Map<string, TakeSlot>;
  rows: TrackRow[];
  recording: boolean;
  playerLoaded: boolean;
  tool: DeskTool;
  setTool: (tool: DeskTool) => void;
  pxPerSec: number;
  timelineRef: React.RefObject<HTMLDivElement | null>;
  regionIndex: Map<string, RegionEntry>;
  docRegions: Record<string, ClipRegion[]>;
  writeStreamRegionsMap: (streamId: string, regions: ClipRegion[]) => void;
  setClipStartOverrides: (update: (prev: Record<string, number>) => Record<string, number>) => void;
  clipStartSec: (streamId: string, takeId: string) => number;
  clipShiftSec: (streamId: string, takeId: string) => number;
  selectedLaneKey: string | null;
  setSelectedLaneKey: (key: string | null) => void;
  laneMenuOpen: boolean;
  orphanedStreams: Set<string>;
  seekTimeline: (sec: number) => void;
  getRowClips: () => ClipModel[][];
  onAddMarker: () => void;
  onOpenComments: () => void;
}) {
  const [selection, setSelection] = useState<string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<DeleteRef[] | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);

  /** Apply the blade to one stream: seed the implicit region on the first
   * cut, split, validate, write ONE whole-list doc update. Rejected cuts
   * (live/incomplete/orphan streams, cuts within 100 ms of an edge) are a
   * silent no-op by design — the blade misses, no error spam. */
  function cutStream(
    streamId: string,
    takeId: string,
    cuts: Array<{ regionId: string; atSourceSec: number }>,
  ): void {
    const stream = state.deskStatus.find((s) => s.streamId === streamId);
    if (!stream?.complete || stream.takeId === state.activeTakeId) return;
    if (orphanedStreams.has(streamId)) return;
    const streamDurationSec = Math.max(stream.totalSamples / SAMPLE_RATE, 1);
    let list = docRegions[streamId] ?? [
      seedRegion(streamId, clipStartSec(streamId, takeId), streamDurationSec),
    ];
    let changed = false;
    for (const cut of cuts) {
      const next = splitRegion(list, cut.regionId, cut.atSourceSec);
      if (next && regionsValid(next, streamDurationSec)) {
        list = next;
        changed = true;
      }
    }
    if (changed) writeStreamRegionsMap(streamId, list);
  }

  /** Ruler/bare-surface blade: cut EVERY region whose drawn box crosses
   * content-second x (drawn = startSec + align shift, so the cut lands
   * under the visible hairline). */
  function splitAllAt(contentSec: number): void {
    collab.sealUndo();
    const byStream = new Map<
      string,
      { takeId: string; cuts: Array<{ regionId: string; atSourceSec: number }> }
    >();
    for (const [regionId, entry] of regionIndex) {
      if (!entry.splittable) continue;
      const drawnLeft = entry.region.startSec + clipShiftSec(entry.streamId, entry.takeId);
      const within = contentSec - drawnLeft;
      if (within <= 0 || within >= entry.region.durationSec) continue;
      const bucket = byStream.get(entry.streamId) ?? { takeId: entry.takeId, cuts: [] };
      bucket.cuts.push({ regionId, atSourceSec: entry.region.sourceOffsetSec + within });
      byStream.set(entry.streamId, bucket);
    }
    for (const [streamId, { takeId, cuts }] of byStream) cutStream(streamId, takeId, cuts);
  }

  function trimFrom(e: React.PointerEvent, entry: RegionEntry, regionId: string): void {
    if (!entry.splittable) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const edge: TrimEdge = e.clientX - rect.left < rect.width / 2 ? "head" : "tail";
    // Never-split streams seed their implicit region on first trim.
    const base = entry.split
      ? (docRegions[entry.streamId] ?? [])
      : [
          seedRegion(
            entry.streamId,
            clipStartSec(entry.streamId, entry.takeId),
            entry.streamDurationSec,
          ),
        ];
    collab.sealUndo(); // one trim gesture = one undo step
    const originX = e.clientX;
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - originX) < 2) return;
      const deltaSec = (ev.clientX - originX) / pxPerSec;
      const next = trimRegion(base, regionId, edge, deltaSec, entry.streamDurationSec);
      if (next && regionsValid(next, entry.streamDurationSec)) {
        writeStreamRegionsMap(entry.streamId, next);
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function dragFrom(e: React.PointerEvent, regionId: string): void {
    const dragIds = selection.includes(regionId) ? selection : [regionId];
    if (!selection.includes(regionId)) setSelection([regionId]);
    collab.sealUndo(); // one clip-drag gesture = one undo step
    const originX = e.clientX;
    // Snapshot the down-state; moves derive from it (never accumulated) so
    // a drag is exact regardless of doc echo timing. Never-split streams
    // write `arrange` (wire-compat), split streams whole region lists.
    const dragged = new Set(dragIds);
    const unsplitStarts = new Map<string, number>();
    const splitBase = new Map<string, ClipRegion[]>();
    for (const id of dragIds) {
      const en = regionIndex.get(id);
      if (!en) continue;
      if (en.split) {
        if (!splitBase.has(en.streamId)) splitBase.set(en.streamId, docRegions[en.streamId] ?? []);
      } else {
        unsplitStarts.set(en.streamId, en.region.startSec);
      }
    }
    const move = (ev: PointerEvent) => {
      const dxSec = (ev.clientX - originX) / pxPerSec;
      if (Math.abs(ev.clientX - originX) < 4) return;
      if (unsplitStarts.size > 0) {
        setClipStartOverrides((prev) => {
          const next = { ...prev };
          for (const [streamId, start] of unsplitStarts) {
            next[streamId] = Math.max(0, start + dxSec);
          }
          return next;
        });
      }
      // Pieces drag individually — siblings hold their spots. Stacked
      // pieces both sound (source disjointness is the only overlap rule).
      for (const [streamId, base] of splitBase) {
        writeStreamRegionsMap(
          streamId,
          base.map((r) =>
            dragged.has(r.id) ? { ...r, startSec: Math.max(0, r.startSec + dxSec) } : r,
          ),
        );
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** Clip press: blade cuts, trim grabs the nearest edge, modifier press
   * toggles selection (never drags), plain press selects and drags every
   * selected region. A press without movement never switches the loaded
   * take — double-click is the explicit load action. */
  function onClipPointerDown(e: React.PointerEvent, regionId: string) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const entry = regionIndex.get(regionId);
    if (!entry) return;
    if (tool === "split") {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const atSourceSec = entry.region.sourceOffsetSec + (e.clientX - rect.left) / pxPerSec;
      collab.sealUndo();
      cutStream(entry.streamId, entry.takeId, [{ regionId, atSourceSec }]);
      return;
    }
    if (tool === "trim") {
      trimFrom(e, entry, regionId);
      return;
    }
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      setSelection((prev) =>
        prev.includes(regionId) ? prev.filter((id) => id !== regionId) : [...prev, regionId],
      );
      return;
    }
    dragFrom(e, regionId);
  }

  /** Bare-surface press: sticky chrome is excluded (viewport-space test —
   * content coordinates drift under sticky elements once scrolled); split
   * mode cuts all lanes; drag = marquee (additive with a modifier); plain
   * click = seek. */
  function onLanePointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || recording) return;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const target = e.target as HTMLElement;
    if (target.closest("button")) return; // clips and controls handle themselves
    const container = timelineRef.current;
    const viewport = container?.parentElement;
    if (!container || !viewport) return;
    const vp = viewport.getBoundingClientRect();
    if (e.clientX - vp.left < TRACK_HEADER_W || e.clientY - vp.top < RULER_H) return;
    const rect = container.getBoundingClientRect();
    if (tool === "split") {
      splitAllAt((e.clientX - rect.left - TRACK_HEADER_W) / pxPerSec);
      return;
    }
    const x0 = e.clientX - rect.left;
    const y0 = e.clientY - rect.top;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const x1 = ev.clientX - rect.left;
      const y1 = ev.clientY - rect.top;
      if (Math.abs(x1 - x0) + Math.abs(y1 - y0) > 5) moved = true;
      if (moved) setMarquee({ x0, y0, x1, y1 });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved) {
        if (!additive) setSelection([]);
        seekTimeline((x0 - TRACK_HEADER_W) / pxPerSec);
        setMarquee(null);
        return;
      }
      // Marquee select: every non-live clip whose rect intersects.
      const x1 = ev.clientX - rect.left;
      const y1 = ev.clientY - rect.top;
      const [left, right] = [Math.min(x0, x1), Math.max(x0, x1)];
      const [top, bottom] = [Math.min(y0, y1), Math.max(y0, y1)];
      const hit: string[] = [];
      getRowClips().forEach((clips, rowIndex) => {
        const rowTop = RULER_H + rowIndex * TRACK_ROW_H + 4;
        const rowBottom = RULER_H + (rowIndex + 1) * TRACK_ROW_H - 4;
        for (const clip of clips) {
          if (clip.live) continue;
          const clipLeft = TRACK_HEADER_W + clip.x;
          const clipRight = clipLeft + Math.max(clip.width, 26);
          if (clipLeft < right && clipRight > left && rowTop < bottom && rowBottom > top) {
            hit.push(clip.id);
          }
        }
      });
      setSelection((prev) =>
        additive ? [...prev, ...hit.filter((id) => !prev.includes(id))] : hit,
      );
      setMarquee(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Keyboard shortcuts. Text inputs are exempt; open dialogs and the lane
  // menu own the keyboard wholesale (gated by STATE, not focus).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }
      if (target.closest?.('[role="dialog"]')) return;
      if (pendingDelete || laneMenuOpen) return;
      const laneKey =
        selectedLaneKey !== null && rows.some((row) => row.key === selectedLaneKey)
          ? selectedLaneKey
          : null;
      if (e.key === "Escape") {
        // Escape exits the active tool first; a second clears the lane.
        if (tool !== "select") {
          setTool("select");
          return;
        }
        setSelectedLaneKey(null);
        return;
      }
      // Ctrl/Cmd+Z undoes the last arrangement edit; +Shift redoes. Pure
      // doc rollback (clips are projections) — inert while a take rolls.
      if (e.code === "KeyZ" && (e.metaKey || e.ctrlKey) && !e.altKey) {
        e.preventDefault();
        if (recording) return;
        const collabClient = getDeskCollab(sessionId);
        if (e.shiftKey) collabClient.redoArrangement();
        else collabClient.undoArrangement();
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        // Space mirrors the transport button exactly, read on the LIVE
        // snapshot so a decode that began this frame already gates.
        if (recording) getDeskSession(sessionId).stopTake();
        else if (playActionReady(playerLoaded, getPlayer().snapshot())) getPlayer().toggle();
        return;
      }
      if (e.code === "KeyS" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (laneKey) getPlayer().toggleChannelSolo(laneKey);
        return;
      }
      // M mutes the selected lane; with none selected it drops a marker.
      if (e.code === "KeyM" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (laneKey) {
          getPlayer().toggleChannelMute(laneKey);
          return;
        }
        onAddMarker();
        return;
      }
      if (e.code === "KeyC" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (!recording) setTool("split");
        return;
      }
      if (e.code === "KeyT" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (!recording) setTool("trim");
        return;
      }
      if (e.code === "KeyV" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setTool("select");
        return;
      }
      if (e.code === "KeyN" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onOpenComments();
        return;
      }
      if ((e.code === "Delete" || e.code === "Backspace") && selection.length > 0) {
        e.preventDefault();
        if (e.shiftKey) {
          // Durable path: stage the selected clips' WHOLE recordings.
          const refs: DeleteRef[] = [];
          for (const id of selection) {
            const streamId = selectionStreamIds([id], docRegions)[0] ?? id;
            const stream = state.deskStatus.find((s) => s.streamId === streamId);
            if (!stream || stream.takeId === state.activeTakeId) continue;
            if (!refs.some((r) => r.streamId === streamId)) {
              refs.push({ takeId: stream.takeId, streamId });
            }
          }
          if (refs.length === 0) return;
          setPendingDelete(refs);
          return;
        }
        // Projection edit: clips leave the arrangement by doc write.
        const byStream = new Map<string, Set<string>>();
        for (const id of selection) {
          const streamId = selectionStreamIds([id], docRegions)[0] ?? id;
          const stream = state.deskStatus.find((s) => s.streamId === streamId);
          if (!stream || stream.takeId === state.activeTakeId) continue;
          const bucket = byStream.get(streamId) ?? new Set();
          bucket.add(id);
          byStream.set(streamId, bucket);
        }
        if (byStream.size === 0) return;
        getDeskCollab(sessionId).sealUndo(); // one Delete press = one undo step
        for (const [streamId, ids] of byStream) {
          const doc = docRegions[streamId];
          // Never-split: its one implicit clip IS the stream → empty list.
          const next = doc ? doc.filter((r) => !ids.has(r.id)) : [];
          writeStreamRegionsMap(streamId, next);
        }
        setSelection([]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    recording,
    playerLoaded,
    sessionId,
    selection,
    selectedLaneKey,
    setSelectedLaneKey,
    rows,
    pendingDelete,
    laneMenuOpen,
    tool,
    setTool,
    docRegions,
    writeStreamRegionsMap,
    state.deskStatus,
    state.activeTakeId,
    onAddMarker,
    onOpenComments,
  ]);

  /** Confirmed DURABLE deletion: the server-authoritative protocol path —
   * local copies drop only on the streams-deleted confirm fanout. */
  function confirmDelete() {
    if (!pendingDelete) return;
    getDeskSession(sessionId).deleteStreams(pendingDelete);
    setSelection([]);
    setClipStartOverrides((prev) => {
      const next = { ...prev };
      for (const ref of pendingDelete) delete next[ref.streamId];
      return next;
    });
    setPendingDelete(null);
  }

  /** A staged recording that is split: the durable delete destroys every
   * piece, and the dialog says so. */
  const deleteSplitWhole = useMemo(
    () => (pendingDelete ?? []).some((ref) => (docRegions[ref.streamId]?.length ?? 0) > 1),
    [pendingDelete, docRegions],
  );

  /** Per-take clip counts for the dialog (pieces counted). */
  const deleteSummary = useMemo((): DeleteSummaryTake[] => {
    if (!pendingDelete) return [];
    const order = [...takes.keys()];
    const counts = new Map<string, number>();
    for (const ref of pendingDelete) {
      const pieces = docRegions[ref.streamId]?.length ?? 1;
      counts.set(ref.takeId, (counts.get(ref.takeId) ?? 0) + Math.max(pieces, 1));
    }
    return [...counts.entries()]
      .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
      .map(([takeId, clipCount]) => ({
        name: `Take ${order.indexOf(takeId) + 1}`,
        clipCount,
      }));
  }, [pendingDelete, takes, docRegions]);

  return {
    selection,
    marquee,
    pendingDelete,
    setPendingDelete,
    confirmDelete,
    deleteSplitWhole,
    deleteSummary,
    onClipPointerDown,
    onLanePointerDown,
    splitAllAt,
  };
}
