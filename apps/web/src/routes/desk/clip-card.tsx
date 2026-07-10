// Timeline clip box: header strip with status badge (or a 4px status dot
// when too narrow), peak-normalized waveform bars, tool-aware cursors.

import type React from "react";
import { cx } from "../../components";
import { hexA } from "./color";
import { SPLIT_CURSOR } from "./split-cursor";
import { waveformGainChip, waveformViewGain } from "./waveform-view";

export interface ClipModel {
  /** Region id — the streamId for a never-split stream, a minted uuid for
   * later pieces. Selection and marquee collect these. */
  id: string;
  streamId: string;
  takeId: string;
  name: string;
  color: string;
  x: number;
  width: number;
  durationSec: number;
  live: boolean;
  /** Split tool active: blade cursor, press = cut. */
  splitting?: boolean;
  /** Trim tool active: resize cursor, press grabs the nearest edge. */
  trimming?: boolean;
  /** "incomplete" is TERMINAL (truncated stream that will never finish
   * syncing) — distinct from the transient "syncing". */
  badge: "rec" | "converged" | "syncing" | "aligned" | "incomplete" | null;
  energy: number[];
  /** Fraction of the clip holding audio (< 1 while a live take grows). */
  fillFraction: number;
  selected?: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
  /** Double-click loads the take — selection alone never does. */
  onDoubleClick?: (e: React.MouseEvent) => void;
}

/** Peak-preserving resample of a waveform to `n` bars. */
function resampleBars(src: number[], n: number): number[] {
  if (src.length === 0 || n <= 0) return [];
  return Array.from({ length: n }, (_, i) => {
    const start = Math.floor((i * src.length) / n);
    const end = Math.max(start + 1, Math.floor(((i + 1) * src.length) / n));
    return Math.max(...src.slice(start, end));
  });
}

// Narrower than this and the badge would clip mid-word: it degrades to a
// status dot; the title tooltip always carries the words.
const CLIP_BADGE_MIN_W = 72;

const BADGE_LABEL: Record<NonNullable<ClipModel["badge"]>, string> = {
  rec: "recording",
  aligned: "aligned",
  converged: "converged",
  syncing: "syncing",
  incomplete:
    "incomplete (truncated mid-take: recorder reloaded — audio preserved, no end marker ever arrived)",
};

const BADGE_CLASS: Record<Exclude<NonNullable<ClipModel["badge"]>, "rec">, string> = {
  aligned: "bg-white/40 text-void",
  converged: "bg-white/40 text-void",
  syncing: "bg-void/25 text-warn",
  incomplete: "bg-warn text-void",
};

const BADGE_TEXT: Record<Exclude<NonNullable<ClipModel["badge"]>, "rec">, string> = {
  aligned: "⇥ aligned",
  converged: "⇥ converged",
  syncing: "syncing",
  incomplete: "⚠ incomplete",
};

function clipCursorStyle(clip: ClipModel): React.CSSProperties {
  if (clip.splitting !== true && clip.trimming !== true) return {};
  if (clip.badge === "incomplete") return { cursor: "not-allowed" };
  return { cursor: clip.trimming === true ? "ew-resize" : SPLIT_CURSOR };
}

function Badge({ badge }: { badge: NonNullable<ClipModel["badge"]> }) {
  if (badge === "rec") {
    return (
      <span
        data-badge="rec"
        className="ml-auto flex flex-none items-center gap-[3px] rounded-[3px] bg-rec px-[5px] font-mono text-[7px] font-bold text-white uppercase animate-recpulse"
      >
        ● rec
      </span>
    );
  }
  return (
    <span
      data-badge={badge}
      {...(badge === "incomplete" ? { title: BADGE_LABEL.incomplete } : {})}
      className={cx(
        "ml-auto flex-none rounded-[3px] px-1 font-mono text-[7px] font-bold uppercase",
        BADGE_CLASS[badge],
      )}
    >
      {BADGE_TEXT[badge]}
    </span>
  );
}

/** 4px stand-in when the clip is too narrow for a badge. Both amber states
 * stay distinguishable by FORM: syncing (transient) is hollow, incomplete
 * (terminal) is solid — echoing their badges. */
function StatusDot({ badge }: { badge: NonNullable<ClipModel["badge"]> }) {
  return (
    <span
      data-status-dot={badge}
      className={cx(
        "ml-auto size-[4px] flex-none rounded-full",
        badge === "rec" && "bg-rec animate-recpulse",
        badge === "syncing" && "border border-warn",
        badge === "incomplete" && "bg-warn",
        (badge === "converged" || badge === "aligned") && "bg-white/70",
      )}
    />
  );
}

export function ClipCard({ clip }: { clip: ClipModel }) {
  const edge = clip.live
    ? "var(--color-rec)"
    : clip.selected
      ? "var(--color-accent)"
      : hexA(clip.color, 0.55);
  const widthPx = Math.max(clip.width, 26);
  const showBadge = clip.badge !== null && widthPx >= CLIP_BADGE_MIN_W;
  const audioWidth = Math.max(0, (widthPx - 10) * Math.min(1, clip.fillFraction));
  // Decoded peaks draw peak-normalized per clip; a significant view gain is
  // declared by the ×N chip. The live proxy is already self-scaled.
  const viewGain = clip.live ? 1 : waveformViewGain(clip.energy);
  const gainChip = clip.live ? null : waveformGainChip(viewGain);
  const bars = resampleBars(clip.energy, Math.floor(audioWidth / 3));
  const status = clip.badge !== null ? BADGE_LABEL[clip.badge] : null;
  const title = `${clip.name}${status ? ` — ${status}` : ""}${
    gainChip !== null ? ` · waveform drawn ×${gainChip}` : ""
  }`;
  return (
    <button
      type="button"
      aria-label={`Select ${clip.name}`}
      title={title}
      data-clip={clip.id}
      data-selected={clip.selected ?? false}
      onPointerDown={clip.onPointerDown}
      onDoubleClick={clip.onDoubleClick}
      className={cx(
        "absolute inset-y-1 overflow-hidden rounded-[5px] border p-0 text-left",
        // Terminal-incomplete clips sit one z-plane below every other clip:
        // an orphan can fully cover the audible re-armed stream in the same
        // slot, and clicks in the overlap must reach the complete clip.
        clip.badge === "incomplete" ? "z-0" : "z-[1]",
        clip.onPointerDown && clip.splitting !== true && clip.trimming !== true
          ? "cursor-grab active:cursor-grabbing"
          : "cursor-default",
        clip.selected && "shadow-[0_0_0_1px_var(--color-accent)]",
      )}
      style={{
        left: clip.x,
        width: widthPx,
        background: hexA(clip.color, clip.live ? 0.16 : 0.24),
        borderColor: edge,
        ...clipCursorStyle(clip),
      }}
    >
      <div
        className="absolute inset-x-0 top-0 flex h-[14px] items-center gap-1.5 px-1.5"
        style={{ background: clip.live ? "var(--color-rec)" : clip.color }}
      >
        <span className="truncate text-[8.5px] font-semibold text-void">{clip.name}</span>
        {showBadge && clip.badge !== null && <Badge badge={clip.badge} />}
        {!showBadge && clip.badge !== null && <StatusDot badge={clip.badge} />}
      </div>
      <div
        data-wave
        className="absolute inset-x-0 top-[14px] bottom-0 flex items-center gap-px overflow-hidden px-[5px]"
      >
        {bars.map((v, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional
            key={i}
            className="w-[2px] flex-none rounded-[1px] bg-white/50"
            style={{ height: `${Math.max(4, Math.min(1, v * viewGain) * 92)}%` }}
          />
        ))}
      </div>
      {gainChip !== null && (
        <span
          data-wave-gain={gainChip}
          className="pointer-events-none absolute right-[3px] bottom-[2px] rounded-[3px] bg-void/45 px-[3px] font-mono text-[7px] font-semibold text-text-faint"
        >
          ×{gainChip}
        </span>
      )}
    </button>
  );
}
