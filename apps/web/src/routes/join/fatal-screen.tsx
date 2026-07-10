// Terminal state: a fatal control error killed this connection for good.
// No reconnect loop is running, capture is stopped, the mic is released.
// Render the fact, not a transient error strip.

import { Button, MonoReadout, Panel, SectionLabel, StatusPill } from "../../components";
import type { FatalSignalingError } from "../../net/signaling-client";
import { JoinHeader } from "./join-header";

export function FatalScreen({
  uuid,
  fatal,
  busy,
  onTakeOver,
}: {
  uuid: string | undefined;
  fatal: FatalSignalingError;
  busy: boolean;
  onTakeOver: () => void;
}) {
  const superseded = fatal.code === "superseded";
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-3 p-4 pb-10">
      <JoinHeader uuid={uuid} label="session" />
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
            <Button variant="accent" className="mt-4 w-full" onClick={onTakeOver} disabled={busy}>
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
