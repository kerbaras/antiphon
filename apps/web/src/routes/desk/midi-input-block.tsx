// The desk's MIDI input card, hosted by the performers panel next to the
// desk audio input — same enable/resume UX, no audio path behind it.

import { useState } from "react";
import { Avatar, SectionLabel, StatusPill } from "../../components";
import { MIDI_EVENT_CAP } from "./midi";
import { initialsOf } from "./track-model";
import { type DeskMidiState, getDeskMidi } from "./use-desk-midi";

/** Permission probe → input picker → armed lane. While a take rolls the
 * lane timestamps channel messages into the take; it is a DATA lane —
 * playback stays silent, the payoff is the .mid export. Enable/disable
 * sit out rolling takes: lanes never appear mid-take. */
export function MidiInputBlock({
  sessionId,
  midi,
  takeRolling,
  color,
}: {
  sessionId: string;
  midi: DeskMidiState;
  takeRolling: boolean;
  color: string;
}) {
  const [pickedId, setPickedId] = useState<string | null>(null);
  const mgr = getDeskMidi(sessionId);

  if (midi.phase === "off") {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          disabled={takeRolling}
          onClick={() => void (midi.resumeLabel ? mgr.resume() : mgr.openPicker())}
          className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-edge-strong p-2.5 text-[11px] font-semibold text-text-dim hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          {midi.resumeLabel ? "⏻ Resume MIDI input" : "+ Add MIDI input"}
          <span className="rounded border border-edge-strong px-1.5 py-px font-mono text-[9px]">
            MIDI
          </span>
        </button>
        {midi.resumeLabel && (
          <div className="flex items-baseline justify-between gap-2 px-1">
            <span className="truncate font-mono text-[9px] text-text-faint">
              {midi.resumeLabel}
            </span>
            <button
              type="button"
              onClick={() => void mgr.openPicker()}
              className="flex-none font-mono text-[9px] text-text-dim hover:text-accent"
            >
              change
            </button>
          </div>
        )}
        {midi.error && <p className="px-1 font-mono text-[9px] text-rec">{midi.error}</p>}
      </div>
    );
  }

  if (midi.phase === "picking") {
    const picked = midi.inputs.find((d) => d.id === pickedId) ?? midi.inputs[0];
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-edge-card bg-card p-2.5">
        <SectionLabel>MIDI input</SectionLabel>
        <select
          aria-label="MIDI input device"
          value={picked?.id ?? ""}
          onChange={(e) => setPickedId(e.target.value)}
          className="w-full rounded-md border border-edge-inset bg-bg px-2 py-1.5 text-[11px] text-text outline-none focus:border-accent"
        >
          {midi.inputs.length === 0 && <option value="">no MIDI inputs found</option>}
          {midi.inputs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={!picked || takeRolling}
            onClick={() => {
              if (picked) mgr.enable(picked);
            }}
            className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Use input
          </button>
          <button
            type="button"
            onClick={() => mgr.closePicker()}
            className="rounded-md border border-edge-strong px-3 py-1.5 text-[11px] font-semibold text-text hover:bg-card-hi"
          >
            Cancel
          </button>
        </div>
        {takeRolling && (
          <p className="font-mono text-[9px] text-text-faint">available between takes</p>
        )}
        {midi.error && <p className="font-mono text-[9px] text-rec">{midi.error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[7px] rounded-lg border border-edge-card bg-card-hi px-2.5 py-[9px]">
      <div className="flex items-center gap-2">
        <Avatar
          initials={initialsOf(midi.input?.label) ?? "MI"}
          color={color}
          dot={midi.capturing ? "var(--color-rec)" : "var(--color-ok)"}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11.5px] font-semibold text-text-strong">
            {midi.input?.label ?? "MIDI input"}
          </div>
          <div className="truncate font-mono text-[9.5px] text-text-dim">
            data lane — export to your DAW
          </div>
        </div>
        <StatusPill tone={midi.capturing ? "rec" : "ok"}>
          {midi.capturing ? "capturing" : "ready"}
        </StatusPill>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[9px] text-text-faint">
          {midi.capturing ? `${midi.liveEventCount} events this take` : "events land on record"}
        </span>
        <button
          type="button"
          disabled={takeRolling}
          onClick={() => mgr.disable()}
          title={takeRolling ? "Available between takes" : "Release this input"}
          className="flex-none font-mono text-[9px] font-semibold tracking-[0.5px] text-text-dim uppercase hover:text-rec disabled:cursor-not-allowed disabled:opacity-40"
        >
          disable
        </button>
      </div>
      {midi.overflowed && (
        <p className="font-mono text-[9px] leading-relaxed text-warn">
          event cap reached ({MIDI_EVENT_CAP.toLocaleString()}) — earliest kept, later dropped
        </p>
      )}
      {midi.unplugged && (
        <p className="font-mono text-[9px] leading-relaxed text-warn">
          input unplugged — no events until it returns; swap or disable between takes
        </p>
      )}
      {midi.error && <p className="font-mono text-[9px] text-rec">{midi.error}</p>}
    </div>
  );
}
