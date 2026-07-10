// /health (round-trips Postgres + the blob store) and /ready.

import { sql } from "drizzle-orm";
import type { Hono } from "hono";
import type { BlobStore } from "./blob/index.ts";
import type { Db } from "./db/index.ts";
import type { Env } from "./gates.ts";
import type { Logger } from "./logger.ts";

export interface HealthDeps {
  db: Db;
  blobs: BlobStore;
  log: Logger;
  isReady(): boolean;
}

export function registerHealthRoutes(app: Hono<Env>, { db, blobs, log, isReady }: HealthDeps) {
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
  app.get("/ready", (c) => c.json({ ready: isReady() }, isReady() ? 200 : 503));
}
