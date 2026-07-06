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

/** Vertical VU strip; animates only while `active` (real data flowing). */
export function VUVertical({
  active,
  className,
  width = 6,
}: {
  active: boolean;
  className?: string;
  width?: number;
}) {
  return (
    <div
      className={cx("relative overflow-hidden rounded-[2px] bg-well", className)}
      style={{ width }}
    >
      <div
        className={cx(
          "vu-gradient-v absolute inset-x-0 bottom-0 origin-bottom transition-transform",
          active ? "animate-vu" : "scale-y-0",
        )}
        style={{ height: "88%" }}
      />
    </div>
  );
}

// ---- timeline --------------------------------------------------------------

export interface ClipModel {
  id: string;
  name: string;
  color: string;
  x: number;
  width: number;
  live: boolean;
  badge: "rec" | "converged" | "syncing" | null;
  energy: number[];
}

export function ClipCard({ clip }: { clip: ClipModel }) {
  const edge = clip.live ? "var(--color-rec)" : hexA(clip.color, 0.55);
  const head = clip.live ? "var(--color-rec)" : clip.color;
  return (
    <div
      className="absolute inset-y-1 overflow-hidden rounded-[5px] border"
      style={{
        left: clip.x,
        width: Math.max(clip.width, 26),
        background: hexA(clip.color, clip.live ? 0.16 : 0.24),
        borderColor: edge,
      }}
    >
      <div className="flex h-[14px] items-center gap-1.5 px-1.5" style={{ background: head }}>
        <span className="truncate text-[8.5px] font-semibold text-void">{clip.name}</span>
        {clip.badge === "rec" && (
          <span className="ml-auto flex flex-none items-center gap-[3px] rounded-[3px] bg-rec px-[5px] font-mono text-[7px] font-bold text-white uppercase animate-recpulse">
            ● rec
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
        {clip.energy.map((v, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional
            key={i}
            className="w-[2px] flex-none rounded-[1px] bg-white/50"
            style={{ height: `${Math.max(6, v * 82)}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/** Time ruler with second labels — the prototype's bar ruler, in seconds
 * (Antiphon has no tempo; the session clock is the grid). */
export function LaneRuler({ pxPerSec, widthPx }: { pxPerSec: number; widthPx: number }) {
  const step = pxPerSec >= 36 ? 2 : pxPerSec >= 18 ? 5 : 10;
  const marks: number[] = [];
  for (let s = 0; s * pxPerSec < widthPx; s += step) marks.push(s);
  return (
    <div
      className="relative border-b border-divider bg-raised"
      style={{
        height: RULER_H,
        width: widthPx,
        backgroundImage: `repeating-linear-gradient(90deg, var(--color-edge-inset) 0 1px, transparent 1px ${
          step * pxPerSec
        }px)`,
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
      title="Pan arrives with the DAW milestone"
      className="relative size-6 cursor-not-allowed rounded-full border border-edge-strong bg-edge"
    >
      <div className="absolute top-[2px] left-1/2 h-[9px] w-[2px] rounded-[1px] bg-[#c8c9cb]" />
    </div>
  );
}

export function Fader({ position = 0.3 }: { position?: number }) {
  return (
    <div className="relative w-[5px] rounded-[3px] bg-well">
      <div
        aria-disabled="true"
        title="Gain arrives with the DAW milestone"
        className="absolute -left-2 h-[11px] w-[21px] cursor-not-allowed rounded-[3px] border border-divider shadow-[0_1px_3px_rgba(0,0,0,.6)]"
        style={{
          top: `${position * 100}%`,
          background: "linear-gradient(180deg,#5a5c5e,#38393b)",
        }}
      >
        <div className="mt-[5px] h-px bg-accent" />
      </div>
    </div>
  );
}

export function MixerStrip({
  name,
  color,
  active,
  master,
  db = "0.0 dB",
}: {
  name: string;
  color: string;
  active: boolean;
  master?: boolean;
  db?: string;
}) {
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
        <Fader position={master ? 0.22 : 0.3} />
        <div className="flex items-end gap-[2px]">
          <VUVertical active={active} width={4} className="h-full" />
          <VUVertical active={active} width={4} className="h-full" />
        </div>
      </div>
      <div className="flex justify-center gap-1 py-[3px]">
        {!master && (
          <>
            <span className="grid h-4 w-5 cursor-not-allowed place-items-center rounded-[3px] border border-edge-btn bg-[#232425] text-[8.5px] font-bold text-text-dim">
              M
            </span>
            <span className="grid h-4 w-5 cursor-not-allowed place-items-center rounded-[3px] border border-edge-btn bg-[#232425] text-[8.5px] font-bold text-text-dim">
              S
            </span>
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
