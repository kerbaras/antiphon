// DAW chrome pieces, lifted measurement-for-measurement from the prototype
// (docs/Antiphone DAW.dc.html): transport icon groups, inset info chips,
// toolbar tools, ruler/track/clip geometry, pan knobs, faders, VU meters.
// Anything not yet functional is visibly inert (aria-disabled), never fake.

import type { ReactNode } from "react";

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
  people: Array<{ initials: string; color: string; title: string }>;
  onAdd?: () => void;
}) {
  return (
    <div className="flex items-center">
      {people.map((p, i) => (
        <div
          key={p.title}
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

const TOOLS: Array<{ name: string; key: string }> = [
  { name: "Select", key: "V" },
  { name: "Trim", key: "T" },
  { name: "Split", key: "S" },
  { name: "Stretch", key: "R" },
  { name: "Fade", key: "F" },
  { name: "Align", key: "A" },
];

/** Editing tool group — visually faithful, inert until the DAW milestone. */
export function ToolGroup() {
  return (
    <div
      aria-disabled="true"
      title="Editing tools arrive with the timeline milestone"
      className="flex cursor-not-allowed gap-0.5 rounded-md border border-edge bg-bg p-[2px]"
    >
      {TOOLS.map((tool, i) => (
        <span
          key={tool.name}
          className={cx(
            "flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-semibold",
            i === 0 ? "bg-edge text-text-mute" : "text-text-faint",
          )}
        >
          {tool.name}
          <span className="font-mono text-[9px] opacity-70">{tool.key}</span>
        </span>
      ))}
    </div>
  );
}

/** Snap / Grid inset chips (inert until editing lands). */
export function SnapGrid() {
  return (
    <div
      aria-disabled="true"
      className="flex cursor-not-allowed items-center gap-2 text-[11px] text-text-faint"
    >
      <span>Snap</span>
      <span className="rounded-[5px] border border-edge bg-bg px-2 py-[3px] font-semibold text-text-dim">
        Bar ▾
      </span>
      <span>Grid</span>
      <span className="rounded-[5px] border border-edge bg-bg px-2 py-[3px] font-mono font-semibold text-text-dim">
        1/16
      </span>
    </div>
  );
}

/** Arrange / Session inset tab pair (Session arrives with the DAW). */
export function ViewTabs() {
  return (
    <div className="flex rounded-md border border-edge bg-bg p-[2px] text-[11px] font-semibold">
      <span className="rounded bg-accent px-3.5 py-1 text-white">Arrange</span>
      <span
        aria-disabled="true"
        title="Session view arrives with the DAW milestone"
        className="cursor-not-allowed px-3.5 py-1 text-text-faint"
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
  badge: "rec" | "converged" | "syncing" | "aligned" | null;
  /** Waveform samples 0..1: true decoded peaks for loaded takes, encoded
   * signal-complexity proxy otherwise. */
  energy: number[];
  /** Fraction of the clip that has audio (< 1 while a live take grows). */
  fillFraction: number;
  selected?: boolean;
  /** Press = select; press-and-drag = move every selected clip. */
  onPointerDown?: (e: React.PointerEvent) => void;
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

export function ClipCard({ clip }: { clip: ClipModel }) {
  const edge = clip.live
    ? "var(--color-rec)"
    : clip.selected
      ? "var(--color-accent)"
      : hexA(clip.color, 0.55);
  const head = clip.live ? "var(--color-rec)" : clip.color;
  const widthPx = Math.max(clip.width, 26);
  // One 2px bar per 3px of AUDIO-holding width (prototype density), spread
  // over the recorded fraction of the clip.
  const audioWidth = Math.max(0, (widthPx - 10) * Math.min(1, clip.fillFraction));
  const bars = resampleBars(clip.energy, Math.floor(audioWidth / 3));
  return (
    <button
      type="button"
      aria-label={`Select ${clip.name}`}
      data-clip={clip.id}
      onPointerDown={clip.onPointerDown}
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
        {clip.badge === "rec" && (
          <span className="ml-auto flex flex-none items-center gap-[3px] rounded-[3px] bg-rec px-[5px] font-mono text-[7px] font-bold text-white uppercase animate-recpulse">
            ● rec
          </span>
        )}
        {clip.badge === "aligned" && (
          <span className="ml-auto flex-none rounded-[3px] bg-white/40 px-1 font-mono text-[7px] font-bold text-void uppercase">
            ⇥ aligned
          </span>
        )}
        {clip.badge === "converged" && (
          <span className="ml-auto flex-none rounded-[3px] bg-white/40 px-1 font-mono text-[7px] font-bold text-void uppercase">
            ⇥ converged
          </span>
        )}
        {clip.badge === "syncing" && (
          <span className="ml-auto flex-none rounded-[3px] bg-void/25 px-1 font-mono text-[7px] font-bold text-warn uppercase">
            syncing
          </span>
        )}
      </div>
      <div className="absolute inset-x-0 top-[14px] bottom-0 flex items-center gap-px overflow-hidden px-[5px]">
        {bars.map((v, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional
            key={i}
            className="w-[2px] flex-none rounded-[1px] bg-white/50"
            style={{ height: `${Math.max(4, Math.min(1, v) * 92)}%` }}
          />
        ))}
      </div>
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

/** 18×18 M/S/arm buttons in a track header (M/S inert until mixdown). */
export function TrackMiniButton({
  label,
  armed,
  inert,
}: {
  label: string;
  armed?: boolean;
  inert?: boolean;
}) {
  return (
    <span
      aria-disabled={inert}
      title={inert ? "Mix controls arrive with the DAW milestone" : undefined}
      className={cx(
        "grid size-[18px] place-items-center rounded border border-edge-btn text-[9px] font-bold",
        armed ? "bg-rec text-white" : "bg-[#232425] text-text-dim",
        inert && "cursor-not-allowed",
      )}
    >
      {label}
    </span>
  );
}

// ---- mixer -----------------------------------------------------------------

export function PanKnob() {
  return (
    <div
      aria-disabled="true"
      title="Pan arrives with stereo render (v1 streams are mono)"
      className="relative size-6 cursor-not-allowed rounded-full border border-edge-strong bg-edge"
    >
      <div className="absolute top-[2px] left-1/2 h-[9px] w-[2px] rounded-[1px] bg-[#c8c9cb]" />
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

/** Draggable gain fader. Without `onChange` it renders inert. */
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
      role="slider"
      aria-label={label}
      aria-valuenow={Math.round(db)}
      aria-valuemin={FADER_MIN_DB}
      aria-valuemax={FADER_MAX_DB}
      tabIndex={0}
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
  muted?: boolean;
  onMute?: () => void;
  soloed?: boolean;
  onSolo?: () => void;
  dbText?: string;
}

export function MixerStrip({
  name,
  color,
  active,
  master,
  level,
  gainDb = 0,
  onGainDb,
  muted,
  onMute,
  soloed,
  onSolo,
  dbText,
}: MixerStripProps) {
  const db =
    dbText ?? (onGainDb ? (gainDb <= FADER_MIN_DB ? "−∞ dB" : `${gainDb.toFixed(1)} dB`) : "—");
  return (
    <div
      className={cx(
        "flex flex-none flex-col border-r border-[#0e0f10]",
        master ? "w-[118px] border-l border-l-divider bg-card-hi" : "w-[104px] bg-card",
      )}
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
        <PanKnob />
      </div>
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
