// Toolbar row (40px): tools, snap/grid, auto-align, marker/comment pills,
// status readouts, view tabs, zoom.

import { type DeskTool, SnapGrid, ToolGroup, ViewTabs, ZoomControl } from "./daw";
import type { PlayerSnapshot } from "./player";

export { DeskFatalPanel } from "./fatal-panel";

/** Auto-align control state — also the e2e observation surface. */
type AlignState = "aligning" | "aligned" | "declined" | "failed" | "idle";

const ALIGN_BUTTON_STYLES: Record<AlignState, string> = {
  aligning: "border-accent/50 text-accent/80",
  aligned: "border-accent text-accent",
  declined: "border-warn/60 text-warn",
  failed: "border-rec/60 text-rec",
  idle: "border-edge-strong text-text-faint",
};

const ALIGN_BUTTON_LABELS: Record<AlignState, string> = {
  aligning: "aligning…",
  aligned: "auto-align on",
  declined: "align declined",
  failed: "align failed",
  idle: "auto-align",
};

export function DeskToolbar({
  recording,
  playerLoaded,
  playerSnap,
  markersUsable,
  tool,
  lastChirpAt,
  errors,
  exportError,
  zoom,
  selectionCount,
  alignFlow,
  alignNote,
  laneNameOf,
  onTool,
  onZoom,
  onAutoAlign,
  onAddMarker,
  onOpenComments,
  onDismissError,
}: {
  recording: boolean;
  playerLoaded: boolean;
  playerSnap: PlayerSnapshot;
  markersUsable: boolean;
  /** Active editing tool: Select ↔ Split, owned by the desk. */
  tool: DeskTool;
  lastChirpAt: number | null;
  errors: string[];
  exportError: string | null;
  zoom: number;
  /** Selected clips: scopes the align button + its copy. */
  selectionCount: number;
  /** Multi-take align flow progress — non-null while running. */
  alignFlow: { done: number; total: number } | null;
  /** Transient align note: "manual offsets reset · N clips". */
  alignNote: string | null;
  /** Mixer-lane display name (nickname when set) for the align readout. */
  laneNameOf: (channelKey: string) => string;
  onTool: (tool: DeskTool) => void;
  onZoom: (zoom: number) => void;
  /** Selection-aware auto-align — index.tsx owns the flow. */
  onAutoAlign: () => void;
  onAddMarker: () => void;
  onOpenComments: () => void;
  onDismissError: (index: number) => void;
}) {
  const outcome = playerSnap.alignmentOutcome;
  const alignState: AlignState =
    playerSnap.aligning || alignFlow !== null ? "aligning" : (outcome?.kind ?? "idle");
  // Reference lane of the aligned outcome, named for humans.
  const referenceName =
    outcome?.kind === "aligned" && outcome.referenceStreamId
      ? laneNameOf(
          playerSnap.tracks.find((t) => t.streamId === outcome.referenceStreamId)?.channelKey ??
            outcome.referenceStreamId,
        )
      : null;
  // Display copy says "waveform"; the persisted method value stays
  // "content" for schema stability.
  const methodLabel =
    outcome?.kind === "aligned"
      ? outcome.method === "mixed"
        ? "chirp+waveform"
        : outcome.method === "content"
          ? "waveform"
          : "chirp"
      : null;
  const alignedTitle =
    outcome?.kind === "aligned"
      ? outcome.method === "chirp"
        ? "Chirp offsets applied at schedule time — stored audio untouched"
        : outcome.method === "content"
          ? "No usable calibration chirp — tracks aligned by cross-correlating their recorded waveforms against the reference lane. Offsets applied at schedule time — stored audio untouched."
          : "Chirp offsets where the sweep was found; waveform cross-correlation placed the rest. Applied at schedule time — stored audio untouched."
      : null;

  return (
    <div className="flex items-center justify-between border-b border-divider bg-raised px-3.5">
      <div className="flex min-w-0 items-center gap-3.5">
        <ToolGroup tool={tool} onTool={onTool} splitDisabled={recording} />
        {/* Divider belongs to SnapGrid — it sheds on the same tier. */}
        <div className="hidden h-[18px] w-px bg-edge min-[1200px]:block" />
        <SnapGrid />
        <button
          type="button"
          aria-label="Auto-align"
          // Split streams keep their region layout — only never-split clips' moves reset.
          title={
            selectionCount > 0
              ? `Re-align the ${selectionCount} selected clip${selectionCount === 1 ? "" : "s"} by waveform (chirp first when present) — resets moved clips (split clips keep their cuts)`
              : alignState === "idle" && !lastChirpAt
                ? "Align tracks: chirp correlation, falling back to waveform cross-correlation (run Chirp during a take for best precision)"
                : "Re-run alignment on the loaded take (chirp, then waveform fallback) — resets moved clips (split clips keep their cuts)"
          }
          data-align-state={alignState}
          disabled={!playerLoaded || playerSnap.aligning || recording || alignFlow !== null}
          onClick={onAutoAlign}
          // whitespace-nowrap: under flex squeeze the pill two-lined and
          // broke the 40px row — the verdict chip is the flexible child.
          className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[10.5px] font-semibold transition-colors disabled:cursor-not-allowed ${
            alignState === "idle" && lastChirpAt
              ? "border-accent/50 text-accent/80 hover:text-accent"
              : ALIGN_BUTTON_STYLES[alignState]
          }`}
        >
          <span className="text-[8px]">●</span>
          {ALIGN_BUTTON_LABELS[alignState]}
        </button>
        {/* Multi-take progress rides the outcome chip's slot; single-take
            runs keep "aligning…" — a 1/1 counter is noise. */}
        {alignFlow && alignFlow.total > 1 && (
          <span
            data-testid="align-outcome"
            className="min-w-0 max-w-[300px] truncate font-mono text-[9px] text-accent/80"
          >
            aligning take {Math.min(alignFlow.done + 1, alignFlow.total)}/{alignFlow.total}…
          </span>
        )}
        {/* aligned/declined/failed stay visibly distinct from "never ran". */}
        {!playerSnap.aligning && !alignFlow && outcome && (
          <span
            data-testid="align-outcome"
            title={
              outcome.kind === "aligned"
                ? (alignedTitle ?? "")
                : outcome.kind === "declined"
                  ? `Best correlation confidence ${outcome.confidence.toFixed(2)} (chirp and waveform both measured) is below the accept threshold ${outcome.threshold} — tracks play unaligned. Replay the chirp during a take, then re-run.`
                  : "Alignment crashed — tracks play unaligned. Re-run to retry."
            }
            className={`min-w-0 max-w-[300px] truncate font-mono text-[9px] ${
              outcome.kind === "aligned"
                ? "text-accent/90"
                : outcome.kind === "declined"
                  ? "text-warn"
                  : "text-rec"
            }`}
          >
            {outcome.kind === "aligned"
              ? `⇥ ${outcome.trackCount} track${outcome.trackCount === 1 ? "" : "s"} aligned · ${methodLabel}${
                  referenceName ? ` · ref ${referenceName}` : ""
                }`
              : outcome.kind === "declined"
                ? `declined · confidence ${outcome.confidence.toFixed(2)} < ${outcome.threshold}`
                : `failed: ${outcome.message}`}
          </span>
        )}
        {/* A re-align that cleared manual clip moves says so, quietly. */}
        {alignNote && (
          <span
            data-testid="align-note"
            title="Auto-align returns clips to their recorded positions plus the fresh alignment shift — manual drags on the realigned clips were discarded (all desks)."
            className="whitespace-nowrap font-mono text-[9px] text-text-faint"
          >
            {alignNote}
          </span>
        )}
        <button
          type="button"
          aria-label="Add marker at playhead"
          title="Add song marker at playhead (M) — or double-click the ruler"
          disabled={!markersUsable}
          onClick={onAddMarker}
          className="flex items-center gap-1.5 whitespace-nowrap rounded-full border border-edge-strong px-2.5 py-1 text-[10.5px] font-semibold text-text-mute transition-colors hover:text-text-hi disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="text-[8px] text-accent/80">◆</span>
          {/* Label sheds below 1024 (width-sweep-pinned tier); icon +
              title + aria carry the meaning below the boundary. */}
          <span className="hidden min-[1024px]:inline">marker</span>
        </button>
        <button
          type="button"
          aria-label="Add comment at playhead"
          title="Comment at playhead (N)"
          disabled={!markersUsable}
          onClick={onOpenComments}
          className="flex items-center gap-1.5 whitespace-nowrap rounded-full border border-edge-strong px-2.5 py-1 text-[10.5px] font-semibold text-text-mute transition-colors hover:text-text-hi disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="text-[8px] text-pin/80">●</span>
          {/* Sheds with the marker label — same tier, same reason. */}
          <span className="hidden min-[1024px]:inline">comment</span>
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
        {/* Error strip: EVERY live error renders — capped and self-expiring
            in desk-session — each with its own dismiss. */}
        {errors.map((message, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: entries are positional (dismissError is index-based) and may repeat verbatim
            key={`${index}:${message}`}
            data-testid="desk-error"
            className="flex min-w-0 items-center gap-1.5 rounded-full border border-rec/40 bg-rec/10 py-0.5 pr-1.5 pl-2.5 font-mono text-[9px] text-rec"
          >
            <span className="max-w-[220px] truncate" title={message}>
              {message}
            </span>
            <button
              type="button"
              aria-label={`Dismiss error: ${message}`}
              onClick={() => onDismissError(index)}
              className="flex-none text-[12px] leading-none hover:brightness-125"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-3.5">
        <ViewTabs />
        <ZoomControl zoom={zoom} onZoom={onZoom} />
      </div>
    </div>
  );
}
