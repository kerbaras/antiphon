// Ruler annotations: marker flags (head) and comment ticks (foot).

import { AvatarImg } from "../../components";
import type { TakeComment } from "./comments";
import { formatAt } from "./format";
import { RULER_H } from "./lane-chrome";
import type { Marker } from "./markers";

/** Marker flag: low-alpha hairline + name chip; click seeks. The hit
 * target is ONLY a 7px strip plus the chip — a full-height column would
 * steal background seeks and shadow the comment ticks below; the strip
 * also stops above the ticks' 10px foot lane. */
export function MarkerFlag({
  marker,
  x,
  onSeek,
}: {
  marker: Marker;
  x: number;
  onSeek: () => void;
}) {
  return (
    <button
      type="button"
      data-marker={marker.id}
      aria-label={`Marker ${marker.name}`}
      title={`${marker.name} — click to seek`}
      onClick={(e) => {
        e.stopPropagation();
        onSeek();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="group/marker absolute top-0 bottom-[10px] z-[2] w-[7px]"
      style={{ left: x - 3 }}
    >
      <span
        className="pointer-events-none absolute top-0 left-[3px] w-px bg-accent/50 group-hover/marker:bg-accent"
        style={{ height: RULER_H }}
      />
      <span className="absolute top-[4px] left-[6px] max-w-[96px] truncate rounded-[3px] border border-edge-btn bg-raised/95 px-[5px] py-px font-mono text-[8px] font-semibold tracking-[0.4px] text-text-mute group-hover/marker:border-accent/60 group-hover/marker:text-accent">
        {marker.name}
      </span>
    </button>
  );
}

/** Comment tick: small amber mark at the ruler's foot (markers own the
 * top). Click seeks; the comments panel is the interaction surface. */
export function CommentTick({
  comment,
  x,
  onSeek,
}: {
  comment: TakeComment;
  x: number;
  onSeek: () => void;
}) {
  const resolved = comment.resolvedAtMs !== null;
  return (
    <button
      type="button"
      data-comment-tick={comment.id}
      data-resolved={resolved}
      aria-label={`Comment: ${comment.text}`}
      title={`${comment.author} @ ${formatAt(comment.atSec)} — ${comment.text}`}
      onClick={(e) => {
        e.stopPropagation();
        onSeek();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="absolute bottom-0 z-[1] flex h-[10px] w-[7px] -translate-x-1/2 items-end justify-center"
      style={{ left: x }}
    >
      <span className={`h-[6px] w-[3px] rounded-t-[1px] ${resolved ? "bg-pin/30" : "bg-pin"}`} />
    </button>
  );
}

/** Lane peer chip: avatar disc (pfp over initials), live dot, label. The
 * title answers "which mic recorded the loaded take?" — absent when the
 * lane has no clip in it, "unknown" when the archive has no description. */
export function LanePeerChip({
  color,
  initials,
  avatarUrl,
  receiving,
  label,
  takeMic,
}: {
  color: string;
  initials: string;
  avatarUrl?: string | null;
  receiving: boolean;
  label: string;
  takeMic: string | null | undefined;
}) {
  return (
    <span
      {...(takeMic !== undefined
        ? {
            title:
              takeMic !== null
                ? `Mic on the loaded take — ${takeMic}`
                : "Mic on the loaded take — unknown (not in the archive)",
            "data-take-mic": takeMic ?? "unknown",
          }
        : {})}
      className="ml-[3px] flex min-w-0 items-center gap-1 rounded-[10px] border border-edge bg-[#17181a] py-px pr-[7px] pl-[2px]"
    >
      <span
        className="relative grid size-[14px] flex-none place-items-center rounded-full text-[7px] font-bold text-void"
        style={{ background: color }}
      >
        {initials}
        {avatarUrl && <AvatarImg src={avatarUrl} />}
        <span
          className="absolute -right-px -bottom-px size-[5px] rounded-full border border-[#17181a]"
          style={{ background: receiving ? "var(--color-rec)" : "var(--color-ok)" }}
        />
      </span>
      <span className="truncate text-[9px] text-text-dim">{label}</span>
    </span>
  );
}
