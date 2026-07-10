// The desk's own hardware input card, hosted by the performers panel.

import { useState } from "react";
import { Avatar, SectionLabel, StatusPill, VUMeter } from "../../components";
import { initialsOf } from "./track-model";
import { type DeskInputState, getDeskInput } from "./use-desk-input";

/** Pick an interface/mic and run it as an embedded recorder lane (the room
 * reference mic). Device labels are blank until permission grants, so the
 * picker opens through a one-off probe. Enable/disable sit out rolling
 * takes: a lane must never appear or vanish mid-take. */
export function DeskInputBlock({
  sessionId,
  input,
  takeRolling,
  color,
}: {
  sessionId: string;
  input: DeskInputState;
  takeRolling: boolean;
  color: string | null;
}) {
  const [pickedId, setPickedId] = useState<string | null>(null);
  const mgr = getDeskInput(sessionId);

  if (input.phase === "off") {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          disabled={takeRolling}
          onClick={() => void (input.resumeLabel ? mgr.resume() : mgr.openPicker())}
          className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-edge-strong p-2.5 text-[11px] font-semibold text-text-dim hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          {input.resumeLabel ? "⏻ Resume desk input" : "+ Add desk input"}
          <span className="rounded border border-edge-strong px-1.5 py-px font-mono text-[9px]">
            MIC
          </span>
        </button>
        {input.resumeLabel && (
          <div className="flex items-baseline justify-between gap-2 px-1">
            <span className="truncate font-mono text-[9px] text-text-faint">
              {input.resumeLabel}
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
        {input.error && <p className="px-1 font-mono text-[9px] text-rec">{input.error}</p>}
      </div>
    );
  }

  if (input.phase === "picking" || input.phase === "starting") {
    const picked = input.devices.find((d) => d.id === pickedId) ?? input.devices[0];
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-edge-card bg-card p-2.5">
        <SectionLabel>Desk input</SectionLabel>
        <select
          aria-label="Desk input device"
          value={picked?.id ?? ""}
          onChange={(e) => setPickedId(e.target.value)}
          disabled={input.phase === "starting"}
          className="w-full rounded-md border border-edge-inset bg-bg px-2 py-1.5 text-[11px] text-text outline-none focus:border-accent"
        >
          {input.devices.length === 0 && <option value="">no inputs found</option>}
          {input.devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={!picked || takeRolling || input.phase === "starting"}
            onClick={() => {
              if (picked) void mgr.enable(picked);
            }}
            className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {input.phase === "starting" ? "Starting…" : "Use input"}
          </button>
          <button
            type="button"
            onClick={() => mgr.closePicker()}
            disabled={input.phase === "starting"}
            className="rounded-md border border-edge-strong px-3 py-1.5 text-[11px] font-semibold text-text hover:bg-card-hi disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
        {takeRolling && (
          <p className="font-mono text-[9px] text-text-faint">available between takes</p>
        )}
        {input.error && <p className="font-mono text-[9px] text-rec">{input.error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[7px] rounded-lg border border-edge-card bg-card-hi px-2.5 py-[9px]">
      <div className="flex items-center gap-2">
        <Avatar
          initials={initialsOf(input.laneLabel ?? undefined) ?? "RM"}
          color={color ?? "var(--color-accent)"}
          dot={
            input.unplugged
              ? "var(--color-warn)"
              : input.recording
                ? "var(--color-rec)"
                : "var(--color-ok)"
          }
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11.5px] font-semibold text-text-strong">
            {input.laneLabel ?? "Desk input"}
          </div>
          <div className="truncate font-mono text-[9.5px] text-text-dim">
            {input.input?.label}
            {input.sampleRate ? ` · ${(input.sampleRate / 1000).toFixed(1)} kHz` : ""}
          </div>
        </div>
        {/* An unplugged input is never "ready" — while a take rolls it
            records silence, which the warning line below spells out. */}
        <StatusPill tone={input.unplugged ? "warn" : input.recording ? "rec" : "ok"}>
          {input.unplugged ? "unplugged" : input.recording ? "recording" : "ready"}
        </StatusPill>
      </div>
      <VUMeter level={input.peak} />
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1">
          <CaptureFlagChip label="EC" value={input.flags?.echoCancellation} />
          <CaptureFlagChip label="NS" value={input.flags?.noiseSuppression} />
          <CaptureFlagChip label="AGC" value={input.flags?.autoGainControl} />
        </div>
        <button
          type="button"
          disabled={takeRolling}
          onClick={() => void mgr.disable()}
          title={takeRolling ? "Available between takes" : "Release this input"}
          className="flex-none font-mono text-[9px] font-semibold tracking-[0.5px] text-text-dim uppercase hover:text-rec disabled:cursor-not-allowed disabled:opacity-40"
        >
          disable
        </button>
      </div>
      {input.unplugged && (
        <p className="font-mono text-[9px] leading-relaxed text-warn">
          input unplugged — the lane records silence; swap or disable between takes
        </p>
      )}
      {input.error && <p className="font-mono text-[9px] text-rec">{input.error}</p>}
    </div>
  );
}

/** EC/NS/AGC honesty chip (desk-compact twin of the phone page badges):
 * all three must be OFF for a truthful recording. */
function CaptureFlagChip({ label, value }: { label: string; value: boolean | string | undefined }) {
  const off = value === false || value === "none";
  return (
    <span
      className={`rounded-[3px] border border-edge bg-bg px-1.5 py-px font-mono text-[8px] font-bold tracking-[0.5px] ${
        off ? "text-ok" : value === undefined ? "text-warn" : "text-rec"
      }`}
    >
      {label} {off ? "OFF" : value === undefined ? "—" : "ON"}
    </span>
  );
}
