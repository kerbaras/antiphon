// Take loading: the latest-wins load queue (the player decodes one take at
// a time) and the persisted-alignment timeline hook.

import { DEFAULT_CHIRP_SPEC } from "@antiphon/protocol";
import { useEffect, useState } from "react";
import { readTakeAlignment, restoreTakeAlignment } from "./alignment-persist";
import { cacheWaveform, getDeskCollab, getDeskSession, getPlayer } from "./desk-state";
import { LoadQueue } from "./load-queue";
import { type AlignShifts, persistedAlignShifts } from "./timeline-math";
import { SAMPLE_RATE } from "./track-model";

/** Every take with a persisted verdict draws aligned, not just the loaded
 * one: materializes takeId → AlignShifts from the shared doc's alignment
 * map and refreshes when any verdict lands — local settles and remote
 * desks' runs alike. Lags convert at the capture rate; the loaded take
 * should prefer the player's live alignShifts (the caller owns that
 * override). `takeIdsKey`: comma-joined take ids (stable-string dep). */
export function useTakeAlignShifts(
  sessionId: string,
  takeIdsKey: string,
): Map<string, AlignShifts> {
  const [shifts, setShifts] = useState<Map<string, AlignShifts>>(new Map());
  useEffect(() => {
    const collab = getDeskCollab(sessionId);
    const spec = DEFAULT_CHIRP_SPEC;
    const recompute = () => {
      const next = new Map<string, AlignShifts>();
      for (const takeId of takeIdsKey ? takeIdsKey.split(",") : []) {
        const entries = readTakeAlignment(collab, sessionId, takeId);
        if (!entries) continue;
        const composed = persistedAlignShifts(
          entries,
          SAMPLE_RATE,
          (spec.durationMs + spec.gapMs) / 1_000,
        );
        // Declined-only verdicts compose nothing — same as no verdict.
        if (composed.shiftSec.size > 0) next.set(takeId, composed);
      }
      setShifts(next);
    };
    recompute();
    const map = collab.doc.getMap("alignment");
    const observer = () => recompute();
    map.observe(observer);
    return () => map.unobserve(observer);
  }, [sessionId, takeIdsKey]);
  return shifts;
}

/** Load a take into the player from the desk's OPFS store (idempotent).
 * `channelOf` maps streams to mixer lanes so strip state follows the
 * performer, not the take. */
export async function loadTakeIntoPlayer(
  sessionId: string,
  takeId: string,
  streamIds: string[],
  channelOf?: (streamId: string) => string,
): Promise<boolean> {
  const desk = getDeskSession(sessionId);
  const ok = await getPlayer().load(
    takeId,
    streamIds,
    (t, s) => desk.assembleFlac(t, s),
    channelOf,
  );
  // The player just decoded these — keep their waveforms forever.
  for (const track of getPlayer().snapshot().tracks) {
    if (track.waveform.length > 0) cacheWaveform(track.streamId, track.waveform);
  }
  return ok;
}

export interface TakeLoadRequest {
  sessionId: string;
  takeId: string;
  streamIds: string[];
  /** Stream → mixer-lane mapping, resolved at load time (attribution may
   * land after the request is queued). */
  channelOf: (streamId: string) => string;
  /** Auto-align after a successful load (chirp first, content fallback —
   * see player.align). Skipped when a persisted verdict already restored. */
  align: boolean;
  /** FORCE-align these streams after the load (persisted verdicts restore
   * first, so a scoped run keeps its out-of-scope anchors). Takes
   * precedence over `align`. */
  forceAlignScope?: readonly string[];
  /** "ok" = loaded (+aligned); "superseded" = a newer request replaced
   * this one (must not be awaited further); "failed" = the load failed
   * (error already on the transport strip). */
  onSettled?: (status: "ok" | "superseded" | "failed") => void;
}

// A pick landing while another load is in flight must not be dropped: the
// newest selection always loads eventually, intermediate picks collapse
// away, and alignment is skipped for a load already superseded.
const takeLoadQueue = new LoadQueue<TakeLoadRequest>(
  async (req, superseded) => {
    const ok = await loadTakeIntoPlayer(req.sessionId, req.takeId, req.streamIds, req.channelOf);
    if (!ok || superseded()) {
      req.onSettled?.(ok ? "superseded" : "failed");
      return;
    }
    // A persisted verdict reapplies BEFORE any auto-align — restored
    // tracks satisfy align()'s idempotence check, and a scoped FORCE run
    // chains onto the restored out-of-scope anchors.
    restoreTakeAlignment(getDeskCollab(req.sessionId), getPlayer(), req.sessionId, req.takeId);
    if (req.forceAlignScope) {
      await getPlayer().align(true, req.forceAlignScope);
    } else if (req.align) {
      await getPlayer().align();
    }
    req.onSettled?.(superseded() ? "superseded" : "ok");
  },
  (error, req) => {
    // A stuck selection must never be silent.
    getPlayer().reportError(
      `take ${req.takeId.slice(0, 8)} load failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    req.onSettled?.("failed");
  },
  // Replaced while still pending: same as a mid-run supersession.
  (req) => req.onSettled?.("superseded"),
);

/** Load the selected take through the latest-wins queue. */
export function requestTakeLoad(req: TakeLoadRequest): void {
  takeLoadQueue.request(req);
}
