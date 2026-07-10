// The signed-in user's display identity (email + profile picture), bridged
// from React (where Clerk lives) to the non-React net layer — auth-token.ts's
// pattern. Keyless: nothing registered → readers see null. No Clerk in /net.

export interface AuthUserIdentity {
  /** Primary email address, or null while Clerk hasn't resolved one. */
  email: string | null;
  /** Clerk profile picture URL (img.clerk.com serves CORP — COEP-safe). */
  imageUrl: string | null;
}

type Listener = () => void;

let identity: AuthUserIdentity | null = null;
const listeners = new Set<Listener>();

/** Called by the Clerk shell whenever the signed-in user changes (and with
 * null on sign-out/unmount). */
export function setAuthUser(next: AuthUserIdentity | null): void {
  if (JSON.stringify(next) === JSON.stringify(identity)) return;
  identity = next;
  for (const l of listeners) l();
}

/** The signed-in user's display identity, or null (keyless / signed out). */
export function authUser(): AuthUserIdentity | null {
  return identity;
}

/** Change subscription for React bindings (auth/use-auth-user.ts). */
export function subscribeAuthUser(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
