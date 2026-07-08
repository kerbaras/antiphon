// W3-A shared project doc — integration over the real WSS route: two desk
// clients converge a map edit through /session/:uuid/collab, the merged doc
// persists to Postgres (debounced) and restores on a fresh server process,
// session hard-delete removes the row, and the join rate limiter guards the
// path. Requires Postgres (docker compose up -d postgres or CI service);
// skipped when TEST_DATABASE_URL is unreachable.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { pollUntil, startTestServer, type TestServer } from "./helpers.ts";

const ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://antiphon:antiphon@localhost:5433/antiphon";

let available = true;
try {
  const probe = postgres(ADMIN_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
} catch {
  available = false;
}

const suite = available ? describe : describe.skip;

async function freshDatabase(name: string): Promise<string> {
  const admin = postgres(ADMIN_URL, { max: 1 });
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  return ADMIN_URL.replace(/\/[^/]+$/, `/${name}`);
}

async function createSession(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
  const body = (await res.json()) as { sessionId: string };
  return body.sessionId;
}

// Wire tags — mirror apps/server/src/collab (1-byte tag + payload).
const SYNC_STEP1 = 0;
const UPDATE = 1;

/** Minimal desk-side doc client: real WS, real Y.Doc, the same handshake
 * the web CollabClient speaks (step-1 both ways, diff replies, live
 * updates). Awareness is exercised e2e; this harness covers the doc. */
class DocClient {
  readonly doc = new Y.Doc();
  ws!: WebSocket;
  synced = false;
  closed = false;

  async connect(baseUrl: string, sessionId: string): Promise<void> {
    this.ws = new WebSocket(`${baseUrl.replace("http", "ws")}/session/${sessionId}/collab`);
    this.ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", () => reject(new Error("collab ws error")), {
        once: true,
      });
    });
    this.ws.addEventListener("close", () => {
      this.closed = true;
    });
    this.ws.addEventListener("message", (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(ev.data);
      const payload = bytes.subarray(1);
      if (bytes[0] === SYNC_STEP1) {
        this.send(UPDATE, Y.encodeStateAsUpdate(this.doc, payload));
      } else if (bytes[0] === UPDATE) {
        Y.applyUpdate(this.doc, payload, "remote");
        this.synced = true;
      }
    });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "remote") this.send(UPDATE, update);
    });
    this.send(SYNC_STEP1, Y.encodeStateVector(this.doc));
  }

  private send(tag: number, payload: Uint8Array): void {
    const framed = new Uint8Array(1 + payload.length);
    framed[0] = tag;
    framed.set(payload, 1);
    this.ws.send(framed);
  }

  async waitSynced(timeoutMs = 5_000): Promise<void> {
    const start = Date.now();
    while (!this.synced) {
      if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for collab sync");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      // already gone
    }
  }
}

suite("collab doc sync (W3-A)", () => {
  let server: TestServer;
  let dbUrl: string;
  let blobRoot: string;
  let sql: postgres.Sql;

  beforeAll(async () => {
    dbUrl = await freshDatabase("antiphon_collab");
    blobRoot = mkdtempSync(join(tmpdir(), "antiphon-collab-blobs-"));
    server = await startTestServer(dbUrl, blobRoot);
    sql = postgres(dbUrl, { max: 1 });
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
    await server?.stop();
  });

  async function docRow(sessionId: string): Promise<Uint8Array | null> {
    const rows = await sql`select doc from collab_docs where session_id = ${sessionId}`;
    const doc = rows[0]?.doc as Buffer | undefined;
    return doc ? new Uint8Array(doc) : null;
  }

  it("two desks converge a map edit; the doc persists and restores across processes", async () => {
    const sessionId = await createSession(server.baseUrl);
    const a = new DocClient();
    const b = new DocClient();
    try {
      await a.connect(server.baseUrl, sessionId);
      await b.connect(server.baseUrl, sessionId);
      await a.waitSynced();
      await b.waitSynced();

      // Desk A moves a fader; desk B sees the mix map converge.
      a.doc.getMap("mix").set("lane-1", { gainDb: -6, pan: 0, muted: false, soloed: false });
      await pollUntil(
        async () => b.doc.getMap("mix").get("lane-1") as { gainDb: number } | undefined,
        (v) => v?.gainDb === -6,
        "desk B mix convergence",
        10_000,
      );

      // Concurrent edits from B converge back at A (both directions live).
      b.doc.getMap("arrange").set("stream-1", 3.25);
      await pollUntil(
        async () => a.doc.getMap("arrange").get("stream-1") as number | undefined,
        (v) => v === 3.25,
        "desk A arrange convergence",
        10_000,
      );

      // Debounced persistence (2 s after the last change) writes the row.
      const persisted = await pollUntil(
        () => docRow(sessionId),
        (row) => row !== null && row.length > 0,
        "collab_docs row",
        10_000,
      );

      // The persisted bytes alone rebuild the full doc state.
      const restored = new Y.Doc();
      Y.applyUpdate(restored, persisted as Uint8Array);
      expect(restored.getMap("mix").get("lane-1")).toEqual({
        gainDb: -6,
        pan: 0,
        muted: false,
        soloed: false,
      });
      expect(restored.getMap("arrange").get("stream-1")).toBe(3.25);
    } finally {
      a.close();
      b.close();
    }

    // A separate server process on the same database (a restart, as far as
    // the doc is concerned) loads the row on room open: a fresh desk gets
    // the full state back.
    const reborn = await startTestServer(dbUrl, blobRoot);
    const c = new DocClient();
    try {
      await c.connect(reborn.baseUrl, sessionId);
      await c.waitSynced();
      await pollUntil(
        async () => c.doc.getMap("mix").get("lane-1") as { gainDb: number } | undefined,
        (v) => v?.gainDb === -6,
        "restored doc after server restart",
        10_000,
      );
    } finally {
      c.close();
      await reborn.stop();
    }
  }, 60_000);

  it("session hard-delete removes the doc row and disconnects collab desks", async () => {
    const sessionId = await createSession(server.baseUrl);
    const a = new DocClient();
    await a.connect(server.baseUrl, sessionId);
    await a.waitSynced();
    a.doc.getMap("markers").set("take-1", "seeded");
    await pollUntil(
      () => docRow(sessionId),
      (row) => row !== null,
      "collab_docs row before delete",
      10_000,
    );

    const res = await fetch(`${server.baseUrl}/api/sessions/${sessionId}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await docRow(sessionId)).toBeNull();
    await pollUntil(
      async () => a.closed,
      (closed) => closed,
      "collab ws closed on session delete",
      5_000,
    );

    // The debounce that was pending when the room dropped must not
    // resurrect the row (FK to sessions backstops; nothing to flush).
    await new Promise((r) => setTimeout(r, 2_500));
    expect(await docRow(sessionId)).toBeNull();
  }, 30_000);

  it("the join rate limiter guards /session/:id/collab", async () => {
    const limited = await startTestServer(dbUrl, blobRoot, {
      limits: { joinRatePerMin: 30, joinBurst: 3 },
    });
    try {
      const url = `${limited.baseUrl}/session/${crypto.randomUUID()}/collab`;
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await fetch(url)).status);
      expect(statuses.slice(0, 3).every((s) => s !== 429)).toBe(true);
      expect(statuses[3]).toBe(429);
      expect(statuses[4]).toBe(429);
    } finally {
      await limited.stop();
    }
  }, 30_000);
});
