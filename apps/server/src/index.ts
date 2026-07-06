// Antiphon server: Hono control plane on Node 24 LTS.
// Signaling (WS rooms, ICE relay), ingest (node-datachannel sink), archive
// (R2 + reconciliation), db (Drizzle + Postgres). Needs real UDP — deploys to
// a VM/Fly.io, never serverless. (docs/ARCHITECTURE.md §2.3)

import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`antiphon server listening on :${info.port}`);
});
