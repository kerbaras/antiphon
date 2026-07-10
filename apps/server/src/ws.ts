// WebSocket surfaces: signaling control plane (desk /session, recorder
// /join — RFC §4.1) and the collab doc socket, all behind per-IP join rate
// limiting before upgrade (RFC §12 MUST).

import { createNodeWebSocket } from "@hono/node-ws";
import type { Context, Hono } from "hono";
import { AccessDeniedError, type DeskAccess } from "./auth/access.ts";
import type { ClerkAuth } from "./auth/clerk.ts";
import type { CollabHub } from "./collab/index.ts";
import type { ServerConfig } from "./config.ts";
import { type Env, UUID_SHAPE } from "./gates.ts";
import type { Logger } from "./logger.ts";
import { KeyedRateLimiter } from "./ratelimit.ts";
import type { ConnState, Signaling } from "./signaling/index.ts";

export interface WsDeps {
  config: ServerConfig;
  signaling: Signaling;
  collab: CollabHub;
  access: DeskAccess | null;
  clerkAuth: ClerkAuth | null;
  log: Logger;
}

export function registerWsRoutes(app: Hono<Env>, deps: WsDeps) {
  const { config, signaling, collab, access, clerkAuth, log } = deps;
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  const joinLimiter = new KeyedRateLimiter(
    config.limits.joinBurst,
    config.limits.joinRatePerMin / 60,
  );
  const clientIp = (c: Context<Env>): string => {
    if (config.trustProxy) {
      const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (forwarded) return forwarded;
    }
    return c.env.incoming.socket?.remoteAddress ?? "unknown";
  };
  const joinRateLimit = async (
    c: Context<Env>,
    next: () => Promise<void>,
  ): Promise<Response | undefined> => {
    const ip = clientIp(c);
    if (!joinLimiter.allow(ip)) {
      log.warn("join attempt rate-limited", { ip, path: c.req.path });
      return c.json({ error: "rate-limited" }, 429);
    }
    await next();
    return undefined;
  };
  app.use("/session/:sessionId/ws", joinRateLimit);
  app.use("/join/:sessionId/ws", joinRateLimit);

  const wsHandler = (role: "desk" | "recorder") =>
    upgradeWebSocket((c: { req: { param(name: "sessionId"): string } }) => {
      const conn: ConnState = {
        sessionId: c.req.param("sessionId"),
        pathRole: role,
        peerId: null,
        epoch: 0,
      };
      return {
        onMessage(event: MessageEvent, ws: Parameters<Signaling["handleMessage"]>[1]) {
          void signaling.handleMessage(conn, ws, String(event.data)).catch((error: unknown) => {
            log.error("signaling message handling failed", {
              sessionId: conn.sessionId,
              peerId: conn.peerId,
              error,
            });
          });
        },
        onClose() {
          signaling.handleClose(conn);
        },
      };
    });
  app.get("/session/:sessionId/ws", wsHandler("desk"));
  app.get("/join/:sessionId/ws", wsHandler("recorder"));

  // ---- shared project doc ---------------------------------------------------
  // Desk-role path like /session/:uuid/ws (join rate limiting included);
  // binary Yjs sync + awareness frames, persisted per session. Transport
  // control stays on the signaling socket — see collab/index.ts header.
  app.use("/session/:sessionId/collab", joinRateLimit);
  if (access && clerkAuth) {
    const deskAccess = access;
    const verify = clerkAuth;
    // The Yjs wire has no hello/welcome handshake to carry a token (binary
    // sync frames from byte 0) and a browser WebSocket can't set headers —
    // so the token rides a query param and the gate REJECTS THE UPGRADE
    // before the collab room (and its doc hydration) is even looked up.
    // Query strings never reach the request log (c.req.path is pathname-
    // only). Or-create like the signaling hello: collab may win the race
    // with the desk's first hello on a fresh session — both claim, one
    // wins, same owner either way.
    app.use("/session/:sessionId/collab", async (c, next) => {
      const token = c.req.query("auth_token");
      const user = token ? await verify.verifyToken(token) : null;
      if (!user) return c.json({ error: "authentication required" }, 401);
      const sessionId = c.req.param("sessionId");
      if (!UUID_SHAPE.test(sessionId)) return c.json({ error: "unknown session" }, 404);
      const denied = await deskAccess
        .authorizeOrCreate(sessionId, user.userId)
        .then((d) => !d.ok)
        .catch((error: unknown) => {
          if (error instanceof AccessDeniedError) return true;
          throw error;
        });
      if (denied) {
        log.warn("collab connection refused: no desk access", {
          sessionId,
          userId: user.userId,
        });
        return c.json({ error: "no desk access to this session" }, 403);
      }
      await next();
      return undefined;
    });
  }
  app.get(
    "/session/:sessionId/collab",
    upgradeWebSocket((c: { req: { param(name: "sessionId"): string } }) => {
      const handlers = collab.handleConnection(c.req.param("sessionId"));
      return {
        onOpen(_evt: Event, ws: Parameters<typeof handlers.onOpen>[0]) {
          handlers.onOpen(ws);
        },
        onMessage(event: MessageEvent, ws: Parameters<typeof handlers.onOpen>[0]) {
          handlers.onMessage(event.data, ws);
        },
        onClose() {
          handlers.onClose();
        },
      };
    }),
  );

  return { injectWebSocket };
}
