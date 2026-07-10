import QRCode from "qrcode";
import { type ReactNode, useMemo } from "react";

/** Styled QR: rounded dot modules, accent finder pupils, "A" badge in a
 * center hole. Error correction H absorbs the hole (~4% of a 30% budget);
 * SVG straight from the matrix — no raster, scales freely. */
export function StyledQr({ value, className }: { value: string; className?: string }) {
  const { size, dark } = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: "H" });
    return { size: qr.modules.size, dark: qr.modules.data as Uint8Array };
  }, [value]);

  const isFinder = (r: number, c: number) =>
    (r < 7 && c < 7) || (r < 7 && c >= size - 7) || (r >= size - 7 && c < 7);

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

  // Pupils sit near-white: scanners binarize by luminance, and a pure
  // accent pupil would read as background and break the finder ratio.
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
