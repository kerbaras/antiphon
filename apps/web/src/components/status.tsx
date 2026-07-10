// Status indicators: pills, record dot, VU meter.

import type { ReactNode } from "react";
import { cx } from "./cx";

export type PillTone = "rec" | "ok" | "accent" | "warn" | "idle";

const PILL_TONES: Record<PillTone, string> = {
  rec: "bg-rec text-white animate-recpulse",
  ok: "bg-ok/15 text-ok",
  accent: "bg-accent/15 text-accent",
  warn: "bg-warn/15 text-warn",
  idle: "bg-edge text-text-dim",
};

/** Mono uppercase status pill (RECORDING / READY / …). */
export function StatusPill({
  tone,
  children,
  className,
}: {
  tone: PillTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-[9px] px-2 py-0.5",
        "font-mono text-[8.5px] font-bold tracking-[0.5px] uppercase",
        PILL_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Blinking record dot. */
export function RecDot({ active = true }: { active?: boolean }) {
  return (
    <span
      className={cx(
        "inline-block size-2 rounded-full",
        active ? "bg-rec animate-recpulse" : "bg-edge-strong",
      )}
    />
  );
}

/** Horizontal VU meter; `level` is 0..1. */
export function VUMeter({ level, className }: { level: number; className?: string }) {
  const clamped = Math.max(0, Math.min(1, level));
  return (
    <div className={cx("h-[5px] overflow-hidden rounded-[3px] bg-bg", className)}>
      <div
        className="vu-gradient-h h-full origin-left transition-transform duration-75 ease-out"
        style={{ transform: `scaleX(${clamped})`, width: "100%" }}
      />
    </div>
  );
}
