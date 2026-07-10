// Server-archive polling for the sink-convergence table.

import { useEffect, useRef, useState } from "react";
import { authFetch } from "../../net/auth-token";

export interface ServerStreamStatus {
  streamId: string;
  takeId: string;
  /** The stream's seq-0 device/mic description as the server archived it.
   * Null for streams recorded before the header carried one. */
  deviceDesc: string | null;
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

/** Poll the server archive for every take we know about — but only while a
 * take is UNSETTLED. A take whose streams all report complete is terminal
 * server-side (rows are immutable once complete): its statuses latch and
 * it leaves the polling set, so a long session stops costing requests. */
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
    // One AbortController per effect generation: a tick in flight holds
    // this generation's sessionId in its closure, so aborting on cleanup
    // cancels the in-flight fetch AND gates every later await resumption —
    // no stray cross-session GET after a session switch.
    const controller = new AbortController();
    const { signal } = controller;
    const tick = async () => {
      const pending = takeIdsRef.current.filter((takeId) => !settledRef.current.has(takeId));
      if (pending.length === 0) return;
      const updates = new Map<string, ServerStreamStatus>();
      const settledNow: string[] = [];
      for (const takeId of pending) {
        if (signal.aborted) return; // stale generation: no further requests
        try {
          const res = await authFetch(`/api/sessions/${sessionId}/takes/${takeId}`, { signal });
          if (!res.ok) continue; // not archived yet (or gone): retry next tick
          const body = (await res.json()) as { streams: ServerStreamStatus[] };
          for (const s of body.streams) updates.set(s.streamId, s);
          if (body.streams.length > 0 && body.streams.every((s) => s.complete)) {
            settledNow.push(takeId);
          }
        } catch {
          // Silent by design (aborts land here too): this poll fires every
          // 2 s — an unreachable server would spam; the UI already shows
          // archive/sync state.
          return; // keep the last view
        }
      }
      if (signal.aborted) return;
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
      controller.abort();
      window.clearInterval(timer);
    };
  }, [sessionId, takeIdsKey]);

  return statuses;
}
