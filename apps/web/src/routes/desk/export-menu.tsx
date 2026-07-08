// Top-bar "Export ▾" dropdown (the prototype's decorative button, live).

import { useState } from "react";
import { SectionLabel } from "../../ui/kit";
import { formatSpan } from "./format";
import type { Song } from "./markers";

export interface ExportMenuProps {
  busy: "master" | "stems" | "songs" | null;
  canRender: boolean;
  canFlac: boolean;
  songs: Song[];
  takeDurationSec: number;
  onMaster: () => void;
  onStems: () => void;
  onSong: (song: Song) => void;
  onAllSongs: () => void;
  onFlac: () => void;
}

/** Top-bar "Export ▾" dropdown (the prototype's decorative button, live):
 * offline renders of the loaded take — master WAV, stems ZIP, and (when
 * markers exist) each song's span as "NN <name>.wav" or all of them in one
 * ZIP — plus the raw per-stream FLAC downloads. Render items gate on
 * playback readiness; the button shows an indeterminate busy label while
 * an OfflineAudioContext render runs (one-shot: no progress to report). */
export function ExportMenu({
  busy,
  canRender,
  canFlac,
  songs,
  takeDurationSec,
  onMaster,
  onStems,
  onSong,
  onAllSongs,
  onFlac,
}: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
        disabled={busy !== null || (!canRender && !canFlac)}
        className={`rounded-md bg-accent px-3.5 py-1.5 text-[11px] font-semibold text-white hover:brightness-110 ${
          busy !== null
            ? "animate-pulse cursor-wait"
            : "disabled:cursor-not-allowed disabled:opacity-40"
        }`}
      >
        {busy === "master"
          ? "Rendering mix…"
          : busy === "stems"
            ? "Rendering stems…"
            : busy === "songs"
              ? "Rendering songs…"
              : "Export ▾"}
      </button>
      {open && (
        <>
          {/* Click-away backdrop */}
          <button
            type="button"
            aria-label="Close export menu"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-[19] cursor-default"
          />
          <div
            role="menu"
            className="absolute top-[calc(100%+6px)] right-0 z-[20] w-[236px] rounded-lg border border-edge-card bg-card p-1 shadow-[0_10px_28px_rgba(0,0,0,.55)]"
          >
            <ExportItem
              title="Master mix"
              hint="WAV · 24-bit · 48 kHz"
              disabled={!canRender}
              onClick={pick(onMaster)}
            />
            <ExportItem
              title="Stems"
              hint="ZIP · aligned mono WAVs"
              disabled={!canRender}
              onClick={pick(onStems)}
            />
            {songs.length > 0 && (
              <>
                <div className="mx-1.5 my-1 h-px bg-divider" />
                <div className="px-2.5 pt-1 pb-0.5">
                  <SectionLabel>Songs</SectionLabel>
                </div>
                <div className="max-h-[204px] overflow-y-auto">
                  {songs.map((song) => (
                    <ExportItem
                      key={song.id}
                      title={`${String(song.index).padStart(2, "0")} ${song.name}`}
                      hint={`WAV · ${formatSpan((song.endSec ?? takeDurationSec) - song.startSec)}`}
                      disabled={!canRender}
                      onClick={pick(() => onSong(song))}
                    />
                  ))}
                </div>
                <ExportItem
                  title="All songs"
                  hint={`ZIP · ${songs.length} WAVs`}
                  disabled={!canRender}
                  onClick={pick(onAllSongs)}
                />
              </>
            )}
            <div className="mx-1.5 my-1 h-px bg-divider" />
            <ExportItem
              title="Source streams"
              hint="FLAC · raw per stream"
              disabled={!canFlac}
              onClick={pick(onFlac)}
            />
          </div>
        </>
      )}
    </div>
  );
}

function ExportItem({
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
