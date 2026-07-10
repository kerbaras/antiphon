// Right-rail Sinks panel: per-stream desk↔server convergence diagnostics.

import type { DeskStreamStatus } from "../../audio/sink-worker-protocol";
import { authActive } from "../../net/auth-token";
import { downloadStreamFlac } from "../../net/stream-download";
import { MonoReadout, StatusPill } from "../../ui/kit";
import type { DriftResult } from "./player";
import type { ServerStreamStatus } from "./use-desk";

/** Plain-words decode of the drift readout, as a hover tooltip (QA low:
 * "c 0.00 · off" was cryptic). Exported for unit tests. */
export function driftTitle(drift: DriftResult): string {
  if (drift.isReference) {
    return "this stream is the drift reference — every other lane's clock is measured against it";
  }
  const ppm = `${drift.ppm >= 0 ? "+" : ""}${drift.ppm.toFixed(1)} ppm`;
  return [
    `clock-rate error vs the reference stream: ${ppm} (parts per million)`,
    `fit confidence ${drift.confidence.toFixed(2)} of 1`,
    drift.applied
      ? "correction applied at playback"
      : "correction off — confidence below the guard rail, played uncorrected",
  ].join(" · ");
}

/** Drift readout: clock-rate error vs the reference stream in ppm, with
 * the fit confidence — "off" marks a measurement the guard rails bypassed
 * (played uncorrected rather than wrongly corrected). */
function driftReadout(drift: DriftResult) {
  if (drift.isReference) return <span title={driftTitle(drift)}>reference</span>;
  const ppm = `${drift.ppm >= 0 ? "+" : ""}${drift.ppm.toFixed(1)} ppm`;
  const conf = `c ${drift.confidence.toFixed(2)}`;
  return (
    <span title={driftTitle(drift)} className={drift.applied ? undefined : "text-warn"}>
      {drift.applied ? `${ppm} · ${conf}` : `${ppm} · ${conf} · off`}
    </span>
  );
}

export function SinksPanel({
  deskStatus,
  serverStatus,
  driftByStream,
  orphanedStreams,
  laneNameOf,
}: {
  deskStatus: DeskStreamStatus[];
  serverStatus: Map<string, ServerStreamStatus>;
  driftByStream: Map<string, DriftResult>;
  /** A6-truncated streams (F9): terminally incomplete, never converging. */
  orphanedStreams: Set<string>;
  /** Stream → lane name (nickname when set) for the card label. */
  laneNameOf: (streamId: string) => string | undefined;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
      {deskStatus.length === 0 && (
        <p className="px-1 py-1 text-[11px] text-text-dim">No streams yet.</p>
      )}
      {deskStatus.map((desk) => {
        const server = serverStatus.get(desk.streamId);
        const drift = driftByStream.get(desk.streamId);
        const converged =
          desk.complete && (server?.complete ?? false) && desk.digest === server?.digest;
        const incomplete = orphanedStreams.has(desk.streamId);
        const lane = laneNameOf(desk.streamId);
        return (
          <div
            key={desk.streamId}
            data-sink-stream={desk.streamId}
            className="flex flex-col gap-1.5 rounded-lg border border-edge-card bg-card-hi px-2.5 py-[9px]"
          >
            <div className="flex items-center justify-between gap-2">
              {/* Lane name first (QA low: cards were raw-UUID-labeled);
                  the short stream id keeps the diagnostic identity. */}
              <span className="flex min-w-0 items-baseline gap-1.5" title={desk.streamId}>
                {lane && (
                  <span className="truncate text-[11px] font-semibold text-text-strong">
                    {lane}
                  </span>
                )}
                <span className="flex-none font-mono text-[9.5px] text-text-dim">
                  {desk.streamId.slice(0, 8)}
                </span>
              </span>
              {desk.flagged || server?.flagged ? (
                <StatusPill tone="rec">flagged</StatusPill>
              ) : incomplete ? (
                // Terminal by design (A6): the phone reloaded mid-take and
                // this stream's final length is undecidable — it will
                // never reconcile to "converged".
                <StatusPill tone="warn" className="flex-none">
                  ⚠ incomplete
                </StatusPill>
              ) : converged ? (
                <StatusPill tone="ok">⇥ converged</StatusPill>
              ) : (
                <StatusPill tone="warn">reconciling</StatusPill>
              )}
            </div>
            <MonoReadout
              label="desk chwm / held"
              value={`${desk.chwm ?? "—"} / ${desk.heldCount}`}
            />
            <MonoReadout
              label="server chwm / held"
              value={`${server?.chwm ?? "—"} / ${server?.chunkCount ?? 0}`}
            />
            <MonoReadout
              label="holes d·s"
              value={
                <span className={desk.holes.length || server?.holes.length ? "text-warn" : ""}>
                  {desk.holes.length} · {server?.holes.length ?? 0}
                </span>
              }
            />
            {desk.finalSeq !== null && <MonoReadout label="final seq" value={desk.finalSeq} />}
            {/* The mic behind this stream (W5-B): the seq-0 header's
                device description, as archived — with W4-F it carries the
                picked input's label. Absent = the archive holds none
                (pre-mic-metadata stream), so no line rather than a guess. */}
            {server?.deviceDesc && (
              <MonoReadout
                label="mic"
                value={
                  <span className="block max-w-[160px] truncate" title={server.deviceDesc}>
                    {server.deviceDesc}
                  </span>
                }
              />
            )}
            {drift && <MonoReadout label="drift" value={driftReadout(drift)} />}
            {incomplete && (
              <p className="font-mono text-[9px] leading-relaxed text-warn">
                truncated mid-take (recorder reloaded) — the captured audio is preserved, but no end
                marker ever arrived
              </p>
            )}
            {converged && (
              <a
                href={`/api/streams/${desk.streamId}/flac`}
                download
                onClick={(e) => {
                  // Auth mode: the export route is desk-gated (W8-A) and
                  // anchors can't carry the token — intercept and fetch.
                  // Keyless: authActive() is false, plain anchor as always.
                  if (authActive()) {
                    e.preventDefault();
                    void downloadStreamFlac(desk.streamId);
                  }
                }}
                className="self-start font-mono text-[10px] text-accent hover:underline"
              >
                ↓ download .flac
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
