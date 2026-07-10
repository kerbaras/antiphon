// Session CRUD + archive status/retrieval REST routes.

import type { Hono } from "hono";
import type { Archive } from "./archive/index.ts";
import type { DeskAccess } from "./auth/access.ts";
import { flacContentDisposition } from "./download-name.ts";
import { type AuthGates, type Env, UUID_SHAPE } from "./gates.ts";
import type { Logger } from "./logger.ts";
import type { Signaling } from "./signaling/index.ts";

export interface SessionRouteDeps {
  archive: Archive;
  signaling: Signaling;
  access: DeskAccess | null;
  gates: AuthGates;
  log: Logger;
  /** Live-peer disconnect + durable delete, in that order (see index.ts). */
  destroySession(sessionId: string): Promise<void>;
}

export function registerSessionRoutes(app: Hono<Env>, deps: SessionRouteDeps) {
  const { archive, signaling, access, log, destroySession } = deps;
  const { bearerUser, deskGate } = deps.gates;

  app.post("/api/sessions", async (c) => {
    const sessionId = crypto.randomUUID();
    if (access) {
      // Authed mode: creating a session requires an account, and the
      // creator IS the owner.
      const user = await bearerUser(c);
      if (!user) return c.json({ error: "authentication required" }, 401);
      await access.createOwned(sessionId, user.userId);
      log.info("session created", { sessionId, ownerUserId: user.userId });
      return c.json({ sessionId }, 201);
    }
    await archive.ensureSession(sessionId);
    return c.json({ sessionId }, 201);
  });

  /** Public existence probe, BOTH modes: the join page needs "does this
   * session exist" without an account — mic join is public by link (RFC
   * §12), so bare existence leaks nothing the link doesn't already grant.
   * The full summary below is desk data and sits behind the desk gate. */
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
    // Unknown session = honest 404; a session that exists but holds nothing
    // yet stays a 200 with empty arrays (the existence probe reads status).
    const summary = await archive.sessionSummary(sessionId);
    if (summary === null) return c.json({ error: "unknown session" }, 404);
    // `access` tells the desk UI whether share management is available
    // (owner-only); absent in keyless mode — the pre-auth wire shape.
    return c.json(gate.role ? { ...summary, access: gate.role } : summary);
  });

  app.delete("/api/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    // Session delete is a desk power — sharees included (v1). Authed mode
    // trades the keyless 204-on-unknown for an honest 404 (deskGate);
    // idempotent retries land there harmlessly.
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
  // RFC §12) — nothing decorative to enforce in keyless mode. With auth on,
  // the stream resolves to its session and the desk gate applies.
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
      // hard-deleted) is a 404; a known stream that cannot honestly be
      // served *yet* (missing header/final/chunks) stays 409.
      return c.json({ error: result.reason }, result.code === "not-found" ? 404 : 409);
    }
    // The disposition header beats the desk's `a.download` in Chromium, so
    // it must carry the same nickname naming as every other export — see
    // download-name.ts.
    const peer = await archive.streamPeer(streamId);
    return c.body(result.bytes.buffer as ArrayBuffer, 200, {
      "content-type": "audio/flac",
      "content-disposition": flacContentDisposition(streamId, peer),
    });
  });
}
