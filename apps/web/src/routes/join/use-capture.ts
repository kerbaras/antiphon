// One CaptureController + one RecorderSession per page, bridged into React
// via useSyncExternalStore. Exposes the dev/e2e hook (window.__antiphon).

import { useCallback, useSyncExternalStore } from "react";
import { CaptureController, type CaptureSnapshot } from "../../audio/capture-controller";
import { RecorderSession, type RecorderSessionState } from "../../net/recorder-session";

let controller: CaptureController | null = null;
let latest: CaptureSnapshot | null = null;
let session: RecorderSession | null = null;
let sessionState: RecorderSessionState | null = null;
let lastReportedFinal: number | null = null;

export function getCaptureController(): CaptureController {
  if (!controller) {
    controller = new CaptureController();
    controller.subscribe((snap) => {
      latest = snap;
      // The worker reported a final seq: tell the sinks via control plane.
      if (snap.finalSeq !== null && snap.finalSeq !== lastReportedFinal) {
        lastReportedFinal = snap.finalSeq;
        session?.notifyFinal(snap.finalSeq);
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
