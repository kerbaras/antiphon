// One CaptureController + one RecorderSession per page, bridged into React
// via useSyncExternalStore. Exposes the dev/e2e hook (window.__antiphon).

import { useCallback, useSyncExternalStore } from "react";
import { CaptureController, type CaptureSnapshot } from "../../audio/capture-controller";
import { setNickname } from "../../net/device-identity";
import { RecorderSession, type RecorderSessionState } from "../../net/recorder-session";

let controller: CaptureController | null = null;
let latest: CaptureSnapshot | null = null;
let session: RecorderSession | null = null;
let sessionState: RecorderSessionState | null = null;
/** Last stream-final reported, keyed `takeId:streamId:finalSeq` — a bare
 * seq number would swallow the final of an equal-length follow-up take.
 * A2: stream-final is idempotent (max wins), so err on re-sending. */
let lastReportedFinal: string | null = null;

export function getCaptureController(): CaptureController {
  if (!controller) {
    controller = new CaptureController();
    controller.subscribe((snap) => {
      latest = snap;
      // The worker reported a final seq: tell the sinks via control plane.
      if (snap.finalSeq !== null) {
        const key = snap.stats
          ? `${snap.stats.takeId}:${snap.stats.streamId}:${snap.finalSeq}`
          : null;
        if (key === null || key !== lastReportedFinal) {
          lastReportedFinal = key;
          session?.notifyFinal(snap.finalSeq);
        }
      }
    });
    (globalThis as Record<string, unknown>).__antiphon = {
      controller,
      snapshot: () => latest,
      session: () => session,
      sessionState: () => sessionState,
    };
  }
  return controller;
}

/** Join the session (idempotent): transports come up; capture stays local
 * until the desk starts a take. */
export function joinSession(sessionId: string): RecorderSession {
  if (!session) {
    session = new RecorderSession(sessionId, getCaptureController());
    session.subscribe((s) => {
      sessionState = s;
    });
    session.start();
  }
  return session;
}

/** Set the performer nickname: persisted locally always; announced to the
 * room (peer-update, A13) when a session is live. */
export function renameSelf(label: string): void {
  if (session) session.rename(label);
  else setNickname(label);
}

const EMPTY: CaptureSnapshot = {
  contextSampleRate: null,
  contextState: null,
  flags: null,
  stats: null,
  ring: null,
  peak: 0,
  localChunks: 0,
  finalSeq: null,
  error: null,
};

export function useCaptureSnapshot(): CaptureSnapshot {
  const subscribe = useCallback((onChange: () => void) => {
    return getCaptureController().subscribe(() => onChange());
  }, []);
  return useSyncExternalStore(subscribe, () => latest ?? EMPTY);
}

export function useRecorderSessionState(): RecorderSessionState | null {
  const subscribe = useCallback((onChange: () => void) => {
    if (!session) return () => {};
    return session.subscribe(() => onChange());
  }, []);
  return useSyncExternalStore(subscribe, () => sessionState);
}
