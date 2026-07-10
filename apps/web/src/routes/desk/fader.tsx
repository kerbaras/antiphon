// Gain fader + dB formatting shared with the mixer strip.

import type React from "react";
import { sliderStep, trackPointerDrag } from "../../components";

export const FADER_MAX_DB = 6;
export const FADER_MIN_DB = -60;

/** The bottom rail is −∞ — aria-valuenow alone can't say "off". */
export function formatFaderDb(db: number): string {
  return db <= FADER_MIN_DB ? "−∞ dB" : `${db.toFixed(1)} dB`;
}

function dbToFaderPos(db: number): number {
  return (FADER_MAX_DB - db) / (FADER_MAX_DB - FADER_MIN_DB);
}

function faderPosToDb(pos: number): number {
  return FADER_MAX_DB - pos * (FADER_MAX_DB - FADER_MIN_DB);
}

function FaderCap({ position }: { position: number }) {
  return (
    <div
      className="pointer-events-none absolute -left-2 h-[11px] w-[21px] rounded-[3px] border border-divider shadow-[0_1px_3px_rgba(0,0,0,.6)]"
      style={{
        top: `calc(${position * 100}% - ${position * 11}px)`,
        background: "linear-gradient(180deg,#5a5c5e,#38393b)",
      }}
    >
      <div className="mt-[5px] h-px bg-accent" />
    </div>
  );
}

/** Draggable gain fader; inert without `onChange`. Click/drag jumps the
 * cap to the pointer, double-click resets to 0 dB, arrows step 0.5 dB. */
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
  function startDrag(down: React.PointerEvent<HTMLDivElement>) {
    if (!onChange) return;
    // Second press of a double-click: the dblclick handler is about to
    // reset to 0 dB — a jump-to-click here would misplace the reset.
    if (down.detail > 1) return;
    const rect = down.currentTarget.getBoundingClientRect();
    const usable = rect.height - 11;
    const apply = (clientY: number) => {
      const p = Math.max(0, Math.min(1, (clientY - rect.top - 5) / usable));
      onChange(Math.round(faderPosToDb(p) * 2) / 2);
    };
    apply(down.clientY);
    trackPointerDrag((e) => apply(e.clientY));
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!onChange) return;
    const clamp = (v: number) => Math.max(FADER_MIN_DB, Math.min(FADER_MAX_DB, v));
    const next = sliderStep(e.key, {
      up: clamp(db + 0.5),
      down: clamp(db - 0.5),
      home: FADER_MIN_DB,
      end: FADER_MAX_DB,
    });
    if (next === null) return;
    e.preventDefault();
    onChange(next);
  }
  if (!onChange) {
    return (
      <div className="relative w-[5px] cursor-not-allowed rounded-[3px] bg-well opacity-70">
        <FaderCap position={position} />
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
      title={`Gain ${formatFaderDb(db)} — drag to set, wheel over the strip to trim (⌥ fine), double-click for 0 dB`}
    >
      <FaderCap position={position} />
    </div>
  );
}
