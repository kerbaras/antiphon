// Right-rail Sinks panel: per-stream desk↔server convergence diagnostics.

import type { DeskStreamStatus } from "../../audio/sink-worker-protocol";
import { MonoReadout, StatusPill } from "../../ui/kit";
import type { DriftResult } from "./player";
import type { ServerStreamStatus } from "./use-desk";

/** Drift readout: clock-rate error vs the reference stream in ppm, with
 * the fit confidence — "off" marks a measurement the guard rails bypassed
 * (played uncorrected rather than wrongly corrected). */
function driftReadout(drift: DriftResult) {
  if (drift.isReference) return "reference";
  const ppm = `${drift.ppm >= 0 ? "+" : ""}${drift.ppm.toFixed(1)} ppm`;
  const conf = `c ${drift.confidence.toFixed(2)}`;
  return (
    <span className={drift.applied ? undefined : "text-warn"}>
      {drift.applied ? `${ppm} · ${conf}` : `${ppm} · ${conf} · off`}
    </span>
  );
}

export function SinksPanel({
  deskStatus,
  serverStatus,
  driftByStream,
}: {
  deskStatus: DeskStreamStatus[];
  serverStatus: Map<string, ServerStreamStatus>;
  driftByStream: Map<string, DriftResult>;
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
        return (
          <div
            key={desk.streamId}
            className="flex flex-col gap-1.5 rounded-lg border border-edge-card bg-card-hi px-2.5 py-[9px]"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[9.5px] text-text-dim">
                {desk.streamId.slice(0, 16)}…
              </span>
              {desk.flagged || server?.flagged ? (
                <StatusPill tone="rec">flagged</StatusPill>
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
            {drift && <MonoReadout label="drift" value={driftReadout(drift)} />}
            {converged && (
              <a
                href={`/api/streams/${desk.streamId}/flac`}
                download
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
