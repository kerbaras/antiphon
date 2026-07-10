// Track-lane chrome: geometry constants, ruler, grid, mini buttons,
// vertical VU, and the shared inline rename editor.

import type React from "react";
import { useRef, useState } from "react";
import { cx } from "../../components";
import { NICKNAME_MAX_LENGTH } from "../../net/device-identity";

export const TRACK_HEADER_W = 232;
export const TRACK_ROW_H = 66;
export const RULER_H = 30;

/** Vertical VU strip: meters a 0..1 `level`, or shows the data-flow
 * activity animation while `active` when no level is given. */
export function VUVertical({
  active,
  level,
  className,
  width = 6,
}: {
  active: boolean;
  level?: number | null;
  className?: string;
  width?: number;
}) {
  const metered = typeof level === "number";
  return (
    <div
      className={cx("relative overflow-hidden rounded-[2px] bg-well", className)}
      style={{ width }}
    >
      <div
        className={cx(
          "vu-gradient-v absolute inset-x-0 bottom-0 origin-bottom",
          !metered && (active ? "animate-vu" : "scale-y-0"),
        )}
        style={
          metered
            ? { height: "100%", transform: `scaleY(${Math.min(1, level as number)})` }
            : { height: "88%" }
        }
      />
    </div>
  );
}

/** Second-labelled time ruler (no tempo — the session clock is the grid).
 * Click seeks; `cursor` overrides the pointer (the split blade). */
export function LaneRuler({
  pxPerSec,
  widthPx,
  onSeek,
  cursor,
}: {
  pxPerSec: number;
  widthPx: number;
  onSeek?: (sec: number) => void;
  cursor?: string;
}) {
  const step = pxPerSec >= 36 ? 2 : pxPerSec >= 18 ? 5 : 10;
  const marks = Array.from({ length: Math.ceil(widthPx / (step * pxPerSec)) }, (_, i) => i * step);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: seek surface; transport buttons are the keyboard path
    // biome-ignore lint/a11y/useKeyWithClickEvents: same
    <div
      className={cx(
        "relative border-b border-divider bg-raised",
        onSeek && cursor === undefined && "cursor-pointer",
      )}
      style={{
        height: RULER_H,
        width: widthPx,
        ...(cursor !== undefined ? { cursor } : {}),
        backgroundImage: `repeating-linear-gradient(90deg, var(--color-edge-inset) 0 1px, transparent 1px ${
          step * pxPerSec
        }px)`,
      }}
      onClick={(e) => {
        if (!onSeek) return;
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek((e.clientX - rect.left) / pxPerSec);
      }}
    >
      {marks.map((s) => (
        <span
          key={s}
          className="absolute top-2 pl-[5px] font-mono text-[9.5px] text-text-dim"
          style={{ left: s * pxPerSec }}
        >
          {s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : s}
        </span>
      ))}
    </div>
  );
}

export function laneGridStyle(pxPerSec: number): React.CSSProperties {
  return {
    backgroundImage: `repeating-linear-gradient(90deg, rgba(255,255,255,.045) 0 1px, transparent 1px ${pxPerSec * 5}px), repeating-linear-gradient(90deg, rgba(255,255,255,.015) 0 1px, transparent 1px ${pxPerSec}px)`,
  };
}

/** 18×18 M/S/arm track-header buttons. Arm changes apply between takes —
 * never mid-take — so the arm button is disabled while a take rolls and
 * its title says so. */
export function TrackMiniButton({
  label,
  armed,
  inert,
  active,
  tone,
  disabled,
  onClick,
  ariaLabel,
}: {
  label: string;
  armed?: boolean;
  inert?: boolean;
  active?: boolean;
  tone?: "gold" | "teal";
  disabled?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const activeClass = tone === "teal" ? "bg-track-teal text-void" : "bg-track-gold text-void";
  const className = cx(
    "grid size-[18px] place-items-center rounded border border-edge-btn text-[9px] font-bold",
    armed ? "bg-rec text-white" : active ? activeClass : "bg-[#232425] text-text-dim",
    inert && "cursor-not-allowed",
    onClick && "enabled:hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-40",
  );
  if (!onClick) {
    return (
      <span aria-disabled={inert} className={className}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-label={ariaLabel ?? label}
      aria-pressed={armed ?? active}
      {...(armed !== undefined ? { title: "arm changes apply between takes" } : {})}
      disabled={disabled ?? false}
      onClick={onClick}
      className={className}
    >
      {label}
    </button>
  );
}

/** The one inline-rename editor (sidebar lane titles and mixer strips):
 * Enter commits via blur, Escape cancels, focus selects all. Callers own
 * the open state; `onClose` always fires on exit. */
export function RenameInput({
  name,
  ariaLabel,
  className,
  onCommit,
  onClose,
}: {
  name: string;
  ariaLabel: string;
  className: string;
  /** Receives the trimmed draft — only when it differs from `name`. */
  onCommit: (label: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(name);
  const cancelled = useRef(false);
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: user explicitly opened the editor
      autoFocus
      value={draft}
      maxLength={NICKNAME_MAX_LENGTH}
      aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={(e) => {
        onClose();
        if (cancelled.current) {
          cancelled.current = false;
          return;
        }
        const next = e.target.value.trim();
        if (next !== name) onCommit(next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
      className={className}
    />
  );
}
