// W8-A auth-mode landing (lazy chunk: this file is the home route's only
// @clerk/react importer, so keyless visitors never download Clerk bytes).
//
// Signed out: wordmark, pitch, sign-in/up, join-by-code — NO create button
// (creating a session needs an owner). Signed in: "Your sessions" and
// "Shared with me" (GET /api/me/sessions), create-session, join-by-code,
// UserButton. Join-by-code stays accountless in both states: singers with
// a link are mics, not accounts.

import { UserButton, useAuth, useClerk } from "@clerk/react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Button, SectionLabel, Wordmark } from "../../components";
import { authFetch } from "../../net/auth-token";
import { JoinByCode } from "./join-panel";
import { fetchMeSessions, type MeSession, type MeSessions } from "./me-sessions";
import { relativeTime } from "./recent-sessions";

export default function AuthedHome() {
  const { isLoaded, isSignedIn } = useAuth();
  const navigate = useNavigate();

  // isLoaded gate first, always (clerk-react-patterns): render the shared
  // skeleton rather than flashing the signed-out affordances.
  if (!isLoaded) {
    return (
      <main className="grid min-h-dvh place-items-center bg-void p-6">
        <div className="flex w-full max-w-xs flex-col items-center gap-6">
          <Wordmark />
          <Pitch />
        </div>
      </main>
    );
  }
  if (!isSignedIn) return <SignedOutHome onJoin={(id) => navigate(`/join/${id}`)} />;
  return <SignedInHome />;
}

function Pitch() {
  return (
    <p className="text-center text-[12px] leading-relaxed text-text-dim">
      Phones are the microphones. The desk is the console. Every take survives the network.
    </p>
  );
}

function SignedOutHome({ onJoin }: { onJoin: (sessionId: string) => void }) {
  const clerk = useClerk();
  return (
    <main className="grid min-h-dvh place-items-center bg-void p-6">
      <div className="flex w-full max-w-xs flex-col items-center gap-6">
        <Wordmark />
        <Pitch />
        <div className="flex w-full flex-col gap-2">
          <Button variant="accent" className="w-full" onClick={() => clerk.openSignIn()}>
            Sign in
          </Button>
          <Button variant="outline" className="w-full" onClick={() => clerk.openSignUp()}>
            Create account
          </Button>
          <p className="px-1 text-center font-mono text-[9px] leading-relaxed text-text-faint">
            an account runs the desk — creating sessions, mixing, sharing
          </p>
        </div>
        <JoinByCode onJoin={onJoin} micCopy />
      </div>
    </main>
  );
}

function SignedInHome() {
  const navigate = useNavigate();
  const [lists, setLists] = useState<MeSessions | null | "loading">("loading");
  const [createFailed, setCreateFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchMeSessions().then((result) => {
      if (!cancelled) setLists(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function createSession() {
    setCreateFailed(false);
    try {
      // POST (not a bare navigate to a fresh uuid): ownership lands
      // atomically at creation, and the landing lists stay authoritative.
      const res = await authFetch("/api/sessions", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      const { sessionId } = (await res.json()) as { sessionId: string };
      navigate(`/session/${sessionId}`);
    } catch {
      setCreateFailed(true);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-void p-6">
      <div className="flex w-full max-w-sm flex-col gap-6 py-8">
        <div className="flex items-center justify-between">
          <Wordmark />
          <UserButton />
        </div>

        <div className="flex flex-col gap-2">
          <Button variant="accent" className="w-full" onClick={() => void createSession()}>
            Create session
          </Button>
          {createFailed && (
            <p className="px-1 font-mono text-[9px] text-warn">
              couldn't create a session — server unreachable? try again
            </p>
          )}
        </div>

        <JoinByCode onJoin={(id) => navigate(`/join/${id}`)} micCopy />

        {lists === "loading" ? (
          <p className="px-1 font-mono text-[9px] text-text-faint">loading your sessions…</p>
        ) : lists === null ? (
          <p className="px-1 font-mono text-[9px] text-warn">
            couldn't load your sessions — direct desk links still open fine
          </p>
        ) : (
          <>
            <SessionList
              label="Your sessions"
              sessions={lists.own}
              empty="none yet — create one above"
              onOpen={(id) => navigate(`/session/${id}`)}
            />
            <SessionList
              label="Shared with me"
              sessions={lists.shared}
              empty="nothing shared to your email yet"
              onOpen={(id) => navigate(`/session/${id}`)}
              showOwner
            />
          </>
        )}
      </div>
    </main>
  );
}

/** One landing bucket: name (short id), created, take count — the desk is
 * one click away. Owner attribution only makes sense on the shared bucket. */
function SessionList({
  label,
  sessions,
  empty,
  onOpen,
  showOwner = false,
}: {
  label: string;
  sessions: MeSession[];
  empty: string;
  onOpen: (sessionId: string) => void;
  showOwner?: boolean;
}) {
  return (
    <div className="flex w-full flex-col gap-1.5">
      <SectionLabel className="px-1">{label}</SectionLabel>
      {sessions.length === 0 && (
        <p className="px-1 font-mono text-[9px] text-text-faint">{empty}</p>
      )}
      {sessions.map((s) => (
        <button
          key={s.sessionId}
          type="button"
          onClick={() => onOpen(s.sessionId)}
          title={`Open desk ${s.sessionId}`}
          className="flex items-baseline justify-between gap-3 rounded-md border border-edge-card bg-card px-3 py-2 text-left hover:bg-card-hi"
        >
          <span className="flex min-w-0 flex-col">
            <span className="font-mono text-[11px] font-medium text-text-strong">
              Session {s.sessionId.slice(0, 8)}
            </span>
            {showOwner && s.ownerEmail && (
              <span className="truncate font-mono text-[9px] text-text-faint">
                from {s.ownerEmail}
              </span>
            )}
          </span>
          <span className="flex shrink-0 flex-col items-end">
            <span className="font-mono text-[9px] text-text-dim">
              {s.takeCount} take{s.takeCount === 1 ? "" : "s"}
            </span>
            <span className="font-mono text-[9px] text-text-faint">
              {relativeTime(Date.parse(s.createdAt))}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
