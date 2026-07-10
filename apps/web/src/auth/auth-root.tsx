// App-root auth mount. Keyless mode renders children with nothing added —
// no provider, no Clerk bytes on the wire (the Clerk shell is a lazy chunk
// only fetched in clerk mode). Auth mode wraps the app in ClerkProvider.

import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useState,
} from "react";
import { type AuthMode, fetchAuthMode } from "./config";

/** "keyless" | "clerk" — UI code branches on this instead of touching
 * Clerk hooks (which only exist under the provider, i.e. in clerk mode). */
const AuthModeContext = createContext<"keyless" | "clerk">("keyless");

export function useAuthMode(): "keyless" | "clerk" {
  return useContext(AuthModeContext);
}

const ClerkShell = lazy(() => import("./clerk-shell"));

export function AuthRoot({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<AuthMode | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchAuthMode().then((resolved) => {
      if (!cancelled) setMode(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // One same-origin fetch stands between boot and first paint — blocked ON
  // PURPOSE: rendering the wrong mode's landing and swapping affordances
  // after the fact is worse than a blank frame. Server-down resolves fast
  // to keyless (fail-open; see config.ts).
  if (mode === null) return null;
  if (mode.mode === "keyless") return children;
  return (
    <AuthModeContext.Provider value="clerk">
      <Suspense fallback={null}>
        <ClerkShell publishableKey={mode.publishableKey}>{children}</ClerkShell>
      </Suspense>
    </AuthModeContext.Provider>
  );
}
