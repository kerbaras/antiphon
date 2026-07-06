// Antiphon server: Hono control plane on Node 24 LTS.
// Signaling (WS rooms, ICE relay), ingest (node-datachannel sink), archive
// (Postgres + blobs + reconciliation). Needs real UDP — deploys to a
// VM/Fly.io, never serverless. (docs/ARCHITECTURE.md §2.3)

import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { Archive } from "./archive/index.ts";
import { FsBlobStore, S3BlobStore } from "./blob/index.ts";
import { loadConfig, type ServerConfig } from "./config.ts";
import { createDb, migrateDb } from "./db/index.ts";
import type { ConnState } from "./signaling/index.ts";
import { Signaling } from "./signaling/index.ts";

export async function createServer(config: ServerConfig = loadConfig()) {
  const db = createDb(config.databaseUrl);
  await migrateDb(db);
  const blobs =
    config.blob.driver === "s3"
      ? new S3BlobStore(config.blob.endpoint, config.blob.bucket)
      : new FsBlobStore(config.blob.root);
  const archive = new Archive(db, blobs);
  const signaling = new Signaling(archive);

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.use("/api/*", cors());
  app.get("/health", (c) => c.json({ ok: true }));

  // ---- session CRUD -------------------------------------------------------
  app.post("/api/sessions", async (c) => {
    const sessionId = crypto.randomUUID();
    await archive.ensureSession(sessionId);
    return c.json({ sessionId }, 201);
  });

  app.get("/api/sessions/:sessionId", async (c) => {
    return c.json(await archive.sessionSummary(c.req.param("sessionId")));
  });

  // ---- archive status / retrieval -----------------------------------------
  app.get("/api/sessions/:sessionId/takes/:takeId", async (c) => {
    return c.json({
      takeId: c.req.param("takeId"),
      streams: await archive.takeSummary(c.req.param("takeId")),
    });
  });

  app.get("/api/sessions/:sessionId/ingest", async (c) => {
    const status = await signaling.ingestStatus(c.req.param("sessionId"));
    return c.body(status, 200, { "content-type": "application/json" });
  });

  app.get("/api/streams/:streamId/flac", async (c) => {
    const allowPartial = c.req.query("partial") === "1";
    const streamId = c.req.param("streamId");
    const result = await archive.reconstructFlac(streamId, allowPartial);
    if (!result.ok) return c.json({ error: result.reason }, 409);
    return c.body(result.bytes.buffer as ArrayBuffer, 200, {
      "content-type": "audio/flac",
      "content-disposition": `attachment; filename="${streamId}.flac"`,
    });
  });

  // ---- control plane (WSS) --------------------------------------------------
  // RFC §4.1: desk connects via /session/{uuid}, recorders via /join/{uuid}.
  const wsHandler = (role: "desk" | "recorder") =>
    upgradeWebSocket((c: { req: { param(name: "sessionId"): string } }) => {
      const conn: ConnState = {
        sessionId: c.req.param("sessionId"),
        pathRole: role,
        peerId: null,
      };
      return {
        onMessage(event: MessageEvent, ws: Parameters<Signaling["handleMessage"]>[1]) {
          void signaling.handleMessage(conn, ws, String(event.data));
        },
        onClose() {
          signaling.handleClose(conn);
        },
      };
    });
  app.get("/session/:sessionId/ws", wsHandler("desk"));
  app.get("/join/:sessionId/ws", wsHandler("recorder"));

  return { app, injectWebSocket, signaling, archive, db, config };
}

// Entrypoint (skipped when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { app, injectWebSocket, config } = await createServer();
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`antiphon server listening on :${info.port}`);
  });
  injectWebSocket(server);
}
