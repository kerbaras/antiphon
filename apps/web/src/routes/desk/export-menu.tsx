// Top-bar "Export ▾" dropdown: offline renders of the loaded take — master
// WAV, stems ZIP (WAV/FLAC), per-song exports, DAW project packages, raw
// per-stream FLAC, MIDI. Row components live in export-menu-items.tsx.

import { useState } from "react";
import { PopoverBackdrop, SectionLabel } from "../../components";
import { ExportItem, SongExportRow } from "./export-menu-items";
import type { Song } from "./markers";
import type { StemFormat } from "./use-desk";

/** One export job at a time; the button carries the busy label. */
export type ExportJob = "master" | "stems" | "songs" | "project" | "ableton" | "logic";

export interface ExportMenuProps {
  busy: ExportJob | null;
  canRender: boolean;
  canFlac: boolean;
  songs: Song[];
  takeDurationSec: number;
  /** Captured MIDI events on the loaded take; 0 hides the item. */
  midiEventCount: number;
  /** Stem archive format — applies to every stems export, whole take and
   * per song alike. The menu shows it; the page owns it. */
  stemFormat: StemFormat;
  onStemFormat: (format: StemFormat) => void;
  /** The master: the whole session — every take at its room offset,
   * silence between. */
  onMaster: () => void;
  /** The selected take's mix alone, kept as its own row. */
  onTakeMaster: () => void;
  onStems: () => void;
  onSong: (song: Song) => void;
  onSongStems: (song: Song) => void;
  onSongProject: (song: Song) => void;
  onAllSongs: () => void;
  onFlac: () => void;
  onMidi: () => void;
  onProjectPackage: () => void;
  onAbleton: () => void;
  onLogic: () => void;
}

const BUSY_LABELS: Record<ExportJob, string> = {
  master: "Rendering mix…",
  stems: "Rendering stems…",
  songs: "Rendering songs…",
  project: "Packaging project…",
  ableton: "Building Live set…",
  logic: "Packaging stems…",
};

/** Render items gate on playback readiness; the button shows an
 * indeterminate busy label while an OfflineAudioContext render runs
 * (one-shot: no progress to report). */
export function ExportMenu({
  busy,
  canRender,
  canFlac,
  songs,
  takeDurationSec,
  midiEventCount,
  stemFormat,
  onStemFormat,
  onMaster,
  onTakeMaster,
  onStems,
  onSong,
  onSongStems,
  onSongProject,
  onAllSongs,
  onFlac,
  onMidi,
  onProjectPackage,
  onAbleton,
  onLogic,
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
        disabled={busy !== null || (!canRender && !canFlac && midiEventCount === 0)}
        className={`rounded-md bg-accent px-3.5 py-1.5 text-[11px] font-semibold text-white hover:brightness-110 ${
          busy !== null
            ? "animate-pulse cursor-wait"
            : "disabled:cursor-not-allowed disabled:opacity-40"
        }`}
      >
        {busy !== null ? BUSY_LABELS[busy] : "Export ▾"}
      </button>
      {open && (
        <>
          <PopoverBackdrop label="Close export menu" onClose={() => setOpen(false)} />
          <div
            role="menu"
            className="absolute top-[calc(100%+6px)] right-0 z-[20] w-[272px] rounded-lg border border-edge-card bg-card p-1 shadow-[0_10px_28px_rgba(0,0,0,.55)]"
          >
            {/* "Master mix" is the whole session; the selected take's own
                mix keeps a row — capability is never silently removed. */}
            <ExportItem
              title="Master mix"
              hint="WAV · whole session"
              disabled={!canRender}
              onClick={pick(onMaster)}
            />
            <ExportItem
              title="Loaded take mix"
              hint="WAV · 24-bit · 48 kHz"
              disabled={!canRender}
              onClick={pick(onTakeMaster)}
            />
            {/* Stems row: the title exports, the trailing toggle picks the
                archive format — same mono 24-bit audio either way, so one
                row with a setting. Setting it deliberately keeps the menu open. */}
            <div className="group/stems flex items-center rounded-md hover:bg-card-hi focus-within:bg-card-hi">
              <button
                type="button"
                role="menuitem"
                disabled={!canRender}
                onClick={pick(onStems)}
                className="flex min-w-0 flex-1 items-baseline justify-between gap-3 rounded-md px-2.5 py-2 text-left disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="text-[11px] font-semibold text-text-strong">Stems</span>
                <span className="font-mono text-[9px] text-text-faint">ZIP · aligned mono</span>
              </button>
              {/* fieldset = implicit role "group": SRs announce the radios
                  as "Stem format" instead of a bare "wav, checked". */}
              <fieldset
                aria-label="Stem format"
                className="mr-2.5 flex flex-none gap-px rounded border border-edge bg-bg p-px"
              >
                {(["wav", "flac"] as const).map((format) => (
                  <button
                    key={format}
                    type="button"
                    role="menuitemradio"
                    aria-checked={stemFormat === format}
                    disabled={!canRender}
                    onClick={() => onStemFormat(format)}
                    className={`rounded-[3px] px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase disabled:cursor-not-allowed disabled:opacity-40 ${
                      stemFormat === format
                        ? "bg-accent text-white"
                        : "text-text-faint hover:text-text"
                    }`}
                  >
                    {format}
                  </button>
                ))}
              </fieldset>
            </div>
            <div className="mx-1.5 my-1 h-px bg-divider" />
            <div className="px-2.5 pt-1 pb-0.5">
              <SectionLabel>Projects</SectionLabel>
            </div>
            <ExportItem
              title="Project package"
              hint="ZIP · stems + mix + manifest"
              disabled={!canRender}
              onClick={pick(onProjectPackage)}
            />
            <ExportItem
              title="Ableton Live project"
              hint="ZIP · .als + samples"
              disabled={!canRender}
              onClick={pick(onAbleton)}
            />
            <ExportItem
              title="Logic / generic stems"
              hint="ZIP · stems + guide"
              disabled={!canRender}
              onClick={pick(onLogic)}
            />
            {songs.length > 0 && (
              <>
                <div className="mx-1.5 my-1 h-px bg-divider" />
                <div className="px-2.5 pt-1 pb-0.5">
                  <SectionLabel>Songs</SectionLabel>
                </div>
                <div className="max-h-[204px] overflow-y-auto">
                  {songs.map((song) => (
                    <SongExportRow
                      key={song.id}
                      song={song}
                      spanSec={(song.endSec ?? takeDurationSec) - song.startSec}
                      disabled={!canRender}
                      onMaster={pick(() => onSong(song))}
                      onStems={pick(() => onSongStems(song))}
                      onProject={pick(() => onSongProject(song))}
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
            {midiEventCount > 0 && (
              <ExportItem
                title="MIDI (.mid)"
                hint={`SMF · ${midiEventCount} events`}
                disabled={false}
                onClick={pick(onMidi)}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
