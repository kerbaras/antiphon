import { useState } from "react";

/** Account picture layered OVER an initials disc: a slow or blocked load
 * (COEP refuses hosts without CORP headers) degrades to the disc.
 * Parent must be `relative`. */
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

/** Avatar circle with optional status dot and account picture. */
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
