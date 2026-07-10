// Session transport: the desk drives takes; the links carry the chunks.

import type { CaptureSnapshot } from "../../audio/capture-controller";
import { Button, MonoReadout, Panel, SectionLabel, StatusPill } from "../../components";
import type { RecorderSessionState } from "../../net/recorder-session";
import { joinSession } from "./use-capture";

export function SessionLinksPanel({
  snap,
  sessionState,
  sessionId,
}: {
  snap: CaptureSnapshot;
  sessionState: RecorderSessionState;
  sessionId: string;
}) {
  return (
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
              <span className={s.settled ? "text-ok" : undefined}>{s.settled ? "yes" : "no"}</span>
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
        onClick={() => joinSession(sessionId).simulateOutage(5_000)}
        disabled={sessionState.outageUntil !== null}
      >
        ⚡ Simulate 5s dropout
      </Button>
    </Panel>
  );
}

function linkColor(state: "connected" | "connecting" | "down" | "absent"): string {
  if (state === "connected") return "text-ok";
  if (state === "connecting") return "text-warn";
  if (state === "absent") return "text-text-faint";
  return "text-rec";
}

function LinkReadout({
  label,
  state,
}: {
  label: string;
  state: "connected" | "connecting" | "down" | "absent";
}) {
  return <MonoReadout label={label} value={<span className={linkColor(state)}>{state}</span>} />;
}
