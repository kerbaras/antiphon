// Antiphon component kit — the only place design tokens get composed.
// Every pattern here is lifted from the binding references (docs/image.png,
// docs/Antiphone DAW.dc.html): inset displays, mono status pills, avatar
// circles with status dots, VU meters, hard-divider panels.

import type { ReactNode } from "react";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Raised surface with the reference's hard divider border. */
export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cx("rounded-lg border border-edge-card bg-card", className)}>{children}</div>
  );
}

/** Sunken display for technical values (timecode / BPM style). */
export function InsetDisplay({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cx("rounded-md border border-edge-inset bg-bg", className)}>{children}</div>
  );
}

/** Tiny uppercase mono label — "TRACKS", "SINKS", section headers. */
export function SectionLabel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cx(
        "font-mono text-[9.5px] font-semibold tracking-[1px] text-text-faint uppercase",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Mono value readout: seq numbers, CHWM, device info, dB, timecode. */
export function MonoReadout({
  label,
  value,
  className,
}: {
  label: string;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex items-baseline justify-between gap-3", className)}>
      <span className="text-[10px] text-text-faint">{label}</span>
      <span className="font-mono text-[11px] font-medium text-text-strong">{value}</span>
    </div>
  );
}

export type PillTone = "rec" | "ok" | "accent" | "warn" | "idle";

const PILL_TONES: Record<PillTone, string> = {
  rec: "bg-rec text-white animate-recpulse",
  ok: "bg-ok/15 text-ok",
  accent: "bg-accent/15 text-accent",
  warn: "bg-warn/15 text-warn",
  idle: "bg-edge text-text-dim",
};

/** Mono uppercase status pill (RECORDING / MONITORING / IDLE …). */
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

/** Tiny mono badge (AUDIO / MIDI / DECK style). */
export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        "rounded-[3px] bg-edge px-1.5 py-px font-mono text-[8px] font-semibold tracking-[0.5px] text-text-dim uppercase",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Button({
  variant = "outline",
  className,
  disabled,
  onClick,
  children,
}: {
  variant?: "accent" | "outline" | "rec";
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  const styles = {
    accent: "bg-accent text-white hover:brightness-110",
    outline: "border border-edge-strong text-text hover:bg-card-hi",
    rec: "bg-rec text-white hover:brightness-110",
  }[variant];
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "rounded-md px-4 py-2 text-[12px] font-semibold transition-[filter,background-color]",
        "disabled:cursor-not-allowed disabled:opacity-40",
        styles,
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Avatar circle with the reference's status dot. */
export function Avatar({
  initials,
  color,
  dot,
  size = 28,
}: {
  initials: string;
  color: string;
  dot?: string;
  size?: number;
}) {
  return (
    <div
      className="relative grid flex-none place-items-center rounded-full font-sans font-bold text-void"
      style={{ width: size, height: size, background: color, fontSize: size * 0.36 }}
    >
      {initials}
      {dot && (
        <div
          className="absolute -right-px -bottom-px rounded-full border-2 border-card-hi"
          style={{ width: size * 0.3, height: size * 0.3, background: dot }}
        />
      )}
    </div>
  );
}

/**
 * Horizontal VU meter (performer-card style). `level` is 0..1; rendering is
 * a clipped gradient so quiet is green and hot is red, like the reference.
 */
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

/** Blinking record dot, as in the reference transport. */
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

/** The ANTIPHON wordmark block from the reference top bar. */
export function Wordmark() {
  return (
    <div className="flex items-center gap-2">
      <div className="grid size-[22px] place-items-center rounded-md bg-accent text-[12px] font-bold text-white">
        A
      </div>
      <div className="text-[13px] font-bold tracking-[2.5px] text-text-hi">ANTIPHON</div>
    </div>
  );
}
