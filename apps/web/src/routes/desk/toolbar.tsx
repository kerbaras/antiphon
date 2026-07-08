// Toolbar row (40px): editing tools, snap/grid, auto-align, marker/comment
// pills, status readouts, view tabs, zoom.

import { SnapGrid, ToolGroup, ViewTabs, ZoomControl } from "./daw";
import type { PlayerSnapshot } from "./player";
import { getPlayer } from "./use-desk";

export function DeskToolbar({
  recording,
  playerLoaded,
  playerSnap,
  markersUsable,
  lastChirpAt,
  errors,
  exportError,
  zoom,
  onZoom,
  onAddMarker,
  onOpenComments,
}: {
  recording: boolean;
  playerLoaded: boolean;
  playerSnap: PlayerSnapshot;
  markersUsable: boolean;
  lastChirpAt: number | null;
  errors: string[];
  exportError: string | null;
  zoom: number;
  onZoom: (zoom: number) => void;
  onAddMarker: () => void;
  onOpenComments: () => void;
}) {
  return (
    <div className="flex items-center justify-between border-b border-divider bg-raised px-3.5">
      <div className="flex items-center gap-3.5">
        <ToolGroup />
        <div className="h-[18px] w-px bg-edge" />
        <SnapGrid />
        <button
          type="button"
          aria-label="Auto-align"
          disabled={!playerLoaded || playerSnap.aligning || recording}
          onClick={() => void getPlayer().align(true)}
          className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-semibold transition-colors disabled:cursor-not-allowed ${
            playerSnap.tracks.some((t) => t.alignment?.applied)
              ? "border-accent text-accent"
              : lastChirpAt
                ? "border-accent/50 text-accent/80 hover:text-accent"
                : "border-edge-strong text-text-faint"
          }`}
        >
          <span className="text-[8px]">●</span>
          {playerSnap.aligning
            ? "aligning…"
            : playerSnap.tracks.some((t) => t.alignment?.applied)
              ? "auto-align on"
              : "auto-align"}
        </button>
        <button
          type="button"
          aria-label="Add marker at playhead"
          title="Add song marker at playhead (M) — or double-click the ruler"
          disabled={!markersUsable}
          onClick={onAddMarker}
          className="flex items-center gap-1.5 rounded-full border border-edge-strong px-2.5 py-1 text-[10.5px] font-semibold text-text-mute transition-colors hover:text-text-hi disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="text-[8px] text-accent/80">◆</span>
          marker
        </button>
        <button
          type="button"
          aria-label="Add comment at playhead"
          title="Comment at playhead (C)"
          disabled={!markersUsable}
          onClick={onOpenComments}
          className="flex items-center gap-1.5 rounded-full border border-edge-strong px-2.5 py-1 text-[10.5px] font-semibold text-text-mute transition-colors hover:text-text-hi disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="text-[8px] text-pin/80">●</span>
          comment
        </button>
        {lastChirpAt && (
          <span className="font-mono text-[9px] text-text-faint">
            chirp emitted {new Date(lastChirpAt).toLocaleTimeString()}
          </span>
        )}
        {playerSnap.error && (
          <span className="font-mono text-[9px] text-warn">{playerSnap.error}</span>
        )}
        {exportError && (
          <span className="font-mono text-[9px] text-warn">export: {exportError}</span>
        )}
        {errors.length > 0 && (
          <span className="font-mono text-[9px] text-rec">{errors[errors.length - 1]}</span>
        )}
      </div>
      <div className="flex items-center gap-3.5">
        <ViewTabs />
        <ZoomControl zoom={zoom} onZoom={onZoom} />
      </div>
    </div>
  );
}
