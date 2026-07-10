// Capture diagnostics readouts.

import type { CaptureSnapshot } from "../../audio/capture-controller";
import { MonoReadout, Panel, SectionLabel } from "../../components";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function DiagnosticsPanel({ snap }: { snap: CaptureSnapshot }) {
  const state = snap.stats?.state ?? "idle";
  return (
    <Panel className="p-4">
      <SectionLabel>Diagnostics</SectionLabel>
      <div className="mt-3 flex flex-col gap-1.5">
        <MonoReadout label="take state" value={state} />
        <MonoReadout label="next seq" value={snap.stats?.nextSeq ?? 0} />
        <MonoReadout label="chunks retained" value={snap.stats?.ringChunks ?? 0} />
        <MonoReadout label="retransmit ring" value={formatBytes(snap.stats?.ringBytes ?? 0)} />
        <MonoReadout
          label="capture ring"
          value={snap.ring ? `${Math.round((snap.ring.depth / snap.ring.capacity) * 100)}%` : "—"}
        />
        <MonoReadout
          label="dropped samples"
          value={
            <span className={snap.ring?.droppedSamples ? "text-rec" : undefined}>
              {snap.ring?.droppedSamples ?? 0}
            </span>
          }
        />
        <MonoReadout
          label="empty quanta"
          value={
            <span className={snap.ring?.emptyQuanta ? "text-warn" : undefined}>
              {snap.ring?.emptyQuanta ?? 0}
            </span>
          }
        />
        <MonoReadout
          label="gaps declared"
          value={
            <span className={snap.stats?.gaps.length ? "text-rec" : undefined}>
              {snap.stats?.gaps.length ?? 0}
            </span>
          }
        />
        {snap.finalSeq !== null && <MonoReadout label="final seq" value={snap.finalSeq} />}
        <MonoReadout label="cross-origin isolated" value={String(globalThis.crossOriginIsolated)} />
      </div>
    </Panel>
  );
}
