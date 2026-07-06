// Phone recorder — /join/:uuid. Mobile Safari is the hostile baseline.
// A performer-facing instrument panel in the reference design language:
// status pill, live VU, mono readouts, inset displays. Capture flags
// (EC/NS/AGC all OFF) are surfaced with pass/fail badges because iOS lies.

import { useState } from "react";
import { useParams } from "react-router";
import { randomId } from "../../audio/capture-controller";
import {
  Badge,
  Button,
  InsetDisplay,
  MonoReadout,
  Panel,
  RecDot,
  SectionLabel,
  StatusPill,
  VUMeter,
  Wordmark,
} from "../../ui/kit";
import {
  getCaptureController,
  joinSession,
  useCaptureSnapshot,
  useRecorderSessionState,
} from "./use-capture";

export function JoinRoute() {
  const { uuid } = useParams();
  const snap = useCaptureSnapshot();
  const sessionState = useRecorderSessionState();
  const [busy, setBusy] = useState(false);

  const state = snap.stats?.state ?? "idle";
  const capturing = snap.contextSampleRate !== null;
  const recording = state === "streaming";
  const inSession = sessionState !== null;

  const seconds =
    snap.stats && snap.stats.sampleRate > 0 ? snap.stats.samplesIn / snap.stats.sampleRate : 0;

  async function enableMic() {
    setBusy(true);
    try {
      await getCaptureController().start();
      if (uuid) joinSession(uuid);
    } finally {
      setBusy(false);
    }
  }

  function armLocal() {
    getCaptureController().arm({
      takeId: randomId(),
      streamId: randomId(),
      retainLocal: true,
    });
  }

  function stop() {
    getCaptureController().stopTake();
  }

  async function download() {
    const flac = await getCaptureController().exportLocalFlac();
    if (!flac) return;
    const url = URL.createObjectURL(new Blob([flac], { type: "audio/flac" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `antiphon-take-${Date.now()}.flac`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-3 p-4 pb-10">
      <header className="flex items-center justify-between border-b border-divider pb-3">
        <Wordmark />
        <div className="flex flex-col items-end leading-tight">
          <span className="text-[10px] text-text-dim">{uuid ? "session" : "rehearsal"}</span>
          <span className="font-mono text-[10px] text-text-mute">
            {uuid ? `${uuid.slice(0, 8)}…` : "no session"}
          </span>
        </div>
      </header>

      {/* Status hero */}
      <Panel className="p-4">
        <div className="flex items-center justify-between">
          <StatusPill
            tone={
              recording
                ? "rec"
                : state === "draining"
                  ? "warn"
                  : state === "closed"
                    ? "ok"
                    : capturing
                      ? "accent"
                      : "idle"
            }
          >
            {recording && <RecDot />}
            {!capturing
              ? "no mic"
              : state === "idle"
                ? "ready"
                : state === "streaming"
                  ? "recording"
                  : state === "closed"
                    ? "take saved"
                    : state}
          </StatusPill>
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

      {/* Capture device */}
      <Panel className="p-4">
        <SectionLabel>Capture</SectionLabel>
        {!capturing ? (
          <div className="mt-3 flex flex-col gap-3">
            <p className="text-[12px] leading-relaxed text-text-body">
              Antiphon records raw, unprocessed audio. Keep this screen on and the phone close to
              your voice.
            </p>
            <Button variant="accent" onClick={enableMic} disabled={busy}>
              {busy ? "Requesting microphone…" : "Enable microphone"}
            </Button>
            {snap.error && <p className="font-mono text-[10px] text-rec">{snap.error}</p>}
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="max-w-[60%] truncate text-[11px] text-text-mute">
                {snap.flags?.deviceLabel}
              </span>
              <span className="font-mono text-[10px] text-text-dim">
                {snap.contextSampleRate} Hz
              </span>
            </div>
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

      {/* Session transport: the desk drives takes; links carry the chunks */}
      {capturing && inSession && sessionState && (
        <Panel className="p-4">
          <div className="flex items-center justify-between">
            <SectionLabel>Session links</SectionLabel>
            <StatusPill tone={sessionState.signalingConnected ? "ok" : "warn"}>
              {sessionState.signalingConnected ? "joined" : "rejoining"}
            </StatusPill>
          </div>
          <div className="mt-3 flex flex-col gap-1.5">
            <LinkReadout label="server sink" state={sessionState.serverLink} />
            <LinkReadout label="desk sink" state={sessionState.deskLink} />
            {sessionState.activeTakeId && (
              <MonoReadout label="take" value={`${sessionState.activeTakeId.slice(0, 8)}…`} />
            )}
            {snap.stats?.sinks.map((s) => (
              <MonoReadout
                key={s.id}
                label={`sink ${s.id === 0 ? "server" : "desk"} settled`}
                value={
                  <span className={s.settled ? "text-ok" : undefined}>
                    {s.settled ? "yes" : "no"}
                  </span>
                }
              />
            ))}
          </div>
          {sessionState.outageUntil && (
            <p className="mt-2 font-mono text-[10px] text-rec">
              network outage simulated — capture continues
            </p>
          )}
          <Button
            variant="outline"
            className="mt-3 w-full"
            onClick={() => joinSession(uuid as string).simulateOutage(5_000)}
            disabled={sessionState.outageUntil !== null}
          >
            ⚡ Simulate 5s dropout
          </Button>
        </Panel>
      )}

      {/* Local rehearsal take (no session joined) */}
      {capturing && !inSession && (
        <Panel className="p-4">
          <div className="flex items-center justify-between">
            <SectionLabel>Local take</SectionLabel>
            <Badge>rehearsal</Badge>
          </div>
          <div className="mt-3 flex gap-2">
            {state === "idle" || state === "closed" ? (
              <Button variant="rec" className="flex-1" onClick={armLocal}>
                ● Record
              </Button>
            ) : (
              <Button
                variant="outline"
                className="flex-1"
                onClick={stop}
                disabled={state === "draining"}
              >
                ■ Stop
              </Button>
            )}
            <Button
              variant="outline"
              className="flex-1"
              onClick={download}
              disabled={snap.localChunks === 0 || recording}
            >
              ↓ FLAC
            </Button>
          </div>
        </Panel>
      )}

      {/* Diagnostics */}
      {capturing && (
        <Panel className="p-4">
          <SectionLabel>Diagnostics</SectionLabel>
          <div className="mt-3 flex flex-col gap-1.5">
            <MonoReadout label="take state" value={state} />
            <MonoReadout label="next seq" value={snap.stats?.nextSeq ?? 0} />
            <MonoReadout label="chunks retained" value={snap.stats?.ringChunks ?? 0} />
            <MonoReadout label="retransmit ring" value={formatBytes(snap.stats?.ringBytes ?? 0)} />
            <MonoReadout
              label="capture ring"
              value={
                snap.ring ? `${Math.round((snap.ring.depth / snap.ring.capacity) * 100)}%` : "—"
              }
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
              label="gaps declared"
              value={
                <span className={snap.stats?.gaps.length ? "text-rec" : undefined}>
                  {snap.stats?.gaps.length ?? 0}
                </span>
              }
            />
            {snap.finalSeq !== null && <MonoReadout label="final seq" value={snap.finalSeq} />}
          </div>
        </Panel>
      )}

      <p className="mt-auto pt-2 text-center font-mono text-[9px] text-text-faint">
        cross-origin isolated: {String(globalThis.crossOriginIsolated)}
      </p>
    </main>
  );
}

function LinkReadout({
  label,
  state,
}: {
  label: string;
  state: "connected" | "connecting" | "down" | "absent";
}) {
  const color =
    state === "connected"
      ? "text-ok"
      : state === "connecting"
        ? "text-warn"
        : state === "absent"
          ? "text-text-faint"
          : "text-rec";
  return <MonoReadout label={label} value={<span className={color}>{state}</span>} />;
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

function formatClock(seconds: number): string {
  const mm = Math.floor(seconds / 60);
  const ss = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(mm)}:${pad(ss)}:${pad(cs)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
