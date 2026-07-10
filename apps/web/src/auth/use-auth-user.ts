// React binding for the auth-user identity registry (net/auth-user.ts).
// Safe on every route in BOTH auth modes: it reads the registry, never
// Clerk — keyless simply always sees null.

import { useSyncExternalStore } from "react";
import { type AuthUserIdentity, authUser, subscribeAuthUser } from "../net/auth-user";

/** The signed-in user's display identity, or null (keyless / signed out). */
export function useAuthUser(): AuthUserIdentity | null {
  return useSyncExternalStore(subscribeAuthUser, authUser);
}
