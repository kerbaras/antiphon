// One DeskSession + one TakePlayer per page, bridged into React, plus
// server-side archive polling for the sink-convergence table.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DeskSession, type DeskSessionState } from "../../net/desk-session";
import { computeWaveform, type PlayerSnapshot, TakePlayer } from "./player";

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

/** Load a take into the player from the desk's OPFS store (idempotent). */
export async function loadTakeIntoPlayer(
  sessionId: string,
  takeId: string,
  streamIds: string[],
): Promise<boolean> {
  const desk = getDeskSession(sessionId);
  const ok = await getPlayer().load(takeId, streamIds, (t, s) => desk.assembleFlac(t, s));
  // The player just decoded these — keep their waveforms forever.
  for (const track of getPlayer().snapshot().tracks) {
    if (track.waveform.length > 0) waveformCache.set(track.streamId, track.waveform);
  }
  return ok;
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
