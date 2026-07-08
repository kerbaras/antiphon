// One DeskSession + one TakePlayer per page, bridged into React, plus
// server-side archive polling for the sink-convergence table.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DeskSession, type DeskSessionState } from "../../net/desk-session";
import { computeWaveform, type PlayerSnapshot, TakePlayer } from "./player";
import { renderMaster, renderStems } from "./render";
import type { RenderRange } from "./timeline-math";
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
    // sink store (the session already told the worker).
    session.onStreamsDeleted((streamIds) => {
      for (const id of streamIds) waveformCache.delete(id);
      getPlayer().removeTracks(streamIds);
    });
    session.start();
    (globalThis as Record<string, unknown>).__antiphonDesk = {
      session,
      snapshot: () => latest,
      player: getPlayer(),
      playerSnapshot: () => playerSnap,
      ui: () => uiMirror,
    };
  }
  return session;
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
  } catch {
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
          // server unreachable; keep the last view
          return;
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
