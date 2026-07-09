// Arrange timeline: ruler (markers, comment ticks, active-song strip),
// track rows with sticky headers, clips, marquee rectangle, playhead.
// Pointer/keyboard interaction state lives with the desk orchestrator
// (index.tsx); this module renders it.

import type { RefObject } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { Badge, SectionLabel } from "../../ui/kit";
import type { TakeComment } from "./comments";
import {
  ClipCard,
  type ClipModel,
  LaneRuler,
  laneGridStyle,
  RenameInput,
  RULER_H,
  TRACK_HEADER_W,
  TRACK_ROW_H,
  TrackMiniButton,
  VUVertical,
} from "./daw";
import { formatAt } from "./format";
import type { Marker, Song } from "./markers";
import { type MidiLaneModel, MidiLaneRow } from "./midi-lane";
import type { ChannelStrip } from "./player";
import type { TrackRow } from "./track-model";
import { getDeskSession, getPlayer } from "./use-desk";

export interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
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
  activeSong,
  durationSec,
  selectedBaseSec,
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
  activeSong: Song | null;
  /** Loaded take duration (marker double-click bounds, song strip end). */
  durationSec: number;
  selectedBaseSec: number;
  markers: Marker[];
  comments: TakeComment[];
  /** The selected take's captured MIDI (W3-C), when it has any. */
  midiLane: MidiLaneModel | null;
  playheadSec: number | null;
  /** Other desks' cursors (W3-A presence), arrangement-timeline seconds. */
  ghostPlayheads: Array<{ clientId: number; name: string; color: string; atSec: number }>;
  marquee: Marquee | null;
  /** Selected lane (W4-E): desk-local UI state shared with the mixer —
   * highlighted here, target of the S/M keyboard shortcuts. */
  selectedLaneKey: string | null;
  onSelectLane: (key: string) => void;
  /** Right-click a row header: the lane context menu at the cursor (W4-E). */
  onLaneMenu: (key: string, x: number, y: number) => void;
  onSeekTimeline: (sec: number) => void;
  onAddMarkerAt: (atSec: number) => void;
}) {
  // LOW — anchored zoom. A zoom change rescales every lane x, so with a raw
  // scrollLeft the content slides under the operator's eye. Correct the
  // viewport in the same frame (layout effect: after the new widths are in
  // the DOM, before paint): whatever second sits under the ANCHOR keeps its
  // viewport x. Anchor = the playhead when it's inside the visible lane
  // area, else the center of that area (lanes start after the sticky
  // header). Clamped at 0 — zooming out near the origin can't over-scroll.
  const prevPxPerSec = useRef(pxPerSec);
  useLayoutEffect(() => {
    const prev = prevPxPerSec.current;
    prevPxPerSec.current = pxPerSec;
    if (prev === pxPerSec) return;
    const viewport = timelineRef.current?.parentElement;
    if (!viewport) return;
    const scroll = viewport.scrollLeft;
    // Default anchor: center of the visible lane area, as a content second.
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
  return (
    // The timeline is an instrument surface, not a document (W4-C): drags
    // here mean marquee/clip-move/seek, so text selection is suppressed for
    // the whole surface — ruler numerals, lane labels, clip titles. Scoped
    // to this section on purpose: copyable text elsewhere in the desk stays
    // copyable, and the lane-rename input re-enables selection for itself.
    <section className="relative min-w-0 flex-1 select-none overflow-auto bg-bg">
      {/* Pointer editing surface (seek/marquee/drag); the transport
          buttons + space bar are the keyboard path. min-h-full: the empty
          space below the last lane is timeline too (W4-C) — marquees and
          click-to-seek must work from the whole scrollable area, not just
          the rows' own height. */}
      <div
        ref={timelineRef}
        className="relative min-h-full min-w-full"
        style={{ width: laneWidth + TRACK_HEADER_W }}
        onPointerDown={onLanePointerDown}
        role="presentation"
      >
        {/* ruler row */}
        <div className="sticky top-0 z-[6] flex">
          <div
            className="sticky left-0 z-[7] flex flex-none items-center border-r border-b border-divider bg-panel px-2.5"
            style={{ width: TRACK_HEADER_W, height: RULER_H }}
          >
            <SectionLabel>Tracks</SectionLabel>
          </div>
          {/* Ruler + marker layer. Double-click bookmarks a song at
              that spot (single clicks still seek via LaneRuler). */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: dblclick shortcut; the toolbar button + M key are the accessible path */}
          <div
            data-ruler
            role="presentation"
            className="relative"
            onDoubleClick={(e) => {
              if (!markersUsable) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const atSec = (e.clientX - rect.left) / pxPerSec - selectedBaseSec;
              if (atSec < 0 || atSec > durationSec) return;
              onAddMarkerAt(atSec);
            }}
          >
            {/* Ruler seeks park the playhead even with nothing loaded
                (W4-C click-to-seek); only a rolling take suspends them —
                the playhead rides the write head. */}
            <LaneRuler
              pxPerSec={pxPerSec}
              widthPx={laneWidth}
              {...(!recording ? { onSeek: onSeekTimeline } : {})}
            />
            {/* Active-song accent strip (the prototype's ruler range bar) */}
            {markersUsable && activeSong && (
              <div
                className="pointer-events-none absolute top-0 z-[1] h-1 rounded-b-[2px] bg-accent opacity-70"
                style={{
                  left: (selectedBaseSec + activeSong.startSec) * pxPerSec,
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
                  x={(selectedBaseSec + marker.atSec) * pxPerSec}
                  onSeek={() => getPlayer().seek(marker.atSec)}
                />
              ))}
            {/* Comment ticks (W2-F): amber, at the ruler's foot, below
                the marker flags — markers own the top. */}
            {markersUsable &&
              comments.map((comment) => (
                <CommentTick
                  key={comment.id}
                  comment={comment}
                  x={(selectedBaseSec + comment.atSec) * pxPerSec}
                  onSeek={() => getPlayer().seek(comment.atSec)}
                />
              ))}
          </div>
        </div>

        {/* track rows */}
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

        {/* MIDI data lane (W3-C): under the audio rows, only when the
            selected take captured events. Sits below every audio row, so
            the marquee's row-indexed hit rects stay untouched. */}
        {midiLane && <MidiLaneRow lane={midiLane} pxPerSec={pxPerSec} laneWidth={laneWidth} />}

        {/* Marquee selection rectangle */}
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

        {/* Marker guides: a whisper of each song boundary down the
            lanes (the ruler flags carry the names). */}
        {markersUsable &&
          markers.map((marker) => (
            <div
              key={marker.id}
              className="pointer-events-none absolute bottom-0 z-[3] w-px bg-accent/15"
              style={{
                left: TRACK_HEADER_W + (selectedBaseSec + marker.atSec) * pxPerSec,
                top: RULER_H,
              }}
            />
          ))}

        {/* Ghost cursors: other desks' playheads (W3-A presence) — a thin
            translucent hairline with a whisper of a name tag, deliberately
            quieter than every local line. */}
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

        {/* Playhead: rides the live take's write head while recording,
            the player position during playback. */}
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

/** Ruler flag for one marker: a full-height hairline with the song name
 * chipped at the ruler's head — comment ticks own the foot (W2-F). Accent
 * at low alpha so the solid-accent playhead stays the loudest line; click
 * seeks to the song start.
 *
 * Hit target (F11): ONLY a 7px strip over the hairline plus the label chip.
 * The button must not blanket the ruler — a full-height column the width of
 * the label steals background seeks (an invisible 2–4 s dead-zone at 100%
 * zoom) and click-shadows the z-[1] comment ticks exactly where comments
 * cluster (song starts). The strip also stops above the ticks' 10px foot
 * lane so a tick AT the song start stays clickable; a click on that last
 * sliver of hairline falls through to the ruler seek, which lands within
 * half a pixel of the marker anyway. */
function MarkerFlag({ marker, x, onSeek }: { marker: Marker; x: number; onSeek: () => void }) {
  return (
    <button
      type="button"
      data-marker={marker.id}
      aria-label={`Marker ${marker.name}`}
      title={`${marker.name} — click to seek`}
      onClick={(e) => {
        e.stopPropagation();
        onSeek();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="group/marker absolute top-0 bottom-[10px] z-[2] w-[7px]"
      style={{ left: x - 3 }}
    >
      <span
        className="pointer-events-none absolute top-0 left-[3px] w-px bg-accent/50 group-hover/marker:bg-accent"
        style={{ height: RULER_H }}
      />
      <span className="absolute top-[4px] left-[6px] max-w-[96px] truncate rounded-[3px] border border-edge-btn bg-raised/95 px-[5px] py-px font-mono text-[8px] font-semibold tracking-[0.4px] text-text-mute group-hover/marker:border-accent/60 group-hover/marker:text-accent">
        {marker.name}
      </span>
    </button>
  );
}

/** Ruler presence for one comment: a small amber tick at the ruler's foot,
 * visually subordinate to the marker flags above (markers own the top).
 * Click seeks; the panel is the interaction surface — no popovers in v1. */
function CommentTick({
  comment,
  x,
  onSeek,
}: {
  comment: TakeComment;
  x: number;
  onSeek: () => void;
}) {
  const resolved = comment.resolvedAtMs !== null;
  return (
    <button
      type="button"
      data-comment-tick={comment.id}
      data-resolved={resolved}
      aria-label={`Comment: ${comment.text}`}
      title={`${comment.author} @ ${formatAt(comment.atSec)} — ${comment.text}`}
      onClick={(e) => {
        e.stopPropagation();
        onSeek();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="absolute bottom-0 z-[1] flex h-[10px] w-[7px] -translate-x-1/2 items-end justify-center"
      style={{ left: x }}
    >
      <span className={`h-[6px] w-[3px] rounded-t-[1px] ${resolved ? "bg-pin/30" : "bg-pin"}`} />
    </button>
  );
}

// ---- timeline row -----------------------------------------------------------

function TimelineRow({
  row,
  clips,
  pxPerSec,
  laneWidth,
  level,
  strip,
  recording,
  armed,
  selected,
  onSelect,
  onLaneMenu,
  onToggleArm,
  onRename,
}: {
  row: TrackRow;
  clips: ClipModel[];
  pxPerSec: number;
  laneWidth: number;
  level: number;
  strip: ChannelStrip | undefined;
  /** A take is rolling: arm changes can't act until it stops, so the
   * arm toggle is honestly disabled instead of silently deferring. */
  recording: boolean;
  armed: boolean;
  /** Lane selection (W4-E): press anywhere on the header — same accent
   * ring as the lane's mixer strip; S/M then key on this lane. */
  selected: boolean;
  onSelect: () => void;
  /** Right-click: the lane context menu at the cursor (W4-E). */
  onLaneMenu: (x: number, y: number) => void;
  onToggleArm: () => void;
  onRename?: (label: string) => void;
}) {
  return (
    <div className="flex border-b border-[#0e0f10]" style={{ height: TRACK_ROW_H }}>
      {/* header (232px, sticky) — press anywhere selects the lane,
          right-click opens the lane menu (the header's buttons remain
          the keyboard path) */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer select/context-menu surface; the header's buttons are the keyboard path */}
      <div
        data-lane-header={row.key}
        data-selected={selected}
        onPointerDown={onSelect}
        onContextMenu={(e) => {
          e.preventDefault();
          onLaneMenu(e.clientX, e.clientY);
        }}
        className={`sticky left-0 z-[5] flex flex-none items-stretch border-r border-divider ${
          selected ? "bg-card-hi shadow-[inset_0_0_0_1px_var(--color-accent)]" : "bg-card"
        }`}
        style={{ width: TRACK_HEADER_W }}
      >
        <div className="w-1 flex-none" style={{ background: row.color }} />
        <div className="flex min-w-0 flex-1 flex-col justify-between px-2 py-[7px]">
          <div className="group/lane flex min-w-0 items-center gap-1.5">
            <LaneName name={row.name} {...(onRename ? { onRename } : {})} />
            <Badge className="flex-none">audio</Badge>
          </div>
          <div className="flex items-center gap-[5px]">
            <TrackMiniButton
              label="M"
              ariaLabel={`Mute ${row.name} (header)`}
              active={strip?.muted ?? false}
              tone="gold"
              onClick={() => getPlayer().toggleChannelMute(row.key)}
            />
            <TrackMiniButton
              label="S"
              ariaLabel={`Solo ${row.name} (header)`}
              active={strip?.soloed ?? false}
              tone="teal"
              onClick={() => getPlayer().toggleChannelSolo(row.key)}
            />
            <TrackMiniButton
              label="●"
              ariaLabel={`Arm ${row.name}`}
              armed={armed}
              disabled={recording}
              onClick={onToggleArm}
            />
            {row.peerLabel && (
              <span className="ml-[3px] flex min-w-0 items-center gap-1 rounded-[10px] border border-edge bg-[#17181a] py-px pr-[7px] pl-[2px]">
                <span
                  className="relative grid size-[14px] flex-none place-items-center rounded-full text-[7px] font-bold text-void"
                  style={{ background: row.color }}
                >
                  {row.peerInitials}
                  <span
                    className="absolute -right-px -bottom-px size-[5px] rounded-full border border-[#17181a]"
                    style={{
                      background: row.receiving ? "var(--color-rec)" : "var(--color-ok)",
                    }}
                  />
                </span>
                <span className="truncate text-[9px] text-text-dim">{row.peerLabel}</span>
              </span>
            )}
          </div>
        </div>
        <div className="flex w-[14px] flex-none items-end bg-[#191a1b] px-1 py-1.5">
          <VUVertical active={row.receiving} level={level} className="h-[52px]" />
        </div>
      </div>

      {/* lane */}
      <div className="relative bg-lane" style={{ width: laneWidth, ...laneGridStyle(pxPerSec) }}>
        {clips.map((clip) => (
          <ClipCard key={clip.id} clip={clip} />
        ))}
      </div>
    </div>
  );
}

/** Lane title with inline rename: double-click the name, or the pencil
 * that appears on header hover. Renames go through peer-update (A13) —
 * the server persists and fans out; the title updates on the echo. Only
 * lanes that map to a known peer get the affordance. The editor itself is
 * the shared RenameInput (daw.tsx) — the mixer strip title (W4-E) opens
 * the exact same one. */
function LaneName({ name, onRename }: { name: string; onRename?: (label: string) => void }) {
  const [editing, setEditing] = useState(false);

  if (editing && onRename) {
    return (
      <RenameInput
        name={name}
        ariaLabel="Rename lane"
        // select-text: the timeline surface is select-none (W4-C) — the one
        // legitimately editable/copyable field on it opts back in.
        className="w-full min-w-0 select-text rounded-[3px] border border-accent bg-bg px-1 py-px text-[11.5px] font-semibold text-text-hi outline-none"
        onCommit={onRename}
        onClose={() => setEditing(false)}
      />
    );
  }
  if (!onRename) {
    return <span className="truncate text-[11.5px] font-semibold text-text-strong">{name}</span>;
  }
  return (
    <>
      <button
        type="button"
        onDoubleClick={() => setEditing(true)}
        title="Double-click to rename"
        className="min-w-0 cursor-text truncate text-left text-[11.5px] font-semibold text-text-strong"
      >
        {name}
      </button>
      <button
        type="button"
        aria-label={`Rename ${name}`}
        onClick={() => setEditing(true)}
        className="hidden flex-none font-mono text-[10px] leading-none text-text-faint group-hover/lane:inline hover:text-accent"
      >
        ✎
      </button>
    </>
  );
}
