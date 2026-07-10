// Session-existence probe (GET /api/sessions/:id/exists — public, unrated,
// status-based: 200 present / 404 absent). Warn-only, never a gate: capture
// never gates on the network, and the verdict only upgrades — never flaps.

import { useEffect, useRef, useState } from "react";

export type SessionExistence = "unknown" | "absent" | "present";

/** Decode a probe's HTTP status. Anything that is neither a definite hit
 * nor a definite miss (5xx, proxy noise) stays "unknown" — never a false
 * warning. */
export function interpretProbeStatus(status: number): SessionExistence {
  if (status === 200) return "present";
  if (status === 404) return "absent";
  return "unknown";
}

/** Gentle re-probe: 5s while the desk may be "opening right now", backing
 * off to 15s after ~a minute. Stops entirely once present (latched). */
const POLL_MS = 5_000;
const SETTLED_POLL_MS = 15_000;
const SETTLE_AFTER_POLLS = 12;

/** Live existence verdict for a session id. `confirmed` lets the caller
 * short-circuit with knowledge the probe can't beat (e.g. a desk visible in
 * the roster after joining). Both signals LATCH: present stays present. */
export function useSessionExistence(sessionId: string | null, confirmed = false): SessionExistence {
  const [verdict, setVerdict] = useState<SessionExistence>("unknown");
  const confirmedOnce = useRef(false);
  // A different id is a different question: drop both latches before they
  // leak a stale verdict (render-phase state adjustment, no effect tick).
  const lastId = useRef(sessionId);
  if (lastId.current !== sessionId) {
    lastId.current = sessionId;
    confirmedOnce.current = false;
    setVerdict("unknown");
  }
  if (confirmed) confirmedOnce.current = true;
  const present = confirmedOnce.current || verdict === "present";

  useEffect(() => {
    if (sessionId === null || present) return;
    let cancelled = false;
    let timer = 0;
    let polls = 0;
    const probe = async (): Promise<void> => {
      let next: SessionExistence = "unknown";
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/exists`);
        next = interpretProbeStatus(res.status);
      } catch {
        // Offline / server unreachable: stay "unknown" — never a false warning.
      }
      if (cancelled) return;
      if (next !== "unknown") setVerdict(next);
      if (next === "present") return; // latched by the state update above
      polls += 1;
      timer = window.setTimeout(
        () => void probe(),
        polls >= SETTLE_AFTER_POLLS ? SETTLED_POLL_MS : POLL_MS,
      );
    };
    void probe();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sessionId, present]);

  return present ? "present" : verdict;
}
