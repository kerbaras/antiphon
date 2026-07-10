// Clerk-backed desk gate (lazy; see access-gate.tsx). Signed out → sign-in;
// 401/403 → "no desk access"; everything else mounts the DAW — 404 included
// (a fresh desk link CREATES the session) and network failure (offline-first).

import { UserButton, useAuth, useClerk, useUser } from "@clerk/react";
import { Link, useParams } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { Button, Panel, SectionLabel, Wordmark } from "../../components";
import { authFetch } from "../../net/auth-token";

type Verdict = "checking" | "allowed" | "forbidden";

export default function ClerkAccessGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { uuid } = useParams({ strict: false });
  const [verdict, setVerdict] = useState<Verdict>("checking");

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !uuid) return;
    let cancelled = false;
    setVerdict("checking");
    authFetch(`/api/sessions/${uuid}`)
      .then((res) => {
        if (cancelled) return;
        setVerdict(res.status === 401 || res.status === 403 ? "forbidden" : "allowed");
      })
      .catch(() => {
        if (!cancelled) setVerdict("allowed");
      });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, uuid]);

  if (!isLoaded) return null;
  if (!isSignedIn) return <SignInScreen sessionId={uuid ?? ""} />;
  if (verdict === "checking") return null;
  if (verdict === "forbidden") return <ForbiddenScreen sessionId={uuid ?? ""} />;
  return children;
}

/** Shared frame for both gate screens: centered column, wordmark, panel. */
function GateFrame({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-void p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        <Wordmark />
        {children}
      </div>
    </main>
  );
}

function SignInScreen({ sessionId }: { sessionId: string }) {
  const clerk = useClerk();
  return (
    <GateFrame>
      <Panel className="flex w-full flex-col gap-3 p-4">
        <SectionLabel>Desk access</SectionLabel>
        <p className="text-[12px] leading-relaxed text-text-body">
          Session <span className="font-mono text-text-strong">{sessionId.slice(0, 8)}</span>'s desk
          — the mixing console — needs an account.
        </p>
        <Button variant="accent" className="w-full" onClick={() => clerk.openSignIn()}>
          Sign in
        </Button>
        <Button variant="outline" className="w-full" onClick={() => clerk.openSignUp()}>
          Create account
        </Button>
      </Panel>
      <p className="text-center font-mono text-[9px] leading-relaxed text-text-faint">
        here to sing? the microphone join needs no account —{" "}
        <Link to="/join/$uuid" params={{ uuid: sessionId }} className="text-accent hover:underline">
          join as a mic
        </Link>
      </p>
    </GateFrame>
  );
}

function ForbiddenScreen({ sessionId }: { sessionId: string }) {
  const { user } = useUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  return (
    <GateFrame>
      <Panel className="flex w-full flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <SectionLabel>No desk access</SectionLabel>
          <UserButton />
        </div>
        <p className="text-[12px] leading-relaxed text-text-body">
          You don't have desk access to session{" "}
          <span className="font-mono text-text-strong">{sessionId.slice(0, 8)}</span>. Ask the owner
          to share it{email ? " with " : ""}
          {email && <span className="font-mono text-text-strong">{email}</span>}.
        </p>
        <Link to="/" className="w-full">
          <Button variant="outline" className="w-full">
            Back to your sessions
          </Button>
        </Link>
      </Panel>
      <p className="text-center font-mono text-[9px] leading-relaxed text-text-faint">
        singers don't need access — the invite link{" "}
        <Link to="/join/$uuid" params={{ uuid: sessionId }} className="text-accent hover:underline">
          joins as a mic
        </Link>{" "}
        without an account
      </p>
    </GateFrame>
  );
}
