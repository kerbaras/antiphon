// Auth-mode boot probe. The SERVER is the source of truth for whether auth
// is enforced (GET /api/auth/config, public in both modes), so one web build
// behaves correctly against keyless AND authed servers.

export type AuthMode = { mode: "keyless" } | { mode: "clerk"; publishableKey: string };

interface AuthConfigWire {
  enabled: boolean;
  publishableKey: string | null;
}

export async function fetchAuthMode(): Promise<AuthMode> {
  let wire: AuthConfigWire;
  try {
    const res = await fetch("/api/auth/config");
    if (!res.ok) return { mode: "keyless" };
    wire = (await res.json()) as AuthConfigWire;
  } catch {
    // Server unreachable: FAIL OPEN to keyless UI. Enforcement lives on
    // the server — an offline desk has nothing reachable to protect, and
    // the signaling `unauthorized` fatal is the honest backstop once the
    // server returns. Blocking the app on an auth probe would violate
    // "capture never gates on the network".
    return { mode: "keyless" };
  }
  if (!wire.enabled) return { mode: "keyless" };
  const publishableKey =
    (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined)?.trim() ||
    wire.publishableKey?.trim() ||
    null;
  if (!publishableKey) {
    // Misconfigured deployment (server enforces, no key anywhere): honest
    // console evidence, keyless UI — the server will still refuse desks.
    console.error(
      "[auth] server enforces Clerk auth but no publishable key is available " +
        "(set VITE_CLERK_PUBLISHABLE_KEY at build time or CLERK_PUBLISHABLE_KEY on the server)",
    );
    return { mode: "keyless" };
  }
  return { mode: "clerk", publishableKey };
}
