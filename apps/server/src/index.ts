// Antiphon server: Hono control plane on Node 24 LTS.
// Signaling (WS rooms, ICE relay), ingest (node-datachannel sink), archive
// (Postgres + blobs + reconciliation). Needs real UDP — deploys to a
// VM/Fly.io, never serverless. (docs/ARCHITECTURE.md §2.3)

import { type HttpBindings, serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { Archive } from "./archive/index.ts";
import {
  AccessDeniedError,
  DeskAccess,
  type DeskRole,
  isPlausibleEmail,
  normalizeEmail,
} from "./auth/access.ts";
import { type ClerkAuth, createClerkAuth } from "./auth/clerk.ts";
import { FsBlobStore, S3BlobStore } from "./blob/index.ts";
import { CollabHub } from "./collab/index.ts";
import { loadConfig, type ServerConfig } from "./config.ts";
import { createDb, migrateDb } from "./db/index.ts";
import { flacContentDisposition } from "./download-name.ts";
import { createLogger, setLogLevel } from "./logger.ts";
import { KeyedRateLimiter } from "./ratelimit.ts";
import type { ConnState } from "./signaling/index.ts";
import { Signaling } from "./signaling/index.ts";

type Env = { Bindings: HttpBindings };

/** Test seam (W8-A): the authz integration suite injects a fake ClerkAuth
 * so the owner/sharee/public matrix runs without Clerk round-trips. */
export interface ServerOptions {
  clerkAuth?: ClerkAuth;
}

export async function createServer(
  config: ServerConfig = loadConfig(),
  options: ServerOptions = {},
) {
  setLogLevel(config.logLevel);
  const log = createLogger({ module: "server" });
  const db = createDb(config.databaseUrl);
  await migrateDb(db);
  let blobs: FsBlobStore | S3BlobStore;
  if (config.blob.driver === "s3") {
    const s3 = new S3BlobStore(config.blob);
    // Fail fast before /ready: unreachable endpoint aborts boot; a missing
    // bucket is created (AccessDenied tolerated — see ensureBucket).
    await s3.ensureBucket();
    blobs = s3;
  } else {
    blobs = new FsBlobStore(config.blob.root);
  }
  const archive = new Archive(db, blobs);

  // ---- auth mode (W8-A, PM decision: enforced iff keys present) -------------
  // Two capability classes, distinct forever: USE a session (desk surface —
  // owner/sharee only when auth is on) vs JOIN as mic (public by link, RFC
  // §12, both modes). Keyless mode is today's single-user behavior
  // byte-for-byte: every gate below checks `access` and no-ops when null.
  const clerkAuth = config.auth
    ? (options.clerkAuth ?? createClerkAuth(config.auth.clerkSecretKey))
    : null;
  const access = clerkAuth ? new DeskAccess(db, clerkAuth) : null;
  if (config.auth) {
    log.info(
      "auth mode: clerk — desk surface (session WS/collab/REST) requires owner or sharee; mic join stays public-by-link",
    );
  } else {
    log.info(
      "auth mode: disabled (keyless) — all surfaces open, single-user behavior; production MUST set CLERK_SECRET_KEY (docs/deploy.md)",
    );
    if (process.env.CLERK_PUBLISHABLE_KEY?.trim()) {
      log.warn(
        "CLERK_PUBLISHABLE_KEY is set but CLERK_SECRET_KEY is not — a publishable key alone cannot enforce anything; auth stays OFF",
      );
    }
  }

  /** Signaling hello gate: desk-role connections must present a valid
   * Clerk token for an owner/sharee BEFORE any session state attaches
   * (room creation included). Recorder hellos never pass through here. */
  const deskHelloAuth =
    access && clerkAuth
      ? async (sessionId: string, token: string | undefined) => {
          if (!token) {
            return { ok: false as const, message: "sign in required to open this session's desk" };
          }
          const user = await clerkAuth.verifyToken(token);
          if (!user) {
            return {
              ok: false as const,
              message: "session token invalid or expired — sign in again",
            };
          }
          try {
            // Or-create: the desk WS is a session-creating surface today
            // (opening /session/<fresh-uuid> boots a session), so the
            // authenticated opener becomes the owner (claim included).
            const decision = await access.authorizeOrCreate(sessionId, user.userId);
            if (decision.ok) return { ok: true as const };
          } catch (error) {
            if (!(error instanceof AccessDeniedError)) throw error;
          }
          return {
            ok: false as const,
            message: "no desk access to this session — ask the owner to share it with your email",
          };
        }
      : null;

  const signaling = new Signaling(archive, config.limits, deskHelloAuth);
  const collab = new CollabHub(db, {
    msgRatePerSec: config.limits.msgRatePerSec,
    msgBurst: config.limits.msgBurst,
    idleEvictMs: config.collab.idleEvictMs,
  });
  let ready = false;

  // WEBRTC_PUBLIC_IP is recognized but cannot work: neither node-datachannel
  // 0.32.x nor libdatachannel/libjuice underneath expose an external-address
  // (1:1 NAT) hint, so ingest can only ever advertise addresses bound to the
  // NICs. Warn loudly instead of failing silently in production — the fix is
  // a VM with the public IP on the interface (docs/deploy.md §5).
  if (config.webrtcPublicIp) {
    log.warn(
      "WEBRTC_PUBLIC_IP is set but unsupported: node-datachannel exposes no " +
        "external-address hint, so ingest cannot advertise it as an ICE candidate. " +
        "Behind 1:1 NAT (EC2-style) phone→server WebRTC will fail — deploy on a " +
        "VM with the public IP bound to its NIC (docs/deploy.md §5).",
      { webrtcPublicIp: config.webrtcPublicIp },
    );
  }

  const app = new Hono<Env>();

  app.onError((err, c) => {
    log.error("unhandled request error", { method: c.req.method, path: c.req.path, error: err });
    return c.json({ error: "internal" }, 500);
  });

  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    const level = c.req.path === "/health" || c.req.path === "/ready" ? "debug" : "info";
    log[level]("http", {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - start),
    });
  });

  // CORS allowlist (RFC §12 hygiene): unset means wide open — dev only.
  if (config.corsOrigins) {
    app.use("/api/*", cors({ origin: config.corsOrigins }));
  } else {
    log.warn("CORS_ORIGINS unset; allowing all origins on /api/* (dev only)");
    app.use("/api/*", cors());
  }

  // ---- health / readiness --------------------------------------------------
  const checkDb = async (): Promise<boolean> => {
    try {
      await Promise.race([
        db.execute(sql`select 1`),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("db health check timeout (2s)")), 2_000).unref();
        }),
      ]);
      return true;
    } catch (error) {
      log.warn("db health check failed", { error });
      return false;
    }
  };
  const checkBlob = async (): Promise<boolean> => {
    try {
      const key = ".health/probe";
      const payload = new TextEncoder().encode(`probe-${Date.now()}`);
      await blobs.put(key, payload);
      const back = await blobs.get(key);
      await blobs.delete(key);
      return Buffer.from(back).equals(Buffer.from(payload));
    } catch (error) {
      log.warn("blob health probe failed", { error });
      return false;
    }
  };
  app.get("/health", async (c) => {
    const [dbOk, blobOk] = await Promise.all([checkDb(), checkBlob()]);
    const ok = dbOk && blobOk;
    return c.json({ ok, db: dbOk, blob: blobOk }, ok ? 200 : 503);
  });
  app.get("/ready", (c) => c.json({ ready }, ready ? 200 : 503));

  // ---- auth plumbing (W8-A; every helper no-ops in keyless mode) ------------

  // Hoisted above the gate that uses it (routes with raw URL params —
  // typos included — must answer honest 404s, never uuid-cast 500s).
  const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** Web boot probe: which auth mode is this deployment running? Public in
   * both modes — the SPA decides whether to mount Clerk from this, so one
   * web build serves keyless AND authed servers deterministically (the
   * publishable key is public by definition). */
  app.get("/api/auth/config", (c) =>
    c.json(
      config.auth
        ? { enabled: true, publishableKey: config.auth.clerkPublishableKey }
        : { enabled: false, publishableKey: null },
    ),
  );

  /** Bearer session-token → Clerk user id; null covers "auth off", "no
   * header", and "invalid token" (callers that care distinguish via
   * `access`). Verification is networkless (cached JWKS) — see auth/clerk. */
  const bearerUser = async (c: Context<Env>): Promise<{ userId: string } | null> => {
    if (!clerkAuth) return null;
    const header = c.req.header("authorization");
    if (!header?.startsWith("Bearer ")) return null;
    return await clerkAuth.verifyToken(header.slice("Bearer ".length));
  };

  /** Desk-surface REST gate. Keyless: pass-through (role null) — today's
   * behavior byte-for-byte. Authed: 401 without a valid user, 404 for
   * sessions that don't exist (existence semantics predate auth and are
   * public anyway via /exists), 403 for a valid user without desk access.
   * A first authenticated toucher of an ownerless session claims it here
   * (access.authorize → claim). */
  type DeskGate =
    | { ok: true; userId: string | null; role: DeskRole | null }
    | { ok: false; res: Response };
  const deskGate = async (c: Context<Env>, sessionId: string): Promise<DeskGate> => {
    if (!access) return { ok: true, userId: null, role: null };
    // Malformed ids can't exist (Postgres uuid) — the same honest 404 the
    // summary route answers, instead of a 500 out of the uuid cast.
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

  // ---- session CRUD -------------------------------------------------------
  app.post("/api/sessions", async (c) => {
    const sessionId = crypto.randomUUID();
    if (access) {
      // Authed mode: creating a session requires an account, and the
      // creator IS the owner (RFC §12's "desk-authenticated session
      // creation", the anticipated v2 step).
      const user = await bearerUser(c);
      if (!user) return c.json({ error: "authentication required" }, 401);
      await access.createOwned(sessionId, user.userId);
      log.info("session created", { sessionId, ownerUserId: user.userId });
      return c.json({ sessionId }, 201);
    }
    await archive.ensureSession(sessionId);
    return c.json({ sessionId }, 201);
  });

  // Unknown sessions are an honest 404 — the F19 existence probe reads the
  // status, not the body (a session that exists but holds nothing yet stays
  // a 200 with empty arrays).

  /** Public existence probe (F19), BOTH modes: the join page's typo
   * warning and the landing's join-by-code need "does this session exist"
   * without an account — mic join is public by link (RFC §12), so bare
   * existence leaks nothing the link doesn't already grant. Split out of
   * GET /api/sessions/:id because the full summary (takes/streams/peers)
   * is desk data and sits behind the desk gate when auth is on. */
  app.get("/api/sessions/:sessionId/exists", async (c) => {
    const sessionId = c.req.param("sessionId");
    const exists = UUID_SHAPE.test(sessionId) && (await archive.sessionExists(sessionId));
    return exists ? c.json({ exists: true }) : c.json({ error: "unknown session" }, 404);
  });

  app.get("/api/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!UUID_SHAPE.test(sessionId)) return c.json({ error: "unknown session" }, 404);
    const gate = await deskGate(c, sessionId);
    if (!gate.ok) return gate.res;
    const summary = await archive.sessionSummary(sessionId);
    if (summary === null) return c.json({ error: "unknown session" }, 404);
    // `access` tells the desk UI whether share management is available
    // (owner-only); absent in keyless mode — the pre-auth wire shape.
    return c.json(gate.role ? { ...summary, access: gate.role } : summary);
  });

  /** Hard deletion (RFC §12 MUST). A9 ordering: disconnect live peers so
   * nothing can recreate state mid-delete (the collab room drops WITHOUT
   * flushing — a debounced save must not resurrect the doc row), then
   * delete durably (blobs, then rows, collab doc included). Idempotent —
   * deleting an unknown session is a 204 no-op. */
  const destroySession = async (sessionId: string): Promise<void> => {
    await signaling.closeSession(sessionId);
    await collab.closeSession(sessionId);
    await archive.deleteSession(sessionId);
  };
  app.delete("/api/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    // Session delete is a desk power — sharees included (v1: any
    // authorized desk is the desk; per-role permissions are future work).
    // Authed mode trades the keyless 204-on-unknown for an honest 404
    // (deskGate) — idempotent retries land there harmlessly.
    const gate = await deskGate(c, sessionId);
    if (!gate.ok) return gate.res;
    await destroySession(sessionId);
    log.info("session deleted", { sessionId, ...(gate.userId ? { userId: gate.userId } : {}) });
    return c.body(null, 204);
  });

  // ---- archive status / retrieval -----------------------------------------
  app.get("/api/sessions/:sessionId/takes/:takeId", async (c) => {
    const takeId = c.req.param("takeId");
    const sessionId = c.req.param("sessionId");
    const gate = await deskGate(c, sessionId);
    if (!gate.ok) return gate.res;
    // Route params are never decorative: a take outside this session 404s.
    const streams = await archive.takeSummary(sessionId, takeId);
    if (streams === null) return c.json({ error: "unknown take" }, 404);
    return c.json({ takeId, streams });
  });

  app.get("/api/sessions/:sessionId/ingest", async (c) => {
    const sessionId = c.req.param("sessionId");
    const gate = await deskGate(c, sessionId);
    if (!gate.ok) return gate.res;
    const status = await signaling.ingestStatus(sessionId);
    return c.body(status, 200, { "content-type": "application/json" });
  });

  // Deliberately un-nested: streamId is a bearer capability (122-bit UUID,
  // RFC §12), and with no session param in the path there is nothing
  // decorative to enforce in KEYLESS mode. With auth on, "v2 adds real
  // authentication" arrived (W8-A): the stream resolves to its session
  // (stream → take → session) and the desk gate applies — exports are
  // session audio, squarely the USE capability.
  app.get("/api/streams/:streamId/flac", async (c) => {
    const allowPartial = c.req.query("partial") === "1";
    const streamId = c.req.param("streamId");
    if (access) {
      // Authentication first (401 even for unknown streams — anonymous
      // probers learn nothing), then resolution (honest 404), then
      // authorization (403 via the desk gate).
      if (!(await bearerUser(c))) return c.json({ error: "authentication required" }, 401);
      const sessionId = UUID_SHAPE.test(streamId) ? await archive.streamSessionId(streamId) : null;
      if (sessionId === null) return c.json({ error: "unknown stream" }, 404);
      const gate = await deskGate(c, sessionId);
      if (!gate.ok) return gate.res;
    }
    const result = await archive.reconstructFlac(streamId, allowPartial);
    if (!result.ok) {
      // Honest status split: a stream the archive has never heard of (or
      // hard-deleted — gone forever) is a 404; a known stream that cannot
      // honestly be served *yet* (missing header/final/chunks) stays 409.
      return c.json({ error: result.reason }, result.code === "not-found" ? 404 : 409);
    }
    // F14: the disposition header beats the desk's `a.download` in Chromium,
    // so it must carry the same nickname naming as every other export —
    // falling back to the desk's device-family lane title for unlabeled
    // peers (full uuid only when the stream has no peer attribution).
    const peer = await archive.streamPeer(streamId);
    return c.body(result.bytes.buffer as ArrayBuffer, 200, {
      "content-type": "audio/flac",
      "content-disposition": flacContentDisposition(streamId, peer),
    });
  });

  // ---- accounts surface (W8-A; mounted ONLY when auth is on) ----------------
  // Keyless mode must stay byte-for-byte: these routes simply don't exist
  // there (404 like any unknown path), so no keyless client can grow a
  // dependency on them.
  if (access && clerkAuth) {
    const deskAccess = access;

    /** Landing lists: sessions you own + sessions shared to any of your
     * verified emails — one call, both buckets. */
    app.get("/api/me/sessions", async (c) => {
      const user = await bearerUser(c);
      if (!user) return c.json({ error: "authentication required" }, 401);
      const { own, shared } = await deskAccess.listUserSessions(user.userId);
      return c.json({ own, shared });
    });

    /** Share management is OWNER-only — the one desk power sharees don't
     * get (v1). The gate's claim path also means a legacy session's first
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
      return c.json({ shares: await deskAccess.listShares(sessionId) });
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
      const added = await deskAccess.addShare(sessionId, email, gate.userId ?? "");
      if (!added) return c.json({ error: "share limit reached for this session" }, 409);
      return c.json({ email }, 201);
    });

    app.delete("/api/sessions/:sessionId/shares/:email", async (c) => {
      const sessionId = c.req.param("sessionId");
      const gate = await ownerGate(c, sessionId);
      if (!gate.ok) return gate.res;
      await deskAccess.removeShare(sessionId, normalizeEmail(c.req.param("email")));
      return c.body(null, 204);
    });
  }

  // ---- control plane (WSS) --------------------------------------------------
  // RFC §4.1: desk connects via /session/{uuid}, recorders via /join/{uuid}.
  // RFC §12 MUST: join attempts are rate-limited per IP before upgrade.
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

  // ---- shared project doc (W3-A) --------------------------------------------
  // Desk-role path like /session/:uuid/ws (join rate limiting included);
  // binary Yjs sync + awareness frames, persisted per session. Transport
  // control stays on the signaling socket — see collab/index.ts header.
  app.use("/session/:sessionId/collab", joinRateLimit);
  if (access && clerkAuth) {
    const deskAccess = access;
    const verify = clerkAuth;
    // W8-A: collab is desk surface. The Yjs wire has no hello/welcome
    // handshake to carry a token (binary sync frames from byte 0), and a
    // browser WebSocket can't set headers — so the token rides a query
    // param and the gate REJECTS THE UPGRADE, before the collab room (and
    // its doc hydration from Postgres) can even be looked up. Query
    // strings never reach the request log (c.req.path is pathname-only).
    // Or-create like the signaling hello: collab may win the race with the
    // desk's first hello on a fresh session — both claim, one wins, same
    // owner either way (single-user opener).
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

  // ---- session expiry sweep (RFC §12 MUST) ----------------------------------
  const sweepIdleSessions = async (): Promise<void> => {
    await signaling.pruneIdleRooms();
    const cutoff = new Date(Date.now() - config.retention.sessionTtlHours * 3_600_000);
    for (const sessionId of await archive.listSessionsIdleSince(cutoff)) {
      if (signaling.sessionBusy(sessionId)) continue;
      log.info("expiring idle session", {
        sessionId,
        ttlHours: config.retention.sessionTtlHours,
      });
      await destroySession(sessionId);
    }
  };
  const sweepTimer = setInterval(() => {
    sweepIdleSessions().catch((error: unknown) => log.error("session sweep failed", { error }));
  }, config.retention.sweepIntervalMs);
  sweepTimer.unref();

  /** Graceful teardown: stop timers, drain WS peers + ingest, flush collab
   * docs, close the pool. */
  const close = async (): Promise<void> => {
    ready = false;
    clearInterval(sweepTimer);
    await signaling.close();
    await collab.close();
    await db.$client.end({ timeout: 5 });
  };

  ready = true;
  return { app, injectWebSocket, signaling, archive, collab, db, config, close };
}

// Entrypoint (skipped when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { app, injectWebSocket, config, close } = await createServer();
  const log = createLogger({ module: "main" });
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    log.info("antiphon server listening", { port: info.port });
  });
  injectWebSocket(server);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    setTimeout(() => {
      log.error("graceful shutdown timed out (10s); exiting hard");
      process.exit(1);
    }, 10_000).unref();
    server.close(); // stop accepting new connections; WS peers drain below
    void close()
      .then(() => {
        log.info("shutdown complete");
        process.exit(0);
      })
      .catch((error: unknown) => {
        log.error("shutdown failed", { error });
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
