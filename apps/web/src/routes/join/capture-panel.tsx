// Capture device panel: mic enable, input picker, and the EC/NS/AGC flag
// badges — surfaced with pass/fail because iOS misreports these flags.

import type { CaptureSnapshot } from "../../audio/capture-controller";
import { Button, Panel, SectionLabel } from "../../components";
import { MicPicker } from "./mic-picker";

export function CapturePanel({
  snap,
  takeOpen,
  busy,
  onEnableMic,
}: {
  snap: CaptureSnapshot;
  takeOpen: boolean;
  busy: boolean;
  onEnableMic: () => void;
}) {
  const capturing = snap.contextSampleRate !== null;
  return (
    <Panel className="p-4">
      <SectionLabel>Capture</SectionLabel>
      {!capturing ? (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-[12px] leading-relaxed text-text-body">
            Antiphon records raw, unprocessed audio. Keep this screen on and the phone close to your
            voice.
          </p>
          <Button variant="accent" onClick={onEnableMic} disabled={busy}>
            {busy ? "Requesting microphone…" : "Enable microphone"}
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <MicPicker flags={snap.flags} locked={takeOpen} sampleRate={snap.contextSampleRate} />
          <div className="mt-1 grid grid-cols-3 gap-2">
            <FlagBadge label="echo cancel" value={snap.flags?.echoCancellation} />
            <FlagBadge label="noise supp" value={snap.flags?.noiseSuppression} />
            <FlagBadge label="auto gain" value={snap.flags?.autoGainControl} />
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-text-faint">
            All three must be OFF for a truthful recording. iOS may misreport — verify by ear via
            the local take below.
          </p>
        </div>
      )}
    </Panel>
  );
}

function FlagBadge({ label, value }: { label: string; value: boolean | string | undefined }) {
  const ok = value === false || value === "none"; // flags must be OFF
  return (
    <div className="flex flex-col items-center gap-1 rounded-md border border-edge bg-bg px-2 py-2">
      <span className="text-center font-mono text-[8px] tracking-[0.5px] text-text-faint uppercase">
        {label}
      </span>
      <span
        className={`font-mono text-[10px] font-bold ${
          ok ? "text-ok" : value === undefined ? "text-warn" : "text-rec"
        }`}
      >
        {ok ? "OFF" : value === undefined ? "N/A" : String(value).toUpperCase()}
      </span>
    </div>
  );
}
