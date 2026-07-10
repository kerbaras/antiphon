// One audio lane: sticky header (name, M/S/arm, peer chip, VU) + clip lane.

import { useState } from "react";
import { Badge } from "../../components";
import { ClipCard, type ClipModel } from "./clip-card";
import {
  laneGridStyle,
  RenameInput,
  TRACK_HEADER_W,
  TRACK_ROW_H,
  TrackMiniButton,
  VUVertical,
} from "./lane-chrome";
import type { ChannelStrip } from "./player";
import { LanePeerChip } from "./ruler-markers";
import type { TrackRow } from "./track-model";
import { getPlayer } from "./use-desk";

export function TimelineRow({
  row,
  clips,
  pxPerSec,
  laneWidth,
  level,
  strip,
  recording,
  armed,
  selected,
  takeMic,
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
  /** Arm changes can't act until the rolling take stops — honest disable. */
  recording: boolean;
  armed: boolean;
  selected: boolean;
  takeMic: string | null | undefined;
  onSelect: () => void;
  onLaneMenu: (x: number, y: number) => void;
  onToggleArm: () => void;
  onRename?: (label: string) => void;
}) {
  return (
    // The row seam (border-b) lives on the CHILDREN, never this wrapper:
    // a wrapper border paints at z-auto and full-height overlays (playhead,
    // guides) bled 1px through it while crossing the sticky header band.
    <div className="flex" style={{ height: TRACK_ROW_H }}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer select/context-menu surface; the header's buttons are the keyboard path */}
      <div
        data-lane-header={row.key}
        data-selected={selected}
        onPointerDown={onSelect}
        onContextMenu={(e) => {
          e.preventDefault();
          onLaneMenu(e.clientX, e.clientY);
        }}
        className={`sticky left-0 z-[5] flex flex-none items-stretch border-r border-b border-divider border-b-[#0e0f10] ${
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
              <LanePeerChip
                color={row.color}
                initials={row.peerInitials}
                avatarUrl={row.avatarUrl}
                receiving={row.receiving}
                label={row.peerLabel}
                takeMic={takeMic}
              />
            )}
          </div>
        </div>
        <div className="flex w-[14px] flex-none items-end bg-[#191a1b] px-1 py-1.5">
          <VUVertical active={row.receiving} level={level} className="h-[52px]" />
        </div>
      </div>

      <div
        className="relative border-b border-[#0e0f10] bg-lane"
        style={{ width: laneWidth, ...laneGridStyle(pxPerSec) }}
      >
        {clips.map((clip) => (
          <ClipCard key={clip.id} clip={clip} />
        ))}
      </div>
    </div>
  );
}

/** Lane title with inline rename (double-click, or the hover pencil).
 * Renames ride peer-update — the title changes on the server echo. Only
 * lanes mapping to a known peer get the affordance. */
function LaneName({ name, onRename }: { name: string; onRename?: (label: string) => void }) {
  const [editing, setEditing] = useState(false);

  if (editing && onRename) {
    return (
      <RenameInput
        name={name}
        ariaLabel="Rename lane"
        // The one editable field on the select-none timeline surface.
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
