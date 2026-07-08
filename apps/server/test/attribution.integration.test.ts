// F1 — cold-desk attribution. The session summary must let a (re)joining
// desk rebuild everything live memory would have held: per-take streams
// with their stream→peer mapping (chronologically ordered takes), plus
// every peer's label/deviceId/role. Proven against a RESTARTED server —
// the payload comes from Postgres, not from any in-memory room state.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Wire shape of GET /api/sessions/:sessionId (attribution extension). */
interface SessionSummaryBody {
  sessionId: string;
  takes: Array<{
    id: string;
    startedAt: string;
    stoppedAt: string | null;
    wallClockHint: string | null;
    streams: Array<{ streamId: string; peerId: string | null; finalSeq: number | null }>;
  }>;
  peers: Array<{
    peerId: string;
    role: "desk" | "recorder";
    userAgent: string;
    label: string | null;
    deviceId: string | null;
    joinedAt: string;
  }>;
}

suite("session attribution (F1)", () => {
  let server: TestServer;
  let dbUrl: string;
  let blobRoot: string;

  beforeAll(async () => {
    dbUrl = await freshDatabase("antiphon_attr_it");
    blobRoot = mkdtempSync(join(tmpdir(), "antiphon-blobs-"));
    server = await startTestServer(dbUrl, blobRoot);
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
    // No nodeDataChannel.cleanup(): see the note in helpers.ts.
  });

  it("a restart-fresh client can rebuild peers/streams/takes attribution from one fetch", async () => {
    const { sessionId } = (await (
      await fetch(`${server.baseUrl}/api/sessions`, { method: "POST" })
    ).json()) as { sessionId: string };

    const deviceId = crypto.randomUUID();
    const desk = new FakeDesk(server.baseUrl, sessionId);
    await desk.join();
    const recorder = new FakeRecorder(server.baseUrl, sessionId, {
      deviceId,
      label: "Maria",
    });
    await recorder.join();
    await recorder.connectDataChannel();
    const recorderPeerId = recorder.peerId as string;

    // Two short takes, recorded in order — ordering must survive cold.
    const takeIds: string[] = [];
    const streamIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const takeId = crypto.randomUUID();
      const streamId = crypto.randomUUID();
      takeIds.push(takeId);
      streamIds.push(streamId);
      const started = new Promise<void>((resolve) => {
        recorder.onTakeStart((startedTakeId) => {
          if (startedTakeId !== takeId) return;
          recorder.arm(takeId, streamId);
          resolve();
        });
      });
      desk.takeStart(takeId);
      await started;
      recorder.pushAudio(sine(1.0));
      recorder.finish(takeId, streamId);
      desk.takeStop(takeId);
      await recorder.waitDrained();
      await pollUntil(
        () => takeSummary(server.baseUrl, sessionId, takeId),
        (s) => s.length === 1 && (s[0]?.complete ?? false),
        `take ${i + 1} archived complete`,
      );
    }
    await recorder.close();
    desk.close();

    // Restart: every in-memory room/announce is gone; only Postgres+blobs
    // survive — exactly what a reloaded or second desk fetches against.
    await server.stop();
    server = await startTestServer(dbUrl, blobRoot);

    const body = (await (
      await fetch(`${server.baseUrl}/api/sessions/${sessionId}`)
    ).json()) as SessionSummaryBody;

    // Takes: both listed, chronological (startedAt ascending), timestamps
    // parseable so the client can rebuild a stable ordering.
    expect(body.takes.map((t) => t.id)).toEqual(takeIds);
    const startedAts = body.takes.map((t) => Date.parse(t.startedAt));
    expect(startedAts.every((ms) => Number.isFinite(ms))).toBe(true);
    expect(startedAts[0]).toBeLessThanOrEqual(startedAts[1] as number);

    // Streams: each take carries its streams, attributed to the recorder,
    // with the finalSeq a cold desk seeds its sink from.
    for (let i = 0; i < 2; i++) {
      expect(body.takes[i]?.streams).toEqual([
        { streamId: streamIds[i], peerId: recorderPeerId, finalSeq: expect.any(Number) },
      ]);
    }

    // Peers: the recorder's identity (label + deviceId + role) survives.
    const peer = body.peers.find((p) => p.peerId === recorderPeerId);
    expect(peer).toBeDefined();
    expect(peer?.role).toBe("recorder");
    expect(peer?.label).toBe("Maria");
    expect(peer?.deviceId).toBe(deviceId);
    expect(peer?.userAgent).toContain("fake-recorder");
    // The desk peer is listed too (role attribution for lane filtering).
    expect(body.peers.some((p) => p.role === "desk")).toBe(true);
  }, 90_000);
});
