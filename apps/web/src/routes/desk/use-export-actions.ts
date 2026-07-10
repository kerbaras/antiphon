// Export wiring: one busy/error gate for every render, and the assembled
// ExportMenu props. Renders share the player's scheduling math, so they
// gate on playback readiness (take loaded, alignment settled, idle).

import { useState } from "react";
import type { DeskSessionState } from "../../net/desk-session";
import { downloadStreamFlac } from "../../net/stream-download";
import type { TakeComment } from "./comments";
import type { ExportJob, ExportMenuProps } from "./export-menu";
import { type Marker, type Song, songFileName, songSlug } from "./markers";
import type { MidiEvent } from "./midi";
import type { PlayerSnapshot } from "./player";
import type { RenderRange } from "./timeline-math";
import { fileSafe, type TakeSlot, type TrackRow } from "./track-model";
import {
  exportAbletonProject,
  exportLogicPackage,
  exportMasterWav,
  exportMidiFile,
  exportProjectPackage,
  exportSessionMasterWav,
  exportSongsZip,
  exportStemsZip,
  type ServerStreamStatus,
  type StemFormat,
} from "./use-desk";

export function useExportActions({
  sessionId,
  state,
  rows,
  takes,
  serverStatus,
  selectedTakeId,
  songs,
  displayMarkers,
  comments,
  midiEvents,
  playerSnap,
  playerLoaded,
  recording,
  convergedCount,
}: {
  sessionId: string;
  state: DeskSessionState;
  rows: TrackRow[];
  takes: Map<string, TakeSlot>;
  serverStatus: Map<string, ServerStreamStatus>;
  selectedTakeId: string | null;
  songs: Song[];
  displayMarkers: Marker[];
  comments: TakeComment[];
  midiEvents: MidiEvent[];
  playerSnap: PlayerSnapshot;
  playerLoaded: boolean;
  recording: boolean;
  convergedCount: number;
}) {
  const canRenderTake = playerLoaded && !recording && !playerSnap.loading && !playerSnap.aligning;
  const [exportBusy, setExportBusy] = useState<ExportJob | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  // Stem archive format — page-lifetime state, deliberately not persisted
  // (a format is a per-delivery choice, not a desk setting).
  const [stemFormat, setStemFormat] = useState<StemFormat>("wav");

  const takeNumber = selectedTakeId ? [...takes.keys()].indexOf(selectedTakeId) + 1 : 0;
  const takeTag = `take-${String(Math.max(1, takeNumber)).padStart(2, "0")}`;

  async function runExport(kind: ExportJob, job: () => Promise<void>) {
    if (exportBusy) return;
    setExportBusy(kind);
    setExportError(null);
    try {
      await job();
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setExportBusy(null);
    }
  }

  /** Per-stream FLAC downloads for every converged stream, named by lane. */
  function exportFlacAll() {
    const laneOf = new Map<string, string>();
    for (const row of rows) {
      for (const s of row.streams) laneOf.set(s.streamId, row.name);
    }
    for (const desk of state.deskStatus) {
      const server = serverStatus.get(desk.streamId);
      if (desk.complete && server?.complete && desk.digest === server.digest) {
        const lane = laneOf.get(desk.streamId);
        void downloadStreamFlac(
          desk.streamId,
          `${lane ? `${fileSafe(lane)}-` : ""}${desk.streamId.slice(0, 8)}.flac`,
        );
      }
    }
  }

  /** Stem entry name (sans extension): lane name + stream id. */
  const stemBaseName = (streamId: string, channelKey: string): string => {
    const lane = rows.find((row) => row.key === channelKey)?.name;
    return `${lane ? `${fileSafe(lane)}-` : ""}${streamId.slice(0, 8)}`;
  };

  /** A last-marker song runs to the true take end (endSec omitted). */
  const songRange = (song: Song): RenderRange => ({
    startSec: song.startSec,
    ...(song.endSec !== null ? { endSec: song.endSec } : {}),
  });

  /** `<take> — NN <name>`: keeps two takes' "01 Kyrie" apart in Downloads. */
  const songTag = (song: Song) => `${takeTag} — ${songSlug(song.index, song.name)}`;

  /** Lane names/peers + markers/comments the DAW packages carry. Markers
   * are the DISPLAY names — the package must match the songs panel. */
  const projectCtx = () => ({
    sessionId,
    lanes: rows.map((row) => ({ key: row.key, name: row.name, peerId: row.peerId })),
    markers: displayMarkers,
    comments,
  });

  const exportMenu: ExportMenuProps = {
    busy: exportBusy,
    canRender: canRenderTake,
    canFlac: convergedCount > 0,
    songs,
    takeDurationSec: playerSnap.takeDurationSec,
    midiEventCount: midiEvents.length,
    stemFormat,
    onStemFormat: setStemFormat,
    // THE master: the whole session at its room offsets; the per-take mix
    // stays available as its own row.
    onMaster: () =>
      void runExport("master", () =>
        exportSessionMasterWav(`session-${sessionId.slice(0, 8)}-master.wav`),
      ),
    onTakeMaster: () => void runExport("master", () => exportMasterWav(`${takeTag}-master.wav`)),
    onStems: () =>
      void runExport("stems", () =>
        exportStemsZip(`${takeTag}-stems.zip`, stemBaseName, undefined, stemFormat),
      ),
    onSong: (song) =>
      void runExport("songs", () => exportMasterWav(`${songTag(song)}.wav`, songRange(song))),
    onSongStems: (song) =>
      void runExport("stems", () =>
        exportStemsZip(`${songTag(song)} — stems.zip`, stemBaseName, songRange(song), stemFormat),
      ),
    onSongProject: (song) =>
      void runExport("project", () =>
        exportProjectPackage(`${songTag(song)} — project.zip`, projectCtx(), songRange(song)),
      ),
    onAllSongs: () =>
      void runExport("songs", () =>
        exportSongsZip(
          `${takeTag}-songs.zip`,
          songs.map((s) => ({ fileName: songFileName(s.index, s.name), range: songRange(s) })),
        ),
      ),
    onFlac: exportFlacAll,
    onMidi: () => exportMidiFile(`${takeTag}.mid`, midiEvents),
    onProjectPackage: () =>
      void runExport("project", () => exportProjectPackage(`${takeTag}-project.zip`, projectCtx())),
    onAbleton: () => void runExport("ableton", () => exportAbletonProject(takeTag, projectCtx())),
    onLogic: () =>
      void runExport("logic", () => exportLogicPackage(`${takeTag}-logic-stems.zip`, projectCtx())),
  };

  /** The songs panel's per-song render affordance (same gate + names). */
  const songExports = {
    canRender: canRenderTake && exportBusy === null,
    fileNameOf: (song: Song) => `${songTag(song)}.wav`,
    render: (song: Song) =>
      void runExport("songs", () => exportMasterWav(`${songTag(song)}.wav`, songRange(song))),
  };

  return { exportMenu, exportError, songExports };
}
