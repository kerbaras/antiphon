// Desk access gate. Keyless: children render bare. Auth mode: the
// clerk-backed gate (lazy chunk) checks sign-in + desk access BEFORE the
// DAW mounts. The server stays the enforcement point; this is UX, not security.

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
