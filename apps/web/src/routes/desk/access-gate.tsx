// W8-A desk access gate. Keyless: children render bare — today's desk
// byte-for-byte. Auth mode: the clerk-backed gate (lazy chunk, the only
// path that pulls Clerk into the desk route) checks sign-in state and desk
// access BEFORE the DAW mounts, so an uninvited visitor sees an honest
// screen instead of a desk whose every request 401s. The server stays the
// enforcement point (WS hello + REST gates); this is UX, not security.

import { lazy, type ReactNode, Suspense } from "react";
import { useAuthMode } from "../../auth/auth-root";

const ClerkAccessGate = lazy(() => import("./access-gate-clerk"));

export function DeskAccessGate({ children }: { children: ReactNode }) {
  if (useAuthMode() === "keyless") return children;
  return (
    <Suspense fallback={null}>
      <ClerkAccessGate>{children}</ClerkAccessGate>
    </Suspense>
  );
}
