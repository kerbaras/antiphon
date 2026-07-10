// One mixer channel strip: color cap, renameable title, pan, EQ, fader,
// meters, M/S, dB readout. Wheel over the strip trims its fader.

import type React from "react";
import { useEffect, useRef, useState } from "react";
import { cx } from "../../components";
import { hexA } from "./color";
import type { EqBandPatch, EqState } from "./eq";
import { FADER_MAX_DB, FADER_MIN_DB, Fader, formatFaderDb } from "./fader";
import { EqSection, PanKnob } from "./knobs";
import { RenameInput, VUVertical } from "./lane-chrome";

// One wheel notch ≈ 1 dB, ⌥ for 0.1 dB fine moves. Shift is deliberately
// NOT the fine modifier — macOS turns shift+wheel into a horizontal
// gesture, which must keep meaning "scroll the dock".
const WHEEL_DB_PER_NOTCH = 1;
const WHEEL_FINE_DB_PER_NOTCH = 0.1;
// Wheel events outrun React renders: a burst compounds on its own target
// for this long instead of re-reading the last-rendered prop.
const WHEEL_ACCUM_MS = 400;

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
  eq?: EqState;
  onEq?: (patch: EqBandPatch) => void;
  onEqBypass?: () => void;
  muted?: boolean;
  onMute?: () => void;
  soloed?: boolean;
  onSolo?: () => void;
  dbText?: string;
  /** Another desk is touching this strip: faint inset ring in its color. */
  remoteEditor?: { name: string; color: string } | null;
  /** Inline rename via double-click; present only for known peers. */
  onRename?: (label: string) => void;
  selected?: boolean;
  onSelect?: () => void;
  onLaneMenu?: (x: number, y: number) => void;
}

/** Native non-passive wheel listener trimming the strip's fader: React's
 * synthetic onWheel is passive, so its preventDefault is void. Horizontal
 * gestures pass through untouched (the dock's overflow-x). */
function useWheelTrim(gainDb: number, onGainDb?: (db: number) => void) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const props = useRef({ gainDb, onGainDb });
  props.current = { gainDb, onGainDb };
  const target = useRef<{ db: number; at: number } | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const { gainDb: current, onGainDb: apply } = props.current;
      if (!apply) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      // Pixel mode ≈ 100/notch (trackpads stream fractions), line mode ≈ 3.
      const notches = e.deltaY / (e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 3 : 100);
      const fresh = target.current;
      const base = fresh && performance.now() - fresh.at < WHEEL_ACCUM_MS ? fresh.db : current;
      const moved = base - notches * (e.altKey ? WHEEL_FINE_DB_PER_NOTCH : WHEEL_DB_PER_NOTCH);
      const next = Math.round(Math.max(FADER_MIN_DB, Math.min(FADER_MAX_DB, moved)) * 10) / 10;
      target.current = { db: next, at: performance.now() };
      apply(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  return rootRef;
}

function StripTitle({
  name,
  master,
  onRename,
}: {
  name: string;
  master?: boolean | undefined;
  onRename?: ((label: string) => void) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  if (editing && onRename) {
    return (
      <div className="px-1 pt-[3px] pb-[1px]">
        <RenameInput
          name={name}
          ariaLabel={`Rename ${name}`}
          className="w-full min-w-0 rounded-[3px] border border-accent bg-bg px-1 py-px text-center text-[10px] font-semibold text-text-hi outline-none"
          onCommit={onRename}
          onClose={() => setEditing(false)}
        />
      </div>
    );
  }
  if (onRename) {
    return (
      <button
        type="button"
        onDoubleClick={() => setEditing(true)}
        title="Double-click to rename"
        className="w-full cursor-text truncate px-2 pt-[5px] pb-[3px] text-center text-[10px] font-semibold text-text"
      >
        {name}
      </button>
    );
  }
  return (
    <div
      className={cx(
        "truncate px-2 pt-[5px] pb-[3px] text-center text-[10px] font-semibold",
        master ? "font-bold tracking-[1.5px] text-text-hi" : "text-text",
      )}
    >
      {name}
    </div>
  );
}

function MuteSoloButton({
  label,
  pressed,
  activeClass,
  onClick,
}: {
  label: string;
  pressed?: boolean | undefined;
  activeClass: string;
  onClick?: (() => void) | undefined;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      disabled={!onClick}
      onClick={onClick}
      className={cx(
        "grid h-4 w-5 place-items-center rounded-[3px] border border-edge-btn text-[8.5px] font-bold",
        pressed ? activeClass : "bg-[#232425] text-text-dim",
        onClick ? "hover:brightness-125" : "cursor-not-allowed",
      )}
    >
      {label.charAt(0)}
    </button>
  );
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
  onRename,
  selected,
  onSelect,
  onLaneMenu,
}: MixerStripProps) {
  const db = dbText ?? (onGainDb ? formatFaderDb(gainDb) : "—");
  const rootRef = useWheelTrim(gainDb, onGainDb);

  // Selection ring on top of the (widened) remote-editor presence ring so
  // its inner pixel stays visible when both apply.
  const rings = [
    selected ? "inset 0 0 0 1px var(--color-accent)" : null,
    remoteEditor ? `inset 0 0 0 ${selected ? 2 : 1}px ${hexA(remoteEditor.color, 0.55)}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div
      ref={rootRef}
      data-mixer-strip={name}
      data-selected={selected ?? false}
      onPointerDown={onSelect}
      {...(onLaneMenu
        ? {
            onContextMenu: (e: React.MouseEvent) => {
              e.preventDefault();
              onLaneMenu(e.clientX, e.clientY);
            },
          }
        : {})}
      className={cx(
        "flex flex-none flex-col border-r border-[#0e0f10]",
        master ? "w-[118px] border-l border-l-divider bg-card-hi" : "w-[104px] bg-card",
      )}
      {...(rings ? { style: { boxShadow: rings } } : {})}
      {...(remoteEditor
        ? {
            "data-remote-editor": remoteEditor.name,
            title: `${remoteEditor.name} is adjusting this strip`,
          }
        : {})}
    >
      <div className="h-[3px]" style={{ background: color }} />
      <StripTitle name={name} master={master} onRename={onRename} />
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
            <MuteSoloButton
              label={`Mute ${name}`}
              pressed={muted}
              activeClass="bg-track-gold text-void"
              onClick={onMute}
            />
            <MuteSoloButton
              label={`Solo ${name}`}
              pressed={soloed}
              activeClass="bg-track-teal text-void"
              onClick={onSolo}
            />
          </>
        )}
      </div>
      <div className="pb-1.5 text-center font-mono text-[9px] text-text-dim">{db}</div>
    </div>
  );
}
