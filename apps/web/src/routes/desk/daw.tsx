// DAW chrome pieces, lifted measurement-for-measurement from the prototype
// (docs/Antiphone DAW.dc.html): transport icon groups, inset info chips,
// toolbar tools, ruler/track/clip geometry, pan knobs, faders, VU meters.
// Anything not yet functional is visibly inert (aria-disabled), never fake.

import type { ReactNode } from "react";
import {
  EQ_DB_RANGE,
  EQ_MID_HZ_DEFAULT,
  EQ_MID_HZ_MAX,
  EQ_MID_HZ_MIN,
  type EqBandPatch,
  type EqState,
  formatEqDb,
  formatEqHz,
  midHzToNorm,
  normToMidHz,
} from "./eq";
import { waveformGainChip, waveformViewGain } from "./waveform-view";

export const TRACK_HEADER_W = 232;
export const TRACK_ROW_H = 66;
export const RULER_H = 30;

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ---- top bar ---------------------------------------------------------------

/** 28×24 icon button inside an inset transport group. */
export function TransportButton({
  label,
  active,
  tone = "plain",
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  tone?: "plain" | "accent" | "rec";
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "grid h-6 w-7 place-items-center rounded text-[11px] transition-colors",
        tone === "accent" && active && "bg-accent text-white",
        tone === "rec" && active && "text-rec animate-recpulse",
        tone === "rec" && !active && "text-rec/80 hover:bg-card-hi",
        tone === "plain" && "text-text-mute hover:bg-card-hi",
        tone === "accent" && !active && "text-text-mute hover:bg-card-hi",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      {children}
    </button>
  );
}

/** Inset container for transport buttons (prototype: bg #141516 p-[3px]). */
export function TransportGroup({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-edge-inset bg-bg p-[3px]">
      {children}
    </div>
  );
}

/** Timecode display — mono 15px in an inset well. */
export function Timecode({ seconds }: { seconds: number }) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <div className="rounded-md border border-edge-inset bg-bg px-3 py-1 font-mono text-[15px] font-semibold tracking-[1px] text-text-hi">
      {pad(Math.floor(seconds / 3600))}:{pad(Math.floor((seconds / 60) % 60))}:
      {pad(Math.floor(seconds % 60))}
      <span className="text-text-faint">:{pad(Math.floor((seconds % 1) * 100))}</span>
    </div>
  );
}

/** Small inset info chip (prototype: "122 BPM" / "4/4" / "A min"). */
export function InfoChip({ value, unit }: { value: ReactNode; unit?: string }) {
  return (
    <div className="rounded-md border border-edge-inset bg-bg px-2.5 py-[5px] font-mono text-[11px] text-text-mute">
      <span className="font-semibold text-text-hi">{value}</span>
      {unit ? ` ${unit}` : ""}
    </div>
  );
}

/** Overlapping avatar stack (prototype top-right). */
export function AvatarStack({
  people,
  onAdd,
}: {
  /** `id` is the stable identity (titles may repeat: two desks both named
   * "Desk"). */
  people: Array<{ id: string; initials: string; color: string; title: string }>;
  onAdd?: () => void;
}) {
  return (
    <div className="flex items-center">
      {people.map((p, i) => (
        <div
          key={p.id}
          title={p.title}
          className={cx(
            "grid size-[26px] place-items-center rounded-full border-2 border-panel",
            "text-[9.5px] font-bold text-void",
            i > 0 && "-ml-[7px]",
          )}
          style={{ background: p.color }}
        >
          {p.initials}
        </div>
      ))}
      <button
        type="button"
        aria-label="Invite performer"
        onClick={onAdd}
        className="-ml-[7px] grid size-[26px] place-items-center rounded-full border-2 border-panel bg-card-hi text-[11px] text-text-dim hover:text-text"
      >
        +
      </button>
    </div>
  );
}

// ---- toolbar ---------------------------------------------------------------

/** Muted "soon" chip marking prototype chrome that is not yet functional. */
function SoonChip() {
  return (
    <span className="rounded-[3px] bg-edge px-1 py-px font-mono text-[7.5px] font-semibold tracking-[0.5px] text-text-faint uppercase">
      soon
    </span>
  );
}

const INERT_TOOLS: Array<{ name: string; key: string }> = [
  { name: "Trim", key: "T" },
  { name: "Split", key: "S" },
  { name: "Stretch", key: "R" },
  { name: "Fade", key: "F" },
  { name: "Align", key: "A" },
];

/** Editing tool group. Select is the one live tool (clip click / marquee /
 * drag on the timeline); the rest keep the prototype's layout but read
 * unmistakably disabled — dimmed, cursor-blocked, tagged "soon". */
export function ToolGroup() {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-edge bg-bg p-[2px]">
      <span className="flex items-center gap-1.5 rounded bg-edge px-2.5 py-1 text-[11px] font-semibold text-text-mute">
        Select
        <span className="font-mono text-[9px] opacity-70">V</span>
      </span>
      <span
        aria-disabled="true"
        title="Coming soon — editing tools arrive with the timeline milestone"
        className="flex cursor-not-allowed items-center gap-0.5 opacity-40"
      >
        {INERT_TOOLS.map((tool) => (
          <span
            key={tool.name}
            className="flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-semibold text-text-faint"
          >
            {tool.name}
            <span className="font-mono text-[9px] opacity-70">{tool.key}</span>
          </span>
        ))}
      </span>
      <span className="pr-1 pl-0.5">
        <SoonChip />
      </span>
    </div>
  );
}

/** Snap / Grid inset chips — visibly disabled until editing lands. */
export function SnapGrid() {
  return (
    <div
      aria-disabled="true"
      title="Coming soon — snap and grid land with the editing tools"
      className="flex cursor-not-allowed items-center gap-2 text-[11px] text-text-faint"
    >
      <span className="flex items-center gap-2 opacity-40">
        <span>Snap</span>
        <span className="rounded-[5px] border border-edge bg-bg px-2 py-[3px] font-semibold text-text-dim">
          Bar ▾
        </span>
        <span>Grid</span>
        <span className="rounded-[5px] border border-edge bg-bg px-2 py-[3px] font-mono font-semibold text-text-dim">
          1/16
        </span>
      </span>
      <SoonChip />
    </div>
  );
}

/** Arrange / Session inset tab pair — Session is visibly disabled until
 * the DAW milestone (Arrange is the only real view). */
export function ViewTabs() {
  return (
    <div className="flex rounded-md border border-edge bg-bg p-[2px] text-[11px] font-semibold">
      <span className="rounded bg-accent px-3.5 py-1 text-white">Arrange</span>
      <span
        aria-disabled="true"
        title="Coming soon — Session view arrives with the DAW milestone"
        className="cursor-not-allowed px-3.5 py-1 text-text-faint opacity-40"
      >
        Session
      </span>
    </div>
  );
}

export function ZoomControl({ zoom, onZoom }: { zoom: number; onZoom: (z: number) => void }) {
  return (
    <div className="flex items-center gap-1.5 font-mono text-[12px] text-text-dim">
      <button
        type="button"
        aria-label="Zoom out"
        className="rounded border border-edge px-[7px] py-px hover:text-text"
        onClick={() => onZoom(Math.max(0.5, zoom - 0.25))}
      >
        −
      </button>
      <span className="text-[10px]">{Math.round(zoom * 100)}%</span>
      <button
        type="button"
        aria-label="Zoom in"
        className="rounded border border-edge px-[6px] py-px hover:text-text"
        onClick={() => onZoom(Math.min(2, zoom + 0.25))}
      >
        +
      </button>
    </div>
  );
}

// ---- meters ----------------------------------------------------------------

/** Vertical VU strip. With a numeric `level` (0..1) it meters that level;
 * otherwise it shows the data-flow activity animation while `active`. */
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

// ---- timeline --------------------------------------------------------------

export interface ClipModel {
  id: string;
  takeId: string;
  name: string;
  color: string;
  x: number;
  width: number;
  durationSec: number;
  live: boolean;
  /** "incomplete" (F9) is TERMINAL: an A6-truncated stream that will never
   * finish syncing — distinct from the transient "syncing". */
  badge: "rec" | "converged" | "syncing" | "aligned" | "incomplete" | null;
  /** Waveform samples 0..1: true decoded peaks for loaded takes, encoded
   * signal-complexity proxy otherwise. */
  energy: number[];
  /** Fraction of the clip that has audio (< 1 while a live take grows). */
  fillFraction: number;
  selected?: boolean;
  /** Press = select; press-and-drag = move every selected clip. */
  onPointerDown?: (e: React.PointerEvent) => void;
  /** Double-click = the EXPLICIT load-this-take action (selection alone
   * never switches the loaded take — QA E3). */
  onDoubleClick?: (e: React.MouseEvent) => void;
}

/** Peak-preserving resample of a waveform to `n` bars. */
function resampleBars(src: number[], n: number): number[] {
  if (src.length === 0 || n <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = Math.floor((i * src.length) / n);
    const end = Math.max(start + 1, Math.floor(((i + 1) * src.length) / n));
    let peak = 0;
    for (let j = start; j < end && j < src.length; j++) {
      peak = Math.max(peak, src[j] as number);
    }
    out.push(peak);
  }
  return out;
}

/** Below this clip width the status badge yields (LOW: min-width clips):
 * the longest badge ("⇥ converged") plus header padding needs ~66px — on a
 * narrower clip it would render half-clipped mid-word. The status stays in
 * the header strip as a 4px status DOT (the kit's avatar status-dot
 * pattern, same tones as the badges) and in the button's title tooltip,
 * which always carries it in words. */
const CLIP_BADGE_MIN_W = 72;

const BADGE_LABEL: Record<NonNullable<ClipModel["badge"]>, string> = {
  rec: "recording",
  aligned: "aligned",
  converged: "converged",
  syncing: "syncing",
  // Terminal verdict (F9): the words ride the clip title in BOTH badge
  // and dot form — a 4px dot alone must never be the whole story.
  incomplete:
    "incomplete (truncated mid-take: recorder reloaded — audio preserved, no end marker ever arrived)",
};

export function ClipCard({ clip }: { clip: ClipModel }) {
  const edge = clip.live
    ? "var(--color-rec)"
    : clip.selected
      ? "var(--color-accent)"
      : hexA(clip.color, 0.55);
  const head = clip.live ? "var(--color-rec)" : clip.color;
  const widthPx = Math.max(clip.width, 26);
  const showBadge = clip.badge !== null && widthPx >= CLIP_BADGE_MIN_W;
  // One 2px bar per 3px of AUDIO-holding width (prototype density), spread
  // over the recorded fraction of the clip.
  const audioWidth = Math.max(0, (widthPx - 10) * Math.min(1, clip.fillFraction));
  // F18 — decoded peaks draw peak-normalized per clip, declared by the ×N
  // chip when the view gain is significant (see waveform-view.ts). The live
  // proxy is already self-scaled and has no amplitude axis: gain 1, no chip.
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
        clip.onPointerDown ? "cursor-grab active:cursor-grabbing" : "cursor-default",
        clip.selected && "shadow-[0_0_0_1px_var(--color-accent)]",
      )}
      style={{
        left: clip.x,
        width: widthPx,
        background: hexA(clip.color, clip.live ? 0.16 : 0.24),
        borderColor: edge,
      }}
    >
      {/* Header strip pinned to the top: buttons vertically center their
          flow content by default, so this must be absolute. */}
      <div
        className="absolute inset-x-0 top-0 flex h-[14px] items-center gap-1.5 px-1.5"
        style={{ background: head }}
      >
        <span className="truncate text-[8.5px] font-semibold text-void">{clip.name}</span>
        {showBadge && clip.badge === "rec" && (
          <span
            data-badge="rec"
            className="ml-auto flex flex-none items-center gap-[3px] rounded-[3px] bg-rec px-[5px] font-mono text-[7px] font-bold text-white uppercase animate-recpulse"
          >
            ● rec
          </span>
        )}
        {showBadge && clip.badge === "aligned" && (
          <span
            data-badge="aligned"
            className="ml-auto flex-none rounded-[3px] bg-white/40 px-1 font-mono text-[7px] font-bold text-void uppercase"
          >
            ⇥ aligned
          </span>
        )}
        {showBadge && clip.badge === "converged" && (
          <span
            data-badge="converged"
            className="ml-auto flex-none rounded-[3px] bg-white/40 px-1 font-mono text-[7px] font-bold text-void uppercase"
          >
            ⇥ converged
          </span>
        )}
        {showBadge && clip.badge === "syncing" && (
          <span
            data-badge="syncing"
            className="ml-auto flex-none rounded-[3px] bg-void/25 px-1 font-mono text-[7px] font-bold text-warn uppercase"
          >
            syncing
          </span>
        )}
        {/* Solid amber, dark text: reads as a settled verdict (F9), not
            the translucent in-flight look of "syncing". */}
        {showBadge && clip.badge === "incomplete" && (
          <span
            data-badge="incomplete"
            title="Truncated mid-take (recorder reloaded) — the captured audio is preserved, but the stream never received its end marker"
            className="ml-auto flex-none rounded-[3px] bg-warn px-1 font-mono text-[7px] font-bold text-void uppercase"
          >
            ⚠ incomplete
          </span>
        )}
        {/* Too narrow for words: a status dot in the badge's tones (rec
            pulses, syncing AND the terminal incomplete warn amber — the
            dot vocabulary can't split them, the title's words do; settled
            states read white like their badges). */}
        {!showBadge && clip.badge !== null && (
          <span
            data-status-dot={clip.badge}
            className={cx(
              "ml-auto size-[4px] flex-none rounded-full",
              clip.badge === "rec" && "bg-rec animate-recpulse",
              (clip.badge === "syncing" || clip.badge === "incomplete") && "bg-warn",
              (clip.badge === "converged" || clip.badge === "aligned") && "bg-white/70",
            )}
          />
        )}
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
      {/* View-gain declaration (F18): dim mono chip, bottom-right — quiet
          audio drawn readable must SAY it is drawn boosted. */}
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

/** Time ruler with second labels — the prototype's bar ruler, in seconds
 * (Antiphon has no tempo; the session clock is the grid). Click to seek. */
export function LaneRuler({
  pxPerSec,
  widthPx,
  onSeek,
}: {
  pxPerSec: number;
  widthPx: number;
  onSeek?: (sec: number) => void;
}) {
  const step = pxPerSec >= 36 ? 2 : pxPerSec >= 18 ? 5 : 10;
  const marks: number[] = [];
  for (let s = 0; s * pxPerSec < widthPx; s += step) marks.push(s);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: seek surface; transport buttons are the keyboard path
    // biome-ignore lint/a11y/useKeyWithClickEvents: same
    <div
      className={cx("relative border-b border-divider bg-raised", onSeek && "cursor-pointer")}
      style={{
        height: RULER_H,
        width: widthPx,
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

/** 18×18 M/S/arm buttons in a track header (M/S inert until mixdown).
 * The arm variant (an `armed` state) is a toggle like the others, so it
 * carries aria-pressed too, plus the sticky-disarm honesty title: arm
 * changes never interrupt a rolling take — they apply between takes
 * (deliberate product semantics; the QA "mid-take disarm silently inert"
 * low is answered by SAYING so, not by changing the behavior). */
export function TrackMiniButton({
  label,
  armed,
  inert,
  active,
  tone,
  onClick,
  ariaLabel,
}: {
  label: string;
  armed?: boolean;
  inert?: boolean;
  /** Engaged state for clickable buttons (mute gold, solo teal). */
  active?: boolean;
  tone?: "gold" | "teal";
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const activeClass = tone === "teal" ? "bg-track-teal text-void" : "bg-track-gold text-void";
  const className = cx(
    "grid size-[18px] place-items-center rounded border border-edge-btn text-[9px] font-bold",
    armed ? "bg-rec text-white" : active ? activeClass : "bg-[#232425] text-text-dim",
    inert && "cursor-not-allowed",
    onClick && "hover:brightness-125",
  );
  if (onClick) {
    return (
      <button
        type="button"
        aria-label={ariaLabel ?? label}
        aria-pressed={armed ?? active}
        {...(armed !== undefined ? { title: "arm changes apply between takes" } : {})}
        onClick={onClick}
        className={className}
      >
        {label}
      </button>
    );
  }
  return (
    <span aria-disabled={inert} className={className}>
      {label}
    </span>
  );
}

// ---- mixer -----------------------------------------------------------------

/** Pan knob: drag horizontally (or vertically) to place the mono source in
 * the stereo field; arrows step 0.05 (Right/Up pan right — the drag axes),
 * Home/End hit the rails, double-click recenters. The tick rotates ±135°. */
export function PanKnob({
  pan = 0,
  onPan,
  label,
}: {
  pan?: number;
  onPan?: (pan: number) => void;
  label?: string;
}) {
  const snap = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 20) / 20;
  function startDrag(downEvent: React.PointerEvent<HTMLDivElement>) {
    if (!onPan) return;
    downEvent.preventDefault();
    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    const startPan = pan;
    const move = (e: PointerEvent) => {
      const delta = (e.clientX - startX - (e.clientY - startY)) / 60;
      onPan(snap(startPan + delta));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!onPan) return;
    const next =
      e.key === "ArrowUp" || e.key === "ArrowRight"
        ? snap(pan + 0.05)
        : e.key === "ArrowDown" || e.key === "ArrowLeft"
          ? snap(pan - 0.05)
          : e.key === "Home"
            ? -1
            : e.key === "End"
              ? 1
              : null;
    if (next === null) return;
    e.preventDefault();
    onPan(next);
  }
  const readout =
    pan === 0 ? "C" : pan < 0 ? `L${Math.round(-pan * 100)}` : `R${Math.round(pan * 100)}`;
  return (
    <div
      role="slider"
      aria-label={label ?? "Pan"}
      aria-valuenow={Math.round(pan * 100)}
      aria-valuemin={-100}
      aria-valuemax={100}
      aria-valuetext={readout}
      tabIndex={0}
      title={`Pan ${readout} — drag to move, double-click to center`}
      onPointerDown={startDrag}
      onDoubleClick={() => onPan?.(0)}
      onKeyDown={onKeyDown}
      className="relative size-6 cursor-ew-resize touch-none rounded-full border border-edge-strong bg-edge"
    >
      <div className="absolute inset-0" style={{ transform: `rotate(${pan * 135}deg)` }}>
        <div
          className={cx(
            "absolute top-[2px] left-1/2 h-[9px] w-[2px] -translate-x-1/2 rounded-[1px]",
            pan === 0 ? "bg-[#c8c9cb]" : "bg-accent",
          )}
        />
      </div>
    </div>
  );
}

// ---- channel EQ -------------------------------------------------------------

/** Mini EQ gain knob (±12 dB) — the pan-knob interaction pattern at track-
 * button scale: drag vertically (up boosts), double-click resets to 0 dB,
 * arrows step 0.5 dB, Home/End jump to the rails. */
function EqKnob({ label, db, onDb }: { label: string; db: number; onDb?: (db: number) => void }) {
  const clamp = (v: number) => Math.max(-EQ_DB_RANGE, Math.min(EQ_DB_RANGE, v));
  function startDrag(down: React.PointerEvent<HTMLDivElement>) {
    if (!onDb) return;
    down.preventDefault();
    const startY = down.clientY;
    const startDb = db;
    const move = (e: PointerEvent) => {
      onDb(clamp(Math.round((startDb + (startY - e.clientY) / 6) * 2) / 2));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!onDb) return;
    const next =
      e.key === "ArrowUp" || e.key === "ArrowRight"
        ? clamp(db + 0.5)
        : e.key === "ArrowDown" || e.key === "ArrowLeft"
          ? clamp(db - 0.5)
          : e.key === "Home"
            ? -EQ_DB_RANGE
            : e.key === "End"
              ? EQ_DB_RANGE
              : null;
    if (next === null) return;
    e.preventDefault();
    onDb(next);
  }
  return (
    <div
      role="slider"
      aria-label={label}
      aria-valuenow={db}
      aria-valuemin={-EQ_DB_RANGE}
      aria-valuemax={EQ_DB_RANGE}
      aria-valuetext={`${formatEqDb(db)} dB`}
      tabIndex={0}
      title={`${label} ${formatEqDb(db)} dB — drag to adjust, double-click to reset`}
      onPointerDown={startDrag}
      onDoubleClick={() => onDb?.(0)}
      onKeyDown={onKeyDown}
      className="relative size-4 cursor-ns-resize touch-none rounded-full border border-edge-strong bg-edge"
    >
      <div
        className="absolute inset-0"
        style={{ transform: `rotate(${(db / EQ_DB_RANGE) * 135}deg)` }}
      >
        <div
          className={cx(
            "absolute top-[1px] left-1/2 h-[6px] w-[2px] -translate-x-1/2 rounded-[1px]",
            db === 0 ? "bg-[#c8c9cb]" : "bg-accent",
          )}
        />
      </div>
    </div>
  );
}

/** Mid-band center frequency as a draggable mono readout: vertical drag
 * sweeps 200 Hz–8 kHz on a log scale, double-click recalls 1 kHz. */
function EqFreq({ label, hz, onHz }: { label: string; hz: number; onHz?: (hz: number) => void }) {
  const NORM_STEP = 1 / 24;
  function startDrag(down: React.PointerEvent<HTMLDivElement>) {
    if (!onHz) return;
    down.preventDefault();
    const startY = down.clientY;
    const startNorm = midHzToNorm(hz);
    const move = (e: PointerEvent) => {
      onHz(Math.round(normToMidHz(startNorm + (startY - e.clientY) / 140)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!onHz) return;
    const norm = midHzToNorm(hz);
    const next =
      e.key === "ArrowUp" || e.key === "ArrowRight"
        ? normToMidHz(norm + NORM_STEP)
        : e.key === "ArrowDown" || e.key === "ArrowLeft"
          ? normToMidHz(norm - NORM_STEP)
          : e.key === "Home"
            ? EQ_MID_HZ_MIN
            : e.key === "End"
              ? EQ_MID_HZ_MAX
              : null;
    if (next === null) return;
    e.preventDefault();
    onHz(Math.round(next));
  }
  return (
    <div
      role="slider"
      aria-label={label}
      aria-valuenow={Math.round(hz)}
      aria-valuemin={EQ_MID_HZ_MIN}
      aria-valuemax={EQ_MID_HZ_MAX}
      aria-valuetext={`${formatEqHz(hz)}Hz`}
      tabIndex={0}
      title={`${label} ${formatEqHz(hz)}Hz — drag to sweep, double-click for ${formatEqHz(EQ_MID_HZ_DEFAULT)}Hz`}
      onPointerDown={startDrag}
      onDoubleClick={() => onHz?.(EQ_MID_HZ_DEFAULT)}
      onKeyDown={onKeyDown}
      className="min-w-[30px] cursor-ns-resize touch-none rounded-[3px] border border-edge-inset bg-bg px-1 py-px text-center font-mono text-[8px] text-text-dim"
    >
      {formatEqHz(hz)}
    </div>
  );
}

const EQ_BANDS = [
  { param: "lowDb", short: "L", band: "low" },
  { param: "midDb", short: "M", band: "mid" },
  { param: "highDb", short: "H", band: "high" },
] as const;

/** Strip EQ block: L/M/H mini-knobs with dB readouts, the mid-frequency
 * sweep, and the EQ in/bypass pill. Bypassed state dims the whole block —
 * the signal path really does reconnect around the filters. */
function EqSection({
  name,
  eq,
  onEq,
  onEqBypass,
}: {
  name: string;
  eq: EqState;
  onEq?: (patch: EqBandPatch) => void;
  onEqBypass?: () => void;
}) {
  return (
    <div className="border-y border-divider px-1 pt-[4px] pb-[3px]">
      <div className={cx("flex justify-center gap-[9px]", eq.bypassed && "opacity-45")}>
        {EQ_BANDS.map(({ param, short, band }) => (
          <div key={param} className="flex flex-col items-center gap-[2px]">
            <EqKnob
              label={`${name} EQ ${band}`}
              db={eq[param]}
              {...(onEq ? { onDb: (db: number) => onEq({ [param]: db }) } : {})}
            />
            <span
              className={cx(
                "font-mono text-[7.5px] leading-none",
                eq[param] === 0 ? "text-text-faint" : "text-text-mute",
              )}
            >
              {short} {formatEqDb(eq[param])}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-center gap-1.5 pt-[3px]">
        <button
          type="button"
          aria-label={`${name} EQ bypass`}
          aria-pressed={eq.bypassed}
          disabled={!onEqBypass}
          onClick={onEqBypass}
          title={eq.bypassed ? "EQ bypassed — click to engage" : "EQ in — click to bypass"}
          className={cx(
            "rounded-[3px] border px-[5px] py-px font-mono text-[7.5px] font-bold tracking-[0.5px]",
            eq.bypassed
              ? "border-edge-btn bg-[#232425] text-text-faint"
              : "border-accent/40 bg-accent/15 text-accent",
            onEqBypass ? "hover:brightness-125" : "cursor-not-allowed",
          )}
        >
          EQ
        </button>
        <div className={cx(eq.bypassed && "opacity-45")}>
          <EqFreq
            label={`${name} EQ mid frequency`}
            hz={eq.midHz}
            {...(onEq ? { onHz: (hz: number) => onEq({ midHz: hz }) } : {})}
          />
        </div>
      </div>
    </div>
  );
}

const FADER_MAX_DB = 6;
const FADER_MIN_DB = -60;

export function dbToFaderPos(db: number): number {
  return (FADER_MAX_DB - db) / (FADER_MAX_DB - FADER_MIN_DB);
}

function faderPosToDb(pos: number): number {
  return FADER_MAX_DB - pos * (FADER_MAX_DB - FADER_MIN_DB);
}

/** Fader readout: the bottom rail is −∞ (mirrored by the strip's visible
 * dB text and the fader's aria-valuetext — aria-valuenow alone can't say
 * "off"). */
function formatFaderDb(db: number): string {
  return db <= FADER_MIN_DB ? "−∞ dB" : `${db.toFixed(1)} dB`;
}

/** Draggable gain fader. Without `onChange` it renders inert. Pointer:
 * click/drag jumps the cap to the pointer; double-click resets to 0 dB.
 * Keyboard (the EQ knobs' conventions): arrows step 0.5 dB, Home/End hit
 * the −∞/+6 rails. */
export function Fader({
  db = 0,
  onChange,
  label,
}: {
  db?: number;
  onChange?: (db: number) => void;
  label?: string;
}) {
  const position = Math.max(0, Math.min(1, dbToFaderPos(db)));
  function startDrag(downEvent: React.PointerEvent<HTMLDivElement>) {
    if (!onChange) return;
    // Second press of a double-click: don't jump-to-click — the dblclick
    // handler is about to reset to 0 dB (pre-F13 the jump applied twice
    // and a "reset" parked the fader wherever the pointer sat).
    if (downEvent.detail > 1) return;
    const track = downEvent.currentTarget;
    const rect = track.getBoundingClientRect();
    const usable = rect.height - 11;
    const apply = (clientY: number) => {
      const p = Math.max(0, Math.min(1, (clientY - rect.top - 5) / usable));
      onChange(Math.round(faderPosToDb(p) * 2) / 2);
    };
    apply(downEvent.clientY);
    const move = (e: PointerEvent) => apply(e.clientY);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!onChange) return;
    const clamp = (v: number) => Math.max(FADER_MIN_DB, Math.min(FADER_MAX_DB, v));
    const next =
      e.key === "ArrowUp" || e.key === "ArrowRight"
        ? clamp(db + 0.5)
        : e.key === "ArrowDown" || e.key === "ArrowLeft"
          ? clamp(db - 0.5)
          : e.key === "Home"
            ? FADER_MIN_DB
            : e.key === "End"
              ? FADER_MAX_DB
              : null;
    if (next === null) return;
    e.preventDefault();
    onChange(next);
  }
  if (!onChange) {
    return (
      <div className="relative w-[5px] cursor-not-allowed rounded-[3px] bg-well opacity-70">
        <div
          className="pointer-events-none absolute -left-2 h-[11px] w-[21px] rounded-[3px] border border-divider shadow-[0_1px_3px_rgba(0,0,0,.6)]"
          style={{
            top: `calc(${position * 100}% - ${position * 11}px)`,
            background: "linear-gradient(180deg,#5a5c5e,#38393b)",
          }}
        >
          <div className="mt-[5px] h-px bg-accent" />
        </div>
      </div>
    );
  }
  return (
    <div
      className="relative w-[5px] cursor-ns-resize rounded-[3px] bg-well"
      onPointerDown={startDrag}
      onDoubleClick={() => onChange(0)}
      onKeyDown={onKeyDown}
      role="slider"
      aria-label={label}
      aria-valuenow={db}
      aria-valuemin={FADER_MIN_DB}
      aria-valuemax={FADER_MAX_DB}
      aria-valuetext={formatFaderDb(db)}
      tabIndex={0}
      title={`Gain ${formatFaderDb(db)} — drag to set, double-click for 0 dB`}
    >
      <div
        className="pointer-events-none absolute -left-2 h-[11px] w-[21px] rounded-[3px] border border-divider shadow-[0_1px_3px_rgba(0,0,0,.6)]"
        style={{
          top: `calc(${position * 100}% - ${position * 11}px)`,
          background: "linear-gradient(180deg,#5a5c5e,#38393b)",
        }}
      >
        <div className="mt-[5px] h-px bg-accent" />
      </div>
    </div>
  );
}

export interface MixerStripProps {
  name: string;
  color: string;
  active: boolean;
  master?: boolean;
  /** Real playback level 0..1; null/undefined → activity animation. */
  level?: number | null;
  gainDb?: number;
  onGainDb?: (db: number) => void;
  pan?: number;
  onPan?: (pan: number) => void;
  /** 3-band strip EQ state; omitted → no EQ block rendered. */
  eq?: EqState;
  onEq?: (patch: EqBandPatch) => void;
  onEqBypass?: () => void;
  muted?: boolean;
  onMute?: () => void;
  soloed?: boolean;
  onSolo?: () => void;
  dbText?: string;
  /** Another desk is touching this strip (W3-A presence): a faint inset
   * ring in that desk's color, quiet enough to ignore. */
  remoteEditor?: { name: string; color: string } | null;
}

export function MixerStrip({
  name,
  color,
  active,
  master,
  level,
  gainDb = 0,
  onGainDb,
  pan = 0,
  onPan,
  eq,
  onEq,
  onEqBypass,
  muted,
  onMute,
  soloed,
  onSolo,
  dbText,
  remoteEditor,
}: MixerStripProps) {
  const db = dbText ?? (onGainDb ? formatFaderDb(gainDb) : "—");
  return (
    <div
      className={cx(
        "flex flex-none flex-col border-r border-[#0e0f10]",
        master ? "w-[118px] border-l border-l-divider bg-card-hi" : "w-[104px] bg-card",
      )}
      {...(remoteEditor
        ? {
            "data-remote-editor": remoteEditor.name,
            title: `${remoteEditor.name} is adjusting this strip`,
            style: { boxShadow: `inset 0 0 0 1px ${hexA(remoteEditor.color, 0.55)}` },
          }
        : {})}
    >
      <div className="h-[3px]" style={{ background: color }} />
      <div
        className={cx(
          "truncate px-2 pt-[5px] pb-[3px] text-center text-[10px] font-semibold",
          master ? "font-bold tracking-[1.5px] text-text-hi" : "text-text",
        )}
      >
        {name}
      </div>
      <div className="flex justify-center py-1">
        <PanKnob pan={pan} {...(onPan ? { onPan } : {})} label={`${name} pan`} />
      </div>
      {eq && (
        <EqSection
          name={name}
          eq={eq}
          {...(onEq ? { onEq } : {})}
          {...(onEqBypass ? { onEqBypass } : {})}
        />
      )}
      <div className="flex min-h-0 flex-1 justify-center gap-[9px] py-1">
        <Fader db={gainDb} {...(onGainDb ? { onChange: onGainDb } : {})} label={`${name} gain`} />
        <div className="flex items-end gap-[2px]">
          <VUVertical active={active} level={level ?? null} width={4} className="h-full" />
          <VUVertical active={active} level={level ?? null} width={4} className="h-full" />
        </div>
      </div>
      <div className="flex justify-center gap-1 py-[3px]">
        {!master && (
          <>
            <button
              type="button"
              aria-label={`Mute ${name}`}
              aria-pressed={muted}
              disabled={!onMute}
              onClick={onMute}
              className={cx(
                "grid h-4 w-5 place-items-center rounded-[3px] border border-edge-btn text-[8.5px] font-bold",
                muted ? "bg-track-gold text-void" : "bg-[#232425] text-text-dim",
                onMute ? "hover:brightness-125" : "cursor-not-allowed",
              )}
            >
              M
            </button>
            <button
              type="button"
              aria-label={`Solo ${name}`}
              aria-pressed={soloed}
              disabled={!onSolo}
              onClick={onSolo}
              className={cx(
                "grid h-4 w-5 place-items-center rounded-[3px] border border-edge-btn text-[8.5px] font-bold",
                soloed ? "bg-track-teal text-void" : "bg-[#232425] text-text-dim",
                onSolo ? "hover:brightness-125" : "cursor-not-allowed",
              )}
            >
              S
            </button>
          </>
        )}
      </div>
      <div className="pb-1.5 text-center font-mono text-[9px] text-text-dim">{db}</div>
    </div>
  );
}

export function hexA(hex: string, alpha: number): string {
  return `color-mix(in srgb, ${hex} ${Math.round(alpha * 100)}%, transparent)`;
}
