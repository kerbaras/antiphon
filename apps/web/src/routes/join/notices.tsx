// Non-terminal notices: the transient error strip and the honest
// session-not-found warning.

import { useEffect, useState } from "react";
import { InsetDisplay, Panel, SectionLabel, StatusPill } from "../../components";

/** The existence probe found no trace of the session. Deliberately NOT a
 * gate — the desk may create it moments later (the probe keeps polling),
 * and capture never depends on the network. */
export function SessionNotFound({ sessionId }: { sessionId: string }) {
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

const ERROR_TTL_MS = 30_000;

/** Transient (non-fatal) error strip: dismissible, with a 30s auto-expiry.
 * A new message resets both. Fatal conditions get the terminal screen. */
export function TransientError({ message }: { message: string | null }) {
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
