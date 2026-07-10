// Terminal control-plane halt: signaling stopped for good (no reconnect
// loop runs), rendered by index.tsx as a blocking panel over everything.

import { Button, MonoReadout, Panel, SectionLabel, StatusPill } from "../../components";
import type { FatalSignalingError } from "../../net/signaling-client";

/** The only exit is the deliberate take-over (reopen + supersede back);
 * local data is safe either way — takes live in OPFS and on the server. */
export function DeskFatalPanel({
  fatal,
  onTakeOver,
}: {
  fatal: FatalSignalingError;
  onTakeOver: () => void;
}) {
  const superseded = fatal.code === "superseded";
  return (
    <div className="fixed inset-0 z-[50] grid place-items-center bg-void/70">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="desk-fatal-title"
        className="relative"
      >
        <Panel className="w-[420px] p-4 shadow-[0_14px_36px_rgba(0,0,0,.6)]">
          <div className="flex items-center justify-between">
            <SectionLabel>Session</SectionLabel>
            <StatusPill tone="warn">disconnected</StatusPill>
          </div>
          <p
            id="desk-fatal-title"
            role="alert"
            className="mt-3 text-[13px] leading-relaxed text-text-body"
          >
            {superseded
              ? "This desk reconnected in another tab — this tab has been disconnected."
              : fatal.message}
          </p>
          <MonoReadout className="mt-3" label="reason" value={fatal.code} />
          <MonoReadout label="reconnect" value="stopped" />
          <MonoReadout label="recorded takes" value="safe (stored on desk + server)" />
          {superseded && (
            <>
              <Button variant="accent" className="mt-4 w-full" onClick={onTakeOver}>
                Take over in this tab
              </Button>
              <p className="mt-2 text-[10px] leading-relaxed text-text-faint">
                Taking over re-joins the session from this tab — and disconnects the other one.
              </p>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
