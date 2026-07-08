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
import { Archive } from "./archive/index.ts";
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

export async function createServer(config: ServerConfig = loadConfig()) {
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
  const signaling = new Signaling(archive, config.limits);
  const collab = new CollabHub(db, {
    msgRatePerSec: config.limits.msgRatePerSec,
    msgBurst: config.limits.msgBurst,
  });
  let ready = false;

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

  // ---- session CRUD -------------------------------------------------------
  app.post("/api/sessions", async (c) => {
    const sessionId = crypto.randomUUID();
    await archive.ensureSession(sessionId);
    return c.json({ sessionId }, 201);
  });

  app.get("/api/sessions/:sessionId", async (c) => {
    return c.json(await archive.sessionSummary(c.req.param("sessionId")));
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
    await destroySession(sessionId);
    log.info("session deleted", { sessionId });
    return c.body(null, 204);
  });

  // ---- archive status / retrieval -----------------------------------------
  app.get("/api/sessions/:sessionId/takes/:takeId", async (c) => {
    const takeId = c.req.param("takeId");
    // Route params are never decorative: a take outside this session 404s.
    const streams = await archive.takeSummary(c.req.param("sessionId"), takeId);
    if (streams === null) return c.json({ error: "unknown take" }, 404);
    return c.json({ takeId, streams });
  });

  app.get("/api/sessions/:sessionId/ingest", async (c) => {
    const status = await signaling.ingestStatus(c.req.param("sessionId"));
    return c.body(status, 200, { "content-type": "application/json" });
  });

  // Deliberately un-nested: streamId is a bearer capability (122-bit UUID,
  // RFC §12), and with no session param in the path there is nothing
  // decorative to enforce. Session-scoping this would mean threading
  // sessionId through every desk/e2e download path for zero access-control
  // gain; revisit if v2 adds real authentication.
  app.get("/api/streams/:streamId/flac", async (c) => {
    const allowPartial = c.req.query("partial") === "1";
    const streamId = c.req.param("streamId");
    const result = await archive.reconstructFlac(streamId, allowPartial);
    if (!result.ok) {
      // Honest status split: a stream the archive has never heard of (or
      // hard-deleted — gone forever) is a 404; a known stream that cannot
      // honestly be served *yet* (missing header/final/chunks) stays 409.
      return c.json({ error: result.reason }, result.code === "not-found" ? 404 : 409);
    }
    // F14: the disposition header beats the desk's `a.download` in Chromium,
    // so it must carry the same nickname naming as every other export.
    const label = await archive.streamLabel(streamId);
    return c.body(result.bytes.buffer as ArrayBuffer, 200, {
      "content-type": "audio/flac",
      "content-disposition": flacContentDisposition(streamId, label),
    });
  });

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
