// Phone recorder — /join/:uuid. Mobile Safari is the hostile baseline.
// A performer-facing instrument panel in the reference design language:
// status pill, live VU, mono readouts, inset displays. Capture flags
// (EC/NS/AGC all OFF) are surfaced with pass/fail badges because iOS lies.

import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { randomId } from "../../audio/capture-controller";
import { getNickname, NICKNAME_MAX_LENGTH, normalizeNickname } from "../../net/device-identity";
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
import { MicPicker } from "./mic-picker";
import { useSessionExistence } from "./session-existence";
import { formatClock } from "./timecode";
import {
  getCaptureController,
  joinSession,
  renameSelf,
  startCapture,
  takeOverSession,
  useCaptureSnapshot,
  useRecorderSessionState,
} from "./use-capture";

export function JoinRoute() {
  const { uuid } = useParams();
  const snap = useCaptureSnapshot();
  const sessionState = useRecorderSessionState();
  const [busy, setBusy] = useState(false);

  // F19: probe session existence on load. Once joined, the live roster
  // beats the HTTP probe — a desk in the room (or a rolling take) confirms
  // the session and latches the verdict.
  const deskSeen =
    sessionState !== null &&
    sessionState.fatal === null &&
    (sessionState.deskLink !== "absent" || sessionState.activeTakeId !== null);
  const existence = useSessionExistence(uuid ?? null, deskSeen);

  const state = snap.stats?.state ?? "idle";
  const capturing = snap.contextSampleRate !== null;
  const recording = state === "streaming";
  const inSession = sessionState !== null;
  // A take is open for this stream (W4-F picker lock). snap.takeOpen is
  // the controller's SYNCHRONOUS latch (set the instant arm() is invoked,
  // held through draining) — never the ~250ms-lagged worker stats, which
  // would leave the picker enabled into a rolling take (QA F1). The
  // session's activeTakeId is belt-and-braces for the signaling window.
  const takeOpen = snap.takeOpen || (sessionState?.activeTakeId ?? null) !== null;

  const seconds =
    snap.stats && snap.stats.sampleRate > 0 ? snap.stats.samplesIn / snap.stats.sampleRate : 0;

  async function enableMic() {
    setBusy(true);
    try {
      await startCapture();
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

  async function takeOver() {
    setBusy(true);
    try {
      // Deliberate supersede-back: re-acquire the mic (this click is the
      // required user gesture), then reopen signaling under our identity —
      // the other tab gets the fatal this tab just lived through.
      await startCapture();
      takeOverSession();
    } finally {
      setBusy(false);
    }
  }

  // Terminal state (F3): a fatal control error killed this connection for
  // good. No reconnect loop is running, capture is stopped, the mic is
  // released. Render the fact, not a transient error strip.
  if (sessionState?.fatal) {
    const fatal = sessionState.fatal;
    const superseded = fatal.code === "superseded";
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-3 p-4 pb-10">
        <header className="flex items-center justify-between border-b border-divider pb-3">
          <Wordmark />
          <div className="flex flex-col items-end leading-tight">
            <span className="text-[10px] text-text-dim">session</span>
            <span className="font-mono text-[10px] text-text-mute">
              {uuid ? `${uuid.slice(0, 8)}…` : "no session"}
            </span>
          </div>
        </header>
        <Panel className="p-4">
          <div className="flex items-center justify-between">
            <SectionLabel>Session</SectionLabel>
            <StatusPill tone="warn">disconnected</StatusPill>
          </div>
          <p role="alert" className="mt-3 text-[13px] leading-relaxed text-text-body">
            {superseded
              ? "This device reconnected in another tab — this tab has been disconnected."
              : fatal.message}
          </p>
          <MonoReadout className="mt-3" label="reason" value={fatal.code} />
          <MonoReadout label="microphone" value="released" />
          {superseded && (
            <>
              <Button variant="accent" className="mt-4 w-full" onClick={takeOver} disabled={busy}>
                {busy ? "Taking over…" : "Take over in this tab"}
              </Button>
              <p className="mt-2 text-[10px] leading-relaxed text-text-faint">
                Taking over re-joins the session from this tab — and disconnects the other one.
              </p>
            </>
          )}
        </Panel>
      </main>
    );
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

      {/* Non-fatal errors: dismissible, self-expiring (F3 strip hygiene) */}
      <TransientError message={snap.error} />

      {/* F19: honest existence state — warn, never gate. The probe keeps
          rechecking gently, so a desk opening the link moments later
          clears this on its own. */}
      {uuid && existence === "absent" && <SessionNotFound sessionId={uuid} />}

      {/* Performer identity: the name the desk sees on this lane */}
      <PerformerPanel deskLabel={sessionState?.label ?? null} />

      {/* Status hero */}
      <Panel className="p-4">
        <div className="flex items-center justify-between">
          {/* aria-live on the pill only (not the running clock beside it):
              performers hear take start/stop without looking. */}
          <span aria-live="polite">
            <StatusPill
              tone={
                sessionState?.sittingOut
                  ? "warn"
                  : recording
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
              {sessionState?.sittingOut
                ? "sitting out (desk disarmed)"
                : !capturing
                  ? "no mic"
                  : state === "idle"
                    ? "ready"
                    : state === "streaming"
                      ? "recording"
                      : state === "closed"
                        ? "take saved"
                        : state}
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
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {/* Single input: static label. Several: the switch (W4-F).
                Owns the whole row incl. the Hz readout, so the readout
                stays centered on the select line when the lock note adds
                a second line below. */}
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
            <MonoReadout
              label="cross-origin isolated"
              value={String(globalThis.crossOriginIsolated)}
            />
          </div>
        </Panel>
      )}
    </main>
  );
}

/** F19: the join page used to render normally for a made-up session id and
 * let you enable the mic into a void. This panel is the honest state: the
 * probe found no trace of the session (no desk ever opened it, no takes).
 * Deliberately NOT a gate — the desk may create it moments later (the
 * probe keeps polling), and capture never depends on the network. */
function SessionNotFound({ sessionId }: { sessionId: string }) {
  return (
    <Panel className="p-4">
      <div className="flex items-center justify-between">
        <SectionLabel>Session</SectionLabel>
        <StatusPill tone="warn">not found</StatusPill>
      </div>
      <p role="status" className="mt-3 text-[13px] leading-relaxed text-text-body">
        This session doesn't exist (yet) — check the invite link.
      </p>
      <InsetDisplay className="mt-3 px-3 py-1.5">
        <span className="font-mono text-[10px] break-all text-text-mute">{sessionId}</span>
      </InsetDisplay>
      <p className="mt-2 text-[10px] leading-relaxed text-text-faint">
        If the desk is being set up right now, this clears by itself in a few seconds — we keep
        checking. You can still enable the microphone and wait; nothing records until the desk
        starts a take.
      </p>
    </Panel>
  );
}

/** Nickname display + edit (A13). Persisted on the phone, prefilled on
 * return visits, sent on hello, live-renameable while connected. A desk
 * rename lands here too (`deskLabel` mirrors the session's view of us). */
function PerformerPanel({ deskLabel }: { deskLabel: string | null }) {
  const [name, setName] = useState(() => getNickname() ?? "");
  const [draft, setDraft] = useState<string | null>(null); // null = not editing
  const editing = draft !== null;

  // Adopt desk-initiated renames unless the user is mid-edit.
  useEffect(() => {
    if (deskLabel !== null && !editing) setName(deskLabel);
  }, [deskLabel, editing]);

  function commit() {
    if (draft === null) return;
    // Commit-time cap (QA LOW): the input's maxLength is decorative for
    // paste/programmatic writes — the model normalizes (trim + 48).
    const trimmed = normalizeNickname(draft);
    renameSelf(trimmed);
    setName(trimmed);
    setDraft(null);
  }

  return (
    <Panel className="p-4">
      <div className="flex items-center justify-between">
        <SectionLabel>Performer</SectionLabel>
        {!editing && (
          <button
            type="button"
            onClick={() => setDraft(name)}
            className="font-mono text-[10px] font-semibold tracking-[0.5px] text-accent uppercase hover:brightness-110"
          >
            ✎ edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="mt-2.5 flex items-stretch gap-2">
          <input
            // biome-ignore lint/a11y/noAutofocus: user explicitly opened the editor
            autoFocus
            value={draft}
            maxLength={NICKNAME_MAX_LENGTH}
            placeholder="Your name"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setDraft(null);
            }}
            className="min-w-0 flex-1 rounded-md border border-edge-inset bg-bg px-3 py-1.5 font-mono text-[14px] font-semibold text-text-hi outline-none focus:border-accent"
          />
          <Button variant="accent" className="px-3 py-1.5" onClick={commit}>
            Save
          </Button>
        </div>
      ) : (
        <button type="button" onClick={() => setDraft(name)} className="mt-2.5 block w-full">
          <InsetDisplay className="flex items-baseline justify-between px-3 py-1.5">
            <span
              className={`truncate font-mono text-[15px] font-semibold tracking-[0.5px] ${
                name ? "text-text-hi" : "text-text-faint"
              }`}
            >
              {name || "unnamed performer"}
            </span>
            <span className="ml-3 flex-none font-mono text-[9px] text-text-faint">
              {name ? "tap to edit" : "tap to set"}
            </span>
          </InsetDisplay>
        </button>
      )}
      <p className="mt-2 text-[10px] leading-relaxed text-text-faint">
        Names this phone's track on the desk. Saved for next time.
      </p>
    </Panel>
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

/** Transient (non-fatal) error surface with strip hygiene (F3 fold): a
 * dismiss affordance and a 30s auto-expiry. A new message resets both.
 * Fatal conditions never render here — they get the terminal panel. */
const ERROR_TTL_MS = 30_000;

function TransientError({ message }: { message: string | null }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    setExpired(false);
    if (message === null) return;
    const timer = window.setTimeout(() => setExpired(true), ERROR_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [message]);

  if (message === null || expired || dismissed === message) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-2 rounded-md border border-rec/40 bg-rec/10 px-3 py-2"
    >
      <span className="min-w-0 truncate font-mono text-[10px] text-rec">{message}</span>
      <button
        type="button"
        aria-label="Dismiss error"
        onClick={() => setDismissed(message)}
        className="flex-none font-mono text-[12px] leading-none text-rec hover:brightness-125"
      >
        ×
      </button>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
