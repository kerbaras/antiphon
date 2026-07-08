// One DeskSession + one TakePlayer per page, bridged into React, plus
// server-side archive polling for the sink-convergence table.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type CollabClient, getCollab } from "../../net/collab";
import {
  deleteArrangeKeys,
  displayTakeList,
  hasTakeList,
  type ListKind,
  seedTakeListOnce,
  writeTakeList,
} from "../../net/collab-doc";
import { DeskSession, type DeskSessionState } from "../../net/desk-session";
import {
  bindAlignmentToCollab,
  persistTakeAlignment,
  restoreTakeAlignment,
  type TakeAlignment,
} from "./alignment-persist";
import { ALS_SAMPLES_DIR, type AlsStem, buildAls } from "./als";
import {
  archivedStreamMetas,
  buildAttribution,
  emptyAttribution,
  type SessionAttribution,
  type SessionSummaryPayload,
} from "./attribution";
import {
  addComment,
  editCommentText,
  loadComments,
  type NewComment,
  openCommentCount,
  removeComment,
  resolveComment,
  saveComments,
  sortComments,
  type TakeComment,
  unresolveComment,
} from "./comments";
import { LoadQueue } from "./load-queue";
import { logicImportGuide } from "./logic-guide";
import {
  addMarker,
  loadMarkers,
  type Marker,
  removeMarker,
  renameMarker,
  saveMarkers,
  sortMarkers,
} from "./markers";
import type { MidiEvent } from "./midi";
import { encodeMidiFile } from "./midi-file";
import { computeWaveform, dbToLinear, type PlayerSnapshot, TakePlayer } from "./player";
import { buildProjectManifest, type ProjectManifest } from "./project-manifest";
import { RENDER_SAMPLE_RATE, type RenderModel, renderMaster, renderStems } from "./render";
import { type RenderRange, resolveRange, type TrackTiming } from "./timeline-math";
import { fileSafe } from "./track-model";
import { bindMixToCollab } from "./use-collab";
import { encodeWav } from "./wav";
import { buildZip, type ZipEntry } from "./zip";

let session: DeskSession | null = null;
let latest: DeskSessionState | null = null;
let player: TakePlayer | null = null;
let playerSnap: PlayerSnapshot | null = null;

export interface DeskUiMirror {
  selection: string[];
  clipStarts: Record<string, number>;
  playheadSec: number | null;
  selectedTakeId: string | null;
  /** Recording-time master bus estimate (sum of live track peaks). */
  liveMasterLevel: number;
  /** Streams whose TRUE decoded waveform is cached. */
  waveformsCached: number;
  /** Song markers of the selected take (W2-B), timeline-sorted, with the
   * DISPLAY names (positional auto-numbering) the panels/exports show. */
  markers: Marker[];
  /** Comments of the selected take (W2-F), timeline-sorted. */
  comments: TakeComment[];
  /** Track rows in render order (F8 regression hook: this order must
   * never change within a session). */
  lanes: Array<{ key: string; name: string }>;
}

let uiMirror: DeskUiMirror | null = null;

/** Test/diagnostics hook: the desk component mirrors its editing state. */
export function publishUiMirror(mirror: DeskUiMirror): void {
  uiMirror = mirror;
}

export function getDeskSession(sessionId: string): DeskSession {
  if (!session || session.sessionId !== sessionId) {
    session?.close();
    session = new DeskSession(sessionId);
    session.subscribe((s) => {
      latest = s;
    });
    // Server-confirmed deletions: evict every local trace outside the
    // sink store (the session already told the worker), including the
    // shared doc's arrangement overrides for the removed clips.
    session.onStreamsDeleted((streamIds) => {
      for (const id of streamIds) waveformCache.delete(id);
      getPlayer().removeTracks(streamIds);
      const collab = getDeskCollab(sessionId);
      deleteArrangeKeys(collab.doc, streamIds, collab.origin);
    });
    session.start();
    (globalThis as Record<string, unknown>).__antiphonDesk = {
      session,
      snapshot: () => latest,
      player: getPlayer(),
      playerSnapshot: () => playerSnap,
      ui: () => uiMirror,
      collab: () => getDeskCollab(sessionId).snapshot(),
      // Diagnostics/e2e: apply + persist a take's alignment verdict through
      // the exact restore path a remote desk's doc update takes (F7b).
      applyAlignment: (takeId: string, entries: TakeAlignment) => {
        if (getPlayer().restoreAlignment(takeId, entries)) {
          persistTakeAlignment(getDeskCollab(sessionId), sessionId, takeId, entries);
        }
      },
    };
  }
  return session;
}

// ---- shared project doc (W3-A) ------------------------------------------------
// One CollabClient per page (net/collab.ts singleton) with the mixer
// binding attached exactly once: the player stays the audio authority, the
// doc is the state source (see use-collab.ts bindMixToCollab).

const mixBound = new WeakSet<CollabClient>();

export function getDeskCollab(sessionId: string): CollabClient {
  const collab = getCollab(sessionId);
  if (!mixBound.has(collab)) {
    mixBound.add(collab);
    bindMixToCollab(collab, getPlayer());
    // F7b: settled align() runs persist to the doc (+ localStorage shadow);
    // remote verdicts reapply to the loaded take at schedule time.
    bindAlignmentToCollab(collab, getPlayer(), sessionId);
  }
  return collab;
}

export function getPlayer(): TakePlayer {
  if (!player) {
    player = new TakePlayer();
    player.subscribe((s) => {
      playerSnap = s;
    });
  }
  return player;
}

export function usePlayer(): PlayerSnapshot {
  const subscribe = useCallback((onChange: () => void) => {
    return getPlayer().subscribe(() => onChange());
  }, []);
  return useSyncExternalStore(subscribe, () => playerSnap ?? getPlayer().snapshot());
}

/** Load a take into the player from the desk's OPFS store (idempotent).
 * `channelOf` maps streams to mixer lanes so strip state follows the
 * performer, not the take. */
export async function loadTakeIntoPlayer(
  sessionId: string,
  takeId: string,
  streamIds: string[],
  channelOf?: (streamId: string) => string,
): Promise<boolean> {
  const desk = getDeskSession(sessionId);
  const ok = await getPlayer().load(
    takeId,
    streamIds,
    (t, s) => desk.assembleFlac(t, s),
    channelOf,
  );
  // The player just decoded these — keep their waveforms forever.
  for (const track of getPlayer().snapshot().tracks) {
    if (track.waveform.length > 0) waveformCache.set(track.streamId, track.waveform);
  }
  return ok;
}

// ---- serialized take loads (F5) ------------------------------------------------
// The player decodes one take at a time; a pick landing while another load
// is in flight must not be dropped (it used to strand the transport on the
// stale take). Loads run through a latest-wins queue: the newest selection
// always loads eventually, intermediate picks collapse away, and alignment
// is skipped for a load that is already superseded.

export interface TakeLoadRequest {
  sessionId: string;
  takeId: string;
  streamIds: string[];
  /** Stream → mixer-lane mapping, resolved at load time (attribution may
   * land after the request is queued). */
  channelOf: (streamId: string) => string;
  /** Auto-align after a successful load (a chirp was emitted). */
  align: boolean;
}

const takeLoadQueue = new LoadQueue<TakeLoadRequest>(
  async (req, superseded) => {
    const ok = await loadTakeIntoPlayer(req.sessionId, req.takeId, req.streamIds, req.channelOf);
    if (!ok || superseded()) return;
    // F7b: a persisted verdict reapplies BEFORE any auto-align — restored
    // tracks satisfy align()'s idempotence check, so nothing re-measures
    // and the reloaded take plays with the exact stored schedule offsets.
    restoreTakeAlignment(getDeskCollab(req.sessionId), getPlayer(), req.sessionId, req.takeId);
    if (req.align) await getPlayer().align();
  },
  (error, req) => {
    // Load/align failures surface on the transport error strip — a stuck
    // selection must never be silent (F5).
    getPlayer().reportError(
      `take ${req.takeId.slice(0, 8)} load failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  },
);

/** Load the selected take through the latest-wins queue (F5). */
export function requestTakeLoad(req: TakeLoadRequest): void {
  takeLoadQueue.request(req);
}

// ---- export (W2-A) -----------------------------------------------------------
// Heavy offline work lives here, out of the component tree: render the
// loaded take through an OfflineAudioContext (render.ts), encode WAV/ZIP
// (wav.ts/zip.ts), hand the bytes to the browser as a download. Both are
// range-capable (RenderRange, room-timeline seconds) for W2-B markers;
// today's UI passes no range = whole take.

/** Render the loaded take's master mix (mixer + master state, alignment,
 * drift — exactly what playback monitors) to a 24-bit 48 kHz stereo WAV. */
export async function exportMasterWav(fileName: string, range?: RenderRange): Promise<void> {
  const model = getPlayer().renderModel();
  if (!model) throw new Error("no take loaded");
  const buffer = await renderMaster(model, range);
  downloadBlob(
    fileName,
    new Blob([encodeWav(channelData(buffer), buffer.sampleRate)], {
      type: "audio/wav",
    }),
  );
}

/** Render aligned+drift-corrected mono stems (pre-mix: strip gain/pan/
 * mute/solo intentionally not baked — see renderStems) and bundle them
 * into a STORE ZIP. `stemName` maps each track to its archive filename. */
export async function exportStemsZip(
  fileName: string,
  stemName: (streamId: string, channelKey: string) => string,
  range?: RenderRange,
): Promise<void> {
  const model = getPlayer().renderModel();
  if (!model) throw new Error("no take loaded");
  const stems = await renderStems(model, range);
  const entries = stems.map((stem) => ({
    name: stemName(stem.streamId, stem.channelKey),
    data: new Uint8Array(encodeWav(channelData(stem.buffer), stem.buffer.sampleRate)),
  }));
  downloadBlob(fileName, new Blob([buildZip(entries)], { type: "application/zip" }));
}

/** Render one master-mix WAV per song (W2-B marker span) and bundle them
 * into a STORE ZIP — the "All songs" export. Songs render sequentially:
 * each is its own OfflineAudioContext pass and PCM buffers are big. */
export async function exportSongsZip(
  fileName: string,
  songs: Array<{ fileName: string; range: RenderRange }>,
): Promise<void> {
  const model = getPlayer().renderModel();
  if (!model) throw new Error("no take loaded");
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  for (const song of songs) {
    const buffer = await renderMaster(model, song.range);
    entries.push({
      name: song.fileName,
      data: new Uint8Array(encodeWav(channelData(buffer), buffer.sampleRate)),
    });
  }
  downloadBlob(fileName, new Blob([buildZip(entries)], { type: "application/zip" }));
}

/** Download the take's captured MIDI as a standard MIDI file (W3-C).
 * Pure encode (midi-file.ts) — no render pass, so no busy state. */
export function exportMidiFile(fileName: string, events: readonly MidiEvent[]): void {
  downloadBlob(fileName, new Blob([encodeMidiFile(events)], { type: "audio/midi" }));
}

function channelData(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch));
}

function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Revoke after the download has had time to start (revoking immediately
  // races the browser's fetch of the blob URL).
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---- DAW project exports (W3-B) ------------------------------------------------
// Three package flavors over one render path, all client-side from the
// loaded take (range = whole take in v1; project.json carries the songs so
// DAW-side slicing stays informed):
//   1. Project package — aligned stems + master mix + project.json, the
//      honest interchange format and the fallback for every DAW.
//   2. Ableton Live — a real .als (gzipped XML, als.ts) referencing the
//      same stems under Live's Samples/Imported convention.
//   3. Logic / generic — the project package plus IMPORT-GUIDE.md (Logic
//      has no documented project format; we do not fake a .logicx).

export interface ProjectLane {
  /** Mixer channel key (player ChannelStrip.key — the performer lane). */
  key: string;
  /** Human lane name (nickname when set) — labels stems and DAW tracks. */
  name: string;
  peerId: string | null;
}

/** Everything a project export needs beyond what the player holds. */
export interface ProjectExportContext {
  sessionId: string;
  lanes: ProjectLane[];
  markers: Marker[];
  comments: TakeComment[];
}

interface RenderedStem {
  streamId: string;
  channelKey: string;
  /** Bare WAV filename (lane name + stream id — the W2-A convention). */
  fileName: string;
  data: Uint8Array;
  frames: number;
  sampleRate: number;
  durationSec: number;
}

function requireRenderModel(): RenderModel {
  const model = getPlayer().renderModel();
  if (!model) throw new Error("no take loaded");
  return model;
}

/** Render + encode the per-lane stems once; every package flavor bundles
 * these same bytes. Sequential renders, like exportSongsZip: PCM is big. */
async function renderStemFiles(
  model: RenderModel,
  lanes: ProjectLane[],
  range?: RenderRange,
): Promise<RenderedStem[]> {
  const laneOf = new Map(lanes.map((lane) => [lane.key, lane]));
  const stems = await renderStems(model, range);
  return stems.map((stem) => {
    const lane = laneOf.get(stem.channelKey);
    return {
      streamId: stem.streamId,
      channelKey: stem.channelKey,
      fileName: `${lane ? `${fileSafe(lane.name)}-` : ""}${stem.streamId.slice(0, 8)}.wav`,
      data: new Uint8Array(encodeWav(channelData(stem.buffer), stem.buffer.sampleRate)),
      frames: stem.buffer.length,
      sampleRate: stem.buffer.sampleRate,
      durationSec: stem.buffer.duration,
    };
  });
}

function manifestOf(
  ctx: ProjectExportContext,
  model: RenderModel,
  snap: PlayerSnapshot,
  stems: RenderedStem[],
  range: { startSec: number; endSec: number },
): ProjectManifest {
  const trackOf = new Map(snap.tracks.map((t) => [t.streamId, t]));
  const timingOf = new Map(model.tracks.map((t) => [t.streamId, t.timing]));
  return buildProjectManifest({
    sessionId: ctx.sessionId,
    takeId: model.takeId,
    sampleRate: RENDER_SAMPLE_RATE,
    bitDepth: 24,
    range,
    masterFile: "master.wav",
    masterDb: snap.masterDb,
    masterPan: snap.masterPan,
    masterEq: snap.masterEq,
    stems: stems.map((stem) => ({
      file: `stems/${stem.fileName}`,
      streamId: stem.streamId,
      channelKey: stem.channelKey,
      timing: timingOf.get(stem.streamId) as TrackTiming,
      alignment: trackOf.get(stem.streamId)?.alignment ?? null,
      drift: trackOf.get(stem.streamId)?.drift ?? null,
    })),
    channels: snap.channels,
    lanes: ctx.lanes,
    markers: ctx.markers,
    comments: ctx.comments,
  });
}

async function packageZip(
  fileName: string,
  ctx: ProjectExportContext,
  withLogicGuide: boolean,
  range?: RenderRange,
): Promise<void> {
  const model = requireRenderModel();
  const snap = getPlayer().snapshot();
  const resolved = resolveRange(model.durationSec, range);
  const stems = await renderStemFiles(model, ctx.lanes, range);
  const master = await renderMaster(model, range);
  const manifest = manifestOf(ctx, model, snap, stems, resolved);
  const entries: ZipEntry[] = [
    ...stems.map((stem) => ({ name: `stems/${stem.fileName}`, data: stem.data })),
    {
      name: "master.wav",
      data: new Uint8Array(encodeWav(channelData(master), master.sampleRate)),
    },
    {
      name: "project.json",
      data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
    },
  ];
  if (withLogicGuide) {
    entries.push({
      name: "IMPORT-GUIDE.md",
      data: new TextEncoder().encode(logicImportGuide(manifest)),
    });
  }
  downloadBlob(fileName, new Blob([buildZip(entries)], { type: "application/zip" }));
}

/** Project package (ZIP): per-lane aligned stems under stems/, the master
 * mix, and the schema-versioned project.json manifest. */
export async function exportProjectPackage(
  fileName: string,
  ctx: ProjectExportContext,
  range?: RenderRange,
): Promise<void> {
  await packageZip(fileName, ctx, false, range);
}

/** Logic / generic stems package: the project package plus an honest
 * IMPORT-GUIDE.md (Logic has no documented project format to write). */
export async function exportLogicPackage(
  fileName: string,
  ctx: ProjectExportContext,
  range?: RenderRange,
): Promise<void> {
  await packageZip(fileName, ctx, true, range);
}

/** Ableton Live project: "<setName> Project.zip" containing <setName>.als
 * plus the stems under Samples/Imported/ — Live's own project folder
 * convention, referenced from the set by relative path. */
export async function exportAbletonProject(
  setName: string,
  ctx: ProjectExportContext,
  range?: RenderRange,
): Promise<void> {
  const model = requireRenderModel();
  const snap = getPlayer().snapshot();
  const resolved = resolveRange(model.durationSec, range);
  const stems = await renderStemFiles(model, ctx.lanes, range);
  const stripOf = new Map(snap.channels.map((c) => [c.key, c]));
  const laneOf = new Map(ctx.lanes.map((lane) => [lane.key, lane]));
  const alsStems: AlsStem[] = stems.map((stem) => {
    const strip = stripOf.get(stem.channelKey);
    return {
      name: laneOf.get(stem.channelKey)?.name ?? stem.channelKey.slice(0, 8),
      fileName: stem.fileName,
      durationSec: stem.durationSec,
      frames: stem.frames,
      sampleRate: stem.sampleRate,
      fileSizeBytes: stem.data.length,
      gainLinear: dbToLinear(strip?.gainDb ?? 0),
      pan: strip?.pan ?? 0,
      muted: strip?.muted ?? false,
    };
  });
  // Markers live on the take's room timeline; the set's timeline starts at
  // the render range head. Whole-take (v1) passes through unchanged.
  const locators = ctx.markers
    .filter((m) => m.atSec >= resolved.startSec && m.atSec < resolved.endSec)
    .map((m) => ({ name: m.name, atSec: m.atSec - resolved.startSec }));
  const als = await buildAls({
    stems: alsStems,
    locators,
    masterGainLinear: dbToLinear(snap.masterDb),
    masterPan: snap.masterPan,
  });
  const entries: ZipEntry[] = [
    { name: `${setName}.als`, data: als },
    ...stems.map((stem) => ({ name: `${ALS_SAMPLES_DIR}/${stem.fileName}`, data: stem.data })),
  ];
  downloadBlob(
    `${setName} Project.zip`,
    new Blob([buildZip(entries)], { type: "application/zip" }),
  );
}

// ---- persistent true-waveform cache -----------------------------------------
// Clips must ALWAYS draw the real decoded waveform once a stream is
// complete, independent of what the player has loaded. Streams are decoded
// once in the background (transient OfflineAudioContext; only the ~240
// floats are retained) and cached for the session's lifetime.

const waveformCache = new Map<string, number[]>();
const waveformInFlight = new Set<string>();
const waveformWarned = new Set<string>();

export function getCachedWaveform(streamId: string): number[] | undefined {
  return waveformCache.get(streamId);
}

export function waveformCacheSize(): number {
  return waveformCache.size;
}

/** Decode one completed stream and cache its waveform. Returns true when
 * the cache gained an entry. Serialized per stream; safe to spam. */
export async function ensureWaveform(
  sessionId: string,
  takeId: string,
  streamId: string,
): Promise<boolean> {
  if (waveformCache.has(streamId) || waveformInFlight.has(streamId)) return false;
  waveformInFlight.add(streamId);
  try {
    const flac = await getDeskSession(sessionId).assembleFlac(takeId, streamId);
    if (!flac) return false;
    const scratch = new OfflineAudioContext(1, 1, 48_000);
    const buffer = await scratch.decodeAudioData(flac);
    waveformCache.set(streamId, computeWaveform(buffer));
    return true;
  } catch (e) {
    // A complete stream that won't assemble/decode is real signal (corrupt
    // FLAC, OPFS trouble) — but the status poll retries every tick, so
    // warn once per stream, not once per attempt.
    if (!waveformWarned.has(streamId)) {
      waveformWarned.add(streamId);
      console.warn(`[desk] waveform decode failed (stream ${streamId})`, e);
    }
    return false;
  } finally {
    waveformInFlight.delete(streamId);
  }
}

export function useDeskState(sessionId: string): DeskSessionState {
  const subscribe = useCallback(
    (onChange: () => void) => getDeskSession(sessionId).subscribe(() => onChange()),
    [sessionId],
  );
  return useSyncExternalStore(subscribe, () => latest ?? getDeskSession(sessionId).snapshot());
}

// ---- cold-desk attribution (F1) --------------------------------------------------
// Live stream-announces exist only in the memory of desks present when a
// take rolled. The server persists the same facts (streams.peerId,
// takes.startedAt, peers.label/deviceId); this hook fetches them in one
// round-trip so a reloaded or second desk rebuilds lanes, take ordering,
// and its polling set. Re-fetches only while a take the archive doesn't
// know is on screen (a take that just started, or history while the server
// was unreachable) — one request per new take, then quiet.

export interface AttributionState extends SessionAttribution {
  /** First fetch attempt finished (either way): safe to load takes — the
   * best available stream→lane mapping is in hand. */
  ready: boolean;
}

const ATTRIBUTION_RETRY_MS = 5_000;

export function useSessionAttribution(
  sessionId: string,
  observedTakeIds: readonly string[],
): AttributionState {
  const [attribution, setAttribution] = useState<AttributionState>(() => ({
    ...emptyAttribution(),
    ready: false,
  }));
  const fetchedFor = useRef<string | null>(null);
  const unknownKey = observedTakeIds
    .filter((takeId) => !attribution.takeStartedAt.has(takeId))
    .join(",");

  useEffect(() => {
    if (fetchedFor.current === sessionId && unknownKey === "") return;
    let cancelled = false;
    const fetchAttribution = async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}`);
        if (cancelled) return;
        if (res.ok) {
          const payload = (await res.json()) as SessionSummaryPayload;
          if (cancelled) return;
          fetchedFor.current = sessionId;
          // Seed the sink with the archive's streams this desk never saw
          // announced: the worker's HAVE exchange then covers them and the
          // server backfills our local copy (a cold second desk otherwise
          // has nothing to reconcile against).
          getDeskSession(sessionId).seedArchivedStreams(archivedStreamMetas(payload));
          setAttribution({ ...buildAttribution(payload), ready: true });
          return;
        }
      } catch {
        // fall through: server away — same handling as a non-OK response
      }
      // Server away/erroring: mark ready (loads proceed on the live
      // fallback) and let the interval retry while unattributed takes
      // remain on screen.
      if (!cancelled) setAttribution((prev) => (prev.ready ? prev : { ...prev, ready: true }));
    };
    void fetchAttribution();
    const timer = window.setInterval(fetchAttribution, ATTRIBUTION_RETRY_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId, unknownKey]);

  return attribution;
}

// ---- shared take-list plumbing (W3-A) ------------------------------------------
// Markers and comments read/write through the shared doc (per their W2-B/
// W2-F persistence boundaries: ONLY load/save is replaced — pure models
// untouched). localStorage stays as SHADOW persistence: it seeds the doc
// once per take, serves as the display fallback while the doc has no entry
// (offline single-desk parity), and is rewritten on every change — remote
// edits included — as cheap offline insurance.

function useCollabTakeList<T extends { id: string }>(
  sessionId: string,
  takeId: string | null,
  kind: ListKind,
  loadLocal: (sessionId: string, takeId: string) => T[],
  saveLocal: (sessionId: string, takeId: string, items: readonly T[]) => void,
  sort: (items: readonly T[]) => T[],
): { items: T[]; commit: (next: readonly T[]) => void } {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    if (!takeId) {
      setItems([]);
      return;
    }
    const collab = getDeskCollab(sessionId);
    const refresh = () => {
      const list = sort(displayTakeList<T>(collab.doc, kind, takeId, loadLocal(sessionId, takeId)));
      setItems(list);
      if (hasTakeList(collab.doc, kind, takeId)) saveLocal(sessionId, takeId, list);
    };
    refresh();
    // Seed-once: after the first sync (immediately when already synced;
    // never while offline — the fallback covers), migrate the local
    // snapshot of a take the doc doesn't know. Guarded by the doc-level
    // seeded flag, so a second desk with the same localStorage won't
    // duplicate (see collab-doc.ts for the accepted concurrent-seed bound).
    const unSynced = collab.onSynced(() => {
      if (seedTakeListOnce(collab.doc, kind, takeId, loadLocal(sessionId, takeId), collab.origin)) {
        refresh();
      }
    });
    const map = collab.doc.getMap(kind);
    const observer = () => refresh();
    map.observeDeep(observer);
    return () => {
      unSynced();
      map.unobserveDeep(observer);
    };
  }, [sessionId, takeId, kind, loadLocal, saveLocal, sort]);

  const ref = useRef({ sessionId, takeId });
  ref.current = { sessionId, takeId };
  const commit = useCallback(
    (next: readonly T[]) => {
      const { sessionId: sid, takeId: tid } = ref.current;
      if (!tid) return;
      const collab = getDeskCollab(sid);
      // First edit while the doc lacks the take migrates the whole
      // fallback list (callers derive `next` from the displayed items).
      writeTakeList(collab.doc, kind, tid, next, collab.origin);
      saveLocal(sid, tid, next); // shadow write (observer also refreshes state)
    },
    [kind, saveLocal],
  );

  return { items, commit };
}

// ---- song markers (W2-B) -----------------------------------------------------

export interface TakeMarkersApi {
  /** Timeline-sorted markers of the current take ([] when none selected). */
  markers: Marker[];
  /** Add at a take-timeline position; null when the spot is taken. */
  addAt(atSec: number): Marker | null;
  rename(id: string, name: string): void;
  remove(id: string): void;
}

/** The selected take's song markers through the shared project doc (W3-A),
 * localStorage as seed/fallback/shadow. Mutation callbacks are
 * identity-stable: safe in effect deps. */
export function useTakeMarkers(sessionId: string, takeId: string | null): TakeMarkersApi {
  const { items: markers, commit } = useCollabTakeList<Marker>(
    sessionId,
    takeId,
    "markers",
    loadMarkers,
    saveMarkers,
    sortMarkers,
  );

  const ref = useRef({ takeId, markers });
  ref.current = { takeId, markers };

  const addAt = useCallback(
    (atSec: number): Marker | null => {
      if (!ref.current.takeId) return null;
      const { markers: next, added } = addMarker(ref.current.markers, atSec);
      if (added) commit(next);
      return added;
    },
    [commit],
  );
  const rename = useCallback(
    (id: string, name: string) => commit(renameMarker(ref.current.markers, id, name)),
    [commit],
  );
  const remove = useCallback(
    (id: string) => commit(removeMarker(ref.current.markers, id)),
    [commit],
  );

  return { markers, addAt, rename, remove };
}

// ---- take comments (W2-F) ------------------------------------------------------

export interface TakeCommentsApi {
  /** Timeline-sorted comments of the current take ([] when none selected). */
  comments: TakeComment[];
  /** Comments not yet marked done (the panel-tab badge count). */
  openCount: number;
  /** Add a comment; null when the trimmed text is empty. */
  add(input: NewComment): TakeComment | null;
  editText(id: string, text: string): void;
  resolve(id: string): void;
  unresolve(id: string): void;
  remove(id: string): void;
}

/** The selected take's comments through the shared project doc (W3-A),
 * localStorage as seed/fallback/shadow. Mutation callbacks are
 * identity-stable: safe in effect deps. */
export function useTakeComments(sessionId: string, takeId: string | null): TakeCommentsApi {
  const { items: comments, commit } = useCollabTakeList<TakeComment>(
    sessionId,
    takeId,
    "comments",
    loadComments,
    saveComments,
    sortComments,
  );

  const ref = useRef({ takeId, comments });
  ref.current = { takeId, comments };

  const add = useCallback(
    (input: NewComment): TakeComment | null => {
      if (!ref.current.takeId) return null;
      const { comments: next, added } = addComment(ref.current.comments, input);
      if (added) commit(next);
      return added;
    },
    [commit],
  );
  const editText = useCallback(
    (id: string, text: string) => commit(editCommentText(ref.current.comments, id, text)),
    [commit],
  );
  const resolve = useCallback(
    (id: string) => commit(resolveComment(ref.current.comments, id)),
    [commit],
  );
  const unresolve = useCallback(
    (id: string) => commit(unresolveComment(ref.current.comments, id)),
    [commit],
  );
  const remove = useCallback(
    (id: string) => commit(removeComment(ref.current.comments, id)),
    [commit],
  );

  return {
    comments,
    openCount: openCommentCount(comments),
    add,
    editText,
    resolve,
    unresolve,
    remove,
  };
}

export interface ServerStreamStatus {
  streamId: string;
  takeId: string;
  chunkCount: number;
  chwm: number | null;
  holes: Array<[number, number]>;
  gaps: Array<[number, number]>;
  finalSeq: number | null;
  complete: boolean;
  settled: boolean;
  flagged: boolean;
  digest: string;
}

/** Poll the server archive for every take we know about — but only while
 * a take is UNSETTLED (F6). A take whose streams all report complete is
 * terminal server-side (rows are immutable once complete): its statuses
 * latch and it leaves the polling set, so a long session stops costing
 * ~1k requests/take/hour. Rebuilt/attributed takes join the set exactly
 * like announced ones and poll until they settle. */
export function useServerStatus(
  sessionId: string,
  takeIds: string[],
): Map<string, ServerStreamStatus> {
  const [statuses, setStatuses] = useState<Map<string, ServerStreamStatus>>(new Map());
  const takeIdsRef = useRef(takeIds);
  takeIdsRef.current = takeIds;
  const settledRef = useRef(new Set<string>());
  const takeIdsKey = takeIds.join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: takeIdsKey re-arms polling when the take set changes
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const pending = takeIdsRef.current.filter((takeId) => !settledRef.current.has(takeId));
      if (pending.length === 0) return;
      const updates = new Map<string, ServerStreamStatus>();
      const settledNow: string[] = [];
      for (const takeId of pending) {
        try {
          const res = await fetch(`/api/sessions/${sessionId}/takes/${takeId}`);
          if (!res.ok) continue; // not archived yet (or gone): retry next tick
          const body = (await res.json()) as { streams: ServerStreamStatus[] };
          for (const s of body.streams) updates.set(s.streamId, s);
          if (body.streams.length > 0 && body.streams.every((s) => s.complete)) {
            settledNow.push(takeId);
          }
        } catch {
          // Silent by design: this poll fires every 2 s — an unreachable
          // server would spam; the UI already shows archive/sync state.
          return; // keep the last view
        }
      }
      if (cancelled) return;
      for (const takeId of settledNow) settledRef.current.add(takeId);
      if (updates.size > 0) {
        setStatuses((prev) => {
          const next = new Map(prev);
          for (const [streamId, status] of updates) next.set(streamId, status);
          return next;
        });
      }
    };
    void tick();
    const timer = window.setInterval(tick, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId, takeIdsKey]);

  return statuses;
}
