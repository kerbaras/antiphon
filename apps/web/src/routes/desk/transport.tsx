// Top-bar transport chrome: icon buttons, timecode, info chips.

import type { ReactNode } from "react";
import { cx } from "../../components";

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

export function TransportGroup({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-edge-inset bg-bg p-[3px]">
      {children}
    </div>
  );
}

export function Timecode({ seconds, className }: { seconds: number; className?: string }) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <div
      className={cx(
        "rounded-md border border-edge-inset bg-bg px-3 py-1 font-mono text-[15px] font-semibold tracking-[1px] text-text-hi",
        className,
      )}
    >
      {pad(Math.floor(seconds / 3600))}:{pad(Math.floor((seconds / 60) % 60))}:
      {pad(Math.floor(seconds % 60))}
      <span className="text-text-faint">:{pad(Math.floor((seconds % 1) * 100))}</span>
    </div>
  );
}

export function InfoChip({ value, unit }: { value: ReactNode; unit?: string }) {
  return (
    <div className="rounded-md border border-edge-inset bg-bg px-2.5 py-[5px] font-mono text-[11px] text-text-mute">
      <span className="font-semibold text-text-hi">{value}</span>
      {unit ? ` ${unit}` : ""}
    </div>
  );
}
