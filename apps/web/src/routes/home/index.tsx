// Landing — "/". Two modes, one route: keyless (no Clerk keys) renders the
// static landing; auth mode loads authed-home.tsx lazily so keyless visitors
// never download Clerk bytes. Join-by-code stays accountless in every variant.

import { useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { useAuthMode } from "../../auth/auth-root";
import { Button, SectionLabel, Wordmark } from "../../components";
import { JoinByCode } from "./join-panel";
import { listRecentSessions, relativeTime } from "./recent-sessions";

const AuthedHome = lazy(() => import("./authed-home"));

export function HomeRoute() {
  // Branch once at the top: Clerk hooks exist only under the provider
  // (auth mode), so the two variants are separate components.
  if (useAuthMode() === "clerk") {
    return (
      <Suspense fallback={null}>
        <AuthedHome />
      </Suspense>
    );
  }
  return <KeylessHome />;
}

function KeylessHome() {
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
          onClick={() => navigate({ to: "/session/$uuid", params: { uuid: crypto.randomUUID() } })}
        >
          Create session
        </Button>

        <JoinByCode onJoin={(id) => navigate({ to: "/join/$uuid", params: { uuid: id } })} />

        {recents.length > 0 && (
          <div className="flex w-full flex-col gap-1.5">
            <SectionLabel className="px-1">Recent sessions</SectionLabel>
            {recents.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => navigate({ to: "/session/$uuid", params: { uuid: s.id } })}
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
