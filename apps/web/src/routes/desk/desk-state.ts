// Page singletons: one DeskSession, one SessionPlayer, one CollabClient,
// bridged into React, plus the page-lifetime decoded-waveform cache and
// the __antiphonDesk window hook (pinned by e2e).

import { useCallback, useSyncExternalStore } from "react";
import { type CollabClient, getCollab } from "../../net/collab";
import { type ClipRegion, deleteArrangeKeys, deleteRegionKeys } from "../../net/collab-doc";
import { DeskSession, type DeskSessionState } from "../../net/desk-session";
import {
  bindAlignmentToCollab,
  persistTakeAlignment,
  readDocAlignment,
  readTakeAlignment,
  type TakeAlignment,
} from "./alignment-persist";
import type { TakeComment } from "./comments";
import type { Marker } from "./markers";
import { computeWaveform, type PlayerSnapshot, SessionPlayer } from "./player";
import { bindMixToCollab } from "./use-collab";

let session: DeskSession | null = null;
let latest: DeskSessionState | null = null;
let player: SessionPlayer | null = null;
let playerSnap: PlayerSnapshot | null = null;

export interface DeskUiMirror {
  /** Selected REGION ids — the streamId for never-split streams. */
  selection: string[];
  clipStarts: Record<string, number>;
  /** Split streams' doc-held region lists; never-split streams absent. */
  regions: Record<string, ClipRegion[]>;
  tool: "select" | "split" | "trim";
  playheadSec: number | null;
  selectedTakeId: string | null;
  /** Recording-time master bus estimate (sum of live track peaks). */
  liveMasterLevel: number;
  /** Streams whose TRUE decoded waveform is cached. */
  waveformsCached: number;
  /** Song markers of the selected take, timeline-sorted, with the DISPLAY
   * names (positional auto-numbering) the panels/exports show. */
  markers: Marker[];
  /** Comments of the selected take, timeline-sorted. */
  comments: TakeComment[];
  /** The song under the playhead, null when the session position sits
   * outside the selected take. */
  currentSongId: string | null;
  /** Track rows in render order — stable within a session except through
   * the operator's own context-menu Move up/down. */
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
    // Server-confirmed deletions: evict every local trace, including the
    // shared doc's arrange/region keys. systemOrigin keeps the cleanup out
    // of the undo ledger — Ctrl+Z can't restore blobs, so it must not
    // resurrect their doc keys either.
    session.onStreamsDeleted((streamIds) => {
      for (const id of streamIds) waveformCache.delete(id);
      getPlayer().removeTracks(streamIds);
      const collab = getDeskCollab(sessionId);
      deleteArrangeKeys(collab.doc, streamIds, collab.systemOrigin);
      deleteRegionKeys(collab.doc, streamIds, collab.systemOrigin);
    });
    session.start();
    (globalThis as Record<string, unknown>).__antiphonDesk = {
      session,
      snapshot: () => latest,
      player: getPlayer(),
      playerSnapshot: () => playerSnap,
      ui: () => uiMirror,
      collab: () => getDeskCollab(sessionId).snapshot(),
      // e2e/diagnostics: apply + persist an alignment verdict through the
      // exact restore path a remote desk's doc update takes.
      applyAlignment: (takeId: string, entries: TakeAlignment) => {
        if (getPlayer().restoreAlignment(takeId, entries)) {
          persistTakeAlignment(getDeskCollab(sessionId), sessionId, takeId, entries);
        }
      },
      // e2e/diagnostics: a take's persisted verdict record from the doc.
      alignmentRecord: (takeId: string) => readDocAlignment(getDeskCollab(sessionId).doc, takeId),
    };
  }
  return session;
}

// One CollabClient per page (net/collab.ts singleton) with the bindings
// attached exactly once: the player stays the audio authority, the doc is
// the state source (see use-collab.ts bindMixToCollab).
const mixBound = new WeakSet<CollabClient>();

export function getDeskCollab(sessionId: string): CollabClient {
  const collab = getCollab(sessionId);
  if (!mixBound.has(collab)) {
    mixBound.add(collab);
    bindMixToCollab(collab, getPlayer());
    // Settled align() runs persist to the doc (+ localStorage shadow);
    // remote verdicts reapply to the loaded take at schedule time.
    bindAlignmentToCollab(collab, getPlayer(), sessionId);
    // The engine's look-ahead mounts and the session render need OPFS
    // assembly + persisted verdicts WITHOUT a selection in the loop.
    // Re-wired per collab client, so a session switch repoints both.
    getPlayer().setSessionSources({
      assemble: (takeId, streamId) => getDeskSession(sessionId).assembleFlac(takeId, streamId),
      storedAlignment: (takeId) => readTakeAlignment(collab, sessionId, takeId),
    });
  }
  return collab;
}

export function getPlayer(): SessionPlayer {
  if (!player) {
    player = new SessionPlayer();
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

export function useDeskState(sessionId: string): DeskSessionState {
  const subscribe = useCallback(
    (onChange: () => void) => getDeskSession(sessionId).subscribe(() => onChange()),
    [sessionId],
  );
  return useSyncExternalStore(subscribe, () => latest ?? getDeskSession(sessionId).snapshot());
}

// ---- persistent true-waveform cache -----------------------------------------
// Clips must ALWAYS draw the real decoded waveform once a stream is
// complete, independent of what the player has loaded. Streams are decoded
// once (only the ~240 floats are retained), cached for the page lifetime.

const waveformCache = new Map<string, number[]>();
const waveformInFlight = new Set<string>();
const waveformWarned = new Set<string>();

export function getCachedWaveform(streamId: string): number[] | undefined {
  return waveformCache.get(streamId);
}

export function waveformCacheSize(): number {
  return waveformCache.size;
}

/** Internal: retain a waveform the player already decoded. */
export function cacheWaveform(streamId: string, waveform: number[]): void {
  waveformCache.set(streamId, waveform);
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
    // Real signal (corrupt FLAC, OPFS trouble) — but the status poll
    // retries every tick, so warn once per stream, not once per attempt.
    if (!waveformWarned.has(streamId)) {
      waveformWarned.add(streamId);
      console.warn(`[desk] waveform decode failed (stream ${streamId})`, e);
    }
    return false;
  } finally {
    waveformInFlight.delete(streamId);
  }
}
