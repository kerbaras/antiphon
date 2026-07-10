// Antiphon component kit — the only place design tokens get composed.
// Every pattern here is lifted from the binding references (docs/image.png,
// docs/Antiphone DAW.dc.html): inset displays, mono status pills, avatar
// circles with status dots, VU meters, hard-divider panels.

import QRCode from "qrcode";
import { type ReactNode, useMemo, useState } from "react";

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

/** Account profile picture covering an initials disc (A16). Renders OVER
 * the initials, so a slow/failed load degrades to the disc that was
 * always there. COEP note: img.clerk.com serves CORP (see
 * auth/clerk-shell.tsx); any host that doesn't is refused by require-corp
 * and lands in the same onError fallback. Parent must be `relative`. */
export function AvatarImg({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
      className="absolute inset-0 size-full rounded-full object-cover"
    />
  );
}

/** Avatar circle with the reference's status dot. `imageUrl` (the account
 * pfp, A16) covers the initials when present and loadable. */
export function Avatar({
  initials,
  color,
  dot,
  size = 28,
  imageUrl,
}: {
  initials: string;
  color: string;
  dot?: string;
  size?: number;
  imageUrl?: string | null;
}) {
  return (
    <div
      className="relative grid flex-none place-items-center rounded-full font-sans font-bold text-void"
      style={{ width: size, height: size, background: color, fontSize: size * 0.36 }}
    >
      {initials}
      {imageUrl && <AvatarImg src={imageUrl} />}
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

/**
 * Styled QR code: transparent background, rounded dot modules in the text
 * ladder, accent finder-pattern pupils, and the Antiphon "A" badge in the
 * middle. Error correction H absorbs the logo hole (~4% of the symbol vs a
 * 30% budget). Rendered as SVG straight from the QR matrix — no raster, no
 * extra dependency, scales freely.
 */
export function StyledQr({ value, className }: { value: string; className?: string }) {
  const { size, dark } = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: "H" });
    return { size: qr.modules.size, dark: qr.modules.data as Uint8Array };
  }, [value]);

  const isFinder = (r: number, c: number) =>
    (r < 7 && c < 7) || (r < 7 && c >= size - 7) || (r >= size - 7 && c < 7);

  // Center hole for the logo badge (odd module count, ~18% linear).
  const hole = Math.max(5, Math.floor(size * 0.18) | 1);
  const holeStart = (size - hole) / 2;
  const inHole = (r: number, c: number) =>
    r >= holeStart && r < holeStart + hole && c >= holeStart && c < holeStart + hole;

  const dots: ReactNode[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!dark[r * size + c] || isFinder(r, c) || inHole(r, c)) continue;
      dots.push(
        <circle key={`${r}-${c}`} cx={c + 0.5} cy={r + 0.5} r={0.44} fill="var(--color-text-hi)" />,
      );
    }
  }

  /** Finder eye: rounded ring + pupil. The pupil is accent tinted far
   * toward white — scanners binarize by luminance (including an inversion
   * pass for light-on-dark codes), so a pure-accent pupil would read as
   * background and break the 1:1:3:1:1 finder ratio. */
  const eye = (x: number, y: number) => (
    <g key={`${x}-${y}`}>
      <rect
        x={x + 0.5}
        y={y + 0.5}
        width={6}
        height={6}
        rx={2}
        fill="none"
        stroke="var(--color-text-hi)"
        strokeWidth={1}
      />
      <rect
        x={x + 2}
        y={y + 2}
        width={3}
        height={3}
        rx={1.2}
        style={{ fill: "color-mix(in srgb, var(--color-accent) 35%, white)" }}
      />
    </g>
  );

  const badge = hole - 0.7;
  const badgeStart = (size - badge) / 2;

  return (
    <svg
      viewBox={`-1.5 -1.5 ${size + 3} ${size + 3}`}
      className={className}
      role="img"
      aria-label="Join QR code"
    >
      {dots}
      {eye(0, 0)}
      {eye(size - 7, 0)}
      {eye(0, size - 7)}
      {/* Antiphon badge, echoing the wordmark block */}
      <rect
        x={badgeStart}
        y={badgeStart}
        width={badge}
        height={badge}
        rx={badge * 0.27}
        fill="var(--color-accent)"
      />
      <text
        x={size / 2}
        y={size / 2 + badge * 0.03}
        textAnchor="middle"
        dominantBaseline="central"
        fill="#fff"
        fontFamily="'IBM Plex Sans', sans-serif"
        fontWeight={700}
        fontSize={badge * 0.58}
      >
        A
      </text>
    </svg>
  );
}

/** The ANTIPHON wordmark block from the reference top bar. `textClassName`
 * lets a dense host degrade gracefully (the desk top bar hides the lettering
 * at narrow widths and keeps the mark — the session title is the working
 * identity there). */
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
