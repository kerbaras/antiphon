// Accounts surface: landing lists + share management. Mounted ONLY when
// auth is on — keyless mode must stay byte-for-byte, so these routes simply
// don't exist there (404 like any unknown path).

import type { Context, Hono } from "hono";
import { z } from "zod";
import { type DeskAccess, isPlausibleEmail, normalizeEmail } from "./auth/access.ts";
import type { AuthGates, DeskGate, Env } from "./gates.ts";

export interface AccountRouteDeps {
  access: DeskAccess;
  gates: AuthGates;
}

export function registerAccountRoutes(app: Hono<Env>, { access, gates }: AccountRouteDeps) {
  const { bearerUser, deskGate } = gates;

  /** Landing lists: sessions you own + sessions shared to any of your
   * verified emails — one call, both buckets. */
  app.get("/api/me/sessions", async (c) => {
    const user = await bearerUser(c);
    if (!user) return c.json({ error: "authentication required" }, 401);
    const { own, shared } = await access.listUserSessions(user.userId);
    return c.json({ own, shared });
  });

  /** Share management is OWNER-only — the one desk power sharees don't get
   * (v1). The gate's claim path means a legacy session's first
   * authenticated opener can immediately manage shares. */
  const ownerGate = async (c: Context<Env>, sessionId: string): Promise<DeskGate> => {
    const gate = await deskGate(c, sessionId);
    if (!gate.ok || gate.role === "owner") return gate;
    return {
      ok: false,
      res: c.json({ error: "only the session owner can manage desk access" }, 403),
    };
  };

  app.get("/api/sessions/:sessionId/shares", async (c) => {
    const sessionId = c.req.param("sessionId");
    const gate = await ownerGate(c, sessionId);
    if (!gate.ok) return gate.res;
    return c.json({ shares: await access.listShares(sessionId) });
  });

  const ShareBody = z.object({ email: z.string().min(3).max(320) });
  app.post("/api/sessions/:sessionId/shares", async (c) => {
    const sessionId = c.req.param("sessionId");
    const gate = await ownerGate(c, sessionId);
    if (!gate.ok) return gate.res;
    const body = ShareBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "body must be { email }" }, 400);
    const email = normalizeEmail(body.data.email);
    if (!isPlausibleEmail(email)) return c.json({ error: "not a plausible email address" }, 400);
    // gate.userId is non-null by construction here (authed mode).
    const added = await access.addShare(sessionId, email, gate.userId ?? "");
    if (!added) return c.json({ error: "share limit reached for this session" }, 409);
    return c.json({ email }, 201);
  });

  app.delete("/api/sessions/:sessionId/shares/:email", async (c) => {
    const sessionId = c.req.param("sessionId");
    const gate = await ownerGate(c, sessionId);
    if (!gate.ok) return gate.res;
    await access.removeShare(sessionId, normalizeEmail(c.req.param("email")));
    return c.body(null, 204);
  });
}
