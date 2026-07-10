// W8-A token plumbing between React (where Clerk lives) and the non-React
// network layer (DeskSession, SignalingClient, CollabClient, raw fetches).
// KEYLESS INVARIANT: with no getter registered — keyless mode, or Clerk not
// yet mounted — every helper degrades to exactly today's behavior: plain
// fetch, hello without authToken, collab URL without a query string. The
// registry is the ONLY coupling; nothing in /net imports Clerk.

type TokenGetter = () => Promise<string | null>;

let getter: TokenGetter | null = null;

/** Called by the Clerk shell once hooks are live (and with null on
 * unmount). Clerk's getToken() caches and silently refreshes the session
 * JWT — calling it per request is the intended usage, not a round-trip. */
export function registerAuthTokenGetter(next: TokenGetter | null): void {
  getter = next;
}

/** True when the app runs with Clerk mounted (auth mode). Non-React code
 * uses this to pick the authed variant of a flow (e.g. downloads). */
export function authActive(): boolean {
  return getter !== null;
}

/** Current session token, or null when keyless / signed out / expired.
 * Never throws: a token failure must read as "not authenticated" and let
 * the server answer 401 — capture-side code paths must not crash. */
export async function authToken(): Promise<string | null> {
  if (!getter) return null;
  try {
    return await getter();
  } catch {
    return null;
  }
}

/** fetch + Authorization when a token exists. Signed-out/keyless calls go
 * out bare and the server answers honestly (open in keyless, 401 authed). */
export async function authFetch(input: string, init?: RequestInit): Promise<Response> {
  const token = await authToken();
  if (!token) return fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
