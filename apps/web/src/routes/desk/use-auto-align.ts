// Selection-aware auto-align: no selection → force re-align the loaded
// take (all lanes); with one → every take owning selected clips, selected
// streams only, sequentially through the latest-wins load queue, then the
// loaded take is restored. Cancel semantics live in align-flow.ts.

import { useCallback, useEffect, useRef, useState } from "react";
import type { CollabClient } from "../../net/collab";
import { type ClipRegion, deleteArrangeKeys } from "../../net/collab-doc";
import type { DeskSessionState } from "../../net/desk-session";
import { planAlignScopes, runAlignFlow } from "./align-flow";
import type { PlayerSnapshot } from "./player";
import { selectionStreamIds } from "./regions";
import type { TakeSlot } from "./track-model";
import { getPlayer, requestTakeLoad } from "./use-desk";

export function useAutoAlign({
  sessionId,
  collab,
  state,
  takes,
  recording,
  playerSnap,
  selectedTakeId,
  selectedStreamIds,
  selection,
  docRegions,
  writeStreamRegionsMap,
  clipStartOverrides,
  orphanedStreams,
  channelOf,
}: {
  sessionId: string;
  collab: CollabClient;
  state: DeskSessionState;
  takes: Map<string, TakeSlot>;
  recording: boolean;
  playerSnap: PlayerSnapshot;
  selectedTakeId: string | null;
  selectedStreamIds: string[];
  selection: string[];
  docRegions: Record<string, ClipRegion[]>;
  writeStreamRegionsMap: (streamId: string, regions: ClipRegion[]) => void;
  clipStartOverrides: Record<string, number>;
  orphanedStreams: Set<string>;
  channelOf: (streamId: string) => string;
}) {
  const [alignFlow, setAlignFlow] = useState<{ done: number; total: number } | null>(null);
  const [alignNote, setAlignNote] = useState<string | null>(null);
  const alignNoteTimer = useRef<number | null>(null);
  /** Transient chip note — auto-expires, replaced by the next run. */
  const noteAlign = useCallback((text: string | null) => {
    if (alignNoteTimer.current !== null) window.clearTimeout(alignNoteTimer.current);
    alignNoteTimer.current = null;
    setAlignNote(text);
    if (text !== null) {
      alignNoteTimer.current = window.setTimeout(() => setAlignNote(null), 10_000);
    }
  }, []);
  useEffect(
    () => () => {
      if (alignNoteTimer.current !== null) window.clearTimeout(alignNoteTimer.current);
    },
    [],
  );
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  // Session-identity guard for the async flow: an EPOCH, not a boolean —
  // a flag would flip back for the new session while the old flow's
  // closure still watches the same ref.
  const flowEpoch = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId IS the trigger — its change (and unmount) must bump the epoch
  useEffect(() => {
    return () => {
      flowEpoch.current += 1;
    };
  }, [sessionId]);

  /** Reset the scoped clips' manual moves up front, ONE doc transaction —
   * a manual move is exactly what re-align exists to undo. Never-split
   * clips drop their arrange override; split streams keep their CUTS but
   * every piece returns to its source-true spot (take slot + source
   * offset) so the fresh verdict lines the waveforms up. The frozen
   * legacy `arrange` key survives (old clients' pre-split view). A
   * mid-flow cancel leaving a scope reset-but-not-remeasured is safe: the
   * persisted verdict still draws and plays those clips aligned. */
  function resetManualMoves(scopes: Array<{ takeId: string; streamIds: string[] }>): number {
    const scopedIds = scopes.flatMap((s) => s.streamIds);
    const resetIds = scopedIds.filter((id) => docRegions[id] === undefined);
    let resetCount = resetIds.filter((id) => clipStartOverrides[id] !== undefined).length;
    collab.sealUndo(); // the whole reset = one undo step
    deleteArrangeKeys(collab.doc, resetIds, collab.origin);
    const EPS = 1e-9;
    for (const scope of scopes) {
      const base = takes.get(scope.takeId)?.offsetSec ?? 0;
      for (const id of scope.streamIds) {
        const regions = docRegions[id];
        if (!regions) continue;
        const next = regions.map((r) => ({ ...r, startSec: base + r.sourceOffsetSec }));
        const moved = next.filter(
          (r, i) => Math.abs(r.startSec - (regions[i] as ClipRegion).startSec) > EPS,
        ).length;
        if (moved > 0) {
          writeStreamRegionsMap(id, next);
          resetCount += moved;
        }
      }
    }
    return resetCount;
  }

  function autoAlign() {
    if (alignFlow !== null || playerSnap.aligning || recording || !selectedTakeId) return;
    // Selection holds REGION ids; the align scope is per-STREAM (head
    // trims are properties of the capture, shared by all its pieces).
    const scopes =
      selection.length > 0
        ? planAlignScopes(
            selectionStreamIds(selection, docRegions),
            state.deskStatus.map((s) => ({
              streamId: s.streamId,
              takeId: s.takeId,
              complete: s.complete,
            })),
            {
              liveTakeId: state.activeTakeId,
              orphanedStreamIds: orphanedStreams,
              takeOrder: [...takes.keys()],
              loadedTakeId: playerSnap.loadedTakeId,
            },
          )
        : [{ takeId: selectedTakeId, streamIds: selectedStreamIds }];
    if (scopes.length === 0) {
      noteAlign("selection has no alignable clips");
      return;
    }
    const resetCount = resetManualMoves(scopes);
    noteAlign(
      resetCount > 0
        ? `manual offsets reset · ${resetCount} clip${resetCount === 1 ? "" : "s"}`
        : null,
    );
    setAlignFlow({ done: 0, total: scopes.length });
    const flowSessionId = sessionId;
    const epoch = flowEpoch.current;
    const streamsOfTake = (takeId: string): string[] =>
      state.deskStatus.filter((s) => s.takeId === takeId && s.complete).map((s) => s.streamId);
    void runAlignFlow(scopes, {
      loadedTakeId: () => getPlayer().snapshot().loadedTakeId,
      cancelled: () => recordingRef.current || flowEpoch.current !== epoch,
      // Steps enqueue with NO busy pre-check: a step's settle signal fires
      // inside the queue's drain loop, so the next enqueue lands in our
      // own drain's pending slot. Foreign requests win through the
      // queue's own supersede/dropped-pending signals — the flow yields.
      runStep: (takeId, streamIds) =>
        new Promise((resolve) => {
          requestTakeLoad({
            sessionId: flowSessionId,
            takeId,
            streamIds: streamsOfTake(takeId), // the LOAD is whole-take…
            channelOf,
            align: false,
            forceAlignScope: streamIds, // …the MEASUREMENT is the selection
            onSettled: resolve,
          });
        }),
      restore: (takeId) => {
        requestTakeLoad({
          sessionId: flowSessionId,
          takeId,
          streamIds: streamsOfTake(takeId),
          channelOf,
          align: true, // restore persisted verdict; align() no-ops on it
        });
      },
      onProgress: (done, total) => setAlignFlow({ done, total }),
    }).finally(() => setAlignFlow(null));
  }

  return { alignFlow, alignNote, autoAlign };
}
