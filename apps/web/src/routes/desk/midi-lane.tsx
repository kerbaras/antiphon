// Slim MIDI lane: piano-roll-lite under the audio rows when the selected
// take captured MIDI. One 28px row, note rects banded by pitch, no editing;
// the rects are inert so clicks fall through to the timeline's seek surface.

import { Badge } from "../../components";
import { hexA, laneGridStyle, TRACK_HEADER_W } from "./daw";
import type { NoteSpan } from "./midi";

export const MIDI_LANE_H = 28;

export interface MidiLaneModel {
  notes: NoteSpan[];
  eventCount: number;
  /** Take-timeline → arrangement drawing offset (timelineBaseSec). */
  baseSec: number;
  /** Fallback right edge for never-released notes (take duration). */
  durationSec: number;
  color: string;
  /** The stored capture hit the event cap — surface the truncation. */
  overflow: boolean;
}

export function MidiLaneRow({
  lane,
  pxPerSec,
  laneWidth,
}: {
  lane: MidiLaneModel;
  pxPerSec: number;
  laneWidth: number;
}) {
  // Pitch band: map the used range (≥ 2 octaves so sparse parts don't
  // explode vertically) onto the row, 2px per note rect.
  const notes = lane.notes;
  const lo = Math.min(...notes.map((n) => n.note), 127);
  const hi = Math.max(...notes.map((n) => n.note), 0);
  const mid = (lo + hi) / 2;
  const span = Math.max(hi - lo, 24);
  const bandLo = Math.max(0, mid - span / 2);
  const pad = 3;
  const usable = MIDI_LANE_H - 2 * pad - 2;
  const yOf = (note: number) => pad + (1 - (note - bandLo) / span) * usable;

  return (
    // Row seam on the CHILDREN, not the wrapper (timeline.tsx TimelineRow's
    // rule): the header's seam must paint inside its z-[5] layer or the
    // full-height overlays bleed 1px through it in the header band.
    <div className="flex" style={{ height: MIDI_LANE_H }}>
      {/* data-lane-header: the tracks-band contract (pinned by
          timeline-header-band.spec.ts) recognizes band chrome by this
          attribute. "midi" can't collide with the audio rows' peer/stream keys. */}
      <div
        data-lane-header="midi"
        className="sticky left-0 z-[5] flex flex-none items-stretch border-r border-b border-divider border-b-[#0e0f10] bg-card"
        style={{ width: TRACK_HEADER_W }}
      >
        <div className="w-1 flex-none" style={{ background: lane.color }} />
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2">
          <span className="truncate text-[10.5px] font-semibold text-text-strong">MIDI</span>
          <Badge className="flex-none">midi</Badge>
          {lane.overflow && (
            <span
              title="event cap reached during capture — earliest kept"
              className="flex-none font-mono text-[8px] font-bold text-warn"
            >
              capped
            </span>
          )}
          <span
            title="data lane — no playback; export to your DAW"
            className="ml-auto flex-none font-mono text-[8.5px] text-text-faint"
          >
            {lane.eventCount} ev
          </span>
        </div>
      </div>
      <div
        data-midi-lane
        className="relative border-b border-[#0e0f10] bg-lane"
        style={{ width: laneWidth, ...laneGridStyle(pxPerSec) }}
      >
        {notes.map((n, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: spans are static per take
            key={i}
            data-midi-note={n.note}
            className="pointer-events-none absolute h-[2px] rounded-[1px]"
            style={{
              left: (lane.baseSec + n.startSec) * pxPerSec,
              width: Math.max(
                2,
                (Math.max(n.endSec ?? lane.durationSec, n.startSec) - n.startSec) * pxPerSec,
              ),
              top: yOf(n.note),
              background: hexA(lane.color, 0.9),
            }}
          />
        ))}
      </div>
    </div>
  );
}
