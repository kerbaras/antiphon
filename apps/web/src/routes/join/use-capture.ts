// One CaptureController per page, bridged into React via
// useSyncExternalStore. Also exposes the dev/e2e hook (window.__antiphon).

import { useCallback, useSyncExternalStore } from "react";
import { CaptureController, type CaptureSnapshot } from "../../audio/capture-controller";

let controller: CaptureController | null = null;
let latest: CaptureSnapshot | null = null;

export function getCaptureController(): CaptureController {
  if (!controller) {
    controller = new CaptureController();
    controller.subscribe((snap) => {
      latest = snap;
    });
    (globalThis as Record<string, unknown>).__antiphon = {
      controller,
      snapshot: () => latest,
    };
  }
  return controller;
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
