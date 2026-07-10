// Cold-desk attribution: live stream-announces exist only in the memory of
// desks present when a take rolled; the server persists the same facts, so
// one round-trip rebuilds lanes, take ordering, and the polling set.

import { useEffect, useRef, useState } from "react";
import { authFetch } from "../../net/auth-token";
import {
  archivedStreamMetas,
  buildAttribution,
  emptyAttribution,
  type SessionAttribution,
  type SessionSummaryPayload,
} from "./attribution";
import { getDeskSession } from "./desk-state";

export interface AttributionState extends SessionAttribution {
  /** First fetch attempt finished (either way): safe to load takes — the
   * best available stream→lane mapping is in hand. */
  ready: boolean;
}

const ATTRIBUTION_RETRY_MS = 5_000;

/** Re-fetches only while a take the archive doesn't know is on screen (a
 * take that just started, or history while the server was unreachable) —
 * one request per new take, then quiet. */
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
        // authFetch: desk REST is owner/sharee-gated in auth mode; keyless
        // sends a bare fetch.
        const res = await authFetch(`/api/sessions/${sessionId}`);
        if (cancelled) return;
        if (res.ok) {
          const payload = (await res.json()) as SessionSummaryPayload;
          if (cancelled) return;
          fetchedFor.current = sessionId;
          // Seed the sink with archived streams this desk never saw
          // announced: the worker's HAVE exchange then covers them and the
          // server backfills our local copy.
          getDeskSession(sessionId).seedArchivedStreams(archivedStreamMetas(payload));
          setAttribution({ ...buildAttribution(payload), ready: true });
          return;
        }
      } catch {
        // fall through: server away — same handling as a non-OK response
      }
      // Server away/erroring — including the honest 404 a brand-new
      // session answers until this desk's own WS hello upserts the row:
      // mark ready (loads proceed on the live fallback) and let the
      // interval retry while unattributed takes remain on screen.
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
