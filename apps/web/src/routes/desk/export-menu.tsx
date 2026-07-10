// Top-bar "Export ▾" dropdown (the prototype's decorative button, live).

import { useState } from "react";
import { SectionLabel } from "../../components";
import { formatSpan } from "./format";
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
  /** Captured MIDI events on the loaded take (W3-C); 0 hides the item. */
  midiEventCount: number;
  /** Stem archive format (W5-C) — applies to every stems export, whole
   * take and per song alike. The menu shows it; the page owns it. */
  stemFormat: StemFormat;
  onStemFormat: (format: StemFormat) => void;
  /** THE master (W6-B): the whole session — every take at its room
   * offset, silence between. */
  onMaster: () => void;
  /** The selected take's mix alone — the pre-W6-B master, kept as its own
   * row (capability never silently removed). */
  onTakeMaster: () => void;
  onStems: () => void;
  onSong: (song: Song) => void;
  onSongStems: (song: Song) => void;
  onSongProject: (song: Song) => void;
  onAllSongs: () => void;
  onFlac: () => void;
  onMidi: () => void;
  // Projects section (W3-B) — DAW-ready packages of the loaded take.
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

/** Top-bar "Export ▾" dropdown (the prototype's decorative button, live):
 * offline renders of the loaded take — master WAV, stems ZIP (WAV or FLAC,
 * the row's own toggle), and (when markers exist) a Songs section where
 * each row is the whole per-song story: click renders the song's master
 * mix, the hover-revealed chips render its stems / project package (W5-C)
 * — plus the raw per-stream FLAC downloads. Render items gate on playback
 * readiness; the button shows an indeterminate busy label while an
 * OfflineAudioContext render runs (one-shot: no progress to report). */
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
            className="absolute top-[calc(100%+6px)] right-0 z-[20] w-[272px] rounded-lg border border-edge-card bg-card p-1 shadow-[0_10px_28px_rgba(0,0,0,.55)]"
          >
            {/* W6-B: "Master mix" IS the session now — every take at its
                room offset, silence between (the operator's ask). The
                selected take's own mix keeps a row: capability is never
                silently removed. */}
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
                archive format (W5-C) — same mono 24-bit audio either way,
                so it's one row with a setting, not two exports. Setting
                the format deliberately does NOT close the menu. */}
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
                  as "Stem format" instead of a bare "wav, checked" (QA M-2). */}
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
            {/* ---- Projects (W3-B): DAW-ready packages — keep this block
                self-contained; sibling branches add their own entries. */}
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
            {/* ---- end Projects (W3-B) ---- */}
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
            {/* MIDI export (W3-C) — self-contained block, appears only
                when the loaded take captured events. */}
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

/** One Songs row, three exports (W5-C): the row itself renders the song's
 * master WAV (the W2-B click, unchanged); hovering — or tabbing in —
 * swaps the span hint for two chips that render the song's stems ZIP and
 * its project package. Same hover-reveal grammar as the songs panel's
 * ✎/↓/× row actions, so the menu gains no permanent rows. The chips are
 * an opacity-revealed OVERLAY on the hint's spot, never display:none
 * (QA M-2): they stay focusable, so Shift+Tab from the next row lands on
 * them and the focus itself triggers the reveal — keyboard-reachable in
 * both directions. pointer-events gate with the reveal, so an invisible
 * chip can never swallow a click meant for the row. */
function SongExportRow({
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
