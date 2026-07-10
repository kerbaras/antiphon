// Rotary/readout controls: pan knob and the strip EQ block.

import type React from "react";
import { cx, sliderStep, trackPointerDrag } from "../../components";
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

/** Pan knob: drag horizontally/vertically, arrows step 0.05, Home/End hit
 * the rails, double-click recenters. The tick rotates ±135°. */
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
  function startDrag(down: React.PointerEvent<HTMLDivElement>) {
    if (!onPan) return;
    down.preventDefault();
    const { clientX: startX, clientY: startY } = down;
    const startPan = pan;
    trackPointerDrag((e) =>
      onPan(snap(startPan + (e.clientX - startX - (e.clientY - startY)) / 60)),
    );
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!onPan) return;
    const next = sliderStep(e.key, {
      up: snap(pan + 0.05),
      down: snap(pan - 0.05),
      home: -1,
      end: 1,
    });
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

/** Mini EQ gain knob (±12 dB): drag vertically, arrows step 0.5 dB,
 * double-click resets. */
function EqKnob({ label, db, onDb }: { label: string; db: number; onDb?: (db: number) => void }) {
  const clamp = (v: number) => Math.max(-EQ_DB_RANGE, Math.min(EQ_DB_RANGE, v));
  function startDrag(down: React.PointerEvent<HTMLDivElement>) {
    if (!onDb) return;
    down.preventDefault();
    const startY = down.clientY;
    const startDb = db;
    trackPointerDrag((e) => onDb(clamp(Math.round((startDb + (startY - e.clientY) / 6) * 2) / 2)));
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!onDb) return;
    const next = sliderStep(e.key, {
      up: clamp(db + 0.5),
      down: clamp(db - 0.5),
      home: -EQ_DB_RANGE,
      end: EQ_DB_RANGE,
    });
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

/** Mid-band frequency as a draggable readout: vertical drag sweeps
 * 200 Hz–8 kHz on a log scale, double-click recalls 1 kHz. */
function EqFreq({ label, hz, onHz }: { label: string; hz: number; onHz?: (hz: number) => void }) {
  const NORM_STEP = 1 / 24;
  function startDrag(down: React.PointerEvent<HTMLDivElement>) {
    if (!onHz) return;
    down.preventDefault();
    const startY = down.clientY;
    const startNorm = midHzToNorm(hz);
    trackPointerDrag((e) => onHz(Math.round(normToMidHz(startNorm + (startY - e.clientY) / 140))));
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!onHz) return;
    const norm = midHzToNorm(hz);
    const next = sliderStep(e.key, {
      up: normToMidHz(norm + NORM_STEP),
      down: normToMidHz(norm - NORM_STEP),
      home: EQ_MID_HZ_MIN,
      end: EQ_MID_HZ_MAX,
    });
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

/** Strip EQ block: L/M/H knobs, mid-frequency sweep, and the bypass pill.
 * Bypassed dims the block — the signal path really reconnects around it. */
export function EqSection({
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
