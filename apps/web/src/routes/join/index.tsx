// Phone recorder — /join/:uuid. A performer-facing instrument panel;
// also works session-less as a local rehearsal recorder.

import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { CapturePanel } from "./capture-panel";
import { DiagnosticsPanel } from "./diagnostics-panel";
import { FatalScreen } from "./fatal-screen";
import { JoinHeader } from "./join-header";
import { LocalTakePanel } from "./local-take-panel";
import { SessionNotFound, TransientError } from "./notices";
import { PerformerPanel } from "./performer-panel";
import { useSessionExistence } from "./session-existence";
import { SessionLinksPanel } from "./session-links-panel";
import { StatusPanel } from "./status-panel";
import {
  joinSession,
  startCapture,
  takeOverSession,
  useCaptureSnapshot,
  useRecorderSessionState,
} from "./use-capture";

export function JoinRoute() {
  const { uuid } = useParams({ strict: false });
  const snap = useCaptureSnapshot();
  const sessionState = useRecorderSessionState();
  const [busy, setBusy] = useState(false);

  // Once joined, the live roster beats the HTTP probe — a desk in the room
  // (or a rolling take) confirms the session and latches the verdict.
  const deskSeen =
    sessionState !== null &&
    sessionState.fatal === null &&
    (sessionState.deskLink !== "absent" || sessionState.activeTakeId !== null);
  const existence = useSessionExistence(uuid ?? null, deskSeen);

  const capturing = snap.contextSampleRate !== null;
  const inSession = sessionState !== null;
  // snap.takeOpen is the controller's SYNCHRONOUS latch (set the instant
  // arm() is invoked, held through draining) — never the ~250ms-lagged
  // worker stats, which would leave the picker enabled into a rolling take.
  const takeOpen = snap.takeOpen || (sessionState?.activeTakeId ?? null) !== null;

  async function enableMic() {
    setBusy(true);
    try {
      await startCapture();
      if (uuid) joinSession(uuid);
    } finally {
      setBusy(false);
    }
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

  if (sessionState?.fatal) {
    return <FatalScreen uuid={uuid} fatal={sessionState.fatal} busy={busy} onTakeOver={takeOver} />;
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-3 p-4 pb-10">
      <JoinHeader uuid={uuid} label={uuid ? "session" : "rehearsal"} />
      <TransientError message={snap.error} />
      {uuid && existence === "absent" && <SessionNotFound sessionId={uuid} />}
      <PerformerPanel deskLabel={sessionState?.label ?? null} />
      <StatusPanel snap={snap} sittingOut={sessionState?.sittingOut ?? false} />
      <CapturePanel snap={snap} takeOpen={takeOpen} busy={busy} onEnableMic={enableMic} />
      {capturing && inSession && sessionState && (
        <SessionLinksPanel snap={snap} sessionState={sessionState} sessionId={uuid as string} />
      )}
      {capturing && !inSession && <LocalTakePanel snap={snap} />}
      {capturing && <DiagnosticsPanel snap={snap} />}
    </main>
  );
}
