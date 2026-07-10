// Join-by-code panel, shared by every landing variant (keyless + both
// auth states). Joining is the MIC capability: public by link (RFC §12),
// deliberately accountless — `micCopy` (auth mode only) says so out loud.

import { useState } from "react";
import { Button, Panel, SectionLabel } from "../../ui/kit";
import { useSessionExistence } from "../join/session-existence";
import { extractSessionId } from "./join-code";

/** Paste a join/desk link or a bare uuid → the phone join page. */
export function JoinByCode({
  onJoin,
  micCopy = false,
}: {
  onJoin: (sessionId: string) => void;
  micCopy?: boolean;
}) {
  const [code, setCode] = useState("");
  const sessionId = extractSessionId(code);
  // F19: probe the pasted id inline — a heads-up, never a gate (the join
  // page carries the full honest state and keeps rechecking).
  const existence = useSessionExistence(sessionId);

  function submit() {
    if (sessionId) onJoin(sessionId);
  }

  return (
    <Panel className="w-full p-3">
      <SectionLabel>Join a session</SectionLabel>
      {micCopy && (
        <p className="mt-1 font-mono text-[9px] leading-relaxed text-text-faint">
          joins as a microphone — anyone with the link can sing, no account needed
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="mt-2 flex items-stretch gap-2"
      >
        <input
          value={code}
          placeholder="Paste an invite link or session id"
          aria-label="Session link or id"
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            // Explicit: implicit form submission needs a submit button.
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          className="min-w-0 flex-1 rounded-md border border-edge-inset bg-bg px-2.5 py-1.5 font-mono text-[11px] text-text outline-none placeholder:text-text-faint focus:border-accent"
        />
        <Button variant="outline" className="px-3 py-1.5" disabled={!sessionId} onClick={submit}>
          Join
        </Button>
      </form>
      {code.trim() && !sessionId && (
        <p className="mt-1.5 px-0.5 font-mono text-[9px] text-warn">
          no session id found — expected a uuid or an invite link containing one
        </p>
      )}
      {sessionId && existence === "absent" && (
        <p className="mt-1.5 px-0.5 font-mono text-[9px] text-warn">
          no desk has opened this session yet — you can still join and wait for it
        </p>
      )}
    </Panel>
  );
}
