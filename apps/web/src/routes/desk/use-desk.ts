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
import {
  addMarker,
  loadMarkers,
  type Marker,
  removeMarker,
  renameMarker,
  saveMarkers,
  sortMarkers,
} from "./markers";
import { computeWaveform, type PlayerSnapshot, TakePlayer } from "./player";
import { renderMaster, renderStems } from "./render";
import type { RenderRange } from "./timeline-math";
import { bindMixToCollab } from "./use-collab";
import { encodeWav } from "./wav";
import { buildZip } from "./zip";

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
  /** Song markers of the selected take (W2-B), timeline-sorted. */
  markers: Marker[];
  /** Comments of the selected take (W2-F), timeline-sorted. */
  comments: TakeComment[];
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

/** Poll the server archive for every take we know about. */
export function useServerStatus(
  sessionId: string,
  takeIds: string[],
): Map<string, ServerStreamStatus> {
  const [statuses, setStatuses] = useState<Map<string, ServerStreamStatus>>(new Map());
  const takeIdsRef = useRef(takeIds);
  takeIdsRef.current = takeIds;
  const takeIdsKey = takeIds.join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: takeIdsKey re-arms polling when the take set changes
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const next = new Map<string, ServerStreamStatus>();
      for (const takeId of takeIdsRef.current) {
        try {
          const res = await fetch(`/api/sessions/${sessionId}/takes/${takeId}`);
          if (!res.ok) continue;
          const body = (await res.json()) as { streams: ServerStreamStatus[] };
          for (const s of body.streams) next.set(s.streamId, s);
        } catch {
          // Silent by design: this poll fires every 2 s — an unreachable
          // server would spam; the UI already shows archive/sync state.
          return; // keep the last view
        }
      }
      if (!cancelled) setStatuses(next);
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
