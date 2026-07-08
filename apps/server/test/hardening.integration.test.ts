// Production-hardening integration tests over real transports (same harness
// as ingest.integration.test.ts): join rate limiting, message flood guard,
// peer/session caps, session hard deletion, expiry sweep, health/readiness.
// Requires Postgres (docker compose up -d postgres or CI service); skipped
// when TEST_DATABASE_URL is unreachable.

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSignalingMessage, type SignalingMessage } from "@antiphon/protocol";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FakeDesk,
  FakeRecorder,
  pollUntil,
  sine,
  startTestServer,
  type TestServer,
  takeSummary,
} from "./helpers.ts";

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

type ErrorMsg = Extract<SignalingMessage, { type: "error" }>;

/** Bare signaling peer: a WS and a hello, nothing else — for observing
 * control-plane rejections (caps, flood guard) without the full harness. */
class RawPeer {
  ws!: WebSocket;
  readonly messages: SignalingMessage[] = [];
  closed = false;

  async connect(baseUrl: string, sessionId: string, path: "session" | "join"): Promise<void> {
    this.ws = new WebSocket(`${baseUrl.replace("http", "ws")}/${path}/${sessionId}/ws`);
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      try {
        const msg = parseSignalingMessage(String(ev.data));
        if (msg) this.messages.push(msg);
      } catch {
        // non-signaling frames are irrelevant here
      }
    });
    this.ws.addEventListener("close", () => {
      this.closed = true;
    });
  }

  hello(role: "desk" | "recorder"): void {
    this.ws.send(
      JSON.stringify({
        v: 1,
        type: "hello",
        role,
        deviceInfo: { userAgent: "raw-peer" },
        protocolVersions: [1],
      }),
    );
  }

  async waitForError(code: string, timeoutMs = 5_000): Promise<ErrorMsg> {
    const start = Date.now();
    for (;;) {
      const found = this.messages.find((m): m is ErrorMsg => m.type === "error" && m.code === code);
      if (found) return found;
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for error ${code}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async waitClosed(timeoutMs = 5_000): Promise<void> {
    const start = Date.now();
    while (!this.closed) {
      if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for ws close");
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

suite("server hardening", () => {
  let server: TestServer;
  let dbUrl: string;
  let blobRoot: string;

  beforeAll(async () => {
    dbUrl = await freshDatabase("antiphon_hard");
    blobRoot = mkdtempSync(join(tmpdir(), "antiphon-hard-blobs-"));
    server = await startTestServer(dbUrl, blobRoot);
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
    // No nodeDataChannel.cleanup(): see the note in helpers.ts (native
    // use-after-free in cleanup() flaked the fork ~1/3 of loaded runs).
  });

  it("/health verifies db + blob store; /ready reports readiness", async () => {
    const health = await fetch(`${server.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, db: true, blob: true });

    const ready = await fetch(`${server.baseUrl}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ready: true });
  });

  it("join rate limit kicks in per IP and recovers (RFC §12)", async () => {
    const limited = await startTestServer(dbUrl, blobRoot, {
      limits: { joinRatePerMin: 30, joinBurst: 3 },
    });
    try {
      const url = `${limited.baseUrl}/join/${crypto.randomUUID()}/ws`;
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await fetch(url)).status);
      // Burst of 3 reaches the WS route; attempts beyond it are rejected.
      expect(statuses.slice(0, 3).every((s) => s !== 429)).toBe(true);
      expect(statuses[3]).toBe(429);
      expect(statuses[4]).toBe(429);

      // Refill at 30/min = one attempt every 2 s: the limiter recovers.
      await new Promise((r) => setTimeout(r, 2_200));
      expect((await fetch(url)).status).not.toBe(429);
      // The desk upgrade path shares the same per-IP limiter (bucket dry again).
      const deskUrl = `${limited.baseUrl}/session/${crypto.randomUUID()}/ws`;
      expect((await fetch(deskUrl)).status).toBe(429);
    } finally {
      await limited.stop();
    }
  }, 30_000);

  it("signaling message flood gets a rate-limited error and a disconnect", async () => {
    const strict = await startTestServer(dbUrl, blobRoot, {
      limits: { msgRatePerSec: 10, msgBurst: 5 },
    });
    try {
      const peer = new RawPeer();
      await peer.connect(strict.baseUrl, await createSession(strict.baseUrl), "join");
      peer.hello("recorder");
      // Unknown types are ignored by the protocol but still count as traffic.
      for (let i = 0; i < 20; i++) {
        peer.ws.send(JSON.stringify({ v: 1, type: "future-noise" }));
      }
      const err = await peer.waitForError("rate-limited");
      expect(err.fatal).toBe(true);
      await peer.waitClosed();
    } finally {
      await strict.stop();
    }
  }, 30_000);

  it("session peer cap and active session cap are enforced", async () => {
    const capped = await startTestServer(dbUrl, blobRoot, {
      limits: { maxPeersPerSession: 2, maxActiveSessions: 1 },
    });
    const third = new RawPeer();
    const other = new RawPeer();
    let desk: FakeDesk | null = null;
    let recorder: FakeRecorder | null = null;
    try {
      const sessionId = await createSession(capped.baseUrl);
      desk = new FakeDesk(capped.baseUrl, sessionId);
      await desk.join();
      recorder = new FakeRecorder(capped.baseUrl, sessionId);
      await recorder.join();
      expect(desk.peerId).not.toBeNull();
      expect(recorder.peerId).not.toBeNull();

      // Third peer in a 2-cap session: session-full, fatal, socket closed.
      await third.connect(capped.baseUrl, sessionId, "join");
      third.hello("recorder");
      const full = await third.waitForError("session-full");
      expect(full.fatal).toBe(true);
      await third.waitClosed();

      // A second session while 1 is active: server-full.
      await other.connect(capped.baseUrl, crypto.randomUUID(), "join");
      other.hello("recorder");
      const serverFull = await other.waitForError("server-full");
      expect(serverFull.fatal).toBe(true);
      await other.waitClosed();
    } finally {
      third.close();
      other.close();
      await recorder?.close();
      desk?.close();
      await capped.stop();
    }
  }, 30_000);

  it("DELETE /api/sessions/:id disconnects peers, removes rows AND blobs, and is idempotent", async () => {
    const sessionId = await createSession(server.baseUrl);
    const desk = new FakeDesk(server.baseUrl, sessionId);
    await desk.join();
    const recorder = new FakeRecorder(server.baseUrl, sessionId);
    await recorder.join();
    await recorder.connectDataChannel();

    const takeId = crypto.randomUUID();
    const streamId = crypto.randomUUID();
    const started = new Promise<void>((resolve) => {
      recorder.onTakeStart(() => {
        recorder.arm(takeId, streamId);
        resolve();
      });
    });
    desk.takeStart(takeId);
    await started;
    recorder.pushAudio(sine(1.2));
    const finalSeq = recorder.finish(takeId, streamId);
    desk.takeStop(takeId);
    await recorder.waitDrained();
    await pollUntil(
      () => takeSummary(server.baseUrl, sessionId, takeId),
      (s) => s.length === 1 && (s[0]?.complete ?? false),
      "archive complete before delete",
    );

    const blobPath = join(blobRoot, takeId, streamId, String(finalSeq));
    expect(existsSync(blobPath)).toBe(true);

    const sql = postgres(dbUrl, { max: 1 });
    try {
      // The peers table is populated on hello (desk + recorder).
      const [peersBefore] = await sql`
        select count(*)::int as count from peers where session_id = ${sessionId}`;
      expect(peersBefore?.count).toBe(2);

      const res = await fetch(`${server.baseUrl}/api/sessions/${sessionId}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(204);

      // Live peers were disconnected with a fatal control-plane error.
      const bounced = await desk.waitForMessage("error");
      expect(bounced.code).toBe("session-deleted");
      expect(bounced.fatal).toBe(true);
      await pollUntil(
        async () => desk.ws.readyState,
        (state) => state === WebSocket.CLOSED,
        "desk ws closed",
      );

      // Blobs gone (seq 0 and the final chunk), rows gone across all tables.
      expect(existsSync(blobPath)).toBe(false);
      expect(existsSync(join(blobRoot, takeId, streamId, "0"))).toBe(false);
      const [counts] = await sql`select
        (select count(*)::int from sessions where id = ${sessionId}) as sessions,
        (select count(*)::int from takes where session_id = ${sessionId}) as takes,
        (select count(*)::int from streams where id = ${streamId}) as streams,
        (select count(*)::int from chunks where stream_id = ${streamId}) as chunks,
        (select count(*)::int from peers where session_id = ${sessionId}) as peers`;
      expect(counts).toEqual({ sessions: 0, takes: 0, streams: 0, chunks: 0, peers: 0 });

      // Idempotent: deleting again (or an unknown session) is still a 204.
      const again = await fetch(`${server.baseUrl}/api/sessions/${sessionId}`, {
        method: "DELETE",
      });
      expect(again.status).toBe(204);
    } finally {
      await sql.end();
      await recorder.close();
      desk.close();
    }
  }, 60_000);

  it("expiry sweep hard-deletes only idle sessions", async () => {
    const sweepDb = await freshDatabase("antiphon_hard_sweep");
    const sweepBlobs = mkdtempSync(join(tmpdir(), "antiphon-hard-sweep-"));
    const sweeper = await startTestServer(sweepDb, sweepBlobs, {
      retention: { sessionTtlHours: 0.0002, sweepIntervalMs: 300 }, // TTL 720 ms
    });
    const sql = postgres(sweepDb, { max: 1 });
    let desk: FakeDesk | null = null;
    try {
      const idle = await createSession(sweeper.baseUrl);
      const busy = await createSession(sweeper.baseUrl);
      desk = new FakeDesk(sweeper.baseUrl, busy);
      await desk.join(); // connected peer: never swept, however old

      await pollUntil(
        async () => (await sql`select id from sessions`).map((r) => r.id as string),
        (ids) => !ids.includes(idle),
        "idle session swept",
        10_000,
      );
      const ids = (await sql`select id from sessions`).map((r) => r.id as string);
      expect(ids).not.toContain(idle);
      expect(ids).toContain(busy);
    } finally {
      desk?.close();
      await sql.end();
      await sweeper.stop();
    }
  }, 30_000);
});
