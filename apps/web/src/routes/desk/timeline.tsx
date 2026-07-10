// Arrange timeline: ruler (markers, ticks, song strip), track rows,
// marquee, playhead. Pointer/keyboard interaction STATE lives with the
// desk orchestrator (index.tsx); this module renders it.

import type { RefObject } from "react";
import { useLayoutEffect, useRef } from "react";
import { SectionLabel } from "../../components";
import type { ClipModel } from "./clip-card";
import type { TakeComment } from "./comments";
import { LaneRuler, laneGridStyle, RULER_H, TRACK_HEADER_W, TRACK_ROW_H } from "./lane-chrome";
import type { Marker, Song } from "./markers";
import { type MidiLaneModel, MidiLaneRow } from "./midi-lane";
import type { ChannelStrip } from "./player";
import { CommentTick, MarkerFlag } from "./ruler-markers";
import { SPLIT_CURSOR } from "./split-cursor";
import { TimelineRow } from "./timeline-row";
import type { DeskTool } from "./tools";
import type { TrackRow } from "./track-model";
import { getDeskSession, getPlayer } from "./use-desk";

export interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Anchored zoom: keep the second under the anchor (playhead when visible,
 * else the lane-area center) at the same viewport x across a zoom change.
 * Layout effect: corrected after the new widths are in the DOM, pre-paint. */
function useAnchoredZoom(
  timelineRef: RefObject<HTMLDivElement | null>,
  pxPerSec: number,
  playheadSec: number | null,
) {
  const prevPxPerSec = useRef(pxPerSec);
  useLayoutEffect(() => {
    const prev = prevPxPerSec.current;
    prevPxPerSec.current = pxPerSec;
    if (prev === pxPerSec) return;
    const viewport = timelineRef.current?.parentElement;
    if (!viewport) return;
    const scroll = viewport.scrollLeft;
    let anchorViewportX = (TRACK_HEADER_W + viewport.clientWidth) / 2;
    let anchorSec = (scroll + anchorViewportX - TRACK_HEADER_W) / prev;
    if (playheadSec !== null) {
      const playheadViewportX = TRACK_HEADER_W + playheadSec * prev - scroll;
      if (playheadViewportX >= TRACK_HEADER_W && playheadViewportX <= viewport.clientWidth) {
        anchorViewportX = playheadViewportX;
        anchorSec = playheadSec;
      }
    }
    viewport.scrollLeft = Math.max(0, TRACK_HEADER_W + anchorSec * pxPerSec - anchorViewportX);
  }, [pxPerSec, playheadSec, timelineRef]);
}

export function TimelineSection({
  sessionId,
  timelineRef,
  onLanePointerDown,
  laneWidth,
  pxPerSec,
  rows,
  rowClips,
  levelFor,
  channels,
  disarmedPeers,
  recording,
  markersUsable,
  tool,
  onSplitAt,
  activeSong,
  durationSec,
  timelineBaseSec,
  takeBaseSec,
  markers,
  comments,
  midiLane,
  playheadSec,
  ghostPlayheads,
  marquee,
  selectedLaneKey,
  onSelectLane,
  onLaneMenu,
  onSeekTimeline,
  onAddMarkerAt,
  takeMicOf,
}: {
  sessionId: string;
  timelineRef: RefObject<HTMLDivElement | null>;
  onLanePointerDown: (e: React.PointerEvent) => void;
  laneWidth: number;
  pxPerSec: number;
  rows: TrackRow[];
  rowClips: ClipModel[][];
  levelFor: (row: TrackRow) => number;
  channels: ChannelStrip[];
  disarmedPeers: string[];
  recording: boolean;
  markersUsable: boolean;
  tool: DeskTool;
  /** Split-all at drawn-content second x (ruler blade path). */
  onSplitAt: (sec: number) => void;
  activeSong: Song | null;
  durationSec: number;
  /** Arrangement position of the take's room-time zero, anchor INCLUDED —
   * what marker/comment/song DRAWING adds to its atSec. */
  timelineBaseSec: number;
  /** The take's audio-domain base, anchor-free — what marker/comment SEEKS
   * add (the session transport clock never shifts; only drawing does). */
  takeBaseSec: number;
  markers: Marker[];
  comments: TakeComment[];
  midiLane: MidiLaneModel | null;
  playheadSec: number | null;
  /** Other desks' cursors, arrangement-timeline seconds. */
  ghostPlayheads: Array<{ clientId: number; name: string; color: string; atSec: number }>;
  marquee: Marquee | null;
  selectedLaneKey: string | null;
  onSelectLane: (key: string) => void;
  onLaneMenu: (key: string, x: number, y: number) => void;
  onSeekTimeline: (sec: number) => void;
  onAddMarkerAt: (atSec: number) => void;
  /** Archived mic(s) behind the lane's audible clips in the loaded take:
   * undefined = no claim, null = archive has no description. */
  takeMicOf: (row: TrackRow) => string | null | undefined;
}) {
  useAnchoredZoom(timelineRef, pxPerSec, playheadSec);
  const splitting = tool === "split" && !recording;
  return (
    // An instrument surface, not a document: drags mean marquee/move/seek,
    // so text selection is off for the whole section (the rename input
    // opts back in for itself).
    <section className="relative min-w-0 flex-1 select-none overflow-auto bg-bg">
      {/* min-h-full: the space below the last lane is timeline too —
          marquee/seek work from the whole scrollable area. */}
      <div
        ref={timelineRef}
        className="relative flex min-h-full min-w-full flex-col"
        style={{
          width: laneWidth + TRACK_HEADER_W,
          ...(splitting ? { cursor: SPLIT_CURSOR } : {}),
        }}
        onPointerDown={onLanePointerDown}
        role="presentation"
      >
        <div className="sticky top-0 z-[6] flex">
          <div
            className="sticky left-0 z-[7] flex flex-none items-center border-r border-b border-divider bg-panel px-2.5"
            style={{ width: TRACK_HEADER_W, height: RULER_H }}
          >
            <SectionLabel>Tracks</SectionLabel>
          </div>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: dblclick shortcut; the toolbar button + M key are the accessible path */}
          <div
            data-ruler
            role="presentation"
            className="relative"
            onDoubleClick={(e) => {
              if (!markersUsable) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const atSec = (e.clientX - rect.left) / pxPerSec - timelineBaseSec;
              if (atSec < 0 || atSec > durationSec) return;
              onAddMarkerAt(atSec);
            }}
          >
            {/* Ruler seeks park the playhead even with nothing loaded; a
                rolling take suspends them. Split mode: the click is the
                blade across all lanes instead. */}
            <LaneRuler
              pxPerSec={pxPerSec}
              widthPx={laneWidth}
              {...(!recording ? { onSeek: tool === "split" ? onSplitAt : onSeekTimeline } : {})}
              {...(splitting ? { cursor: SPLIT_CURSOR } : {})}
            />
            {markersUsable && activeSong && (
              <div
                className="pointer-events-none absolute top-0 z-[1] h-1 rounded-b-[2px] bg-accent opacity-70"
                style={{
                  left: (timelineBaseSec + activeSong.startSec) * pxPerSec,
                  width: Math.max(
                    0,
                    ((activeSong.endSec ?? durationSec) - activeSong.startSec) * pxPerSec,
                  ),
                }}
              />
            )}
            {markersUsable &&
              markers.map((marker) => (
                <MarkerFlag
                  key={marker.id}
                  marker={marker}
                  x={(timelineBaseSec + marker.atSec) * pxPerSec}
                  onSeek={() => getPlayer().seek(takeBaseSec + marker.atSec)}
                />
              ))}
            {markersUsable &&
              comments.map((comment) => (
                <CommentTick
                  key={comment.id}
                  comment={comment}
                  x={(timelineBaseSec + comment.atSec) * pxPerSec}
                  onSeek={() => getPlayer().seek(takeBaseSec + comment.atSec)}
                />
              ))}
          </div>
        </div>

        {rows.length === 0 && (
          <div className="flex" style={{ height: TRACK_ROW_H }}>
            <div
              className="sticky left-0 z-[5] flex flex-none items-center border-r border-b border-[#0e0f10] bg-card px-3"
              style={{ width: TRACK_HEADER_W }}
            >
              <span className="text-[11px] text-text-faint">Waiting for phones…</span>
            </div>
            <div
              className="flex-1 border-b border-[#0e0f10] bg-lane"
              style={laneGridStyle(pxPerSec)}
            >
              <p className="p-3 text-[11px] text-text-faint">
                Performers join via the QR invite; ● starts everyone at once.
              </p>
            </div>
          </div>
        )}
        {rows.map((row, rowIndex) => (
          <TimelineRow
            key={row.key}
            row={row}
            clips={rowClips[rowIndex] ?? []}
            pxPerSec={pxPerSec}
            laneWidth={laneWidth}
            level={levelFor(row)}
            strip={channels.find((c) => c.key === row.key)}
            recording={recording}
            armed={recording ? row.armed : !disarmedPeers.includes(row.key)}
            selected={row.key === selectedLaneKey}
            takeMic={takeMicOf(row)}
            onSelect={() => onSelectLane(row.key)}
            onLaneMenu={(x, y) => onLaneMenu(row.key, x, y)}
            onToggleArm={() => getDeskSession(sessionId).toggleArm(row.key)}
            {...(row.peerId
              ? {
                  onRename: (label: string) =>
                    getDeskSession(sessionId).renamePeer(row.peerId as string, label),
                }
              : {})}
          />
        ))}

        {midiLane && <MidiLaneRow lane={midiLane} pxPerSec={pxPerSec} laneWidth={laneWidth} />}

        {/* Header-band filler: extends the sticky header column to the
            container's bottom so overlays never scroll through the gap
            below the last lane; zero-height once lanes fill the view. */}
        <div className="flex min-h-0 flex-1" role="presentation">
          <div
            data-header-filler
            className="sticky left-0 z-[5] flex-none border-r border-divider bg-card"
            style={{ width: TRACK_HEADER_W }}
          />
        </div>

        {marquee && (
          <div
            className="pointer-events-none absolute z-[5] border border-accent bg-accent/10"
            style={{
              left: Math.min(marquee.x0, marquee.x1),
              top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0),
              height: Math.abs(marquee.y1 - marquee.y0),
            }}
          />
        )}

        {/* Song-boundary guides down the lanes (flags carry the names). */}
        {markersUsable &&
          markers.map((marker) => (
            <div
              key={marker.id}
              className="pointer-events-none absolute bottom-0 z-[3] w-px bg-accent/15"
              style={{
                left: TRACK_HEADER_W + (timelineBaseSec + marker.atSec) * pxPerSec,
                top: RULER_H,
              }}
            />
          ))}

        {/* Ghost cursors: other desks' playheads, quieter than local lines. */}
        {ghostPlayheads.map((ghost) => (
          <div
            key={ghost.clientId}
            data-ghost-playhead={ghost.clientId}
            className="pointer-events-none absolute top-0 bottom-0 z-[3] w-px opacity-45 transition-[left] duration-300 ease-linear"
            style={{
              left: TRACK_HEADER_W + ghost.atSec * pxPerSec,
              background: ghost.color,
            }}
          >
            <span
              className="absolute left-[3px] max-w-[72px] truncate rounded-[3px] px-[4px] py-px font-mono text-[7.5px] font-semibold tracking-[0.4px] text-void"
              style={{ background: ghost.color, top: RULER_H + 3 }}
            >
              {ghost.name}
            </span>
          </div>
        ))}

        {/* Playhead: the live take's write head while recording, the
            player position during playback. */}
        {playheadSec !== null && (
          <div
            data-playhead
            className="pointer-events-none absolute top-0 bottom-0 z-[4] w-px bg-accent"
            style={{ left: TRACK_HEADER_W + playheadSec * pxPerSec }}
          >
            <div
              className="absolute top-0 -left-[5px] size-[11px] bg-accent"
              style={{ clipPath: "polygon(0 0, 100% 0, 50% 100%)" }}
            />
          </div>
        )}
      </div>
    </section>
  );
}
