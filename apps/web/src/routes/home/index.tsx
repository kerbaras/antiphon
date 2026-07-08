// Landing — "/". Minimal and honest: wordmark, the one-line pitch, Create
// session, join-by-code (paste a link or a raw uuid), and the desk sessions
// this browser has visited. Same instrument-panel language as everything
// else; no marketing surface.

import { useState } from "react";
import { useNavigate } from "react-router";
import { Button, Panel, SectionLabel, Wordmark } from "../../ui/kit";
import { extractSessionId } from "./join-code";
import { listRecentSessions, relativeTime } from "./recent-sessions";

export function HomeRoute() {
  const navigate = useNavigate();
  // Read once per mount: the list only changes by visiting a desk.
  const [recents] = useState(() => listRecentSessions());

  return (
    <main className="grid min-h-dvh place-items-center bg-void p-6">
      <div className="flex w-full max-w-xs flex-col items-center gap-6">
        <Wordmark />
        <p className="text-center text-[12px] leading-relaxed text-text-dim">
          Phones are the microphones. The desk is the console. Every take survives the network.
        </p>
        <Button
          variant="accent"
          className="w-full"
          onClick={() => navigate(`/session/${crypto.randomUUID()}`)}
        >
          Create session
        </Button>

        <JoinByCode onJoin={(id) => navigate(`/join/${id}`)} />

        {recents.length > 0 && (
          <div className="flex w-full flex-col gap-1.5">
            <SectionLabel className="px-1">Recent sessions</SectionLabel>
            {recents.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => navigate(`/session/${s.id}`)}
                title={`Reopen desk ${s.id}`}
                className="flex items-baseline justify-between gap-3 rounded-md border border-edge-card bg-card px-3 py-2 text-left hover:bg-card-hi"
              >
                <span className="font-mono text-[11px] font-medium text-text-strong">
                  {s.id.slice(0, 8)}
                </span>
                <span className="font-mono text-[9px] text-text-faint">{relativeTime(s.at)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

/** Paste a join/desk link or a bare uuid → the phone join page. */
function JoinByCode({ onJoin }: { onJoin: (sessionId: string) => void }) {
  const [code, setCode] = useState("");
  const sessionId = extractSessionId(code);

  function submit() {
    if (sessionId) onJoin(sessionId);
  }

  return (
    <Panel className="w-full p-3">
      <SectionLabel>Join a session</SectionLabel>
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
    </Panel>
  );
}
