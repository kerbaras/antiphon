// Clerk mount (lazy chunk — see auth-root.tsx). clerk-js loads from the
// Clerk CDN on purpose: the npm-bundled variant lacks the hot-loaded
// @clerk/ui components, and every Clerk browser asset is served with
// CORP: cross-origin, so our COOP/COEP (require-corp) stays untouched.

import { ClerkProvider, useAuth, useUser } from "@clerk/react";
import { type ReactNode, useEffect } from "react";
import { registerAuthTokenGetter } from "../net/auth-token";
import { setAuthUser } from "../net/auth-user";

/** House tokens → Clerk appearance variables. Use the CURRENT @clerk/ui
 * names (colorForeground/colorInput/…) — legacy aliases silently no-op.
 * Values mirror styles.css (@theme); keep in sync by hand. */
const APPEARANCE = {
  variables: {
    colorPrimary: "#2e8bff", // --color-accent
    colorPrimaryForeground: "#ffffff",
    colorBackground: "#202122", // --color-card
    colorForeground: "#d6d7d8", // --color-text
    colorMuted: "#1a1b1c", // --color-raised
    colorMutedForeground: "#8b8d90", // --color-text-dim
    colorInput: "#141516", // --color-bg
    colorInputForeground: "#e8e9ea", // --color-text-strong
    colorNeutral: "#d6d7d8",
    colorRing: "rgba(46, 139, 255, 0.4)", // accent at focus-ring strength
    colorDanger: "#e5484d", // --color-rec
    colorSuccess: "#3fbf6f", // --color-ok
    colorWarning: "#d9c94b", // --color-warn
    borderRadius: "0.5rem", // rounded-lg, the Panel radius
    fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",
    fontFamilyButtons: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",
  },
} as const;

function TokenBridge() {
  const { getToken } = useAuth();
  useEffect(() => {
    // Clerk's getToken caches + auto-refreshes the session JWT; per-call
    // use is the intended pattern.
    registerAuthTokenGetter(() => getToken());
    return () => registerAuthTokenGetter(null);
  }, [getToken]);
  return null;
}

/** Mirrors the signed-in user's display identity (email + pfp) into the
 * net-layer registry — no Clerk outside this chunk. */
function IdentityBridge() {
  const { user } = useUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  const imageUrl = user?.imageUrl ?? null;
  useEffect(() => {
    setAuthUser(user ? { email, imageUrl } : null);
    return () => setAuthUser(null);
  }, [user, email, imageUrl]);
  return null;
}

export default function ClerkShell({
  publishableKey,
  children,
}: {
  publishableKey: string;
  children: ReactNode;
}) {
  return (
    <ClerkProvider publishableKey={publishableKey} appearance={APPEARANCE}>
      {/* First children on purpose: their effects (token + identity
          registration) flush before any route effect can fire an authed
          fetch or read the user. */}
      <TokenBridge />
      <IdentityBridge />
      {children}
    </ClerkProvider>
  );
}
