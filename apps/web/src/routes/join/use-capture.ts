// One CaptureController + one RecorderSession per page, bridged into React
// via useSyncExternalStore. Exposes the dev/e2e hook (window.__antiphon).

import { useCallback, useSyncExternalStore } from "react";
import { CaptureController, type CaptureSnapshot } from "../../audio/capture-controller";
import { setNickname } from "../../net/device-identity";
import { RecorderSession, type RecorderSessionState } from "../../net/recorder-session";
import { loadMicPreference } from "./mic-preference";

let controller: CaptureController | null = null;
let latest: CaptureSnapshot | null = null;
let session: RecorderSession | null = null;
let sessionState: RecorderSessionState | null = null;
/** React subscribers to the session store. Registered unconditionally (even
 * while `session` is null) so a session created AFTER a component mounted
 * still notifies it — the F10 bug was a memoized no-op unsubscribe that
 * never re-subscribed once joinSession created the session, leaving
 * dropout/outage UI frozen. */
const sessionListeners = new Set<() => void>();

function notifySessionListeners(): void {
  for (const l of sessionListeners) l();
}
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

/** Start the pipeline on the persisted mic (W4-F), falling back to the
 * default input when the saved device is gone — deviceIds rotate on iOS
 * Safari, and a stale preference must never cost a take. Must run inside
 * the user gesture (iOS). */
export async function startCapture(): Promise<void> {
  const ctl = getCaptureController();
  const pref = loadMicPreference();
  if (!pref) return ctl.start();
  try {
    await ctl.start({ deviceId: pref.deviceId });
  } catch (e) {
    // Permission denials aren't staleness — retrying would just re-prompt.
    if (e instanceof DOMException && e.name === "NotAllowedError") throw e;
    // Stale/rotated id (OverconstrainedError et al): default mic instead.
    // The preference itself is kept — the picker heals it by label once
    // the post-permission enumeration is in (see mic-picker.tsx).
    await ctl.start();
  }
}

/** Join the session (idempotent): transports come up; capture stays local
 * until the desk starts a take. */
export function joinSession(sessionId: string): RecorderSession {
  if (!session) {
    session = new RecorderSession(sessionId, getCaptureController());
    session.subscribe((s) => {
      sessionState = s;
      notifySessionListeners();
    });
    session.start();
  }
  return session;
}

/** Deliberate re-join after a fatal supersede (F3): the caller restarts the
 * capture pipeline (user gesture), then this reopens signaling — which
 * supersedes the tab that superseded us. Honest, explicit semantics. */
export function takeOverSession(): void {
  session?.takeOver();
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
  takeOpen: false,
};

export function useCaptureSnapshot(): CaptureSnapshot {
  const subscribe = useCallback((onChange: () => void) => {
    return getCaptureController().subscribe(() => onChange());
  }, []);
  return useSyncExternalStore(subscribe, () => latest ?? EMPTY);
}

export function useRecorderSessionState(): RecorderSessionState | null {
  // Subscribe to the module-level listener set, NOT to the session object:
  // the set outlives (and predates) the session, so a session created after
  // mount — joinSession runs from the "enable microphone" click — reaches
  // every already-mounted component (F10).
  const subscribe = useCallback((onChange: () => void) => {
    sessionListeners.add(onChange);
    return () => sessionListeners.delete(onChange);
  }, []);
  return useSyncExternalStore(subscribe, () => sessionState);
}
