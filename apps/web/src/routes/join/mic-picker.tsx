// Phone mic picker: a styled NATIVE select (on a phone the OS wheel/sheet
// beats any custom dropdown) that switches the live pipeline on change.
// Locked while a take is open — a mid-take swap would corrupt continuity.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CaptureFlags } from "../../audio/capture-controller";
import {
  loadMicPreference,
  type MicDeviceOption,
  matchMicPreference,
  saveMicPreference,
} from "./mic-preference";
import { getCaptureController } from "./use-capture";

/** Audio inputs, refreshed on devicechange. Only meaningful post-grant
 * (labels are blank until getUserMedia is granted). */
function useAudioInputs(active: boolean): MicDeviceOption[] {
  const [devices, setDevices] = useState<MicDeviceOption[]>([]);
  useEffect(() => {
    if (!active) return;
    const media = navigator.mediaDevices;
    // Optional-chained twice over: older iOS exposes mediaDevices without
    // the EventTarget interface; enumeration then still works, minus live
    // refresh.
    if (!media?.enumerateDevices) return;
    let cancelled = false;
    const refresh = () => {
      void media.enumerateDevices().then((all) => {
        if (cancelled) return;
        setDevices(
          all
            .filter((d) => d.kind === "audioinput")
            .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
        );
      });
    };
    refresh();
    media.addEventListener?.("devicechange", refresh);
    return () => {
      cancelled = true;
      media.removeEventListener?.("devicechange", refresh);
    };
  }, [active]);
  return devices;
}

/** How long a failed-switch note lingers before clearing itself. */
const SWITCH_FAILED_TTL_MS = 6_000;

export function MicPicker({
  flags,
  locked,
  sampleRate,
}: {
  flags: CaptureFlags | null;
  /** A take is open (armed/streaming/draining) — switching is refused. */
  locked: boolean;
  /** Context rate readout, rendered inline so it aligns with the select. */
  sampleRate: number | null;
}) {
  const devices = useAudioInputs(flags !== null);
  const [switching, setSwitching] = useState(false);
  const [failed, setFailed] = useState(false);
  const healedRef = useRef(false);
  const noteId = useId();

  const switchTo = useCallback(async (device: MicDeviceOption): Promise<void> => {
    setSwitching(true);
    setFailed(false);
    try {
      await getCaptureController().switchDevice(device.id);
      saveMicPreference({ deviceId: device.id, label: device.label });
    } catch {
      // The previous stream keeps running (the controller never trades a
      // working mic for a broken one), so the select — whose value derives
      // from the LIVE flags — snaps back on its own.
      setFailed(true);
    } finally {
      setSwitching(false);
    }
  }, []);

  // The failure note is brief: it self-clears, like the transient strip.
  useEffect(() => {
    if (!failed) return;
    const timer = window.setTimeout(() => setFailed(false), SWITCH_FAILED_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [failed]);

  // Heal a rotated deviceId once per page (iOS Safari re-mints ids): the
  // saved id failed at start (we're on the default mic) but an input with
  // the SAME LABEL is in the list → silently move to it and re-persist the
  // fresh id. Skipped while a take is open — the lock outranks preference.
  useEffect(() => {
    if (healedRef.current || locked || switching || flags?.deviceId === undefined) return;
    if (devices.length === 0) return;
    healedRef.current = true;
    const pref = loadMicPreference();
    if (!pref) return;
    const match = matchMicPreference(pref, devices);
    if (!match) {
      // Dead preference (device gone, label matches nothing): re-persist
      // the live input so future starts stop paying a doomed exact-id
      // getUserMedia on every visit.
      saveMicPreference({ deviceId: flags.deviceId, label: flags.deviceLabel });
      return;
    }
    if (match.id === flags.deviceId) {
      // Already on the right mic — refresh the stored id if it rotated.
      if (pref.deviceId !== match.id) {
        saveMicPreference({ deviceId: match.id, label: match.label });
      }
      return;
    }
    void switchTo(match);
  }, [devices, flags?.deviceId, flags?.deviceLabel, locked, switching, switchTo]);

  const hz = <span className="flex-none font-mono text-[10px] text-text-dim">{sampleRate} Hz</span>;

  // One input: nothing to pick — collapse to the static device label.
  if (devices.length < 2) {
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 flex-1 truncate text-[11px] text-text-mute">
          {flags?.deviceLabel}
        </span>
        {hz}
      </div>
    );
  }

  const currentId = devices.find((d) => d.id === flags?.deviceId)?.id ?? "";
  const disabled = locked || switching;
  const note = locked
    ? "Mic locked while a take is rolling — switch between takes."
    : failed
      ? `Couldn't switch — still using ${flags?.deviceLabel ?? "the current input"}.`
      : null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <div className="relative min-w-0 flex-1">
          <select
            aria-label="Microphone"
            aria-describedby={note !== null ? noteId : undefined}
            title={locked ? "Mic switching is locked while a take is open" : "Switch microphone"}
            value={currentId}
            disabled={disabled}
            onChange={(e) => {
              const device = devices.find((d) => d.id === e.target.value);
              if (device) void switchTo(device);
            }}
            className="w-full appearance-none truncate rounded-md border border-edge-inset bg-bg py-1.5 pr-7 pl-3 font-mono text-[11px] font-medium text-text-strong outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            {/* The live device should always be in the list; if enumeration
                lags a switch, an inert placeholder keeps the value honest. */}
            {currentId === "" && (
              <option value="" disabled>
                {flags?.deviceLabel ?? "current input"}
              </option>
            )}
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[8px] text-text-faint"
          >
            ▼
          </span>
        </div>
        {hz}
      </div>
      {note !== null && (
        <p
          id={noteId}
          className={`text-[10px] leading-relaxed ${locked ? "text-text-faint" : "text-warn"}`}
        >
          {note}
        </p>
      )}
    </div>
  );
}
