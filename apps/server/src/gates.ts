// Desk-surface auth gates shared by the HTTP route modules. Every gate
// no-ops in keyless mode (null access/clerkAuth) — pre-auth behavior
// byte-for-byte.

import type { HttpBindings } from "@hono/node-server";
import type { Context } from "hono";
import { AccessDeniedError, type DeskAccess, type DeskRole } from "./auth/access.ts";
import type { ClerkAuth } from "./auth/clerk.ts";
import type { DeskHelloAuth } from "./signaling/index.ts";

export type Env = { Bindings: HttpBindings };

/** Routes with raw URL params — typos included — must answer honest 404s,
 * never uuid-cast 500s (malformed ids can't exist in Postgres uuid). */
export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DeskGate =
  | { ok: true; userId: string | null; role: DeskRole | null }
  | { ok: false; res: Response };

export interface AuthGates {
  /** Bearer session-token → Clerk user id; null covers "auth off", "no
   * header", and "invalid token". Verification is networkless after warmup
   * (cached JWKS) — see auth/clerk. */
  bearerUser(c: Context<Env>): Promise<{ userId: string } | null>;
  /** Desk-surface REST gate. Keyless: pass-through (role null). Authed:
   * 401 without a valid user, 404 for unknown sessions (existence is
   * public anyway via /exists), 403 for a user without desk access. A
   * first authenticated toucher of an ownerless session claims it here. */
  deskGate(c: Context<Env>, sessionId: string): Promise<DeskGate>;
}

export function createAuthGates(clerkAuth: ClerkAuth | null, access: DeskAccess | null): AuthGates {
  const bearerUser = async (c: Context<Env>): Promise<{ userId: string } | null> => {
    if (!clerkAuth) return null;
    const header = c.req.header("authorization");
    if (!header?.startsWith("Bearer ")) return null;
    return await clerkAuth.verifyToken(header.slice("Bearer ".length));
  };

  const deskGate = async (c: Context<Env>, sessionId: string): Promise<DeskGate> => {
    if (!access) return { ok: true, userId: null, role: null };
    if (!UUID_SHAPE.test(sessionId)) {
      return { ok: false, res: c.json({ error: "unknown session" }, 404) };
    }
    const user = await bearerUser(c);
    if (!user) return { ok: false, res: c.json({ error: "authentication required" }, 401) };
    try {
      const decision = await access.authorize(sessionId, user.userId);
      if (decision.ok) return { ok: true, userId: user.userId, role: decision.role };
      if (decision.reason === "unknown-session") {
        return { ok: false, res: c.json({ error: "unknown session" }, 404) };
      }
    } catch (error) {
      if (!(error instanceof AccessDeniedError)) throw error;
    }
    return {
      ok: false,
      res: c.json({ error: "no desk access to this session — ask the owner to share it" }, 403),
    };
  };

  return { bearerUser, deskGate };
}

/** Signaling hello gate: desk-role connections must present a valid Clerk
 * token for an owner/sharee BEFORE any session state attaches (room
 * creation included). Or-create: the desk WS is a session-creating surface,
 * so the authenticated opener of a fresh session becomes the owner. */
export function createDeskHelloAuth(
  clerkAuth: ClerkAuth | null,
  access: DeskAccess | null,
): DeskHelloAuth | null {
  if (!clerkAuth || !access) return null;
  return async (sessionId: string, token: string | undefined) => {
    if (!token) {
      return { ok: false as const, message: "sign in required to open this session's desk" };
    }
    const user = await clerkAuth.verifyToken(token);
    if (!user) {
      return { ok: false as const, message: "session token invalid or expired — sign in again" };
    }
    try {
      const decision = await access.authorizeOrCreate(sessionId, user.userId);
      if (decision.ok) return { ok: true as const };
    } catch (error) {
      if (!(error instanceof AccessDeniedError)) throw error;
    }
    return {
      ok: false as const,
      message: "no desk access to this session — ask the owner to share it with your email",
    };
  };
}
