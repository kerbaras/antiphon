// Status hero: state pill, running clock, live VU.

import type { CaptureSnapshot } from "../../audio/capture-controller";
import { InsetDisplay, Panel, type PillTone, RecDot, StatusPill, VUMeter } from "../../components";
import { formatClock } from "./timecode";

function statusTone(sittingOut: boolean, capturing: boolean, state: string): PillTone {
  if (sittingOut) return "warn";
  if (state === "streaming") return "rec";
  if (state === "draining") return "warn";
  if (state === "closed") return "ok";
  if (capturing) return "accent";
  return "idle";
}

function statusLabel(sittingOut: boolean, capturing: boolean, state: string): string {
  if (sittingOut) return "sitting out (desk disarmed)";
  if (!capturing) return "no mic";
  if (state === "idle") return "ready";
  if (state === "streaming") return "recording";
  if (state === "closed") return "take saved";
  return state;
}

export function StatusPanel({ snap, sittingOut }: { snap: CaptureSnapshot; sittingOut: boolean }) {
  const state = snap.stats?.state ?? "idle";
  const capturing = snap.contextSampleRate !== null;
  const seconds =
    snap.stats && snap.stats.sampleRate > 0 ? snap.stats.samplesIn / snap.stats.sampleRate : 0;

  return (
    <Panel className="p-4">
      <div className="flex items-center justify-between">
        {/* aria-live on the pill only (not the running clock beside it):
            performers hear take start/stop without looking. */}
        <span aria-live="polite">
          <StatusPill tone={statusTone(sittingOut, capturing, state)}>
            {state === "streaming" && <RecDot />}
            {statusLabel(sittingOut, capturing, state)}
          </StatusPill>
        </span>
        <InsetDisplay className="px-3 py-1">
          <span className="font-mono text-[15px] font-semibold tracking-[1px] text-text-hi">
            {formatClock(seconds)}
          </span>
        </InsetDisplay>
      </div>
      <VUMeter level={snap.peak} className="mt-4" />
      <div className="mt-2 flex justify-between font-mono text-[9px] text-text-faint">
        <span>−∞</span>
        <span>−12</span>
        <span>0 dB</span>
      </div>
    </Panel>
  );
}
