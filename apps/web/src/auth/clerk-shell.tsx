// W8-A Clerk mount (lazy chunk — see auth-root.tsx).
//
// COEP RESOLUTION (trap A, decided after testing both options): clerk-js
// loads from the Clerk CDN (the SDK default). The npm-bundled variant
// (`Clerk` prop) was tried first and REJECTED: since clerk-js v6 the
// prebuilt components (SignIn modal, UserButton) live in a separately
// hot-loaded `@clerk/ui` package that simply is not in the npm module —
// the bundled path throws "Clerk was not loaded with Ui components".
// Self-hosting would mean vendoring two dist trees behind two @internal
// props; instead we rely on the fact that Clerk serves EVERY browser
// asset (clerk.browser.js + chunks, ui.browser.js, img.clerk.com
// avatars) with `Cross-Origin-Resource-Policy: cross-origin` — verified
// 2026-07 and deliberately COEP-compatible on their side. COOP/COEP
// (require-corp) stay untouched on every route; the FAPI itself is CORS
// (exempt from CORP). The live-clerk e2e pins the whole story: sign-in
// modal renders, crossOriginIsolated === true, zero BLOCKED_BY_RESPONSE.
// If Clerk ever drops those headers, that spec — not a choir's session —
// finds out.
//
// Appearance maps Clerk components onto the house tokens (styles.css) so
// the prebuilt modals don't look alien in the instrument panel.
// TokenBridge hands Clerk's getToken to the non-React net layer; on
// unmount the registry clears back to keyless behavior.

import { ClerkProvider, useAuth } from "@clerk/react";
import { type ReactNode, useEffect } from "react";
import { registerAuthTokenGetter } from "../net/auth-token";

/** House tokens → Clerk appearance variables (the CURRENT @clerk/ui
 * names: colorForeground/colorInput/… — the legacy colorText/
 * colorInputBackground aliases silently no-op on the new renderer, which
 * is how the first pass shipped a white input on a dark card). Values
 * mirror styles.css (@theme) — keep in sync by hand; Clerk renders in its
 * own subtree where our Tailwind theme doesn't reach. */
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
    // use is the intended pattern (clerk-react-patterns skill).
    registerAuthTokenGetter(() => getToken());
    return () => registerAuthTokenGetter(null);
  }, [getToken]);
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
      {/* First child on purpose: its effect (token registration) flushes
          before any route effect can fire an authed fetch. */}
      <TokenBridge />
      {children}
    </ClerkProvider>
  );
}
