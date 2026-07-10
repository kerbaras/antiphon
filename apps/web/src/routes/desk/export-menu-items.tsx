// Row components for the top-bar Export menu (export-menu.tsx).

import { formatSpan } from "./format";
import type { Song } from "./markers";

export function ExportItem({
  title,
  hint,
  disabled,
  onClick,
}: {
  title: string;
  hint: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-baseline justify-between gap-3 rounded-md px-2.5 py-2 text-left hover:bg-card-hi disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <span className="text-[11px] font-semibold text-text-strong">{title}</span>
      <span className="font-mono text-[9px] text-text-faint">{hint}</span>
    </button>
  );
}

/** One Songs row, three exports: the row itself renders the song's master
 * WAV; hovering — or tabbing in — swaps the span hint for two chips that
 * render its stems ZIP and project package. The chips are an
 * opacity-revealed overlay, never display:none, so they stay focusable and
 * focus itself triggers the reveal — keyboard-reachable in both directions;
 * pointer-events gate with the reveal so an invisible chip can't swallow a
 * click meant for the row. */
export function SongExportRow({
  song,
  spanSec,
  disabled,
  onMaster,
  onStems,
  onProject,
}: {
  song: Song;
  spanSec: number;
  disabled: boolean;
  onMaster: () => void;
  onStems: () => void;
  onProject: () => void;
}) {
  const title = `${String(song.index).padStart(2, "0")} ${song.name}`;
  return (
    <div className="group/song relative flex items-center rounded-md hover:bg-card-hi focus-within:bg-card-hi">
      <button
        type="button"
        role="menuitem"
        title={`Render ${title} master mix (WAV)`}
        disabled={disabled}
        onClick={onMaster}
        className="flex min-w-0 flex-1 items-baseline justify-between gap-3 rounded-md px-2.5 py-2 text-left disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span className="truncate text-[11px] font-semibold text-text-strong">{title}</span>
        <span className="flex-none font-mono text-[9px] text-text-faint group-focus-within/song:hidden group-hover/song:hidden">
          WAV · {formatSpan(spanSec)}
        </span>
      </button>
      <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center gap-1 opacity-0 group-focus-within/song:pointer-events-auto group-focus-within/song:opacity-100 group-hover/song:pointer-events-auto group-hover/song:opacity-100">
        <SongChip label={`Export ${title} stems`} disabled={disabled} onClick={onStems}>
          stems
        </SongChip>
        <SongChip label={`Export ${title} project package`} disabled={disabled} onClick={onProject}>
          project
        </SongChip>
      </span>
    </div>
  );
}

function SongChip({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded border border-edge-strong px-1.5 py-0.5 font-mono text-[9px] text-text-mute hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
