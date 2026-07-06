// One DeskSession + one TakePlayer per page, bridged into React, plus
// server-side archive polling for the sink-convergence table.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DeskSession, type DeskSessionState } from "../../net/desk-session";
import { type PlayerSnapshot, TakePlayer } from "./player";

let session: DeskSession | null = null;
let latest: DeskSessionState | null = null;
let player: TakePlayer | null = null;
let playerSnap: PlayerSnapshot | null = null;

export interface DeskUiMirror {
  selection: string[];
  clipStarts: Record<string, number>;
  playheadSec: number | null;
  selectedTakeId: string | null;
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
  return await getPlayer().load(takeId, streamIds, (t, s) => desk.assembleFlac(t, s));
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
