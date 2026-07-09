// Right-rail Songs panel (W2-B): the selected take's marker-started songs.

import { useRef, useState } from "react";
import { formatAt, formatSpan } from "./format";
import type { Song } from "./markers";

/** Right-rail song list: one row per marker-started song — name (inline
 * rename), start timecode, span. Click seeks; hover reveals rename /
 * render-WAV / delete. */
export function SongsPanel({
  songs,
  takeDurationSec,
  currentSongId,
  usable,
  canRender,
  fileNameOf,
  onAdd,
  onSeek,
  onRename,
  onRemove,
  onRender,
}: {
  songs: Song[];
  takeDurationSec: number;
  currentSongId: string | null;
  /** A take is loaded and idle — markers can be added and seeked. */
  usable: boolean;
  canRender: boolean;
  /** The exact download name onRender produces — the page composes it
   * (take tag + song slug), the ↓ tooltip promises it. */
  fileNameOf: (song: Song) => string;
  onAdd: () => void;
  onSeek: (song: Song) => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  onRender: (song: Song) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2.5">
      {songs.length === 0 && (
        <p className="px-1 py-1 text-[11px] leading-relaxed text-text-dim">
          No songs bookmarked yet. Each marker starts a song that runs to the next marker (or the
          take end). Press <span className="font-mono text-text-mute">M</span> to drop one at the
          playhead, or double-click the ruler.
        </p>
      )}
      {songs.map((song) => (
        <SongRow
          key={song.id}
          song={song}
          durationSec={(song.endSec ?? takeDurationSec) - song.startSec}
          active={song.id === currentSongId}
          usable={usable}
          canRender={canRender}
          fileName={fileNameOf(song)}
          onSeek={() => onSeek(song)}
          onRename={(name) => onRename(song.id, name)}
          onRemove={() => onRemove(song.id)}
          onRender={() => onRender(song)}
        />
      ))}
      <button
        type="button"
        disabled={!usable}
        onClick={onAdd}
        className="mt-0.5 flex items-center justify-center gap-2 rounded-lg border border-dashed border-edge-strong p-2 text-[11px] font-semibold text-text-dim hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
      >
        ◆ Add marker at playhead
        <span className="rounded border border-edge-strong px-1.5 py-px font-mono text-[9px]">
          M
        </span>
      </button>
    </div>
  );
}

function SongRow({
  song,
  durationSec,
  active,
  usable,
  canRender,
  fileName,
  onSeek,
  onRename,
  onRemove,
  onRender,
}: {
  song: Song;
  durationSec: number;
  active: boolean;
  usable: boolean;
  canRender: boolean;
  fileName: string;
  onSeek: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  onRender: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const commit = (value: string) => {
    setDraft(null);
    if (value.trim() && value.trim() !== song.name) onRename(value);
  };
  return (
    <div
      className={`group/song flex flex-col gap-[3px] rounded-md border px-2 py-[7px] ${
        active ? "border-accent/60 bg-card-hi" : "border-edge-card bg-card hover:bg-card-hi"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className="flex-none font-mono text-[9px] font-semibold text-text-faint">
          {String(song.index).padStart(2, "0")}
        </span>
        {draft !== null ? (
          <input
            // biome-ignore lint/a11y/noAutofocus: user explicitly opened the editor
            autoFocus
            value={draft}
            maxLength={64}
            aria-label="Rename song"
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={(e) => {
              if (cancelled.current) {
                cancelled.current = false;
                setDraft(null);
              } else {
                commit(e.target.value);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                cancelled.current = true;
                e.currentTarget.blur();
              }
            }}
            className="w-full min-w-0 rounded-[3px] border border-accent bg-bg px-1 py-px text-[11.5px] font-semibold text-text-hi outline-none"
          />
        ) : (
          <>
            <button
              type="button"
              disabled={!usable}
              onClick={onSeek}
              onDoubleClick={() => setDraft(song.name)}
              title="Click to seek · double-click to rename"
              className="min-w-0 flex-1 truncate text-left text-[11.5px] font-semibold text-text-strong hover:text-text-hi disabled:cursor-default"
            >
              {song.name}
            </button>
            <button
              type="button"
              aria-label={`Rename ${song.name}`}
              onClick={() => setDraft(song.name)}
              className="hidden flex-none font-mono text-[10px] leading-none text-text-faint hover:text-accent group-hover/song:inline"
            >
              ✎
            </button>
            <button
              type="button"
              aria-label={`Export ${song.name}`}
              title={`Render ${fileName}`}
              disabled={!canRender}
              onClick={onRender}
              className="hidden flex-none font-mono text-[10px] leading-none text-text-faint hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 group-hover/song:inline"
            >
              ↓
            </button>
            <button
              type="button"
              aria-label={`Delete marker ${song.name}`}
              onClick={onRemove}
              className="hidden flex-none font-mono text-[10px] leading-none text-text-faint hover:text-rec group-hover/song:inline"
            >
              ×
            </button>
          </>
        )}
      </div>
      <button
        type="button"
        disabled={!usable}
        onClick={onSeek}
        title="Seek to song start"
        className="flex items-baseline gap-1.5 pl-[22px] text-left font-mono text-[9.5px] text-text-dim hover:text-text disabled:cursor-default"
      >
        <span className={active ? "text-accent" : ""}>▶ {formatAt(song.startSec)}</span>
        <span className="text-text-faint">·</span>
        <span>{formatSpan(durationSec)}</span>
      </button>
    </div>
  );
}
