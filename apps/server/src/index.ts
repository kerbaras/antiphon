// Antiphon server: Hono control plane on Node 24 LTS. Signaling (WS rooms,
// ICE relay), ingest (node-datachannel sink), archive (Postgres + blobs).
// Needs real UDP — deploys to a VM, never serverless (ARCHITECTURE §2.3).

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { Archive } from "./archive/index.ts";
import { DeskAccess } from "./auth/access.ts";
import { type ClerkAuth, createClerkAuth } from "./auth/clerk.ts";
import { FsBlobStore, S3BlobStore } from "./blob/index.ts";
import { CollabHub } from "./collab/index.ts";
import { loadConfig, type ServerConfig } from "./config.ts";
import { createDb, migrateDb } from "./db/index.ts";
import { createAuthGates, createDeskHelloAuth, type Env } from "./gates.ts";
import { registerHealthRoutes } from "./health.ts";
import { createLogger, setLogLevel } from "./logger.ts";
import { registerSessionRoutes } from "./routes-sessions.ts";
import { registerAccountRoutes } from "./routes-shares.ts";
import { Signaling } from "./signaling/index.ts";
import { registerWsRoutes } from "./ws.ts";

/** Test seam: the authz integration suite injects a fake ClerkAuth so the
 * owner/sharee/public matrix runs without Clerk round-trips. */
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

  // Auth is enforced iff Clerk keys are present. Two capability classes,
  // distinct forever: USE a session (desk surface — owner/sharee when auth
  // is on) vs JOIN as mic (public by link, RFC §12, BOTH modes). Keyless
  // mode is pre-auth single-user behavior byte-for-byte: every gate no-ops.
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

  const signaling = new Signaling(archive, config.limits, createDeskHelloAuth(clerkAuth, access));
  const collab = new CollabHub(db, {
    msgRatePerSec: config.limits.msgRatePerSec,
    msgBurst: config.limits.msgBurst,
    idleEvictMs: config.collab.idleEvictMs,
  });
  let ready = false;

  // WEBRTC_PUBLIC_IP is recognized but cannot work: node-datachannel exposes
  // no external-address (1:1 NAT) hint, so ingest only advertises NIC-bound
  // addresses. Warn loudly — the fix is a VM with the public IP on the
  // interface (docs/deploy.md §5).
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

  registerHealthRoutes(app, { db, blobs, log, isReady: () => ready });

  /** Web boot probe: which auth mode is this deployment running? Public in
   * both modes — the SPA decides whether to mount Clerk from this, so one
   * web build serves keyless AND authed servers deterministically. */
  app.get("/api/auth/config", (c) =>
    c.json(
      config.auth
        ? { enabled: true, publishableKey: config.auth.clerkPublishableKey }
        : { enabled: false, publishableKey: null },
    ),
  );

  /** Hard deletion (RFC §12 MUST). Ordering: disconnect live peers so
   * nothing can recreate state mid-delete (the collab room drops WITHOUT
   * flushing — a debounced save must not resurrect the doc row), then
   * delete durably. Idempotent — an unknown session is a 204 no-op. */
  const destroySession = async (sessionId: string): Promise<void> => {
    await signaling.closeSession(sessionId);
    await collab.closeSession(sessionId);
    await archive.deleteSession(sessionId);
  };

  const gates = createAuthGates(clerkAuth, access);
  registerSessionRoutes(app, { archive, signaling, access, gates, log, destroySession });
  if (access) registerAccountRoutes(app, { access, gates });
  const { injectWebSocket } = registerWsRoutes(app, {
    config,
    signaling,
    collab,
    access,
    clerkAuth,
    log,
  });

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
