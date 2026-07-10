// F19: honest session-existence feedback for the join page and the
// landing's join-by-code.
//
// Server facts:
// - GET /api/sessions/:id/exists 404s when no session row exists (the
//   dedicated PUBLIC probe: W8-A moved the full summary behind desk auth,
//   and this mic-side typo check must stay accountless in both modes) and
//   200s once the row does (a desk opening the invite, POST
//   /api/sessions, or ingest). The verdict is therefore STATUS-based; the
//   body never matters. Accepted bound: a recorder joining a void creates
//   the row too, so its own session reads "present" from then on — a
//   session with a live recorder in it is real enough, and the
//   typo-warning window that matters is before anyone joins.
// - Rate limiting sits on the WS upgrade paths (/…/ws, /…/collab) only,
//   NOT on this GET (35 rapid probes → 35× 200), so a gentle poll is safe.
//
// Probe philosophy: capture NEVER gates on the network. Fetch failures and
// non-200/404 statuses (5xx, proxy noise) read as "unknown" — we warn only
// on a definite miss, and the verdict can only ever upgrade
// (absent → present), never flap.

import { useEffect, useRef, useState } from "react";

export type SessionExistence = "unknown" | "absent" | "present";

/** Decode a probe's HTTP status into an existence verdict. */
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

/**
 * Live existence verdict for a session id. `confirmed` lets the caller
 * short-circuit with knowledge the probe can't beat — e.g. a desk visible
 * in the signaling roster after joining. Both signals LATCH: once a
 * session is known to exist it stays "present" (a desk leaving later is a
 * roster concern, not an invite-link typo).
 */
export function useSessionExistence(sessionId: string | null, confirmed = false): SessionExistence {
  const [verdict, setVerdict] = useState<SessionExistence>("unknown");
  const confirmedOnce = useRef(false);
  // A different id (the landing input) is a different question: drop both
  // latches before they can leak a stale verdict (documented React pattern
  // for adjusting state when props change — render-phase, no effect tick).
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
