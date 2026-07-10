// Surface primitives from the binding reference design (docs/image.png).

import type { ReactNode } from "react";
import { cx } from "./cx";

/** Raised surface with a hard divider border. */
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

/** Tiny uppercase mono section header. */
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

/** Label + mono value row: seq numbers, device info, dB, timecode. */
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

/** Tiny mono badge (AUDIO / MIDI style). */
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

/** The ANTIPHON wordmark block; `textClassName` lets dense hosts hide the
 * lettering at narrow widths and keep the mark. */
export function Wordmark({ textClassName }: { textClassName?: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="grid size-[22px] flex-none place-items-center rounded-md bg-accent text-[12px] font-bold text-white">
        A
      </div>
      <div className={cx("text-[13px] font-bold tracking-[2.5px] text-text-hi", textClassName)}>
        ANTIPHON
      </div>
    </div>
  );
}
